"use server";

/**
 * Host moderation actions.
 *
 * Every export here is host-gated by `requireHost`, which resolves the host from
 * the meeting row and never from anything the caller sends. The underlying
 * LiveKit calls act on live media, so a missing check would let any participant
 * mute or eject anyone else.
 */

import { KnockStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";

import {
  moderationConfigured,
  muteEveryoneElse,
  muteParticipant,
  removeOccupant,
} from "@/lib/meetings/livekit-admin";
import { actingHostId } from "@/lib/meetings/host-succession";
import { prisma } from "@/lib/prisma";
import { ensureCurrentUser } from "@/lib/users/current-user";

export interface ModerationResult {
  ok: boolean;
  message: string;
}

/**
 * One refusal for every gate failure: not signed in, not the host, no such
 * meeting. Distinguishing them would let anyone probe meeting codes and learn who
 * hosts what.
 */
const NOT_HOST = "Only the host can do that.";

interface HostContext {
  meetingId: string;
  meetingCode: string;
  /** Clerk subject, which is what LiveKit uses as the participant identity. */
  hostClerkId: string | null;
  localUserId: string;
  /** True only for the meeting owner, false for a co-host. */
  isOwner: boolean;
}

/**
 * Resolves the caller and proves they may moderate `meetingCode`.
 *
 * `level` separates the two tiers deliberately:
 * - `"moderator"` admits the host *and* co-hosts. Muting, removing, locking and
 *   admitting are all delegated powers.
 * - `"owner"` admits only the host. Ending the meeting and appointing co-hosts are
 *   ownership, not moderation — a co-host who could do either would be able to
 *   close someone else's meeting or make the role self-propagating.
 *
 * Returns null on any failure so a caller cannot mistake a refusal for success.
 * The refusal message is intentionally identical for "not permitted" and "no such
 * meeting", so meeting codes cannot be probed.
 */
async function requireHost(
  meetingCode: string,
  level: "owner" | "moderator" = "moderator",
): Promise<HostContext | null> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return null;
  }

  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: {
      id: true,
      meetingCode: true,
      hostId: true,
      currentHostId: true,
      participants: {
        where: { userId: me.id, isCoHost: true },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (meeting === null) {
    return null;
  }

  // The acting host, which may be a successor rather than the creator.
  const actingId = actingHostId(meeting);
  const isOwner = actingId === me.id;
  const isCreator = meeting.hostId === me.id;
  const isCoHost = meeting.participants.length > 0;

  if (level === "owner" && !isOwner) {
    return null;
  }

  // The creator keeps moderation rights after handing the room over: opening a
  // meeting must never leave you unable to moderate it.
  if (!isOwner && !isCreator && !isCoHost) {
    return null;
  }

  const acting = await prisma.user.findUnique({
    where: { id: actingId },
    select: { clerkId: true },
  });

  return {
    meetingId: meeting.id,
    meetingCode: meeting.meetingCode,
    hostClerkId: acting?.clerkId ?? null,
    localUserId: me.id,
    isOwner,
  };
}

/** Mutes every microphone in the room except the host's own. */
export async function muteAllParticipants(
  meetingCode: string,
): Promise<ModerationResult> {
  const host = await requireHost(meetingCode);

  if (host === null) {
    return { ok: false, message: NOT_HOST };
  }

  if (!moderationConfigured()) {
    return {
      ok: false,
      message: "Moderation is unavailable: the media server is not configured.",
    };
  }

  // Excludes whoever ran the command, not the owner: a co-host muting the room
  // should not silence themselves while leaving the host talking.
  const me = await ensureCurrentUser();

  const outcome = await muteEveryoneElse(
    host.meetingCode,
    me?.clerkId ?? host.hostClerkId ?? "",
  );

  return outcome.ok
    ? { ok: true, message: "Muted everyone else." }
    : { ok: false, message: outcome.message };
}

/** Mutes one participant's microphone, server-side. */
export async function muteOneParticipant(
  meetingCode: string,
  identity: string,
): Promise<ModerationResult> {
  const host = await requireHost(meetingCode);

  if (host === null) {
    return { ok: false, message: NOT_HOST };
  }

  if (identity === host.hostClerkId) {
    return {
      ok: false,
      // The dock already has a mic button; routing self-mute through moderation
      // would be a confusing second path to the same state.
      message: host.isOwner
        ? "Use the microphone button to mute yourself."
        : "Only the host can mute the host.",
    };
  }

  const outcome = await muteParticipant(host.meetingCode, identity);

  return outcome.ok
    ? { ok: true, message: "Muted." }
    : { ok: false, message: outcome.message };
}

/**
 * Ejects someone and stops them walking back in.
 *
 * Three writes, in this order, because removal has to be durable:
 * 1. a DENIED knock row, which `authorizeMeetingJoin` treats as a ban;
 * 2. their `Participant` row is dropped, so enrollment no longer admits them;
 * 3. the LiveKit disconnect.
 *
 * Doing the disconnect first would leave a window where their still-valid access
 * token lets them reconnect immediately.
 */
export async function removeFromMeeting(
  meetingCode: string,
  identity: string,
): Promise<ModerationResult> {
  const host = await requireHost(meetingCode);

  if (host === null) {
    return { ok: false, message: NOT_HOST };
  }

  // Covers two cases at once: the owner cannot remove themselves, and a co-host
  // cannot remove the owner. Delegated moderation must not be able to eject the
  // person who delegated it.
  if (identity === host.hostClerkId) {
    return {
      ok: false,
      message: host.isOwner
        ? "You cannot remove yourself."
        : "Only the host can do that.",
    };
  }

  // LiveKit identity is the Clerk subject, so the local user is resolved from it.
  const target = await prisma.user.findUnique({
    where: { clerkId: identity },
    select: { id: true },
  });

  if (target !== null) {
    await prisma.$transaction([
      prisma.waitingRoomEntry.upsert({
        where: {
          meetingId_userId: {
            meetingId: host.meetingId,
            userId: target.id,
          },
        },
        create: {
          meetingId: host.meetingId,
          userId: target.id,
          status: KnockStatus.DENIED,
          decidedById: host.localUserId,
        },
        update: {
          status: KnockStatus.DENIED,
          decidedById: host.localUserId,
        },
        select: { id: true },
      }),
      prisma.participant.deleteMany({
        where: { meetingId: host.meetingId, userId: target.id },
      }),
    ]);
  }

  const outcome = await removeOccupant(host.meetingCode, identity);

  revalidatePath("/dashboard");

  // The ban is already recorded, so a failed disconnect still keeps them out on
  // the next join attempt. Reported honestly rather than as a clean success.
  return outcome.ok
    ? { ok: true, message: "Removed from the meeting." }
    : {
        ok: false,
        message:
          "They are blocked from rejoining, but we could not disconnect them right now.",
      };
}

/** Locks or unlocks the room. Existing participants are unaffected. */
export async function setMeetingLock(
  meetingCode: string,
  locked: boolean,
): Promise<ModerationResult> {
  const host = await requireHost(meetingCode);

  if (host === null) {
    return { ok: false, message: NOT_HOST };
  }

  await prisma.meeting.update({
    where: { id: host.meetingId },
    data: { isLocked: locked },
    select: { id: true },
  });

  return {
    ok: true,
    message: locked
      ? "Meeting locked. No one new can join."
      : "Meeting unlocked.",
  };
}

/** Turns the waiting room on or off. */
export async function setWaitingRoom(
  meetingCode: string,
  enabled: boolean,
): Promise<ModerationResult> {
  const host = await requireHost(meetingCode);

  if (host === null) {
    return { ok: false, message: NOT_HOST };
  }

  await prisma.meeting.update({
    where: { id: host.meetingId },
    data: { waitingRoomEnabled: enabled },
    select: { id: true },
  });

  return {
    ok: true,
    message: enabled
      ? "Waiting room on. Guests need your approval."
      : "Waiting room off.",
  };
}

export interface MeetingModerationState {
  ok: boolean;
  /** True only for the meeting owner. Co-hosts moderate but do not own. */
  isOwner: boolean;
  isLocked: boolean;
  waitingRoomEnabled: boolean;
  moderationAvailable: boolean;
  waiting: { userId: string; username: string; name: string | null }[];
}

/**
 * Current moderation state plus the pending knock queue.
 *
 * Host-only, because the queue names people who are not in the meeting yet.
 */
export async function getModerationState(
  meetingCode: string,
): Promise<MeetingModerationState> {
  const empty = {
    isOwner: false,
    isLocked: false,
    waitingRoomEnabled: false,
    moderationAvailable: false,
    waiting: [],
  };

  const host = await requireHost(meetingCode);

  if (host === null) {
    return { ok: false, ...empty };
  }

  const meeting = await prisma.meeting.findUnique({
    where: { id: host.meetingId },
    select: {
      isLocked: true,
      waitingRoomEnabled: true,
      knocks: {
        where: { status: KnockStatus.PENDING },
        select: {
          userId: true,
          user: { select: { username: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 25,
      },
    },
  });

  if (meeting === null) {
    return { ok: false, ...empty };
  }

  return {
    ok: true,
    isOwner: host.isOwner,
    isLocked: meeting.isLocked,
    waitingRoomEnabled: meeting.waitingRoomEnabled,
    moderationAvailable: moderationConfigured(),
    waiting: meeting.knocks.map((entry) => ({
      userId: entry.userId,
      username: entry.user.username ?? entry.userId.slice(0, 8),
      name: entry.user.name,
    })),
  };
}

/**
 * Admits or denies someone waiting.
 *
 * Admitting enrolls them, which is what lets the next token request through.
 * Scoped to a pending row so a decision cannot be flipped after the fact by a
 * replayed request.
 */
export async function decideWaitingRoom(
  meetingCode: string,
  userId: string,
  decision: "admit" | "deny",
): Promise<ModerationResult> {
  const host = await requireHost(meetingCode);

  if (host === null) {
    return { ok: false, message: NOT_HOST };
  }

  const entry = await prisma.waitingRoomEntry.findUnique({
    where: {
      meetingId_userId: { meetingId: host.meetingId, userId },
    },
    select: { id: true, status: true },
  });

  if (entry === null) {
    return { ok: false, message: "That request is no longer waiting." };
  }

  if (decision === "deny") {
    await prisma.waitingRoomEntry.update({
      where: { id: entry.id },
      data: { status: KnockStatus.DENIED, decidedById: host.localUserId },
      select: { id: true },
    });

    return { ok: true, message: "Denied." };
  }

  await prisma.$transaction([
    prisma.waitingRoomEntry.update({
      where: { id: entry.id },
      data: { status: KnockStatus.ADMITTED, decidedById: host.localUserId },
      select: { id: true },
    }),
    // Enrolled here rather than on their next request, so admission takes effect
    // even if they are already retrying.
    prisma.participant.upsert({
      where: {
        userId_meetingId: { userId, meetingId: host.meetingId },
      },
      create: { userId, meetingId: host.meetingId },
      update: {},
      select: { id: true },
    }),
  ]);

  return { ok: true, message: "Admitted." };
}

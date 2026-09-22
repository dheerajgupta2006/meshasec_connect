"use server";

/**
 * Who holds which role in a meeting.
 *
 * This exists because the room used to *infer* the host in the browser: room
 * metadata if present, otherwise the earliest participant still connected. That
 * guess drifted the moment the real host left — the crown moved to whoever
 * remained, while the moderation controls stayed with the database owner. The two
 * disagreed, so one person saw a host badge with no controls and another had
 * controls with no badge.
 *
 * Roles are now read from the database and nowhere else.
 */

import { revalidatePath } from "next/cache";

import { requireMeetingHost } from "@/lib/meetings/host-guard";
import { maybeApplyHostSuccession } from "@/lib/meetings/host-succession";
import { prisma } from "@/lib/prisma";
import { ensureCurrentUser } from "@/lib/users/current-user";

export interface MeetingRoles {
  ok: boolean;
  /**
   * LiveKit identity of the host. Identity is the Clerk subject, which is what
   * the token route publishes, so these can be compared directly against
   * participants in the room.
   */
  hostIdentity: string | null;
  coHostIdentities: string[];
  /**
   * LiveKit identity of whoever opened the meeting, which is not always the
   * acting host once the room has been handed over.
   *
   * Reported because the creator keeps moderation rights, so any client deciding
   * whether a moderation message is legitimate has to count them in. Leaving them
   * out made the server and the clients disagree: the server would let the
   * creator close a poll and every recipient would then discard the message.
   */
  creatorIdentity: string | null;
  /** True when the caller owns the meeting. */
  isHost: boolean;
  /** True when the caller has been granted co-host. */
  isCoHost: boolean;
  /**
   * True when the caller created the meeting, whether or not they still hold the
   * host role. They keep moderation rights either way, so opening a meeting can
   * never leave you locked out of it.
   */
  isCreator: boolean;
}

const EMPTY: MeetingRoles = {
  ok: false,
  hostIdentity: null,
  coHostIdentities: [],
  creatorIdentity: null,
  isHost: false,
  isCoHost: false,
  isCreator: false,
};

/**
 * Resolves roles for one meeting.
 *
 * Readable by people actually in the meeting. The badges are public *within* a
 * call — hiding them from a participant would achieve nothing — but they were
 * previously readable by any signed-in caller who named a meeting code, which is a
 * different thing entirely. That leaked the host's and co-hosts' Clerk subject ids
 * for any room, and confirmed whether a guessed code existed: the exact oracle
 * `host-guard.ts` and `setCoHost` both use a single refusal string to avoid.
 *
 * Worse, it let an unrelated caller drive `maybeApplyHostSuccession` — a LiveKit
 * round trip and a possible write to `Meeting.currentHostId` — against a meeting
 * they had nothing to do with. The gate below is now in front of that.
 *
 * Non-members get `EMPTY`, which is the same answer as a meeting that does not
 * exist, so nothing new can be inferred from the refusal.
 */
export async function getMeetingRoles(
  meetingCode: string,
): Promise<MeetingRoles> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return EMPTY;
  }

  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: {
      id: true,
      meetingCode: true,
      hostId: true,
      currentHostId: true,
      host: { select: { clerkId: true } },
      // Widened from `isCoHost: true` so the caller's own enrollment row comes
      // back in this same query. Membership is the gate immediately below, and
      // asking for it separately would add a round trip to something every client
      // in the call polls every few seconds.
      participants: {
        where: { OR: [{ isCoHost: true }, { userId: me.id }] },
        select: {
          userId: true,
          isCoHost: true,
          user: { select: { clerkId: true } },
        },
      },
    },
  });

  if (meeting === null) {
    return EMPTY;
  }

  // The host is checked directly rather than through the roster: creating a
  // meeting does not enroll you, so the owner frequently has no `Participant` row.
  const isMember =
    meeting.hostId === me.id ||
    meeting.currentHostId === me.id ||
    meeting.participants.some(
      (participant) => participant.userId === me.id,
    );

  if (!isMember) {
    return EMPTY;
  }

  // Repairs the role when the previous host closed their tab without pressing
  // Leave, which is the only case the explicit hang-up path cannot catch.
  // Throttled internally, so this does not cost a LiveKit call on every poll.
  const actingId = await maybeApplyHostSuccession(meeting);

  const acting = await prisma.user.findUnique({
    where: { id: actingId },
    select: { clerkId: true },
  });

  const coHostIdentities: string[] = [];
  let callerIsCoHost = false;

  meeting.participants.forEach((participant) => {
    // The selection above also returns the caller's own row so membership could be
    // checked without a second query, so co-host status has to be filtered here
    // rather than assumed from the row's presence.
    if (!participant.isCoHost) {
      return;
    }

    // The acting host is not also listed as a co-host: one badge per person.
    if (participant.userId === actingId) {
      return;
    }

    if (participant.userId === me.id) {
      callerIsCoHost = true;
    }

    if (participant.user.clerkId !== null) {
      coHostIdentities.push(participant.user.clerkId);
    }
  });

  const isHost = actingId === me.id;

  return {
    ok: true,
    hostIdentity: acting?.clerkId ?? null,
    coHostIdentities,
    creatorIdentity: meeting.host.clerkId,
    isHost,
    // The host already outranks a co-host, so never both.
    isCoHost: callerIsCoHost && !isHost,
    // The creator keeps moderation rights even after handing the room over, so
    // they can never be locked out of a meeting they opened.
    isCreator: meeting.hostId === me.id,
  };
}

export interface RoleActionResult {
  ok: boolean;
  message: string;
}

/**
 * Promotes or demotes a co-host. Host only.
 *
 * Deliberately not available to co-hosts: letting them appoint each other would
 * make the role self-propagating, and a host could lose control of who moderates
 * their meeting.
 */
export async function setCoHost(
  meetingCode: string,
  targetIdentity: string,
  makeCoHost: boolean,
): Promise<RoleActionResult> {
  /**
   * Through the shared guard rather than an inline comparison.
   *
   * This used to check `meeting.hostId !== me.id` itself, which is the *creator*,
   * while `requireMeetingHost`'s `"owner"` level resolves the *acting* host. The
   * two had already drifted: after a succession the person actually running the
   * meeting could not appoint co-hosts, while the creator who had left still
   * could. One definition of a permission, in one place, is the whole reason
   * `host-guard` exists.
   *
   * Still returns null for not-signed-in, not-the-host and no-such-meeting alike,
   * so the single refusal below keeps meeting codes unprobeable.
   */
  const host = await requireMeetingHost(meetingCode, "owner");

  if (host === null) {
    return { ok: false, message: "Only the host can change co-hosts." };
  }

  // Compared as identities rather than user ids, which also closes a gap: the
  // creator-only comparison let the *acting* host be handed a co-host badge after
  // a succession, leaving them holding both.
  if (targetIdentity === host.hostClerkId) {
    return { ok: false, message: "They are already the host." };
  }

  // LiveKit identity is the Clerk subject.
  const target = await prisma.user.findUnique({
    where: { clerkId: targetIdentity },
    select: { id: true, name: true, username: true },
  });

  if (target === null) {
    return { ok: false, message: "That person is not a known account." };
  }

  // `updateMany` rather than `update`: someone may be in the room without an
  // enrollment row yet, and that should read as "not eligible" rather than throw.
  const updated = await prisma.participant.updateMany({
    where: { meetingId: host.meetingId, userId: target.id },
    data: { isCoHost: makeCoHost },
  });

  if (updated.count === 0) {
    return {
      ok: false,
      message: "They need to join the meeting before you can make them co-host.",
    };
  }

  revalidatePath(`/meeting/${meetingCode}`);

  const label = target.name ?? `@${target.username ?? "participant"}`;

  return {
    ok: true,
    message: makeCoHost
      ? `${label} is now a co-host.`
      : `${label} is no longer a co-host.`,
  };
}

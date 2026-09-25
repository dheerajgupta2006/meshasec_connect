"use server";

/**
 * Starting a group call.
 *
 * Adds no new call machinery. A group call is an ordinary private `Meeting`
 * tagged with a `groupId`, so everything downstream works unchanged: the LiveKit
 * room name is still the meeting code, `authorizeMeetingJoin` still decides
 * admission, the room still appears in every member's dashboard history, and the
 * ringing banner still picks it up through `CallInvite`.
 *
 * Two things are deliberately different from `startDirectCall`:
 *
 * - **Every member is enrolled as a `Participant` up front.** That is what lets
 *   them join without a passcode prompt and what makes the call theirs rather
 *   than something they were let into.
 * - **Ringing goes through `CallInvite` for everyone, never through
 *   `Meeting.createdAt`.** The incoming-call poll's first query rings any
 *   non-host participant of a fresh private meeting, which would work once and
 *   then never again for a reused room. An invite carries its own timestamp, so
 *   re-ringing is a matter of refreshing it.
 */

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { groupRoleFor } from "@/lib/groups/queries";
import { isValidId } from "@/lib/groups/validation";
import {
  generateMeetingCode,
  generateRoomPasscode,
} from "@/lib/meetings/meeting-code";
import { prisma } from "@/lib/prisma";
import { pushConfigured, sendPushToUser } from "@/lib/push/send";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";
import { ensureCurrentUser } from "@/lib/users/current-user";

/**
 * How long a group's call stays reusable.
 *
 * Without this, three members each pressing Call open three rooms and each sits
 * alone in one. Matches the 1-on-1 window so the behaviour is not surprising when
 * moving between them.
 */
const CALL_REUSE_WINDOW_MS = 30 * 60 * 1000;

const MEETING_CODE_ATTEMPTS = 5;

const SIGN_IN_REQUIRED = "Your session has ended. Sign in again to continue.";
const NO_SUCH_GROUP = "That group does not exist, or you are not a member.";

export interface StartGroupCallResult {
  ok: boolean;
  message: string;
  /** Present only on success, so the caller can navigate to the lobby. */
  meetingCode: string | null;
}

/**
 * Rings and notifies every member except the caller.
 *
 * Both halves are best-effort and neither throws: failing to reach somebody must
 * not stop the caller entering the room they just opened.
 */
async function ringMembers(
  meetingId: string,
  meetingCode: string,
  callerId: string,
  callerName: string,
  memberIds: readonly string[],
): Promise<void> {
  const targets = memberIds.filter((userId) => userId !== callerId);

  if (targets.length === 0) {
    return;
  }

  await Promise.all(
    targets.map(async (receiverId) => {
      try {
        await prisma.callInvite.upsert({
          where: { meetingId_receiverId: { meetingId, receiverId } },
          create: { meetingId, senderId: callerId, receiverId },
          // Re-ringing: the timestamp moves back into the ringing window and any
          // previous accept or dismiss is cleared so the banner shows again.
          update: {
            senderId: callerId,
            createdAt: new Date(),
            acceptedAt: null,
            dismissedAt: null,
          },
          select: { id: true },
        });
      } catch (error: unknown) {
        console.error("ring_group_member_failed", {
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
    }),
  );

  if (!pushConfigured()) {
    return;
  }

  await Promise.all(
    targets.map((receiverId) =>
      sendPushToUser(receiverId, {
        kind: "call",
        meetingCode,
        callerName,
        // Reuses the existing group wording in the banner and the service worker.
        isGroupInvite: true,
      }).catch(() => undefined),
    ),
  );
}

/**
 * Opens, or rejoins, this group's call.
 *
 * Any member can start one. Deliberately not restricted to owners and admins:
 * those roles govern the roster, not whether the group is allowed to talk.
 */
export async function startGroupCall(
  groupId: string,
): Promise<StartGroupCallResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED, meetingCode: null };
  }

  if (!isValidId(groupId)) {
    return { ok: false, message: NO_SUCH_GROUP, meetingCode: null };
  }

  if ((await groupRoleFor(groupId, me.id)) === null) {
    return { ok: false, message: NO_SUCH_GROUP, meetingCode: null };
  }

  const verdict = consumeRateLimit("startCall", me.id);

  if (!verdict.allowed) {
    return {
      ok: false,
      message: `You are starting calls too often. Try again in ${describeRetryAfter(
        verdict.retryAfterSeconds,
      )}.`,
      meetingCode: null,
    };
  }

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      members: { select: { userId: true } },
    },
  });

  if (group === null) {
    return { ok: false, message: NO_SUCH_GROUP, meetingCode: null };
  }

  const memberIds = group.members.map((member) => member.userId);
  const callerName = me.name ?? `@${me.username}`;

  // Reuse this group's recent room rather than opening a second one. Scoped by
  // `groupId`, which is exactly what that column exists for — the 1-on-1 version
  // has to match on a pair of participants instead.
  const existing = await prisma.meeting.findFirst({
    where: {
      groupId: group.id,
      endsAt: null,
      createdAt: { gte: new Date(Date.now() - CALL_REUSE_WINDOW_MS) },
    },
    select: { id: true, meetingCode: true },
    orderBy: { createdAt: "desc" },
  });

  if (existing !== null) {
    // Members who joined the group after the room was opened have no enrollment
    // yet, so top it up before ringing them — otherwise they would be rung and
    // then refused at the door.
    await prisma.participant.createMany({
      data: memberIds.map((userId) => ({
        userId,
        meetingId: existing.id,
      })),
      skipDuplicates: true,
    });

    await ringMembers(
      existing.id,
      existing.meetingCode,
      me.id,
      callerName,
      memberIds,
    );

    revalidatePath("/dashboard");

    return {
      ok: true,
      message: `Joining the ${group.name} call.`,
      meetingCode: existing.meetingCode,
    };
  }

  for (let attempt = 0; attempt < MEETING_CODE_ATTEMPTS; attempt += 1) {
    const meetingCode = generateMeetingCode();

    try {
      const meeting = await prisma.meeting.create({
        data: {
          title: `${group.name} call`,
          meetingCode,
          hostId: me.id,
          groupId: group.id,
          // Private: only enrolled members may mint a token, so a leaked code is
          // not enough for an outsider to listen in.
          isPrivate: true,
          // The room PIN is what lets a member widen the call to an outside guest
          // later, exactly as for a 1-on-1.
          passcode: generateRoomPasscode(),
          participants: {
            create: memberIds.map((userId) => ({ userId })),
          },
        },
        select: { id: true, meetingCode: true },
      });

      await ringMembers(
        meeting.id,
        meeting.meetingCode,
        me.id,
        callerName,
        memberIds,
      );

      revalidatePath("/dashboard");

      return {
        ok: true,
        message: `Calling ${group.name}.`,
        meetingCode: meeting.meetingCode,
      };
    } catch (error: unknown) {
      const isCodeCollision =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        JSON.stringify(error.meta?.target ?? "").includes("meetingCode");

      if (isCodeCollision) {
        continue;
      }

      console.error("start_group_call_failed", {
        message: error instanceof Error ? error.message : "unknown error",
      });

      return {
        ok: false,
        message: "We could not start that call. Please try again.",
        meetingCode: null,
      };
    }
  }

  return {
    ok: false,
    message: "We could not start that call. Please try again.",
    meetingCode: null,
  };
}

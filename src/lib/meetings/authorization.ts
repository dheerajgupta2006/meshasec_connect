import "server-only";

/**
 * Room admission.
 *
 * Knowing a meeting code is not authorization. A PRIVATE meeting — every direct
 * 1-on-1 call — admits only its host and the participants enrolled on it, so a
 * leaked or guessed code cannot be used to listen in.
 *
 * An open meeting is deliberately joinable by link, which is the whole point of
 * an invite. Joining one enrolls the person, so it appears in their dashboard
 * history afterwards.
 */

import { normalizePasscode } from "@/lib/meetings/passcode";
import { passcodeMatches } from "@/lib/meetings/passcode-verify";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, refundRateLimit } from "@/lib/rate-limit";

export interface JoinableMeeting {
  id: string;
  meetingCode: string;
  isPrivate: boolean;
}

export type JoinRefusalReason =
  | "not_found"
  | "forbidden"
  /** A passcode is needed and none was supplied. Prompt for it. */
  | "passcode_required"
  /** A passcode was supplied and was wrong. Prompt again with an error. */
  | "passcode_invalid"
  /** Too many wrong guesses. Prompting again would be pointless. */
  | "passcode_throttled"
  /** The host removed this person. Rejoining is not offered. */
  | "removed"
  /** The host locked the room. Existing participants are unaffected. */
  | "locked"
  /** Knock accepted; waiting for the host to admit. Not a failure. */
  | "waiting_for_host";

export type JoinDecision =
  | { allowed: true; meeting: JoinableMeeting; enrolled: boolean }
  | {
      allowed: false;
      reason: JoinRefusalReason;
      /** Present only for `passcode_throttled`. */
      retryAfterSeconds?: number;
    };

/**
 * Decides whether `localUserId` may join `meetingCode`.
 *
 * Three tiers of admission:
 * 1. The host and already-enrolled participants are always in, and never see a
 *    passcode prompt. This is what makes an invited friend's join seamless.
 * 2. A guest holding the link may present the room passcode. This is the
 *    external-guest path, and it works even for a PRIVATE room, because the whole
 *    point of expanding a call is to let the host widen it deliberately.
 * 3. Everyone else is refused.
 *
 * A wrong passcode consumes attempt quota; a correct one does not. That keeps a
 * six-digit secret from being walked while never penalising a legitimate guest.
 */
export async function authorizeMeetingJoin(
  meetingCode: string,
  localUserId: string,
  submittedPasscode?: string | null,
): Promise<JoinDecision> {
  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: {
      id: true,
      meetingCode: true,
      isPrivate: true,
      hostId: true,
      passcode: true,
      isLocked: true,
      waitingRoomEnabled: true,
      participants: {
        where: { userId: localUserId },
        select: { id: true },
        take: 1,
      },
      knocks: {
        where: { userId: localUserId },
        select: { status: true },
        take: 1,
      },
    },
  });

  if (meeting === null) {
    return { allowed: false, reason: "not_found" };
  }

  const isHost = meeting.hostId === localUserId;
  const isParticipant = meeting.participants.length > 0;
  const knock = meeting.knocks[0] ?? null;

  const admit = (): JoinDecision => ({
    allowed: true,
    meeting: {
      id: meeting.id,
      meetingCode: meeting.meetingCode,
      isPrivate: meeting.isPrivate,
    },
    enrolled: isHost || isParticipant,
  });

  // The host is always in, and is never subject to their own lock or waiting
  // room — otherwise they could shut themselves out of their own meeting.
  if (isHost) {
    return admit();
  }

  // A host-issued removal outranks enrollment: being removed has to survive the
  // `Participant` row, or the person walks straight back in.
  if (knock?.status === "DENIED") {
    return { allowed: false, reason: "removed" };
  }

  // Enrolled participants are never prompted and never burn passcode quota.
  // Locking deliberately does not eject them.
  if (isParticipant) {
    return admit();
  }

  // --- Everything below is an unenrolled guest. ---

  if (meeting.isLocked) {
    return { allowed: false, reason: "locked" };
  }

  // An open meeting stays joinable by link alone. Requiring a passcode here would
  // break every invite link already in circulation. The waiting room check below
  // still applies.
  if (!meeting.isPrivate) {
    return meeting.waitingRoomEnabled && knock?.status !== "ADMITTED"
      ? { allowed: false, reason: "waiting_for_host" }
      : admit();
  }

  // Tier 2: private room, unenrolled caller. A passcode is the only way in.
  // `?? null` so a column that is absent rather than null cannot fall through to
  // the comparison and be treated as a set passcode.
  const storedPasscode = meeting.passcode ?? null;

  if (storedPasscode === null) {
    // Rooms created before passcodes existed, and any room the host has not
    // shared. Indistinguishable from "not invited", which is the right answer.
    return { allowed: false, reason: "forbidden" };
  }

  const normalized = normalizePasscode(submittedPasscode ?? null);

  if (normalized === null) {
    // Covers both "nothing supplied" and "malformed", which the caller renders
    // the same way: show the prompt.
    return { allowed: false, reason: "passcode_required" };
  }

  // Scoped to the meeting *and* the user so one attacker cannot lock a room's
  // legitimate guests out, and cannot spread guesses across rooms either.
  const attempt = consumeRateLimit(
    "meetingPasscode",
    `${meeting.id}:${localUserId}`,
  );

  if (!attempt.allowed) {
    return {
      allowed: false,
      reason: "passcode_throttled",
      retryAfterSeconds: attempt.retryAfterSeconds,
    };
  }

  if (!passcodeMatches(storedPasscode, normalized)) {
    return { allowed: false, reason: "passcode_invalid" };
  }

  // Correct guess: refund the attempt so a guest who mistypes once and then gets
  // it right is not left with a depleted budget for the rest of the window.
  refundRateLimit("meetingPasscode", `${meeting.id}:${localUserId}`);

  // The passcode proves they were invited; the waiting room is a separate,
  // deliberate gate on top of that, so it is checked last.
  if (meeting.waitingRoomEnabled && knock?.status !== "ADMITTED") {
    return { allowed: false, reason: "waiting_for_host" };
  }

  return admit();
}

/**
 * Records attendance. Safe to call repeatedly: the unique `[userId, meetingId]`
 * constraint collapses duplicates, and a failure here must never block a join
 * that has already been authorized.
 */
export async function recordAttendance(
  meetingId: string,
  localUserId: string,
): Promise<void> {
  try {
    await prisma.participant.upsert({
      where: {
        userId_meetingId: { userId: localUserId, meetingId },
      },
      create: { userId: localUserId, meetingId },
      update: {},
      select: { id: true },
    });
  } catch (error: unknown) {
    console.error("record_attendance_failed", {
      meetingId,
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
}

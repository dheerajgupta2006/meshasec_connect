import "server-only";

/**
 * Admission for guests who have no account.
 *
 * Kept separate from `authorizeMeetingJoin` because the two answer different
 * questions. That function asks "is this *user* allowed in", and every tier of it
 * — host, enrolled participant, removal, waiting-room approval — is keyed to a
 * user id a guest does not have. A guest's only claim is the passcode, so this is
 * a deliberately narrower check rather than a special case bolted into the other.
 */

import { normalizePasscode } from "@/lib/meetings/passcode";
import { passcodeMatches } from "@/lib/meetings/passcode-verify";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, refundRateLimit } from "@/lib/rate-limit";

export type GuestAdmission =
  | {
      allowed: true;
      meetingId: string;
      meetingCode: string;
      /**
       * True when the passcode was right but the host still has to let them in.
       * The session is issued either way — proving the passcode is what earns the
       * cookie; approval is a separate gate on top of it.
       */
      requiresApproval: boolean;
    }
  | {
      allowed: false;
      reason:
        | "not_found"
        | "passcode_required"
        | "passcode_invalid"
        | "passcode_throttled"
        | "locked"
        | "removed"
        | "no_passcode";
      retryAfterSeconds?: number;
    };

/**
 * Decides whether a guest may enter, given a passcode and an attempt subject.
 *
 * `attemptSubject` is what the brute-force limit is keyed on. For a signed-in user
 * that is their id; a guest has none, so the caller passes their IP. That is
 * genuinely weaker — everyone behind one NAT shares a budget — but a six-digit
 * passcode with no limit at all is far worse.
 */
export async function admitGuest(
  meetingCode: string,
  submittedPasscode: string | null,
  attemptSubject: string,
  knownGuestId: string | null,
): Promise<GuestAdmission> {
  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: {
      id: true,
      meetingCode: true,
      passcode: true,
      isLocked: true,
      waitingRoomEnabled: true,
    },
  });

  if (meeting === null) {
    return { allowed: false, reason: "not_found" };
  }

  // A returning guest who was removed stays removed. Checked before the passcode
  // so a banned guest cannot tell a wrong code from a ban.
  if (knownGuestId !== null) {
    const banned = await prisma.meetingGuestBan.findUnique({
      where: {
        meetingId_guestId: { meetingId: meeting.id, guestId: knownGuestId },
      },
      select: { id: true },
    });

    if (banned !== null) {
      return { allowed: false, reason: "removed" };
    }
  }

  if (meeting.isLocked) {
    return { allowed: false, reason: "locked" };
  }

  // A room with no passcode has no way for a guest to prove anything, so guests
  // cannot enter it at all. Rooms created before passcodes existed land here.
  if (meeting.passcode === null) {
    return { allowed: false, reason: "no_passcode" };
  }

  const normalized = normalizePasscode(submittedPasscode);

  if (normalized === null) {
    return { allowed: false, reason: "passcode_required" };
  }

  const attempt = consumeRateLimit(
    "meetingPasscode",
    `guest:${meeting.id}:${attemptSubject}`,
  );

  if (!attempt.allowed) {
    return {
      allowed: false,
      reason: "passcode_throttled",
      retryAfterSeconds: attempt.retryAfterSeconds,
    };
  }

  if (!passcodeMatches(meeting.passcode, normalized)) {
    return { allowed: false, reason: "passcode_invalid" };
  }

  // Correct: refund so a guest who mistypes once is not penalised.
  refundRateLimit("meetingPasscode", `guest:${meeting.id}:${attemptSubject}`);

  return {
    allowed: true,
    meetingId: meeting.id,
    meetingCode: meeting.meetingCode,
    requiresApproval: meeting.waitingRoomEnabled,
  };
}

export type GuestKnockState = "admitted" | "waiting" | "denied";

/**
 * Records or reads a guest's request to be let in.
 *
 * Safe to poll: an existing row is only created, never reset, so repeatedly asking
 * cannot clear a decision the host has already made. That is the difference
 * between knocking and retrying — a denied guest must not be able to undo their
 * own denial by reloading.
 */
export async function knockAsGuest(
  meetingCode: string,
  guestId: string,
  displayName: string,
): Promise<GuestKnockState> {
  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: { id: true, waitingRoomEnabled: true },
  });

  if (meeting === null) {
    return "denied";
  }

  // Removal outranks any knock.
  const banned = await prisma.meetingGuestBan.findUnique({
    where: { meetingId_guestId: { meetingId: meeting.id, guestId } },
    select: { id: true },
  });

  if (banned !== null) {
    return "denied";
  }

  const existing = await prisma.guestWaitingEntry.findUnique({
    where: { meetingId_guestId: { meetingId: meeting.id, guestId } },
    select: { status: true },
  });

  if (existing?.status === "ADMITTED") {
    return "admitted";
  }

  if (existing?.status === "DENIED") {
    return "denied";
  }

  // The waiting room was switched off while they were waiting: nothing left to
  // wait for, and the passcode they already proved is enough.
  if (!meeting.waitingRoomEnabled) {
    return "admitted";
  }

  if (existing === null) {
    try {
      await prisma.guestWaitingEntry.create({
        data: {
          meetingId: meeting.id,
          guestId,
          displayName,
        },
        select: { id: true },
      });
    } catch {
      // A concurrent knock won the unique index; its row is the one that counts.
      return "waiting";
    }
  }

  return "waiting";
}

/**
 * Whether this guest may currently mint a media token.
 *
 * Called at token time, not just at the passcode exchange, so revoking approval or
 * turning the waiting room on mid-call takes effect on the next reconnect.
 */
export async function guestApprovalState(
  meetingCode: string,
  guestId: string,
): Promise<GuestKnockState> {
  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: { id: true, waitingRoomEnabled: true },
  });

  if (meeting === null) {
    return "denied";
  }

  const entry = await prisma.guestWaitingEntry.findUnique({
    where: { meetingId_guestId: { meetingId: meeting.id, guestId } },
    select: { status: true },
  });

  if (entry?.status === "DENIED") {
    return "denied";
  }

  if (entry?.status === "ADMITTED") {
    return "admitted";
  }

  // No decision recorded. Only a gate when the waiting room is actually on.
  return meeting.waitingRoomEnabled ? "waiting" : "admitted";
}

/** True when this guest has been removed from the meeting. */
export async function isGuestBanned(
  meetingCode: string,
  guestId: string,
): Promise<boolean> {
  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: { id: true },
  });

  if (meeting === null) {
    return true;
  }

  const banned = await prisma.meetingGuestBan.findUnique({
    where: { meetingId_guestId: { meetingId: meeting.id, guestId } },
    select: { id: true },
  });

  return banned !== null;
}

/**
 * Best-effort client address, used only as a rate-limit key.
 *
 * Never used for access control: `x-forwarded-for` is client-supplied and only
 * trustworthy because Vercel's proxy overwrites it. A spoofed value here can at
 * worst give the attacker a fresh attempt budget, which is why the budget is not
 * the only defence — the passcode still has to be right.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded !== null && forwarded.length > 0) {
    const first = forwarded.split(",")[0]?.trim();

    if (first !== undefined && first.length > 0) {
      return first.slice(0, 64);
    }
  }

  return request.headers.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}

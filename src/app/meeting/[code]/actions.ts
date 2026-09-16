"use server";

/**
 * Room lifecycle actions.
 *
 * Leaving a room used to be purely client-side — `room.disconnect()` and a
 * navigation — so the database never learned that anything had happened. That is
 * why an instant meeting stayed in Upcoming forever: `endsAt` was never written
 * by anyone.
 */

import { revalidatePath } from "next/cache";

import {
  authorizeMeetingJoin,
  recordAttendance,
} from "@/lib/meetings/authorization";
import {
  actingHostId,
  applyHostSuccession,
} from "@/lib/meetings/host-succession";
import { ROOM_PASSCODE_DIGITS } from "@/lib/meetings/types";
import { prisma } from "@/lib/prisma";
import { describeRetryAfter } from "@/lib/rate-limit";
import { ensureCurrentUser } from "@/lib/users/current-user";

export interface RoomActionResult {
  ok: boolean;
  message: string;
}

const SIGN_IN_REQUIRED = "Your session has ended. Sign in again to continue.";

/**
 * Records that the caller left. Never ends the meeting.
 *
 * This deliberately does *not* set `endsAt`, not even for the host. It used to,
 * and that was wrong: the room unmounts on any client navigation, so opening the
 * dashboard or a chat thread ended the call for everybody and made it
 * unrejoinable. Ending is now only ever explicit, through `endMeeting`.
 *
 * Idempotent and never throws: this runs while the user is navigating away, and a
 * failure here must not block them leaving or surface an error on a page they are
 * already off.
 */
export async function leaveMeeting(
  meetingCode: string,
): Promise<RoomActionResult> {
  try {
    const me = await ensureCurrentUser();

    if (me === null) {
      return { ok: false, message: SIGN_IN_REQUIRED };
    }

    // Reuses the join gate so someone who could not enter the room cannot end it
    // either.
    const decision = await authorizeMeetingJoin(meetingCode, me.id);

    if (!decision.allowed) {
      return { ok: false, message: "That meeting is not available." };
    }

    // Attendance may not exist for a link-holder who never enrolled, so this is
    // an updateMany rather than an update: zero rows affected is fine.
    await prisma.participant.updateMany({
      where: {
        meetingId: decision.meeting.id,
        userId: me.id,
        leftAt: null,
      },
      data: { leftAt: new Date() },
    });

    // If the person leaving was running the meeting, hand the role to whoever is
    // still in the room. Without this the remaining participants would be left
    // with nobody able to mute, admit or remove anyone.
    const meeting = await prisma.meeting.findUnique({
      where: { id: decision.meeting.id },
      select: {
        id: true,
        meetingCode: true,
        hostId: true,
        currentHostId: true,
      },
    });

    if (meeting !== null && actingHostId(meeting) === me.id) {
      await applyHostSuccession(meeting).catch(() => undefined);
    }

    revalidatePath("/dashboard");

    return { ok: true, message: "You left the meeting." };
  } catch {
    // Swallowed on purpose. See the note above: this fires during teardown.
    return { ok: false, message: "We could not record that you left." };
  }
}

export interface PasscodeCheckResult {
  ok: boolean;
  message: string;
}

/**
 * Verifies a room passcode from the lobby and enrolls the guest on success.
 *
 * Enrolling here is what makes the rest of the flow simple: once the guest is a
 * `Participant`, the token route admits them under tier 1 and the passcode never
 * has to be carried through `sessionStorage` or re-sent. It also means the
 * meeting lands in their dashboard history, same as any other attendee.
 *
 * The attempt budget lives in `authorizeMeetingJoin`, so repeated wrong guesses
 * here are throttled exactly as they would be at the token endpoint.
 */
export async function verifyRoomPasscode(
  meetingCode: string,
  passcode: string,
): Promise<PasscodeCheckResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const decision = await authorizeMeetingJoin(meetingCode, me.id, passcode);

  if (decision.allowed) {
    if (!decision.enrolled) {
      await recordAttendance(decision.meeting.id, me.id);
    }

    return { ok: true, message: "" };
  }

  switch (decision.reason) {
    case "not_found":
      return { ok: false, message: "That meeting no longer exists." };

    case "passcode_required":
      return {
        ok: false,
        message: `Enter the ${ROOM_PASSCODE_DIGITS}-digit room passcode.`,
      };

    case "passcode_invalid":
      return { ok: false, message: "That passcode is not correct." };

    case "passcode_throttled":
      return {
        ok: false,
        message: `Too many incorrect passcodes. Try again in ${describeRetryAfter(
          decision.retryAfterSeconds ?? 60,
        )}.`,
      };

    default:
      return {
        ok: false,
        message: "You do not have access to this meeting.",
      };
  }
}

export type KnockOutcome =
  | { state: "admitted" }
  | { state: "waiting" }
  | { state: "denied" }
  | { state: "error"; message: string };

/**
 * Asks the host for entry, and reports where the request stands.
 *
 * Idempotent and safe to poll: an existing row is only touched when it is still
 * pending, so polling can never reset a decision the host already made. That is
 * the difference between a knock and a retry — a denied guest must not be able to
 * clear their own denial by asking again.
 */
export async function knockForEntry(
  meetingCode: string,
): Promise<KnockOutcome> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { state: "error", message: SIGN_IN_REQUIRED };
  }

  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: { id: true, hostId: true, waitingRoomEnabled: true },
  });

  if (meeting === null) {
    return { state: "error", message: "That meeting no longer exists." };
  }

  // The host never waits for themselves.
  if (meeting.hostId === me.id) {
    return { state: "admitted" };
  }

  const existing = await prisma.waitingRoomEntry.findUnique({
    where: {
      meetingId_userId: { meetingId: meeting.id, userId: me.id },
    },
    select: { status: true },
  });

  if (existing?.status === "ADMITTED") {
    return { state: "admitted" };
  }

  if (existing?.status === "DENIED") {
    return { state: "denied" };
  }

  if (!meeting.waitingRoomEnabled) {
    // Nothing to wait for. The token request is the real gate.
    return { state: "admitted" };
  }

  if (existing === null) {
    try {
      await prisma.waitingRoomEntry.create({
        data: { meetingId: meeting.id, userId: me.id },
        select: { id: true },
      });
    } catch {
      // A concurrent knock won the unique index. Its row is the one that counts.
      return { state: "waiting" };
    }
  }

  return { state: "waiting" };
}

/**
 * Explicitly ends a meeting for everyone. Host only.
 *
 * Separate from `leaveMeeting` so the intent is unambiguous at the call site, and
 * so a future "End for all" button does not have to depend on who is leaving.
 */
export async function endMeeting(
  meetingCode: string,
): Promise<RoomActionResult> {
  try {
    const me = await ensureCurrentUser();

    if (me === null) {
      return { ok: false, message: SIGN_IN_REQUIRED };
    }

    const decision = await authorizeMeetingJoin(meetingCode, me.id);

    if (!decision.allowed) {
      return { ok: false, message: "That meeting is not available." };
    }

    const meeting = await prisma.meeting.findUnique({
      where: { id: decision.meeting.id },
      select: { id: true, hostId: true, endsAt: true },
    });

    if (meeting === null) {
      return { ok: false, message: "That meeting is not available." };
    }

    if (meeting.hostId !== me.id) {
      return { ok: false, message: "Only the host can end this meeting." };
    }

    // Already ended is a success, not an error: a double-click or a retry after a
    // lost response lands here.
    if (meeting.endsAt !== null) {
      return { ok: true, message: "Meeting already ended." };
    }

    const now = new Date();

    await prisma.$transaction([
      prisma.meeting.update({
        where: { id: meeting.id },
        data: { endsAt: now },
        select: { id: true },
      }),
      prisma.participant.updateMany({
        where: { meetingId: meeting.id, leftAt: null },
        data: { leftAt: now },
      }),
    ]);

    revalidatePath("/dashboard");

    return { ok: true, message: "Meeting ended." };
  } catch {
    return { ok: false, message: "We could not end the meeting." };
  }
}

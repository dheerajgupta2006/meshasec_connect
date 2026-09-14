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

import { prisma } from "@/lib/prisma";

export interface JoinableMeeting {
  id: string;
  meetingCode: string;
  isPrivate: boolean;
}

export type JoinDecision =
  | { allowed: true; meeting: JoinableMeeting; enrolled: boolean }
  | { allowed: false; reason: "not_found" | "forbidden" };

/**
 * Decides whether `localUserId` may join `meetingCode`.
 *
 * Enrollment is recorded for open meetings so the dashboard's participant-based
 * history query can see them. It is deliberately not created for a private
 * meeting: that would let the first uninvited caller write themselves in.
 */
export async function authorizeMeetingJoin(
  meetingCode: string,
  localUserId: string,
): Promise<JoinDecision> {
  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: {
      id: true,
      meetingCode: true,
      isPrivate: true,
      hostId: true,
      participants: {
        where: { userId: localUserId },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (meeting === null) {
    return { allowed: false, reason: "not_found" };
  }

  const isHost = meeting.hostId === localUserId;
  const isParticipant = meeting.participants.length > 0;

  if (meeting.isPrivate && !isHost && !isParticipant) {
    return { allowed: false, reason: "forbidden" };
  }

  return {
    allowed: true,
    meeting: {
      id: meeting.id,
      meetingCode: meeting.meetingCode,
      isPrivate: meeting.isPrivate,
    },
    enrolled: isHost || isParticipant,
  };
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

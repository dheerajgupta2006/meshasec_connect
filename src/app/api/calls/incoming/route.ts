import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { timed } from "@/lib/timing";

export const runtime = "nodejs";

/**
 * How recently a call must have been opened to still be "ringing".
 *
 * Deliberately shorter than the reuse window in `startDirectCall`: a room stays
 * joinable for a while, but it should stop announcing itself long before that.
 */
const RINGING_WINDOW_MS = 90 * 1000;

/** Cap so a burst of calls cannot make the banner unbounded. */
const MAX_RINGING = 3;

export interface IncomingCall {
  meetingCode: string;
  callerName: string;
  callerUsername: string;
  createdAt: string;
  /**
   * True when this is a mid-call invite into an existing room rather than a
   * fresh 1-on-1. Drives the "invited you to a group call" wording.
   */
  isGroupInvite: boolean;
}

/**
 * Calls waiting for this user.
 *
 * This endpoint is polled continuously, so it is deliberately a *single* query
 * filtered through the participant relation on the Clerk subject. Resolving the
 * local user first would double the round trips, and against a remote database
 * that is the difference between a fast poll and pool exhaustion.
 */
export async function GET(): Promise<NextResponse> {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - RINGING_WINDOW_MS);

  // Two independent sources of a ring, run in parallel: a brand-new direct call,
  // and a mid-call invite into a room that may be much older than the window.
  // They cannot be one query — the direct-call case filters on the *meeting's*
  // age, the invite case on the *invite's* age.
  const [meetings, invites] = await Promise.all([
    timed("calls.incoming.query", () =>
      prisma.meeting.findMany({
        where: {
          isPrivate: true,
          createdAt: { gte: since },
          // Enrolled by someone else, which is exactly what startDirectCall does.
          participants: { some: { user: { is: { clerkId } } } },
          // You are not rung by a call you opened yourself.
          NOT: { host: { is: { clerkId } } },
        },
        select: {
          meetingCode: true,
          createdAt: true,
          host: { select: { name: true, username: true } },
        },
        orderBy: { createdAt: "desc" },
        take: MAX_RINGING,
      }),
    ),
    timed("calls.incoming.invites", () =>
      prisma.callInvite.findMany({
        where: {
          createdAt: { gte: since },
          // Unanswered only: accepting or declining stops the ring.
          acceptedAt: null,
          dismissedAt: null,
          receiver: { is: { clerkId } },
          // Defensive: you should never be the sender of your own invite, but a
          // self-invite would otherwise ring the sender.
          NOT: { sender: { is: { clerkId } } },
          // A meeting that has been ended must not keep ringing.
          meeting: { is: { endsAt: null } },
        },
        select: {
          createdAt: true,
          meeting: { select: { meetingCode: true } },
          sender: { select: { name: true, username: true } },
        },
        orderBy: { createdAt: "desc" },
        take: MAX_RINGING,
      }),
    ),
  ]);

  const calls: IncomingCall[] = meetings.map((meeting) => {
    const username = meeting.host.username ?? "someone";

    return {
      meetingCode: meeting.meetingCode,
      callerName: meeting.host.name ?? `@${username}`,
      callerUsername: username,
      createdAt: meeting.createdAt.toISOString(),
      isGroupInvite: false,
    };
  });

  // Deduplicated by room: a direct call whose invite was also re-sent must ring
  // once, not twice. The direct-call entry is kept because it is the more
  // specific description of that room.
  const seenRooms = new Set(calls.map((call) => call.meetingCode));

  invites.forEach((invite) => {
    const meetingCode = invite.meeting.meetingCode;

    if (seenRooms.has(meetingCode)) {
      return;
    }

    seenRooms.add(meetingCode);

    const username = invite.sender.username ?? "someone";

    calls.push({
      meetingCode,
      callerName: invite.sender.name ?? `@${username}`,
      callerUsername: username,
      createdAt: invite.createdAt.toISOString(),
      isGroupInvite: true,
    });
  });

  calls.sort(
    (first, second) =>
      new Date(second.createdAt).getTime() -
      new Date(first.createdAt).getTime(),
  );

  return NextResponse.json(
    { calls: calls.slice(0, MAX_RINGING) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

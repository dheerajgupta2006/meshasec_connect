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

  const meetings = await timed("calls.incoming.query", () =>
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
  );

  const calls: IncomingCall[] = meetings.map((meeting) => {
    const username = meeting.host.username ?? "someone";

    return {
      meetingCode: meeting.meetingCode,
      callerName: meeting.host.name ?? `@${username}`,
      callerUsername: username,
      createdAt: meeting.createdAt.toISOString(),
    };
  });

  return NextResponse.json(
    { calls },
    { headers: { "Cache-Control": "no-store" } },
  );
}

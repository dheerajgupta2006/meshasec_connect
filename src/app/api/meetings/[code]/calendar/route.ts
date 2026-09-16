import { NextResponse } from "next/server";

import { meetingDescription } from "@/lib/brand";
import { buildIcsCalendar, icsFilename } from "@/lib/calendar/ics";
import { authorizeMeetingJoin } from "@/lib/meetings/authorization";
import { prisma } from "@/lib/prisma";
import { resolveAppOrigin } from "@/lib/meetings/app-origin";
import { ensureCurrentUser } from "@/lib/users/current-user";

export const runtime = "nodejs";

const MAX_MEETING_CODE_LENGTH = 128;

/**
 * Serves a calendar file for one meeting.
 *
 * Gated by the same admission check as joining: a private meeting must not leak
 * its title or schedule to someone who could not enter the room. `authorize`
 * runs before any meeting field is read out.
 *
 * Deliberately does not enroll the caller. Downloading an invite is not
 * attending, so unlike the token route this one never calls `recordAttendance`.
 */
export async function GET(
  request: Request,
  { params }: { params: { code: string } },
): Promise<NextResponse> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const meetingCode = decodeURIComponent(params.code ?? "").trim();

  if (
    meetingCode.length === 0 ||
    meetingCode.length > MAX_MEETING_CODE_LENGTH
  ) {
    return NextResponse.json({ error: "Invalid meeting code" }, { status: 400 });
  }

  const decision = await authorizeMeetingJoin(meetingCode, me.id);

  if (!decision.allowed) {
    return NextResponse.json(
      { error: decision.reason === "not_found" ? "Not found" : "Forbidden" },
      { status: decision.reason === "not_found" ? 404 : 403 },
    );
  }

  const meeting = await prisma.meeting.findUnique({
    where: { id: decision.meeting.id },
    select: {
      id: true,
      title: true,
      createdAt: true,
      startsAt: true,
      endsAt: true,
      host: { select: { name: true, email: true } },
    },
  });

  if (meeting === null) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const origin = resolveAppOrigin(request);
  const joinUrl = `${origin}/meeting/${encodeURIComponent(
    decision.meeting.meetingCode,
  )}/lobby`;

  const calendar = buildIcsCalendar({
    // Stable per meeting: re-downloading updates the existing calendar entry
    // instead of creating a duplicate.
    uid: `meeting-${meeting.id}@meshasec`,
    title: meeting.title,
    description: meetingDescription(decision.meeting.meetingCode),
    url: joinUrl,
    // An instant meeting has no `startsAt`; its creation time is when it opened.
    startsAt: meeting.startsAt ?? meeting.createdAt,
    endsAt: meeting.endsAt,
    organizerName: meeting.host.name,
    organizerEmail: meeting.host.email,
  });

  return new NextResponse(calendar, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${icsFilename(
        meeting.title,
        decision.meeting.meetingCode,
      )}"`,
      // Contains meeting details for one specific viewer; must not be shared by
      // an intermediary cache.
      "Cache-Control": "private, no-store",
    },
  });
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { knockAsGuest } from "@/lib/meetings/guest-admission";
import {
  GUEST_COOKIE_NAME,
  readGuestSessionFor,
} from "@/lib/meetings/guest-session";
import { notifyHostOfGuestKnock } from "@/lib/meetings/guest-notify";

export const runtime = "nodejs";

const MAX_MEETING_CODE_LENGTH = 128;

/**
 * Asks the host to admit a guest, and reports where the request stands.
 *
 * Polled by the guest's lobby while they wait. The guest session cookie is the
 * only credential accepted — the body cannot name a different meeting or guest, so
 * one guest cannot knock on another's behalf or check someone else's status.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const meetingCode =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { meetingCode?: unknown }).meetingCode === "string"
      ? (body as { meetingCode: string }).meetingCode.trim()
      : "";

  if (
    meetingCode.length === 0 ||
    meetingCode.length > MAX_MEETING_CODE_LENGTH
  ) {
    return NextResponse.json({ error: "Invalid meeting code" }, { status: 400 });
  }

  const store = await cookies();
  const session = readGuestSessionFor(
    store.get(GUEST_COOKIE_NAME)?.value,
    meetingCode,
  );

  if (session === null) {
    return NextResponse.json(
      { error: "Enter the room passcode first.", code: "guest_session_required" },
      { status: 401 },
    );
  }

  const state = await knockAsGuest(
    meetingCode,
    session.guestId,
    session.displayName,
  );

  // Only on the first transition into waiting, so a polling lobby does not
  // notify the host every few seconds.
  if (state === "waiting") {
    await notifyHostOfGuestKnock(
      meetingCode,
      session.guestId,
      session.displayName,
    );
  }

  return NextResponse.json(
    { state },
    { headers: { "Cache-Control": "no-store" } },
  );
}

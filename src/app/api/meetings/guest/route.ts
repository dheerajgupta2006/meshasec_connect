import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  admitGuest,
  clientAddress,
} from "@/lib/meetings/guest-admission";
import {
  GUEST_COOKIE_NAME,
  guestCookieOptions,
  guestSessionsConfigured,
  issueGuestToken,
  normalizeGuestName,
  readGuestToken,
} from "@/lib/meetings/guest-session";
import { describeRetryAfter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_MEETING_CODE_LENGTH = 128;

function readString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];

  return typeof value === "string" ? value : null;
}

/**
 * Exchanges a room passcode for a guest session.
 *
 * This is the only endpoint in the app that grants access without an account, so
 * it is deliberately minimal: it verifies one passcode against one meeting and
 * issues a token scoped to that meeting alone. It creates no `User`, no
 * `Participant`, and nothing that outlives the session.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!guestSessionsConfigured()) {
    return NextResponse.json(
      {
        error:
          "Guest access is not configured on this server. Sign in to join instead.",
        code: "not_configured",
      },
      { status: 503 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const meetingCode = (readString(body, "meetingCode") ?? "").trim();

  if (
    meetingCode.length === 0 ||
    meetingCode.length > MAX_MEETING_CODE_LENGTH
  ) {
    return NextResponse.json({ error: "Invalid meeting code" }, { status: 400 });
  }

  const store = await cookies();
  const existing = readGuestToken(store.get(GUEST_COOKIE_NAME)?.value);

  const admission = await admitGuest(
    meetingCode,
    readString(body, "passcode"),
    clientAddress(request),
    // A previous session's id, so a removed guest stays removed across reloads.
    existing?.meetingCode === meetingCode ? existing.guestId : null,
  );

  if (!admission.allowed) {
    if (admission.reason === "not_found") {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    if (admission.reason === "passcode_throttled") {
      const retryAfter = admission.retryAfterSeconds ?? 60;

      return NextResponse.json(
        {
          error: `Too many incorrect passcodes. Try again in ${describeRetryAfter(
            retryAfter,
          )}.`,
          code: admission.reason,
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    const messages: Record<string, string> = {
      passcode_required: "Enter the room passcode.",
      passcode_invalid: "That passcode is not correct.",
      locked: "The host has locked this meeting.",
      removed: "The host removed you from this meeting.",
      no_passcode:
        "This room has no guest passcode. Ask the host to invite you, or sign in.",
    };

    return NextResponse.json(
      {
        error: messages[admission.reason] ?? "You cannot join this meeting.",
        code: admission.reason,
      },
      { status: admission.reason === "passcode_invalid" ? 401 : 403 },
    );
  }

  const issued = issueGuestToken(
    admission.meetingCode,
    normalizeGuestName(readString(body, "name")),
  );

  if (issued === null) {
    return NextResponse.json(
      { error: "Guest access is not configured." },
      { status: 503 },
    );
  }

  const response = NextResponse.json({
    ok: true,
    displayName: issued.session.displayName,
    // The lobby uses this to decide whether to show the waiting state straight
    // away rather than briefly implying they are about to join.
    requiresApproval: admission.requiresApproval,
  });

  response.cookies.set(
    GUEST_COOKIE_NAME,
    issued.token,
    guestCookieOptions(),
  );

  return response;
}

/** Ends the guest session, so leaving a room does not leave the token lying around. */
export async function DELETE(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });

  response.cookies.set(GUEST_COOKIE_NAME, "", {
    ...guestCookieOptions(),
    maxAge: 0,
  });

  return response;
}

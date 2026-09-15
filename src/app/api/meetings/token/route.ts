import { AccessToken } from "livekit-server-sdk";
import { NextResponse } from "next/server";

import {
  authorizeMeetingJoin,
  recordAttendance,
} from "@/lib/meetings/authorization";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";
import { ensureCurrentUser } from "@/lib/users/current-user";

export const runtime = "nodejs";

const MAX_MEETING_CODE_LENGTH = 128;

/**
 * Token lifetime.
 *
 * LiveKit validates the token on the initial join and again on reconnect, so a
 * short TTL boots people out of long meetings after a network blip. Twelve hours
 * comfortably outlives any realistic session while still bounding replay of a
 * leaked token.
 */
const TOKEN_TTL = "12h";

function readMeetingCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const body = value as Record<string, unknown>;

  return typeof body.meetingCode === "string" ? body.meetingCode : null;
}

/**
 * Reads the optional room passcode.
 *
 * Absent and malformed both become null: `authorizeMeetingJoin` normalises and
 * judges it, so this only has to avoid passing a non-string through.
 */
function readPasscode(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const body = value as Record<string, unknown>;

  return typeof body.passcode === "string" ? body.passcode : null;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  // Resolves the local row as well as the session: admission is decided against
  // `User.id`, which is what Meeting.hostId and Participant.userId reference.
  const me = await ensureCurrentUser();

  if (me === null) {
    return errorResponse("Unauthorized", 401);
  }

  const limit = consumeRateLimit("meetingToken", me.id);

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Too many join attempts. Try again in ${describeRetryAfter(
          limit.retryAfterSeconds,
        )}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  const rawMeetingCode = readMeetingCode(body);

  if (rawMeetingCode === null) {
    return errorResponse("meetingCode must be a string", 400);
  }

  const meetingCode = rawMeetingCode.trim();

  if (meetingCode.length === 0) {
    return errorResponse("meetingCode is required", 400);
  }

  if (meetingCode.length > MAX_MEETING_CODE_LENGTH) {
    return errorResponse("meetingCode exceeds the allowed length", 400);
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error("LiveKit API credentials are not configured");
    return errorResponse("Token service is not configured", 500);
  }

  try {
    const decision = await authorizeMeetingJoin(
      meetingCode,
      me.id,
      readPasscode(body),
    );

    if (!decision.allowed) {
      switch (decision.reason) {
        case "not_found":
          return errorResponse("Meeting not found", 404);

        // 401 rather than 403: the request is not permanently refused, it is
        // missing a credential the client can go and collect. The lobby keys its
        // passcode prompt off this `code`.
        case "passcode_required":
          return NextResponse.json(
            {
              error: "This room requires a passcode.",
              code: "passcode_required",
            },
            { status: 401 },
          );

        case "passcode_invalid":
          return NextResponse.json(
            {
              error: "That passcode is not correct.",
              code: "passcode_invalid",
            },
            { status: 401 },
          );

        case "passcode_throttled": {
          const retryAfter = decision.retryAfterSeconds ?? 60;

          return NextResponse.json(
            {
              error: `Too many incorrect passcodes. Try again in ${describeRetryAfter(
                retryAfter,
              )}.`,
              code: "passcode_throttled",
            },
            {
              status: 429,
              headers: { "Retry-After": String(retryAfter) },
            },
          );
        }

        default:
          // Deliberately explicit rather than a 404: the caller is signed in and
          // the meeting exists, they simply were not invited to it.
          return errorResponse(
            "You are not a participant in this meeting. Ask the host to invite you.",
            403,
          );
      }
    }

    // An open meeting joined by link enrolls the attendee, which is what makes
    // it appear in their dashboard history afterwards.
    if (!decision.enrolled) {
      await recordAttendance(decision.meeting.id, me.id);
    }

    // The display name comes from the verified profile, never from the request
    // body. Trusting the client here allowed trivial impersonation.
    const displayName = me.name ?? me.username;

    const accessToken = new AccessToken(apiKey, apiSecret, {
      identity: me.clerkId,
      name: displayName,
      ttl: TOKEN_TTL,
    });

    accessToken.addGrant({
      room: decision.meeting.meetingCode,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await accessToken.toJwt();

    return NextResponse.json(
      { token, identity: me.clerkId, name: displayName },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Failed to generate a LiveKit access token", error);
    return errorResponse("Unable to generate access token", 500);
  }
}

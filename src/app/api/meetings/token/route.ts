import { AccessToken } from "livekit-server-sdk";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  authorizeMeetingJoin,
  recordAttendance,
} from "@/lib/meetings/authorization";
import {
  guestApprovalState,
  isGuestBanned,
} from "@/lib/meetings/guest-admission";
import {
  GUEST_COOKIE_NAME,
  guestIdentity,
  readGuestSessionFor,
} from "@/lib/meetings/guest-session";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";
import { ensureCurrentUser } from "@/lib/users/current-user";

export const runtime = "nodejs";

const MAX_MEETING_CODE_LENGTH = 128;

/**
 * Token lifetime.
 *
 * LiveKit validates the token on the initial join and again on reconnect, and
 * there is no API to hand a live room a replacement — so this value is exactly the
 * window in which a *removed or banned* participant can rejoin.
 *
 * That is not theoretical. The token is returned in this route's JSON response,
 * so it can be lifted straight out of devtools, and `room.connect()` against
 * LiveKit never touches this app: `isGuestBanned`, `authorizeMeetingJoin`, the
 * DENIED knock and `isLocked` are all skipped. At twelve hours — the previous
 * value — removal, bans and room lock were effectively advisory for the rest of
 * the working day.
 *
 * Thirty minutes because the cost of expiry is already handled. LiveKit retries a
 * dropped connection internally, and when it gives up `CallProvider`'s
 * `onDisconnected` shows a "Rejoin call" notice whose button re-mints here —
 * re-running every ban, lock and approval check. So the worst an expiry causes is
 * one click, and only after a blip long enough to exhaust LiveKit's own retries.
 *
 * This bounds the hole rather than closing it. Closing it needs LiveKit to consult
 * the ban list at connect time, which means a `participant_joined` webhook that
 * evicts a banned identity. Worth doing if removal needs to be immediate.
 */
const TOKEN_TTL = "30m";

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

/**
 * Mints a token for a guest holding a verified session.
 *
 * The session cookie is the credential: it was issued by `/api/meetings/guest`
 * only after the passcode was checked, and it names exactly one meeting. Nothing
 * from the request body is trusted here — not the room, not the display name.
 *
 * The ban is re-checked at mint time rather than only at exchange time, because a
 * guest removed mid-call still holds a valid-looking cookie and would otherwise
 * reconnect straight away.
 */
async function issueGuestAccessToken(
  meetingCode: string,
  apiKey: string,
  apiSecret: string,
  request: Request,
): Promise<NextResponse> {
  const store = await cookies();
  const session = readGuestSessionFor(
    store.get(GUEST_COOKIE_NAME)?.value,
    meetingCode,
  );

  if (session === null) {
    return NextResponse.json(
      {
        error: "Enter the room passcode to join as a guest.",
        code: "guest_session_required",
      },
      { status: 401 },
    );
  }

  // Keyed on the guest id, so one guest cannot exhaust another's budget.
  const limit = consumeRateLimit("meetingToken", `guest:${session.guestId}`);

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

  if (await isGuestBanned(meetingCode, session.guestId)) {
    return NextResponse.json(
      {
        error: "The host removed you from this meeting.",
        code: "removed",
      },
      { status: 403 },
    );
  }

  // Re-checked because a lock applied after the passcode exchange must still keep
  // new arrivals out.
  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: { isLocked: true },
  });

  if (meeting === null) {
    return errorResponse("Meeting not found", 404);
  }

  if (meeting.isLocked) {
    return NextResponse.json(
      { error: "The host has locked this meeting.", code: "locked" },
      { status: 403 },
    );
  }

  // Re-checked at mint time, not only at the passcode exchange, so turning the
  // waiting room on or revoking approval takes effect on the next reconnect.
  const approval = await guestApprovalState(meetingCode, session.guestId);

  if (approval === "denied") {
    return NextResponse.json(
      { error: "The host did not admit you.", code: "removed" },
      { status: 403 },
    );
  }

  if (approval === "waiting") {
    return NextResponse.json(
      {
        error: "Waiting for the host to admit you.",
        code: "waiting_for_host",
      },
      { status: 403 },
    );
  }

  const identity = guestIdentity(session.guestId);
  // Suffixed so nobody can pass themselves off as an account holder by choosing a
  // display name. Other participants can always tell a guest apart.
  const displayName = `${session.displayName} (guest)`;

  const accessToken = new AccessToken(apiKey, apiSecret, {
    identity,
    name: displayName,
    ttl: TOKEN_TTL,
  });

  accessToken.addGrant({
    room: meetingCode,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });

  void request;

  return NextResponse.json(
    { token: await accessToken.toJwt(), identity, name: displayName },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
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

  // Resolves the local row as well as the session: admission is decided against
  // `User.id`, which is what Meeting.hostId and Participant.userId reference.
  const me = await ensureCurrentUser();

  // No account. The guest path is a separate, narrower check — every tier of
  // `authorizeMeetingJoin` is keyed to a user id a guest does not have.
  if (me === null) {
    try {
      return await issueGuestAccessToken(
        meetingCode,
        apiKey,
        apiSecret,
        request,
      );
    } catch (error) {
      console.error("Failed to generate a guest access token", error);
      return errorResponse("Unable to generate access token", 500);
    }
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

    // Everyone who actually joins gets an attendance row, including the host.
    //
    // `decision.enrolled` is true for the host because ownership alone admits
    // them, so the previous `if (!decision.enrolled)` guard skipped them — leaving
    // the creator of a meeting with no `Participant` row at all. That is what made
    // host succession think the host was absent and hand the role to the first
    // person who joined. `recordAttendance` upserts, so this is idempotent.
    await recordAttendance(decision.meeting.id, me.id);

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

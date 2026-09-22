import { WebhookReceiver } from "livekit-server-sdk";
import { NextResponse } from "next/server";

import { joinBarFor } from "@/lib/meetings/join-enforcement";
import { removeOccupant } from "@/lib/meetings/livekit-admin";

export const runtime = "nodejs";

/**
 * LiveKit webhook receiver.
 *
 * Only reason this exists: a LiveKit token is checked at connect time and never
 * again, so a participant who saved theirs can replay it with `room.connect()` and
 * walk straight back into a room they were removed, banned or locked out of. That
 * request never touches this app, so no check in `authorizeMeetingJoin` or
 * `admitGuest` can see it. Asking LiveKit to report joins is the only way to
 * enforce a removal at the media server rather than merely record it.
 *
 * The signature is the authentication. There is no session here — LiveKit is the
 * caller — so `receive()` verifying the `Authorization` header against the API
 * secret is what makes this route safe to expose. `skipAuth` is never passed.
 *
 * Configure in LiveKit (project settings → webhooks) pointing at
 * `https://<your-origin>/api/livekit/webhook`. Until then this route is simply
 * never called and the token TTL is the only bound on replay.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error("livekit_webhook_not_configured");
    // 500, not 200: a misconfigured receiver silently discarding events would
    // leave removal unenforced with nothing to show it.
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  // The raw body, not a parsed one: the signature covers the exact bytes.
  const body = await request.text();
  const authHeader = request.headers.get("Authorization") ?? undefined;

  let event;

  try {
    event = await new WebhookReceiver(apiKey, apiSecret).receive(
      body,
      authHeader,
    );
  } catch {
    // Unsigned, missigned or replayed past the clock tolerance. Nothing here is
    // trustworthy, so it is refused rather than inspected.
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (event.event !== "participant_joined") {
    // Every other event is acknowledged and ignored. A non-2xx would make LiveKit
    // retry events this app has no use for.
    return NextResponse.json({ ok: true });
  }

  const meetingCode = event.room?.name;
  const identity = event.participant?.identity;

  if (
    typeof meetingCode !== "string" ||
    meetingCode.length === 0 ||
    typeof identity !== "string" ||
    identity.length === 0
  ) {
    return NextResponse.json({ ok: true });
  }

  const bar = await joinBarFor(meetingCode, identity);

  if (bar === null) {
    return NextResponse.json({ ok: true });
  }

  const outcome = await removeOccupant(meetingCode, identity);

  // Logged either way: this firing at all means someone reconnected with a token
  // that should no longer work, which is worth being able to see.
  console.warn("livekit_webhook_evicted", {
    meetingCode,
    identity,
    reason: bar,
    disconnected: outcome.ok,
  });

  return NextResponse.json({ ok: true });
}

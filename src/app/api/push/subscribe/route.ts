import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { getCurrentLocalUserId } from "@/lib/users/current-user";

export const runtime = "nodejs";

/** Bounds on the values a browser supplies, so nothing unbounded is stored. */
const MAX_ENDPOINT_CHARS = 1024;
const MAX_KEY_CHARS = 256;
const MAX_USER_AGENT_CHARS = 256;

interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function readSubscription(value: unknown): SubscriptionInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const body = value as Record<string, unknown>;
  const endpoint = body.endpoint;
  const keys = body.keys;

  if (
    typeof endpoint !== "string" ||
    endpoint.length === 0 ||
    endpoint.length > MAX_ENDPOINT_CHARS
  ) {
    return null;
  }

  // Only the well-known push services are accepted. Without this the endpoint is
  // an arbitrary URL the server will later POST to, which is an SSRF vector.
  let parsed: URL;

  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  if (typeof keys !== "object" || keys === null) {
    return null;
  }

  const keyRecord = keys as Record<string, unknown>;
  const p256dh = keyRecord.p256dh;
  const auth = keyRecord.auth;

  if (
    typeof p256dh !== "string" ||
    typeof auth !== "string" ||
    p256dh.length === 0 ||
    auth.length === 0 ||
    p256dh.length > MAX_KEY_CHARS ||
    auth.length > MAX_KEY_CHARS
  ) {
    return null;
  }

  return { endpoint, p256dh, auth };
}

/**
 * Registers this browser to receive push notifications.
 *
 * Keyed on the endpoint, which the browser generates, so re-subscribing the same
 * browser updates the row rather than creating a duplicate. The row is bound to
 * the signed-in user here — the client never says who it is for.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getCurrentLocalUserId();

  if (userId === null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const subscription = readSubscription(body);

  if (subscription === null) {
    return NextResponse.json(
      { error: "Invalid subscription" },
      { status: 400 },
    );
  }

  const userAgent = (request.headers.get("user-agent") ?? "").slice(
    0,
    MAX_USER_AGENT_CHARS,
  );

  try {
    await prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: {
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        userAgent: userAgent.length > 0 ? userAgent : null,
      },
      // Reassigns ownership: a shared browser where a second person signs in must
      // not keep notifying the first.
      update: {
        userId,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        userAgent: userAgent.length > 0 ? userAgent : null,
      },
      select: { id: true },
    });
  } catch {
    return NextResponse.json({ error: "Could not save" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/** Unsubscribes this browser. Scoped to the caller so one user cannot remove another's. */
export async function DELETE(request: Request): Promise<NextResponse> {
  const userId = await getCurrentLocalUserId();

  if (userId === null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const endpoint =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { endpoint?: unknown }).endpoint === "string"
      ? (body as { endpoint: string }).endpoint
      : null;

  if (endpoint === null) {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }

  await prisma.pushSubscription
    .deleteMany({ where: { endpoint, userId } })
    .catch(() => undefined);

  return NextResponse.json({ ok: true });
}

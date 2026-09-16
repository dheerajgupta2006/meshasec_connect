import "server-only";

/**
 * Sending browser push notifications.
 *
 * This is what makes a call reachable when the recipient's tab is backgrounded or
 * closed. Polling cannot do that: a closed tab runs no JavaScript, and a
 * background tab has its timers throttled to roughly once a minute.
 *
 * Push is also server-initiated, so it arrives in about a second rather than
 * waiting for the next poll — and the notification's sound is played by the
 * operating system, which is not subject to the browser autoplay rules that can
 * silence an in-page ringtone.
 */

import webpush from "web-push";

import { prisma } from "@/lib/prisma";

/** How long the push service should hold a call notification. */
const CALL_TTL_SECONDS = 60;

let configured: boolean | null = null;

/**
 * Configures the VAPID identity once per process.
 *
 * Cached because `setVapidDetails` validates the keys, and re-running it on every
 * send is wasted work.
 */
function ensureConfigured(): boolean {
  if (configured !== null) {
    return configured;
  }

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@example.com";

  if (
    publicKey === undefined ||
    privateKey === undefined ||
    publicKey.length === 0 ||
    privateKey.length === 0
  ) {
    configured = false;
    return false;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  } catch {
    configured = false;
  }

  return configured;
}

/** True when push can be sent at all, used to avoid pointless database reads. */
export function pushConfigured(): boolean {
  return ensureConfigured();
}

export interface CallPushPayload {
  kind: "call";
  meetingCode: string;
  callerName: string;
  /** True for a mid-call group invite rather than a fresh 1-on-1. */
  isGroupInvite: boolean;
}

export interface MessagePushPayload {
  kind: "message";
  fromName: string;
  fromUsername: string;
  preview: string;
}

export type PushPayload = CallPushPayload | MessagePushPayload;

/**
 * A push service reporting the subscription is dead.
 *
 * 404 and 410 mean the browser has discarded it — the user cleared site data,
 * uninstalled, or the endpoint expired. Anything else is transient and the row
 * must be kept.
 */
function isGone(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

/**
 * Sends a notification to every device belonging to `userId`.
 *
 * Never throws and never blocks the caller's own work: a failed notification must
 * not fail placing a call. Errors are swallowed per-subscription so one dead
 * device cannot stop the others.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  if (!ensureConfigured()) {
    return;
  }

  let subscriptions: {
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }[];

  try {
    subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
      // A person with many stale devices should not fan out without bound.
      take: 10,
    });
  } catch {
    return;
  }

  if (subscriptions.length === 0) {
    return;
  }

  const body = JSON.stringify(payload);
  const deadIds: string[] = [];

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          body,
          {
            TTL: CALL_TTL_SECONDS,
            // `high` asks the push service to wake the device promptly rather
            // than batching, which is the point for a ringing call.
            urgency: "high",
          },
        );
      } catch (error: unknown) {
        const statusCode =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : undefined;

        if (isGone(statusCode)) {
          deadIds.push(subscription.id);
        }
      }
    }),
  );

  if (deadIds.length > 0) {
    // Pruned so the list does not grow forever with endpoints that can never
    // succeed again.
    await prisma.pushSubscription
      .deleteMany({ where: { id: { in: deadIds } } })
      .catch(() => undefined);
  }

  const liveIds = subscriptions
    .filter((subscription) => !deadIds.includes(subscription.id))
    .map((subscription) => subscription.id);

  if (liveIds.length > 0) {
    await prisma.pushSubscription
      .updateMany({
        where: { id: { in: liveIds } },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
  }
}

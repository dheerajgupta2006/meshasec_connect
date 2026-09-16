import "server-only";

/**
 * Tells the host that a guest is waiting.
 *
 * The host's own admit queue polls, so this exists for the case polling cannot
 * cover: the host is on another tab, or another page, and would otherwise leave
 * someone standing at the door indefinitely.
 */

import { actingHostId } from "@/lib/meetings/host-succession";
import { prisma } from "@/lib/prisma";
import { pushConfigured, sendPushToUser } from "@/lib/push/send";

/**
 * Minimum gap between notifications for the same guest.
 *
 * The guest's lobby polls its own status, and each tick reports "waiting", so
 * without this the host would be notified every few seconds for one person.
 * In-memory and therefore per-instance, which is acceptable for a notification.
 */
const NOTIFY_INTERVAL_MS = 60_000;

const lastNotified = new Map<string, number>();

/**
 * Notifies the acting host, once per guest per interval.
 *
 * Never throws: failing to notify must not stop the guest from waiting properly,
 * and the host's queue will show them on its next poll regardless.
 */
export async function notifyHostOfGuestKnock(
  meetingCode: string,
  guestId: string,
  displayName: string,
): Promise<void> {
  const key = `${meetingCode}:${guestId}`;
  const now = Date.now();

  if (now - (lastNotified.get(key) ?? 0) < NOTIFY_INTERVAL_MS) {
    return;
  }

  lastNotified.set(key, now);

  if (!pushConfigured()) {
    return;
  }

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { meetingCode },
      select: { hostId: true, currentHostId: true },
    });

    if (meeting === null) {
      return;
    }

    await sendPushToUser(actingHostId(meeting), {
      kind: "call",
      meetingCode,
      callerName: `${displayName} is waiting to join`,
      // Reuses the call payload so the existing service worker handles it with no
      // new message type; tapping it opens the room where the admit queue lives.
      isGroupInvite: true,
    });
  } catch {
    // Best effort by design.
  }
}

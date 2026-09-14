/**
 * Server wrapper that feeds the notification bell.
 *
 * Rendered from the root layout, so it must stay cheap and silent for signed-out
 * visitors: `ensureCurrentUser` returns null without touching the database when
 * there is no session.
 */

import {
  NotificationBell,
  type BellRequest,
} from "@/components/connections/notification-bell";
import { listPendingRequests } from "@/lib/connections/queries";
import { ensureCurrentUser } from "@/lib/users/current-user";

export async function NotificationsMenu() {
  const me = await ensureCurrentUser();

  if (me === null) {
    return null;
  }

  const pending = await listPendingRequests(me.id);

  const requests: BellRequest[] = pending.map((request) => ({
    requestId: request.requestId,
    senderUsername: request.sender.username,
    senderName: request.sender.name,
  }));

  return <NotificationBell requests={requests} />;
}

/**
 * Header link to Groups carrying an unread badge.
 *
 * Server component so the count is read per request; renders nothing for signed
 * out visitors. Modelled on `MessagesNavLink`, and the two badges are deliberately
 * separate counts — a group message and a direct message are different things to
 * go and read.
 */

import { Users } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { countUnreadGroupMessages } from "@/lib/groups/queries";
import { ensureCurrentUser } from "@/lib/users/current-user";

export async function GroupsNavLink() {
  const me = await ensureCurrentUser();

  if (me === null) {
    return null;
  }

  const unread = await countUnreadGroupMessages(me.id);

  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      // Hidden below `sm`, where `MobileMenu` carries a Groups row instead. The
      // phone header already runs out of width at the wordmark — the same reason
      // the Dashboard button and both toggles are desktop-only — and this would
      // have been the fifth control in that cluster.
      className="relative hidden sm:inline-flex"
      aria-label={unread > 0 ? `Groups, ${unread} unread` : "Groups"}
    >
      <Link href="/dashboard/groups">
        <Users className="h-5 w-5" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Link>
    </Button>
  );
}

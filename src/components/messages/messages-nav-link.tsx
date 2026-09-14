/**
 * Header link to Messages carrying an unread badge.
 *
 * Server component so the count is read per request; renders nothing for signed
 * out visitors.
 */

import { MessageSquare } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { countUnreadMessages } from "@/lib/messages/queries";
import { ensureCurrentUser } from "@/lib/users/current-user";

export async function MessagesNavLink() {
  const me = await ensureCurrentUser();

  if (me === null) {
    return null;
  }

  const unread = await countUnreadMessages(me.id);

  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className="relative"
      aria-label={
        unread > 0
          ? `Messages, ${unread} unread`
          : "Messages"
      }
    >
      <Link href="/messages">
        <MessageSquare className="h-5 w-5" />
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

import { MessageSquare, UserRound, Users } from "lucide-react";
import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { listContacts } from "@/lib/connections/queries";
import { listConversations } from "@/lib/messages/queries";
import { ensureCurrentUser } from "@/lib/users/current-user";

export const metadata: Metadata = {
  title: "Messages",
};

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export default async function MessagesPage() {
  noStore();

  const me = await ensureCurrentUser();

  if (me === null) {
    redirect("/sign-in");
  }

  const contacts = await listContacts(me.id);
  const conversations = await listConversations(
    me.id,
    contacts.map((contact) => ({
      id: contact.id,
      username: contact.username,
      name: contact.name,
    })),
  );

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-gradient-to-b from-primary/[0.06] via-background to-background">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Messages
            </h1>
            <p className="mt-2 text-muted-foreground">
              Chat with people you are connected to.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href="/dashboard">Dashboard</Link>
          </Button>
        </header>

        {conversations.length === 0 ? (
          <Card className="border-dashed bg-card/60">
            <CardContent className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
              <span className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <Users className="h-5 w-5" />
              </span>
              <h2 className="font-semibold">No conversations yet</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                You can only message people you are connected with. Send a
                connection request from the dashboard to get started.
              </p>
              <Button asChild className="mt-6">
                <Link href="/dashboard">Find someone to connect with</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ul className="space-y-3">
            {conversations.map((conversation) => (
              <li key={conversation.person.id}>
                <Link
                  href={`/messages/${encodeURIComponent(conversation.person.username)}`}
                  className="block rounded-xl border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                >
                  <div className="flex items-center gap-4">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                      <UserRound className="h-5 w-5" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate font-medium">
                          {conversation.person.name ??
                            `@${conversation.person.username}`}
                        </p>
                        {conversation.lastMessageAt !== null && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {dayFormatter.format(conversation.lastMessageAt)}
                          </span>
                        )}
                      </div>

                      <p className="truncate text-sm text-muted-foreground">
                        {conversation.lastMessage ?? "No messages yet"}
                      </p>
                    </div>

                    {conversation.unreadCount > 0 && (
                      <Badge className="shrink-0">
                        {conversation.unreadCount}
                      </Badge>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-8 flex items-start gap-2 text-xs text-muted-foreground">
          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Messages are only available between accepted connections. Removing a
          connection immediately closes the thread.
        </p>
      </div>
    </main>
  );
}

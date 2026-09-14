import { ArrowLeft, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  MessageThread,
  type ThreadMessageView,
} from "@/components/messages/message-thread";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { areUsersConnected } from "@/lib/connections/queries";
import { listThread } from "@/lib/messages/queries";
import { prisma } from "@/lib/prisma";
import { ensureCurrentUser, normalizeUsername } from "@/lib/users/current-user";

interface ThreadPageProps {
  params: { username: string };
}

export const metadata: Metadata = {
  title: "Conversation",
};

export default async function ThreadPage({ params }: ThreadPageProps) {
  noStore();

  const me = await ensureCurrentUser();

  if (me === null) {
    redirect("/sign-in");
  }

  const username = normalizeUsername(decodeURIComponent(params.username));

  const contact = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, name: true },
  });

  if (contact === null || contact.username === null) {
    notFound();
  }

  if (contact.id === me.id) {
    redirect("/messages");
  }

  // The security gate. Rendered as a blocked state rather than a 404 so the
  // person knows what to do next.
  const connected = await areUsersConnected(me.id, contact.id);

  if (!connected) {
    return (
      <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-2xl items-center px-4 py-10 sm:px-6">
        <Card className="w-full">
          <CardContent className="px-6 py-10 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-destructive/10 text-destructive-text">
              <ShieldAlert className="h-5 w-5" />
            </span>
            <h1 className="mt-5 text-xl font-semibold">Not connected yet</h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              You must connect with @{contact.username} and have your request
              accepted before calling or chatting.
            </p>
            <Button asChild className="mt-6">
              <Link href="/dashboard">
                <ArrowLeft className="h-4 w-4" />
                Back to dashboard
              </Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const thread = await listThread(me.id, contact.id);

  const initialMessages: ThreadMessageView[] = thread.map((message) => ({
    id: message.id,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    outgoing: message.outgoing,
  }));

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-gradient-to-b from-primary/[0.06] via-background to-background">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="mb-4 -ml-2 text-muted-foreground"
        >
          <Link href="/messages">
            <ArrowLeft className="h-4 w-4" />
            All messages
          </Link>
        </Button>

        <MessageThread
          contactId={contact.id}
          contactUsername={contact.username}
          contactName={contact.name}
          initialMessages={initialMessages}
        />
      </div>
    </main>
  );
}

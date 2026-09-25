import { MessagesSquare, Users } from "lucide-react";
import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CreateGroupDialog } from "@/components/groups/create-group-dialog";
import { LocalDateTime } from "@/components/local-date-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { listMyGroups } from "@/lib/groups/queries";
import { ensureCurrentUser } from "@/lib/users/current-user";

export const metadata: Metadata = {
  title: "Groups",
};

// Dates are formatted by `LocalDateTime` on the client. Doing it here would use
// the server's time zone, which is UTC on Vercel.

export default async function GroupsPage() {
  noStore();

  const me = await ensureCurrentUser();

  if (me === null) {
    redirect("/sign-in");
  }

  const groups = await listMyGroups(me.id);

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-gradient-to-b from-primary/[0.06] via-background to-background">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Groups
            </h1>
            <p className="mt-2 text-muted-foreground">
              Chat and call with several people at once.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
            <CreateGroupDialog />
          </div>
        </header>

        {groups.length === 0 ? (
          <Card className="border-dashed bg-card/60">
            <CardContent className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
              <span className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <Users className="h-5 w-5" />
              </span>
              <h2 className="font-semibold">No groups yet</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                A group is a named set of people you can message and call
                together. You can add anyone you are connected with.
              </p>
              <div className="mt-6">
                <CreateGroupDialog />
              </div>
            </CardContent>
          </Card>
        ) : (
          <ul className="space-y-3">
            {groups.map((group) => (
              <li key={group.id}>
                <Link
                  href={`/groups/${encodeURIComponent(group.id)}`}
                  className="block rounded-xl border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                >
                  <div className="flex items-center gap-4">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                      <Users className="h-5 w-5" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate font-medium">{group.name}</p>
                        {group.lastMessageAt !== null && (
                          <LocalDateTime
                            iso={group.lastMessageAt.toISOString()}
                            mode="dayMonth"
                            fallback=""
                            className="shrink-0 text-xs text-muted-foreground"
                          />
                        )}
                      </div>

                      <p className="truncate text-sm text-muted-foreground">
                        {group.lastMessage === null
                          ? `${String(group.memberCount)} members · no messages yet`
                          : `${group.lastMessageBy ?? "Someone"}: ${group.lastMessage}`}
                      </p>
                    </div>

                    {group.unreadCount > 0 && (
                      <Badge className="shrink-0">{group.unreadCount}</Badge>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-8 flex items-start gap-2 text-xs text-muted-foreground">
          <MessagesSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          You can add people you are connected with. Once someone is in a group
          they stay reachable there, even if a connection is later removed.
        </p>
      </div>
    </main>
  );
}

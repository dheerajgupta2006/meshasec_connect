import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { GroupThread } from "@/components/groups/group-thread";
import { Button } from "@/components/ui/button";
import { getGroupDetail, listGroupThread } from "@/lib/groups/queries";
import { isValidId } from "@/lib/groups/validation";
import { ensureCurrentUser } from "@/lib/users/current-user";

export const metadata: Metadata = {
  title: "Group",
};

interface GroupPageProps {
  params: { groupId: string };
}

export default async function GroupPage({ params }: GroupPageProps) {
  noStore();

  const me = await ensureCurrentUser();

  if (me === null) {
    redirect("/sign-in");
  }

  const groupId = decodeURIComponent(params.groupId);

  if (!isValidId(groupId)) {
    notFound();
  }

  // `getGroupDetail` returns null both for a group that does not exist and for one
  // the viewer is not in, so a 404 is the correct and only answer — anything more
  // specific would turn this route into an existence oracle.
  const group = await getGroupDetail(groupId, me.id);

  if (group === null) {
    notFound();
  }

  const messages = await listGroupThread(group.id, me.id);

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-gradient-to-b from-primary/[0.06] via-background to-background">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
          <Link href="/dashboard/groups">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            All groups
          </Link>
        </Button>

        <GroupThread
          groupId={group.id}
          groupName={group.name}
          description={group.description}
          myRole={group.myRole}
          myUserId={me.id}
          members={group.members.map((member) => ({
            id: member.id,
            username: member.username,
            name: member.name,
            role: member.role,
          }))}
          initialMessages={messages.map((message) => ({
            id: message.id,
            body: message.body,
            createdAt: message.createdAt.toISOString(),
            outgoing: message.outgoing,
            author: message.author,
            editedAt: message.editedAt?.toISOString() ?? null,
            deleted: message.deleted,
            replyTo: message.replyTo,
          }))}
        />
      </div>
    </main>
  );
}

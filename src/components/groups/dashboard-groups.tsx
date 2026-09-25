import { ArrowRight, MessagesSquare, Users } from "lucide-react";
import Link from "next/link";

import { CreateGroupDialog } from "@/components/groups/create-group-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { GroupSummary } from "@/lib/groups/queries";

/** How many groups the dashboard shows before deferring to the full list. */
const PREVIEW_LIMIT = 4;

interface DashboardGroupsProps {
  groups: GroupSummary[];
}

/**
 * Groups section for the dashboard.
 *
 * A preview rather than the whole list: the dashboard already carries meetings,
 * connections and stats, and an unbounded section would push everything below it
 * off the first screen. The busiest few are shown and the rest are one click away.
 *
 * Deliberately always rendered, unlike the "Ongoing" meetings section which hides
 * when empty — someone with no groups is exactly the person who needs to be told
 * the feature exists.
 */
export function DashboardGroups({ groups }: DashboardGroupsProps) {
  const preview = groups.slice(0, PREVIEW_LIMIT);
  const hidden = groups.length - preview.length;

  return (
    <section className="space-y-4" aria-labelledby="groups-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2
            id="groups-heading"
            className="text-lg font-semibold tracking-tight text-white"
          >
            Groups
          </h2>
          <p className="text-sm text-zinc-400">
            Message and call several people at once.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {groups.length > 0 && (
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/groups">
                All groups
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          )}
          <CreateGroupDialog size="sm" />
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.03] px-6 py-8 text-center">
          <span
            aria-hidden="true"
            className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-white/[0.06] text-zinc-400"
          >
            <Users className="h-5 w-5" />
          </span>
          <p className="text-sm font-medium text-zinc-200">No groups yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-400">
            Put the people you are connected with into a named group, then chat
            or start a call with all of them at once.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {preview.map((group) => (
            <li key={group.id}>
              <Link
                href={`/dashboard/groups/${encodeURIComponent(group.id)}`}
                className="flex h-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition-colors hover:border-white/25 hover:bg-white/[0.06]"
              >
                <span
                  aria-hidden="true"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-indigo-500/15 text-indigo-300"
                >
                  <Users className="h-5 w-5" />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-100">
                    {group.name}
                  </span>
                  <span className="flex items-center gap-1 truncate text-xs text-zinc-400">
                    <MessagesSquare
                      className="h-3 w-3 shrink-0"
                      aria-hidden="true"
                    />
                    {group.lastMessage === null
                      ? `${String(group.memberCount)} members`
                      : group.lastMessage}
                  </span>
                </span>

                {group.unreadCount > 0 && (
                  <Badge className="shrink-0">{group.unreadCount}</Badge>
                )}
              </Link>
            </li>
          ))}

          {hidden > 0 && (
            <li className="sm:col-span-2">
              <Link
                href="/dashboard/groups"
                className="block rounded-xl border border-dashed border-white/15 px-3 py-2 text-center text-xs text-zinc-400 transition-colors hover:border-white/30 hover:text-zinc-200"
              >
                {`${String(hidden)} more group${hidden === 1 ? "" : "s"}`}
              </Link>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

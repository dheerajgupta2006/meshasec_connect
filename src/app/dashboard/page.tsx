import { auth } from "@clerk/nextjs/server";
import {
  ArrowUpRight,
  CalendarDays,
  Clock3,
  History,
  Plus,
  Sparkles,
  Users,
  Video,
} from "lucide-react";
import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  partitionMeetings,
  resolveMeetingStatus,
} from "@/lib/meetings/lifecycle";
import { AddToCalendar } from "@/components/calendar/add-to-calendar";
import { ConnectDialog } from "@/components/connections/connect-dialog";
import {
  ContactsList,
  type ContactSummary,
} from "@/components/connections/contacts-list";
import { QuickActions } from "@/components/dashboard/quick-actions";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Button } from "@/components/ui/button";
import {
  listContacts,
  listSentPendingRequests,
} from "@/lib/connections/queries";
import { prisma } from "@/lib/prisma";
import { ensureCurrentUser } from "@/lib/users/current-user";

interface DashboardMeeting {
  id: string;
  title: string;
  meetingCode: string;
  createdAt: Date;
  startsAt: Date | null;
  endsAt: Date | null;
  host: {
    clerkId: string | null;
    name: string | null;
  };
  _count: {
    participants: number;
  };
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeStyle: "short",
});

// Sorting now lives in `lib/meetings/lifecycle.ts` alongside the status rule, so
// the two cannot drift apart.

function firstNameOf(name: string | null): string | null {
  const trimmed = (name ?? "").trim();

  if (trimmed.length === 0) {
    return null;
  }

  const [first] = trimmed.split(/\s+/);
  return first ?? null;
}

function MeetingCard({
  meeting,
  clerkUserId,
  isPast,
}: {
  meeting: DashboardMeeting;
  clerkUserId: string;
  isPast: boolean;
}) {
  const scheduledFor = meeting.startsAt ?? meeting.createdAt;
  const isHost = meeting.host.clerkId === clerkUserId;
  // Derived from the shared lifecycle rule so an instant meeting counts as live
  // too. The previous test required a non-null `startsAt`, which instant meetings
  // never have, so they never showed "Ready now".
  const isInProgress = resolveMeetingStatus(meeting, Date.now()) === "live";

  // "Rejoin" is only truthful for a room that has already been live; a meeting
  // whose start time is still ahead has never been open.
  const actionLabel = isPast || isInProgress ? "Rejoin" : "Join";
  const lobbyHref = `/meeting/${encodeURIComponent(meeting.meetingCode)}/lobby`;

  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/60 backdrop-blur transition-colors hover:border-white/20">
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent ${
          isPast ? "via-zinc-500/50" : "via-indigo-400/70"
        }`}
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent ${
          isPast ? "from-zinc-500/[0.07]" : "from-indigo-500/[0.12]"
        }`}
      />

      <div className="relative flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
              isPast
                ? "border-white/10 bg-white/[0.06] text-zinc-300"
                : isInProgress
                  ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                  : "border-indigo-400/30 bg-indigo-400/10 text-indigo-200"
            }`}
          >
            {isPast ? (
              <History className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Video className="h-3 w-3" aria-hidden="true" />
            )}
            {isPast ? "Ended" : isInProgress ? "Ready now" : "Upcoming"}
          </span>
          <span className="min-w-0 truncate font-mono text-xs text-zinc-500">
            {meeting.meetingCode}
          </span>
        </div>

        <div className="min-w-0 space-y-1">
          <h3 className="line-clamp-2 break-words text-base font-semibold text-white sm:text-lg">
            {meeting.title}
          </h3>
          <p className="truncate text-xs text-zinc-400">
            {isHost
              ? "You are the host"
              : `Hosted by ${meeting.host.name ?? "another member"}`}
          </p>
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex items-center gap-2.5">
            <CalendarDays
              className="h-4 w-4 shrink-0 text-indigo-300"
              aria-hidden="true"
            />
            <dt className="sr-only">Date</dt>
            <dd className="min-w-0 truncate text-zinc-200">
              {dateFormatter.format(scheduledFor)}
              <span className="text-zinc-500"> · </span>
              {timeFormatter.format(scheduledFor)}
            </dd>
          </div>
          <div className="flex items-center gap-2.5">
            <Clock3
              className="h-4 w-4 shrink-0 text-zinc-500"
              aria-hidden="true"
            />
            <dt className="sr-only">Duration</dt>
            <dd className="min-w-0 truncate text-xs text-zinc-400">
              {meeting.endsAt
                ? `Ends ${timeFormatter.format(meeting.endsAt)}`
                : meeting.startsAt
                  ? "No end time set"
                  : "Instant meeting"}
            </dd>
          </div>
          <div className="flex items-center gap-2.5">
            <Users
              className="h-4 w-4 shrink-0 text-zinc-500"
              aria-hidden="true"
            />
            <dt className="sr-only">Participants</dt>
            <dd className="text-xs text-zinc-400">
              {meeting._count.participants}{" "}
              {meeting._count.participants === 1
                ? "participant"
                : "participants"}
            </dd>
          </div>
        </dl>

        <div className="mt-auto space-y-2 pt-2">
          <Button
            asChild
            size="sm"
            className={`h-11 w-full sm:h-9 ${
              isPast
                ? "bg-white/10 text-zinc-100 hover:bg-white/20"
                : "bg-gradient-to-r from-indigo-500 to-violet-500 text-white hover:from-indigo-400 hover:to-violet-400"
            }`}
          >
            <Link
              href={lobbyHref}
              aria-label={`${actionLabel} ${meeting.title}`}
            >
              {actionLabel}
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>

          {/* Only offered for meetings still ahead: adding a finished meeting to
              a calendar has no purpose. */}
          {!isPast && (
            <AddToCalendar
              meetingCode={meeting.meetingCode}
              title={meeting.title}
              startsAt={scheduledFor.toISOString()}
              endsAt={meeting.endsAt?.toISOString() ?? null}
              tone="dark"
              className="h-9 w-full border-white/15 bg-white/[0.06] text-zinc-200 hover:bg-white/[0.12] hover:text-white"
            />
          )}
        </div>
      </div>
    </article>
  );
}

function EmptyMeetings({ type }: { type: "upcoming" | "past" }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-12 text-center">
      <span
        aria-hidden="true"
        className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-zinc-400"
      >
        {type === "upcoming" ? (
          <CalendarDays className="h-5 w-5" />
        ) : (
          <History className="h-5 w-5" />
        )}
      </span>
      <h3 className="font-semibold text-zinc-100">
        No {type === "upcoming" ? "upcoming" : "past"} meetings
      </h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-400">
        {type === "upcoming"
          ? "Create a meeting or join one with a meeting code to see it here."
          : "Meetings you have completed will appear here."}
      </p>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3 backdrop-blur">
      <dt className="truncate text-xs text-zinc-400">{label}</dt>
      <dd className={`mt-0.5 text-xl font-semibold sm:text-2xl ${tone}`}>
        {value}
      </dd>
    </div>
  );
}

export default async function DashboardPage() {
  noStore();

  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  // Resolves (and provisions) the local row that connections are keyed on.
  const me = await ensureCurrentUser();

  const [contacts, outgoing] = me === null
    ? [[], []]
    : await Promise.all([listContacts(me.id), listSentPendingRequests(me.id)]);

  const contactSummaries: ContactSummary[] = contacts.map((person) => ({
    id: person.id,
    username: person.username,
    name: person.name,
  }));

  const outgoingSummaries: ContactSummary[] = outgoing.map((person) => ({
    id: person.id,
    username: person.username,
    name: person.name,
  }));

  const meetings: DashboardMeeting[] = await prisma.meeting.findMany({
    where: {
      OR: [
        { host: { is: { clerkId: userId } } },
        {
          participants: {
            some: { user: { is: { clerkId: userId } } },
          },
        },
      ],
    },
    select: {
      id: true,
      title: true,
      meetingCode: true,
      createdAt: true,
      startsAt: true,
      endsAt: true,
      host: {
        select: {
          clerkId: true,
          name: true,
        },
      },
      _count: {
        select: {
          participants: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  // Delegated to `lib/meetings/lifecycle.ts` rather than filtered on `endsAt`
  // here. The old test was `endsAt && endsAt < now`, which no instant meeting can
  // ever satisfy because instant meetings are created with `endsAt: null` — they
  // stayed under Upcoming permanently.
  const { upcoming: upcomingMeetings, past: pastMeetings } = partitionMeetings(
    meetings,
    Date.now(),
  );

  const firstName = firstNameOf(me?.name ?? null);

  return (
    <main className="relative min-h-[calc(100vh-4rem)] overflow-hidden bg-zinc-950 text-zinc-100">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[26rem] bg-[radial-gradient(75%_65%_at_50%_0%,rgba(99,102,241,0.22),transparent_70%)]"
      />

      <div className="relative mx-auto w-full max-w-7xl space-y-8 px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <section className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-zinc-300 backdrop-blur">
                <Sparkles
                  className="h-3.5 w-3.5 text-indigo-300"
                  aria-hidden="true"
                />
                Meeting hub
              </span>
              <StatusBadge />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-4xl">
              {firstName === null
                ? "Your meetings"
                : `Welcome back, ${firstName}`}
            </h1>
            <p className="max-w-xl text-sm text-zinc-400">
              Start a room in one tap, join with a code, and pick up where your
              conversations left off.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {me !== null && <ConnectDialog myUsername={me.username} />}
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-11 border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.12] hover:text-white"
            >
              <Link href="/meeting/new">
                <Plus className="h-5 w-5" aria-hidden="true" />
                Create New Meeting
              </Link>
            </Button>
          </div>
        </section>

        <QuickActions hostName={me?.name ?? null} />

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile
            label="Upcoming"
            value={upcomingMeetings.length}
            tone="text-white"
          />
          <StatTile
            label="Completed"
            value={pastMeetings.length}
            tone="text-zinc-300"
          />
          <StatTile
            label="Connections"
            value={contactSummaries.length}
            tone="text-indigo-200"
          />
        </dl>

        <ContactsList
          contacts={contactSummaries}
          outgoing={outgoingSummaries}
        />

        <section className="space-y-4" aria-labelledby="upcoming-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2
                id="upcoming-heading"
                className="text-lg font-semibold text-white sm:text-2xl"
              >
                Upcoming
              </h2>
              <p className="text-sm text-zinc-400">
                Meetings that are scheduled or still active.
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-zinc-300">
              {upcomingMeetings.length}
            </span>
          </div>
          {upcomingMeetings.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {upcomingMeetings.map((meeting) => (
                <MeetingCard
                  key={meeting.id}
                  meeting={meeting}
                  clerkUserId={userId}
                  isPast={false}
                />
              ))}
            </div>
          ) : (
            <EmptyMeetings type="upcoming" />
          )}
        </section>

        <section className="space-y-4" aria-labelledby="past-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2
                id="past-heading"
                className="text-lg font-semibold text-white sm:text-2xl"
              >
                Past meetings
              </h2>
              <p className="text-sm text-zinc-400">
                A history of meetings that have ended.
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-zinc-300">
              {pastMeetings.length}
            </span>
          </div>
          {pastMeetings.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {pastMeetings.map((meeting) => (
                <MeetingCard
                  key={meeting.id}
                  meeting={meeting}
                  clerkUserId={userId}
                  isPast
                />
              ))}
            </div>
          ) : (
            <EmptyMeetings type="past" />
          )}
        </section>
      </div>
    </main>
  );
}

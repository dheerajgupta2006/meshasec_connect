import { MeetingCardSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while the dashboard waits on the database.
 *
 * Mirrors the real layout — greeting, stat tiles, two sections of cards — so the
 * page does not jump when the data lands. Previously this was a blank screen for
 * the length of a round trip to Neon.
 */
export default function DashboardLoading() {
  return (
    <main
      // Announced once for the whole page. Individual skeletons are decorative.
      role="status"
      aria-live="polite"
      aria-label="Loading your dashboard"
      className="relative min-h-[calc(100vh-4rem)] overflow-hidden bg-zinc-950 text-zinc-100"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[26rem] bg-[radial-gradient(75%_65%_at_50%_0%,rgba(99,102,241,0.22),transparent_70%)]"
      />

      <div className="relative mx-auto max-w-7xl space-y-10 px-4 py-10 sm:px-6 lg:px-8">
        <div className="space-y-3">
          <Skeleton className="h-9 w-64 bg-white/10" />
          <Skeleton className="h-4 w-80 bg-white/10" />
        </div>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((tile) => (
            <div
              key={tile}
              className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"
            >
              <Skeleton className="h-3 w-16 bg-white/10" />
              <Skeleton className="mt-3 h-7 w-10 bg-white/10" />
            </div>
          ))}
        </dl>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((card) => (
            <MeetingCardSkeleton key={card} />
          ))}
        </div>

        <div className="space-y-4">
          <Skeleton className="h-7 w-40 bg-white/10" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1].map((card) => (
              <MeetingCardSkeleton key={card} />
            ))}
          </div>
        </div>
      </div>

      <span className="sr-only">Loading your meetings…</span>
    </main>
  );
}

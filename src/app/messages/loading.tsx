import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the conversation list so the page does not shift when data lands. */
export default function MessagesLoading() {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-label="Loading your conversations"
      className="min-h-[calc(100vh-4rem)] bg-gradient-to-b from-primary/[0.06] via-background to-background"
    >
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <div className="mb-8 space-y-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>

        <Skeleton className="mb-6 h-11 w-full" />

        <ul className="space-y-3">
          {[0, 1, 2, 3].map((row) => (
            <li key={row} className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-4">
                <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <span className="sr-only">Loading your conversations…</span>
    </main>
  );
}

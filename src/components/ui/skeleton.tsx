import { cn } from "@/lib/utils";

/**
 * Placeholder block for content that has not arrived.
 *
 * Shown instead of a blank page while a Server Component waits on the database.
 * A skeleton that mirrors the real layout reads as "loading"; an empty page reads
 * as "broken", which is what this app did before.
 *
 * The pulse is a Tailwind animation class rather than an inline style, so the
 * global `prefers-reduced-motion` rule in `globals.css` neutralises it.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // Decorative: the surrounding region announces its own loading state, and
      // announcing every block would flood a screen reader.
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-foreground/10", className)}
      {...props}
    />
  );
}

/** Skeleton shaped like a dashboard meeting card. */
export function MeetingCardSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-5 w-20 rounded-full bg-white/10" />
        <Skeleton className="h-3 w-24 bg-white/10" />
      </div>
      <Skeleton className="h-5 w-3/4 bg-white/10" />
      <Skeleton className="h-3 w-1/3 bg-white/10" />
      <div className="mt-1 space-y-2">
        <Skeleton className="h-3 w-2/3 bg-white/10" />
        <Skeleton className="h-3 w-1/2 bg-white/10" />
      </div>
      <Skeleton className="mt-auto h-9 w-full bg-white/10" />
    </div>
  );
}

import { LoaderCircle } from "lucide-react";

/**
 * App-wide fallback for routes without their own skeleton.
 *
 * A centred spinner rather than a layout-shaped skeleton, because this covers any
 * route and cannot know the shape of what is coming.
 */
export default function RootLoading() {
  return (
    <main
      role="status"
      aria-live="polite"
      className="grid min-h-[calc(100vh-4rem)] place-items-center bg-background px-4"
    >
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <LoaderCircle className="h-6 w-6 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading…</p>
      </div>
    </main>
  );
}

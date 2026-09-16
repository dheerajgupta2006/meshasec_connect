import { Compass, Home } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
};

/**
 * Replaces the framework's default 404.
 *
 * Reached most often by a stale or mistyped meeting link, so the copy points at
 * that rather than saying only "not found".
 */
export default function NotFound() {
  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-background px-4">
      <div className="w-full max-w-md text-center">
        <span
          aria-hidden="true"
          className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary"
        >
          <Compass className="h-6 w-6" />
        </span>

        <p className="mt-6 font-mono text-sm text-muted-foreground">404</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          We could not find that page
        </h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          The link may be mistyped, or the meeting it pointed to has ended.
        </p>

        <div className="mt-7 flex flex-col-reverse items-center gap-3 sm:flex-row sm:justify-center">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/">Go to the homepage</Link>
          </Button>
          <Button asChild className="w-full sm:w-auto">
            <Link href="/dashboard">
              <Home className="h-4 w-4" />
              Your dashboard
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}

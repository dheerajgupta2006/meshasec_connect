"use client";

import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary.
 *
 * Without this, a thrown error in any Server Component showed Next's own error
 * screen — the dev overlay locally, and a bare unstyled message in production.
 *
 * The error text itself is deliberately not rendered. In production Next replaces
 * it with an opaque digest anyway, and in development showing a raw stack to the
 * user teaches nothing; the digest is shown instead so a report can be matched to
 * a server log.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Logged rather than displayed: this is where a reporting service would go.
    console.error("route_error", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-background px-4">
      <div className="w-full max-w-md text-center">
        <span
          aria-hidden="true"
          className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-destructive/10 text-destructive-text"
        >
          <AlertTriangle className="h-6 w-6" />
        </span>

        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          This page could not be loaded. It is usually temporary — trying again
          often works.
        </p>

        {error.digest !== undefined && (
          <p className="mt-4 font-mono text-xs text-muted-foreground">
            Reference: {error.digest}
          </p>
        )}

        <div className="mt-7 flex flex-col-reverse items-center gap-3 sm:flex-row sm:justify-center">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/dashboard">
              <ArrowLeft className="h-4 w-4" />
              Back to dashboard
            </Link>
          </Button>
          <Button type="button" onClick={reset} className="w-full sm:w-auto">
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      </div>
    </main>
  );
}

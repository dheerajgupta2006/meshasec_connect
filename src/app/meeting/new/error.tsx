"use client";

import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface MeetingCreationErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Route error boundary. Because it replaces the page, the creation form is never
 * mounted when a page-level dependency fails. `error.message` is deliberately not
 * rendered; the digest is the safe reference to quote.
 */
export default function MeetingCreationError({
  error,
  reset,
}: MeetingCreationErrorProps) {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-2xl items-center px-4 py-10 sm:px-6">
      <Card className="w-full">
        <CardHeader>
          <span className="mb-2 grid h-11 w-11 place-items-center rounded-xl bg-destructive/10 text-destructive-text">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <CardTitle>We could not open the meeting form</CardTitle>
          <CardDescription>
            Something went wrong while preparing this page. Your account and your
            existing meetings are unaffected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {error.digest !== undefined && (
            <p className="text-sm text-muted-foreground">
              Reference:{" "}
              <span className="font-mono text-xs">{error.digest}</span>
            </p>
          )}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
              <Link href="/dashboard">
                <ArrowLeft className="h-4 w-4" />
                Back to dashboard
              </Link>
            </Button>
            <Button
              type="button"
              size="lg"
              onClick={reset}
              className="w-full sm:w-auto"
            >
              <RotateCcw className="h-4 w-4" />
              Try again
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

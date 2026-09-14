"use client";

import { SignedIn, SignedOut, SignUpButton } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The landing page's primary call to action.
 *
 * Client-side for the same reason as the header controls: after signing in
 * through the modal there is no full page load, so a server-evaluated
 * `SignedOut` branch would leave a dead "Start meeting for free" button behind.
 */
export function PrimaryCta() {
  return (
    <>
      <SignedOut>
        <SignUpButton mode="modal">
          <Button
            size="lg"
            className="h-12 rounded-xl px-6 shadow-lg shadow-primary/20"
          >
            Start meeting for free
            <ArrowRight className="h-4 w-4" />
          </Button>
        </SignUpButton>
      </SignedOut>

      <SignedIn>
        <Button
          asChild
          size="lg"
          className="h-12 rounded-xl px-6 shadow-lg shadow-primary/20"
        >
          <Link href="/dashboard">
            Open your dashboard
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </SignedIn>
    </>
  );
}

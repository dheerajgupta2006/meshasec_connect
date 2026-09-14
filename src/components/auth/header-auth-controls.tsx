"use client";

import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface HeaderAuthControlsProps {
  /**
   * Server-rendered nodes shown only to signed-in users (the message and
   * notification badges). Passed in rather than imported so those stay server
   * components while the visibility decision happens on the client.
   */
  signedInSlot?: ReactNode;
}

/**
 * Header auth controls.
 *
 * Deliberately a client component. The header sits in the root layout, and a
 * layout does not re-render during client-side navigation — so server-evaluated
 * `SignedOut` markup would stay in the DOM after signing in, leaving dead
 * "Sign in" buttons that ask Clerk to open a modal for an already-signed-in
 * user. Evaluated on the client, these track auth state live.
 */
export function HeaderAuthControls({
  signedInSlot,
}: HeaderAuthControlsProps) {
  return (
    <>
      <SignedOut>
        <SignInButton mode="modal">
          <Button variant="ghost" size="sm">
            Sign in
          </Button>
        </SignInButton>
        <SignUpButton mode="modal">
          <Button size="sm" className="hidden shadow-sm sm:inline-flex">
            Get started
            <ArrowRight className="h-4 w-4" />
          </Button>
        </SignUpButton>
      </SignedOut>

      <SignedIn>
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard">Dashboard</Link>
        </Button>
        {signedInSlot}
        <UserButton />
      </SignedIn>
    </>
  );
}

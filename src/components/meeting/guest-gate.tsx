"use client";

import { KeyRound, LoaderCircle, LogIn, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ROOM_PASSCODE_DIGITS } from "@/lib/meetings/types";

interface GuestGateProps {
  meetingCode: string;
  meetingTitle: string;
}

/**
 * Passcode exchange for someone joining without an account.
 *
 * Shown instead of the device lobby when there is no signed-in user and no valid
 * guest session. On success the server sets an httpOnly cookie and the page is
 * refreshed, at which point the normal lobby renders.
 *
 * The name is asked for here because a guest has no profile to read one from, and
 * an unnamed participant in a call is unhelpful for everyone else.
 */
export function GuestGate({ meetingCode, meetingTitle }: GuestGateProps) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const digits = passcode.replace(/[\s-]/g, "");

    if (digits.length !== ROOM_PASSCODE_DIGITS) {
      setError(`Enter the ${ROOM_PASSCODE_DIGITS}-digit room passcode.`);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/meetings/guest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingCode, passcode: digits, name }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const message =
          typeof payload === "object" &&
          payload !== null &&
          typeof (payload as { error?: unknown }).error === "string"
            ? (payload as { error: string }).error
            : "We could not let you in. Check the passcode and try again.";

        setBusy(false);
        setError(message);
        return;
      }

      // The cookie is set by the response; re-rendering the route on the server is
      // what swaps this gate for the real lobby.
      router.refresh();
    } catch {
      setBusy(false);
      setError("We could not reach the server. Check your connection.");
    }
  }

  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-zinc-950 px-4 text-zinc-100">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/70 p-7">
        <span
          aria-hidden="true"
          className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-blue-500/15 text-blue-300"
        >
          <KeyRound className="h-5 w-5" />
        </span>

        <h1 className="text-xl font-semibold tracking-tight">{meetingTitle}</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
          You have been invited as a guest. Enter your name and the room passcode
          to join — no account needed.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-2">
            <label
              className="flex items-center gap-2 text-sm font-medium"
              htmlFor="guest-name"
            >
              <UserRound className="h-4 w-4 text-zinc-400" aria-hidden="true" />
              Your name
            </label>
            <Input
              id="guest-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="What should we call you?"
              maxLength={60}
              autoComplete="name"
              disabled={busy}
              className="border-zinc-700 bg-zinc-950/70 text-zinc-50 placeholder:text-zinc-600"
            />
          </div>

          <div className="space-y-2">
            <label
              className="flex items-center gap-2 text-sm font-medium"
              htmlFor="guest-passcode"
            >
              <KeyRound className="h-4 w-4 text-zinc-400" aria-hidden="true" />
              Room passcode
            </label>
            <Input
              id="guest-passcode"
              value={passcode}
              onChange={(event) => {
                setPasscode(event.target.value);
                setError(null);
              }}
              // `numeric` rather than `number`: a number input strips leading
              // zeros, and a passcode like 001234 depends on them.
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
              maxLength={16}
              disabled={busy}
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : "guest-error"}
              className="border-zinc-700 bg-zinc-950/70 font-mono text-lg tracking-[0.3em] text-zinc-50 placeholder:tracking-normal placeholder:text-zinc-600"
            />
          </div>

          {error !== null && (
            <p
              id="guest-error"
              role="alert"
              className="text-xs font-medium text-red-400"
            >
              {error}
            </p>
          )}

          <Button
            type="submit"
            size="lg"
            disabled={busy || passcode.trim().length === 0}
            className="w-full bg-blue-600 text-white hover:bg-blue-500"
          >
            {busy ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {busy ? "Checking…" : "Continue as guest"}
          </Button>
        </form>

        <div className="mt-6 border-t border-white/10 pt-5">
          <p className="text-xs text-zinc-500">
            Have an account? Signing in shows this meeting in your history and
            lets the host make you a co-host.
          </p>
          <Button
            asChild
            variant="outline"
            className="mt-3 w-full border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14]"
          >
            <Link
              href={`/sign-in?redirect_url=/meeting/${encodeURIComponent(
                meetingCode,
              )}/lobby`}
            >
              <LogIn className="h-4 w-4" />
              Sign in instead
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}

"use client";

import { ArrowRight, KeyRound, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveJoinCode } from "@/lib/meetings/join-code";

/**
 * "Enter a meeting code" for the landing page hero.
 *
 * Both reference products put this on the front page, and it works here without
 * an account: `middleware.ts` marks `/meeting/(.*)` public, and the lobby renders
 * the guest passcode prompt until a signed guest session exists. So an invited
 * guest can land on the marketing page, type their code, and reach the room —
 * previously they had to be handed the full lobby URL.
 *
 * Shares its parser with the dashboard field via `@/lib/meetings/join-code`, so a
 * pasted invite link behaves identically in both places.
 */
export function HeroJoin() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Held for the whole navigation, which also guards against a double submit.
  const [isNavigating, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (isNavigating) {
      return;
    }

    const result = resolveJoinCode(value);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setError(null);
    startTransition(() => {
      router.push(result.href);
    });
  }

  const errorId = "hero-join-error";

  return (
    <form onSubmit={handleSubmit} noValidate className="w-full">
      <Label htmlFor="hero-join" className="sr-only">
        Meeting code or invite link
      </Label>
      {/* One bordered shell around both controls on `sm` and up so it reads as a
          single field, which is how the reference products present it. Below `sm`
          the two stack, because a 40px-wide button next to an input on a phone is
          a mis-tap waiting to happen. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-1.5 sm:rounded-2xl sm:border sm:bg-card sm:p-1.5 sm:shadow-sm">
        <div className="relative flex-1">
          <KeyRound
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="hero-join"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            placeholder="Enter a meeting code or invite link"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={isNavigating}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : errorId}
            className="h-12 w-full min-w-0 rounded-xl pl-10 text-[15px] sm:border-transparent sm:bg-transparent sm:shadow-none sm:focus-visible:ring-1"
          />
        </div>
        <Button
          type="submit"
          disabled={isNavigating}
          className="h-12 shrink-0 rounded-xl px-5 text-[15px]"
        >
          {isNavigating ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          )}
          {isNavigating ? "Joining…" : "Join"}
        </Button>
      </div>
      {error === null ? (
        <p className="mt-2.5 text-xs text-muted-foreground">
          Invited as a guest? No account needed — just your code and passcode.
        </p>
      ) : (
        <p
          id={errorId}
          role="alert"
          className="mt-2.5 break-words text-xs font-medium text-destructive-text"
        >
          {error}
        </p>
      )}
    </form>
  );
}

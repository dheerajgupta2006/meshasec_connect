"use client";

import { ArrowRight, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveJoinCode } from "@/lib/meetings/join-code";

/**
 * Dashboard "join by code" field.
 *
 * The parsing lives in `@/lib/meetings/join-code` because the landing page hero
 * offers the same affordance; this component is only the dashboard's presentation
 * of it, styled for the dark action card it sits inside.
 */
export function JoinByCode() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stays pending for the duration of the navigation, which doubles as the
  // guard against a second submit.
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

  const errorId = "join-by-code-error";

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-2">
      <Label htmlFor="join-by-code" className="sr-only">
        Meeting code or invite link
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="join-by-code"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder="Code or invite link"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={isNavigating}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          className="h-11 min-w-0 border-white/15 bg-white/[0.06] text-zinc-100 placeholder:text-zinc-500 sm:h-10"
        />
        <Button
          type="submit"
          disabled={isNavigating}
          aria-label="Join meeting by code"
          className="h-11 w-full shrink-0 bg-white text-zinc-900 hover:bg-zinc-200 sm:h-10 sm:w-auto"
        >
          {isNavigating ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="h-4 w-4" />
          )}
          {isNavigating ? "Joining…" : "Join"}
        </Button>
      </div>
      {error !== null && (
        <p
          id={errorId}
          role="alert"
          className="break-words text-xs text-destructive-text"
        >
          {error}
        </p>
      )}
    </form>
  );
}

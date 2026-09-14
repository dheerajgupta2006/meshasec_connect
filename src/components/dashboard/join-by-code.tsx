"use client";

import { ArrowRight, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The Meeting_Code alphabet: unpadded base64url, mirrored from the server's
 * generator contract. Used only to reject obvious junk before navigating; the
 * lobby route remains the authority on whether a meeting exists.
 */
const MEETING_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Route segments that follow the code in an invite URL. */
const TRAILING_ROUTE_SEGMENTS = new Set(["lobby", "room"]);

const EMPTY_MESSAGE = "Enter a meeting code or paste an invite link.";
const SHAPE_MESSAGE =
  "That does not look like a meeting code. Check the link and try again.";

/**
 * Accepts either a bare code or a pasted invite URL.
 *
 * An invite link is `https://host/meeting/<code>/lobby`, so the last path
 * segment is the route, not the code. The code is taken from just after the
 * `meeting` segment when one is present, and only otherwise from the final
 * segment — which is what makes both a pasted link and a hand-typed code work.
 */
function extractMeetingCode(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return "";
  }

  // Drop any query string or fragment before looking at path segments.
  const pathOnly = trimmed.split(/[?#]/)[0] ?? "";
  const segments = pathOnly
    .split("/")
    .map((segment) => safeDecode(segment.trim()))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return "";
  }

  const meetingIndex = segments.lastIndexOf("meeting");

  if (meetingIndex !== -1) {
    const afterMeeting: string | undefined = segments[meetingIndex + 1];

    if (afterMeeting !== undefined) {
      return afterMeeting;
    }
  }

  const last: string | undefined = segments[segments.length - 1];

  if (last === undefined) {
    return "";
  }

  // A URL that ends in a known route segment still carries the code before it.
  if (TRAILING_ROUTE_SEGMENTS.has(last.toLowerCase()) && segments.length > 1) {
    return segments[segments.length - 2] ?? "";
  }

  return last;
}

/** `decodeURIComponent` throws on malformed input, so the raw value stands in. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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

    const code = extractMeetingCode(value);

    if (code.length === 0) {
      setError(EMPTY_MESSAGE);
      return;
    }
    if (!MEETING_CODE_PATTERN.test(code)) {
      setError(SHAPE_MESSAGE);
      return;
    }

    setError(null);
    startTransition(() => {
      router.push(`/meeting/${encodeURIComponent(code)}/lobby`);
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

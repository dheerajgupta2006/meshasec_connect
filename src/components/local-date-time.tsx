"use client";

import { useEffect, useState } from "react";

export type DateTimeMode = "date" | "time" | "dateTime" | "dayMonth";

interface LocalDateTimeProps {
  /** ISO 8601 instant. Serialised because this crosses the server boundary. */
  iso: string;
  mode?: DateTimeMode;
  /** Shown before the browser has formatted the value. */
  fallback?: string;
  className?: string;
}

/**
 * Renders a timestamp in the viewer's own time zone.
 *
 * Formatting a date inside a Server Component uses the *server's* time zone,
 * which on Vercel is UTC. A meeting at 10:45 in India was therefore displayed as
 * 05:15, because `Intl.DateTimeFormat` with no explicit `timeZone` silently falls
 * back to wherever the code is running.
 *
 * Hardcoding `Asia/Kolkata` would only move the problem to the next region, so the
 * formatting happens in the browser instead, where the correct zone and locale are
 * actually known.
 *
 * The value is set in an effect rather than during render on purpose: the server
 * and the client would otherwise produce different text for the same element, and
 * React keeps the server's version through hydration. Writing it after mount is
 * what guarantees the corrected time is the one on screen.
 */
export function LocalDateTime({
  iso,
  mode = "dateTime",
  fallback = "—",
  className,
}: LocalDateTimeProps) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const parsed = new Date(iso);

    if (Number.isNaN(parsed.getTime())) {
      setText(null);
      return;
    }

    // `undefined` locale means "use the browser's", and no `timeZone` here means
    // the browser's own — which is the whole point.
    setText(
      new Intl.DateTimeFormat(undefined, optionsFor(mode)).format(parsed),
    );
  }, [iso, mode]);

  return (
    // `dateTime` carries the machine-readable instant regardless of what is
    // rendered, so the markup stays meaningful before the effect runs.
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {text ?? fallback}
    </time>
  );
}

function optionsFor(mode: DateTimeMode): Intl.DateTimeFormatOptions {
  if (mode === "date") {
    return { dateStyle: "medium" };
  }

  if (mode === "time") {
    return { timeStyle: "short" };
  }

  if (mode === "dayMonth") {
    return { month: "short", day: "numeric" };
  }

  return { dateStyle: "medium", timeStyle: "short" };
}

"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Announces direct messages anywhere in the app.
 *
 * Three things were missing before this, and web push fixed none of them:
 *
 * - A push notification is suppressed by the browser while the page is focused,
 *   so a DM arriving while the recipient sat on the dashboard was completely
 *   silent.
 * - The unread badge is rendered by a server component in the root layout, so it
 *   only moved on a full navigation. A message could sit unread with the header
 *   still showing nothing.
 * - Push needs VAPID keys configured and permission granted. This works
 *   regardless of both.
 *
 * Renders nothing. It polls, toasts, and asks the router to re-render the layout
 * so the badge follows — the count itself is never duplicated into client state,
 * which keeps the server component the single source of truth.
 */

/**
 * Poll cadence.
 *
 * Four times slower than the incoming-call poll, because the urgency is genuinely
 * different: a caller is sitting there waiting, a message can wait a few seconds.
 * Skipped entirely while the tab is hidden, with a catch-up on focus.
 */
const POLL_INTERVAL_MS = 15000;

interface UnreadAlert {
  id: string;
  fromName: string;
  fromUsername: string;
  preview: string;
}

function parseAlert(value: unknown): UnreadAlert | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.id !== "string" ||
    typeof record.fromName !== "string" ||
    typeof record.fromUsername !== "string" ||
    typeof record.preview !== "string"
  ) {
    return null;
  }

  return {
    id: record.id,
    fromName: record.fromName,
    fromUsername: record.fromUsername,
    preview: record.preview,
  };
}

export function MessageNotifier() {
  const router = useRouter();
  const pathname = usePathname();

  /**
   * Newest unread id already accounted for.
   *
   * `undefined` means no poll has completed yet. The first result only
   * establishes this baseline and never toasts — otherwise every page load would
   * re-announce mail that has been sitting unread for days, which the badge
   * already covers.
   */
  const seenIdRef = useRef<string | null | undefined>(undefined);
  const inFlightRef = useRef(false);
  /** Read inside the poll without making `pathname` a dependency of it. */
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  const poll = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;

    try {
      const response = await fetch("/api/messages/unread", {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const payload: unknown = await response.json();
      const record =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)
          : null;

      if (record === null) {
        return;
      }

      const latest = parseAlert(record.latest);
      const previous = seenIdRef.current;

      seenIdRef.current = latest?.id ?? null;

      // Baseline pass, nothing unread, or nothing new. Guarding on `latest`
      // itself rather than its id so it narrows for the toast below.
      if (previous === undefined || latest === null || latest.id === previous) {
        return;
      }

      // Already reading this conversation: the thread appends it within seconds
      // and marks it read, so a toast would be noise about something on screen.
      const openThread = `/messages/${encodeURIComponent(latest.fromUsername)}`;

      if (pathnameRef.current === openThread) {
        return;
      }

      toast(latest.fromName, {
        description: latest.preview,
        action: {
          label: "Open",
          onClick: () => router.push(openThread),
        },
      });

      // Re-renders the layout so `MessagesNavLink` recounts. Cheaper than holding
      // a second copy of the count here and risking the two disagreeing, and it
      // only runs when a message actually arrived.
      router.refresh();
    } catch {
      // A failed poll is not worth surfacing; the next tick retries.
    } finally {
      inFlightRef.current = false;
    }
  }, [router]);

  useEffect(() => {
    void poll();

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void poll();
      }
    }, POLL_INTERVAL_MS);

    // Background tabs have their timers throttled to roughly once a minute, so
    // without this a message could go unannounced until the tab was reloaded.
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void poll();
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    // A backgrounded window is not always `hidden`, so focus is a second signal.
    window.addEventListener("focus", handleVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
    };
  }, [poll]);

  return null;
}

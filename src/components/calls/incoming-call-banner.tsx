"use client";

import { PhoneCall, PhoneOff, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { respondToCallInvite } from "@/app/connections/actions";
import { Button } from "@/components/ui/button";
import { useRingtone } from "@/hooks/use-ringtone";
import { installAudioUnlock } from "@/lib/audio-unlock";

interface IncomingCall {
  meetingCode: string;
  callerName: string;
  callerUsername: string;
  createdAt: string;
  /** A mid-call invite into an existing room rather than a fresh 1-on-1. */
  isGroupInvite: boolean;
}

/**
 * Poll cadence.
 *
 * Every tick is a database round trip, but a ring is the one notification where
 * latency is obvious: the caller is sitting there waiting. Ten seconds felt
 * broken, so this is tightened — and the poll is skipped entirely while the tab is
 * hidden, which keeps the cost close to what it was.
 */
const POLL_INTERVAL_MS = 4000;
const DISMISSED_STORAGE_KEY = "meshasec:dismissed-calls";

function readDismissed(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_STORAGE_KEY);

    if (raw === null) {
      return new Set<string>();
    }

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }

    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set<string>();
  }
}

function persistDismissed(codes: Set<string>): void {
  try {
    window.sessionStorage.setItem(
      DISMISSED_STORAGE_KEY,
      JSON.stringify(Array.from(codes)),
    );
  } catch {
    // Storage can be unavailable in private modes; dismissal then lasts only
    // for this page view, which is an acceptable degradation.
  }
}

function isIncomingCall(value: unknown): value is IncomingCall {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.meetingCode === "string" &&
    typeof record.callerName === "string" &&
    typeof record.callerUsername === "string" &&
    typeof record.createdAt === "string"
  );
}

/**
 * Narrows the optional flag without rejecting a payload that predates it.
 *
 * A rolling deploy can serve the old shape to a page already running the new
 * code; treating the absent field as `false` degrades to the previous wording
 * rather than dropping the ring entirely.
 */
function toIncomingCall(value: IncomingCall): IncomingCall {
  return {
    ...value,
    isGroupInvite:
      (value as unknown as Record<string, unknown>).isGroupInvite === true,
  };
}

/**
 * Ringing banner for direct calls.
 *
 * Polls rather than holding a socket, matching how direct messages already work.
 * Without this, the person being called gets no signal at all and both sides end
 * up sitting in separate rooms.
 */
export function IncomingCallBanner() {
  const router = useRouter();
  const [call, setCall] = useState<IncomingCall | null>(null);
  const dismissedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    dismissedRef.current = readDismissed();
  }, []);

  // Unlocks audio on the user's first interaction anywhere in the app, so the
  // ringtone is ready before a call arrives rather than being refused at ring
  // time. Costs nothing after the first click; the listeners remove themselves.
  useEffect(() => installAudioUnlock(), []);

  const inFlightRef = useRef(false);

  const poll = useCallback(async () => {
    // A hidden tab cannot show a banner, so there is no reason to query for one.
    if (document.visibilityState === "hidden" || inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;

    try {
      const response = await fetch("/api/calls/incoming", {
        cache: "no-store",
      });

      if (!response.ok || !mountedRef.current) {
        return;
      }

      const payload: unknown = await response.json();

      const list =
        typeof payload === "object" &&
        payload !== null &&
        Array.isArray((payload as { calls?: unknown }).calls)
          ? (payload as { calls: unknown[] }).calls
          : [];

      const found =
        list.filter(isIncomingCall).find(
          (entry) => !dismissedRef.current.has(entry.meetingCode),
        ) ?? null;

      const next = found === null ? null : toIncomingCall(found);

      if (mountedRef.current) {
        setCall(next);
      }
    } catch {
      // A failed poll is not worth surfacing; the next tick retries.
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void poll();

    const timer = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    /**
     * Catch up the moment the tab is looked at again.
     *
     * This is what fixes "I only see the call after refreshing". Browsers throttle
     * `setInterval` heavily in background tabs — often to once a minute, sometimes
     * suspending it entirely — so a call placed while the tab was in the
     * background could go unnoticed until the 90-second ringing window had already
     * expired. Reloading worked only because it re-ran the initial poll.
     */
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void poll();
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    // A backgrounded window is not always `hidden`, so focus is a second signal.
    window.addEventListener("focus", handleVisibility);

    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
    };
  }, [poll]);

  // Rings while a call is on screen. Silent if the browser refuses audio before
  // the user has interacted with the page; the banner still shows either way.
  useRingtone(call !== null);

  function dismiss(): void {
    if (call === null) {
      return;
    }

    dismissedRef.current.add(call.meetingCode);
    persistDismissed(dismissedRef.current);

    // Also recorded server-side, so the invite stops ringing on this user's other
    // devices. sessionStorage alone is per-tab.
    void respondToCallInvite(call.meetingCode, "dismiss");

    setCall(null);
  }

  function accept(): void {
    if (call === null) {
      return;
    }

    // Dismiss on accept too, so returning to the dashboard afterwards does not
    // ring for a call already answered.
    dismissedRef.current.add(call.meetingCode);
    persistDismissed(dismissedRef.current);
    void respondToCallInvite(call.meetingCode, "accept");

    const target = `/meeting/${encodeURIComponent(call.meetingCode)}/lobby`;
    setCall(null);
    router.push(target);
  }

  if (call === null) {
    return null;
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-x-3 top-20 z-[60] mx-auto max-w-md rounded-2xl border border-emerald-400/30 bg-zinc-900/95 p-4 shadow-2xl backdrop-blur-xl sm:inset-x-auto sm:right-6"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-300"
        >
          <UserRound className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-50">
            {call.isGroupInvite
              ? `${call.callerName} invited you to a group call`
              : `${call.callerName} is calling`}
          </p>
          <p className="truncate font-mono text-xs text-zinc-400">
            @{call.callerUsername}
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <Button
          type="button"
          onClick={accept}
          className="h-11 flex-1 bg-emerald-500 text-zinc-950 hover:bg-emerald-400 sm:h-10"
        >
          <PhoneCall className="h-4 w-4" aria-hidden="true" />
          Join
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={dismiss}
          className="h-11 flex-1 border-white/15 bg-white/[0.06] text-zinc-200 hover:bg-white/[0.12] sm:h-10"
        >
          <PhoneOff className="h-4 w-4" aria-hidden="true" />
          Dismiss
        </Button>
      </div>
    </div>
  );
}

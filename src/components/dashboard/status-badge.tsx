"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Presence states the dashboard is able to state truthfully.
 *
 * "away" comes from the Page Visibility API, which is the only presence signal
 * the browser actually exposes here. "in-meeting" is never inferred: a caller
 * that observes a live session passes `inMeeting`. There is no heartbeat, no
 * socket, and no last-seen column behind this component, so nothing else is
 * claimed.
 */
type PresenceKind = "online" | "away" | "in-meeting";

interface StatusBadgeProps {
  /** Set by callers that can observe an active session. Defaults to false. */
  inMeeting?: boolean;
  className?: string;
}

interface PresenceTone {
  label: string;
  /** Short explanation exposed to assistive tech alongside the label. */
  hint: string;
  dot: string;
  glow: string;
  text: string;
}

const PRESENCE_TONES: Record<PresenceKind, PresenceTone> = {
  online: {
    label: "Online",
    hint: "This tab is active",
    dot: "bg-emerald-400",
    glow: "shadow-[0_0_0_3px_rgba(52,211,153,0.15)]",
    text: "text-emerald-200",
  },
  away: {
    label: "Away",
    hint: "This tab is in the background",
    dot: "bg-amber-400",
    glow: "shadow-[0_0_0_3px_rgba(251,191,36,0.15)]",
    text: "text-amber-200",
  },
  "in-meeting": {
    label: "In Meeting",
    hint: "You are connected to a meeting",
    dot: "bg-sky-400",
    glow: "shadow-[0_0_0_3px_rgba(56,189,248,0.15)]",
    text: "text-sky-200",
  },
};

function presenceFor(inMeeting: boolean, documentHidden: boolean): PresenceKind {
  if (inMeeting) {
    return "in-meeting";
  }
  return documentHidden ? "away" : "online";
}

export function StatusBadge({
  inMeeting = false,
  className,
}: StatusBadgeProps) {
  // `document` does not exist during the server render, so the first paint uses
  // the neutral value and the effect corrects it right after hydration. Reading
  // it during render instead would risk a hydration mismatch.
  const [documentHidden, setDocumentHidden] = useState(false);

  useEffect(() => {
    function readVisibility(): void {
      setDocumentHidden(document.visibilityState === "hidden");
    }

    readVisibility();
    document.addEventListener("visibilitychange", readVisibility);

    return () => {
      document.removeEventListener("visibilitychange", readVisibility);
    };
  }, []);

  const presence = presenceFor(inMeeting, documentHidden);
  const tone = PRESENCE_TONES[presence];

  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium backdrop-blur",
        tone.text,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot, tone.glow)}
      />
      <span className="sr-only">Your status: </span>
      <span className="truncate">{tone.label}</span>
      <span className="sr-only">. {tone.hint}.</span>
    </span>
  );
}

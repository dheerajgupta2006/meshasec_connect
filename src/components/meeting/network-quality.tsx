"use client";

import { Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type NetworkQualityLevel =
  | "unknown"
  | "good"
  | "fair"
  | "poor"
  | "offline";

interface NetworkQualityProps {
  /** Same-origin URL used as a round-trip probe. */
  endpoint?: string;
  /** How often to re-measure while mounted. */
  intervalMs?: number;
  /** Probes per measurement; the median is used. */
  sampleCount?: number;
  className?: string;
}

/** Subset of the Network Information API we can safely feature-detect. */
interface NetworkInformationLike {
  effectiveType?: string;
  rtt?: number;
  downlink?: number;
}

interface NetworkQualityState {
  level: NetworkQualityLevel;
  latencyMs: number | null;
  effectiveType: string | null;
}

const DEFAULT_ENDPOINT = "/favicon.ico";
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_SAMPLE_COUNT = 3;
const GOOD_MAX_MS = 180;
const FAIR_MAX_MS = 500;
const PROBE_SPACING_MS = 120;

const INITIAL_STATE: NetworkQualityState = {
  level: "unknown",
  latencyMs: null,
  effectiveType: null,
};

const LEVEL_COPY: Record<
  NetworkQualityLevel,
  { label: string; bars: number; tone: string; dot: string }
> = {
  unknown: {
    label: "Checking…",
    bars: 0,
    tone: "text-zinc-400",
    dot: "bg-zinc-600",
  },
  good: {
    label: "Good",
    bars: 3,
    tone: "text-emerald-300",
    dot: "bg-emerald-400",
  },
  fair: {
    label: "Fair",
    bars: 2,
    tone: "text-amber-300",
    dot: "bg-amber-400",
  },
  poor: { label: "Poor", bars: 1, tone: "text-red-300", dot: "bg-red-400" },
  offline: {
    label: "Offline",
    bars: 0,
    tone: "text-red-300",
    dot: "bg-red-400",
  },
};

function now(): number {
  return typeof performance !== "undefined" && "now" in performance
    ? performance.now()
    : Date.now();
}

function readConnection(): NetworkInformationLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  const scope = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };

  return scope.connection ?? scope.mozConnection ?? scope.webkitConnection ?? null;
}

function isOnline(): boolean {
  if (typeof navigator === "undefined" || !("onLine" in navigator)) {
    return true;
  }
  return navigator.onLine;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }

  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return (lower + upper) / 2;
}

/** Spaces probes apart, resolving early when the caller aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const handleAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };

    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

/** Times one round trip. Returns `null` when the request never completed. */
async function probe(
  endpoint: string,
  signal: AbortSignal,
): Promise<number | null> {
  const separator = endpoint.includes("?") ? "&" : "?";
  const url = `${endpoint}${separator}rtt=${Date.now().toString(36)}`;
  const startedAt = now();

  try {
    // Any status code is a valid timing sample: the round trip completed.
    await fetch(url, { method: "HEAD", cache: "no-store", signal });
    return now() - startedAt;
  } catch {
    return null;
  }
}

function levelFromLatency(latencyMs: number): NetworkQualityLevel {
  if (latencyMs <= GOOD_MAX_MS) {
    return "good";
  }
  if (latencyMs <= FAIR_MAX_MS) {
    return "fair";
  }
  return "poor";
}

/** Caps the measured level when the browser reports a slow radio link. */
function applyConnectionHint(
  level: NetworkQualityLevel,
  effectiveType: string | null,
): NetworkQualityLevel {
  if (level === "unknown" || level === "offline" || effectiveType === null) {
    return level;
  }

  if (effectiveType === "slow-2g" || effectiveType === "2g") {
    return "poor";
  }

  if (effectiveType === "3g" && level === "good") {
    return "fair";
  }

  return level;
}

export function NetworkQuality({
  endpoint = DEFAULT_ENDPOINT,
  intervalMs = DEFAULT_INTERVAL_MS,
  sampleCount = DEFAULT_SAMPLE_COUNT,
  className,
}: NetworkQualityProps) {
  const [state, setState] = useState<NetworkQualityState>(INITIAL_STATE);
  const inFlightRef = useRef(false);

  const samples = Math.max(1, Math.round(sampleCount));

  const measure = useCallback(
    async (signal: AbortSignal) => {
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;

      try {
        const connection = readConnection();
        const effectiveType =
          typeof connection?.effectiveType === "string"
            ? connection.effectiveType
            : null;

        if (!isOnline()) {
          if (!signal.aborted) {
            setState({ level: "offline", latencyMs: null, effectiveType });
          }
          return;
        }

        const timings: number[] = [];

        for (let index = 0; index < samples; index += 1) {
          if (signal.aborted) {
            return;
          }

          const timing = await probe(endpoint, signal);

          if (timing !== null) {
            timings.push(timing);
          }

          if (index < samples - 1) {
            await delay(PROBE_SPACING_MS, signal);
          }
        }

        if (signal.aborted) {
          return;
        }

        if (timings.length === 0) {
          setState({
            level: isOnline() ? "poor" : "offline",
            latencyMs: null,
            effectiveType,
          });
          return;
        }

        const latencyMs = median(timings);

        setState({
          level: applyConnectionHint(levelFromLatency(latencyMs), effectiveType),
          latencyMs,
          effectiveType,
        });
      } finally {
        inFlightRef.current = false;
      }
    },
    [endpoint, samples],
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof fetch !== "function") {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    void measure(signal);

    const timer = window.setInterval(() => {
      void measure(signal);
    }, Math.max(3_000, intervalMs));

    const handleOnline = () => {
      void measure(signal);
    };
    const handleOffline = () => {
      if (!signal.aborted) {
        setState((current) => ({
          ...current,
          level: "offline",
          latencyMs: null,
        }));
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      controller.abort();
    };
  }, [intervalMs, measure]);

  const copy = LEVEL_COPY[state.level];
  const detail =
    state.level === "offline"
      ? "No connection detected"
      : state.latencyMs === null
        ? "Measuring round trip…"
        : `${Math.round(state.latencyMs)} ms round trip${
            state.effectiveType ? ` · ${state.effectiveType}` : ""
          }`;

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-full border border-zinc-800 bg-zinc-950/70 px-3 py-2",
        className,
      )}
      title={detail}
    >
      <span
        className={cn("shrink-0", copy.tone, "opacity-90")}
        aria-hidden="true"
      >
        {state.level === "offline" ? (
          <WifiOff className="h-3.5 w-3.5" />
        ) : (
          <Wifi className="h-3.5 w-3.5" />
        )}
      </span>

      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className={cn(
              "w-[3px] rounded-sm transition-colors",
              index === 0 ? "h-1.5" : index === 1 ? "h-2.5" : "h-3.5",
              index < copy.bars ? copy.dot : "bg-zinc-700",
            )}
          />
        ))}
      </span>

      {/* Only the level lives in the live region so periodic re-measurements
          do not re-announce unchanged latency numbers. */}
      <span
        role="status"
        aria-live="polite"
        className={cn("text-[11px] font-medium", copy.tone)}
      >
        <span className="sr-only">Network quality: </span>
        {copy.label}
      </span>
    </div>
  );
}

"use client";

import { Mic, MicOff } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

interface AudioLevelMeterProps {
  /** Live preview stream. The first enabled audio track drives the meter. */
  stream: MediaStream | null;
  /** Mirrors the lobby microphone toggle so the meter can show an idle state. */
  muted?: boolean;
  /** Number of bars to render. Clamped to 5–7. */
  barCount?: number;
  className?: string;
}

/** Matches `window.AudioContext` without depending on the vendor-prefixed global type. */
type AudioContextConstructor = new (
  options?: AudioContextOptions,
) => AudioContext;

const FFT_SIZE = 1024;
/** Throttles React updates; the analyser itself still runs every frame. */
const UPDATE_INTERVAL_MS = 45;
const SPEAKING_THRESHOLD = 0.05;
const MIN_BAR_SCALE = 0.14;
/** Voice energy sits in the lower part of the spectrum, so ignore the top bins. */
const USABLE_SPECTRUM_RATIO = 0.45;
const ATTACK = 0.55;
const DECAY = 0.16;

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  // `typeof window` keeps the global declarations (AudioContext) in scope while
  // adding the vendor-prefixed fallback that older Safari still ships.
  const scope: typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  } = window;

  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function smooth(previous: number, next: number): number {
  const factor = next > previous ? ATTACK : DECAY;
  return previous + (next - previous) * factor;
}

function createIdleBars(barCount: number): number[] {
  return new Array<number>(barCount).fill(0);
}

interface AnalyserGraph {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
}

/**
 * Builds the analyser graph for a single audio track. Returns `null` when the
 * browser refuses to create the context so callers can fall back to idle.
 */
function createAnalyserGraph(track: MediaStreamTrack): AnalyserGraph | null {
  const AudioContextCtor = resolveAudioContextConstructor();

  if (!AudioContextCtor) {
    return null;
  }

  let context: AudioContext | null = null;

  try {
    context = new AudioContextCtor();
    // A dedicated stream keeps the graph scoped to audio; the preview's video
    // track is irrelevant here.
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    // Deliberately not connected to `destination`: routing the mic to the
    // speakers would echo.
    return { context, source, analyser };
  } catch {
    if (context) {
      void context.close().catch(() => undefined);
    }
    return null;
  }
}

export function AudioLevelMeter({
  stream,
  muted = false,
  barCount = 6,
  className,
}: AudioLevelMeterProps) {
  const bars = Math.min(7, Math.max(5, Math.round(barCount)));

  const [levels, setLevels] = useState<number[]>(() => createIdleBars(bars));
  const [level, setLevel] = useState(0);
  const [trackLive, setTrackLive] = useState(false);

  useEffect(() => {
    setLevels(createIdleBars(bars));
  }, [bars]);

  useEffect(() => {
    const audioTrack = stream?.getAudioTracks()[0] ?? null;

    if (!audioTrack || audioTrack.readyState !== "live") {
      setTrackLive(false);
      setLevel(0);
      setLevels(createIdleBars(bars));
      return;
    }

    const graph = createAnalyserGraph(audioTrack);

    if (!graph) {
      setTrackLive(false);
      setLevel(0);
      setLevels(createIdleBars(bars));
      return;
    }

    const { context, source, analyser } = graph;

    let cancelled = false;
    let frameId = 0;
    let smoothedLevel = 0;
    let smoothedBars = createIdleBars(bars);
    let lastPublishedAt = 0;

    const handleTrackEnded = () => {
      if (!cancelled) {
        setTrackLive(false);
      }
    };

    audioTrack.addEventListener("ended", handleTrackEnded);
    setTrackLive(true);

    // Browsers commonly hand back a suspended context until a gesture happens.
    const resumeContext = () => {
      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }
    };

    resumeContext();
    // If autoplay policy still blocks it, the next interaction unblocks it.
    window.addEventListener("pointerdown", resumeContext);
    window.addEventListener("keydown", resumeContext);

    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Uint8Array(analyser.fftSize);
    const usableBins = Math.max(
      bars,
      Math.floor(frequencyData.length * USABLE_SPECTRUM_RATIO),
    );
    const bandSize = Math.max(1, Math.floor(usableBins / bars));

    const readLevels = (timestamp: number) => {
      if (cancelled) {
        return;
      }

      frameId = window.requestAnimationFrame(readLevels);

      const silent = !audioTrack.enabled || audioTrack.readyState !== "live";

      analyser.getByteTimeDomainData(timeData);
      analyser.getByteFrequencyData(frequencyData);

      let sumOfSquares = 0;
      for (let index = 0; index < timeData.length; index += 1) {
        const centered = (timeData[index] - 128) / 128;
        sumOfSquares += centered * centered;
      }
      const rms = Math.sqrt(sumOfSquares / timeData.length);
      // Speech rarely exceeds ~0.3 RMS, so scale up before clamping.
      const rawLevel = silent ? 0 : clamp01(rms * 3.4);

      const nextBars: number[] = [];
      for (let band = 0; band < bars; band += 1) {
        let total = 0;
        let counted = 0;
        for (
          let bin = band * bandSize;
          bin < (band + 1) * bandSize && bin < usableBins;
          bin += 1
        ) {
          total += frequencyData[bin];
          counted += 1;
        }
        const average = counted === 0 ? 0 : total / counted / 255;
        const previous = smoothedBars[band] ?? 0;
        nextBars.push(smooth(previous, silent ? 0 : clamp01(average * 1.5)));
      }

      smoothedBars = nextBars;
      smoothedLevel = smooth(smoothedLevel, rawLevel);

      if (timestamp - lastPublishedAt < UPDATE_INTERVAL_MS) {
        return;
      }
      lastPublishedAt = timestamp;

      setLevel(smoothedLevel);
      setLevels(nextBars);
    };

    frameId = window.requestAnimationFrame(readLevels);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("pointerdown", resumeContext);
      window.removeEventListener("keydown", resumeContext);
      audioTrack.removeEventListener("ended", handleTrackEnded);

      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // Already-disconnected nodes throw on some engines; nothing to undo.
      }

      // Closing is what actually releases the hardware-backed context. Skipping
      // it here would leak one context per device switch.
      if (context.state !== "closed") {
        void context.close().catch(() => undefined);
      }
    };
  }, [bars, stream]);

  const inactive = muted || !trackLive;
  const speaking = !inactive && level > SPEAKING_THRESHOLD;
  const displayLevels = inactive ? createIdleBars(bars) : levels;
  const statusLabel = muted
    ? "Muted"
    : !trackLive
      ? "No input"
      : speaking
        ? "Speaking"
        : "Quiet";

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-full border border-zinc-800 bg-zinc-950/70 px-3 py-2",
        className,
      )}
    >
      <span
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded-full transition-colors",
          inactive
            ? "bg-zinc-800 text-zinc-500"
            : speaking
              ? "bg-emerald-500/20 text-emerald-300"
              : "bg-zinc-800 text-zinc-300",
        )}
        aria-hidden="true"
      >
        {muted ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
      </span>

      <div
        className="flex h-6 flex-1 items-center gap-[3px]"
        role="meter"
        aria-live="off"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={inactive ? 0 : Math.round(level * 10) * 10}
        aria-label={`Microphone input level: ${statusLabel}`}
      >
        {displayLevels.map((barLevel, index) => {
          const scale = inactive
            ? MIN_BAR_SCALE
            : Math.max(MIN_BAR_SCALE, clamp01(barLevel));

          return (
            <span
              key={index}
              className={cn(
                "h-full w-full min-w-[3px] max-w-[6px] origin-center rounded-full transition-transform duration-75 ease-out",
                inactive
                  ? "bg-zinc-700"
                  : speaking
                    ? "bg-emerald-400"
                    : "bg-zinc-600",
              )}
              style={{ transform: `scaleY(${scale.toFixed(3)})` }}
            />
          );
        })}
      </div>

      <span className="w-14 shrink-0 text-right text-[11px] font-medium text-zinc-500">
        {statusLabel}
      </span>
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";

/**
 * Plays a ring tone while a call is incoming.
 *
 * Synthesised with the Web Audio API rather than shipped as an MP3: it is a few
 * lines, adds no binary asset, and cannot fail to load.
 *
 * Autoplay policy is the real constraint. A browser refuses to start audio until
 * the user has interacted with the page, so this cannot be guaranteed to sound —
 * it resumes the context if allowed and stays silent if not. The banner is always
 * shown regardless, so the notification never depends on audio succeeding.
 */

/** Classic two-tone ring, in hertz. */
const TONE_A = 480;
const TONE_B = 620;

/** One ring is two short bursts, then a gap, repeating. */
const BURST_MS = 380;
const GAP_MS = 200;
const CYCLE_MS = 2600;

/** Kept well below 1 so a ring is noticeable without being startling. */
const PEAK_GAIN = 0.16;

interface RingtoneHandle {
  context: AudioContext;
  timers: number[];
  stopped: boolean;
}

type AudioContextConstructor = new () => AudioContext;

function resolveAudioContext(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  const candidate =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext;

  return candidate ?? null;
}

/**
 * Schedules one burst.
 *
 * Gain is ramped rather than switched, because an abrupt start or stop on a sine
 * wave produces an audible click.
 */
function scheduleBurst(
  context: AudioContext,
  startAt: number,
  frequency: number,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = frequency;

  const durationSeconds = BURST_MS / 1000;

  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(PEAK_GAIN, startAt + 0.02);
  gain.gain.setValueAtTime(PEAK_GAIN, startAt + durationSeconds - 0.04);
  gain.gain.linearRampToValueAtTime(0, startAt + durationSeconds);

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.start(startAt);
  oscillator.stop(startAt + durationSeconds);
}

/**
 * Rings for as long as `active` is true.
 *
 * Everything is torn down when it goes false or the component unmounts, so a
 * dismissed call cannot leave a tone playing.
 */
export function useRingtone(active: boolean): void {
  const handleRef = useRef<RingtoneHandle | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }

    const Ctor = resolveAudioContext();

    if (Ctor === null) {
      return;
    }

    let handle: RingtoneHandle;

    try {
      handle = { context: new Ctor(), timers: [], stopped: false };
    } catch {
      // Some environments refuse to construct a context at all.
      return;
    }

    handleRef.current = handle;

    const ring = () => {
      if (handle.stopped || handle.context.state !== "running") {
        return;
      }

      const now = handle.context.currentTime;
      scheduleBurst(handle.context, now, TONE_A);
      scheduleBurst(handle.context, now + (BURST_MS + GAP_MS) / 1000, TONE_B);
    };

    // `resume` is a promise because the browser may prompt or refuse. A rejection
    // is expected and simply means this call rings silently.
    void handle.context
      .resume()
      .then(() => {
        if (handle.stopped) {
          return;
        }

        ring();

        const repeat = window.setInterval(ring, CYCLE_MS);
        handle.timers.push(repeat);
      })
      .catch(() => undefined);

    return () => {
      handle.stopped = true;
      handle.timers.forEach((timer) => window.clearInterval(timer));
      handle.timers = [];
      // Closing releases the audio hardware; without it a long session
      // accumulates suspended contexts, and browsers cap how many may exist.
      void handle.context.close().catch(() => undefined);
      handleRef.current = null;
    };
  }, [active]);
}

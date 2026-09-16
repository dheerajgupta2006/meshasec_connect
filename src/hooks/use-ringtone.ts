"use client";

import { useEffect, useRef } from "react";

import { primeAudio, runningAudioContext } from "@/lib/audio-unlock";

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
  timers: number[];
  stopped: boolean;
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

    // Attempt a resume in case a gesture has happened since the last try. The
    // context itself is created during the user's first interaction by
    // `installAudioUnlock`, because permission is granted to the gesture rather
    // than to the page — a context created here, at ring time, would be refused.
    primeAudio();

    const handle: RingtoneHandle = { timers: [], stopped: false };
    handleRef.current = handle;

    const ring = () => {
      const context = runningAudioContext();

      if (handle.stopped || context === null) {
        return;
      }

      const now = context.currentTime;
      scheduleBurst(context, now, TONE_A);
      scheduleBurst(context, now + (BURST_MS + GAP_MS) / 1000, TONE_B);
    };

    ring();

    const repeat = window.setInterval(ring, CYCLE_MS);
    handle.timers.push(repeat);

    return () => {
      handle.stopped = true;
      handle.timers.forEach((timer) => window.clearInterval(timer));
      handle.timers = [];
      handleRef.current = null;
      // The context is shared and deliberately not closed: it stays unlocked for
      // the next call, and closing it would need another user gesture to reopen.
    };
  }, [active]);
}

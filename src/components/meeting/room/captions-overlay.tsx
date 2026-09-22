"use client";

/**
 * Live captions over the video, newest at the bottom.
 *
 * ## Why expiry lives here and not in the reducer
 *
 * `caption-state.ts` keeps a long transcript so a late joiner can catch up and so
 * the drawer could show history. How long a line stays *on screen* is a different
 * question, local to each viewer, and driven by a timer — neither of which belongs
 * in shared room state. So the buffer below is a view over that state rather than
 * a second copy of it.
 *
 * ## The rolling window
 *
 * At most three lines are shown, and each one expires seven seconds after it was
 * last *updated* rather than after it was created. That distinction matters:
 * interim results revise the same line continuously while someone is mid-sentence,
 * so measuring from creation would clear a caption out from under a speaker who is
 * still talking. Measuring from the last update means a line only ages once its
 * speaker has actually stopped, and the container empties itself when the room
 * falls quiet.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import * as React from "react";

import { directionFor, findLanguage } from "@/lib/i18n/languages";

import { useCaptions, type CaptionEntry } from "./captions-provider";

/** Lines held at once. More than this starts hiding the people talking. */
const VISIBLE_LINES = 3;

/** How long a line survives after its last update. */
const CAPTION_TTL_MS = 7000;

/**
 * Slack added to each expiry timer.
 *
 * Without it a timer can fire a millisecond early, find the line still just
 * inside its lifetime, and reschedule — a burst of wasted renders for nothing.
 */
const EXPIRY_GRACE_MS = 60;

function speakerNameFor(entry: CaptionEntry): string {
  if (entry.segment.speakerName.length > 0) {
    return entry.segment.speakerName;
  }

  return entry.isLocal ? "You" : "Someone";
}

function CaptionLine({ entry }: { entry: CaptionEntry }) {
  const { readLanguage } = useCaptions();
  const { segment, translation } = entry;

  // A translation leads when there is one, with the original supporting it.
  // Keeping the original visible is deliberate: recognition of code-mixed speech
  // is wrong often enough that a reader needs to see what was actually said, and
  // without it a mistranslation looks identical to a mis-hearing.
  const primary = translation ?? segment.text;
  const primaryLanguage =
    translation !== null ? readLanguage : segment.sourceLanguage;

  return (
    <div className="min-w-0">
      <p className="mb-0.5 flex items-baseline gap-2">
        {/* Accent colour and weight so it is instantly clear who is speaking,
            without the name competing with the caption itself for attention. */}
        <span className="truncate text-[12px] font-semibold tracking-wide text-sky-300">
          {speakerNameFor(entry)}
        </span>

        {!segment.isFinal && (
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-emerald-400/90">
            speaking
          </span>
        )}
      </p>

      {/* `lang` and `dir` so the browser shapes the script correctly and a screen
          reader switches voice rather than reading Telugu with an English one. */}
      <p
        lang={primaryLanguage ?? undefined}
        dir={
          primaryLanguage === null ? undefined : directionFor(primaryLanguage)
        }
        className="text-[15px] font-normal leading-[1.4] text-white"
      >
        {primary}
      </p>

      {translation !== null && (
        <p
          lang={segment.sourceLanguage}
          dir={directionFor(segment.sourceLanguage)}
          className="mt-1 text-[12px] leading-[1.4] text-white/55"
        >
          {findLanguage(segment.sourceLanguage).englishName}
          {/* Two hops compound their errors, so a pivoted caption says so rather
              than reading as confidently as a direct one. */}
          {entry.viaPivot && " via English"}: {segment.text}
        </p>
      )}
    </div>
  );
}

export function CaptionsOverlay() {
  const { entries } = useCaptions();
  const shouldReduceMotion = useReducedMotion() === true;

  /** Bumped by the expiry timer to force a re-evaluation of the window. */
  const [, setExpiryTick] = React.useState(0);

  const candidates = React.useMemo(
    () => entries.slice(-VISIBLE_LINES),
    [entries],
  );

  /**
   * Changes only when a line is added or actually revised.
   *
   * Used as the timer effect's dependency so a re-render that touched nothing
   * relevant does not tear down and rebuild the countdown.
   */
  const signature = candidates
    .map((entry) => `${entry.segment.id}:${entry.segment.updatedAt}`)
    .join("|");

  const now = Date.now();
  const visible = candidates.filter(
    (entry) => now - entry.segment.updatedAt < CAPTION_TTL_MS,
  );

  React.useEffect(() => {
    const deadlines = candidates
      .map((entry) => entry.segment.updatedAt + CAPTION_TTL_MS)
      // Only deadlines still ahead of us. Scheduling for one already past would
      // fire immediately, re-render, and schedule it again — a tight loop.
      .filter((deadline) => deadline > Date.now());

    if (deadlines.length === 0) {
      return;
    }

    // One timer for the soonest expiry rather than an interval, so a quiet call
    // costs nothing and each line disappears on time rather than on a tick.
    const delay = Math.min(...deadlines) - Date.now() + EXPIRY_GRACE_MS;

    const timer = window.setTimeout(() => {
      setExpiryTick((tick) => tick + 1);
    }, Math.max(0, delay));

    return () => window.clearTimeout(timer);
    // `signature` stands in for `candidates`, a fresh array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const transition = shouldReduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: "easeOut" as const };

  return (
    // Always mounted, so a line leaving can animate out rather than vanishing.
    // `pointer-events-none` so captions never swallow a click meant for a tile
    // underneath, and the bottom offset clears the control dock, which is pinned
    // to the bottom edge at a higher z-index.
    <div
      className="pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-center px-3 sm:bottom-32 sm:px-6"
      role="log"
      aria-live="polite"
      aria-label="Live captions"
    >
      <AnimatePresence initial={false}>
        {visible.length > 0 && (
          <motion.div
            key="caption-card"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={transition}
            // One card around every line rather than a card per line: a single
            // surface reads as part of the player instead of as debris scattered
            // over the video.
            //
            // `bg-black/65` and `backdrop-blur` are 0.65 alpha and an 8px blur;
            // `rounded-lg` is 8px; `px-4 py-3` is the 16px/12px inset.
            className="w-full max-w-2xl rounded-lg bg-black/65 px-4 py-3 shadow-lg shadow-black/30 ring-1 ring-white/10 backdrop-blur"
          >
            <motion.div layout={!shouldReduceMotion} className="space-y-2">
              <AnimatePresence initial={false} mode="popLayout">
                {visible.map((entry) => (
                  <motion.div
                    key={entry.segment.id}
                    layout={!shouldReduceMotion}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={transition}
                  >
                    <CaptionLine entry={entry} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

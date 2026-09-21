"use client";

/**
 * Caption text over the video, newest at the bottom.
 *
 * Shows the translation as the primary line and the original underneath it,
 * smaller. Keeping the original visible is deliberate: recognition of code-mixed
 * speech is wrong often enough that a reader needs to see what was actually said
 * when a caption makes no sense, and without it a mistranslation is
 * indistinguishable from a mis-hearing.
 *
 * Renders nothing at all when there is nothing to show, so it never occupies
 * space over the grid on a silent call.
 */

import * as React from "react";

import { directionFor, findLanguage } from "@/lib/i18n/languages";

import { useCaptions, type CaptionEntry } from "./captions-provider";

/** Most lines shown at once. Beyond this the overlay starts hiding the video. */
const VISIBLE_LINES = 3;

function CaptionLine({ entry }: { entry: CaptionEntry }) {
  const { segment, translation, isLocal } = entry;
  const { readLanguage } = useCaptions();

  const speaker =
    segment.speakerName.length > 0
      ? segment.speakerName
      : isLocal
        ? "You"
        : "Someone";

  // When a translation exists it leads and the original supports it. Otherwise
  // the original is all there is.
  const primary = translation ?? segment.text;
  const primaryLanguage = translation !== null ? readLanguage : segment.sourceLanguage;

  return (
    <div
      className={`rounded-lg bg-zinc-950/75 px-3 py-2 backdrop-blur-sm transition-opacity ${
        segment.isFinal ? "opacity-100" : "opacity-80"
      }`}
    >
      <p className="mb-0.5 flex items-baseline gap-2 text-[11px] font-medium text-zinc-400">
        <span className="truncate">{speaker}</span>
        {!segment.isFinal && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-emerald-400">
            speaking
          </span>
        )}
      </p>

      {/* `lang` and `dir` so the browser shapes the script correctly and a screen
          reader switches voice instead of reading Telugu with an English one. */}
      <p
        lang={primaryLanguage ?? undefined}
        dir={primaryLanguage === null ? undefined : directionFor(primaryLanguage)}
        className="text-sm leading-snug text-zinc-50 sm:text-base"
      >
        {primary}
      </p>

      {translation !== null && (
        <p
          lang={segment.sourceLanguage}
          dir={directionFor(segment.sourceLanguage)}
          className="mt-1 text-[11px] leading-snug text-zinc-400"
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

  // Only the tail is shown: a long transcript would cover the people talking.
  const visible = React.useMemo(
    () => entries.slice(-VISIBLE_LINES),
    [entries],
  );

  if (visible.length === 0) {
    return null;
  }

  return (
    <div
      // `pointer-events-none` so captions never intercept a click meant for the
      // video grid or a tile control underneath them.
      className="pointer-events-none absolute inset-x-0 bottom-24 z-20 flex justify-center px-3 sm:bottom-28 sm:px-6"
      role="log"
      aria-live="polite"
      aria-label="Live captions"
    >
      <div className="flex w-full max-w-2xl flex-col gap-1.5">
        {visible.map((entry) => (
          <CaptionLine key={entry.segment.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

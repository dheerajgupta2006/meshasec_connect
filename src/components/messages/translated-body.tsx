"use client";

/**
 * A message's translation, shown beneath the original rather than instead of it.
 *
 * Keeping both visible is the point. On-device translation of code-mixed Indic
 * text gets things wrong often enough that a reader needs to be able to check a
 * confusing line against what was actually sent, and the sender needs to see
 * their own words unaltered. Replacing the body would make a bad translation
 * indistinguishable from a bad message.
 */

import { Languages } from "lucide-react";

import {
  directionFor,
  findLanguage,
  type LanguageCode,
} from "@/lib/i18n/languages";

interface TranslatedBodyProps {
  text: string;
  /** Language the original was detected as, for the attribution line. */
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  outgoing: boolean;
}

export function TranslatedBody({
  text,
  sourceLanguage,
  targetLanguage,
  outgoing,
}: TranslatedBodyProps) {
  const direction = directionFor(targetLanguage);

  return (
    <div
      className={`mt-2 border-t pt-2 ${
        outgoing
          ? "border-primary-emphasis-foreground/25"
          : "border-foreground/15"
      }`}
    >
      <p
        className={`mb-0.5 flex items-center gap-1 text-[10px] ${
          outgoing
            ? "text-primary-emphasis-foreground/70"
            : "text-muted-foreground"
        }`}
      >
        <Languages className="h-3 w-3 shrink-0" aria-hidden />
        Translated from {findLanguage(sourceLanguage).englishName}
      </p>

      {/* `dir` and `lang` are set from the target language so the browser applies
          the right shaping and bidirectional layout, and so a screen reader
          switches voice instead of reading Telugu with an English one. */}
      <p
        dir={direction}
        lang={targetLanguage}
        className="whitespace-pre-wrap break-words text-sm"
      >
        {text}
      </p>
    </div>
  );
}

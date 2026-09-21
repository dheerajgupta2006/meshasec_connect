/**
 * Identifies which of the supported languages a piece of text is written in.
 *
 * Works by counting letters per writing system, not by understanding words. That
 * is exact for the current set because each enabled language uses a script none
 * of the others do: Telugu, Devanagari and Latin.
 *
 * ## The boundary this relies on, and when it breaks
 *
 * Script identifies a *language* here only because the enabled set happens to
 * hold one language per script. That stops being true the moment a second
 * Devanagari language is enabled — Marathi and Nepali both use it, and this
 * module would read them as Hindi. Sanskrit and Konkani are the same story.
 *
 * At that point the replacement is Chrome's `LanguageDetector` API, which is
 * on-device and free like the translator, and returns ranked candidates with
 * confidence scores. Swapping it in means making `detectLanguage` async; the
 * call sites already treat a null result as "do not translate", so the failure
 * mode does not change.
 *
 * Until then this is preferred because it is synchronous, needs no model
 * download, cannot fail, and is exactly right for English, Hindi and Telugu.
 *
 * Pure and dependency-free, so it runs identically on the server and the client.
 */

import { DEFAULT_LANGUAGE, type LanguageCode } from "@/lib/i18n/languages";

function isTeluguLetter(code: number): boolean {
  // Telugu block.
  return code >= 0x0c00 && code <= 0x0c7f;
}

function isDevanagariLetter(code: number): boolean {
  // Devanagari block, plus the Extended block used for rarer conjuncts.
  return (
    (code >= 0x0900 && code <= 0x097f) || (code >= 0xa8e0 && code <= 0xa8ff)
  );
}

function isLatinLetter(code: number): boolean {
  // Basic Latin letters, then the accented ranges. Digits and punctuation are
  // deliberately excluded: "2026!" is not evidence of any language.
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x00c0 && code <= 0x024f)
  );
}

export interface ScriptCounts {
  telugu: number;
  devanagari: number;
  latin: number;
}

/** Letters per script. Exported for tests and for diagnosing a misread line. */
export function countScripts(text: string): ScriptCounts {
  const counts: ScriptCounts = { telugu: 0, devanagari: 0, latin: 0 };

  // An index loop with `codePointAt` rather than `for...of`: this project's
  // tsconfig declares no `target`, and this also keeps surrogate pairs from
  // being counted as two characters.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index);

    if (code === undefined) {
      continue;
    }

    // Step over the low surrogate of an astral character.
    if (code > 0xffff) {
      index += 1;
    }

    if (isTeluguLetter(code)) {
      counts.telugu += 1;
    } else if (isDevanagariLetter(code)) {
      counts.devanagari += 1;
    } else if (isLatinLetter(code)) {
      counts.latin += 1;
    }
  }

  return counts;
}

/**
 * The language `text` appears to be written in, or null when there is nothing to
 * go on — an empty string, or only digits, emoji and punctuation.
 *
 * Null means "do not translate this", which is the right outcome for a message
 * like "👍" or "+91 98765 43210".
 */
export function detectLanguage(text: string): LanguageCode | null {
  const counts = countScripts(text);
  const total = counts.telugu + counts.devanagari + counts.latin;

  if (total === 0) {
    return null;
  }

  // An Indic script wins on *any* presence rather than on a majority.
  //
  // This asymmetry is deliberate. Bilingual chat is heavily code-mixed — a Telugu
  // speaker writes Telugu grammar with English nouns dropped in ("repu meeting
  // కి వస్తావా") — and in such a line the Latin letters frequently outnumber the
  // Telugu ones. Counting the scripts symmetrically would classify it as English
  // and leave it untranslated, which is exactly the message a Telugu reader most
  // needs translated. Latin is therefore the fallback, not a competitor.
  if (counts.telugu > 0 && counts.telugu >= counts.devanagari) {
    return "te";
  }

  if (counts.devanagari > 0) {
    return "hi";
  }

  return DEFAULT_LANGUAGE;
}

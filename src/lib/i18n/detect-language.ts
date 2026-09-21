/**
 * Identifies the writing system of a piece of text, and the language when the
 * script gives that away on its own.
 *
 * This is the *synchronous fallback* for language detection. It is exact for
 * scripts only one enabled language uses — Telugu, Tamil, Kannada, Bengali,
 * Thai, Hebrew, Arabic, Hangul — and deliberately gives up on the rest.
 *
 * Latin now covers ten of the catalog's languages, Devanagari covers Hindi and
 * Marathi, and Cyrillic covers Russian and Ukrainian. Characters alone cannot
 * separate those, so `detectLanguageByScript` returns null for them rather than
 * guessing. The real answer for those comes from Chrome's `LanguageDetector`
 * API, wrapped in `lib/translation/detector.ts`, which asks a model instead.
 *
 * The ambiguity is not hardcoded here: it is derived from the registry by
 * `soleLanguageForScript`, so enabling a second Devanagari language narrows this
 * module automatically instead of leaving it confidently wrong.
 *
 * Pure and dependency-free, so it runs identically on the server and the client.
 */

import {
  soleLanguageForScript,
  type LanguageCode,
  type ScriptName,
} from "@/lib/i18n/languages";

export type ScriptCounts = Record<ScriptName, number>;

function emptyCounts(): ScriptCounts {
  return {
    latin: 0,
    cyrillic: 0,
    devanagari: 0,
    bengali: 0,
    tamil: 0,
    telugu: 0,
    kannada: 0,
    arabic: 0,
    hebrew: 0,
    thai: 0,
    han: 0,
    japanese: 0,
    hangul: 0,
  };
}

/**
 * Classifies one code point, or null for anything that is not a letter.
 *
 * Digits, punctuation, spaces and emoji return null on purpose: "2026!" and "👍"
 * are not evidence of any language, and counting them would make a message of
 * pure punctuation look like whichever script happened to win a tie.
 */
function classify(code: number): ScriptName | null {
  // Basic Latin letters first: the overwhelmingly common case.
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
    return "latin";
  }

  // Latin-1 Supplement and Latin Extended-A/B, then Latin Extended Additional.
  // The latter matters for Vietnamese, whose diacritics live at 1E00-1EFF.
  if (
    (code >= 0x00c0 && code <= 0x024f) ||
    (code >= 0x1e00 && code <= 0x1eff)
  ) {
    return "latin";
  }

  if (code >= 0x0400 && code <= 0x052f) {
    return "cyrillic";
  }

  if (
    (code >= 0x0900 && code <= 0x097f) ||
    (code >= 0xa8e0 && code <= 0xa8ff)
  ) {
    return "devanagari";
  }

  if (code >= 0x0980 && code <= 0x09ff) {
    return "bengali";
  }

  if (code >= 0x0b80 && code <= 0x0bff) {
    return "tamil";
  }

  if (code >= 0x0c00 && code <= 0x0c7f) {
    return "telugu";
  }

  if (code >= 0x0c80 && code <= 0x0cff) {
    return "kannada";
  }

  if (code >= 0x0590 && code <= 0x05ff) {
    return "hebrew";
  }

  if (
    (code >= 0x0600 && code <= 0x06ff) ||
    (code >= 0x0750 && code <= 0x077f) ||
    (code >= 0x08a0 && code <= 0x08ff) ||
    (code >= 0xfb50 && code <= 0xfdff) ||
    (code >= 0xfe70 && code <= 0xfeff)
  ) {
    return "arabic";
  }

  if (code >= 0x0e00 && code <= 0x0e7f) {
    return "thai";
  }

  // Kana. Counted separately from Han because it is what separates Japanese from
  // Chinese: both use Han characters, only Japanese uses kana.
  if (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x31f0 && code <= 0x31ff) ||
    (code >= 0xff66 && code <= 0xff9d)
  ) {
    return "japanese";
  }

  // Hangul syllables, Jamo and compatibility Jamo.
  if (
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3130 && code <= 0x318f)
  ) {
    return "hangul";
  }

  if (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  ) {
    return "han";
  }

  return null;
}

/** Letters per script. Exported for tests and for diagnosing a misread line. */
export function countScripts(text: string): ScriptCounts {
  const counts = emptyCounts();

  // An index loop with `codePointAt` rather than `for...of`: this project's
  // tsconfig declares no `target`, and this also keeps a surrogate pair from
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

    const script = classify(code);

    if (script !== null) {
      counts[script] += 1;
    }
  }

  return counts;
}

/**
 * Scripts that settle the matter on their own presence, in priority order.
 *
 * Kana first: Japanese text is a mix of kana and Han, so seeing any kana means
 * Japanese, whereas seeing Han means Chinese only if no kana appeared. Hangul
 * next for the same reason — Korean can carry Han characters too.
 */
const DECISIVE_SCRIPTS: readonly ScriptName[] = ["japanese", "hangul", "han"];

/**
 * Scripts that win over Latin on any presence at all.
 *
 * The asymmetry against Latin is deliberate. Bilingual chat is heavily
 * code-mixed — a Telugu speaker writes Telugu grammar with English nouns dropped
 * in ("repu meeting కి వస్తావా") — and the Latin letters frequently outnumber the
 * Telugu ones in such a line. Treating the scripts symmetrically would classify
 * it as English and leave it untranslated, which is exactly the message its
 * reader most needs translated. Latin is therefore the fallback, not a rival.
 */
const NON_LATIN_SCRIPTS: readonly ScriptName[] = [
  "devanagari",
  "telugu",
  "tamil",
  "kannada",
  "bengali",
  "arabic",
  "hebrew",
  "thai",
  "cyrillic",
];

/**
 * The writing system `text` is in, or null when it holds no letters at all.
 *
 * Null is the right answer for "👍" or "+91 98765 43210": there is nothing to
 * translate and nothing to go on.
 */
export function detectScript(text: string): ScriptName | null {
  const counts = countScripts(text);

  for (const script of DECISIVE_SCRIPTS) {
    if (counts[script] > 0) {
      return script;
    }
  }

  // Highest count among the non-Latin scripts, so a line mixing two Indic
  // scripts resolves to the dominant one rather than to declaration order.
  let best: ScriptName | null = null;
  let bestCount = 0;

  for (const script of NON_LATIN_SCRIPTS) {
    if (counts[script] > bestCount) {
      best = script;
      bestCount = counts[script];
    }
  }

  if (best !== null) {
    return best;
  }

  return counts.latin > 0 ? "latin" : null;
}

/**
 * The language `text` is written in, when the script alone proves it.
 *
 * Null means one of three things, all of which callers should treat the same way
 * — ask `lib/translation/detector.ts` instead:
 *
 *  - the text holds no letters,
 *  - the script is shared by several enabled languages (Latin, Devanagari,
 *    Cyrillic in the current catalog),
 *  - the script is not used by any enabled language.
 */
export function detectLanguageByScript(text: string): LanguageCode | null {
  const script = detectScript(text);

  if (script === null) {
    return null;
  }

  return soleLanguageForScript(script);
}

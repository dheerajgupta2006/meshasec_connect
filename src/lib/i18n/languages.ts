/**
 * The languages this app can translate between.
 *
 * Translation runs on-device through Chrome's built-in Translator API (see
 * `lib/translation/on-device.ts`), so this list is bounded by what that API
 * supports, not by what a cloud translator could do. Every entry here is a pair
 * the browser can actually serve.
 *
 * Pure and dependency-free: imported by both browser and server code, so it must
 * not reach for `window` or any Node built-in.
 *
 * ## Not available on-device
 *
 * Four languages that belong in this catalog are missing because Chrome's
 * translator has no pack for them: **Gujarati (`gu`), Malayalam (`ml`), Punjabi
 * (`pa`) and Swahili (`sw`)**. Adding them means adding a cloud engine and
 * leaving the zero-cost design, so they are deliberately absent rather than
 * listed and broken.
 *
 * ## Adding a language
 *
 * Append an entry. `LanguageCode` and every exhaustiveness check widen
 * automatically. Four fields have to be right:
 *
 *  1. `code` — the BCP 47 short code the Translator API expects (`hi`, not
 *     `hi-IN`).
 *  2. `speechLocale` — the *regional* tag speech recognition wants (`hi-IN`).
 *     These are deliberately separate: the translator rejects a regional tag and
 *     `SpeechRecognition` does badly without one.
 *  3. `script` — drives the synchronous detection fallback in
 *     `detect-language.ts`. Adding a second language in an existing script makes
 *     that script ambiguous, which that module detects and handles on its own.
 *  4. `direction` — `"rtl"` for Arabic, Hebrew, Persian and Urdu.
 */

export type TextDirection = "ltr" | "rtl";

/**
 * Writing system, used to identify a language from its characters alone.
 *
 * Coarser than Unicode's script property on purpose: `japanese` means "contains
 * kana", which is what actually separates Japanese from Chinese, since both draw
 * on Han characters.
 */
export type ScriptName =
  | "latin"
  | "cyrillic"
  | "devanagari"
  | "bengali"
  | "tamil"
  | "telugu"
  | "kannada"
  | "arabic"
  | "hebrew"
  | "thai"
  | "han"
  | "japanese"
  | "hangul";

export interface Language {
  /** BCP 47 short code, as passed to the Translator API. */
  code: string;
  /** Name in English, for building accessible labels. */
  englishName: string;
  /** Name in the language itself, which is what a speaker of it looks for. */
  nativeName: string;
  /** Regional tag for `SpeechRecognition.lang`. */
  speechLocale: string;
  script: ScriptName;
  direction: TextDirection;
}

/**
 * Ordered by how likely they are to be wanted in this app: English first, then
 * the Indian languages it is aimed at, then the rest roughly by speaker count.
 *
 * `en-IN` rather than `en-US` for English speech, because the accent this app's
 * users actually speak is the one recognition should expect.
 */
export const SUPPORTED_LANGUAGES = [
  {
    code: "en",
    englishName: "English",
    nativeName: "English",
    speechLocale: "en-IN",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "hi",
    englishName: "Hindi",
    nativeName: "हिन्दी",
    speechLocale: "hi-IN",
    script: "devanagari",
    direction: "ltr",
  },
  {
    code: "te",
    englishName: "Telugu",
    nativeName: "తెలుగు",
    speechLocale: "te-IN",
    script: "telugu",
    direction: "ltr",
  },
  {
    code: "ta",
    englishName: "Tamil",
    nativeName: "தமிழ்",
    speechLocale: "ta-IN",
    script: "tamil",
    direction: "ltr",
  },
  {
    code: "kn",
    englishName: "Kannada",
    nativeName: "ಕನ್ನಡ",
    speechLocale: "kn-IN",
    script: "kannada",
    direction: "ltr",
  },
  {
    code: "bn",
    englishName: "Bengali",
    nativeName: "বাংলা",
    speechLocale: "bn-IN",
    script: "bengali",
    direction: "ltr",
  },
  {
    code: "mr",
    englishName: "Marathi",
    nativeName: "मराठी",
    speechLocale: "mr-IN",
    script: "devanagari",
    direction: "ltr",
  },
  {
    code: "es",
    englishName: "Spanish",
    nativeName: "Español",
    speechLocale: "es-ES",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "zh",
    englishName: "Chinese",
    nativeName: "中文",
    speechLocale: "zh-CN",
    script: "han",
    direction: "ltr",
  },
  {
    code: "ar",
    englishName: "Arabic",
    nativeName: "العربية",
    speechLocale: "ar-SA",
    script: "arabic",
    direction: "rtl",
  },
  {
    code: "fr",
    englishName: "French",
    nativeName: "Français",
    speechLocale: "fr-FR",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "pt",
    englishName: "Portuguese",
    nativeName: "Português",
    speechLocale: "pt-BR",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "ru",
    englishName: "Russian",
    nativeName: "Русский",
    speechLocale: "ru-RU",
    script: "cyrillic",
    direction: "ltr",
  },
  {
    code: "de",
    englishName: "German",
    nativeName: "Deutsch",
    speechLocale: "de-DE",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "ja",
    englishName: "Japanese",
    nativeName: "日本語",
    speechLocale: "ja-JP",
    script: "japanese",
    direction: "ltr",
  },
  {
    code: "ko",
    englishName: "Korean",
    nativeName: "한국어",
    speechLocale: "ko-KR",
    script: "hangul",
    direction: "ltr",
  },
  {
    code: "it",
    englishName: "Italian",
    nativeName: "Italiano",
    speechLocale: "it-IT",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "vi",
    englishName: "Vietnamese",
    nativeName: "Tiếng Việt",
    speechLocale: "vi-VN",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "th",
    englishName: "Thai",
    nativeName: "ไทย",
    speechLocale: "th-TH",
    script: "thai",
    direction: "ltr",
  },
  {
    code: "id",
    englishName: "Indonesian",
    nativeName: "Bahasa Indonesia",
    speechLocale: "id-ID",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "nl",
    englishName: "Dutch",
    nativeName: "Nederlands",
    speechLocale: "nl-NL",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "pl",
    englishName: "Polish",
    nativeName: "Polski",
    speechLocale: "pl-PL",
    script: "latin",
    direction: "ltr",
  },
  {
    code: "uk",
    englishName: "Ukrainian",
    nativeName: "Українська",
    speechLocale: "uk-UA",
    script: "cyrillic",
    direction: "ltr",
  },
  {
    code: "he",
    englishName: "Hebrew",
    nativeName: "עברית",
    speechLocale: "he-IL",
    script: "hebrew",
    direction: "rtl",
  },
  {
    code: "sv",
    englishName: "Swedish",
    nativeName: "Svenska",
    speechLocale: "sv-SE",
    script: "latin",
    direction: "ltr",
  },
] as const satisfies readonly Language[];

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

/**
 * The language a reader falls back to when they have expressed no preference.
 *
 * Only the initial position of the picker. Translation stays off until someone
 * chooses, so this is never an implicit decision to translate.
 */
export const DEFAULT_LANGUAGE: LanguageCode = "en";

// The callback return type is annotated so the entries are tuples rather than
// `(string | Language)[]`, which the Map constructor would reject.
const BY_CODE = new Map<string, Language>(
  SUPPORTED_LANGUAGES.map((language): [string, Language] => [
    language.code,
    language,
  ]),
);

/**
 * Narrows an untrusted value to a supported code.
 *
 * Needed because a reader's choice is round-tripped through `localStorage` and a
 * speaker's choice arrives over the LiveKit data channel, so neither can be
 * assumed to hold a code this build knows about.
 */
export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && BY_CODE.has(value);
}

/** The full record for a code. Throws only on a code outside the union. */
export function findLanguage(code: LanguageCode): Language {
  const language = BY_CODE.get(code);

  if (language === undefined) {
    throw new Error(`Unknown language code: ${code}`);
  }

  return language;
}

/** Reading direction, for the `dir` attribute on rendered text. */
export function directionFor(code: LanguageCode): TextDirection {
  return findLanguage(code).direction;
}

/** Regional tag for `SpeechRecognition.lang`. */
export function speechLocaleFor(code: LanguageCode): string {
  return findLanguage(code).speechLocale;
}

/**
 * Label for a picker: native name first, English name after when they differ.
 *
 * "हिन्दी (Hindi)" rather than "Hindi", so a Hindi speaker scanning a list of
 * twenty-five recognises their own language before having to read English.
 */
export function languageLabel(code: LanguageCode): string {
  const language = findLanguage(code);

  if (language.nativeName === language.englishName) {
    return language.englishName;
  }

  return `${language.nativeName} (${language.englishName})`;
}

/**
 * Codes that are the only enabled language using their script.
 *
 * Derived rather than hardcoded, so enabling a second Devanagari or Cyrillic
 * language removes the affected entries automatically instead of leaving
 * `detect-language.ts` confidently wrong.
 */
const UNAMBIGUOUS_BY_SCRIPT = (() => {
  const counts = new Map<ScriptName, number>();

  SUPPORTED_LANGUAGES.forEach((language) => {
    counts.set(language.script, (counts.get(language.script) ?? 0) + 1);
  });

  const result = new Map<ScriptName, LanguageCode>();

  SUPPORTED_LANGUAGES.forEach((language) => {
    if (counts.get(language.script) === 1) {
      result.set(language.script, language.code);
    }
  });

  return result;
})();

/**
 * The single language written in `script`, or null when more than one enabled
 * language shares it.
 *
 * Null is the honest answer for Latin, Devanagari and Cyrillic in the current
 * set: the characters alone cannot separate English from Spanish, or Hindi from
 * Marathi. Callers should treat null as "ask a real detector".
 */
export function soleLanguageForScript(script: ScriptName): LanguageCode | null {
  return UNAMBIGUOUS_BY_SCRIPT.get(script) ?? null;
}

/**
 * A translation direction.
 *
 * A type rather than two loose arguments because the pair is the cache key, the
 * availability key and the translator-instance key — three places where silently
 * swapping source and target would be an easy and near-invisible bug.
 */
export interface LanguagePair {
  source: LanguageCode;
  target: LanguageCode;
}

/** True when translating this pair would be a no-op. */
export function isSamePair(pair: LanguagePair): boolean {
  return pair.source === pair.target;
}

/**
 * Stable string form of a pair, for use as a `Map` key.
 *
 * `>` is safe as a separator because it cannot appear in a BCP 47 code.
 */
export function pairKey(pair: LanguagePair): string {
  return `${pair.source}>${pair.target}`;
}

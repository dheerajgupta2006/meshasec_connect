/**
 * The languages this app can translate between.
 *
 * Deliberately a small, explicit list rather than every language a translation
 * engine claims to handle. Translation runs on-device (see
 * `lib/translation/on-device.ts`), and each language a user actually selects
 * costs them a language-pack download, so an honest short list beats a long one
 * where most entries would stall on first use.
 *
 * Pure and dependency-free: this is imported by both browser and server code, so
 * it must not reach for `window` or any Node built-in.
 *
 * ## Adding a language
 *
 * Append an entry below. `LanguageCode` and every exhaustiveness check widen
 * automatically. Two things to get right:
 *
 *  1. `code` must be the BCP 47 short code the Translator API expects (`hi`, not
 *     `hi-IN`). Speech recognition wants the *regional* form instead, so when
 *     live captions land they need a separate `speechLocale` field rather than a
 *     reuse of this one.
 *  2. `direction` must be `"rtl"` for Arabic, Hebrew, Persian and Urdu. It is
 *     carried from the start precisely so adding one of those later is a
 *     one-line change instead of an audit of every render site.
 *
 * Chrome's on-device Translator covers 38 codes. Of the wider language set this
 * app is aiming at, four are *not* available on-device and will need a different
 * engine when their turn comes: Gujarati (`gu`), Malayalam (`ml`), Punjabi
 * (`pa`) and Swahili (`sw`).
 */

export type TextDirection = "ltr" | "rtl";

export interface Language {
  /** BCP 47 short code, as passed to the Translator API. */
  code: string;
  /** Name in English, for building accessible labels. */
  englishName: string;
  /** Name in the language itself, which is what a speaker of it looks for. */
  nativeName: string;
  direction: TextDirection;
}

/**
 * Ordered for display, with English first because it is the pivot most of these
 * pairs travel through and the likeliest default.
 */
export const SUPPORTED_LANGUAGES = [
  {
    code: "en",
    englishName: "English",
    nativeName: "English",
    direction: "ltr",
  },
  {
    code: "hi",
    englishName: "Hindi",
    nativeName: "हिन्दी",
    direction: "ltr",
  },
  {
    code: "te",
    englishName: "Telugu",
    nativeName: "తెలుగు",
    direction: "ltr",
  },
] as const satisfies readonly Language[];

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

/**
 * The language a thread falls back to when the reader has expressed no
 * preference. Translation stays off until someone chooses, so this is only the
 * initial position of the picker, never an implicit decision to translate.
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
 * Needed because the reader's choice is round-tripped through `localStorage`,
 * which can hold anything a previous version of the app — or the user — put
 * there.
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

/** Reading direction for a code, for the `dir` attribute on rendered text. */
export function directionFor(code: LanguageCode): TextDirection {
  return findLanguage(code).direction;
}

/**
 * Label for a picker: native name first, English name after when they differ.
 *
 * "हिन्दी (Hindi)" rather than "Hindi", so a Hindi speaker scanning the list
 * recognises their own language before they have to read English to find it.
 */
export function languageLabel(code: LanguageCode): string {
  const language = findLanguage(code);

  if (language.nativeName === language.englishName) {
    return language.englishName;
  }

  return `${language.nativeName} (${language.englishName})`;
}

/**
 * A translation direction.
 *
 * Kept as a type rather than two loose arguments because the pair is the cache
 * key, the availability key and the engine-instance key — three places where
 * silently swapping source and target would be an easy and near-invisible bug.
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

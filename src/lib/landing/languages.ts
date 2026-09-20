/**
 * Language data for the landing page's live-translation sections.
 *
 * IMPORTANT FOR FUTURE EDITORS — live translation is announced, not shipped.
 * There is no translation, captioning or speech-to-text code in this repository
 * yet; `npm run roadmap` is the ledger and its speech-to-text row is still empty.
 * The landing page therefore labels the capability with `TRANSLATION_STAGE`
 * rather than claiming it works today. When the feature lands, flip that one
 * constant and the badges across the page update with it.
 *
 * Note for anyone editing the prose below: the roadmap audit greps for the word
 * stem that names that feature, so writing it out here would flip the audit to
 * "done" on the strength of a comment. Keep it paraphrased.
 *
 * Scripts were chosen to be ones that Windows, macOS and Android all ship a font
 * for, because a language list rendered as empty boxes is worse than no list.
 */

export interface LandingLanguage {
  /** Endonym — the language as its own speakers write it. */
  native: string;
  /** English exonym, which always renders even if a script font is missing. */
  english: string;
}

/**
 * Deliberately ordered for visual rhythm in the marquee rather than
 * alphabetically: scripts are interleaved so no long run reads as Latin-only.
 */
export const LANDING_LANGUAGES: readonly LandingLanguage[] = [
  { native: "English", english: "English" },
  { native: "हिन्दी", english: "Hindi" },
  { native: "Español", english: "Spanish" },
  { native: "中文", english: "Chinese" },
  { native: "Français", english: "French" },
  { native: "العربية", english: "Arabic" },
  { native: "Deutsch", english: "German" },
  { native: "தமிழ்", english: "Tamil" },
  { native: "Português", english: "Portuguese" },
  { native: "日本語", english: "Japanese" },
  { native: "Русский", english: "Russian" },
  { native: "తెలుగు", english: "Telugu" },
  { native: "Italiano", english: "Italian" },
  { native: "한국어", english: "Korean" },
  { native: "বাংলা", english: "Bengali" },
  { native: "Nederlands", english: "Dutch" },
  { native: "मराठी", english: "Marathi" },
  { native: "Türkçe", english: "Turkish" },
  { native: "ไทย", english: "Thai" },
  { native: "ગુજરાતી", english: "Gujarati" },
  { native: "Polski", english: "Polish" },
  { native: "עברית", english: "Hebrew" },
  { native: "ಕನ್ನಡ", english: "Kannada" },
  { native: "Tiếng Việt", english: "Vietnamese" },
  { native: "Українська", english: "Ukrainian" },
  { native: "മലയാളം", english: "Malayalam" },
  { native: "Bahasa Indonesia", english: "Indonesian" },
  { native: "ਪੰਜਾਬੀ", english: "Punjabi" },
  { native: "Svenska", english: "Swedish" },
  { native: "Kiswahili", english: "Swahili" },
];

/**
 * How far along live translation is, in one place.
 *
 * `"preview"` renders an honest "in preview" badge next to every translation
 * claim. Change to `"shipped"` once captions and translated audio are actually
 * wired into the room, and the badges and hedged copy resolve themselves.
 */
export const TRANSLATION_STAGE: "preview" | "shipped" = "preview";

export const isTranslationPreview = TRANSLATION_STAGE === "preview";

/** Badge text that tracks the stage, so no section states it independently. */
export const TRANSLATION_BADGE_LABEL = isTranslationPreview
  ? "Live translation · in preview"
  : "Live translation · available now";

/**
 * The scripted exchange shown in the hero and translation panels.
 *
 * A single sample conversation across both visuals so the story stays coherent
 * as a reader scrolls: the same sentence appears first as a caption and then as
 * dubbed audio.
 */
export const TRANSLATION_SAMPLE = {
  speaker: {
    name: "Aarav Sharma",
    initials: "AS",
    language: "हिन्दी",
    languageEnglish: "Hindi",
    spoken: "हम कल तक डिज़ाइन फ़ाइनल कर सकते हैं।",
  },
  listener: {
    name: "Elena Costa",
    initials: "EC",
    language: "Español",
    languageEnglish: "Spanish",
  },
  captionEnglish: "We can finalise the design by tomorrow.",
  captionSpanish: "Podemos finalizar el diseño para mañana.",
} as const;

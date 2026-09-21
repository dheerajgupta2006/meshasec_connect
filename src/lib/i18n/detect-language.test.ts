import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { countScripts, detectLanguage } from "@/lib/i18n/detect-language";
import { SUPPORTED_LANGUAGES, isLanguageCode } from "@/lib/i18n/languages";

describe("countScripts", () => {
  it("counts letters and ignores digits, spaces and punctuation", () => {
    expect(countScripts("Hi! 42?")).toEqual({
      telugu: 0,
      devanagari: 0,
      latin: 2,
    });
  });

  it("counts each script separately in mixed text", () => {
    const counts = countScripts("ok సరే");

    expect(counts.latin).toBe(2);
    expect(counts.telugu).toBeGreaterThan(0);
    expect(counts.devanagari).toBe(0);
  });

  it("returns zeroes for text with no letters at all", () => {
    expect(countScripts("👍 123 ... +91")).toEqual({
      telugu: 0,
      devanagari: 0,
      latin: 0,
    });
  });

  it("does not count an emoji as two characters", () => {
    // Astral characters occupy two UTF-16 units; the low surrogate must be
    // stepped over rather than classified on its own.
    expect(countScripts("😀😀")).toEqual({
      telugu: 0,
      devanagari: 0,
      latin: 0,
    });
  });
});

describe("detectLanguage", () => {
  it("reads Latin text as English", () => {
    expect(detectLanguage("Are we still on for tomorrow?")).toBe("en");
  });

  it("reads Telugu script as Telugu", () => {
    expect(detectLanguage("రేపు కలుద్దాం")).toBe("te");
  });

  it("reads Devanagari as Hindi", () => {
    expect(detectLanguage("कल मिलते हैं")).toBe("hi");
  });

  it("returns null when there is nothing to go on", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("   ")).toBeNull();
    expect(detectLanguage("👍")).toBeNull();
    expect(detectLanguage("+91 98765 43210")).toBeNull();
    expect(detectLanguage("2026!")).toBeNull();
  });

  it("classifies code-mixed Telugu as Telugu, not English", () => {
    // "Tenglish" is how bilingual friends actually write. The English nouns
    // outnumbering the Telugu letters must not flip the result, because the
    // reader who asked for Telugu still needs this translated.
    expect(detectLanguage("repu meeting కి వస్తావా")).toBe("te");
    expect(detectLanguage("ఆ file ని share చెయ్యి please")).toBe("te");
  });

  it("classifies code-mixed Hindi as Hindi, not English", () => {
    expect(detectLanguage("kal का meeting cancel है")).toBe("hi");
  });

  it("prefers Telugu when both Indic scripts appear", () => {
    const text = "కల कल";

    // Documents the tie-break rather than asserting it is the only sane choice:
    // a line in two Indic scripts is already outside what this can resolve.
    expect(detectLanguage(text)).toBe("te");
  });

  it("treats accented Latin as English", () => {
    expect(detectLanguage("café résumé")).toBe("en");
  });

  it("always returns a supported code or null", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = detectLanguage(text);

        return result === null || isLanguageCode(result);
      }),
    );
  });

  it("never throws on arbitrary unicode", () => {
    fc.assert(
      // `binary` spans the full code-point range, astral characters included.
      // (`fullUnicodeString` was removed in fast-check 4.)
      fc.property(fc.string({ unit: "binary" }), (text) => {
        detectLanguage(text);
        return true;
      }),
    );
  });

  it("can identify every supported language from its own native name", () => {
    // The native names are real text in their own scripts, so each one should
    // round-trip to its own code. English is Latin, so it anchors the fallback.
    SUPPORTED_LANGUAGES.forEach((language) => {
      expect(detectLanguage(language.nativeName)).toBe(language.code);
    });
  });
});

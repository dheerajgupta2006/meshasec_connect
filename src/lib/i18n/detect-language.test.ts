import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  countScripts,
  detectLanguageByScript,
  detectScript,
} from "@/lib/i18n/detect-language";
import {
  SUPPORTED_LANGUAGES,
  isLanguageCode,
  soleLanguageForScript,
} from "@/lib/i18n/languages";

describe("countScripts", () => {
  it("counts letters and ignores digits, spaces and punctuation", () => {
    const counts = countScripts("Hi! 42?");

    expect(counts.latin).toBe(2);
    expect(counts.devanagari).toBe(0);
  });

  it("counts each script separately in mixed text", () => {
    const counts = countScripts("ok సరే");

    expect(counts.latin).toBe(2);
    expect(counts.telugu).toBeGreaterThan(0);
    expect(counts.devanagari).toBe(0);
  });

  it("returns all zeroes for text with no letters", () => {
    const counts = countScripts("👍 123 ... +91");

    Object.values(counts).forEach((count) => expect(count).toBe(0));
  });

  it("does not count an emoji as two characters", () => {
    // Astral characters occupy two UTF-16 units; the low surrogate must be
    // stepped over rather than classified on its own.
    const counts = countScripts("😀😀");

    Object.values(counts).forEach((count) => expect(count).toBe(0));
  });

  it("counts Vietnamese diacritics as Latin", () => {
    // Vietnamese lives partly at 1E00-1EFF, outside the Latin-1 range.
    expect(countScripts("Tiếng Việt").latin).toBe(9);
  });

  it("counts kana separately from Han", () => {
    const counts = countScripts("日本語です");

    expect(counts.han).toBeGreaterThan(0);
    expect(counts.japanese).toBeGreaterThan(0);
  });
});

describe("detectScript", () => {
  it("identifies scripts unique to one language", () => {
    expect(detectScript("రేపు కలుద్దాం")).toBe("telugu");
    expect(detectScript("வணக்கம்")).toBe("tamil");
    expect(detectScript("ನಮಸ್ಕಾರ")).toBe("kannada");
    expect(detectScript("নমস্কার")).toBe("bengali");
    expect(detectScript("สวัสดี")).toBe("thai");
    expect(detectScript("안녕하세요")).toBe("hangul");
    expect(detectScript("שלום")).toBe("hebrew");
    expect(detectScript("مرحبا")).toBe("arabic");
  });

  it("identifies shared scripts as the script, not a language", () => {
    expect(detectScript("Hello there")).toBe("latin");
    expect(detectScript("कल मिलते हैं")).toBe("devanagari");
    expect(detectScript("Привет")).toBe("cyrillic");
  });

  it("separates Japanese from Chinese by the presence of kana", () => {
    // Both draw on Han characters; only Japanese uses kana, so kana decides.
    expect(detectScript("日本語です")).toBe("japanese");
    expect(detectScript("你好世界")).toBe("han");
  });

  it("returns null when there are no letters", () => {
    expect(detectScript("")).toBeNull();
    expect(detectScript("   ")).toBeNull();
    expect(detectScript("👍")).toBeNull();
    expect(detectScript("+91 98765 43210")).toBeNull();
    expect(detectScript("2026!")).toBeNull();
  });

  it("prefers a non-Latin script over Latin in code-mixed text", () => {
    // The English nouns outnumber the Indic letters here. Counting the scripts
    // symmetrically would call this English and leave it untranslated, which is
    // exactly the line its reader most needs translated.
    expect(detectScript("repu meeting కి వస్తావా")).toBe("telugu");
    expect(detectScript("ఆ file ని share చెయ్యి please")).toBe("telugu");
    expect(detectScript("kal का meeting cancel है")).toBe("devanagari");
  });

  it("picks the dominant script when two Indic scripts appear", () => {
    expect(detectScript("కలుద్దాం कल")).toBe("telugu");
    expect(detectScript("कल मिलते हैं కల")).toBe("devanagari");
  });
});

describe("detectLanguageByScript", () => {
  it("resolves languages whose script only they use", () => {
    expect(detectLanguageByScript("రేపు కలుద్దాం")).toBe("te");
    expect(detectLanguageByScript("வணக்கம்")).toBe("ta");
    expect(detectLanguageByScript("ನಮಸ್ಕಾರ")).toBe("kn");
    expect(detectLanguageByScript("নমস্কার")).toBe("bn");
    expect(detectLanguageByScript("สวัสดี")).toBe("th");
    expect(detectLanguageByScript("안녕하세요")).toBe("ko");
    expect(detectLanguageByScript("שלום")).toBe("he");
    expect(detectLanguageByScript("مرحبا")).toBe("ar");
    expect(detectLanguageByScript("你好世界")).toBe("zh");
    expect(detectLanguageByScript("日本語です")).toBe("ja");
  });

  it("refuses to guess when a script covers several languages", () => {
    // Devanagari is Hindi and Marathi; Latin is ten languages; Cyrillic is
    // Russian and Ukrainian. Null sends the caller to the model instead.
    expect(detectLanguageByScript("कल मिलते हैं")).toBeNull();
    expect(detectLanguageByScript("Hello there")).toBeNull();
    expect(detectLanguageByScript("Привет")).toBeNull();
  });

  it("returns null when there is nothing to go on", () => {
    expect(detectLanguageByScript("")).toBeNull();
    expect(detectLanguageByScript("👍")).toBeNull();
  });

  it("still resolves code-mixed Telugu, which is the common real case", () => {
    expect(detectLanguageByScript("repu meeting కి వస్తావా")).toBe("te");
  });

  it("reads Japanese written without kana as Chinese", () => {
    // A real and unavoidable limitation. "日本語" is pure kanji, and kanji are Han
    // characters, so by script alone this is indistinguishable from Chinese —
    // Han is the only evidence present and Chinese is the language that owns it.
    //
    // It matters little in practice because running Japanese prose almost always
    // carries kana for particles and inflection, which is decisive. The model in
    // `lib/translation/detector.ts` is what resolves the kanji-only case.
    expect(detectLanguageByScript("日本語")).toBe("zh");
    expect(detectLanguageByScript("日本語です")).toBe("ja");
  });

  it("agrees with the registry about which scripts it can resolve", () => {
    SUPPORTED_LANGUAGES.forEach((language) => {
      // Japanese is excluded: its native name is kanji-only, so it is covered by
      // the dedicated test above rather than by this round-trip.
      if (language.code === "ja") {
        return;
      }

      const resolvable = soleLanguageForScript(language.script) !== null;
      const detected = detectLanguageByScript(language.nativeName);

      if (resolvable) {
        expect(detected).toBe(language.code);
      } else {
        expect(detected).toBeNull();
      }
    });
  });

  it("always returns a supported code or null", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = detectLanguageByScript(text);

        return result === null || isLanguageCode(result);
      }),
    );
  });

  it("never throws on arbitrary unicode", () => {
    fc.assert(
      // `binary` spans the full code-point range, astral characters included.
      // (`fullUnicodeString` was removed in fast-check 4.)
      fc.property(fc.string({ unit: "binary" }), (text) => {
        detectLanguageByScript(text);
        return true;
      }),
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  directionFor,
  findLanguage,
  isLanguageCode,
  isSamePair,
  languageLabel,
  pairKey,
  soleLanguageForScript,
  speechLocaleFor,
  type LanguageCode,
} from "@/lib/i18n/languages";

/** Codes Chrome's on-device Translator API has no pack for. */
const NOT_AVAILABLE_ON_DEVICE = ["gu", "ml", "pa", "sw"];

describe("SUPPORTED_LANGUAGES", () => {
  it("covers the catalog", () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(25);
  });

  it("includes the languages this app is aimed at", () => {
    const codes = SUPPORTED_LANGUAGES.map((language) => language.code);

    ["en", "hi", "te", "ta", "kn", "bn", "mr"].forEach((code) => {
      expect(codes).toContain(code);
    });
  });

  it("omits the four languages the on-device translator cannot serve", () => {
    // Listing these would render a picker entry that always fails. They are
    // absent by design, not by oversight.
    const codes: readonly string[] = SUPPORTED_LANGUAGES.map(
      (language) => language.code,
    );

    NOT_AVAILABLE_ON_DEVICE.forEach((code) => {
      expect(codes).not.toContain(code);
    });
  });

  it("uses bare BCP 47 codes, which is what the translator accepts", () => {
    SUPPORTED_LANGUAGES.forEach((language) => {
      expect(language.code).not.toContain("-");
    });
  });

  it("uses regional tags for speech, which is what recognition needs", () => {
    SUPPORTED_LANGUAGES.forEach((language) => {
      expect(language.speechLocale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect(language.speechLocale.startsWith(`${language.code}-`)).toBe(true);
    });
  });

  it("has no duplicate codes", () => {
    const codes = SUPPORTED_LANGUAGES.map((language) => language.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it("has no duplicate native names", () => {
    const names = SUPPORTED_LANGUAGES.map((language) => language.nativeName);

    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every language non-empty names", () => {
    SUPPORTED_LANGUAGES.forEach((language) => {
      expect(language.nativeName.length).toBeGreaterThan(0);
      expect(language.englishName.length).toBeGreaterThan(0);
    });
  });

  it("marks exactly the right-to-left languages", () => {
    const rtl = SUPPORTED_LANGUAGES.filter(
      (language) => language.direction === "rtl",
    ).map((language) => language.code);

    expect(rtl.sort()).toEqual(["ar", "he"]);
  });

  it("defaults to a supported language", () => {
    expect(isLanguageCode(DEFAULT_LANGUAGE)).toBe(true);
  });
});

describe("isLanguageCode", () => {
  it("accepts every supported code", () => {
    SUPPORTED_LANGUAGES.forEach((language) => {
      expect(isLanguageCode(language.code)).toBe(true);
    });
  });

  it("rejects anything else", () => {
    // These arrive from localStorage and from the data channel, so non-strings
    // are a real possibility rather than a hypothetical.
    expect(isLanguageCode("hi-IN")).toBe(false);
    expect(isLanguageCode("gu")).toBe(false);
    expect(isLanguageCode("")).toBe(false);
    expect(isLanguageCode(null)).toBe(false);
    expect(isLanguageCode(undefined)).toBe(false);
    expect(isLanguageCode(42)).toBe(false);
    expect(isLanguageCode({ code: "en" })).toBe(false);
  });
});

describe("findLanguage", () => {
  it("resolves a record", () => {
    expect(findLanguage("te").nativeName).toBe("తెలుగు");
  });

  it("throws for a code outside the union", () => {
    expect(() => findLanguage("zz" as LanguageCode)).toThrow(/Unknown language/);
  });
});

describe("directionFor", () => {
  it("reports right-to-left for Arabic and Hebrew", () => {
    expect(directionFor("ar")).toBe("rtl");
    expect(directionFor("he")).toBe("rtl");
  });

  it("reports left-to-right otherwise", () => {
    expect(directionFor("en")).toBe("ltr");
    expect(directionFor("te")).toBe("ltr");
    expect(directionFor("ja")).toBe("ltr");
  });
});

describe("speechLocaleFor", () => {
  it("returns the regional tag", () => {
    expect(speechLocaleFor("te")).toBe("te-IN");
    expect(speechLocaleFor("hi")).toBe("hi-IN");
  });

  it("expects an Indian accent for English", () => {
    expect(speechLocaleFor("en")).toBe("en-IN");
  });
});

describe("languageLabel", () => {
  it("shows the native name ahead of the English one", () => {
    expect(languageLabel("hi")).toBe("हिन्दी (Hindi)");
    expect(languageLabel("te")).toBe("తెలుగు (Telugu)");
  });

  it("does not repeat a name that is the same in both", () => {
    expect(languageLabel("en")).toBe("English");
  });
});

describe("soleLanguageForScript", () => {
  it("resolves scripts used by exactly one language", () => {
    expect(soleLanguageForScript("telugu")).toBe("te");
    expect(soleLanguageForScript("tamil")).toBe("ta");
    expect(soleLanguageForScript("kannada")).toBe("kn");
    expect(soleLanguageForScript("bengali")).toBe("bn");
    expect(soleLanguageForScript("thai")).toBe("th");
    expect(soleLanguageForScript("hangul")).toBe("ko");
    expect(soleLanguageForScript("hebrew")).toBe("he");
    expect(soleLanguageForScript("arabic")).toBe("ar");
  });

  it("refuses scripts shared by more than one language", () => {
    // Latin covers ten languages here, Devanagari covers Hindi and Marathi, and
    // Cyrillic covers Russian and Ukrainian. Characters alone cannot separate
    // them, so null is the correct answer rather than a guess.
    expect(soleLanguageForScript("latin")).toBeNull();
    expect(soleLanguageForScript("devanagari")).toBeNull();
    expect(soleLanguageForScript("cyrillic")).toBeNull();
  });

  it("agrees with the registry about which scripts are unique", () => {
    const counts = new Map<string, number>();

    SUPPORTED_LANGUAGES.forEach((language) => {
      counts.set(language.script, (counts.get(language.script) ?? 0) + 1);
    });

    SUPPORTED_LANGUAGES.forEach((language) => {
      const expected = counts.get(language.script) === 1 ? language.code : null;

      expect(soleLanguageForScript(language.script)).toBe(expected);
    });
  });
});

describe("pairKey", () => {
  it("distinguishes direction", () => {
    expect(pairKey({ source: "en", target: "te" })).toBe("en>te");
    expect(pairKey({ source: "te", target: "en" })).toBe("te>en");
  });

  it("never collides across the whole catalog", () => {
    const keys: string[] = [];

    SUPPORTED_LANGUAGES.forEach((source) => {
      SUPPORTED_LANGUAGES.forEach((target) => {
        keys.push(pairKey({ source: source.code, target: target.code }));
      });
    });

    expect(keys).toHaveLength(625);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("isSamePair", () => {
  it("detects a no-op direction", () => {
    expect(isSamePair({ source: "en", target: "en" })).toBe(true);
    expect(isSamePair({ source: "en", target: "hi" })).toBe(false);
  });
});

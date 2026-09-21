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
  type LanguageCode,
} from "@/lib/i18n/languages";

describe("SUPPORTED_LANGUAGES", () => {
  it("covers the first target set", () => {
    const codes = SUPPORTED_LANGUAGES.map((language) => language.code);

    expect(codes).toEqual(["en", "hi", "te"]);
  });

  it("uses bare BCP 47 codes, not regional ones", () => {
    // `hi-IN` would be rejected by the Translator API, which wants `hi`.
    SUPPORTED_LANGUAGES.forEach((language) => {
      expect(language.code).not.toContain("-");
    });
  });

  it("has no duplicate codes", () => {
    const codes = SUPPORTED_LANGUAGES.map((language) => language.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives every language a non-empty native name", () => {
    SUPPORTED_LANGUAGES.forEach((language) => {
      expect(language.nativeName.length).toBeGreaterThan(0);
      expect(language.englishName.length).toBeGreaterThan(0);
    });
  });

  it("defaults to a supported language", () => {
    expect(isLanguageCode(DEFAULT_LANGUAGE)).toBe(true);
  });
});

describe("isLanguageCode", () => {
  it("accepts supported codes", () => {
    expect(isLanguageCode("en")).toBe(true);
    expect(isLanguageCode("hi")).toBe(true);
    expect(isLanguageCode("te")).toBe(true);
  });

  it("rejects anything else", () => {
    // These arrive from localStorage, so non-strings are a real possibility.
    expect(isLanguageCode("fr")).toBe(false);
    expect(isLanguageCode("hi-IN")).toBe(false);
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
  it("reports left-to-right for the current set", () => {
    // None of English, Hindi or Telugu is RTL. The field exists so that adding
    // Arabic or Hebrew later does not require touching every render site.
    expect(directionFor("en")).toBe("ltr");
    expect(directionFor("hi")).toBe("ltr");
    expect(directionFor("te")).toBe("ltr");
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

describe("pairKey", () => {
  it("distinguishes direction", () => {
    expect(pairKey({ source: "en", target: "te" })).toBe("en>te");
    expect(pairKey({ source: "te", target: "en" })).toBe("te>en");
  });

  it("never collides across the supported set", () => {
    const keys: string[] = [];

    SUPPORTED_LANGUAGES.forEach((source) => {
      SUPPORTED_LANGUAGES.forEach((target) => {
        keys.push(pairKey({ source: source.code, target: target.code }));
      });
    });

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("isSamePair", () => {
  it("detects a no-op direction", () => {
    expect(isSamePair({ source: "en", target: "en" })).toBe(true);
    expect(isSamePair({ source: "en", target: "hi" })).toBe(false);
  });
});

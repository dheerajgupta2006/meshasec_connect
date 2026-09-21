import { describe, expect, it, vi } from "vitest";

import type { LanguagePair } from "@/lib/i18n/languages";
import {
  MAX_TRANSLATION_CHARS,
  createTranslationEngine,
  readTranslatorFactory,
  type TranslatorAvailability,
  type TranslatorFactory,
} from "@/lib/translation/on-device";

const EN_TE: LanguagePair = { source: "en", target: "te" };
const TE_EN: LanguagePair = { source: "te", target: "en" };
const EN_HI: LanguagePair = { source: "en", target: "hi" };

interface FakeOptions {
  availability?: TranslatorAvailability;
  /** Throw from `create`, simulating a failed language-pack download. */
  failCreate?: boolean;
  /** Throw from `translate`, simulating a model error. */
  failTranslate?: boolean;
}

/**
 * Stands in for the browser global.
 *
 * Records every call so the tests can assert on de-duplication and instance
 * reuse, which are the whole point of the engine.
 */
function fakeFactory(options: FakeOptions = {}) {
  const createdPairs: string[] = [];
  const translated: string[] = [];
  let downloadProgress: ((fraction: number) => void) | null = null;

  const factory: TranslatorFactory = {
    availability: vi.fn(async () => options.availability ?? "available"),
    create: vi.fn(async (createOptions) => {
      createdPairs.push(
        `${createOptions.sourceLanguage}>${createOptions.targetLanguage}`,
      );

      createOptions.monitor?.({
        addEventListener: (
          _type: "downloadprogress",
          listener: (event: { loaded: number }) => void,
        ) => {
          downloadProgress = (fraction: number) => {
            listener({ loaded: fraction });
          };
        },
      });

      if (options.failCreate === true) {
        throw new Error("pack download failed");
      }

      return {
        translate: async (input: string) => {
          translated.push(input);

          if (options.failTranslate === true) {
            throw new Error("model error");
          }

          return `[${createOptions.targetLanguage}] ${input}`;
        },
      };
    }),
  };

  return {
    factory,
    createdPairs,
    translated,
    emitProgress: (fraction: number) => downloadProgress?.(fraction),
  };
}

describe("readTranslatorFactory", () => {
  it("returns null when the browser global is absent", () => {
    // The test runner is Node, so this is the real ambient condition.
    expect(readTranslatorFactory()).toBeNull();
  });

  it("rejects a global missing the expected methods", () => {
    const host = globalThis as { Translator?: unknown };
    host.Translator = { availability: () => undefined };

    try {
      expect(readTranslatorFactory()).toBeNull();
    } finally {
      delete host.Translator;
    }
  });

  it("accepts a plain object carrying both methods", () => {
    const host = globalThis as { Translator?: unknown };
    host.Translator = { availability: () => undefined, create: () => undefined };

    try {
      expect(readTranslatorFactory()).not.toBeNull();
    } finally {
      delete host.Translator;
    }
  });

  it("accepts a class with static methods, which is the real shape", () => {
    // Regression test. `Translator` is a WebIDL interface with static `create`
    // and `availability`, so the browser global is a constructor and `typeof` it
    // is "function". An earlier version required "object" and so reported the
    // feature unsupported on every browser that actually supports it.
    class FakeTranslator {
      static availability(): void {}
      static create(): void {}
    }

    const host = globalThis as { Translator?: unknown };
    host.Translator = FakeTranslator;

    try {
      expect(readTranslatorFactory()).not.toBeNull();
    } finally {
      delete host.Translator;
    }
  });

  it("rejects a function missing the static methods", () => {
    const host = globalThis as { Translator?: unknown };
    host.Translator = function notTheApi(): void {};

    try {
      expect(readTranslatorFactory()).toBeNull();
    } finally {
      delete host.Translator;
    }
  });
});

describe("createTranslationEngine without support", () => {
  it("reports itself unsupported", async () => {
    const engine = createTranslationEngine(null);

    expect(engine.isSupported()).toBe(false);
    await expect(engine.availability(EN_TE)).resolves.toBe("unavailable");
    await expect(engine.prepare(EN_TE)).resolves.toBe(false);
  });

  it("fails translation with a reason the UI can branch on", async () => {
    const engine = createTranslationEngine(null);

    const outcome = await engine.translate("hello", EN_TE);

    expect(outcome).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("availability", () => {
  it("passes the pair through to the factory", async () => {
    const { factory } = fakeFactory({ availability: "downloadable" });
    const engine = createTranslationEngine(factory);

    await expect(engine.availability(EN_TE)).resolves.toBe("downloadable");
    expect(factory.availability).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "te",
    });
  });

  it("treats a thrown availability check as unavailable", async () => {
    const factory: TranslatorFactory = {
      availability: vi.fn(async () => {
        throw new Error("boom");
      }),
      create: vi.fn(),
    };

    await expect(
      createTranslationEngine(factory).availability(EN_TE),
    ).resolves.toBe("unavailable");
  });

  it("short-circuits a same-language pair without asking the factory", async () => {
    const { factory } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await expect(
      engine.availability({ source: "en", target: "en" }),
    ).resolves.toBe("available");
    expect(factory.availability).not.toHaveBeenCalled();
  });
});

describe("translate", () => {
  it("translates through the factory", async () => {
    const { factory } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await expect(engine.translate("hello", EN_TE)).resolves.toEqual({
      ok: true,
      text: "[te] hello",
      viaPivot: false,
    });
  });

  it("returns the input unchanged for a same-language pair", async () => {
    const { factory, translated } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await expect(
      engine.translate("hello", { source: "en", target: "en" }),
    ).resolves.toEqual({ ok: true, text: "hello", viaPivot: false });
    expect(translated).toEqual([]);
  });

  it("returns blank input unchanged without calling the model", async () => {
    const { factory, translated } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await expect(engine.translate("   ", EN_TE)).resolves.toEqual({
      ok: true,
      text: "   ",
      viaPivot: false,
    });
    expect(translated).toEqual([]);
  });

  it("refuses text longer than a message body may be", async () => {
    const { factory, translated } = fakeFactory();
    const engine = createTranslationEngine(factory);

    const outcome = await engine.translate(
      "x".repeat(MAX_TRANSLATION_CHARS + 1),
      EN_TE,
    );

    expect(outcome).toEqual({ ok: false, reason: "too_long" });
    expect(translated).toEqual([]);
  });

  it("caches a result so identical text is translated once", async () => {
    const { factory, translated } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await engine.translate("hello", EN_TE);
    await engine.translate("hello", EN_TE);

    expect(translated).toEqual(["hello"]);
  });

  it("de-duplicates concurrent requests for the same text", async () => {
    const { factory, translated } = fakeFactory();
    const engine = createTranslationEngine(factory);

    // Two bubbles showing the same text render in the same tick.
    const [first, second] = await Promise.all([
      engine.translate("hello", EN_TE),
      engine.translate("hello", EN_TE),
    ]);

    expect(first).toEqual(second);
    expect(translated).toEqual(["hello"]);
  });

  it("keys the cache by direction, not just by text", async () => {
    const { factory, translated } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await engine.translate("hello", EN_TE);
    await engine.translate("hello", EN_HI);

    expect(translated).toEqual(["hello", "hello"]);
  });

  it("reuses one translator per direction", async () => {
    const { factory, createdPairs } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await engine.translate("one", EN_TE);
    await engine.translate("two", EN_TE);
    await engine.translate("three", TE_EN);

    expect(createdPairs).toEqual(["en>te", "te>en"]);
  });

  it("surfaces a model failure without throwing", async () => {
    const { factory } = fakeFactory({ failTranslate: true });
    const engine = createTranslationEngine(factory);

    const outcome = await engine.translate("hello", EN_TE);

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.reason).toBe("failed");
      expect(outcome.detail).toBe("model error");
    }
  });

  it("does not cache a failure, so the next attempt retries", async () => {
    let attempts = 0;

    const factory: TranslatorFactory = {
      availability: async () => "available",
      create: async () => ({
        translate: async (input: string) => {
          attempts += 1;

          if (attempts === 1) {
            throw new Error("transient");
          }

          return `ok:${input}`;
        },
      }),
    };

    const engine = createTranslationEngine(factory);

    expect((await engine.translate("hello", EN_TE)).ok).toBe(false);
    await expect(engine.translate("hello", EN_TE)).resolves.toEqual({
      ok: true,
      text: "ok:hello",
      viaPivot: false,
    });
    expect(attempts).toBe(2);
  });

  it("keeps serving later requests after one fails", async () => {
    let calls = 0;

    const factory: TranslatorFactory = {
      availability: async () => "available",
      create: async () => ({
        translate: async (input: string) => {
          calls += 1;

          if (input === "bad") {
            throw new Error("nope");
          }

          return `ok:${input}`;
        },
      }),
    };

    const engine = createTranslationEngine(factory);

    // A rejected task must not break the shared queue for everything behind it.
    const [bad, good] = await Promise.all([
      engine.translate("bad", EN_TE),
      engine.translate("good", EN_TE),
    ]);

    expect(bad.ok).toBe(false);
    expect(good).toEqual({ ok: true, text: "ok:good", viaPivot: false });
    expect(calls).toBe(2);
  });

  it("completes queued translations in the order they were requested", async () => {
    const finished: string[] = [];

    const factory: TranslatorFactory = {
      availability: async () => "available",
      create: async () => ({
        translate: async (input: string) => {
          // Earlier requests are made deliberately slower, so anything other
          // than a real queue would let the later one finish first.
          const delay = input === "first" ? 20 : 0;
          await new Promise((resolve) => setTimeout(resolve, delay));
          finished.push(input);
          return input;
        },
      }),
    };

    const engine = createTranslationEngine(factory);

    await Promise.all([
      engine.translate("first", EN_TE),
      engine.translate("second", EN_TE),
    ]);

    expect(finished).toEqual(["first", "second"]);
  });
});

describe("prepare", () => {
  it("creates the translator and reports success", async () => {
    const { factory, createdPairs } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await expect(engine.prepare(EN_TE)).resolves.toBe(true);
    expect(createdPairs).toEqual(["en>te"]);
  });

  it("reports download progress", async () => {
    const { factory, emitProgress } = fakeFactory();
    const engine = createTranslationEngine(factory);
    const seen: number[] = [];

    await engine.prepare(EN_TE, (fraction) => seen.push(fraction));

    emitProgress(0.5);
    emitProgress(1);

    expect(seen).toEqual([0.5, 1]);
  });

  it("reports failure rather than throwing when the pack will not download", async () => {
    const { factory } = fakeFactory({ failCreate: true });
    const engine = createTranslationEngine(factory);

    await expect(engine.prepare(EN_TE)).resolves.toBe(false);
  });

  it("retries after a failed create rather than caching the failure", async () => {
    let attempts = 0;

    const factory: TranslatorFactory = {
      availability: async () => "available",
      create: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("download failed");
        }

        return { translate: async (input: string) => input };
      },
    };

    const engine = createTranslationEngine(factory);

    await expect(engine.prepare(EN_TE)).resolves.toBe(false);
    await expect(engine.prepare(EN_TE)).resolves.toBe(true);
    expect(attempts).toBe(2);
  });

  it("does nothing for a same-language pair", async () => {
    const { factory, createdPairs } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await expect(
      engine.prepare({ source: "en", target: "en" }),
    ).resolves.toBe(false);
    expect(createdPairs).toEqual([]);
  });
});

describe("reset", () => {
  it("clears cached results and instances", async () => {
    const { factory, translated, createdPairs } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await engine.translate("hello", EN_TE);
    engine.reset();
    await engine.translate("hello", EN_TE);

    expect(translated).toEqual(["hello", "hello"]);
    expect(createdPairs).toEqual(["en>te", "en>te"]);
  });
});

describe("English pivot", () => {
  const TE_TA: LanguagePair = { source: "te", target: "ta" };

  /**
   * A factory that serves only pairs involving English.
   *
   * This is the shape the real API may well have: Chrome does not publish which
   * of the 600 non-English combinations it handles directly, and its page
   * translation has always routed through English.
   */
  function englishOnlyFactory() {
    const asked: string[] = [];
    const translatedBy: string[] = [];

    const factory: TranslatorFactory = {
      availability: vi.fn(async ({ sourceLanguage, targetLanguage }) => {
        asked.push(`${sourceLanguage}>${targetLanguage}`);

        return sourceLanguage === "en" || targetLanguage === "en"
          ? "available"
          : "unavailable";
      }),
      create: vi.fn(async ({ sourceLanguage, targetLanguage }) => ({
        translate: async (input: string) => {
          translatedBy.push(`${sourceLanguage}>${targetLanguage}`);
          return `${input}|${sourceLanguage}>${targetLanguage}`;
        },
      })),
    };

    return { factory, asked, translatedBy };
  }

  it("translates Telugu to Tamil through English when the direct pair is missing", () => {
    const { factory, translatedBy } = englishOnlyFactory();
    const engine = createTranslationEngine(factory);

    return engine.translate("రేపు", TE_TA).then((outcome) => {
      expect(outcome.ok).toBe(true);

      if (outcome.ok) {
        // Two hops, in order, rather than nothing at all.
        expect(translatedBy).toEqual(["te>en", "en>ta"]);
        expect(outcome.text).toBe("రేపు|te>en|en>ta");
        expect(outcome.viaPivot).toBe(true);
      }
    });
  });

  it("marks a direct translation as not pivoted", async () => {
    const { factory } = fakeFactory();
    const outcome = await createTranslationEngine(factory).translate(
      "hello",
      EN_TE,
    );

    expect(outcome.ok).toBe(true);

    if (outcome.ok) {
      expect(outcome.viaPivot).toBe(false);
    }
  });

  it("prefers a direct pair over a pivot", async () => {
    const { factory, translated } = fakeFactory();
    const engine = createTranslationEngine(factory);

    await engine.translate("hello", TE_TA);

    // One hop: a pivot would have translated twice and lost quality for nothing.
    expect(translated).toEqual(["hello"]);
  });

  it("reports a pivoted pair as available through `availability`", async () => {
    const { factory } = englishOnlyFactory();

    await expect(
      createTranslationEngine(factory).availability(TE_TA),
    ).resolves.not.toBe("unavailable");
  });

  it("prepares both legs of a pivot", async () => {
    const { factory } = englishOnlyFactory();
    const engine = createTranslationEngine(factory);

    await expect(engine.prepare(TE_TA)).resolves.toBe(true);
    expect(factory.create).toHaveBeenCalledTimes(2);
  });

  it("does not pivot when English is already one end of the pair", async () => {
    // en>xx being unavailable cannot be fixed by going en>en>xx, and asking would
    // just spend two more availability checks to learn nothing.
    const factory: TranslatorFactory = {
      availability: vi.fn(
        async (): Promise<TranslatorAvailability> => "unavailable",
      ),
      create: vi.fn(),
    };

    const engine = createTranslationEngine(factory);
    const outcome = await engine.translate("hello", {
      source: "en",
      target: "ta",
    });

    expect(outcome.ok).toBe(false);
    expect(factory.availability).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable when neither leg exists", async () => {
    const factory: TranslatorFactory = {
      availability: vi.fn(
        async (): Promise<TranslatorAvailability> => "unavailable",
      ),
      create: vi.fn(),
    };

    const outcome = await createTranslationEngine(factory).translate(
      "రేపు",
      TE_TA,
    );

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.reason).toBe("unavailable");
    }
  });

  it("resolves a route once and reuses it", async () => {
    const { factory, asked } = englishOnlyFactory();
    const engine = createTranslationEngine(factory);

    await engine.translate("one", TE_TA);
    await engine.translate("two", TE_TA);

    // Three checks for the first call (direct, then both legs), none for the
    // second: the answer cannot change within a session.
    expect(asked).toEqual(["te>ta", "te>en", "en>ta"]);
  });

  it("forgets routes on reset", async () => {
    const { factory, asked } = englishOnlyFactory();
    const engine = createTranslationEngine(factory);

    await engine.translate("one", TE_TA);
    engine.reset();
    await engine.translate("one", TE_TA);

    expect(asked).toHaveLength(6);
  });

  it("caches a pivoted result like any other", async () => {
    const { factory, translatedBy } = englishOnlyFactory();
    const engine = createTranslationEngine(factory);

    await engine.translate("రేపు", TE_TA);
    await engine.translate("రేపు", TE_TA);

    expect(translatedBy).toEqual(["te>en", "en>ta"]);
  });
});

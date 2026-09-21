import { describe, expect, it, vi } from "vitest";

import {
  MIN_CONFIDENCE,
  MIN_DETECTABLE_CHARS,
  createLanguageDetectorEngine,
  readLanguageDetectorFactory,
  type DetectionResult,
  type DetectorAvailability,
  type LanguageDetectorFactory,
} from "@/lib/translation/detector";

interface FakeOptions {
  availability?: DetectorAvailability;
  failCreate?: boolean;
  failDetect?: boolean;
  /** Candidates the fake model returns, highest confidence not assumed first. */
  candidates?: DetectionResult[];
}

function fakeFactory(options: FakeOptions = {}) {
  const detected: string[] = [];
  let creates = 0;

  const factory: LanguageDetectorFactory = {
    availability: vi.fn(async () => options.availability ?? "available"),
    create: vi.fn(async () => {
      creates += 1;

      if (options.failCreate === true) {
        throw new Error("model download failed");
      }

      return {
        detect: async (input: string) => {
          detected.push(input);

          if (options.failDetect === true) {
            throw new Error("detect failed");
          }

          return (
            options.candidates ?? [
              { detectedLanguage: "en", confidence: 0.99 },
            ]
          );
        },
      };
    }),
  };

  return { factory, detected, creates: () => creates };
}

describe("readLanguageDetectorFactory", () => {
  it("returns null when the global is absent", () => {
    expect(readLanguageDetectorFactory()).toBeNull();
  });

  it("accepts a class with static methods, which is the real shape", () => {
    // `LanguageDetector` is a WebIDL interface with static `create` and
    // `availability`, so the global is a constructor and `typeof` it is
    // "function". Requiring "object" would reject the real API.
    class FakeDetector {
      static availability(): void {}
      static create(): void {}
    }

    const host = globalThis as { LanguageDetector?: unknown };
    host.LanguageDetector = FakeDetector;

    try {
      expect(readLanguageDetectorFactory()).not.toBeNull();
    } finally {
      delete host.LanguageDetector;
    }
  });

  it("rejects a global missing the expected methods", () => {
    const host = globalThis as { LanguageDetector?: unknown };
    host.LanguageDetector = { availability: () => undefined };

    try {
      expect(readLanguageDetectorFactory()).toBeNull();
    } finally {
      delete host.LanguageDetector;
    }
  });
});

describe("without a model", () => {
  it("reports itself unsupported", async () => {
    const engine = createLanguageDetectorEngine(null);

    expect(engine.isSupported()).toBe(false);
    await expect(engine.availability()).resolves.toBe("unavailable");
    await expect(engine.prepare()).resolves.toBe(false);
  });

  it("still detects Indic scripts through the fallback", async () => {
    // This is the whole point of the layering: no model, but Telugu is still
    // identified because no other enabled language uses that script.
    const engine = createLanguageDetectorEngine(null);

    await expect(engine.detect("రేపు కలుద్దాం")).resolves.toBe("te");
    await expect(engine.detect("வணக்கம்")).resolves.toBe("ta");
  });

  it("cannot resolve a shared script without a model", async () => {
    const engine = createLanguageDetectorEngine(null);

    await expect(engine.detect("Hello there")).resolves.toBeNull();
    await expect(engine.detect("कल मिलते हैं")).resolves.toBeNull();
  });
});

describe("detect", () => {
  it("uses the model's confident answer", async () => {
    const { factory } = fakeFactory({
      candidates: [{ detectedLanguage: "es", confidence: 0.9 }],
    });

    await expect(
      createLanguageDetectorEngine(factory).detect("Hola, como estas"),
    ).resolves.toBe("es");
  });

  it("separates Hindi from Marathi, which the script cannot", async () => {
    // Both are Devanagari. This is the case that required a model at all.
    const { factory } = fakeFactory({
      candidates: [{ detectedLanguage: "mr", confidence: 0.88 }],
    });

    await expect(
      createLanguageDetectorEngine(factory).detect("मी उद्या येतो"),
    ).resolves.toBe("mr");
  });

  it("picks the highest-confidence supported candidate", async () => {
    const { factory } = fakeFactory({
      candidates: [
        { detectedLanguage: "en", confidence: 0.6 },
        { detectedLanguage: "es", confidence: 0.85 },
        { detectedLanguage: "it", confidence: 0.7 },
      ],
    });

    await expect(
      createLanguageDetectorEngine(factory).detect("something here"),
    ).resolves.toBe("es");
  });

  it("ignores a confident answer outside the catalog", async () => {
    // The model knows Gujarati; this app cannot translate it on-device, so it
    // must not displace a weaker but usable candidate.
    const { factory } = fakeFactory({
      candidates: [
        { detectedLanguage: "gu", confidence: 0.97 },
        { detectedLanguage: "hi", confidence: 0.55 },
      ],
    });

    await expect(
      createLanguageDetectorEngine(factory).detect("કેમ છો"),
    ).resolves.toBe("hi");
  });

  it("rejects answers below the confidence floor", async () => {
    // A wrong source produces a confidently wrong translation the reader cannot
    // detect, so a weak guess is worse than none.
    const { factory } = fakeFactory({
      candidates: [{ detectedLanguage: "es", confidence: MIN_CONFIDENCE - 0.01 }],
    });

    await expect(
      createLanguageDetectorEngine(factory).detect("ambiguous words"),
    ).resolves.toBeNull();
  });

  it("falls back to the script when the model is unconfident", async () => {
    const { factory } = fakeFactory({
      candidates: [{ detectedLanguage: "hi", confidence: 0.1 }],
    });

    // Telugu script is decisive even though the model was not.
    await expect(
      createLanguageDetectorEngine(factory).detect("రేపు కలుద్దాం"),
    ).resolves.toBe("te");
  });

  it("falls back to the script when the model throws", async () => {
    const { factory } = fakeFactory({ failDetect: true });

    await expect(
      createLanguageDetectorEngine(factory).detect("రేపు కలుద్దాం"),
    ).resolves.toBe("te");
  });

  it("falls back to the script when the model will not load", async () => {
    const { factory } = fakeFactory({ failCreate: true });

    await expect(
      createLanguageDetectorEngine(factory).detect("வணக்கம் நண்பரே"),
    ).resolves.toBe("ta");
  });

  it("does not ask the model about very short text", async () => {
    const { factory, detected } = fakeFactory();
    const engine = createLanguageDetectorEngine(factory);

    await engine.detect("ok");

    // Two characters carry almost no signal; the model spreads confidence thin
    // and the script check is both better and instant.
    expect("ok".length).toBeLessThan(MIN_DETECTABLE_CHARS);
    expect(detected).toEqual([]);
  });

  it("returns null for blank input without touching the model", async () => {
    const { factory, detected } = fakeFactory();
    const engine = createLanguageDetectorEngine(factory);

    await expect(engine.detect("   ")).resolves.toBeNull();
    expect(detected).toEqual([]);
  });

  it("caches a result so identical text is detected once", async () => {
    const { factory, detected } = fakeFactory();
    const engine = createLanguageDetectorEngine(factory);

    await engine.detect("the same sentence");
    await engine.detect("the same sentence");

    expect(detected).toEqual(["the same sentence"]);
  });

  it("de-duplicates concurrent detections of the same text", async () => {
    const { factory, detected } = fakeFactory();
    const engine = createLanguageDetectorEngine(factory);

    const [first, second] = await Promise.all([
      engine.detect("the same sentence"),
      engine.detect("the same sentence"),
    ]);

    expect(first).toBe(second);
    expect(detected).toEqual(["the same sentence"]);
  });

  it("keys the cache on trimmed text", async () => {
    const { factory, detected } = fakeFactory();
    const engine = createLanguageDetectorEngine(factory);

    await engine.detect("padded sentence");
    await engine.detect("  padded sentence  ");

    expect(detected).toEqual(["padded sentence"]);
  });

  it("reuses one model instance across detections", async () => {
    const { factory, creates } = fakeFactory();
    const engine = createLanguageDetectorEngine(factory);

    await engine.detect("first sentence");
    await engine.detect("second sentence");

    expect(creates()).toBe(1);
  });

  it("keeps serving later detections after one fails", async () => {
    let calls = 0;

    const factory: LanguageDetectorFactory = {
      availability: async () => "available",
      create: async () => ({
        detect: async (input: string) => {
          calls += 1;

          if (input.startsWith("bad")) {
            throw new Error("nope");
          }

          return [{ detectedLanguage: "es", confidence: 0.9 }];
        },
      }),
    };

    const engine = createLanguageDetectorEngine(factory);

    // A rejected detection must not break the shared queue behind it.
    const [bad, good] = await Promise.all([
      engine.detect("bad input here"),
      engine.detect("good input here"),
    ]);

    expect(bad).toBeNull();
    expect(good).toBe("es");
    expect(calls).toBe(2);
  });
});

describe("availability and prepare", () => {
  it("passes availability through", async () => {
    const { factory } = fakeFactory({ availability: "downloadable" });

    await expect(
      createLanguageDetectorEngine(factory).availability(),
    ).resolves.toBe("downloadable");
  });

  it("treats a thrown availability check as unavailable", async () => {
    const factory: LanguageDetectorFactory = {
      availability: async () => {
        throw new Error("boom");
      },
      create: vi.fn(),
    };

    await expect(
      createLanguageDetectorEngine(factory).availability(),
    ).resolves.toBe("unavailable");
  });

  it("reports a failed prepare without throwing", async () => {
    const { factory } = fakeFactory({ failCreate: true });

    await expect(createLanguageDetectorEngine(factory).prepare()).resolves.toBe(
      false,
    );
  });

  it("retries after a failed create rather than caching the failure", async () => {
    let attempts = 0;

    const factory: LanguageDetectorFactory = {
      availability: async () => "available",
      create: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("download failed");
        }

        return { detect: async () => [] };
      },
    };

    const engine = createLanguageDetectorEngine(factory);

    await expect(engine.prepare()).resolves.toBe(false);
    await expect(engine.prepare()).resolves.toBe(true);
    expect(attempts).toBe(2);
  });
});

describe("reset", () => {
  it("clears cached detections and the model instance", async () => {
    const { factory, detected, creates } = fakeFactory();
    const engine = createLanguageDetectorEngine(factory);

    await engine.detect("a sentence here");
    engine.reset();
    await engine.detect("a sentence here");

    expect(detected).toEqual(["a sentence here", "a sentence here"]);
    expect(creates()).toBe(2);
  });
});

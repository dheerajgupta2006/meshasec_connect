/**
 * Language detection on the reader's own machine.
 *
 * Chrome exposes a `LanguageDetector` global alongside the translator. It returns
 * ranked candidates with confidence scores and, unlike counting characters, can
 * tell Hindi from Marathi and English from Spanish — both of which the catalog
 * now needs, since Devanagari and Latin each cover several enabled languages.
 *
 * Detection runs in the browser, so this adds nothing to the operating cost and
 * no text leaves the device.
 *
 * ## Layering
 *
 * The model is primary; `detectLanguageByScript` is the fallback. That ordering
 * matters because the fallback is exact for Telugu, Tamil, Kannada, Bengali,
 * Thai, Hebrew, Arabic and Hangul but blind to everything sharing a script. So on
 * a browser without the API, Indic-script messages still get detected and Latin
 * ones simply do not.
 *
 * ## Why an injected factory
 *
 * The browser global is passed in rather than read at the point of use, so the
 * caching, confidence filtering and fallback behaviour below are testable under
 * Node with a fake. `readLanguageDetectorFactory()` supplies the real one.
 */

import { detectLanguageByScript } from "@/lib/i18n/detect-language";
import { isLanguageCode, type LanguageCode } from "@/lib/i18n/languages";

/** Mirrors the availability states of the translator API. */
export type DetectorAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

/** One ranked candidate from the model. */
export interface DetectionResult {
  /** A BCP 47 code, which may well be outside this app's catalog. */
  detectedLanguage: string;
  /** 0 to 1. */
  confidence: number;
}

export interface LanguageDetectorInstance {
  detect(input: string): Promise<DetectionResult[]>;
  destroy?: () => void;
}

export interface LanguageDetectorFactory {
  availability(): Promise<DetectorAvailability>;
  create(options?: { monitor?: (monitor: unknown) => void }): Promise<
    LanguageDetectorInstance
  >;
}

/**
 * Reads the browser global, or null when it is absent.
 *
 * Accepts `function` as well as `object`: the spec declares `LanguageDetector` as
 * a WebIDL interface whose `create` and `availability` are static, so the global
 * is a constructor and `typeof` it is "function". Checking only for "object"
 * would reject the real API.
 */
export function readLanguageDetectorFactory(): LanguageDetectorFactory | null {
  const candidate = (globalThis as { LanguageDetector?: unknown })
    .LanguageDetector;

  if (
    candidate === null ||
    (typeof candidate !== "object" && typeof candidate !== "function")
  ) {
    return null;
  }

  const record = candidate as unknown as Record<string, unknown>;

  if (
    typeof record.availability !== "function" ||
    typeof record.create !== "function"
  ) {
    return null;
  }

  return candidate as unknown as LanguageDetectorFactory;
}

/**
 * Below this, the model's best guess is not worth acting on.
 *
 * A wrong source language produces a confidently wrong translation, which is
 * worse than no translation at all — the reader has no way to tell. Falling back
 * to the script check, or to nothing, is the safer failure.
 */
export const MIN_CONFIDENCE = 0.5;

/** Bounds the cache; a thread plus a call's captions fit comfortably. */
const MAX_CACHE_ENTRIES = 500;

/**
 * Short strings are not worth asking a model about.
 *
 * "ok", "👍" and "haha" carry almost no signal, and the model returns low
 * confidence spread across many languages. The script check handles them better
 * and instantly.
 */
export const MIN_DETECTABLE_CHARS = 4;

export interface LanguageDetectorEngine {
  /** False when this browser has no detector model. The fallback still works. */
  isSupported(): boolean;
  availability(): Promise<DetectorAvailability>;
  /**
   * Warms the model. Must be called from a user gesture, as the first use
   * downloads it.
   */
  prepare(): Promise<boolean>;
  /**
   * The language of `text`, or null when nothing can be established.
   *
   * Never throws and never rejects: a failed detection degrades to the script
   * check, and from there to null.
   */
  detect(text: string): Promise<LanguageCode | null>;
  reset(): void;
}

export function createLanguageDetectorEngine(
  factory: LanguageDetectorFactory | null = readLanguageDetectorFactory(),
): LanguageDetectorEngine {
  /** Promises rather than values, so identical text in flight twice asks once. */
  const results = new Map<string, Promise<LanguageCode | null>>();

  let instance: Promise<LanguageDetectorInstance> | null = null;

  /**
   * Serialises detection.
   *
   * Captions arrive in bursts, and firing thirty concurrent detections makes the
   * model queue them internally anyway while costing ordered completion.
   */
  let tail: Promise<unknown> = Promise.resolve();

  function evictOldestIfFull(): void {
    if (results.size <= MAX_CACHE_ENTRIES) {
      return;
    }

    // `forEach` rather than `for...of`: this project's tsconfig declares no
    // `target`. Insertion order makes the first key the oldest.
    let oldest: string | null = null;

    results.forEach((_value, key) => {
      if (oldest === null) {
        oldest = key;
      }
    });

    if (oldest !== null) {
      results.delete(oldest);
    }
  }

  function getInstance(): Promise<LanguageDetectorInstance> {
    if (factory === null) {
      return Promise.reject(new Error("No on-device language detector"));
    }

    if (instance !== null) {
      return instance;
    }

    const created = factory.create().catch((error: unknown) => {
      // Not kept, so a failed download is retried rather than poisoning the
      // detector for the rest of the session.
      instance = null;
      throw error;
    });

    instance = created;

    return created;
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);

    tail = run.catch(() => undefined);

    return run;
  }

  /** Highest-confidence candidate that is both in the catalog and confident. */
  function pick(candidates: readonly DetectionResult[]): LanguageCode | null {
    let best: LanguageCode | null = null;
    let bestConfidence = 0;

    candidates.forEach((candidate) => {
      if (candidate.confidence < MIN_CONFIDENCE) {
        return;
      }

      // The model knows far more languages than this app enables, so a confident
      // answer of "Gujarati" is still unusable and must not displace a weaker but
      // supported one.
      if (!isLanguageCode(candidate.detectedLanguage)) {
        return;
      }

      if (candidate.confidence > bestConfidence) {
        best = candidate.detectedLanguage;
        bestConfidence = candidate.confidence;
      }
    });

    return best;
  }

  return {
    isSupported(): boolean {
      return factory !== null;
    },

    async availability(): Promise<DetectorAvailability> {
      if (factory === null) {
        return "unavailable";
      }

      try {
        return await factory.availability();
      } catch {
        return "unavailable";
      }
    },

    async prepare(): Promise<boolean> {
      if (factory === null) {
        return false;
      }

      try {
        await getInstance();
        return true;
      } catch {
        return false;
      }
    },

    async detect(text: string): Promise<LanguageCode | null> {
      const trimmed = text.trim();

      if (trimmed.length === 0) {
        return null;
      }

      // Too short to ask a model about, and no model at all, both land on the
      // script check.
      if (factory === null || trimmed.length < MIN_DETECTABLE_CHARS) {
        return detectLanguageByScript(trimmed);
      }

      const cached = results.get(trimmed);

      if (cached !== undefined) {
        return cached;
      }

      const pending = enqueue(async () => {
        try {
          const detector = await getInstance();
          const candidates = await detector.detect(trimmed);

          const picked = pick(candidates);

          // A model that ran but produced nothing usable — unsupported language,
          // or confidence spread too thin — still leaves the script check, which
          // is decisive for Indic text.
          return picked ?? detectLanguageByScript(trimmed);
        } catch {
          return detectLanguageByScript(trimmed);
        }
      });

      results.set(trimmed, pending);
      evictOldestIfFull();

      return pending;
    },

    reset(): void {
      results.clear();
      instance = null;
      tail = Promise.resolve();
    },
  };
}

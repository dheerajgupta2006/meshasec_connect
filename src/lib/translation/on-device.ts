/**
 * Translation that runs on the reader's own machine.
 *
 * Chrome ships an expert translation model behind a `Translator` global. Text is
 * translated in the browser and never reaches this app's server or any third
 * party, which is why this feature needs no API key, no route handler, no
 * outbound request and no cache table: the three things that would normally make
 * translation cost money are all absent.
 *
 * What it costs instead is availability. The API is desktop-Chromium only, so
 * every caller has to handle "not supported here" as an ordinary outcome rather
 * than an error, and the first use of a language pair downloads a language pack.
 *
 * ## Why an injected factory
 *
 * The browser global is passed in rather than read at the point of use, so the
 * queueing, caching and de-duplication below are testable under Node with a
 * fake. `readTranslatorFactory()` supplies the real one in the app.
 */

import { isSamePair, pairKey, type LanguagePair } from "@/lib/i18n/languages";

/**
 * Whether a language pair can be translated, and at what setup cost.
 *
 * `downloadable` and `downloading` both mean "will work, but not instantly" —
 * the distinction only matters for what the UI says while waiting.
 */
export type TranslatorAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

/** Progress of a language-pack download, 0 to 1. */
export type DownloadProgress = (fraction: number) => void;

/**
 * Only the field this module reads.
 *
 * Deliberately not `extends Event`: the real event carries the full DOM surface,
 * but depending on only `loaded` keeps this usable from a Node test without a DOM
 * shim, and structurally the real event still satisfies it.
 */
interface DownloadProgressEvent {
  readonly loaded: number;
}

interface CreateMonitor {
  addEventListener(
    type: "downloadprogress",
    listener: (event: DownloadProgressEvent) => void,
  ): void;
}

export interface TranslatorInstance {
  translate(input: string): Promise<string>;
  /** Present on the real API; unused here because chat messages are short. */
  destroy?: () => void;
}

export interface TranslatorCreateOptions {
  sourceLanguage: string;
  targetLanguage: string;
  monitor?: (monitor: CreateMonitor) => void;
}

/** The shape of the `Translator` global this module depends on. */
export interface TranslatorFactory {
  availability(pair: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslatorAvailability>;
  create(options: TranslatorCreateOptions): Promise<TranslatorInstance>;
}

/**
 * Reads the browser global, or null when it is absent.
 *
 * Deliberately a narrowing read off `globalThis` rather than an ambient `declare`
 * for the global: an ambient declaration would let the rest of the codebase use
 * `Translator` as though it always exists, and on most browsers it does not.
 */
export function readTranslatorFactory(): TranslatorFactory | null {
  const candidate = (globalThis as { Translator?: unknown }).Translator;

  // `function` is accepted, and that is the case that matters.
  //
  // The spec declares `Translator` as a WebIDL interface whose `create` and
  // `availability` are *static* methods, so the global is an interface object —
  // a constructor — and `typeof` it is "function". Checking only for "object"
  // rejected the real API and turned the feature off in precisely the browsers
  // that implement it. "object" is still allowed so a plain stub also works.
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

  return candidate as unknown as TranslatorFactory;
}

/**
 * Bounds the result cache.
 *
 * A thread renders at most a couple of hundred messages, and a reader may switch
 * target language a few times, so this holds a whole realistic session without
 * growing without limit.
 */
const MAX_CACHE_ENTRIES = 500;

/** Matches the 4000-char limit `sendDirectMessage` enforces on a message body. */
export const MAX_TRANSLATION_CHARS = 4000;

/**
 * The language every pair is routed through when no direct pair exists.
 *
 * Chrome does not publish which of the 600 non-English combinations it serves
 * directly, and its page translation has always gone via English, so a pair like
 * Telugu to Tamil may simply not exist. Rather than show such a pair nothing at
 * all, it is translated in two hops.
 */
export const PIVOT_LANGUAGE = "en";

export type TranslationOutcome =
  | {
      ok: true;
      text: string;
      /**
       * True when the text went through a second language to get here.
       *
       * Worth surfacing: two translations compound their errors, so Telugu to
       * Tamil via English is measurably worse than either hop alone.
       */
      viaPivot: boolean;
    }
  /**
   * `reason` is for the UI to branch on; `detail` is for a log. Nothing here is
   * thrown, because a failed translation must never take down a message thread —
   * the original text is always still readable.
   */
  | {
      ok: false;
      reason: "unsupported" | "unavailable" | "too_long" | "failed";
      detail?: string;
    };

export interface TranslationEngine {
  /** False when this browser has no on-device translator at all. */
  isSupported(): boolean;
  availability(pair: LanguagePair): Promise<TranslatorAvailability>;
  /**
   * Warms a pair, reporting language-pack download progress.
   *
   * Must be called from a user gesture: Chrome gates the model download behind
   * user activation, so calling this from a mount effect can fail where the same
   * call from a click succeeds. The language picker is the intended caller.
   */
  prepare(pair: LanguagePair, onProgress?: DownloadProgress): Promise<boolean>;
  translate(text: string, pair: LanguagePair): Promise<TranslationOutcome>;
  /** Drops cached results and translator instances. */
  reset(): void;
}

function cacheKey(pair: LanguagePair, text: string): string {
  // NUL cannot occur in a language code, so it cannot be confused with the
  // separator inside the text either.
  return `${pairKey(pair)}\u0000${text}`;
}

/** How a pair is served: straight through, in two hops, or not at all. */
type TranslationRoute =
  | { kind: "direct" }
  | { kind: "pivot"; via: string }
  | { kind: "unavailable" };

export function createTranslationEngine(
  factory: TranslatorFactory | null = readTranslatorFactory(),
): TranslationEngine {
  /**
   * Completed and in-flight translations.
   *
   * Promises rather than strings, so two message bubbles holding identical text
   * share one translation instead of racing two. Rejections are evicted so a
   * transient failure is retried rather than cached forever.
   */
  const results = new Map<string, Promise<string>>();

  /** One translator per direction, reused across every message in that direction. */
  const translators = new Map<string, Promise<TranslatorInstance>>();

  /**
   * How each pair gets translated, resolved once and remembered.
   *
   * Cached because working it out costs up to three `availability` calls, and the
   * answer cannot change within a session.
   */
  const routes = new Map<string, Promise<TranslationRoute>>();

  /**
   * Serialises work.
   *
   * The API processes translations sequentially regardless, so queueing here
   * rather than firing everything at once buys ordered completion and keeps a
   * long thread from burying a just-typed message behind 200 older ones.
   */
  let tail: Promise<unknown> = Promise.resolve();

  function evictOldestIfFull(): void {
    if (results.size <= MAX_CACHE_ENTRIES) {
      return;
    }

    // `forEach` rather than `for...of`: this project's tsconfig declares no
    // `target`, so Map iteration is rejected under the default ES5 check.
    // Insertion order makes the first key the oldest.
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

  function getTranslator(
    pair: LanguagePair,
    onProgress?: DownloadProgress,
  ): Promise<TranslatorInstance> {
    if (factory === null) {
      return Promise.reject(new Error("No on-device translator in this browser"));
    }

    const key = pairKey(pair);
    const existing = translators.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const created = factory
      .create({
        sourceLanguage: pair.source,
        targetLanguage: pair.target,
        monitor(monitor) {
          if (onProgress === undefined) {
            return;
          }

          monitor.addEventListener("downloadprogress", (event) => {
            onProgress(event.loaded);
          });
        },
      })
      .catch((error: unknown) => {
        // Not kept, so a failed download is retried on the next attempt rather
        // than poisoning the pair for the rest of the session.
        translators.delete(key);
        throw error;
      });

    translators.set(key, created);

    return created;
  }

  /** Appends to the queue and resolves with that task's own result. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);

    // The queue must survive a rejected task, so the chain tracks settlement
    // only and each caller keeps its own rejection.
    tail = run.catch(() => undefined);

    return run;
  }

  /** One `availability` call, with a thrown check treated as unavailable. */
  async function rawAvailability(
    source: string,
    target: string,
  ): Promise<TranslatorAvailability> {
    if (factory === null) {
      return "unavailable";
    }

    try {
      return await factory.availability({
        sourceLanguage: source,
        targetLanguage: target,
      });
    } catch {
      return "unavailable";
    }
  }

  /**
   * Works out how a pair can be served, preferring a direct pair.
   *
   * A pivot is only considered when neither end is already the pivot language:
   * if English to Tamil is unavailable, going English to English to Tamil cannot
   * help, and asking would just waste two more checks.
   */
  function resolveRoute(pair: LanguagePair): Promise<TranslationRoute> {
    const key = pairKey(pair);
    const existing = routes.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const resolved = (async (): Promise<TranslationRoute> => {
      if ((await rawAvailability(pair.source, pair.target)) !== "unavailable") {
        return { kind: "direct" };
      }

      if (
        pair.source === PIVOT_LANGUAGE ||
        pair.target === PIVOT_LANGUAGE
      ) {
        return { kind: "unavailable" };
      }

      const [toPivot, fromPivot] = await Promise.all([
        rawAvailability(pair.source, PIVOT_LANGUAGE),
        rawAvailability(PIVOT_LANGUAGE, pair.target),
      ]);

      if (toPivot !== "unavailable" && fromPivot !== "unavailable") {
        return { kind: "pivot", via: PIVOT_LANGUAGE };
      }

      return { kind: "unavailable" };
    })();

    routes.set(key, resolved);

    return resolved;
  }

  /** The legs a route needs translating over, in order. */
  function legsFor(
    pair: LanguagePair,
    route: TranslationRoute,
  ): LanguagePair[] {
    if (route.kind === "pivot") {
      return [
        { source: pair.source, target: route.via as LanguagePair["target"] },
        { source: route.via as LanguagePair["source"], target: pair.target },
      ];
    }

    return [pair];
  }

  return {
    isSupported(): boolean {
      return factory !== null;
    },

    async availability(pair: LanguagePair): Promise<TranslatorAvailability> {
      if (factory === null) {
        return "unavailable";
      }

      // Nothing to download to turn a language into itself.
      if (isSamePair(pair)) {
        return "available";
      }

      const route = await resolveRoute(pair);

      if (route.kind === "unavailable") {
        return "unavailable";
      }

      if (route.kind === "direct") {
        return rawAvailability(pair.source, pair.target);
      }

      // A pivot is only as ready as its least ready leg: if either pack still
      // has to download, the pair as a whole does.
      const [first, second] = await Promise.all([
        rawAvailability(pair.source, route.via),
        rawAvailability(route.via, pair.target),
      ]);

      return first === "available" && second === "available"
        ? "available"
        : "downloadable";
    },

    async prepare(
      pair: LanguagePair,
      onProgress?: DownloadProgress,
    ): Promise<boolean> {
      if (factory === null || isSamePair(pair)) {
        return false;
      }

      const route = await resolveRoute(pair);

      if (route.kind === "unavailable") {
        return false;
      }

      try {
        // Sequential rather than parallel: two concurrent pack downloads report
        // interleaved progress, which reads as a bar jumping backwards.
        for (const leg of legsFor(pair, route)) {
          await getTranslator(leg, onProgress);
        }

        return true;
      } catch {
        return false;
      }
    },

    async translate(
      text: string,
      pair: LanguagePair,
    ): Promise<TranslationOutcome> {
      if (factory === null) {
        return { ok: false, reason: "unsupported" };
      }

      // Same language, or nothing worth sending. Both are successes that happen
      // to need no work.
      if (isSamePair(pair) || text.trim().length === 0) {
        return { ok: true, text, viaPivot: false };
      }

      if (text.length > MAX_TRANSLATION_CHARS) {
        return { ok: false, reason: "too_long" };
      }

      const route = await resolveRoute(pair);

      if (route.kind === "unavailable") {
        return { ok: false, reason: "unavailable" };
      }

      const viaPivot = route.kind === "pivot";
      const key = cacheKey(pair, text);
      const cached = results.get(key);

      if (cached !== undefined) {
        try {
          return { ok: true, text: await cached, viaPivot };
        } catch {
          // Fall through and retry: the entry was already evicted below.
        }
      }

      const legs = legsFor(pair, route);

      const pending = enqueue(async () => {
        let current = text;

        // One hop for a direct pair, two for a pivot. Each leg reuses its own
        // cached translator, so a pivot costs no extra setup after the first use.
        for (const leg of legs) {
          const translator = await getTranslator(leg);
          current = await translator.translate(current);
        }

        return current;
      });

      results.set(key, pending);

      // Eviction rides a separate, fully-handled chain. Deriving a promise that
      // re-threw made the derived rejection unobserved — the caller awaits
      // `pending`, not the derivation — which surfaces as an unhandled rejection
      // and, under a strict runner, a failed process.
      void pending.catch(() => {
        results.delete(key);
      });

      evictOldestIfFull();

      try {
        return { ok: true, text: await pending, viaPivot };
      } catch (error: unknown) {
        return {
          ok: false,
          reason: "failed",
          detail: error instanceof Error ? error.message : undefined,
        };
      }
    },

    reset(): void {
      results.clear();
      translators.clear();
      routes.clear();
      tail = Promise.resolve();
    },
  };
}

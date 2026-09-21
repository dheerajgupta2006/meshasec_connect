/**
 * Speaking a translation aloud.
 *
 * This is what makes the feature usable by someone who cannot read: instead of
 * Tamil text on screen, they hear a Tamil voice. Everything up to this point —
 * recognition, translation, the data channel — already exists; this is the last
 * hop.
 *
 * ## The voice is not ours to provide
 *
 * `speechSynthesis` reads from voices installed on the *listener's operating
 * system*. Nothing this app or even Chrome does can conjure a Tamil voice onto a
 * machine that has none, and Indic voices beyond Hindi are frequently absent on
 * Windows. So the central export here is not `speak` but `speakableLanguages`:
 * callers must offer only what the device can actually say, rather than offering
 * the whole catalogue and falling silent.
 *
 * ## Why a queue that throws work away
 *
 * Synthesis speaks at human pace, but speech arrives as fast as someone talks. An
 * unbounded queue therefore drifts further behind with every sentence until the
 * listener is a minute adrift and the conversation has stopped being one. Falling
 * behind is worse than missing a sentence, so the queue is small and drops the
 * oldest unspoken utterance rather than growing.
 *
 * ## Why an injected factory
 *
 * The browser globals are passed in, so the voice matching, queue policy and
 * staleness rules below are testable under Node with a fake.
 */

import {
  SUPPORTED_LANGUAGES,
  speechLocaleFor,
  type LanguageCode,
} from "@/lib/i18n/languages";

/** The subset of `SpeechSynthesisVoice` this module reads. */
export interface VoiceLike {
  /** BCP 47 tag, which may be regional (`ta-IN`) or bare (`ta`). */
  lang: string;
  name: string;
  /**
   * True for a voice that runs on the device.
   *
   * Preferred over a network voice: it starts speaking sooner and keeps working
   * on a bad connection, which matters in the middle of a call.
   */
  localService: boolean;
}

export interface UtteranceLike {
  text: string;
  lang: string;
  voice: VoiceLike | null;
  rate: number;
  pitch: number;
  volume: number;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

export interface SynthesisLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  getVoices(): VoiceLike[];
  addEventListener(type: "voiceschanged", listener: () => void): void;
  removeEventListener(type: "voiceschanged", listener: () => void): void;
  readonly speaking: boolean;
}

export type UtteranceFactory = (text: string) => UtteranceLike;

/**
 * Reads the browser globals, or null when synthesis is unavailable.
 *
 * Both halves are required: `speechSynthesis` alone is useless without
 * `SpeechSynthesisUtterance` to hand it.
 */
export function readSynthesis(): {
  synthesis: SynthesisLike;
  createUtterance: UtteranceFactory;
} | null {
  const host = globalThis as {
    speechSynthesis?: unknown;
    SpeechSynthesisUtterance?: unknown;
  };

  const synthesis = host.speechSynthesis;
  const Utterance = host.SpeechSynthesisUtterance;

  if (
    synthesis === null ||
    synthesis === undefined ||
    typeof synthesis !== "object" ||
    typeof Utterance !== "function"
  ) {
    return null;
  }

  const record = synthesis as Record<string, unknown>;

  if (
    typeof record.speak !== "function" ||
    typeof record.cancel !== "function" ||
    typeof record.getVoices !== "function"
  ) {
    return null;
  }

  const Constructor = Utterance as new (text: string) => UtteranceLike;

  return {
    synthesis: synthesis as unknown as SynthesisLike,
    createUtterance: (text: string) => new Constructor(text),
  };
}

/**
 * Utterances held at once.
 *
 * Two: one being spoken and one waiting. A third means the speaker is outpacing
 * synthesis, at which point catching up matters more than completeness.
 */
export const MAX_QUEUE = 2;

/**
 * Age past which an utterance is no longer worth speaking.
 *
 * A translation of something said eight seconds ago is not a conversation, it is
 * a recap, and hearing it over whatever is being said now is worse than silence.
 */
export const MAX_UTTERANCE_AGE_MS = 8000;

/** Slightly quick, because the audio is already behind the speaker. */
const SPEECH_RATE = 1.05;

/** The bare language subtag, so `ta-IN` and `ta` compare equal. */
function baseLanguage(tag: string): string {
  const separator = tag.indexOf("-");

  return (separator === -1 ? tag : tag.slice(0, separator)).toLowerCase();
}

/**
 * Picks the best installed voice for a language, or null when none exists.
 *
 * Matching is on the base subtag, so a `ta-LK` voice serves Tamil when no `ta-IN`
 * one is installed: a regional accent is vastly better than silence.
 */
export function pickVoice(
  voices: readonly VoiceLike[],
  locale: string,
): VoiceLike | null {
  const wanted = baseLanguage(locale);
  const candidates = voices.filter(
    (voice) => baseLanguage(voice.lang) === wanted,
  );

  if (candidates.length === 0) {
    return null;
  }

  // Exact regional match first, then any local voice, then whatever is left.
  const exact = candidates.filter(
    (voice) => voice.lang.toLowerCase() === locale.toLowerCase(),
  );
  const pool = exact.length > 0 ? exact : candidates;

  return pool.find((voice) => voice.localService) ?? pool[0];
}

interface QueuedUtterance {
  text: string;
  locale: string;
  queuedAt: number;
  /** Identity of whoever said it, so callers can duck that participant. */
  speaker: string;
}

export interface SpeechEvents {
  /** Fires when an utterance begins, with the speaker it belongs to. */
  onStart?: (speaker: string) => void;
  /** Fires when the queue drains, so ducking can be released. */
  onIdle?: () => void;
}

export interface SpeechController {
  /** False when this browser cannot synthesise speech at all. */
  isSupported(): boolean;
  /**
   * Catalogue languages this device has a voice for.
   *
   * The list a picker should be built from. Empty until the voice list has
   * loaded — see `onVoicesReady`.
   */
  speakableLanguages(): LanguageCode[];
  /**
   * Registers a callback for when the voice list becomes available.
   *
   * `getVoices()` returns an empty array on first call in Chrome and is populated
   * asynchronously, so a picker built at mount would show nothing. Returns an
   * unsubscribe function.
   */
  onVoicesReady(listener: () => void): () => void;
  /** Queues a translated utterance. Silently ignored when no voice exists. */
  enqueue(text: string, language: LanguageCode, speaker: string): void;
  /** Stops immediately and drops everything queued. */
  stop(): void;
  /** Registers lifecycle callbacks, used to duck the original speaker. */
  setEvents(events: SpeechEvents): void;
}

export interface SpeechOptions {
  synthesis?: SynthesisLike | null;
  createUtterance?: UtteranceFactory;
  now?: () => number;
}

export function createSpeechController(
  options: SpeechOptions = {},
): SpeechController {
  const resolved =
    options.synthesis === undefined ? readSynthesis() : null;

  const synthesis =
    options.synthesis !== undefined
      ? options.synthesis
      : (resolved?.synthesis ?? null);

  const createUtterance =
    options.createUtterance ?? resolved?.createUtterance ?? null;

  const now = options.now ?? (() => Date.now());

  let events: SpeechEvents = {};
  const queue: QueuedUtterance[] = [];
  let active = false;

  /** Cached so a picker does not re-scan the voice list on every render. */
  let voices: readonly VoiceLike[] = synthesis?.getVoices() ?? [];

  const voiceListeners = new Set<() => void>();

  if (synthesis !== null) {
    synthesis.addEventListener("voiceschanged", () => {
      voices = synthesis.getVoices();
      voiceListeners.forEach((listener) => listener());
    });
  }

  function drain(): void {
    if (synthesis === null || createUtterance === null || active) {
      return;
    }

    const next = queue.shift();

    if (next === undefined) {
      events.onIdle?.();
      return;
    }

    // Too old to be part of the conversation any more. Skipped rather than
    // spoken over whatever is being said now.
    if (now() - next.queuedAt > MAX_UTTERANCE_AGE_MS) {
      drain();
      return;
    }

    const voice = pickVoice(voices, next.locale);

    if (voice === null) {
      drain();
      return;
    }

    const utterance = createUtterance(next.text);
    utterance.lang = next.locale;
    utterance.voice = voice;
    utterance.rate = SPEECH_RATE;
    utterance.pitch = 1;
    utterance.volume = 1;

    const finish = (): void => {
      active = false;
      drain();
    };

    utterance.onend = finish;
    // A failed utterance must not wedge the queue shut.
    utterance.onerror = finish;

    active = true;
    events.onStart?.(next.speaker);

    try {
      synthesis.speak(utterance);
    } catch {
      active = false;
      drain();
    }
  }

  return {
    isSupported(): boolean {
      return synthesis !== null && createUtterance !== null;
    },

    speakableLanguages(): LanguageCode[] {
      if (synthesis === null) {
        return [];
      }

      // Re-read rather than trusting the cache: Chrome populates the list lazily
      // and does not always fire the event before the first query.
      if (voices.length === 0) {
        voices = synthesis.getVoices();
      }

      const result: LanguageCode[] = [];

      SUPPORTED_LANGUAGES.forEach((language) => {
        if (pickVoice(voices, speechLocaleFor(language.code)) !== null) {
          result.push(language.code);
        }
      });

      return result;
    },

    onVoicesReady(listener: () => void): () => void {
      voiceListeners.add(listener);

      return () => {
        voiceListeners.delete(listener);
      };
    },

    enqueue(text: string, language: LanguageCode, speaker: string): void {
      if (synthesis === null || createUtterance === null) {
        return;
      }

      const cleaned = text.trim();

      if (cleaned.length === 0) {
        return;
      }

      const locale = speechLocaleFor(language);

      // Nothing installed for this language. Dropped quietly: the caller should
      // not have offered it, and a thrown error mid-call helps nobody.
      if (pickVoice(voices, locale) === null) {
        return;
      }

      queue.push({ text: cleaned, locale, queuedAt: now(), speaker });

      // Drops the oldest *unspoken* utterance. The one being spoken is untouched,
      // because cutting a sentence off mid-word to start another is worse than
      // losing one entirely.
      while (queue.length > MAX_QUEUE) {
        queue.shift();
      }

      drain();
    },

    stop(): void {
      queue.length = 0;
      active = false;

      try {
        synthesis?.cancel();
      } catch {
        // Nothing to cancel.
      }

      events.onIdle?.();
    },

    setEvents(next: SpeechEvents): void {
      events = next;
    },
  };
}

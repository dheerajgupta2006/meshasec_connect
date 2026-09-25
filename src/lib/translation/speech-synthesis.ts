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
  language: LanguageCode;
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

/** Fetches synthesised audio from the server, or null when it cannot. */
export type AudioFetcher = (
  text: string,
  language: LanguageCode,
) => Promise<string | null>;

/** Plays an audio URL to completion. Rejecting is treated as a skipped line. */
export type AudioPlayer = (url: string) => Promise<void>;

export interface SpeechController {
  /**
   * False when this browser can neither synthesise speech locally nor play
   * audio from the server.
   */
  isSupported(): boolean;
  /**
   * Catalogue languages that can be spoken, from a local voice or the server.
   *
   * The list a picker should be built from. Local voices are empty until the
   * browser has loaded them — see `onVoicesReady`.
   */
  speakableLanguages(): LanguageCode[];
  /**
   * Declares which languages the server can synthesise.
   *
   * Discovered asynchronously after mount, which is why it is set rather than
   * passed in. Languages here become speakable even when the device has no voice
   * of its own, which is the entire point: Windows ships no Telugu, Kannada,
   * Marathi or Malayalam voice, so on Chrome those languages are otherwise
   * unreachable no matter what this app does.
   */
  setCloudLanguages(languages: readonly LanguageCode[]): void;
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
  /** Server-side synthesis, used only for languages the device cannot speak. */
  fetchAudio?: AudioFetcher | null;
  playAudio?: AudioPlayer | null;
}

/** Requests synthesised audio from this app's own endpoint. */
function defaultFetchAudio(): AudioFetcher {
  return async (text, language) => {
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language }),
      });

      if (!response.ok) {
        return null;
      }

      // An object URL rather than a data URL: the clip is handed straight to an
      // `Audio` element without being base64-inflated through a string first.
      return URL.createObjectURL(await response.blob());
    } catch {
      return null;
    }
  };
}

/** Plays a clip through an `Audio` element, releasing the URL afterwards. */
function defaultPlayAudio(): AudioPlayer {
  return (url) =>
    new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);

      const done = (settle: () => void) => () => {
        // Revoked on both paths: an object URL held forever is a memory leak that
        // grows with every sentence spoken.
        URL.revokeObjectURL(url);
        settle();
      };

      audio.onended = done(resolve);
      audio.onerror = done(() => reject(new Error("playback failed")));

      void audio.play().catch(
        done(() => reject(new Error("playback rejected"))),
      );
    });
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

  const fetchAudio =
    options.fetchAudio === undefined ? defaultFetchAudio() : options.fetchAudio;

  const playAudio =
    options.playAudio === undefined ? defaultPlayAudio() : options.playAudio;

  let events: SpeechEvents = {};
  const queue: QueuedUtterance[] = [];
  let active = false;

  /** Languages the server can cover. Set once discovered. */
  let cloudLanguages: readonly LanguageCode[] = [];

  /** True when a clip can be fetched and played, whatever the device has. */
  const canUseCloud = fetchAudio !== null && playAudio !== null;

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
    if (active) {
      return;
    }

    const next = queue.shift();

    if (next === undefined) {
      notifyIdle();
      return;
    }

    // Too old to be part of the conversation any more. Skipped rather than
    // spoken over whatever is being said now.
    if (now() - next.queuedAt > MAX_UTTERANCE_AGE_MS) {
      drain();
      return;
    }

    const voice =
      synthesis === null || createUtterance === null
        ? null
        : pickVoice(voices, next.locale);

    // A local voice is always preferred: it is free, starts instantly and works
    // offline. The server is only for languages the device cannot speak at all.
    if (voice !== null) {
      speakLocally(next, voice);
      return;
    }

    if (canUseCloud && cloudLanguages.includes(next.language)) {
      void speakFromServer(next);
      return;
    }

    drain();
  }

  /** Runs one utterance through the browser's own synthesiser. */
  function speakLocally(next: QueuedUtterance, voice: VoiceLike): void {
    if (synthesis === null || createUtterance === null) {
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

    // Guarded, and before nothing important: the consumer's callback reaches into
    // LiveKit to duck the speaker, and a throw there previously escaped `drain`
    // before `speak` was ever reached — producing total silence from a fault that
    // had nothing to do with synthesis.
    try {
      events.onStart?.(next.speaker);
    } catch {
      // Ducking is a nicety; speaking is the point.
    }

    try {
      synthesis.speak(utterance);
    } catch {
      active = false;
      drain();
    }
  }

  /**
   * Fetches a clip from the server and plays it.
   *
   * This is what makes dubbing browser-independent: playing audio needs no
   * installed voice, so a Chrome user on Windows can hear Telugu even though
   * Windows has no Telugu voice.
   *
   * Marked active before the fetch so a burst of captions cannot start several
   * overlapping requests and then talk over each other.
   */
  async function speakFromServer(next: QueuedUtterance): Promise<void> {
    if (fetchAudio === null || playAudio === null) {
      drain();
      return;
    }

    active = true;

    try {
      events.onStart?.(next.speaker);
    } catch {
      // Ducking is a nicety; speaking is the point.
    }

    try {
      const url = await fetchAudio(next.text, next.language);

      // Re-checked after the round trip: the listener may have turned dubbing off
      // while this was in flight, and `stop` clears the queue but cannot cancel a
      // fetch already awaiting.
      if (url === null) {
        active = false;
        drain();
        return;
      }

      await playAudio(url);
    } catch {
      // A failed clip costs one sentence, not the queue.
    } finally {
      active = false;
      drain();
    }
  }

  /** Notifies idle without letting a consumer's throw break the queue. */
  function notifyIdle(): void {
    try {
      events.onIdle?.();
    } catch {
      // Same reasoning as `onStart`.
    }
  }

  return {
    isSupported(): boolean {
      // Either route is enough. Audio playback needs no installed voice, which is
      // exactly why the server path exists.
      return (synthesis !== null && createUtterance !== null) || canUseCloud;
    },

    speakableLanguages(): LanguageCode[] {
      // Re-read rather than trusting the cache: Chrome populates the list lazily
      // and does not always fire the event before the first query.
      if (synthesis !== null && voices.length === 0) {
        voices = synthesis.getVoices();
      }

      const result: LanguageCode[] = [];

      SUPPORTED_LANGUAGES.forEach((language) => {
        const hasLocal =
          synthesis !== null &&
          createUtterance !== null &&
          pickVoice(voices, speechLocaleFor(language.code)) !== null;

        const hasCloud = canUseCloud && cloudLanguages.includes(language.code);

        if (hasLocal || hasCloud) {
          result.push(language.code);
        }
      });

      return result;
    },

    setCloudLanguages(languages: readonly LanguageCode[]): void {
      cloudLanguages = languages;

      // The picker is built from `speakableLanguages`, so it has to be told the
      // set just grew.
      voiceListeners.forEach((listener) => listener());
    },

    onVoicesReady(listener: () => void): () => void {
      voiceListeners.add(listener);

      return () => {
        voiceListeners.delete(listener);
      };
    },

    enqueue(text: string, language: LanguageCode, speaker: string): void {
      const cleaned = text.trim();

      if (cleaned.length === 0) {
        return;
      }

      const locale = speechLocaleFor(language);

      const hasLocal =
        synthesis !== null &&
        createUtterance !== null &&
        pickVoice(voices, locale) !== null;

      const hasCloud = canUseCloud && cloudLanguages.includes(language);

      // No route for this language. Dropped quietly: the caller should not have
      // offered it, and throwing mid-call helps nobody.
      if (!hasLocal && !hasCloud) {
        return;
      }

      queue.push({ text: cleaned, language, locale, queuedAt: now(), speaker });

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

      notifyIdle();
    },

    setEvents(next: SpeechEvents): void {
      events = next;
    },
  };
}

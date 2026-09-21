/**
 * Microphone dictation for live captions.
 *
 * Wraps the Web Speech API, which Chrome exposes as `webkitSpeechRecognition`.
 * It is free and needs no key, which is what makes captions possible at no
 * operating cost.
 *
 * ## The privacy difference that matters
 *
 * Unlike the translator and the language detector, this is **not** on-device.
 * Chrome streams microphone audio to Google's speech service and returns text.
 * So while a translated caption is produced locally, the *audio* that produced it
 * left the machine. Captions must therefore be explicitly opt-in with a visible
 * indicator, never quietly switched on. Callers are responsible for that; this
 * module only reports what it is doing.
 *
 * ## Why this is more than a thin wrapper
 *
 * The raw API is awkward in three ways that all have to be handled here or they
 * surface as bugs:
 *
 *  1. It stops on its own after a few seconds of silence *even with*
 *     `continuous = true`, so staying live means restarting on every `end`.
 *  2. Its errors mix the fatal with the routine. A denied permission must stop
 *     everything; "no speech heard" is completely normal and must not.
 *  3. Restarting too eagerly after a real failure spins into a tight loop that
 *     pins the CPU and hammers the speech endpoint, so retries need backoff.
 *
 * ## Why injected dependencies
 *
 * The constructor and the timer are passed in, so the restart, backoff and error
 * classification logic below is testable under Node against a fake recogniser
 * with no browser and no real clock.
 */

/** One alternative for one stretch of speech. */
interface SpeechAlternativeLike {
  transcript: string;
}

interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternativeLike;
}

interface SpeechResultListLike {
  readonly length: number;
  [index: number]: SpeechResultLike;
}

export interface SpeechResultEventLike {
  /** Index of the first result that changed in this event. */
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
}

export interface SpeechErrorEventLike {
  readonly error: string;
}

/** The subset of `SpeechRecognition` this module uses. */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/**
 * Reads the browser constructor, or null when the API is absent.
 *
 * Chrome ships it prefixed; the unprefixed name is checked first so a browser
 * that later standardises it is preferred automatically.
 */
export function readSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const host = globalThis as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };

  const candidate = host.SpeechRecognition ?? host.webkitSpeechRecognition;

  return typeof candidate === "function"
    ? (candidate as SpeechRecognitionConstructor)
    : null;
}

export type DictationFailure =
  /** The user refused the microphone, or policy blocks it. Terminal. */
  | "denied"
  /** No usable input device. Terminal. */
  | "no-microphone"
  /** The speech service is unreachable. Retried with backoff. */
  | "network"
  /** Retries exhausted, or an unrecognised error repeated. Terminal. */
  | "failed";

export type DictationState = "idle" | "starting" | "listening" | "failed";

export interface DictationHandlers {
  /**
   * Called with the text recognised so far.
   *
   * `isFinal` false means the recogniser may still revise it, so callers should
   * replace rather than append. A true value ends that utterance: the next
   * callback begins a new one.
   */
  onTranscript: (text: string, isFinal: boolean) => void;
  onStateChange?: (state: DictationState) => void;
  /** Terminal failures only; routine silence never reaches here. */
  onFailure?: (failure: DictationFailure) => void;
}

export interface DictationController {
  /** False when this browser has no speech recognition at all. */
  isSupported(): boolean;
  state(): DictationState;
  /**
   * Begins listening in `locale`, which must be a regional tag such as `te-IN`.
   *
   * Should be called from a user gesture so the permission prompt is attributed
   * to something the user did. Calling it while already listening in the same
   * locale does nothing; a different locale restarts.
   */
  start(locale: string, handlers: DictationHandlers): void;
  /** Stops listening. Safe to call when already stopped. */
  stop(): void;
}

/** Delay before restarting after a clean end. Long enough to avoid a tight loop. */
const RESTART_DELAY_MS = 250;

/** Ceiling for the backoff, so a long outage still recovers eventually. */
const MAX_RESTART_DELAY_MS = 8000;

/**
 * Consecutive failures tolerated before giving up.
 *
 * Applies only to errors; a clean end after silence resets the count, so a long
 * quiet call never exhausts this.
 */
const MAX_CONSECUTIVE_FAILURES = 6;

/** Errors that mean "stop and tell the user", rather than "try again". */
function classifyFatal(error: string): DictationFailure | null {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "denied";
  }

  if (error === "audio-capture") {
    return "no-microphone";
  }

  return null;
}

export interface DictationOptions {
  create?: SpeechRecognitionConstructor | null;
  /** Injected so backoff is testable without a real clock. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createDictationController(
  options: DictationOptions = {},
): DictationController {
  const Recognition =
    options.create === undefined
      ? readSpeechRecognitionConstructor()
      : options.create;

  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) =>
      setTimeout(callback, delayMs) as unknown);

  const cancel =
    options.cancel ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  let recognition: SpeechRecognitionLike | null = null;
  let handlers: DictationHandlers | null = null;
  let currentLocale = "";
  let state: DictationState = "idle";

  /** True between `start` and `stop`, regardless of whether a session is live. */
  let wanted = false;

  let consecutiveFailures = 0;
  let restartHandle: unknown = null;

  function setState(next: DictationState): void {
    if (state === next) {
      return;
    }

    state = next;
    handlers?.onStateChange?.(next);
  }

  function clearPendingRestart(): void {
    if (restartHandle !== null) {
      cancel(restartHandle);
      restartHandle = null;
    }
  }

  function fail(failure: DictationFailure): void {
    wanted = false;
    clearPendingRestart();
    teardown();
    setState("failed");
    handlers?.onFailure?.(failure);
  }

  function teardown(): void {
    if (recognition === null) {
      return;
    }

    // Detached before aborting: `abort` synchronously fires `end`, which would
    // otherwise be read as an unexpected stop and schedule a restart.
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.onstart = null;

    try {
      recognition.abort();
    } catch {
      // Already dead. Nothing to release.
    }

    recognition = null;
  }

  function handleResult(event: SpeechResultEventLike): void {
    let finalText = "";
    let interimText = "";

    for (
      let index = event.resultIndex;
      index < event.results.length;
      index += 1
    ) {
      const result = event.results[index];

      if (result === undefined || result.length === 0) {
        continue;
      }

      const alternative = result[0];

      if (alternative === undefined) {
        continue;
      }

      if (result.isFinal) {
        finalText += alternative.transcript;
      } else {
        interimText += alternative.transcript;
      }
    }

    // Any recognised speech proves the pipeline works end to end, so a past
    // network wobble should not count against the retry budget any more.
    if (finalText.length > 0 || interimText.length > 0) {
      consecutiveFailures = 0;
    }

    // `resultIndex` is the first *changed* result, so this loop never re-reads
    // sentences already emitted earlier in the session.
    if (finalText.trim().length > 0) {
      handlers?.onTranscript(finalText.trim(), true);
    }

    if (interimText.trim().length > 0) {
      handlers?.onTranscript(interimText.trim(), false);
    }
  }

  function scheduleRestart(delayMs: number): void {
    clearPendingRestart();

    restartHandle = schedule(() => {
      restartHandle = null;

      if (!wanted) {
        return;
      }

      openSession();
    }, delayMs);
  }

  function handleEnd(): void {
    recognition = null;

    if (!wanted) {
      setState("idle");
      return;
    }

    // The expected case: Chrome ends the session after a few seconds of silence
    // even in continuous mode, so staying live means reopening.
    setState("starting");
    scheduleRestart(RESTART_DELAY_MS);
  }

  function handleError(event: SpeechErrorEventLike): void {
    const fatal = classifyFatal(event.error);

    if (fatal !== null) {
      fail(fatal);
      return;
    }

    // Routine and not worth reporting: the user simply did not speak, or we
    // stopped the session ourselves.
    if (event.error === "no-speech" || event.error === "aborted") {
      return;
    }

    consecutiveFailures += 1;

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      fail(event.error === "network" ? "network" : "failed");
      return;
    }

    // Exponential backoff, so an unreachable speech service is retried a few
    // times at widening intervals instead of in a tight loop.
    const delay = Math.min(
      RESTART_DELAY_MS * 2 ** consecutiveFailures,
      MAX_RESTART_DELAY_MS,
    );

    clearPendingRestart();

    if (wanted) {
      scheduleRestart(delay);
    }
  }

  function openSession(): void {
    if (Recognition === null || !wanted) {
      return;
    }

    teardown();

    let instance: SpeechRecognitionLike;

    try {
      instance = new Recognition();
    } catch {
      fail("failed");
      return;
    }

    instance.lang = currentLocale;
    // Continuous so a pause between sentences does not end the caption stream,
    // and interim so text appears while it is still being spoken rather than
    // only once a sentence lands.
    instance.continuous = true;
    instance.interimResults = true;
    // Only the best alternative is ever read, so asking for more is wasted work.
    instance.maxAlternatives = 1;

    instance.onstart = () => {
      setState("listening");
    };
    instance.onresult = handleResult;
    instance.onerror = handleError;
    instance.onend = handleEnd;

    recognition = instance;

    try {
      instance.start();
    } catch {
      // `start` throws `InvalidStateError` when a session is already running.
      // Treated as a transient failure so it is retried rather than surfaced.
      recognition = null;
      handleError({ error: "invalid-state" });
    }
  }

  return {
    isSupported(): boolean {
      return Recognition !== null;
    },

    state(): DictationState {
      return state;
    },

    start(locale: string, nextHandlers: DictationHandlers): void {
      handlers = nextHandlers;

      if (Recognition === null) {
        setState("failed");
        nextHandlers.onFailure?.("failed");
        return;
      }

      // Already listening in this language: nothing to do. Restarting here would
      // drop the utterance in progress for no reason.
      if (wanted && locale === currentLocale) {
        return;
      }

      currentLocale = locale;
      wanted = true;
      consecutiveFailures = 0;
      setState("starting");
      openSession();
    },

    stop(): void {
      wanted = false;
      clearPendingRestart();
      teardown();
      consecutiveFailures = 0;
      setState("idle");
    },
  };
}

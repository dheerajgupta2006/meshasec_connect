"use client";

/**
 * Live translated captions for a meeting.
 *
 * Each participant chooses two things independently: the language they *speak*,
 * which tells recognition what to listen for, and the language they want to
 * *read*, which is private to them. A speaker broadcasts their words once, in
 * their own language, and every listener translates that locally into whatever
 * they chose.
 *
 * That receiver-side fan-out is the whole design. It means one broadcast serves a
 * room holding any number of languages, a listener can switch language instantly
 * without asking anyone to resend anything, and nobody learns what language
 * anyone else is reading in. The alternative — the speaker translating into every
 * language present — would multiply traffic by the number of languages and make
 * every listener's choice public.
 *
 * ## Costs nothing, but not entirely private
 *
 * Translation and language detection run on-device. Speech recognition does not:
 * Chrome streams microphone audio to Google's speech service. So captions are
 * opt-in per participant, announced to the room while active, and never started
 * on someone's behalf. See `lib/translation/speech-recognition.ts`.
 *
 * ## Nothing is stored
 *
 * Captions live in the room and die with it, exactly as polls and raised hands
 * do — a conversation is not a transcript unless everyone agreed to one. The cost
 * is a catch-up path: a client joining mid-call asks for a snapshot and whoever
 * has state answers.
 */

import { useDataChannel, useRoomContext } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import * as React from "react";

import {
  DEFAULT_LANGUAGE,
  isLanguageCode,
  speechLocaleFor,
  type LanguageCode,
} from "@/lib/i18n/languages";
import {
  EMPTY_CAPTIONS_STATE,
  newCaptionId,
  parseCaptionsMessage,
  reduceCaptions,
  visibleSegments,
  type CaptionSegment,
  type CaptionsMessage,
  type CaptionsState,
} from "@/lib/meetings/caption-state";
import {
  createDictationController,
  type DictationController,
  type DictationFailure,
  type DictationState,
} from "@/lib/translation/speech-recognition";
import {
  createTranslationEngine,
  type TranslationEngine,
} from "@/lib/translation/on-device";

/**
 * Captions get their own topic, separate from `meshasec-room-ux` and
 * `meshasec-room-polls`. LiveKit has one data channel, so a topic is only a
 * filter — this does not open a second channel, it keeps a high-frequency
 * caption stream out of the reaction and poll handlers.
 */
const CAPTIONS_TOPIC = "meshasec-room-captions";

/** Longest payload worth attempting to parse. Remote input is untrusted. */
const MAX_PAYLOAD_BYTES = 4096;

/** Delay before a late joiner asks for history, matching the polls provider. */
const SNAPSHOT_REQUEST_DELAY_MS = 600;

/**
 * How long to wait before translating.
 *
 * Interim results are revised on almost every syllable. Translating each revision
 * would flicker, and because the translator processes requests sequentially it
 * would also starve the finished sentences queued behind it. Finals are translated
 * on the next pass regardless; this only paces the in-progress one.
 */
const TRANSLATE_DEBOUNCE_MS = 250;

/** Persisted across meetings: a person's languages rarely change per call. */
const SPEAK_STORAGE_KEY = "meeting:speakIn";
const READ_STORAGE_KEY = "meeting:readIn";

export interface CaptionEntry {
  segment: CaptionSegment;
  /**
   * Translation into the reader's language, or null when none is needed, none is
   * possible, or it has not arrived yet.
   */
  translation: string | null;
  /**
   * True when the translation went through English in two hops.
   *
   * Common for pairs like Telugu to Tamil, which the on-device translator may not
   * serve directly. Two translations compound their errors, so it is worth
   * showing rather than hiding.
   */
  viaPivot: boolean;
  /** True for the local participant's own speech. */
  isLocal: boolean;
}

interface CaptionsContextValue {
  /** Captions worth rendering, oldest first. */
  entries: readonly CaptionEntry[];
  /** False when this browser cannot run speech recognition at all. */
  canCaption: boolean;
  /** False when this browser has no on-device translator. */
  canTranslate: boolean;
  isCaptioning: boolean;
  dictationState: DictationState;
  failure: DictationFailure | null;
  /** Must be called from a user gesture: it prompts for the microphone. */
  startCaptioning: () => void;
  stopCaptioning: () => void;
  /** The language the local participant speaks, driving recognition. */
  speakLanguage: LanguageCode;
  setSpeakLanguage: (language: LanguageCode) => void;
  /** The language the local participant reads. Null shows originals only. */
  readLanguage: LanguageCode | null;
  setReadLanguage: (language: LanguageCode | null) => void;
  /** True while a translation language pack is downloading. */
  isPreparing: boolean;
  /** Anyone in the room currently broadcasting captions, by identity. */
  activeSpeakers: readonly string[];
}

const CaptionsContext = React.createContext<CaptionsContextValue | null>(null);

export function useCaptions(): CaptionsContextValue {
  const value = React.useContext(CaptionsContext);

  if (value === null) {
    throw new Error("useCaptions must be used inside CaptionsProvider");
  }

  return value;
}

function readStoredLanguage(key: string): LanguageCode | null {
  try {
    const stored = window.localStorage.getItem(key);

    return isLanguageCode(stored) ? stored : null;
  } catch {
    // Private browsing or a blocked store. Defaults apply.
    return null;
  }
}

function writeStoredLanguage(key: string, value: LanguageCode | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // A failed write only costs the preference on reload.
  }
}

/** What a translation was produced from, so staleness is detectable. */
interface TranslationEntry {
  text: string;
  sourceLanguage: LanguageCode;
  target: LanguageCode;
  translated: string;
  /** True when it went through English because no direct pair exists. */
  viaPivot: boolean;
}

export function CaptionsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const room = useRoomContext();

  const [state, setState] = React.useState<CaptionsState>(EMPTY_CAPTIONS_STATE);
  const [isCaptioning, setIsCaptioning] = React.useState(false);
  const [dictationState, setDictationState] =
    React.useState<DictationState>("idle");
  const [failure, setFailure] = React.useState<DictationFailure | null>(null);
  const [speakLanguage, setSpeakLanguageState] =
    React.useState<LanguageCode>(DEFAULT_LANGUAGE);
  const [readLanguage, setReadLanguageState] =
    React.useState<LanguageCode | null>(null);
  const [isPreparing, setIsPreparing] = React.useState(false);
  const [translations, setTranslations] = React.useState<
    Map<string, TranslationEntry>
  >(() => new Map<string, TranslationEntry>());

  /**
   * Engines are built in an effect, not during render.
   *
   * This tree also renders on the server, where the browser globals are absent.
   * Building them during render would make the server and the first client render
   * disagree about what is supported, which is a hydration mismatch.
   */
  const [engine, setEngine] = React.useState<TranslationEngine | null>(null);
  const dictationRef = React.useRef<DictationController | null>(null);
  const [canCaption, setCanCaption] = React.useState(false);

  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const translationsRef = React.useRef(translations);
  React.useEffect(() => {
    translationsRef.current = translations;
  }, [translations]);

  /** Id of the utterance in progress, or null between utterances. */
  const utteranceIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setEngine(createTranslationEngine());

    const controller = createDictationController();
    dictationRef.current = controller;
    setCanCaption(controller.isSupported());

    setSpeakLanguageState(readStoredLanguage(SPEAK_STORAGE_KEY) ?? DEFAULT_LANGUAGE);
    setReadLanguageState(readStoredLanguage(READ_STORAGE_KEY));

    return () => {
      controller.stop();
      dictationRef.current = null;
    };
  }, []);

  const handleIncoming = React.useCallback(
    (payload: Uint8Array, from: Participant | undefined) => {
      if (from === undefined || from.identity.length === 0) {
        return;
      }

      if (payload.byteLength > MAX_PAYLOAD_BYTES) {
        return;
      }

      let message: CaptionsMessage | null;

      try {
        message = parseCaptionsMessage(
          JSON.parse(new TextDecoder().decode(payload)),
        );
      } catch {
        return;
      }

      if (message === null) {
        return;
      }

      // A newcomer asking for history. Answered only when there is something to
      // send, so an empty room does not produce a burst of empty snapshots.
      if (message.kind === "snapshot_request") {
        const current = stateRef.current;

        if (current.segments.length === 0) {
          return;
        }

        const reply = new TextEncoder().encode(
          JSON.stringify({ kind: "snapshot", state: current }),
        );

        void sendRef.current(reply, { reliable: true }).catch(() => undefined);
        return;
      }

      // The sender's identity comes from the packet, never the payload. For a
      // transcript this matters more than it does for a poll vote: otherwise
      // anyone could put words in somebody else's mouth.
      setState((current) => reduceCaptions(current, message, from.identity));
    },
    [],
  );

  const handleIncomingRef = React.useRef(handleIncoming);
  React.useEffect(() => {
    handleIncomingRef.current = handleIncoming;
  }, [handleIncoming]);

  const onDataMessage = React.useCallback(
    (message: { payload: Uint8Array; from?: Participant }) => {
      handleIncomingRef.current(message.payload, message.from);
    },
    [],
  );

  const { send } = useDataChannel(CAPTIONS_TOPIC, onDataMessage);

  const sendRef = React.useRef(send);
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const broadcast = React.useCallback((message: CaptionsMessage) => {
    const payload = new TextEncoder().encode(JSON.stringify(message));

    // Unreliable would be defensible for interim text, but a dropped *final*
    // would leave a half-sentence on screen permanently, so everything is
    // reliable and ordering is preserved.
    void sendRef.current(payload, { reliable: true }).catch(() => undefined);
  }, []);

  // Ask for history once on join. Harmless if nobody answers.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      broadcast({ kind: "snapshot_request" });
    }, SNAPSHOT_REQUEST_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [broadcast]);

  const localIdentity = room.localParticipant.identity;

  const applyLocally = React.useCallback(
    (message: CaptionsMessage) => {
      if (localIdentity.length === 0) {
        return;
      }

      setState((current) => reduceCaptions(current, message, localIdentity));
    },
    [localIdentity],
  );

  /** Mirrors state the dictation callback needs without re-registering it. */
  const speakLanguageRef = React.useRef(speakLanguage);
  React.useEffect(() => {
    speakLanguageRef.current = speakLanguage;
  }, [speakLanguage]);

  const emitTranscript = React.useCallback(
    (text: string, isFinal: boolean) => {
      if (utteranceIdRef.current === null) {
        utteranceIdRef.current = newCaptionId();
      }

      const message: CaptionsMessage = {
        kind: "caption",
        at: Date.now(),
        caption: {
          id: utteranceIdRef.current,
          speakerName: room.localParticipant.name ?? "",
          sourceLanguage: speakLanguageRef.current,
          text,
          isFinal,
        },
      };

      // Applied locally as well as broadcast, so the speaker sees their own words
      // with no round trip.
      applyLocally(message);
      broadcast(message);

      // A committed sentence closes the utterance; the next result starts a new
      // one rather than reopening this.
      if (isFinal) {
        utteranceIdRef.current = null;
      }
    },
    [applyLocally, broadcast, room.localParticipant],
  );

  const emitTranscriptRef = React.useRef(emitTranscript);
  React.useEffect(() => {
    emitTranscriptRef.current = emitTranscript;
  }, [emitTranscript]);

  const startCaptioning = React.useCallback(() => {
    const controller = dictationRef.current;

    if (controller === null || !controller.isSupported()) {
      return;
    }

    setFailure(null);
    setIsCaptioning(true);

    controller.start(speechLocaleFor(speakLanguageRef.current), {
      onTranscript: (text, isFinal) => {
        emitTranscriptRef.current(text, isFinal);
      },
      onStateChange: setDictationState,
      onFailure: (next) => {
        setFailure(next);
        setIsCaptioning(false);
      },
    });
  }, []);

  const stopCaptioning = React.useCallback(() => {
    dictationRef.current?.stop();
    setIsCaptioning(false);
    utteranceIdRef.current = null;

    // Discards this speaker's uncommitted tail everywhere, so a half-recognised
    // phrase does not sit on screen after they stop.
    const message: CaptionsMessage = { kind: "caption_stopped" };
    applyLocally(message);
    broadcast(message);
  }, [applyLocally, broadcast]);

  const setSpeakLanguage = React.useCallback(
    (language: LanguageCode) => {
      setSpeakLanguageState(language);
      speakLanguageRef.current = language;
      writeStoredLanguage(SPEAK_STORAGE_KEY, language);

      // Recognition is locked to a language when it starts, so a change only
      // takes effect by restarting it.
      const controller = dictationRef.current;

      if (controller !== null && isCaptioning) {
        controller.start(speechLocaleFor(language), {
          onTranscript: (text, isFinal) => {
            emitTranscriptRef.current(text, isFinal);
          },
          onStateChange: setDictationState,
          onFailure: (next) => {
            setFailure(next);
            setIsCaptioning(false);
          },
        });
      }
    },
    [isCaptioning],
  );

  const setReadLanguage = React.useCallback(
    (language: LanguageCode | null) => {
      setReadLanguageState(language);
      writeStoredLanguage(READ_STORAGE_KEY, language);
      setIsPreparing(false);
    },
    [],
  );

  const segments = React.useMemo(() => visibleSegments(state), [state]);

  /**
   * Translates what is on screen into the reader's language.
   *
   * Debounced as a whole rather than per segment: recognition revises interim
   * text constantly, and the translator is sequential, so pacing the pass keeps
   * in-progress speech from starving finished sentences.
   */
  React.useEffect(() => {
    if (engine === null || !engine.isSupported() || readLanguage === null) {
      return;
    }

    let cancelled = false;
    const target = readLanguage;
    const activeEngine = engine;

    const timer = window.setTimeout(() => {
      void (async () => {
        const pending = segments.filter((segment) => {
          if (segment.sourceLanguage === target) {
            return false;
          }

          const existing = translationsRef.current.get(segment.id);

          return (
            existing === undefined ||
            existing.text !== segment.text ||
            existing.target !== target
          );
        });

        if (pending.length === 0) {
          return;
        }

        // Distinct directions actually needed, so a first run downloads only the
        // packs in use rather than every pair in the catalog.
        const sources: LanguageCode[] = [];

        pending.forEach((segment) => {
          if (!sources.includes(segment.sourceLanguage)) {
            sources.push(segment.sourceLanguage);
          }
        });

        for (const source of sources) {
          if (cancelled) {
            return;
          }

          const pair = { source, target };
          const availability = await activeEngine.availability(pair);

          if (cancelled) {
            return;
          }

          if (availability === "unavailable") {
            continue;
          }

          if (availability !== "available") {
            setIsPreparing(true);
          }

          await activeEngine.prepare(pair);

          if (cancelled) {
            return;
          }
        }

        setIsPreparing(false);

        for (const segment of pending) {
          if (cancelled) {
            return;
          }

          const outcome = await activeEngine.translate(segment.text, {
            source: segment.sourceLanguage,
            target,
          });

          if (cancelled || !outcome.ok) {
            continue;
          }

          const translated = outcome.text;
          const { viaPivot } = outcome;

          setTranslations((current) => {
            const next = new Map(current);

            next.set(segment.id, {
              text: segment.text,
              sourceLanguage: segment.sourceLanguage,
              target,
              translated,
              viaPivot,
            });

            return next;
          });
        }
      })();
    }, TRANSLATE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [engine, readLanguage, segments]);

  const entries = React.useMemo<readonly CaptionEntry[]>(() => {
    return segments.map((segment) => {
      const entry = translations.get(segment.id);

      // Only a translation produced from this exact text, into the language
      // currently selected, is safe to show. Anything else would be mislabelled.
      const fresh =
        entry !== undefined &&
        entry.text === segment.text &&
        entry.target === readLanguage &&
        readLanguage !== null &&
        segment.sourceLanguage !== readLanguage;

      return {
        segment,
        translation: fresh ? entry.translated : null,
        viaPivot: fresh ? entry.viaPivot : false,
        isLocal: segment.speaker === localIdentity,
      };
    });
  }, [segments, translations, readLanguage, localIdentity]);

  const activeSpeakers = React.useMemo(() => {
    const identities: string[] = [];

    segments.forEach((segment) => {
      if (!segment.isFinal && !identities.includes(segment.speaker)) {
        identities.push(segment.speaker);
      }
    });

    return identities;
  }, [segments]);

  const value = React.useMemo<CaptionsContextValue>(
    () => ({
      entries,
      canCaption,
      canTranslate: engine !== null && engine.isSupported(),
      isCaptioning,
      dictationState,
      failure,
      startCaptioning,
      stopCaptioning,
      speakLanguage,
      setSpeakLanguage,
      readLanguage,
      setReadLanguage,
      isPreparing,
      activeSpeakers,
    }),
    [
      entries,
      canCaption,
      engine,
      isCaptioning,
      dictationState,
      failure,
      startCaptioning,
      stopCaptioning,
      speakLanguage,
      setSpeakLanguage,
      readLanguage,
      setReadLanguage,
      isPreparing,
      activeSpeakers,
    ],
  );

  return (
    <CaptionsContext.Provider value={value}>
      {children}
    </CaptionsContext.Provider>
  );
}

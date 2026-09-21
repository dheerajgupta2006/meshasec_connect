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
  createSpeechController,
  type SpeechController,
} from "@/lib/translation/speech-synthesis";
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
const LISTEN_STORAGE_KEY = "meeting:listenIn";

/**
 * How far the original voice drops while a translation is spoken over it.
 *
 * Not to zero. Hearing that the other person is still talking, and their tone
 * and when they stop, is worth keeping even when the words are unintelligible to
 * the listener.
 */
const DUCKED_VOLUME = 0.15;

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
  /**
   * The language the local participant wants spoken aloud, or null for silence.
   *
   * Independent of `readLanguage`: someone may want both, and someone who cannot
   * read wants only this.
   */
  listenLanguage: LanguageCode | null;
  setListenLanguage: (language: LanguageCode | null) => void;
  /**
   * Catalogue languages this device actually has a voice for.
   *
   * The list the listen picker must be built from. Voices come from the operating
   * system, so this is frequently a small subset — Indic voices beyond Hindi are
   * often absent on Windows — and offering a language with no voice would fail
   * silently.
   */
  speakableLanguages: readonly LanguageCode[];
  /** False when this browser cannot synthesise speech at all. */
  canSpeak: boolean;
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

/**
 * Keys a translation by segment *and* target language.
 *
 * Both are needed because reading and listening can be set to different
 * languages, and keying on the segment alone meant whichever was translated first
 * won and the other was never served.
 */
function translationKey(segmentId: string, target: LanguageCode): string {
  return `${segmentId}\u0000${target}`;
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
  const [listenLanguage, setListenLanguageState] =
    React.useState<LanguageCode | null>(null);
  const [speakableLanguages, setSpeakableLanguages] = React.useState<
    readonly LanguageCode[]
  >([]);
  const [canSpeak, setCanSpeak] = React.useState(false);
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
  const speechRef = React.useRef<SpeechController | null>(null);
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

    const speech = createSpeechController();
    speechRef.current = speech;
    setCanSpeak(speech.isSupported());
    setSpeakableLanguages(speech.speakableLanguages());

    // Chrome returns an empty voice list on first call and fills it in later, so
    // the picker has to be rebuilt when that happens or it stays empty forever.
    const unsubscribe = speech.onVoicesReady(() => {
      setSpeakableLanguages(speech.speakableLanguages());
    });

    setSpeakLanguageState(readStoredLanguage(SPEAK_STORAGE_KEY) ?? DEFAULT_LANGUAGE);
    setReadLanguageState(readStoredLanguage(READ_STORAGE_KEY));
    setListenLanguageState(readStoredLanguage(LISTEN_STORAGE_KEY));

    return () => {
      controller.stop();
      dictationRef.current = null;
      unsubscribe();
      speech.stop();
      speechRef.current = null;
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

  /**
   * Identity whose audio is currently ducked, so it can be restored.
   *
   * Held in a ref rather than state: the restore happens from a synthesis
   * callback, which must not depend on a re-render having landed first.
   */
  const duckedRef = React.useRef<string | null>(null);

  const restoreVolume = React.useCallback(() => {
    const identity = duckedRef.current;

    if (identity === null) {
      return;
    }

    duckedRef.current = null;

    const participant = room.remoteParticipants.get(identity);

    // `setVolume` is a no-op when the track has gone, and the participant may
    // have left mid-utterance, so a missing one is not an error.
    participant?.setVolume(1);
  }, [room]);

  const duckVolume = React.useCallback(
    (identity: string) => {
      if (duckedRef.current === identity) {
        return;
      }

      restoreVolume();

      const participant = room.remoteParticipants.get(identity);

      if (participant === undefined) {
        return;
      }

      duckedRef.current = identity;
      participant.setVolume(DUCKED_VOLUME);
    },
    [room, restoreVolume],
  );

  // Registered as a pair: a started utterance ducks its speaker, and draining
  // the queue restores them.
  React.useEffect(() => {
    const speech = speechRef.current;

    if (speech === null) {
      return;
    }

    speech.setEvents({ onStart: duckVolume, onIdle: restoreVolume });

    return () => {
      speech.setEvents({});
      restoreVolume();
    };
  }, [duckVolume, restoreVolume]);

  const setListenLanguage = React.useCallback(
    (language: LanguageCode | null) => {
      setListenLanguageState(language);
      writeStoredLanguage(LISTEN_STORAGE_KEY, language);

      // Turning it off must silence what is already queued, not let the backlog
      // play out after the user asked for quiet.
      if (language === null) {
        speechRef.current?.stop();
        restoreVolume();
      }
    },
    [restoreVolume],
  );

  const segments = React.useMemo(() => visibleSegments(state), [state]);

  /**
   * Every language translations are currently needed in.
   *
   * Usually one. Two when somebody reads in one language and listens in another,
   * which is unusual but has to work rather than silently serving only the first.
   */
  const translationTargets = React.useMemo(() => {
    const targets: LanguageCode[] = [];

    if (readLanguage !== null) {
      targets.push(readLanguage);
    }

    if (listenLanguage !== null && listenLanguage !== readLanguage) {
      targets.push(listenLanguage);
    }

    return targets;
  }, [readLanguage, listenLanguage]);

  /** Stable across renders, so the translation effect is not restarted needlessly. */
  const targetsSignature = translationTargets.join("|");

  /**
   * Translates what is on screen into the reader's language.
   *
   * Debounced as a whole rather than per segment: recognition revises interim
   * text constantly, and the translator is sequential, so pacing the pass keeps
   * in-progress speech from starving finished sentences.
   */
  React.useEffect(() => {
    if (engine === null || !engine.isSupported()) {
      return;
    }

    const targets = translationTargets;

    if (targets.length === 0) {
      return;
    }

    let cancelled = false;
    const activeEngine = engine;

    const timer = window.setTimeout(() => {
      void (async () => {
        for (const target of targets) {
          if (cancelled) {
            return;
          }

          const pending = segments.filter((segment) => {
            if (segment.sourceLanguage === target) {
              return false;
            }

            const existing = translationsRef.current.get(
              translationKey(segment.id, target),
            );

            return existing === undefined || existing.text !== segment.text;
          });

          if (pending.length === 0) {
            continue;
          }

          // Distinct directions actually needed, so a first run downloads only
          // the packs in use rather than every pair in the catalog.
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

              next.set(translationKey(segment.id, target), {
                text: segment.text,
                sourceLanguage: segment.sourceLanguage,
                target,
                translated,
                viaPivot,
              });

              return next;
            });
          }
        }
      })();
    }, TRANSLATE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `targetsSignature` stands in for `translationTargets`, a fresh array each
    // render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, targetsSignature, segments]);

  /** Segment ids already spoken, so a re-render never repeats an utterance. */
  const spokenIdsRef = React.useRef<Set<string>>(new Set<string>());

  /**
   * Forgets what has been spoken when the listen language changes.
   *
   * Declared *before* the speaking effect on purpose. Effects run in declaration
   * order, so with this second it wiped the ids the speaking effect had just
   * recorded, and the next render spoke the whole backlog again.
   */
  React.useEffect(() => {
    spokenIdsRef.current = new Set<string>();
  }, [listenLanguage]);

  const entriesForSpeech = React.useMemo(() => {
    if (listenLanguage === null) {
      return [];
    }

    return segments.filter((segment) => {
      // Interim text is revised on almost every syllable, so speaking it would
      // stutter and repeat. Only a committed sentence is worth saying aloud.
      if (!segment.isFinal) {
        return false;
      }

      // Never read the listener their own words back.
      if (segment.speaker === localIdentity) {
        return false;
      }

      return true;
    });
  }, [segments, listenLanguage, localIdentity]);

  React.useEffect(() => {
    const speech = speechRef.current;

    if (speech === null || listenLanguage === null) {
      return;
    }

    entriesForSpeech.forEach((segment) => {
      if (spokenIdsRef.current.has(segment.id)) {
        return;
      }

      // Already in the listener's language: speak the original rather than
      // waiting on a translation that will never come.
      if (segment.sourceLanguage === listenLanguage) {
        spokenIdsRef.current.add(segment.id);
        speech.enqueue(segment.text, listenLanguage, segment.speaker);
        return;
      }

      const translation = translations.get(
        translationKey(segment.id, listenLanguage),
      );

      // Not translated yet. Left unmarked so the next pass picks it up once the
      // translation lands.
      if (translation === undefined || translation.text !== segment.text) {
        return;
      }

      spokenIdsRef.current.add(segment.id);
      speech.enqueue(translation.translated, listenLanguage, segment.speaker);
    });
  }, [entriesForSpeech, translations, listenLanguage]);

  const entries = React.useMemo<readonly CaptionEntry[]>(() => {
    return segments.map((segment) => {
      const entry =
        readLanguage === null
          ? undefined
          : translations.get(translationKey(segment.id, readLanguage));

      // Only a translation produced from this exact text is safe to show; the
      // key already guarantees it is in the language currently selected.
      const fresh =
        entry !== undefined &&
        entry.text === segment.text &&
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
      listenLanguage,
      setListenLanguage,
      speakableLanguages,
      canSpeak,
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
      listenLanguage,
      setListenLanguage,
      speakableLanguages,
      canSpeak,
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

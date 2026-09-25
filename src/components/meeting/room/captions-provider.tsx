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
const MUTE_ORIGINAL_STORAGE_KEY = "meeting:muteOriginal";

/**
 * How far the original drops while a translation plays over it.
 *
 * Only used by listeners who chose to keep the original audible. Not zero, so
 * tone and turn-taking survive even when the words do not.
 */
const DUCKED_VOLUME = 0.15;

/**
 * How recently somebody must have been captioned to count as still captioning.
 *
 * Used to decide whose audio to silence while dubbing. Generous enough to span
 * a pause for breath, short enough that someone who turns captioning off becomes
 * audible again quickly rather than staying silenced for the rest of the call.
 */
const ACTIVE_CAPTION_WINDOW_MS = 20_000;

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
  /**
   * Whether the server can synthesise languages this device cannot.
   *
   * False until Azure credentials are configured. The listen panel uses it to
   * decide whether a missing language is worth explaining: with no server route,
   * the honest advice is to use a browser that carries more voices, and that
   * advice should disappear on its own once the server can cover them.
   */
  hasCloudVoices: boolean;
  /**
   * Whether to silence the original voice entirely while dubbing.
   *
   * On by default, which is what makes this a dub rather than an echo: dubbing
   * lands a few seconds late, so leaving the original audible means hearing the
   * sentence in a language you do not understand and only then its translation.
   */
  muteOriginal: boolean;
  setMuteOriginal: (mute: boolean) => void;
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
  const [hasCloudVoices, setHasCloudVoices] = React.useState(false);
  const [muteOriginal, setMuteOriginalState] = React.useState(true);
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

  /**
   * Captions worth showing or speaking.
   *
   * Declared early because both the audio-muting effect and the translation
   * effect depend on it.
   */
  const segments = React.useMemo(() => visibleSegments(state), [state]);

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
    // The same listener covers the server's languages arriving.
    const unsubscribe = speech.onVoicesReady(() => {
      setSpeakableLanguages(speech.speakableLanguages());
    });

    /**
     * Asks the server which languages it can synthesise.
     *
     * This is what makes dubbing work in any browser: Windows ships no Telugu,
     * Kannada, Marathi or Malayalam voice, so without a server route those
     * languages are unreachable on Chrome no matter what the app does. A failure
     * here is silent and simply leaves the local voices as the whole offering.
     */
    void (async () => {
      try {
        const response = await fetch("/api/tts", { cache: "no-store" });

        if (!response.ok) {
          return;
        }

        const payload: unknown = await response.json();
        const languages =
          typeof payload === "object" &&
          payload !== null &&
          Array.isArray((payload as { languages?: unknown }).languages)
            ? (payload as { languages: unknown[] }).languages.filter(
                isLanguageCode,
              )
            : [];

        speech.setCloudLanguages(languages);
        setHasCloudVoices(languages.length > 0);
        setSpeakableLanguages(speech.speakableLanguages());
      } catch {
        // Offline, or synthesis is not configured. Local voices still work.
      }
    })();

    setSpeakLanguageState(readStoredLanguage(SPEAK_STORAGE_KEY) ?? DEFAULT_LANGUAGE);
    setReadLanguageState(readStoredLanguage(READ_STORAGE_KEY));
    setListenLanguageState(readStoredLanguage(LISTEN_STORAGE_KEY));

    try {
      // Defaults to on, so only an explicit "false" turns it off.
      setMuteOriginalState(
        window.localStorage.getItem(MUTE_ORIGINAL_STORAGE_KEY) !== "false",
      );
    } catch {
      // Blocked store. The default stands.
    }

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
   * Identities currently turned down, and what to restore them to.
   *
   * A ref rather than state because the restore has to be able to run from a
   * cleanup or a synthesis callback, neither of which can wait for a re-render.
   */
  const loweredRef = React.useRef<Set<string>>(new Set<string>());

  const setParticipantVolume = React.useCallback(
    (identity: string, volume: number) => {
      const participant = room.remoteParticipants.get(identity);

      // A participant who has left, or whose track has gone, is not an error —
      // there is simply nothing left to adjust.
      participant?.setVolume(volume);
    },
    [room],
  );

  const restoreAll = React.useCallback(() => {
    // `forEach` rather than `for...of`: this project's tsconfig declares no
    // `target`, so Set iteration is rejected under the default ES5 check.
    loweredRef.current.forEach((identity) => {
      setParticipantVolume(identity, 1);
    });

    loweredRef.current = new Set<string>();
  }, [setParticipantVolume]);

  /**
   * Silences the people whose speech is being dubbed for this listener.
   *
   * Continuous rather than only while an utterance plays. Dubbing lands a few
   * seconds behind the speaker, so ducking just for the utterance left the
   * original audible in the gap — you heard the sentence in a language you do not
   * read, and only then its translation. Muting for as long as dubbing is on is
   * what makes it feel like a dub rather than an echo.
   *
   * Scoped to *active captioners* rather than everyone: a participant who is not
   * captioning produces nothing to dub, so muting them would make them simply
   * inaudible.
   */
  React.useEffect(() => {
    if (listenLanguage === null || !muteOriginal) {
      restoreAll();
      return;
    }

    const shouldLower = new Set<string>();

    segments.forEach((segment) => {
      if (segment.speaker === localIdentity) {
        return;
      }

      // Recency, so someone who stops captioning becomes audible again on their
      // own rather than staying silenced for the rest of the call.
      if (Date.now() - segment.updatedAt <= ACTIVE_CAPTION_WINDOW_MS) {
        shouldLower.add(segment.speaker);
      }
    });

    shouldLower.forEach((identity) => {
      if (!loweredRef.current.has(identity)) {
        setParticipantVolume(identity, 0);
      }
    });

    loweredRef.current.forEach((identity) => {
      if (!shouldLower.has(identity)) {
        setParticipantVolume(identity, 1);
      }
    });

    loweredRef.current = shouldLower;
  }, [
    listenLanguage,
    muteOriginal,
    segments,
    localIdentity,
    setParticipantVolume,
    restoreAll,
  ]);

  // Leaving the room, or unmounting, must never strand somebody on mute.
  React.useEffect(() => restoreAll, [restoreAll]);

  /** Identity dipped for the duration of one utterance, tracked separately from
   * the continuous mute so the two cannot clobber each other's restore. */
  const dippedRef = React.useRef<string | null>(null);

  /**
   * Dips the original while an utterance plays, for listeners who chose to keep
   * it audible.
   *
   * Nothing to do when `muteOriginal` is on: it is already silent.
   */
  React.useEffect(() => {
    const speech = speechRef.current;

    if (speech === null) {
      return;
    }

    const releaseDip = (): void => {
      const identity = dippedRef.current;

      if (identity !== null) {
        dippedRef.current = null;
        setParticipantVolume(identity, 1);
      }
    };

    if (listenLanguage === null || muteOriginal) {
      speech.setEvents({});
      releaseDip();
      return;
    }

    speech.setEvents({
      onStart: (identity) => {
        releaseDip();
        dippedRef.current = identity;
        setParticipantVolume(identity, DUCKED_VOLUME);
      },
      onIdle: releaseDip,
    });

    return () => {
      speech.setEvents({});
      releaseDip();
    };
  }, [listenLanguage, muteOriginal, setParticipantVolume]);

  const setListenLanguage = React.useCallback(
    (language: LanguageCode | null) => {
      setListenLanguageState(language);
      writeStoredLanguage(LISTEN_STORAGE_KEY, language);

      // Turning it off must silence what is already queued, not let the backlog
      // play out after the user asked for quiet, and must hand everyone their
      // real voice back.
      if (language === null) {
        speechRef.current?.stop();
        restoreAll();
      }
    },
    [restoreAll],
  );

  const setMuteOriginal = React.useCallback((mute: boolean) => {
    setMuteOriginalState(mute);

    try {
      window.localStorage.setItem(
        MUTE_ORIGINAL_STORAGE_KEY,
        mute ? "true" : "false",
      );
    } catch {
      // A failed write only costs the preference on reload.
    }
  }, []);

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
      hasCloudVoices,
      muteOriginal,
      setMuteOriginal,
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
      hasCloudVoices,
      muteOriginal,
      setMuteOriginal,
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

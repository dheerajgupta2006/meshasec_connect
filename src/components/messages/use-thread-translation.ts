"use client";

/**
 * Reader-side translation for one message thread.
 *
 * The reader picks the language *they* want to read in. Every message is then
 * identified and translated into that language if it is not already in it, which
 * is what makes the feature bidirectional without anyone declaring what language
 * they write in: an English message shown to a Telugu reader is translated, and
 * the Telugu reply shown back to an English reader is too.
 *
 * Nothing is sent anywhere. Both detection and translation run in the reader's
 * browser, so the choice is private to them, costs nothing to run, and no message
 * body leaves the device. That also means the choice is *not* shared with the
 * other person and does not need to be.
 *
 * Originals are never replaced, only annotated. `translationFor` returns the
 * translation alongside the detected source language, and the caller renders both
 * — a wrong translation must always be checkable against what was actually sent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isLanguageCode, type LanguageCode } from "@/lib/i18n/languages";
import {
  createLanguageDetectorEngine,
  type LanguageDetectorEngine,
} from "@/lib/translation/detector";
import {
  createTranslationEngine,
  type TranslationEngine,
} from "@/lib/translation/on-device";

/** Anything the hook needs from a message. */
export interface TranslatableMessage {
  id: string;
  body: string;
  /** Soft-deleted bodies are blank, so there is nothing to translate. */
  deleted: boolean;
}

export interface MessageTranslation {
  text: string;
  /** What the original was identified as, for the "translated from" label. */
  sourceLanguage: LanguageCode;
  /**
   * True when the text was translated in two hops via English.
   *
   * Surfaced because two translations compound their errors, so the reader should
   * weigh a pivoted line a little more cautiously.
   */
  viaPivot: boolean;
}

export type TranslationStatus =
  /** No translator in this browser. The control is hidden entirely. */
  | "unsupported"
  /** Supported, but the reader has not turned it on. */
  | "off"
  /** Downloading a language pack. First use of a pair only. */
  | "preparing"
  | "ready"
  /** Turned on, but this pair cannot be served. */
  | "unavailable";

export interface ThreadTranslation {
  status: TranslationStatus;
  /** The language the reader wants to read in, or null when off. */
  target: LanguageCode | null;
  /** Null turns translation off. Must be called from a user gesture. */
  setTarget: (target: LanguageCode | null) => void;
  /** Language-pack download progress, 0 to 1, while `status` is "preparing". */
  progress: number;
  translationFor: (messageId: string) => MessageTranslation | null;
}

/**
 * Namespaced per contact: reading Telugu with one friend and English with
 * another is the normal case, not an edge case.
 */
function storageKey(contactUsername: string): string {
  return `messages:${contactUsername}:readIn`;
}

interface Entry extends MessageTranslation {
  /** The body this was produced from, so an edited message is re-translated. */
  body: string;
  /**
   * The language this was translated *into*.
   *
   * Checked on read. Without it, switching the picker from Telugu to Hindi would
   * keep showing the Telugu text under a "Hindi" heading until each message was
   * re-translated, which is worse than showing nothing.
   */
  target: LanguageCode;
}

export function useThreadTranslation(
  contactUsername: string,
  messages: readonly TranslatableMessage[],
): ThreadTranslation {
  /**
   * Created in an effect, not during render.
   *
   * This is a client component, so it also renders on the server, where the
   * browser globals are absent. Building the engines during render would make the
   * server and the first client render disagree about whether translation is
   * supported, which is a hydration mismatch. Both start at "no engine" and the
   * effect corrects it.
   */
  const [engine, setEngine] = useState<TranslationEngine | null>(null);
  const [detector, setDetector] = useState<LanguageDetectorEngine | null>(null);
  const [target, setTargetState] = useState<LanguageCode | null>(null);
  const [status, setStatus] = useState<TranslationStatus>("unsupported");
  const [progress, setProgress] = useState(0);
  const [entries, setEntries] = useState<Map<string, Entry>>(
    () => new Map<string, Entry>(),
  );

  /**
   * Mirrors `entries` so the work loop can check what it already has without
   * taking `entries` as a dependency, which would restart the loop on every
   * result it produced.
   */
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    const createdEngine = createTranslationEngine();

    setEngine(createdEngine);
    // The detector is created regardless of whether a model exists: without one
    // it still resolves Indic scripts by character, which is the majority of what
    // this app translates.
    setDetector(createLanguageDetectorEngine());
    setStatus(createdEngine.isSupported() ? "off" : "unsupported");
  }, []);

  // Restore the reader's choice once the engine is known to exist. Reading
  // `localStorage` in an effect keeps it off the server render path.
  useEffect(() => {
    if (engine === null || !engine.isSupported()) {
      return;
    }

    try {
      const stored = window.localStorage.getItem(storageKey(contactUsername));

      if (isLanguageCode(stored)) {
        setTargetState(stored);
      }
    } catch {
      // Private browsing or a blocked store. Translation simply starts off.
    }
  }, [engine, contactUsername]);

  // Switching thread must not show the previous conversation's translations.
  useEffect(() => {
    setEntries(new Map<string, Entry>());
  }, [contactUsername]);

  const setTarget = useCallback(
    (next: LanguageCode | null) => {
      setTargetState(next);
      setProgress(0);

      if (next === null) {
        setStatus(
          engine !== null && engine.isSupported() ? "off" : "unsupported",
        );
      } else {
        // Called from a click, which is the only time the browser permits a model
        // download. Warming the detector here rather than lazily means the first
        // message does not wait on it.
        void detector?.prepare();
      }

      try {
        const key = storageKey(contactUsername);

        if (next === null) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, next);
        }
      } catch {
        // A failed write only costs the preference on reload.
      }
    },
    [contactUsername, engine, detector],
  );

  /**
   * Message bodies that could need translating.
   *
   * Only the cheap, synchronous filtering happens here — deleted and blank
   * bodies. Which language each one is in is not known until the model has been
   * asked, so that decision moved into the async loop below.
   */
  const candidates = useMemo(() => {
    if (target === null) {
      return [];
    }

    const items: { id: string; body: string }[] = [];

    messages.forEach((message) => {
      if (message.deleted || message.body.trim().length === 0) {
        return;
      }

      items.push({ id: message.id, body: message.body });
    });

    return items;
  }, [messages, target]);

  /** Changes only when the work to do changes, not on every poll tick. */
  const signature = useMemo(
    () => candidates.map((item) => item.id).join("|"),
    [candidates],
  );

  const candidatesRef = useRef(candidates);
  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);

  useEffect(() => {
    if (
      engine === null ||
      detector === null ||
      !engine.isSupported() ||
      target === null
    ) {
      return;
    }

    let cancelled = false;
    const work = candidatesRef.current;
    // Bound explicitly: the null check above does not survive into the nested
    // async function, and every use below needs a non-null target.
    const readIn: LanguageCode = target;
    const activeEngine = engine;
    const activeDetector = detector;

    async function run(): Promise<void> {
      if (work.length === 0) {
        setStatus("ready");
        return;
      }

      /** Resolved source language per message, for the pairs actually needed. */
      const resolved: { id: string; body: string; source: LanguageCode }[] = [];

      for (const item of work) {
        if (cancelled) {
          return;
        }

        // Already translated from this exact body into this exact language. An
        // edit changes the body and so re-detects; a re-poll of unchanged text
        // does neither.
        const existing = entriesRef.current.get(item.id);

        if (
          existing !== undefined &&
          existing.body === item.body &&
          existing.target === readIn
        ) {
          continue;
        }

        const source = await activeDetector.detect(item.body);

        if (cancelled) {
          return;
        }

        // Undetectable, or already in the reader's language. Neither is an error.
        if (source === null || source === readIn) {
          continue;
        }

        resolved.push({ id: item.id, body: item.body, source });
      }

      if (cancelled) {
        return;
      }

      if (resolved.length === 0) {
        setStatus("ready");
        return;
      }

      // The distinct directions this thread actually needs, so a first run
      // downloads only the packs in use rather than every pair in the catalog.
      const sources: LanguageCode[] = [];

      resolved.forEach((item) => {
        if (!sources.includes(item.source)) {
          sources.push(item.source);
        }
      });

      let anyReady = false;
      let sawUnavailable = false;

      for (const source of sources) {
        if (cancelled) {
          return;
        }

        const pair = { source, target: readIn };
        const availability = await activeEngine.availability(pair);

        if (cancelled) {
          return;
        }

        if (availability === "unavailable") {
          sawUnavailable = true;
          continue;
        }

        if (availability !== "available") {
          setStatus("preparing");
        }

        const ready = await activeEngine.prepare(pair, (fraction) => {
          if (!cancelled) {
            setProgress(fraction);
          }
        });

        if (cancelled) {
          return;
        }

        if (ready) {
          anyReady = true;
        } else {
          sawUnavailable = true;
        }
      }

      if (cancelled) {
        return;
      }

      if (!anyReady) {
        setStatus(sawUnavailable ? "unavailable" : "off");
        return;
      }

      setStatus("ready");

      for (const item of resolved) {
        if (cancelled) {
          return;
        }

        const outcome = await activeEngine.translate(item.body, {
          source: item.source,
          target: readIn,
        });

        if (cancelled) {
          return;
        }

        if (!outcome.ok) {
          continue;
        }

        const translated = outcome.text;
        const { viaPivot } = outcome;

        setEntries((current) => {
          const next = new Map(current);

          next.set(item.id, {
            body: item.body,
            text: translated,
            sourceLanguage: item.source,
            target: readIn,
            viaPivot,
          });

          return next;
        });
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
    // `signature` stands in for `candidates`, which is a new array on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, detector, target, signature]);

  const translationFor = useCallback(
    (messageId: string): MessageTranslation | null => {
      if (target === null) {
        return null;
      }

      const entry = entries.get(messageId);

      if (entry === undefined || entry.target !== target) {
        return null;
      }

      // An identical result means the model found nothing to change. Showing it
      // twice would just look broken.
      return entry.text === entry.body
        ? null
        : {
            text: entry.text,
            sourceLanguage: entry.sourceLanguage,
            viaPivot: entry.viaPivot,
          };
    },
    [entries, target],
  );

  return { status, target, setTarget, progress, translationFor };
}

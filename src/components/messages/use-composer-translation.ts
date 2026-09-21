"use client";

/**
 * Compose in your own language, send in theirs.
 *
 * The reading side of this feature (`use-thread-translation.ts`) only helps
 * people whose browser can translate. Desktop Chromium can; phones and Safari
 * cannot. So a Telugu message sent to someone on a phone arrives untranslated and
 * unreadable no matter what they have selected.
 *
 * This closes that gap from the other end: the sender translates before sending,
 * so the message arrives already in the recipient's language and needs nothing
 * from their browser.
 *
 * ## What actually gets sent
 *
 * The translated text, not the original. There is no column to hold both, and
 * inventing one would mean a migration for a feature that otherwise needs none.
 * The honest consequence is that the sender is *writing in another language with
 * help*, so they have to be able to see exactly what will be sent before it goes
 * — which is why the preview is mandatory and sending is blocked until it matches
 * the current draft. What you see is what is sent.
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

/**
 * Pause before translating a draft.
 *
 * Longer than the caption debounce: someone typing produces a new draft on every
 * keystroke, and translating each one would queue dozens of requests through a
 * sequential translator to show text nobody has finished writing.
 */
const DEBOUNCE_MS = 450;

/** Namespaced per contact: you write to different people in different languages. */
function storageKey(contactUsername: string): string {
  return `messages:${contactUsername}:sendIn`;
}

export interface ComposerTranslation {
  /** False when this browser cannot translate; the control stays hidden. */
  isSupported: boolean;
  /** Language to send in, or null to send exactly what was typed. */
  target: LanguageCode | null;
  setTarget: (target: LanguageCode | null) => void;
  /** The translated draft, or null when there is nothing to show yet. */
  preview: string | null;
  /** True while a translation for the current draft is outstanding. */
  isTranslating: boolean;
  /** Set when the draft could not be translated at all. */
  failed: boolean;
  /**
   * False while the preview does not yet match the draft.
   *
   * The composer disables sending on this, so nobody can send text they have not
   * seen.
   */
  isReady: boolean;
  /**
   * What to send for `draft`, or null when it is not ready.
   *
   * Returns the draft unchanged when translation is off.
   */
  resolve: (draft: string) => string | null;
  /** Clears the preview once a message has been sent. */
  reset: () => void;
}

export function useComposerTranslation(
  contactUsername: string,
  draft: string,
): ComposerTranslation {
  const [engine, setEngine] = useState<TranslationEngine | null>(null);
  const [detector, setDetector] = useState<LanguageDetectorEngine | null>(null);
  const [target, setTargetState] = useState<LanguageCode | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [failed, setFailed] = useState(false);

  /** The draft this preview was produced from, so staleness is detectable. */
  const [result, setResult] = useState<{
    draft: string;
    target: LanguageCode;
    text: string;
  } | null>(null);

  // Built in an effect, not during render: this is a client component that also
  // renders on the server, where the browser globals are absent.
  useEffect(() => {
    setEngine(createTranslationEngine());
    setDetector(createLanguageDetectorEngine());
  }, []);

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
      // Private browsing or a blocked store. The feature starts off.
    }
  }, [engine, contactUsername]);

  const setTarget = useCallback(
    (next: LanguageCode | null) => {
      setTargetState(next);
      setResult(null);
      setFailed(false);
      setIsTranslating(false);

      // From a click, which is the only time the browser permits a model
      // download.
      if (next !== null) {
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
    [contactUsername, detector],
  );

  const trimmed = draft.trim();

  useEffect(() => {
    if (
      engine === null ||
      detector === null ||
      !engine.isSupported() ||
      target === null
    ) {
      return;
    }

    if (trimmed.length === 0) {
      setResult(null);
      setIsTranslating(false);
      setFailed(false);
      return;
    }

    let cancelled = false;
    const activeEngine = engine;
    const activeDetector = detector;
    const activeTarget = target;

    setIsTranslating(true);
    setFailed(false);

    const timer = window.setTimeout(() => {
      void (async () => {
        const source = await activeDetector.detect(trimmed);

        if (cancelled) {
          return;
        }

        // Undetectable, or already the target language. Either way there is
        // nothing to translate, and the draft is sent as written.
        if (source === null || source === activeTarget) {
          setResult({ draft: trimmed, target: activeTarget, text: trimmed });
          setIsTranslating(false);
          return;
        }

        const pair = { source, target: activeTarget };
        const availability = await activeEngine.availability(pair);

        if (cancelled) {
          return;
        }

        if (availability === "unavailable") {
          setIsTranslating(false);
          setFailed(true);
          return;
        }

        await activeEngine.prepare(pair);

        if (cancelled) {
          return;
        }

        const outcome = await activeEngine.translate(trimmed, pair);

        if (cancelled) {
          return;
        }

        setIsTranslating(false);

        if (!outcome.ok) {
          setFailed(true);
          return;
        }

        setResult({
          draft: trimmed,
          target: activeTarget,
          text: outcome.text,
        });
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [engine, detector, target, trimmed]);

  const isFresh =
    result !== null && result.draft === trimmed && result.target === target;

  const preview = useMemo(() => {
    if (target === null || !isFresh || result === null) {
      return null;
    }

    // Identical output means there was nothing to change. Showing it as a
    // "translation" would just look broken.
    return result.text === trimmed ? null : result.text;
  }, [target, isFresh, result, trimmed]);

  const resultRef = useRef(result);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  const resolve = useCallback(
    (value: string): string | null => {
      if (target === null) {
        return value;
      }

      const current = resultRef.current;
      const cleaned = value.trim();

      if (
        current === null ||
        current.draft !== cleaned ||
        current.target !== target
      ) {
        return null;
      }

      return current.text;
    },
    [target],
  );

  const reset = useCallback(() => {
    setResult(null);
    setIsTranslating(false);
    setFailed(false);
  }, []);

  return {
    isSupported: engine !== null && engine.isSupported(),
    target,
    setTarget,
    preview,
    isTranslating,
    failed,
    // Nothing typed is trivially ready: there is nothing to verify.
    isReady: target === null || trimmed.length === 0 || isFresh,
    resolve,
    reset,
  };
}

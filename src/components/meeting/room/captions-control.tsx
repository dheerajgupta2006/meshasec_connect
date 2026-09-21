"use client";

/**
 * Dock control for live translated captions.
 *
 * Two separate choices, which is the part worth getting right in the UI: the
 * language you *speak* configures recognition, and the language you *read*
 * configures translation. They are usually different — that is the entire point
 * of the feature — so presenting them as one setting would make it unusable.
 *
 * The microphone toggle carries an explicit warning. Captions send audio to a
 * speech service, unlike the translation itself, and that has to be stated where
 * the switch is rather than buried elsewhere.
 */

import { Captions, LoaderCircle, TriangleAlert } from "lucide-react";
import * as React from "react";

import {
  SUPPORTED_LANGUAGES,
  languageLabel,
  type LanguageCode,
} from "@/lib/i18n/languages";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DictationFailure } from "@/lib/translation/speech-recognition";

import { useCaptions } from "./captions-provider";

/** Sentinel for the off position. Radix Select cannot hold an empty value. */
const OFF = "off";

function describeFailure(failure: DictationFailure): string {
  if (failure === "denied") {
    return "Microphone access was refused, so captions cannot be produced. Allow it in your browser's site settings and try again.";
  }

  if (failure === "no-microphone") {
    return "No microphone was found.";
  }

  if (failure === "network") {
    return "The speech service could not be reached. Captions stopped.";
  }

  return "Captions stopped unexpectedly.";
}

export function CaptionsPanel() {
  const {
    canCaption,
    canTranslate,
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
  } = useCaptions();

  return (
    <div className="w-[264px] space-y-4 p-1">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          I read in
        </h3>

        <Select
          value={readLanguage ?? OFF}
          onValueChange={(value) => {
            setReadLanguage(value === OFF ? null : (value as LanguageCode));
          }}
          disabled={!canTranslate}
        >
          <SelectTrigger
            className="h-9 border-white/15 bg-white/5 text-xs text-zinc-100"
            aria-label="Language to show captions in"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={OFF} className="text-xs">
              Original language
            </SelectItem>
            {SUPPORTED_LANGUAGES.map((language) => (
              <SelectItem
                key={language.code}
                value={language.code}
                className="text-xs"
              >
                {languageLabel(language.code)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {!canTranslate && (
          <p className="text-[11px] leading-4 text-zinc-400">
            This browser cannot translate on-device, so captions will show the
            language each person spoke.
          </p>
        )}

        {isPreparing && (
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />
            Downloading a language pack
          </p>
        )}
      </section>

      <div aria-hidden className="h-px bg-white/10" />

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          I speak
        </h3>

        <Select
          value={speakLanguage}
          onValueChange={(value) => setSpeakLanguage(value as LanguageCode)}
          disabled={!canCaption}
        >
          <SelectTrigger
            className="h-9 border-white/15 bg-white/5 text-xs text-zinc-100"
            aria-label="Language you are speaking"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {SUPPORTED_LANGUAGES.map((language) => (
              <SelectItem
                key={language.code}
                value={language.code}
                className="text-xs"
              >
                {languageLabel(language.code)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {canCaption ? (
          <button
            type="button"
            onClick={isCaptioning ? stopCaptioning : startCaptioning}
            aria-pressed={isCaptioning}
            className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              isCaptioning
                ? "bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
                : "bg-white/10 text-zinc-100 hover:bg-white/20"
            }`}
          >
            {isCaptioning && dictationState === "starting" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Captions className="h-3.5 w-3.5" aria-hidden />
            )}
            {isCaptioning ? "Stop captioning me" : "Caption what I say"}
          </button>
        ) : (
          <p className="text-[11px] leading-4 text-zinc-400">
            This browser cannot recognise speech, so you cannot be captioned. You
            can still read other people&apos;s captions.
          </p>
        )}

        {/* Stated at the switch rather than buried in a policy page: the audio
            really does leave the device, unlike the translation. */}
        <p className="text-[11px] leading-4 text-zinc-400">
          Captioning sends your microphone audio to a speech service for
          transcription. Translation stays on your device.
        </p>

        {failure !== null && (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-[11px] leading-4 text-red-300"
          >
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            {describeFailure(failure)}
          </p>
        )}
      </section>
    </div>
  );
}

/** Whether the dock button should read as active. */
export function useCaptionsActive(): boolean {
  const { isCaptioning, readLanguage } = useCaptions();

  return isCaptioning || readLanguage !== null;
}

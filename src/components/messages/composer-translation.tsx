"use client";

/**
 * Composer control for sending in another language.
 *
 * The preview is not decoration. What gets sent is the translated text, so the
 * sender has to see it before it goes — this is the only place they can check
 * that the translation says what they meant.
 */

import { ArrowRight, Languages, LoaderCircle, TriangleAlert } from "lucide-react";

import {
  SUPPORTED_LANGUAGES,
  directionFor,
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
import type { ComposerTranslation } from "@/components/messages/use-composer-translation";

/** Sentinel for the off position. Radix Select cannot hold an empty value. */
const OFF = "off";

export function ComposerTranslationBar({
  translation,
  hasDraft,
}: {
  translation: ComposerTranslation;
  hasDraft: boolean;
}) {
  const { isSupported, target, setTarget, preview, isTranslating, failed } =
    translation;

  if (!isSupported) {
    return null;
  }

  return (
    <div className="border-t bg-muted/30 px-3 py-2 sm:px-4">
      <div className="flex items-center gap-2">
        <Languages
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="shrink-0 text-xs text-muted-foreground">Send in</span>

        <Select
          value={target ?? OFF}
          onValueChange={(value) => {
            setTarget(value === OFF ? null : (value as LanguageCode));
          }}
        >
          {/* Same reasoning as the reader's picker in the header: borderless and
              transparent, the selected language was barely legible and did not
              read as something you could click. */}
          <SelectTrigger
            className="h-8 w-[150px] shrink-0 px-2 text-xs"
            aria-label="Language to send this message in"
          >
            <SelectValue placeholder="My own language" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={OFF} className="text-xs">
              My own language
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

        {target !== null && isTranslating && hasDraft && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />
            Translating
          </span>
        )}
      </div>

      {target !== null && failed && hasDraft && (
        <p
          role="alert"
          className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-4 text-destructive-text"
        >
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          This could not be translated into {languageLabel(target)}. Turn the
          setting off to send what you typed.
        </p>
      )}

      {target !== null && preview !== null && (
        <div className="mt-1.5 flex items-start gap-1.5">
          <ArrowRight
            className="mt-1 h-3 w-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
          {/* Labelled as what will be sent, not as a hint, because that is
              literally the message body. */}
          <p
            lang={target}
            dir={directionFor(target)}
            className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-5"
          >
            {preview}
          </p>
        </div>
      )}
    </div>
  );
}

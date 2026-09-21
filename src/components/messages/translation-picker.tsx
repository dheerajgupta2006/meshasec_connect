"use client";

/**
 * Chooses the language a reader wants a thread rendered in.
 *
 * Renders nothing at all when the browser has no on-device translator, rather
 * than showing a disabled control: the capability is missing for reasons the
 * reader cannot act on, so an explanation would be noise.
 */

import { Languages, LoaderCircle, TriangleAlert } from "lucide-react";

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
import type { TranslationStatus } from "@/components/messages/use-thread-translation";

/** Sentinel for the off position. Radix Select cannot hold an empty value. */
const OFF = "off";

interface TranslationPickerProps {
  status: TranslationStatus;
  target: LanguageCode | null;
  progress: number;
  onChange: (target: LanguageCode | null) => void;
}

export function TranslationPicker({
  status,
  target,
  progress,
  onChange,
}: TranslationPickerProps) {
  if (status === "unsupported") {
    return null;
  }

  const isPreparing = status === "preparing";
  // Only meaningful once a language has been chosen: "off" plus "unavailable"
  // would be reporting a failure nobody asked for.
  const isUnavailable = status === "unavailable" && target !== null;

  return (
    <div
      // `shrink-0` because the sibling name block is `flex-1` and would otherwise
      // squeeze this control down toward its content width.
      className="flex shrink-0 items-center gap-1.5"
      title={
        isUnavailable
          ? "This browser cannot translate this conversation's languages."
          : undefined
      }
    >
      {isUnavailable ? (
        <TriangleAlert
          className="h-4 w-4 shrink-0 text-destructive-text"
          aria-hidden
        />
      ) : isPreparing ? (
        <LoaderCircle
          className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
          aria-hidden
        />
      ) : (
        <Languages
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
      )}

      {/* Mirrors the composer's "Send in" so the pair reads as one feature.
          Hidden on narrow screens, where the header has no room to spare — the
          select keeps its `aria-label` either way. */}
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        Read in
      </span>

      <Select
        value={target ?? OFF}
        onValueChange={(value) => {
          // Called from a click, which matters: the first use of a language pair
          // downloads a model, and the browser only permits that during user
          // activation.
          onChange(value === OFF ? null : (value as LanguageCode));
        }}
      >
        {/* Deliberately the default bordered trigger. Borderless and transparent,
            this read as decoration rather than a control and the selected value
            was easy to miss entirely. */}
        <SelectTrigger
          className="h-8 w-[132px] shrink-0 px-2 text-xs"
          aria-label="Read this conversation in"
        >
          {/* The placeholder only appears if `target` ever holds a code this
              build does not know, which a stale stored preference could do. */}
          <SelectValue placeholder="No translation" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={OFF} className="text-xs">
            No translation
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

      {/* Announced politely so a screen reader hears the outcome without having
          the download chatter read out at every percentage. */}
      <span className="sr-only" role="status">
        {status === "preparing"
          ? `Preparing translation, ${Math.round(progress * 100)} percent`
          : status === "unavailable"
            ? "Translation is not available for this conversation"
            : status === "ready" && target !== null
              ? `Translating into ${languageLabel(target)}`
              : "Translation off"}
      </span>
    </div>
  );
}

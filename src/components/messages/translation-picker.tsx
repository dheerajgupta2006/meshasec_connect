"use client";

/**
 * Chooses the language a reader wants a thread rendered in.
 *
 * Renders nothing at all when the browser has no on-device translator, rather
 * than showing a disabled control: the capability is missing for reasons the
 * reader cannot act on, so an explanation would be noise.
 */

import { Languages, LoaderCircle } from "lucide-react";

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

  return (
    <div className="flex items-center gap-1.5">
      {isPreparing ? (
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

      <Select
        value={target ?? OFF}
        onValueChange={(value) => {
          // Called from a click, which matters: the first use of a language pair
          // downloads a model, and the browser only permits that during user
          // activation.
          onChange(value === OFF ? null : (value as LanguageCode));
        }}
      >
        <SelectTrigger
          className="h-8 w-[136px] border-none bg-transparent px-2 text-xs shadow-none focus:ring-1"
          aria-label="Translate this conversation"
        >
          <SelectValue />
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

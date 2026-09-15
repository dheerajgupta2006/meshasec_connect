"use client";

import { Ban, ImagePlus, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ACCEPTED_UPLOAD_TYPES,
  BACKGROUND_PRESETS,
  describeBackgroundEffect,
  sameBackgroundEffect,
  type BackgroundEffect,
} from "@/lib/meetings/backgrounds";
import {
  prepareUploadedBackground,
  renderPreset,
} from "@/lib/meetings/backgrounds-client";
import { cn } from "@/lib/utils";

interface BackgroundPickerProps {
  effect: BackgroundEffect;
  onChange: (effect: BackgroundEffect) => void;
  /** False when the browser cannot run background processors at all. */
  supported: boolean;
  disabled?: boolean;
  /** Rendered under the options, e.g. "Applying…" or a failure notice. */
  notice?: string | null;
}

/**
 * Chooses between no effect, blur, a built-in background, or an uploaded image.
 *
 * Presets are rendered to data URLs on first use, so the swatches and the actual
 * background come from the same source and cannot disagree.
 */
export function BackgroundPicker({
  effect,
  onChange,
  supported,
  disabled = false,
  notice = null,
}: BackgroundPickerProps) {
  const [swatches, setSwatches] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Rendered in an effect, never during render: `renderPreset` touches a canvas,
  // which does not exist on the server.
  useEffect(() => {
    const rendered: Record<string, string> = {};

    BACKGROUND_PRESETS.forEach((preset) => {
      rendered[preset.id] = renderPreset(preset);
    });

    setSwatches(rendered);
  }, []);

  async function handleFile(file: File | undefined): Promise<void> {
    if (file === undefined) {
      return;
    }

    setUploading(true);
    setUploadError(null);

    const outcome = await prepareUploadedBackground(file);

    setUploading(false);

    if (!outcome.ok) {
      setUploadError(outcome.message);
      return;
    }

    onChange({ kind: "image", id: "custom", url: outcome.url });
  }

  const optionClass = (active: boolean) =>
    cn(
      "relative flex h-16 items-center justify-center overflow-hidden rounded-lg border text-xs font-medium transition-all",
      active
        ? "border-blue-400 ring-2 ring-blue-400/50"
        : "border-white/15 hover:border-white/35",
      disabled && "cursor-not-allowed opacity-50",
    );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant={effect.kind === "none" ? "secondary" : "default"}
          disabled={disabled || !supported}
          className={cn(
            "rounded-full",
            effect.kind !== "none" && "bg-blue-600 text-white hover:bg-blue-500",
          )}
          aria-label={
            supported
              ? `Background: ${describeBackgroundEffect(effect)}. Change it.`
              : "Background effects are unavailable in this browser"
          }
          title={
            supported
              ? describeBackgroundEffect(effect)
              : "Background effects are unavailable in this browser"
          }
        >
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="center"
        className="w-72 border-white/10 bg-zinc-900/95 text-zinc-100 backdrop-blur-xl"
      >
        <p className="mb-2 text-xs font-medium text-zinc-400">Background</p>

        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => onChange({ kind: "none" })}
            disabled={disabled}
            aria-pressed={effect.kind === "none"}
            className={cn(optionClass(effect.kind === "none"), "bg-zinc-800")}
          >
            <span className="flex flex-col items-center gap-1 text-zinc-300">
              <Ban className="h-4 w-4" aria-hidden="true" />
              None
            </span>
          </button>

          <button
            type="button"
            onClick={() => onChange({ kind: "blur" })}
            disabled={disabled}
            aria-pressed={effect.kind === "blur"}
            className={cn(
              optionClass(effect.kind === "blur"),
              "bg-gradient-to-br from-zinc-600 to-zinc-800 backdrop-blur",
            )}
          >
            <span className="text-zinc-100">Blur</span>
          </button>

          {BACKGROUND_PRESETS.map((preset) => {
            const url = swatches[preset.id];
            const candidate: BackgroundEffect =
              url === undefined
                ? { kind: "none" }
                : { kind: "image", id: preset.id, url };
            const active =
              effect.kind === "image" && effect.id === preset.id;

            return (
              <button
                key={preset.id}
                type="button"
                disabled={disabled || url === undefined}
                aria-pressed={active}
                onClick={() => {
                  if (!sameBackgroundEffect(effect, candidate)) {
                    onChange(candidate);
                  }
                }}
                className={optionClass(active)}
                style={
                  url === undefined
                    ? undefined
                    : {
                        backgroundImage: `url(${url})`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                      }
                }
              >
                <span className="rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
                  {preset.label}
                </span>
              </button>
            );
          })}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_UPLOAD_TYPES.join(",")}
          className="sr-only"
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
            // Cleared so re-picking the same file fires `change` again.
            event.target.value = "";
          }}
        />

        <Button
          type="button"
          variant="outline"
          disabled={disabled || uploading}
          onClick={() => fileRef.current?.click()}
          className="mt-2 h-10 w-full border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14]"
        >
          {uploading ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
          )}
          Upload your own
        </Button>

        {effect.kind === "image" && effect.id === "custom" && (
          <p className="mt-2 text-[11px] text-zinc-400">
            Using your uploaded image. It stays on your device.
          </p>
        )}

        {uploadError !== null && (
          <p role="alert" className="mt-2 text-[11px] font-medium text-red-400">
            {uploadError}
          </p>
        )}

        {notice !== null && (
          <p className="mt-2 text-[11px] text-zinc-400">{notice}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

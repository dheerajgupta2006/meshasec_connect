"use client";

import { useLocalParticipant } from "@livekit/components-react";
import {
  BackgroundBlur,
  VirtualBackground,
  supportsBackgroundProcessors,
} from "@livekit/track-processors";
import { Track } from "livekit-client";
import type { LocalVideoTrack } from "livekit-client";
import { useEffect, useRef, useState } from "react";

import { BackgroundPicker } from "@/components/meeting/background-picker";
import {
  NO_BACKGROUND,
  sameBackgroundEffect,
  type BackgroundEffect,
} from "@/lib/meetings/backgrounds";

/** Matches the lobby preview so the effect does not visibly change on join. */
const BLUR_RADIUS = 10;

interface BackgroundControlProps {
  /** Chosen in the lobby. Applied once the camera track exists. */
  initialEffect: BackgroundEffect;
}

/**
 * Applies and switches the camera background effect inside a live room.
 *
 * This is what actually puts the effect on the published track. The lobby only
 * ever showed a local preview — the choice made there was never applied to the
 * outgoing stream, so other participants saw the raw camera.
 */
export function BackgroundControl({ initialEffect }: BackgroundControlProps) {
  const { localParticipant, isCameraEnabled } = useLocalParticipant();
  const [effect, setEffect] = useState<BackgroundEffect>(initialEffect);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [status, setStatus] = useState<"idle" | "applying" | "failed">("idle");

  /** The effect currently on the track, so a re-render does not reapply it. */
  const appliedRef = useRef<BackgroundEffect>(NO_BACKGROUND);

  useEffect(() => {
    // Support detection touches WebGL and WASM, so it cannot run on the server.
    setSupported(supportsBackgroundProcessors());
  }, []);

  useEffect(() => {
    if (supported !== true) {
      return;
    }

    const publication = localParticipant.getTrackPublication(
      Track.Source.Camera,
    );
    const track = publication?.videoTrack as LocalVideoTrack | undefined;

    // No camera track yet, or the camera is off. Nothing to process; the effect
    // is reapplied by this same effect once the track appears.
    if (track === undefined || !isCameraEnabled) {
      appliedRef.current = NO_BACKGROUND;
      return;
    }

    if (sameBackgroundEffect(appliedRef.current, effect)) {
      return;
    }

    let cancelled = false;

    const apply = async () => {
      try {
        if (effect.kind === "none") {
          setStatus("idle");
          await track.stopProcessor();
          appliedRef.current = NO_BACKGROUND;
          return;
        }

        setStatus("applying");

        const processor =
          effect.kind === "blur"
            ? BackgroundBlur(BLUR_RADIUS)
            : VirtualBackground(effect.url);

        // `setProcessor` replaces any existing one, so switching presets does
        // not need an explicit stop first.
        await track.setProcessor(processor);

        if (cancelled) {
          await track.stopProcessor().catch(() => undefined);
          return;
        }

        appliedRef.current = effect;
        setStatus("idle");
      } catch {
        if (cancelled) {
          return;
        }

        // A failed processor must not take the camera down with it: fall back to
        // the raw track and say so.
        await track.stopProcessor().catch(() => undefined);
        appliedRef.current = NO_BACKGROUND;
        setEffect(NO_BACKGROUND);
        setStatus("failed");
      }
    };

    void apply();

    return () => {
      cancelled = true;
    };
  }, [effect, isCameraEnabled, localParticipant, supported]);

  return (
    <BackgroundPicker
      effect={effect}
      onChange={setEffect}
      supported={supported === true}
      disabled={supported === null || !isCameraEnabled}
      notice={
        supported === false
          ? "Background effects are not supported in this browser."
          : !isCameraEnabled
            ? "Turn your camera on to use a background."
            : status === "applying"
              ? "Applying…"
              : status === "failed"
                ? "That effect could not start on this device."
                : null
      }
    />
  );
}

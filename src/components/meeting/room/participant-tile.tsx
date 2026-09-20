"use client";

import {
  isTrackReference,
  useConnectionQualityIndicator,
  useIsSpeaking,
  useParticipantInfo,
  useRoomInfo,
  useTrackMutedIndicator,
  VideoTrack,
} from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { ConnectionQuality, Track } from "livekit-client";
import {
  Crown,
  FlipHorizontal2,
  Mic,
  MicOff,
  MonitorUp,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SignalZero,
} from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

import { RaisedHandIndicator, ReactionOverlay, useReactions } from "./reactions";

export type TileVariant = "grid" | "spotlight" | "thumbnail";

export interface ParticipantVideoTileProps {
  /** Camera or screen-share reference. Placeholders render the avatar state. */
  trackRef: TrackReferenceOrPlaceholder;
  variant?: TileVariant;
  /** Marks the meeting host so the tile can show the crown. */
  isHost?: boolean;
  /** Mirroring is offered for the local camera only. */
  mirrored?: boolean;
  onToggleMirror?: () => void;
}

/** Stable React key for a tile, since a participant can own several tracks. */
export function trackReferenceKey(trackRef: TrackReferenceOrPlaceholder): string {
  const sid = isTrackReference(trackRef) ? trackRef.publication.trackSid : "none";
  return `${trackRef.participant.identity}:${trackRef.source}:${sid}`;
}

export function participantDisplayName(participant: Participant): string {
  const name = participant.name;
  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }
  return participant.identity;
}

function initialsOf(label: string): string {
  const words = label
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return "?";
  }

  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";

  return `${first}${last}`.toUpperCase();
}

const QUALITY_LABEL: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: "Excellent connection",
  [ConnectionQuality.Good]: "Good connection",
  [ConnectionQuality.Poor]: "Poor connection",
  [ConnectionQuality.Lost]: "Connection lost",
  [ConnectionQuality.Unknown]: "Connection quality unknown",
};

/** Connection-quality glyph. Reused by the participants roster. */
export function ConnectionQualityIcon({
  participant,
  className,
}: {
  participant: Participant;
  className?: string;
}): React.JSX.Element {
  const { quality } = useConnectionQualityIndicator({ participant });
  const label = QUALITY_LABEL[quality];

  const iconClassName = cn("h-3.5 w-3.5", className);

  let icon: React.JSX.Element;
  if (quality === ConnectionQuality.Excellent) {
    icon = (
      <SignalHigh
        className={cn(iconClassName, "text-emerald-400")}
        aria-hidden="true"
      />
    );
  } else if (quality === ConnectionQuality.Good) {
    icon = (
      <SignalMedium
        className={cn(iconClassName, "text-emerald-300")}
        aria-hidden="true"
      />
    );
  } else if (quality === ConnectionQuality.Poor) {
    icon = (
      <SignalLow
        className={cn(iconClassName, "text-amber-400")}
        aria-hidden="true"
      />
    );
  } else if (quality === ConnectionQuality.Lost) {
    icon = (
      <SignalZero
        className={cn(iconClassName, "text-red-400")}
        aria-hidden="true"
      />
    );
  } else {
    icon = (
      <SignalZero
        className={cn(iconClassName, "text-zinc-500")}
        aria-hidden="true"
      />
    );
  }

  return (
    <span title={label} className="inline-flex items-center">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Microphone glyph driven by the participant's real publication state. */
export function MicrophoneStateIcon({
  participant,
  className,
}: {
  participant: Participant;
  className?: string;
}): React.JSX.Element {
  // Memoised so the underlying observable is not re-subscribed every render.
  const micRef = React.useMemo<TrackReferenceOrPlaceholder>(
    () => ({ participant, source: Track.Source.Microphone }),
    [participant],
  );
  const { isMuted } = useTrackMutedIndicator(micRef);

  const label = isMuted ? "Microphone muted" : "Microphone live";

  return (
    <span title={label} className="inline-flex items-center">
      {isMuted ? (
        <MicOff
          className={cn("h-3.5 w-3.5 text-red-400", className)}
          aria-hidden="true"
        />
      ) : (
        <Mic
          className={cn("h-3.5 w-3.5 text-zinc-300", className)}
          aria-hidden="true"
        />
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * One participant, one track.
 *
 * The speaking state drives an animated ring. The pulse is a Tailwind
 * animation class rather than an inline style, so the global
 * `prefers-reduced-motion` rule can neutralise it and leave a static glow.
 */
export function ParticipantVideoTile({
  trackRef,
  variant = "grid",
  isHost = false,
  mirrored = false,
  onToggleMirror,
}: ParticipantVideoTileProps): React.JSX.Element {
  const { participant, source } = trackRef;
  const isSpeaking = useIsSpeaking(participant);
  const { isMuted: isVideoMuted } = useTrackMutedIndicator(trackRef);
  const { name } = useParticipantInfo({ participant });
  const { isHandRaised } = useReactions();

  const isScreenShare = source === Track.Source.ScreenShare;
  const isLocal = participant.isLocal;
  const handRaised = isHandRaised(participant.identity);

  const label =
    typeof name === "string" && name.trim().length > 0
      ? name.trim()
      : participantDisplayName(participant);

  const hasVideo = isTrackReference(trackRef) && !isVideoMuted;

  // Screen shares must not be cropped; camera feeds look best filling the tile.
  const videoFit = isScreenShare ? "object-contain" : "object-cover";

  return (
    <div
      className={cn(
        // `h-full w-full` is load-bearing, not cosmetic. The <video> inside is
        // sized with `h-full`, which resolves against *this* element — and while
        // this element had auto height the percentage could not resolve, so the
        // video fell back to the track's intrinsic size. A 1080p-or-larger screen
        // share then rendered at native pixels and forced the whole page wider
        // than the viewport.
        "group relative isolate flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden bg-zinc-900 ring-1 ring-inset ring-white/10 transition-shadow duration-300",
        variant === "thumbnail" ? "rounded-xl" : "rounded-2xl",
        isSpeaking &&
          !isScreenShare &&
          "ring-2 ring-emerald-400 shadow-[0_0_0_3px_rgba(16,185,129,0.28),0_0_26px_rgba(16,185,129,0.35)]",
      )}
      data-speaking={isSpeaking ? "true" : "false"}
    >
      {isSpeaking && !isScreenShare && (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 animate-pulse ring-2 ring-inset ring-emerald-300/60",
            variant === "thumbnail" ? "rounded-xl" : "rounded-2xl",
          )}
        />
      )}

      {hasVideo && isTrackReference(trackRef) ? (
        <VideoTrack
          trackRef={trackRef}
          className={cn(
            // `max-*` as well as `h/w-full`: a belt-and-braces guard so that even
            // if an ancestor's height is ever indefinite again, the intrinsic
            // video size still cannot exceed its box and push the layout out.
            "h-full max-h-full w-full max-w-full",
            videoFit,
            mirrored && isLocal && !isScreenShare && "-scale-x-100",
          )}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-zinc-800 to-zinc-900">
          <span
            className={cn(
              "grid place-items-center rounded-full bg-zinc-700/80 font-semibold text-zinc-100",
              variant === "spotlight"
                ? "h-24 w-24 text-3xl"
                : variant === "thumbnail"
                  ? "h-10 w-10 text-sm"
                  : "h-16 w-16 text-xl",
            )}
            aria-hidden="true"
          >
            {initialsOf(label)}
          </span>
          {variant !== "thumbnail" && (
            <span className="text-xs text-zinc-400">Camera off</span>
          )}
        </div>
      )}

      <ReactionOverlay identity={participant.identity} />

      {handRaised && (
        <RaisedHandIndicator className="absolute left-2 top-2 z-10" />
      )}

      {isLocal && !isScreenShare && onToggleMirror !== undefined && (
        <button
          type="button"
          onClick={onToggleMirror}
          aria-pressed={mirrored}
          aria-label={
            mirrored ? "Turn off mirrored view" : "Mirror your own video"
          }
          title="Mirror your own video"
          className={cn(
            "absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-lg bg-zinc-950/70 text-zinc-200 opacity-0 transition-opacity hover:bg-zinc-950 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 group-hover:opacity-100",
            mirrored && "text-emerald-300 opacity-100",
          )}
        >
          <FlipHorizontal2 className="h-4 w-4" aria-hidden="true" />
        </button>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 bg-gradient-to-t from-zinc-950/85 to-transparent px-2.5 py-2">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 truncate font-medium text-zinc-50",
            variant === "thumbnail" ? "text-[11px]" : "text-xs sm:text-sm",
          )}
        >
          {isScreenShare && (
            <MonitorUp
              className="h-3.5 w-3.5 shrink-0 text-sky-300"
              aria-hidden="true"
            />
          )}
          {isHost && (
            <Crown
              className="h-3.5 w-3.5 shrink-0 text-amber-300"
              aria-hidden="true"
            />
          )}
          <span className="truncate">
            {isScreenShare ? `${label}'s screen` : label}
            {isLocal && !isScreenShare ? " (You)" : ""}
          </span>
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {!isScreenShare && <MicrophoneStateIcon participant={participant} />}
          <ConnectionQualityIcon participant={participant} />
        </span>
      </div>
    </div>
  );
}

function readHostFromMetadata(metadata: string | undefined): string | null {
  if (metadata === undefined || metadata.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record: Record<string, unknown> = parsed as Record<string, unknown>;

  for (const key of ["hostIdentity", "host", "createdBy", "ownerIdentity"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

/**
 * Identity of the meeting host, guessed from the room.
 *
 * @deprecated Superseded by `useMeetingRoles`, which reads the host from the
 * database. The fallback below — the earliest participant still connected — is
 * wrong the moment the real host leaves: the crown moved to whoever remained,
 * while the moderation controls stayed with the actual owner, so the badge and
 * the permissions disagreed.
 *
 * Kept only so nothing silently loses a host badge if a caller is missed; it has
 * no remaining callers and should be deleted once that is certain.
 */
export function useHostIdentity(participants: readonly Participant[]): string | null {
  const { metadata } = useRoomInfo();

  return React.useMemo(() => {
    const fromMetadata = readHostFromMetadata(metadata);
    if (fromMetadata !== null) {
      return fromMetadata;
    }

    let earliest: Participant | null = null;
    for (const participant of participants) {
      const joinedAt = participant.joinedAt?.getTime();
      if (joinedAt === undefined) {
        continue;
      }
      const earliestAt = earliest?.joinedAt?.getTime();
      if (earliestAt === undefined || joinedAt < earliestAt) {
        earliest = participant;
      }
    }

    return earliest === null ? null : earliest.identity;
  }, [metadata, participants]);
}

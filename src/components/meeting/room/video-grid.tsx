"use client";

import {
  isTrackReference,
  useLocalParticipant,
  useSpeakingParticipants,
  useTracks,
} from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { Track } from "livekit-client";
import * as React from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

import {
  ParticipantVideoTile,
  participantDisplayName,
  trackReferenceKey,
} from "./participant-tile";
import { useMeetingRoles } from "./roles-provider";
import { ScreenShareViewport } from "./screen-share-viewport";

export type LayoutMode = "gallery" | "speaker";

export interface VideoGridProps {
  /** The layout the user picked in the dock. */
  layout: LayoutMode;
  className?: string;
}

/**
 * Column counts per participant count. Tailwind needs literal class names, so
 * these are spelled out rather than interpolated.
 */
function galleryColumnsClass(count: number): string {
  if (count <= 1) {
    return "grid-cols-1";
  }
  if (count === 2) {
    return "grid-cols-1 sm:grid-cols-2";
  }
  if (count <= 4) {
    return "grid-cols-1 sm:grid-cols-2";
  }
  if (count <= 9) {
    return "grid-cols-2 sm:grid-cols-2 lg:grid-cols-3";
  }
  if (count <= 16) {
    return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
  }
  return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
}

/**
 * Announces new screen shares. Kept here because this is where the
 * screen-share track references are already being tracked.
 */
function useScreenShareToasts(
  screenShareTracks: readonly TrackReferenceOrPlaceholder[],
): void {
  const announcedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    const live = new Set<string>();

    for (const trackRef of screenShareTracks) {
      const key = trackReferenceKey(trackRef);
      live.add(key);

      if (!announcedRef.current.has(key)) {
        announcedRef.current.add(key);
        const who = trackRef.participant.isLocal
          ? "You"
          : participantDisplayName(trackRef.participant);
        toast.info(`${who} started sharing a screen`);
      }
    }

    // Forget finished shares so a later share by the same person re-announces.
    const stale: string[] = [];
    announcedRef.current.forEach((key) => {
      if (!live.has(key)) {
        stale.push(key);
      }
    });
    for (const key of stale) {
      announcedRef.current.delete(key);
    }
  }, [screenShareTracks]);
}

/** Remembers the most recent speaker so the spotlight does not flicker empty. */
function useDominantSpeakerIdentity(): string | null {
  const speaking = useSpeakingParticipants();
  const [identity, setIdentity] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (speaking.length === 0) {
      return;
    }
    setIdentity(speaking[0].identity);
  }, [speaking]);

  return identity;
}

export function VideoGrid({ layout, className }: VideoGridProps): React.JSX.Element {
  const { localParticipant } = useLocalParticipant();
  // From the database, not inferred. A guessed host moved the crown to whoever
  // remained after the real host left.
  const { hostIdentity } = useMeetingRoles();
  const dominantSpeaker = useDominantSpeakerIdentity();

  const [mirrorLocal, setMirrorLocal] = React.useState(true);
  const toggleMirror = React.useCallback(() => {
    setMirrorLocal((current) => !current);
  }, []);

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const screenShareTracks = React.useMemo(
    () =>
      tracks.filter(
        (trackRef) =>
          trackRef.source === Track.Source.ScreenShare &&
          isTrackReference(trackRef),
      ),
    [tracks],
  );

  const cameraTracks = React.useMemo(
    () => tracks.filter((trackRef) => trackRef.source === Track.Source.Camera),
    [tracks],
  );

  useScreenShareToasts(screenShareTracks);

  const activeScreenShare =
    screenShareTracks.length > 0 ? screenShareTracks[0] : null;

  // A live screen share always wins; otherwise honour the user's choice.
  const effectiveLayout: LayoutMode =
    activeScreenShare !== null ? "speaker" : layout;

  const spotlight = React.useMemo<TrackReferenceOrPlaceholder | null>(() => {
    if (activeScreenShare !== null) {
      return activeScreenShare;
    }

    if (cameraTracks.length === 0) {
      return null;
    }

    const speaking =
      dominantSpeaker === null
        ? undefined
        : cameraTracks.find(
            (trackRef) => trackRef.participant.identity === dominantSpeaker,
          );

    if (speaking !== undefined) {
      return speaking;
    }

    const remote = cameraTracks.find(
      (trackRef) => !trackRef.participant.isLocal,
    );

    return remote ?? cameraTracks[0];
  }, [activeScreenShare, cameraTracks, dominantSpeaker]);

  const localIdentity = localParticipant.identity;

  const renderTile = React.useCallback(
    (trackRef: TrackReferenceOrPlaceholder, variant: "grid" | "spotlight" | "thumbnail") => {
      const isLocalCamera =
        trackRef.participant.identity === localIdentity &&
        trackRef.source === Track.Source.Camera;

      return (
        <ParticipantVideoTile
          key={trackReferenceKey(trackRef)}
          trackRef={trackRef}
          variant={variant}
          isHost={trackRef.participant.identity === hostIdentity}
          mirrored={isLocalCamera && mirrorLocal}
          onToggleMirror={isLocalCamera ? toggleMirror : undefined}
        />
      );
    },
    [hostIdentity, localIdentity, mirrorLocal, toggleMirror],
  );

  if (cameraTracks.length === 0 && screenShareTracks.length === 0) {
    return (
      <div
        className={cn(
          "grid place-items-center px-4 text-center text-sm text-zinc-400",
          className,
        )}
      >
        Waiting for the first camera to come online…
      </div>
    );
  }

  if (effectiveLayout === "speaker" && spotlight !== null) {
    const spotlightKey = trackReferenceKey(spotlight);
    const thumbnails = cameraTracks.filter(
      (trackRef) => trackReferenceKey(trackRef) !== spotlightKey,
    );

    /**
     * A spotlit screen share gets the zoomable viewport instead of a plain tile.
     *
     * Narrowed here rather than inside the viewport so the component can require a
     * real `TrackReference`: its zoom maths reads the decoded resolution off the
     * video element, which a placeholder has no way to provide.
     */
    const screenShareSpotlight =
      spotlight.source === Track.Source.ScreenShare &&
      isTrackReference(spotlight)
        ? spotlight
        : null;

    return (
      <div className={cn("flex min-h-0 min-w-0 flex-col gap-3", className)}>
        {/* `min-w-0` matters in a flex column: without it a wide screen share can
            set the flex item's min-content width and push the row past the
            viewport, which no amount of zooming out fixes.
            `overflow-hidden` stays even though the viewport below scrolls its own
            content — it is the backstop that keeps a zoomed share from ever
            reaching the page. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {screenShareSpotlight === null ? (
            renderTile(spotlight, "spotlight")
          ) : (
            <ScreenShareViewport
              trackRef={screenShareSpotlight}
              isHost={
                screenShareSpotlight.participant.identity === hostIdentity
              }
            />
          )}
        </div>

        {thumbnails.length > 0 && (
          <ul
            aria-label="Other participants"
            className="flex shrink-0 list-none gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
          >
            {thumbnails.map((trackRef) => (
              <li
                key={trackReferenceKey(trackRef)}
                className="aspect-video h-20 shrink-0 sm:h-24 lg:h-28"
              >
                {renderTile(trackRef, "thumbnail")}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const galleryTracks = [...screenShareTracks, ...cameraTracks];

  return (
    <div
      className={cn(
        "grid min-h-0 auto-rows-fr gap-2 sm:gap-3",
        galleryColumnsClass(galleryTracks.length),
        className,
      )}
    >
      {galleryTracks.map((trackRef) => renderTile(trackRef, "grid"))}
    </div>
  );
}

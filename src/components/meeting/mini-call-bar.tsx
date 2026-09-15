"use client";

import {
  useLocalParticipant,
  useParticipants,
  VideoTrack,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import {
  Maximize2,
  Mic,
  MicOff,
  PhoneOff,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { Button } from "@/components/ui/button";

import { useCall } from "./call-provider";

/**
 * Floating call controls shown while the user is on another page.
 *
 * The call itself keeps running in `CallProvider`; this is the surface that makes
 * that visible and controllable. Without it, a live call would be invisible the
 * moment you opened the dashboard, which is worse than dropping it.
 *
 * Mic and camera are here on purpose: the most common reason to leave the meeting
 * page mid-call is to look something up, and you still need to mute.
 */
export function MiniCallBar() {
  const { session, leaveCall } = useCall();
  const participants = useParticipants();
  const {
    localParticipant,
    isMicrophoneEnabled,
    isCameraEnabled,
  } = useLocalParticipant();

  const [pending, setPending] = React.useState<"mic" | "camera" | null>(null);

  const cameraTrack = localParticipant
    .getTrackPublications()
    .find(
      (publication) =>
        publication.source === Track.Source.Camera &&
        publication.track !== undefined,
    );

  const toggleMic = React.useCallback(async () => {
    setPending("mic");

    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch {
      // The device may have been taken by another app; the button state resyncs
      // from the real publication on the next render.
    } finally {
      setPending(null);
    }
  }, [localParticipant, isMicrophoneEnabled]);

  const toggleCamera = React.useCallback(async () => {
    setPending("camera");

    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
    } catch {
      // As above.
    } finally {
      setPending(null);
    }
  }, [localParticipant, isCameraEnabled]);

  if (session === null) {
    return null;
  }

  const roomHref = `/meeting/${encodeURIComponent(session.meetingCode)}`;

  return (
    <div
      role="region"
      aria-label="Call in progress"
      className="fixed bottom-4 right-4 z-[70] w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl backdrop-blur-xl"
    >
      <Link
        href={roomHref}
        className="group relative block aspect-video bg-zinc-950"
        aria-label="Return to the call"
      >
        {cameraTrack !== undefined && isCameraEnabled ? (
          <VideoTrack
            trackRef={{
              participant: localParticipant,
              source: Track.Source.Camera,
              publication: cameraTrack,
            }}
            // Mirrored to match the lobby preview and the in-call tile.
            className="h-full w-full scale-x-[-1] object-cover"
          />
        ) : (
          <span className="grid h-full w-full place-items-center text-xs text-zinc-500">
            Camera off
          </span>
        )}

        <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-2.5 py-2 text-[11px] text-zinc-200">
          <Users className="h-3 w-3 shrink-0" aria-hidden="true" />
          {participants.length}
          <span className="ml-auto inline-flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Maximize2 className="h-3 w-3" aria-hidden="true" />
            Return
          </span>
        </span>
      </Link>

      <div className="flex items-center gap-2 px-2.5 py-2">
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">
          {session.meetingTitle}
        </p>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={pending === "mic"}
          onClick={() => void toggleMic()}
          aria-pressed={!isMicrophoneEnabled}
          aria-label={
            isMicrophoneEnabled ? "Mute your microphone" : "Unmute your microphone"
          }
          className={`h-8 w-8 shrink-0 ${
            isMicrophoneEnabled
              ? "text-zinc-200 hover:bg-white/10"
              : "bg-red-500/90 text-white hover:bg-red-500"
          }`}
        >
          {isMicrophoneEnabled ? (
            <Mic className="h-4 w-4" />
          ) : (
            <MicOff className="h-4 w-4" />
          )}
        </Button>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={pending === "camera"}
          onClick={() => void toggleCamera()}
          aria-pressed={!isCameraEnabled}
          aria-label={
            isCameraEnabled ? "Turn your camera off" : "Turn your camera on"
          }
          className={`h-8 w-8 shrink-0 ${
            isCameraEnabled
              ? "text-zinc-200 hover:bg-white/10"
              : "bg-red-500/90 text-white hover:bg-red-500"
          }`}
        >
          {isCameraEnabled ? (
            <Video className="h-4 w-4" />
          ) : (
            <VideoOff className="h-4 w-4" />
          )}
        </Button>

        <Button
          type="button"
          size="icon"
          variant="destructive"
          onClick={leaveCall}
          aria-label="Leave the call"
          className="h-8 w-8 shrink-0"
        >
          <PhoneOff className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

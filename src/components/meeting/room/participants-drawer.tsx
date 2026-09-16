"use client";

import {
  useParticipants,
  useTrackMutedIndicator,
} from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { LocalParticipant, RemoteParticipant } from "livekit-client";
import { Track } from "livekit-client";
import {
  Crown,
  Hand,
  MicOff,
  ShieldCheck,
  UserPlus,
  UserRoundX,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  muteOneParticipant,
  removeFromMeeting,
} from "@/app/meeting/[code]/moderation";
import { setCoHost } from "@/app/meeting/[code]/roles";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { HostControls } from "./host-controls";
import { InviteToCallModal } from "./invite-to-call-modal";
import { useMeetingRoles } from "./roles-provider";
import {
  ConnectionQualityIcon,
  MicrophoneStateIcon,
  participantDisplayName,
} from "./participant-tile";
import { useReactions } from "./reactions";

type RoomParticipant = LocalParticipant | RemoteParticipant;

/** `isLocal` is true only for `LocalParticipant`, so this narrowing is sound. */
function isRemoteParticipant(
  participant: RoomParticipant,
): participant is RemoteParticipant {
  return !participant.isLocal;
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

interface ParticipantRowProps {
  participant: RoomParticipant;
  isHost: boolean;
  handPosition: number | null;
  volume: number;
  onVolumeChange: (identity: string, volume: number) => void;
  /** Undefined when the viewer cannot moderate, which is what hides the controls. */
  onModerate?: (identity: string, action: "mute" | "remove") => Promise<void>;
  /** Undefined unless the viewer owns the meeting. */
  onSetCoHost?: (identity: string, makeCoHost: boolean) => Promise<void>;
  isCoHost?: boolean;
  moderating?: boolean;
}

function ParticipantRow({
  participant,
  isHost,
  isCoHost = false,
  handPosition,
  volume,
  onVolumeChange,
  onModerate,
  onSetCoHost,
  moderating = false,
}: ParticipantRowProps): React.JSX.Element {
  /** Two-step, because removing someone mid-sentence is not undoable. */
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const cameraRef = React.useMemo<TrackReferenceOrPlaceholder>(
    () => ({ participant, source: Track.Source.Camera }),
    [participant],
  );
  const { isMuted: isCameraMuted } = useTrackMutedIndicator(cameraRef);

  const label = participantDisplayName(participant);
  const remote = isRemoteParticipant(participant);
  const sliderId = `volume-${participant.sid}`;

  return (
    <li className="rounded-xl bg-white/5 px-3 py-2.5 ring-1 ring-inset ring-white/10">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-zinc-700 text-xs font-semibold text-zinc-100"
        >
          {initialsOf(label)}
        </span>

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 truncate text-sm font-medium text-zinc-100">
            <span className="truncate">
              {label}
              {participant.isLocal ? " (You)" : ""}
            </span>
            {isHost && (
              <span
                title="Meeting host"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
              >
                <Crown className="h-3 w-3" aria-hidden="true" />
                Host
              </span>
            )}
            {isCoHost && !isHost && (
              <span
                title="Co-host: has moderation controls granted by the host"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300"
              >
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                Co-host
              </span>
            )}
          </span>

          {handPosition !== null && (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-amber-300">
              <Hand className="h-3 w-3" aria-hidden="true" />
              Hand raised · #{handPosition}
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <MicrophoneStateIcon participant={participant} />
          {isCameraMuted ? (
            <span title="Camera off" className="inline-flex items-center">
              <VideoOff className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
              <span className="sr-only">Camera off</span>
            </span>
          ) : (
            <span title="Camera on" className="inline-flex items-center">
              <Video className="h-3.5 w-3.5 text-zinc-300" aria-hidden="true" />
              <span className="sr-only">Camera on</span>
            </span>
          )}
          <ConnectionQualityIcon participant={participant} />
        </span>
      </div>

      {(onModerate !== undefined || onSetCoHost !== undefined) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2">
          {onSetCoHost !== undefined && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={moderating}
              onClick={() => void onSetCoHost(participant.identity, !isCoHost)}
              className="h-7 px-2 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-sky-300"
              aria-label={
                isCoHost
                  ? `Remove co-host from ${label}`
                  : `Make ${label} a co-host`
              }
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {isCoHost ? "Remove co-host" : "Make co-host"}
            </Button>
          )}
        </div>
      )}

      {onModerate !== undefined && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={moderating}
            onClick={() => void onModerate(participant.identity, "mute")}
            className="h-7 px-2 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-white"
            aria-label={`Mute ${label}`}
          >
            <MicOff className="h-3.5 w-3.5" aria-hidden="true" />
            Mute
          </Button>

          {!confirmRemove ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={moderating}
              onClick={() => setConfirmRemove(true)}
              className="h-7 px-2 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-red-300"
              aria-label={`Remove ${label} from the meeting`}
            >
              <UserRoundX className="h-3.5 w-3.5" aria-hidden="true" />
              Remove
            </Button>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-zinc-400">
              Remove?
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={moderating}
                onClick={() => {
                  setConfirmRemove(false);
                  void onModerate(participant.identity, "remove");
                }}
                className="h-7 px-2 text-[11px]"
              >
                Yes
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmRemove(false)}
                className="h-7 px-2 text-[11px]"
              >
                No
              </Button>
            </span>
          )}
        </div>
      )}

      {remote && (
        <div className="mt-2.5 flex items-center gap-2">
          <label htmlFor={sliderId} className="sr-only">
            {`Volume for ${label}`}
          </label>
          {volume === 0 ? (
            <VolumeX className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
          ) : (
            <Volume2 className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
          )}
          <input
            id={sliderId}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(event) => {
              onVolumeChange(participant.identity, Number(event.target.value));
            }}
            aria-valuetext={`${Math.round(volume * 100)} percent`}
            // Native appearance is kept on purpose: an `appearance-none` range
            // input loses its thumb in WebKit unless it is fully restyled.
            className="w-full cursor-pointer accent-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          />
          <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-zinc-400">
            {Math.round(volume * 100)}%
          </span>
        </div>
      )}
    </li>
  );
}

export interface ParticipantsDrawerProps {
  /** Needed to invite people into *this* room. */
  meetingCode: string;

  open: boolean;
  onClose: () => void;
}

/**
 * Room roster. Raised hands float to the top in the order they were raised,
 * so the host can work through them as a queue.
 */
export function ParticipantsDrawer({
  open,
  onClose,
  meetingCode,
}: ParticipantsDrawerProps): React.JSX.Element {
  const participants = useParticipants();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [moderating, setModerating] = React.useState<string | null>(null);

  // Authoritative, from the database. The old `useHostIdentity` guessed the host
  // from the earliest connected participant, so the crown drifted to whoever was
  // left when the real host hung up.
  const {
    hostIdentity,
    isHost,
    canModerate,
    isCoHostIdentity,
    refresh: refreshRoles,
  } = useMeetingRoles();

  /** Server-side mute or removal, applied to one LiveKit identity. */
  const moderate = React.useCallback(
    async (
      identity: string,
      action: "mute" | "remove",
    ): Promise<void> => {
      setModerating(identity);

      try {
        const outcome =
          action === "mute"
            ? await muteOneParticipant(meetingCode, identity)
            : await removeFromMeeting(meetingCode, identity);

        if (outcome.ok) {
          toast.success(outcome.message);
        } else {
          toast.error(outcome.message);
        }
      } finally {
        setModerating(null);
      }
    },
    [meetingCode],
  );

  /** Promotes or demotes a co-host, then re-reads roles so badges update now. */
  const setRole = React.useCallback(
    async (identity: string, makeCoHost: boolean): Promise<void> => {
      setModerating(identity);

      try {
        const outcome = await setCoHost(meetingCode, identity, makeCoHost);

        if (outcome.ok) {
          toast.success(outcome.message);
          refreshRoles();
        } else {
          toast.error(outcome.message);
        }
      } finally {
        setModerating(null);
      }
    },
    [meetingCode, refreshRoles],
  );
  const { raisedHands } = useReactions();
  const shouldReduceMotion = useReducedMotion() === true;

  const [volumes, setVolumes] = React.useState<Readonly<Record<string, number>>>(
    {},
  );

  React.useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  // Drop volume entries for people who have left so the map cannot grow forever.
  React.useEffect(() => {
    const present = new Set(participants.map((one) => one.identity));
    setVolumes((current) => {
      const stale = Object.keys(current).filter(
        (identity) => !present.has(identity),
      );
      if (stale.length === 0) {
        return current;
      }
      const next: Record<string, number> = {};
      for (const [identity, value] of Object.entries(current)) {
        if (present.has(identity)) {
          next[identity] = value;
        }
      }
      return next;
    });
  }, [participants]);

  const participantByIdentity = React.useMemo(() => {
    const map = new Map<string, RoomParticipant>();
    for (const participant of participants) {
      map.set(participant.identity, participant);
    }
    return map;
  }, [participants]);

  const handleVolumeChange = React.useCallback(
    (identity: string, volume: number) => {
      const clamped = Math.min(1, Math.max(0, volume));
      const participant = participantByIdentity.get(identity);
      if (participant !== undefined && isRemoteParticipant(participant)) {
        participant.setVolume(clamped);
      }
      setVolumes((current) => ({ ...current, [identity]: clamped }));
    },
    [participantByIdentity],
  );

  const handQueue = React.useMemo(() => {
    const positions = new Map<string, number>();
    raisedHands.forEach((hand, index) => {
      positions.set(hand.identity, index + 1);
    });
    return positions;
  }, [raisedHands]);

  const ordered = React.useMemo(() => {
    return [...participants].sort((left, right) => {
      const leftHand = handQueue.get(left.identity);
      const rightHand = handQueue.get(right.identity);

      if (leftHand !== undefined && rightHand !== undefined) {
        return leftHand - rightHand;
      }
      if (leftHand !== undefined) {
        return -1;
      }
      if (rightHand !== undefined) {
        return 1;
      }

      if (left.identity === hostIdentity) {
        return -1;
      }
      if (right.identity === hostIdentity) {
        return 1;
      }

      return participantDisplayName(left).localeCompare(
        participantDisplayName(right),
      );
    });
  }, [handQueue, hostIdentity, participants]);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          role="dialog"
          aria-label="Participants"
          initial={{ x: shouldReduceMotion ? 0 : "100%", opacity: shouldReduceMotion ? 0 : 1 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: shouldReduceMotion ? 0 : "100%", opacity: shouldReduceMotion ? 0 : 1 }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 320, damping: 34 }
          }
          className="absolute inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-white/10 bg-zinc-950/95 text-zinc-100 shadow-2xl backdrop-blur-xl"
        >
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
            <h2 className="text-sm font-semibold tracking-tight">
              Participants
              <span className="ml-2 rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-zinc-300">
                {participants.length}
              </span>
            </h2>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setInviteOpen(true)}
                className="h-8 border-white/15 bg-white/[0.06] px-2.5 text-xs text-zinc-100 hover:bg-white/[0.14] hover:text-white"
                aria-label="Add people to this call"
              >
                <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                Add
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onClose}
                aria-label="Close participants"
                className="h-8 w-8 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </header>

          <InviteToCallModal
            meetingCode={meetingCode}
            open={inviteOpen}
            onOpenChange={setInviteOpen}
          />

          {canModerate && <HostControls meetingCode={meetingCode} />}

          {raisedHands.length > 0 && (
            <p
              className={cn(
                "shrink-0 border-b border-white/10 bg-amber-400/10 px-4 py-2 text-xs font-medium text-amber-200",
              )}
            >
              {raisedHands.length === 1
                ? "1 raised hand waiting"
                : `${raisedHands.length} raised hands waiting`}
            </p>
          )}

          <ul className="min-h-0 flex-1 list-none space-y-2 overflow-y-auto px-3 py-3">
            {ordered.map((participant) => (
              <ParticipantRow
                key={participant.sid}
                participant={participant}
                isHost={participant.identity === hostIdentity}
                isCoHost={isCoHostIdentity(participant.identity)}
                handPosition={handQueue.get(participant.identity) ?? null}
                volume={volumes[participant.identity] ?? 1}
                onVolumeChange={handleVolumeChange}
                // Offered to the host and co-hosts, never against the host —
                // delegated moderation must not be able to eject its source.
                onModerate={
                  canModerate && participant.identity !== hostIdentity
                    ? moderate
                    : undefined
                }
                // Appointing co-hosts is ownership, so host only.
                onSetCoHost={
                  isHost && participant.identity !== hostIdentity
                    ? setRole
                    : undefined
                }
                moderating={moderating === participant.identity}
              />
            ))}
          </ul>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

"use client";

import {
  Check,
  DoorOpen,
  Lock,
  LockOpen,
  MicOff,
  PhoneOff,
  ShieldCheck,
  UserRoundCheck,
  UserRoundX,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import { endMeeting } from "@/app/meeting/[code]/actions";
import {
  decideWaitingRoom,
  getModerationState,
  muteAllParticipants,
  setMeetingLock,
  setWaitingRoom,
  type MeetingModerationState,
} from "@/app/meeting/[code]/moderation";
import { Button } from "@/components/ui/button";

import { useCall } from "../call-provider";

interface HostControlsProps {
  meetingCode: string;
}

/**
 * How often the knock queue is refreshed.
 *
 * Someone waiting to be let in is actively staring at a spinner, so this is
 * faster than the message poll — but it is still a database round trip, and only
 * the host polls it.
 */
const POLL_INTERVAL_MS = 5000;

const EMPTY: MeetingModerationState = {
  ok: false,
  isLocked: false,
  waitingRoomEnabled: false,
  moderationAvailable: false,
  waiting: [],
};

/**
 * Host-only moderation panel: mute all, lock, waiting room, and the knock queue.
 *
 * Rendered only for the host, but every action re-verifies that server-side —
 * hiding a button is presentation, not authorization.
 */
export function HostControls({ meetingCode }: HostControlsProps) {
  const { leaveCall } = useCall();
  const router = useRouter();

  const [state, setState] = React.useState<MeetingModerationState>(EMPTY);
  const [busy, setBusy] = React.useState<string | null>(null);
  /** Two-step, because ending a call for everyone is not undoable. */
  const [confirmEnd, setConfirmEnd] = React.useState(false);

  const inFlightRef = React.useRef(false);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = React.useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;

    try {
      const next = await getModerationState(meetingCode);

      if (mountedRef.current) {
        setState(next);
      }
    } catch {
      // A failed poll is not worth surfacing; the next tick retries.
    } finally {
      inFlightRef.current = false;
    }
  }, [meetingCode]);

  React.useEffect(() => {
    void refresh();

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [refresh]);

  async function run(
    key: string,
    action: () => Promise<{ ok: boolean; message: string }>,
  ): Promise<void> {
    setBusy(key);

    try {
      const outcome = await action();

      if (outcome.message.length > 0) {
        if (outcome.ok) {
          toast.success(outcome.message);
        } else {
          toast.error(outcome.message);
        }
      }

      await refresh();
    } finally {
      if (mountedRef.current) {
        setBusy(null);
      }
    }
  }

  // Not the host: the server refused, so render nothing rather than a dead panel.
  if (!state.ok) {
    return null;
  }

  return (
    <section
      aria-label="Host controls"
      className="shrink-0 border-b border-white/10 bg-white/[0.02] px-4 py-3"
    >
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        Host controls
      </h3>

      <div className="grid grid-cols-1 gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null || !state.moderationAvailable}
          onClick={() =>
            void run("mute-all", () => muteAllParticipants(meetingCode))
          }
          className="h-9 justify-start border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14] hover:text-white"
          title={
            state.moderationAvailable
              ? "Mute every other microphone"
              : "The media server is not configured for moderation"
          }
        >
          <MicOff className="h-4 w-4" aria-hidden="true" />
          Mute everyone else
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            void run("lock", () => setMeetingLock(meetingCode, !state.isLocked))
          }
          className="h-9 justify-start border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14] hover:text-white"
        >
          {state.isLocked ? (
            <Lock className="h-4 w-4 text-amber-300" aria-hidden="true" />
          ) : (
            <LockOpen className="h-4 w-4" aria-hidden="true" />
          )}
          {state.isLocked ? "Unlock meeting" : "Lock meeting"}
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            void run("waiting", () =>
              setWaitingRoom(meetingCode, !state.waitingRoomEnabled),
            )
          }
          className="h-9 justify-start border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14] hover:text-white"
          aria-pressed={state.waitingRoomEnabled}
        >
          <DoorOpen
            className={`h-4 w-4 ${
              state.waitingRoomEnabled ? "text-emerald-300" : ""
            }`}
            aria-hidden="true"
          />
          Waiting room: {state.waitingRoomEnabled ? "on" : "off"}
        </Button>
      </div>

      {/* Ending is deliberately explicit. Leaving the page, or even pressing
          Leave, no longer ends the meeting for everyone — this button is the only
          thing that does, so a host can step away and come back. */}
      {!confirmEnd ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => setConfirmEnd(true)}
          className="mt-1.5 h-9 w-full justify-start border-red-400/30 bg-red-500/10 text-red-200 hover:bg-red-500/20 hover:text-red-100"
        >
          <PhoneOff className="h-4 w-4" aria-hidden="true" />
          End meeting for everyone
        </Button>
      ) : (
        <div className="mt-1.5 rounded-lg border border-red-400/30 bg-red-500/10 p-2">
          <p className="mb-2 text-[11px] text-red-100">
            This ends the call for everyone and moves it to past meetings.
          </p>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                setConfirmEnd(false);
                void run("end", async () => {
                  const outcome = await endMeeting(meetingCode);

                  if (outcome.ok) {
                    leaveCall();
                    router.push("/dashboard");
                  }

                  return outcome;
                });
              }}
              className="h-8 flex-1 text-[11px]"
            >
              End meeting
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmEnd(false)}
              className="h-8 flex-1 text-[11px]"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {state.isLocked && (
        <p className="mt-2 rounded-lg bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-200">
          Locked. People already here are unaffected.
        </p>
      )}

      {state.waiting.length > 0 && (
        <div className="mt-3">
          <p
            className="mb-1.5 text-xs font-medium text-zinc-300"
            role="status"
            aria-live="polite"
          >
            {state.waiting.length} waiting to join
          </p>

          <ul className="space-y-1.5">
            {state.waiting.map((guest) => (
              <li
                key={guest.userId}
                className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5"
              >
                <UserRoundCheck
                  className="h-4 w-4 shrink-0 text-zinc-400"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-100">
                  {guest.name ?? `@${guest.username}`}
                </span>

                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`admit-${guest.userId}`, () =>
                      decideWaitingRoom(meetingCode, guest.userId, "admit"),
                    )
                  }
                  className="h-7 w-7 bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
                  aria-label={`Admit @${guest.username}`}
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>

                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`deny-${guest.userId}`, () =>
                      decideWaitingRoom(meetingCode, guest.userId, "deny"),
                    )
                  }
                  className="h-7 w-7 text-zinc-400 hover:bg-white/10 hover:text-red-300"
                  aria-label={`Deny @${guest.username}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!state.moderationAvailable && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-zinc-500">
          <UserRoundX className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          Muting and removing need LIVEKIT_API_KEY and LIVEKIT_API_SECRET set on
          the server. Lock and waiting room work without them.
        </p>
      )}
    </section>
  );
}

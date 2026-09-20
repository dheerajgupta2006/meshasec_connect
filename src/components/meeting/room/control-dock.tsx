"use client";

import { useLocalParticipant, useParticipants } from "@livekit/components-react";
import {
  BarChart3,
  Hand,
  LayoutGrid,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PenLine,
  PhoneOff,
  Smile,
  SquareUser,
  UserPlus,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { cn } from "@/lib/utils";

import type { BackgroundEffect } from "@/lib/meetings/backgrounds";

import { useCall } from "../call-provider";
import { BackgroundControl } from "./background-control";
import { useMeetingChat } from "./chat-drawer";
import { InviteToCallModal } from "./invite-to-call-modal";
import { ReactionPicker, useReactions } from "./reactions";
import type { LayoutMode } from "./video-grid";

export type DrawerId =
  | "chat"
  | "participants"
  | "polls"
  | "board"
  | null;

/**
 * Hard ceiling on a push-to-talk hold. If a `keyup` never arrives — an OS
 * dialog steals focus, the tab is swapped mid-hold — the mic still closes.
 */
const MAX_PUSH_TO_TALK_MS = 30_000;

export interface ControlDockProps {
  layout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  activeDrawer: DrawerId;
  onDrawerChange: (drawer: DrawerId) => void;
  /** Needed to invite people into *this* room. */
  meetingCode: string;
  /** Background chosen in the lobby, applied once the camera track exists. */
  initialBackgroundEffect: BackgroundEffect;
}

interface DockButtonProps extends React.ComponentPropsWithoutRef<"button"> {
  /** Screen-reader name. Always required. */
  label: string;
  /** Keyboard hint surfaced through `title`. */
  hint?: string;
  tone?: "neutral" | "on" | "off" | "danger";
  badge?: number;
  icon: React.ReactNode;
}

const TONE_CLASS: Record<"neutral" | "on" | "off" | "danger", string> = {
  neutral: "bg-white/10 text-zinc-100 hover:bg-white/20",
  on: "bg-emerald-500 text-zinc-950 hover:bg-emerald-400",
  off: "bg-red-500/90 text-white hover:bg-red-500",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

const DockButton = React.forwardRef<HTMLButtonElement, DockButtonProps>(
  ({ label, hint, tone = "neutral", badge, icon, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={hint === undefined ? label : `${label} (${hint})`}
      className={cn(
        "relative grid h-11 w-11 shrink-0 place-items-center rounded-full transition-all duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 disabled:pointer-events-none disabled:opacity-60 sm:h-12 sm:w-12",
        TONE_CLASS[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {badge !== undefined && badge > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-emerald-400 px-1 text-[10px] font-bold text-zinc-950"
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  ),
);
DockButton.displayName = "DockButton";

/**
 * Floating glass dock.
 *
 * Device state comes from `useLocalParticipant`, so the buttons always reflect
 * the real publication state rather than a local guess.
 */
export function ControlDock({
  layout,
  onLayoutChange,
  activeDrawer,
  onDrawerChange,
  meetingCode,
  initialBackgroundEffect,
}: ControlDockProps): React.JSX.Element {
  const participants = useParticipants();
  const {
    localParticipant,
    isMicrophoneEnabled,
    isCameraEnabled,
    isScreenShareEnabled,
  } = useLocalParticipant();
  const { unreadCount } = useMeetingChat();
  const { localHandRaised } = useReactions();

  const { leaveCall } = useCall();
  const router = useRouter();

  const [reactionsOpen, setReactionsOpen] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [micPending, setMicPending] = React.useState(false);
  const [cameraPending, setCameraPending] = React.useState(false);
  const [screenPending, setScreenPending] = React.useState(false);
  const [pushToTalkActive, setPushToTalkActive] = React.useState(false);

  const micPendingRef = React.useRef(false);
  const cameraPendingRef = React.useRef(false);
  const screenPendingRef = React.useRef(false);
  const pushToTalkRef = React.useRef({ active: false, restoreToMuted: false });
  const watchdogRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const localRef = React.useRef(localParticipant);
  React.useEffect(() => {
    localRef.current = localParticipant;
  }, [localParticipant]);

  const clearWatchdog = React.useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const endPushToTalk = React.useCallback(() => {
    if (!pushToTalkRef.current.active) {
      return;
    }

    const shouldMute = pushToTalkRef.current.restoreToMuted;
    pushToTalkRef.current = { active: false, restoreToMuted: false };
    setPushToTalkActive(false);
    clearWatchdog();

    if (shouldMute) {
      void localRef.current
        .setMicrophoneEnabled(false)
        .catch(() => undefined);
    }
  }, [clearWatchdog]);

  const startPushToTalk = React.useCallback(() => {
    if (pushToTalkRef.current.active) {
      return;
    }

    const wasEnabled = localRef.current.isMicrophoneEnabled;
    pushToTalkRef.current = { active: true, restoreToMuted: !wasEnabled };
    setPushToTalkActive(true);

    if (!wasEnabled) {
      void localRef.current.setMicrophoneEnabled(true).catch(() => {
        endPushToTalk();
      });
    }

    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      endPushToTalk();
    }, MAX_PUSH_TO_TALK_MS);
  }, [clearWatchdog, endPushToTalk]);

  // Stable handle so the document-level safety listeners never re-subscribe.
  const endPushToTalkRef = React.useRef(endPushToTalk);
  React.useEffect(() => {
    endPushToTalkRef.current = endPushToTalk;
  }, [endPushToTalk]);

  React.useEffect(() => {
    function closeIfHidden() {
      if (document.visibilityState === "hidden") {
        endPushToTalkRef.current();
      }
    }
    function closeNow() {
      endPushToTalkRef.current();
    }

    document.addEventListener("visibilitychange", closeIfHidden);
    window.addEventListener("pagehide", closeNow);

    return () => {
      document.removeEventListener("visibilitychange", closeIfHidden);
      window.removeEventListener("pagehide", closeNow);
    };
  }, []);

  // Last line of defence: unmounting mid-hold must not leave the mic open.
  React.useEffect(() => {
    const watchdog = watchdogRef;
    const pushToTalk = pushToTalkRef;
    const local = localRef;

    return () => {
      if (watchdog.current !== null) {
        clearTimeout(watchdog.current);
        watchdog.current = null;
      }
      if (pushToTalk.current.active && pushToTalk.current.restoreToMuted) {
        pushToTalk.current = { active: false, restoreToMuted: false };
        void local.current.setMicrophoneEnabled(false).catch(() => undefined);
      }
    };
  }, []);

  const toggleMicrophone = React.useCallback(() => {
    // Ignore the shortcut mid-hold, otherwise the restore state is ambiguous.
    if (micPendingRef.current || pushToTalkRef.current.active) {
      return;
    }

    micPendingRef.current = true;
    setMicPending(true);

    const next = !localRef.current.isMicrophoneEnabled;
    void localRef.current
      .setMicrophoneEnabled(next)
      .catch(() => {
        toast.error("Your microphone could not be changed");
      })
      .finally(() => {
        micPendingRef.current = false;
        setMicPending(false);
      });
  }, []);

  const toggleCamera = React.useCallback(() => {
    if (cameraPendingRef.current) {
      return;
    }

    cameraPendingRef.current = true;
    setCameraPending(true);

    const next = !localRef.current.isCameraEnabled;
    void localRef.current
      .setCameraEnabled(next)
      .catch(() => {
        toast.error("Your camera could not be changed");
      })
      .finally(() => {
        cameraPendingRef.current = false;
        setCameraPending(false);
      });
  }, []);

  const toggleScreenShare = React.useCallback(() => {
    if (screenPendingRef.current) {
      return;
    }

    screenPendingRef.current = true;
    setScreenPending(true);

    const next = !localRef.current.isScreenShareEnabled;
    void localRef.current
      .setScreenShareEnabled(next)
      .catch(() => {
        // Cancelling the browser picker lands here too, so keep it gentle.
        if (next) {
          toast.error("Screen sharing did not start");
        }
      })
      .finally(() => {
        screenPendingRef.current = false;
        setScreenPending(false);
      });
  }, []);

  useKeyboardShortcuts({
    onToggleMute: toggleMicrophone,
    onToggleVideo: toggleCamera,
    onToggleScreenShare: toggleScreenShare,
    onPushToTalkStart: startPushToTalk,
    onPushToTalkEnd: endPushToTalk,
  });

  const leave = React.useCallback(() => {
    // Routed through the provider, which owns the connection and is the only
    // place that records attendance. Navigating away deliberately does not do
    // this — pressing Leave is the only thing that means "I am done".
    leaveCall();
    router.push("/dashboard");
  }, [leaveCall, router]);

  const toggleDrawer = React.useCallback(
    (drawer: Exclude<DrawerId, null>) => {
      onDrawerChange(activeDrawer === drawer ? null : drawer);
    },
    [activeDrawer, onDrawerChange],
  );

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-2 px-2 pb-3 sm:pb-5">
      <p
        aria-live="polite"
        className={cn(
          "pointer-events-none rounded-full bg-emerald-500/95 px-3 py-1 text-xs font-semibold text-zinc-950 transition-opacity duration-200",
          pushToTalkActive ? "opacity-100" : "opacity-0",
        )}
      >
        {pushToTalkActive ? "Microphone open — release Space to stop" : ""}
      </p>

      {/* `group` rather than `toolbar`: every button is individually tabbable,
          so promising toolbar arrow-key navigation would be misleading. */}
      <div
        role="group"
        aria-label="Meeting controls"
        onKeyDown={(event) => {
          // A focused button must keep native Space activation. Push-to-talk
          // listens on `window`, so stopping propagation here means Space acts
          // on the button under focus instead of opening the mic.
          if (
            event.code === "Space" &&
            event.target instanceof HTMLButtonElement
          ) {
            event.stopPropagation();
          }
        }}
        className="pointer-events-auto flex max-w-full items-center gap-1.5 rounded-2xl border border-white/10 bg-zinc-900/70 p-1.5 shadow-2xl backdrop-blur-xl sm:gap-2 sm:rounded-full sm:p-2"
      >
        {/* Only the tool buttons scroll. Twelve 44px targets plus gaps want
            ~610px and a 375px phone offers ~360px, so on mobile this row is
            swiped. Leave used to be its last child, which meant hanging up
            required discovering the horizontal scroll first — it now sits
            outside the scroller, pinned and always reachable. */}
        {/* `-my-1 py-1` because a box with `overflow-x: auto` clips vertically
            too (CSS resolves the other axis away from `visible`), and the chat
            unread badge hangs 2px above its button. The negative margin cancels
            the padding so the pill keeps its original height. */}
        <div className="-my-1 flex min-w-0 items-center gap-1.5 overflow-x-auto py-1 sm:gap-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <DockButton
          label={isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}
          hint="M · hold Space to talk"
          tone={isMicrophoneEnabled ? "neutral" : "off"}
          aria-pressed={!isMicrophoneEnabled}
          disabled={micPending}
          onClick={toggleMicrophone}
          className={cn(
            pushToTalkActive && "ring-2 ring-emerald-400 ring-offset-2 ring-offset-zinc-900",
          )}
          icon={
            isMicrophoneEnabled ? (
              <Mic className="h-5 w-5" aria-hidden="true" />
            ) : (
              <MicOff className="h-5 w-5" aria-hidden="true" />
            )
          }
        />

        <DockButton
          label={isCameraEnabled ? "Turn camera off" : "Turn camera on"}
          hint="V"
          tone={isCameraEnabled ? "neutral" : "off"}
          aria-pressed={!isCameraEnabled}
          disabled={cameraPending}
          onClick={toggleCamera}
          icon={
            isCameraEnabled ? (
              <Video className="h-5 w-5" aria-hidden="true" />
            ) : (
              <VideoOff className="h-5 w-5" aria-hidden="true" />
            )
          }
        />

        <DockButton
          label={isScreenShareEnabled ? "Stop sharing your screen" : "Share your screen"}
          hint="Ctrl/⌘ + D"
          tone={isScreenShareEnabled ? "on" : "neutral"}
          aria-pressed={isScreenShareEnabled}
          disabled={screenPending}
          onClick={toggleScreenShare}
          icon={<MonitorUp className="h-5 w-5" aria-hidden="true" />}
        />

        <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}>
          <PopoverTrigger asChild>
            <DockButton
              label="Reactions and hand raise"
              tone={localHandRaised ? "on" : "neutral"}
              aria-expanded={reactionsOpen}
              icon={
                localHandRaised ? (
                  <Hand className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Smile className="h-5 w-5" aria-hidden="true" />
                )
              }
            />
          </PopoverTrigger>
          <PopoverContent
            align="center"
            side="top"
            sideOffset={12}
            className="w-auto border-white/10 bg-zinc-900/95 text-zinc-100 backdrop-blur-xl"
          >
            <ReactionPicker onAfterSelect={() => setReactionsOpen(false)} />
          </PopoverContent>
        </Popover>

        <DockButton
          label={activeDrawer === "chat" ? "Close chat" : "Open chat"}
          tone={activeDrawer === "chat" ? "on" : "neutral"}
          aria-pressed={activeDrawer === "chat"}
          badge={activeDrawer === "chat" ? undefined : unreadCount}
          onClick={() => toggleDrawer("chat")}
          icon={<MessageSquare className="h-5 w-5" aria-hidden="true" />}
        />

        <DockButton
          label={
            activeDrawer === "participants"
              ? "Close participants"
              : `Open participants (${participants.length} in the meeting)`
          }
          tone={activeDrawer === "participants" ? "on" : "neutral"}
          aria-pressed={activeDrawer === "participants"}
          onClick={() => toggleDrawer("participants")}
          icon={<Users className="h-5 w-5" aria-hidden="true" />}
        />

        <DockButton
          label={
            activeDrawer === "board" ? "Close whiteboard" : "Open whiteboard"
          }
          tone={activeDrawer === "board" ? "on" : "neutral"}
          aria-pressed={activeDrawer === "board"}
          onClick={() => toggleDrawer("board")}
          icon={<PenLine className="h-5 w-5" aria-hidden="true" />}
        />

        <DockButton
          label={
            activeDrawer === "polls"
              ? "Close polls and questions"
              : "Open polls and questions"
          }
          tone={activeDrawer === "polls" ? "on" : "neutral"}
          aria-pressed={activeDrawer === "polls"}
          onClick={() => toggleDrawer("polls")}
          icon={<BarChart3 className="h-5 w-5" aria-hidden="true" />}
        />

        <BackgroundControl initialEffect={initialBackgroundEffect} />

        <DockButton
          label="Add people to this call"
          tone={inviteOpen ? "on" : "neutral"}
          aria-pressed={inviteOpen}
          onClick={() => setInviteOpen(true)}
          icon={<UserPlus className="h-5 w-5" aria-hidden="true" />}
        />

        <DockButton
          label={
            layout === "gallery"
              ? "Switch to speaker view"
              : "Switch to gallery view"
          }
          tone="neutral"
          onClick={() =>
            onLayoutChange(layout === "gallery" ? "speaker" : "gallery")
          }
          icon={
            layout === "gallery" ? (
              <SquareUser className="h-5 w-5" aria-hidden="true" />
            ) : (
              <LayoutGrid className="h-5 w-5" aria-hidden="true" />
            )
          }
        />

        </div>

        <span aria-hidden="true" className="mx-0.5 h-8 w-px shrink-0 bg-white/10" />

        <DockButton
          label="Leave the meeting"
          tone="danger"
          onClick={leave}
          icon={<PhoneOff className="h-5 w-5" aria-hidden="true" />}
        />
      </div>

      <InviteToCallModal
        meetingCode={meetingCode}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
    </div>
  );
}

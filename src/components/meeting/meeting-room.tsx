"use client";

import { AlertTriangle, ArrowLeft, LoaderCircle, LogIn, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ChatDrawer } from "@/components/meeting/room/chat-drawer";
import { ControlDock } from "@/components/meeting/room/control-dock";
import type { DrawerId } from "@/components/meeting/room/control-dock";
import { ParticipantsDrawer } from "@/components/meeting/room/participants-drawer";
import { VideoGrid } from "@/components/meeting/room/video-grid";
import type { LayoutMode } from "@/components/meeting/room/video-grid";
import { Button } from "@/components/ui/button";

import { useCall } from "./call-provider";

interface MeetingRoomProps {
  /** Resolved on the server from the meeting row. Gates the host panel. */
  isHost: boolean;
  meetingCode: string;
  meetingTitle: string;
}

/**
 * The in-call surface: video grid, floating dock, and the two slide-over drawers.
 *
 * Notably absent: `LiveKitRoom`, `RoomAudioRenderer`, and the chat and reaction
 * providers. Those live in `CallProvider` in the root layout so the connection
 * survives navigation — this component only renders the view.
 */
function MeetingStage({
  meetingTitle,
  meetingCode,
  isHost,
}: {
  meetingTitle: string;
  meetingCode: string;
  isHost: boolean;
}) {
  const { session } = useCall();
  const [layout, setLayout] = useState<LayoutMode>("gallery");
  const [activeDrawer, setActiveDrawer] = useState<DrawerId>(null);

  const closeDrawer = useCallback(() => {
    setActiveDrawer(null);
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex shrink-0 items-center gap-3 px-3 py-2 sm:px-5 sm:py-3">
        <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
          {meetingTitle}
        </h1>
        <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
          {meetingCode}
        </span>
      </header>

      <VideoGrid layout={layout} className="flex-1 px-2 pb-24 sm:px-4 sm:pb-28" />

      <ControlDock
        layout={layout}
        onLayoutChange={setLayout}
        activeDrawer={activeDrawer}
        onDrawerChange={setActiveDrawer}
        meetingCode={meetingCode}
        initialBackgroundEffect={
          session?.preferences.backgroundEffect ?? { kind: "none" }
        }
      />

      <ChatDrawer open={activeDrawer === "chat"} onClose={closeDrawer} />
      <ParticipantsDrawer
        open={activeDrawer === "participants"}
        onClose={closeDrawer}
        meetingCode={meetingCode}
        isHost={isHost}
      />
    </div>
  );
}

/**
 * Meeting page entry point.
 *
 * Asks `CallProvider` to join, then renders the stage once connected. Returning to
 * this page during a live call is a no-op on the connection: `joinCall` recognises
 * the room it is already in, so the media is never torn down and rebuilt.
 */
export function MeetingRoom({
  meetingCode,
  meetingTitle,
  isHost,
}: MeetingRoomProps) {
  const { session, status, error, joinCall, retry } = useCall();

  useEffect(() => {
    joinCall({ meetingCode, meetingTitle, isHost });
  }, [joinCall, meetingCode, meetingTitle, isHost]);

  if (error !== null) {
    return (
      <RoomNotice
        title="Could not join the meeting"
        description={error.message}
        meetingCode={meetingCode}
        tone="error"
      >
        {error.action === "retry" && (
          <Button type="button" onClick={retry}>
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
        )}
        {error.action === "signin" && (
          <Button asChild>
            <Link
              href={`/sign-in?redirect_url=/meeting/${encodeURIComponent(
                meetingCode,
              )}`}
            >
              <LogIn className="h-4 w-4" />
              Sign in
            </Link>
          </Button>
        )}
      </RoomNotice>
    );
  }

  // Connected, but to a different room. Only possible for a moment while the
  // provider swaps rooms.
  if (session === null || session.meetingCode !== meetingCode) {
    return (
      <RoomNotice
        title={meetingTitle}
        description={
          status === "connecting"
            ? "Connecting you to the meeting…"
            : "Preparing the meeting…"
        }
        meetingCode={meetingCode}
        tone="loading"
      />
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] w-full bg-zinc-950">
      <MeetingStage
        meetingTitle={meetingTitle}
        meetingCode={meetingCode}
        isHost={isHost}
      />
    </div>
  );
}

function RoomNotice({
  title,
  description,
  meetingCode,
  tone,
  children,
}: {
  title: string;
  description: string;
  meetingCode: string;
  tone: "loading" | "error";
  children?: React.ReactNode;
}) {
  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-zinc-950 px-4 text-zinc-50">
      <div className="w-full max-w-md text-center">
        <span
          className={`mx-auto grid h-14 w-14 place-items-center rounded-2xl ${
            tone === "error"
              ? "bg-red-500/10 text-red-400"
              : "bg-blue-500/10 text-blue-400"
          }`}
        >
          {tone === "error" ? (
            <AlertTriangle className="h-6 w-6" />
          ) : (
            <LoaderCircle className="h-6 w-6 animate-spin" />
          )}
        </span>

        <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 leading-7 text-zinc-400">{description}</p>

        <div className="mt-7 flex flex-col-reverse items-center gap-3 sm:flex-row sm:justify-center">
          <Button
            asChild
            variant="outline"
            className="w-full border-zinc-700 bg-zinc-900 hover:bg-zinc-800 sm:w-auto"
          >
            <Link href={`/meeting/${encodeURIComponent(meetingCode)}/lobby`}>
              <ArrowLeft className="h-4 w-4" />
              Back to lobby
            </Link>
          </Button>
          {children}
        </div>
      </div>
    </main>
  );
}

"use client";

import { useUser } from "@clerk/nextjs";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
} from "@livekit/components-react";
import "@livekit/components-styles";
import {
  AlertTriangle,
  ArrowLeft,
  LoaderCircle,
  LogIn,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatDrawer, MeetingChatProvider } from "@/components/meeting/room/chat-drawer";
import { ControlDock } from "@/components/meeting/room/control-dock";
import type { DrawerId } from "@/components/meeting/room/control-dock";
import { ParticipantsDrawer } from "@/components/meeting/room/participants-drawer";
import { ReactionsProvider } from "@/components/meeting/room/reactions";
import { VideoGrid } from "@/components/meeting/room/video-grid";
import type { LayoutMode } from "@/components/meeting/room/video-grid";
import { Button } from "@/components/ui/button";

interface MeetingRoomProps {
  meetingCode: string;
  meetingTitle: string;
}

/** Written by the pre-join lobby before it navigates here. */
interface DevicePreferences {
  participantName: string;
  cameraId: string;
  microphoneId: string;
  speakerId: string;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
}

type RoomError = {
  message: string;
  action: "retry" | "signin" | "none";
};

const DEFAULT_PREFERENCES: DevicePreferences = {
  participantName: "",
  cameraId: "",
  microphoneId: "",
  speakerId: "",
  cameraEnabled: true,
  microphoneEnabled: true,
};

const serverUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "";

function readPreferences(meetingCode: string): DevicePreferences {
  try {
    const raw = window.sessionStorage.getItem(`meeting:${meetingCode}:devices`);
    if (raw === null) {
      return DEFAULT_PREFERENCES;
    }

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_PREFERENCES;
    }

    const record = parsed as Record<string, unknown>;

    return {
      participantName:
        typeof record.participantName === "string"
          ? record.participantName
          : DEFAULT_PREFERENCES.participantName,
      cameraId:
        typeof record.cameraId === "string"
          ? record.cameraId
          : DEFAULT_PREFERENCES.cameraId,
      microphoneId:
        typeof record.microphoneId === "string"
          ? record.microphoneId
          : DEFAULT_PREFERENCES.microphoneId,
      speakerId:
        typeof record.speakerId === "string"
          ? record.speakerId
          : DEFAULT_PREFERENCES.speakerId,
      cameraEnabled:
        typeof record.cameraEnabled === "boolean"
          ? record.cameraEnabled
          : DEFAULT_PREFERENCES.cameraEnabled,
      microphoneEnabled:
        typeof record.microphoneEnabled === "boolean"
          ? record.microphoneEnabled
          : DEFAULT_PREFERENCES.microphoneEnabled,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Applies the speaker chosen in the lobby once the room is connected. */
function SpeakerPreference({ speakerId }: { speakerId: string }) {
  const room = useRoomContext();

  useEffect(() => {
    if (speakerId.length === 0) {
      return;
    }
    room
      .switchActiveDevice("audiooutput", speakerId)
      .catch(() => undefined);
  }, [room, speakerId]);

  return null;
}

/**
 * The in-call surface: video grid, floating dock, and the two slide-over
 * drawers. Layout and drawer state live here because the dock toggles them and
 * the grid and drawers consume them.
 */
function MeetingStage({
  meetingTitle,
  meetingCode,
}: {
  meetingTitle: string;
  meetingCode: string;
}) {
  const [layout, setLayout] = useState<LayoutMode>("gallery");
  const [activeDrawer, setActiveDrawer] = useState<DrawerId>(null);

  const closeDrawer = useCallback(() => {
    setActiveDrawer(null);
  }, []);

  return (
    <MeetingChatProvider>
      <ReactionsProvider>
        <div className="relative flex h-full w-full flex-col overflow-hidden bg-zinc-950 text-zinc-100">
          <header className="flex shrink-0 items-center gap-3 px-3 py-2 sm:px-5 sm:py-3">
            <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
              {meetingTitle}
            </h1>
            <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
              {meetingCode}
            </span>
          </header>

          <VideoGrid
            layout={layout}
            className="flex-1 px-2 pb-24 sm:px-4 sm:pb-28"
          />

          <ControlDock
            layout={layout}
            onLayoutChange={setLayout}
            activeDrawer={activeDrawer}
            onDrawerChange={setActiveDrawer}
          />

          <ChatDrawer open={activeDrawer === "chat"} onClose={closeDrawer} />
          <ParticipantsDrawer
            open={activeDrawer === "participants"}
            onClose={closeDrawer}
          />

          {/* The prefab used to provide this. It must appear exactly once. */}
          <RoomAudioRenderer />
        </div>
      </ReactionsProvider>
    </MeetingChatProvider>
  );
}

export function MeetingRoom({ meetingCode, meetingTitle }: MeetingRoomProps) {
  const router = useRouter();
  const { user, isLoaded } = useUser();

  const [preferences, setPreferences] = useState<DevicePreferences | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<RoomError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const leavingRef = useRef(false);

  // sessionStorage is only available in the browser, so read it after mount.
  useEffect(() => {
    setPreferences(readPreferences(meetingCode));
  }, [meetingCode]);

  useEffect(() => {
    if (preferences === null || !isLoaded || token !== null) {
      return;
    }

    if (serverUrl.length === 0) {
      setError({
        message:
          "The LiveKit server URL is not configured. Set NEXT_PUBLIC_LIVEKIT_URL in your environment and restart the app.",
        action: "none",
      });
      return;
    }

    const participantName =
      preferences.participantName.trim().length > 0
        ? preferences.participantName.trim()
        : (user?.fullName ??
          user?.firstName ??
          user?.primaryEmailAddress?.emailAddress.split("@")[0] ??
          "Guest");

    let cancelled = false;

    async function requestToken() {
      setError(null);

      try {
        const response = await fetch("/api/meetings/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ meetingCode, participantName }),
        });

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setError(describeTokenFailure(response.status));
          return;
        }

        const payload: unknown = await response.json();
        const issued =
          typeof payload === "object" &&
          payload !== null &&
          typeof (payload as { token?: unknown }).token === "string"
            ? (payload as { token: string }).token
            : null;

        if (cancelled) {
          return;
        }

        if (issued === null) {
          setError({
            message: "The server returned an unreadable access token.",
            action: "retry",
          });
          return;
        }

        setToken(issued);
      } catch {
        if (!cancelled) {
          setError({
            message:
              "We could not reach the server. Check your connection and try again.",
            action: "retry",
          });
        }
      }
    }

    void requestToken();

    return () => {
      cancelled = true;
    };
  }, [preferences, isLoaded, token, meetingCode, user, attempt]);

  const handleDisconnected = useCallback(() => {
    if (leavingRef.current) {
      return;
    }
    leavingRef.current = true;
    router.push("/dashboard");
  }, [router]);

  const handleRoomError = useCallback((roomError: Error) => {
    setToken(null);
    setError({
      message:
        roomError.message.length > 0
          ? roomError.message
          : "The connection to the meeting failed.",
      action: "retry",
    });
  }, []);

  const retry = useCallback(() => {
    setToken(null);
    setError(null);
    setAttempt((current) => current + 1);
  }, []);

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

  if (preferences === null || token === null) {
    return (
      <RoomNotice
        title={meetingTitle}
        description="Connecting you to the meeting…"
        meetingCode={meetingCode}
        tone="loading"
      />
    );
  }

  return (
    <div
      data-lk-theme="default"
      className="h-[calc(100vh-4rem)] w-full bg-zinc-950"
    >
      <LiveKitRoom
        token={token}
        serverUrl={serverUrl}
        connect
        video={preferences.cameraEnabled}
        audio={preferences.microphoneEnabled}
        options={{
          videoCaptureDefaults: {
            deviceId:
              preferences.cameraId.length > 0
                ? preferences.cameraId
                : undefined,
          },
          audioCaptureDefaults: {
            deviceId:
              preferences.microphoneId.length > 0
                ? preferences.microphoneId
                : undefined,
          },
        }}
        onDisconnected={handleDisconnected}
        onError={handleRoomError}
        className="h-full"
      >
        <MeetingStage meetingTitle={meetingTitle} meetingCode={meetingCode} />
        <SpeakerPreference speakerId={preferences.speakerId} />
      </LiveKitRoom>
    </div>
  );
}

function describeTokenFailure(status: number): RoomError {
  if (status === 401) {
    return {
      message: "Your session has ended. Sign in again to join this meeting.",
      action: "signin",
    };
  }
  if (status === 403) {
    return {
      message:
        "This is a private meeting and you are not one of its participants. Ask the host to invite you.",
      action: "none",
    };
  }
  if (status === 404) {
    return {
      message: "This meeting no longer exists.",
      action: "none",
    };
  }
  if (status === 429) {
    return {
      message:
        "Too many join attempts from your account. Wait a moment and try again.",
      action: "retry",
    };
  }
  if (status === 400) {
    return {
      message: "This meeting request was rejected. Return to the lobby and retry.",
      action: "none",
    };
  }
  return {
    message: "The meeting service is unavailable right now.",
    action: "retry",
  };
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

"use client";

import { useUser } from "@clerk/nextjs";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { leaveMeeting } from "@/app/meeting/[code]/actions";
import { CaptionsProvider } from "@/components/meeting/room/captions-provider";
import { MeetingChatProvider } from "@/components/meeting/room/chat-drawer";
import { ReactionsProvider } from "@/components/meeting/room/reactions";
import {
  NO_BACKGROUND,
  parseBackgroundEffect,
  type BackgroundEffect,
} from "@/lib/meetings/backgrounds";

import { MiniCallBar } from "./mini-call-bar";

/**
 * Device choices made in the pre-join lobby.
 *
 * Read from `sessionStorage`, which is where the lobby writes them before it
 * navigates.
 */
export interface DevicePreferences {
  backgroundEffect: BackgroundEffect;
  participantName: string;
  cameraId: string;
  microphoneId: string;
  speakerId: string;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
}

const DEFAULT_PREFERENCES: DevicePreferences = {
  participantName: "",
  cameraId: "",
  microphoneId: "",
  speakerId: "",
  cameraEnabled: true,
  microphoneEnabled: true,
  backgroundEffect: NO_BACKGROUND,
};

export interface CallError {
  message: string;
  action: "retry" | "signin" | "none";
}

export interface ActiveSession {
  meetingCode: string;
  meetingTitle: string;
  isHost: boolean;
  preferences: DevicePreferences;
  token: string;
}

export interface JoinRequest {
  meetingCode: string;
  meetingTitle: string;
  isHost: boolean;
}

export type CallStatus = "idle" | "connecting" | "connected" | "failed";

interface CallContextValue {
  session: ActiveSession | null;
  status: CallStatus;
  error: CallError | null;
  /**
   * Idempotent, and ignored for a room the user has explicitly left. See
   * `leftCode` for why that guard exists.
   */
  joinCall: (request: JoinRequest) => void;
  /** Explicit hang-up. Records attendance and tears the connection down. */
  leaveCall: () => void;
  /**
   * The room the user hung up on, or null. While set, `joinCall` for that room is
   * refused, so the meeting page shows a "rejoin" prompt instead of reconnecting.
   */
  leftCode: string | null;
  /** Clears the guard and reconnects. The only way back after a hang-up. */
  rejoinCall: (request: JoinRequest) => void;
  /**
   * Clears the guard without connecting.
   *
   * Used by the lobby: someone who leaves and then deliberately re-enters through
   * the lobby has already expressed intent to join, so they should not be met with
   * a "you left this call" prompt.
   */
  allowRejoin: (meetingCode: string) => void;
  retry: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

/**
 * Access the ambient call.
 *
 * Safe to call anywhere under the root layout, including on pages that have
 * nothing to do with meetings — `session` is simply null there.
 */
export function useCall(): CallContextValue {
  const value = useContext(CallContext);

  if (value === null) {
    throw new Error("useCall must be used inside CallProvider");
  }

  return value;
}

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
      // `backgroundEffect` is the current shape; older sessions only carry the
      // `backgroundBlur` boolean, so fall back rather than dropping the choice.
      backgroundEffect:
        record.backgroundEffect !== undefined
          ? parseBackgroundEffect(record.backgroundEffect)
          : record.backgroundBlur === true
            ? { kind: "blur" }
            : NO_BACKGROUND,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function describeTokenFailure(status: number): CallError {
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
    return { message: "This meeting no longer exists.", action: "none" };
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
      message:
        "This meeting request was rejected. Return to the lobby and retry.",
      action: "none",
    };
  }

  return {
    message: "The meeting service is unavailable right now.",
    action: "retry",
  };
}

/** Applies the speaker chosen in the lobby once the room is connected. */
function SpeakerPreference({ speakerId }: { speakerId: string }) {
  const room = useRoomContext();

  useEffect(() => {
    if (speakerId.length === 0) {
      return;
    }

    room.switchActiveDevice("audiooutput", speakerId).catch(() => undefined);
  }, [room, speakerId]);

  return null;
}

/**
 * Holds the LiveKit connection for the whole app.
 *
 * Mounted once in the root layout, above the router. That placement is the entire
 * point: when the room lived on `/meeting/[code]`, opening the dashboard or a chat
 * thread unmounted it and killed the call. Here it survives every client-side
 * navigation, so the call keeps running while the user browses — which is how
 * Zoom and Meet behave.
 *
 * Children render *inside* `LiveKitRoom`, so any page can use the room hooks, and
 * chat history and raised hands persist across navigation because their providers
 * live here too.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { user, isLoaded } = useUser();
  const pathname = usePathname();

  const [request, setRequest] = useState<JoinRequest | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [attempt, setAttempt] = useState(0);

  /** Guards against a second token fetch for a request already in flight. */
  const fetchingRef = useRef<string | null>(null);

  /**
   * The room the user hung up on.
   *
   * Held in a ref as well as state because `joinCall` must see the current value
   * synchronously — `rejoinCall` clears the guard and joins in the same tick, and
   * a state read there would still see the stale value.
   *
   * This guard is what fixes the hang-up loop. Clearing `session` swaps the
   * provider between its two render branches, and because the element type at that
   * position changes, React unmounts and remounts the whole child tree. That
   * remount re-ran the meeting page's join effect, which reconnected, which
   * swapped the branch back — an endless join/leave cycle that made the call
   * impossible to end.
   */
  const leftRef = useRef<string | null>(null);
  const [leftCode, setLeftCode] = useState<string | null>(null);

  /** Mirrors the connected room code so callbacks can read it without a dep. */
  const sessionCodeRef = useRef<string | null>(null);

  useEffect(() => {
    sessionCodeRef.current = session?.meetingCode ?? null;
  }, [session]);

  const joinCall = useCallback((next: JoinRequest) => {
    // Refuse to auto-reconnect to a room the user deliberately left.
    if (leftRef.current === next.meetingCode) {
      return;
    }

    setRequest((current) => {
      // Already in this room: do not disturb the live connection.
      if (current !== null && current.meetingCode === next.meetingCode) {
        return current;
      }

      return next;
    });
  }, []);

  const leaveCall = useCallback(() => {
    const code = session?.meetingCode ?? request?.meetingCode ?? null;

    if (code !== null) {
      // Explicit hang-up is the only path that records attendance. Not awaited:
      // the user should not wait on a round trip to leave.
      void leaveMeeting(code);

      leftRef.current = code;
      setLeftCode(code);
    }

    fetchingRef.current = null;
    setSession(null);
    setRequest(null);
    setError(null);
  }, [session, request]);

  const allowRejoin = useCallback((meetingCode: string) => {
    if (leftRef.current === meetingCode) {
      leftRef.current = null;
      setLeftCode(null);
    }
  }, []);

  const rejoinCall = useCallback(
    (next: JoinRequest) => {
      // Synchronous so the `joinCall` below sees the cleared guard.
      leftRef.current = null;
      setLeftCode(null);
      joinCall(next);
    },
    [joinCall],
  );

  const retry = useCallback(() => {
    fetchingRef.current = null;
    setSession(null);
    setError(null);
    setAttempt((current) => current + 1);
  }, []);

  // Mints a token for the requested room.
  useEffect(() => {
    if (request === null || !isLoaded) {
      return;
    }

    if (session !== null && session.meetingCode === request.meetingCode) {
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

    const fetchKey = `${request.meetingCode}:${attempt}`;

    if (fetchingRef.current === fetchKey) {
      return;
    }

    fetchingRef.current = fetchKey;

    const preferences = readPreferences(request.meetingCode);
    const participantName =
      preferences.participantName.trim().length > 0
        ? preferences.participantName.trim()
        : (user?.fullName ??
          user?.firstName ??
          user?.primaryEmailAddress?.emailAddress.split("@")[0] ??
          "Guest");

    let cancelled = false;

    async function requestToken(target: JoinRequest) {
      setError(null);

      try {
        const response = await fetch("/api/meetings/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meetingCode: target.meetingCode,
            participantName,
          }),
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

        setSession({
          meetingCode: target.meetingCode,
          meetingTitle: target.meetingTitle,
          isHost: target.isHost,
          preferences,
          token: issued,
        });
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

    void requestToken(request);

    return () => {
      cancelled = true;
    };
  }, [request, session, isLoaded, user, attempt]);

  const handleRoomError = useCallback((roomError: Error) => {
    setSession(null);
    fetchingRef.current = null;
    setError({
      message:
        roomError.message.length > 0
          ? roomError.message
          : "The connection to the meeting failed.",
      action: "retry",
    });
  }, []);

  /**
   * Fires when the media connection drops, for any reason: an explicit hang-up,
   * the host removing this participant, or the network going away.
   *
   * The guard is set here as well as in `leaveCall`, and that is deliberate. Any
   * path that clears the session remounts the child tree, which re-runs the
   * meeting page's join effect — so without the guard a dropped connection
   * reconnects itself forever. Reconnecting is offered as a button instead.
   *
   * Records nothing and does not navigate: a drop is not a decision.
   */
  const handleDisconnected = useCallback(() => {
    // Read from a ref rather than a state updater: a `setState` callback must be
    // pure, and React may invoke it twice in development.
    const code = sessionCodeRef.current;

    if (code !== null) {
      leftRef.current = code;
      setLeftCode(code);
    }

    setSession(null);
    setRequest(null);
    fetchingRef.current = null;
  }, []);

  const status: CallStatus = useMemo(() => {
    if (error !== null) {
      return "failed";
    }
    if (session !== null) {
      return "connected";
    }

    return request === null ? "idle" : "connecting";
  }, [error, session, request]);

  const value = useMemo<CallContextValue>(
    () => ({
      session,
      status,
      error,
      joinCall,
      leaveCall,
      leftCode,
      rejoinCall,
      allowRejoin,
      retry,
    }),
    [
      session,
      status,
      error,
      joinCall,
      leaveCall,
      leftCode,
      rejoinCall,
      allowRejoin,
      retry,
    ],
  );

  // No live room: render the app untouched. This is the common case for every
  // page that is not a meeting.
  if (session === null) {
    return (
      <CallContext.Provider value={value}>{children}</CallContext.Provider>
    );
  }

  const onMeetingPage = pathname.startsWith(
    `/meeting/${encodeURIComponent(session.meetingCode)}`,
  );

  return (
    <CallContext.Provider value={value}>
      <LiveKitRoom
        token={session.token}
        serverUrl={serverUrl}
        connect
        video={session.preferences.cameraEnabled}
        audio={session.preferences.microphoneEnabled}
        options={{
          videoCaptureDefaults: {
            deviceId:
              session.preferences.cameraId.length > 0
                ? session.preferences.cameraId
                : undefined,
          },
          audioCaptureDefaults: {
            deviceId:
              session.preferences.microphoneId.length > 0
                ? session.preferences.microphoneId
                : undefined,
          },
        }}
        onDisconnected={handleDisconnected}
        onError={handleRoomError}
        data-lk-theme="default"
        // `display: contents` so this wrapper does not participate in layout.
        // It wraps the entire app, and any box of its own would break every page.
        className="contents"
      >
        {/* Above `children` so chat history and raised hands survive navigation. */}
        <MeetingChatProvider>
          <ReactionsProvider>
            {/* Here rather than in `MeetingRoom` for the same reason as chat, plus
                one specific to captions: if this unmounted on navigation, a
                speaker glancing at the dashboard would stop captioning for
                everybody else mid-sentence. */}
            <CaptionsProvider>
              {children}

              {/* Exactly once, and outside the page, so audio keeps playing while
                  the user is on the dashboard. */}
              <RoomAudioRenderer />
              <SpeakerPreference speakerId={session.preferences.speakerId} />

              {!onMeetingPage && <MiniCallBar />}
            </CaptionsProvider>
          </ReactionsProvider>
        </MeetingChatProvider>
      </LiveKitRoom>
    </CallContext.Provider>
  );
}

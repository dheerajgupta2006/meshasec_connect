"use client";

import { useUser } from "@clerk/nextjs";
import {
  BackgroundBlur,
  VirtualBackground,
  supportsBackgroundProcessors,
} from "@livekit/track-processors";
import { Track } from "livekit-client";
import {
  ArrowLeft,
  AudioLines,
  Camera,
  CameraOff,
  Clock,
  KeyRound,
  LoaderCircle,
  Mic,
  MicOff,
  MonitorSpeaker,
  Settings2,
  ShieldCheck,
  Sparkles,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AudioLevelMeter } from "@/components/meeting/audio-level-meter";
import { NetworkQuality } from "@/components/meeting/network-quality";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  knockForEntry,
  verifyRoomPasscode,
} from "@/app/meeting/[code]/actions";
import { BackgroundPicker } from "@/components/meeting/background-picker";
import { useCall } from "@/components/meeting/call-provider";
import {
  NO_BACKGROUND,
  type BackgroundEffect,
} from "@/lib/meetings/backgrounds";
import { requestGuestKnock } from "@/lib/meetings/guest-knock-client";
import { ROOM_PASSCODE_DIGITS } from "@/lib/meetings/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface PreJoinLobbyProps {
  /**
   * True when the visitor is neither the host nor an enrolled participant, and
   * the room has a passcode. Resolved on the server so the field is never shown
   * to someone who does not need it.
   */
  passcodeRequired?: boolean;
  /**
   * True when the host has a waiting room on and this visitor is not enrolled.
   * Joining then means knocking and waiting for approval.
   */
  waitingRoomRequired?: boolean;
  /**
   * ISO start time for a scheduled meeting the visitor may not enter yet, or null
   * when they can join immediately. Null for the host, and for instant meetings.
   */
  opensAt?: string | null;
  /**
   * Name chosen at the guest passcode gate.
   *
   * Guests have no Clerk profile, so there is nothing to fall back to — without
   * this they would appear as "Guest" to everyone in the room.
   */
  guestName?: string | null;
  /**
   * True when this guest must be admitted by the host before joining.
   * Separate from `waitingRoomRequired` because the two knock through different
   * endpoints — a guest has no Clerk session for a Server Action to resolve.
   */
  guestWaitingRequired?: boolean;
  meetingCode: string;
  meetingTitle: string;
}

interface MediaDevicesByKind {
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
}

type MediaStatus = "requesting" | "ready" | "error";

/**
 * How often to check whether the host has answered a knock.
 *
 * Faster than the message poll because someone is actively staring at a spinner,
 * and only guests in a waiting room ever run it.
 */
const KNOCK_POLL_INTERVAL_MS = 4000;

/** Renders a remaining duration as a coarse, readable countdown. */
function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

type BlurStatus = "idle" | "starting" | "active" | "failed";

type BackgroundBlurProcessor = ReturnType<typeof BackgroundBlur>;

const EMPTY_DEVICES: MediaDevicesByKind = {
  cameras: [],
  microphones: [],
  speakers: [],
};

const BLUR_RADIUS = 12;

const BLUR_UNSUPPORTED_MESSAGE =
  "Background blur needs a browser with video frame processing support. Try the latest Chrome, Edge, or Safari.";
const BLUR_FAILED_MESSAGE =
  "Background blur could not start on this device, so your preview is unchanged.";

function describeMediaError(error: unknown): string {
  if (!(error instanceof DOMException)) {
    return "We could not start your camera and microphone. Please try again.";
  }

  switch (error.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera or microphone access was blocked. Allow access in your browser settings, then try again.";
    case "NotFoundError":
      return "No camera or microphone was found. Connect a device and try again.";
    case "NotReadableError":
      return "Your camera or microphone is already in use by another application.";
    case "OverconstrainedError":
      return "The selected device is no longer available. Choose another device.";
    default:
      return error.message || "Unable to access your camera and microphone.";
  }
}

function deviceName(
  device: MediaDeviceInfo,
  type: "Camera" | "Microphone" | "Speaker",
  index: number,
): string {
  return device.label || `${type} ${index + 1}`;
}

export function PreJoinLobby({
  passcodeRequired = false,
  waitingRoomRequired = false,
  guestWaitingRequired = false,
  opensAt = null,
  guestName = null,
  meetingCode,
  meetingTitle,
}: PreJoinLobbyProps) {
  const router = useRouter();
  const { user } = useUser();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** Holds the off-screen video element the blur processor reads frames from. */
  const blurHostRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const nameInitializedRef = useRef(false);
  const cameraEnabledRef = useRef(true);
  const microphoneEnabledRef = useRef(true);

  const [devices, setDevices] =
    useState<MediaDevicesByKind>(EMPTY_DEVICES);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [participantName, setParticipantName] = useState("");
  const [mediaStatus, setMediaStatus] =
    useState<MediaStatus>("requesting");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [speakerMessage, setSpeakerMessage] = useState<string | null>(null);
  const [speakerSelectionSupported, setSpeakerSelectionSupported] =
    useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [isJoining, setIsJoining] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const { allowRejoin } = useCall();

  /**
   * Ticks once a second so the countdown is live and the Join button unlocks by
   * itself at the start time, without the visitor having to reload.
   */
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const opensAtMs = useMemo(() => {
    if (opensAt === null) {
      return null;
    }

    const parsed = new Date(opensAt).getTime();

    return Number.isNaN(parsed) ? null : parsed;
  }, [opensAt]);

  const waitingForStart = opensAtMs !== null && nowMs < opensAtMs;

  useEffect(() => {
    if (opensAtMs === null || nowMs >= opensAtMs) {
      return;
    }

    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, [opensAtMs, nowMs]);

  const [knockState, setKnockState] = useState<
    "idle" | "waiting" | "denied"
  >("idle");
  const isGuest = guestName !== null;
  /** Held so the poll can enter the room with the name that was submitted. */
  const knockNameRef = useRef<string>("");
  /** Mirrors `streamRef` so child components and effects can react to changes. */
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const [backgroundEffect, setBackgroundEffect] =
    useState<BackgroundEffect>(NO_BACKGROUND);
  /** `null` until support detection has run, so nothing flashes on first paint. */
  const [blurSupported, setBlurSupported] = useState<boolean | null>(null);
  const [blurStatus, setBlurStatus] = useState<BlurStatus>("idle");

  const stopStream = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const refreshDevices = useCallback(async (activeStream?: MediaStream) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const availableDevices = await navigator.mediaDevices.enumerateDevices();
    const nextDevices: MediaDevicesByKind = {
      cameras: availableDevices.filter(
        (device) => device.kind === "videoinput" && device.deviceId,
      ),
      microphones: availableDevices.filter(
        (device) => device.kind === "audioinput" && device.deviceId,
      ),
      speakers: availableDevices.filter(
        (device) => device.kind === "audiooutput" && device.deviceId,
      ),
    };

    if (!mountedRef.current) {
      return;
    }

    const activeCameraId = activeStream
      ?.getVideoTracks()[0]
      ?.getSettings().deviceId;
    const activeMicrophoneId = activeStream
      ?.getAudioTracks()[0]
      ?.getSettings().deviceId;

    setDevices(nextDevices);
    setSelectedCameraId((current) =>
      current && nextDevices.cameras.some((device) => device.deviceId === current)
        ? current
        : activeCameraId ?? nextDevices.cameras[0]?.deviceId ?? "",
    );
    setSelectedMicrophoneId((current) =>
      current &&
      nextDevices.microphones.some((device) => device.deviceId === current)
        ? current
        : activeMicrophoneId ?? nextDevices.microphones[0]?.deviceId ?? "",
    );
    setSelectedSpeakerId((current) =>
      current && nextDevices.speakers.some((device) => device.deviceId === current)
        ? current
        : nextDevices.speakers[0]?.deviceId ?? "",
    );
  }, []);

  const startMedia = useCallback(
    async (cameraId?: string, microphoneId?: string) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMediaStatus("error");
        setMediaError(
          "Media devices are unavailable. Open this page on localhost or HTTPS in a supported browser.",
        );
        return;
      }

      const requestId = ++requestIdRef.current;
      setMediaStatus("requesting");
      setMediaError(null);

      const constraints: MediaStreamConstraints = {
        video: cameraId
          ? { deviceId: { exact: cameraId } }
          : { facingMode: "user" },
        audio: microphoneId
          ? { deviceId: { exact: microphoneId } }
          : true,
      };

      try {
        const nextStream = await navigator.mediaDevices.getUserMedia(
          constraints,
        );

        if (!mountedRef.current || requestId !== requestIdRef.current) {
          stopStream(nextStream);
          return;
        }

        nextStream.getVideoTracks().forEach((track) => {
          track.enabled = cameraEnabledRef.current;
        });
        nextStream.getAudioTracks().forEach((track) => {
          track.enabled = microphoneEnabledRef.current;
        });

        const previousStream = streamRef.current;
        streamRef.current = nextStream;
        setActiveStream(nextStream);

        if (videoRef.current) {
          videoRef.current.srcObject = nextStream;
        }

        stopStream(previousStream);
        setMediaStatus("ready");
        await refreshDevices(nextStream);
      } catch (error) {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return;
        }

        setMediaStatus("error");
        setMediaError(describeMediaError(error));
      }
    },
    [refreshDevices, stopStream],
  );

  useEffect(() => {
    if (nameInitializedRef.current) {
      return;
    }

    // A guest has no Clerk profile, so their name comes from the passcode gate.
    // Checked first because `user` is permanently null for them and the original
    // guard would return early forever, leaving the field blank.
    if (guestName !== null && guestName.length > 0) {
      setParticipantName(guestName);
      nameInitializedRef.current = true;
      return;
    }

    if (!user) {
      return;
    }

    setParticipantName(
      user.fullName ??
        user.firstName ??
        user.primaryEmailAddress?.emailAddress.split("@")[0] ??
        "",
    );
    nameInitializedRef.current = true;
  }, [user, guestName]);

  useEffect(() => {
    const previewElement = videoRef.current;

    mountedRef.current = true;
    setSpeakerSelectionSupported(
      typeof HTMLMediaElement !== "undefined" &&
        "setSinkId" in HTMLMediaElement.prototype,
    );

    void startMedia();

    const handleDeviceChange = () => {
      void refreshDevices(streamRef.current ?? undefined);
    };

    navigator.mediaDevices?.addEventListener(
      "devicechange",
      handleDeviceChange,
    );

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
      stopStream(streamRef.current);
      streamRef.current = null;

      if (previewElement) {
        previewElement.srcObject = null;
      }
    };
  }, [refreshDevices, startMedia, stopStream]);

  // Background blur relies on WebGL plus frame processing APIs, so the control
  // is only offered once the browser reports support.
  useEffect(() => {
    let supported = false;

    try {
      supported = supportsBackgroundProcessors();
    } catch {
      supported = false;
    }

    setBlurSupported(supported);
  }, []);

  useEffect(() => {
    const previewElement = videoRef.current;
    const host = blurHostRef.current;
    const videoTrack = activeStream?.getVideoTracks()[0] ?? null;

    if (
      backgroundEffect.kind === "none" ||
      !blurSupported ||
      !activeStream ||
      !videoTrack ||
      !previewElement ||
      !host
    ) {
      // Nothing to process: make sure the preview shows the raw camera stream.
      if (
        previewElement &&
        activeStream &&
        previewElement.srcObject !== activeStream
      ) {
        previewElement.srcObject = activeStream;
      }
      return;
    }

    let cancelled = false;
    let processor: BackgroundBlurProcessor | null = null;

    // Each run owns its own frame source, so overlapping start/stop cycles
    // (device switches, remounts) can never fight over a shared element.
    const sourceElement = document.createElement("video");
    sourceElement.muted = true;
    sourceElement.autoplay = true;
    sourceElement.playsInline = true;
    sourceElement.tabIndex = -1;
    sourceElement.setAttribute("aria-hidden", "true");
    host.appendChild(sourceElement);

    setBlurStatus("starting");

    const restorePreview = () => {
      if (previewElement.srcObject !== activeStream) {
        previewElement.srcObject = activeStream;
      }
    };

    const releaseSource = () => {
      sourceElement.srcObject = null;
      sourceElement.remove();
    };

    const applyBlur = async () => {
      try {
        sourceElement.srcObject = new MediaStream([videoTrack]);

        try {
          await sourceElement.play();
        } catch {
          // Autoplay may be refused; the processor keeps its own frame timing.
        }

        // Same processor pipeline either way; only the effect differs.
        const instance =
          backgroundEffect.kind === "blur"
            ? BackgroundBlur(BLUR_RADIUS)
            : VirtualBackground(backgroundEffect.url);

        await instance.init({
          kind: Track.Kind.Video,
          track: videoTrack,
          element: sourceElement,
        });

        const processedTrack = instance.processedTrack;

        if (cancelled || !processedTrack) {
          await instance.destroy().catch(() => undefined);
          return;
        }

        processor = instance;
        previewElement.srcObject = new MediaStream([processedTrack]);
        setBlurStatus("active");
      } catch {
        if (cancelled) {
          return;
        }

        // A processor failure must never take the preview down with it.
        restorePreview();
        setBlurStatus("failed");
        setBackgroundEffect(NO_BACKGROUND);
      }
    };

    void applyBlur();

    return () => {
      cancelled = true;

      const instance = processor;
      processor = null;

      if (instance) {
        // Tear the processor down before detaching its source, otherwise its
        // render loop keeps reading from an element that no longer has a track.
        void instance
          .destroy()
          .catch(() => undefined)
          .then(releaseSource);
      } else {
        releaseSource();
      }

      // Only hand the raw stream back while it is still usable; on unmount the
      // media effect has already stopped every track.
      if (videoTrack.readyState === "live") {
        restorePreview();
      }
    };
    // `backgroundEffect` is depended on as a whole: switching preset must tear
    // the old processor down and build a new one, not mutate it in place.
  }, [activeStream, backgroundEffect, blurSupported]);

  const handleCameraChange = (deviceId: string) => {
    setSelectedCameraId(deviceId);
    void startMedia(deviceId, selectedMicrophoneId || undefined);
  };

  const handleMicrophoneChange = (deviceId: string) => {
    setSelectedMicrophoneId(deviceId);
    void startMedia(selectedCameraId || undefined, deviceId);
  };

  const handleSpeakerChange = async (deviceId: string) => {
    setSelectedSpeakerId(deviceId);
    setSpeakerMessage(null);

    const preview = videoRef.current;

    if (!preview || typeof preview.setSinkId !== "function") {
      setSpeakerMessage(
        "Speaker selection is not supported by this browser. The default output will be used.",
      );
      return;
    }

    try {
      await preview.setSinkId(deviceId);
    } catch {
      setSpeakerMessage(
        "The selected speaker could not be activated. The default output will be used.",
      );
    }
  };

  const toggleCamera = () => {
    const nextEnabled = !cameraEnabled;
    cameraEnabledRef.current = nextEnabled;
    streamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = nextEnabled;
    });
    setCameraEnabled(nextEnabled);
  };

  const toggleMicrophone = () => {
    const nextEnabled = !microphoneEnabled;
    microphoneEnabledRef.current = nextEnabled;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = nextEnabled;
    });
    setMicrophoneEnabled(nextEnabled);
  };

  const handleBackgroundChange = (next: BackgroundEffect) => {
    if (!blurSupported) {
      return;
    }

    const nextEnabled = next.kind !== "none";
    setBackgroundEffect(next);
    setBlurStatus(nextEnabled ? "starting" : "idle");
  };

  const handleJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedName = participantName.trim();

    if (!trimmedName || mediaStatus !== "ready" || isJoining) {
      return;
    }

    // Scheduled meeting, not open yet. The button is disabled too; this guards
    // against a submit from the keyboard.
    if (waitingForStart) {
      return;
    }

    setPasscodeError(null);

    // A guest must clear the passcode before the room is entered. Verifying here
    // rather than at the token endpoint is what lets the error appear inline in
    // the lobby instead of as a failed connection on a black screen.
    if (passcodeRequired) {
      const submitted = passcode.replace(/[\s-]/g, "");

      if (submitted.length !== ROOM_PASSCODE_DIGITS) {
        setPasscodeError(
          `Enter the ${ROOM_PASSCODE_DIGITS}-digit room passcode.`,
        );
        return;
      }

      setIsJoining(true);

      void verifyRoomPasscode(meetingCode, submitted).then((outcome) => {
        if (!outcome.ok) {
          setIsJoining(false);
          setPasscodeError(outcome.message);
          return;
        }

        // Verified and now enrolled, so the room can be entered exactly as an
        // invited participant would.
        persistPreferencesAndEnter(trimmedName);
      });

      return;
    }

    setIsJoining(true);

    // Guests knock through their own endpoint: the server action behind
    // `beginKnocking` resolves the caller from a Clerk session they do not have.
    if (guestWaitingRequired) {
      void beginGuestKnocking(trimmedName);
      return;
    }

    // Waiting room without a passcode: knock, then wait for the host.
    if (waitingRoomRequired) {
      void beginKnocking(trimmedName);
      return;
    }

    persistPreferencesAndEnter(trimmedName);
  };

  /**
   * Guest equivalent of `beginKnocking`.
   *
   * Goes through the API rather than a Server Action because the guest's identity
   * lives in a signed cookie, not a Clerk session, and every action in this app
   * resolves the caller from Clerk.
   */
  const beginGuestKnocking = async (trimmedName: string) => {
    setKnockState("waiting");
    knockNameRef.current = trimmedName;

    const state = await requestGuestKnock(meetingCode);

    if (state === "admitted") {
      setKnockState("idle");
      persistPreferencesAndEnter(trimmedName);
      return;
    }

    if (state === "denied") {
      setIsJoining(false);
      setKnockState("denied");
    }
  };

  /**
   * Knocks, then polls until the host answers.
   *
   * Polling rather than pushing because the host's decision is a database write
   * with no channel to this page — the guest is not in the room yet, so there is
   * no LiveKit data channel to listen on.
   */
  const beginKnocking = async (trimmedName: string) => {
    setKnockState("waiting");

    const outcome = await knockForEntry(meetingCode);

    if (outcome.state === "admitted") {
      setKnockState("idle");
      persistPreferencesAndEnter(trimmedName);
      return;
    }

    if (outcome.state === "denied") {
      setIsJoining(false);
      setKnockState("denied");
      return;
    }

    if (outcome.state === "error") {
      setIsJoining(false);
      setKnockState("idle");
      setPasscodeError(outcome.message);
      return;
    }

    knockNameRef.current = trimmedName;
  };

  const persistPreferencesAndEnter = (trimmedName: string) => {
    // Coming through the lobby is an explicit decision to join, so any "you left
    // this call" guard from a previous hang-up is cleared here.
    allowRejoin(meetingCode);

    sessionStorage.setItem(
      `meeting:${meetingCode}:devices`,
      JSON.stringify({
        participantName: trimmedName,
        cameraId: selectedCameraId,
        microphoneId: selectedMicrophoneId,
        speakerId: selectedSpeakerId,
        cameraEnabled,
        microphoneEnabled,
        // Additive: the meeting room ignores unknown keys, so existing readers
        // keep working. `backgroundBlur` is kept for backward compatibility with
        // a session written by an older build.
        backgroundBlur: backgroundEffect.kind === "blur",
        backgroundEffect,
      }),
    );
    router.push(`/meeting/${encodeURIComponent(meetingCode)}`);
  };


  // Polls for the host's decision while the guest waits. Stops as soon as they
  // are admitted or denied, so a page left open does not poll forever.
  useEffect(() => {
    if (knockState !== "waiting") {
      return;
    }

    let cancelled = false;

    /** Guests and account holders poll different endpoints for the same answer. */
    const check = async (): Promise<"admitted" | "waiting" | "denied"> => {
      if (isGuest) {
        return requestGuestKnock(meetingCode);
      }

      const outcome = await knockForEntry(meetingCode);

      return outcome.state === "admitted"
        ? "admitted"
        : outcome.state === "denied"
          ? "denied"
          : "waiting";
    };

    const timer = window.setInterval(() => {
      void check().then((state) => {
        if (cancelled) {
          return;
        }

        if (state === "admitted") {
          setKnockState("idle");
          persistPreferencesAndEnter(knockNameRef.current);
          return;
        }

        if (state === "denied") {
          setIsJoining(false);
          setKnockState("denied");
        }
      });
    }, KNOCK_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `persistPreferencesAndEnter` is recreated each render and would restart the
    // interval on every tick, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knockState, meetingCode, isGuest]);

  const blurUnsupported = blurSupported === false;
  const blurNotice = blurUnsupported
    ? BLUR_UNSUPPORTED_MESSAGE
    : blurStatus === "failed"
      ? BLUR_FAILED_MESSAGE
      : "";

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-zinc-950 text-zinc-50">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <Button
            asChild
            variant="ghost"
            className="text-zinc-300 hover:bg-zinc-800 hover:text-white"
          >
            <Link href="/dashboard">
              <ArrowLeft className="h-4 w-4" />
              Dashboard
            </Link>
          </Button>
          <Badge
            variant="outline"
            className="border-zinc-700 bg-zinc-900 text-zinc-300"
          >
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5 text-emerald-400" />
            Secure pre-join
          </Badge>
        </div>

        <div className="grid flex-1 items-center gap-8 lg:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.75fr)]">
          <section className="space-y-5">
            <div>
              <p className="text-sm font-medium text-blue-400">
                Meeting {meetingCode}
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
                {meetingTitle}
              </h1>
            </div>

            <div className="relative aspect-video overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/30">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="h-full w-full -scale-x-100 object-cover"
              />

              {/* Host for the blur processor's unprocessed frame source. The
                  element has to stay in the document to keep decoding frames,
                  so it is clipped to a single pixel instead of hidden. */}
              <div
                ref={blurHostRef}
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 h-px w-px overflow-hidden opacity-0"
              />

              {!cameraEnabled && mediaStatus === "ready" && (
                <div className="absolute inset-0 grid place-items-center bg-zinc-900">
                  <div className="text-center">
                    <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-zinc-800 text-zinc-400">
                      <CameraOff className="h-7 w-7" />
                    </span>
                    <p className="mt-3 text-sm text-zinc-400">Camera is off</p>
                  </div>
                </div>
              )}

              {mediaStatus !== "ready" && (
                <div className="absolute inset-0 grid place-items-center bg-zinc-900/95 p-6 text-center">
                  {mediaStatus === "requesting" ? (
                    <div>
                      <LoaderCircle className="mx-auto h-8 w-8 animate-spin text-blue-400" />
                      <p className="mt-4 font-medium">
                        Requesting camera and microphone access…
                      </p>
                      <p className="mt-1 text-sm text-zinc-400">
                        Approve the browser permission prompt to continue.
                      </p>
                    </div>
                  ) : (
                    <div className="max-w-md">
                      <CameraOff className="mx-auto h-9 w-9 text-red-400" />
                      <p className="mt-4 font-medium">Device access failed</p>
                      <p className="mt-2 text-sm leading-6 text-zinc-400">
                        {mediaError}
                      </p>
                      <Button
                        className="mt-5"
                        onClick={() =>
                          void startMedia(
                            selectedCameraId || undefined,
                            selectedMicrophoneId || undefined,
                          )
                        }
                        type="button"
                      >
                        Try again
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-black/60 p-2 shadow-lg backdrop-blur">
                <Button
                  type="button"
                  size="icon"
                  variant={microphoneEnabled ? "secondary" : "destructive"}
                  className="rounded-full"
                  onClick={toggleMicrophone}
                  disabled={mediaStatus !== "ready"}
                  aria-label={
                    microphoneEnabled ? "Mute microphone" : "Unmute microphone"
                  }
                  title={
                    microphoneEnabled ? "Mute microphone" : "Unmute microphone"
                  }
                >
                  {microphoneEnabled ? (
                    <Mic className="h-4 w-4" />
                  ) : (
                    <MicOff className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant={cameraEnabled ? "secondary" : "destructive"}
                  className="rounded-full"
                  onClick={toggleCamera}
                  disabled={mediaStatus !== "ready"}
                  aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                  title={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                >
                  {cameraEnabled ? (
                    <Camera className="h-4 w-4" />
                  ) : (
                    <CameraOff className="h-4 w-4" />
                  )}
                </Button>
                <span
                  className="h-6 w-px shrink-0 bg-white/15"
                  aria-hidden="true"
                />
                <BackgroundPicker
                  effect={backgroundEffect}
                  onChange={handleBackgroundChange}
                  supported={blurSupported === true}
                  disabled={
                    mediaStatus !== "ready" || blurStatus === "starting"
                  }
                  notice={
                    blurUnsupported
                      ? BLUR_UNSUPPORTED_MESSAGE
                      : blurStatus === "starting"
                        ? "Applying…"
                        : blurStatus === "failed"
                          ? "That effect could not start on this device."
                          : null
                  }
                />
              </div>

              <div className="absolute left-4 top-4 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-xs backdrop-blur">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      mediaStatus === "ready" ? "bg-emerald-400" : "bg-amber-400"
                    }`}
                  />
                  {mediaStatus === "ready" ? "Preview ready" : "Setting up"}
                </span>
                {blurStatus === "active" && (
                  <span className="flex items-center gap-1.5 rounded-full bg-blue-500/25 px-3 py-1.5 text-xs text-blue-100 backdrop-blur">
                    <Sparkles className="h-3 w-3" />
                    Blur on
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <AudioLevelMeter
                  stream={activeStream}
                  muted={!microphoneEnabled}
                  className="w-full sm:flex-1"
                />
                <NetworkQuality className="w-full justify-center sm:w-auto" />
              </div>

              {/* Always mounted so announcements fire, but taken out of the
                  layout while there is nothing to say. */}
              <p
                className={cn(
                  "text-xs leading-5 text-amber-300/80",
                  blurNotice === "" && "sr-only",
                )}
                aria-live="polite"
              >
                {blurNotice}
              </p>

              <p className="text-center text-sm text-zinc-500">
                Your preview is mirrored. Other participants will see you
                normally.
              </p>
            </div>
          </section>

          <Card className="border-zinc-800 bg-zinc-900/80 text-zinc-50 shadow-xl shadow-black/20 backdrop-blur">
            <CardHeader>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/15 text-blue-400">
                <Settings2 className="h-5 w-5" />
              </div>
              <CardTitle>Ready to join?</CardTitle>
              <CardDescription className="text-zinc-400">
                Check your name and devices before entering the room.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-5" onSubmit={handleJoin}>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="participant-name">
                    Display name
                  </label>
                  <Input
                    id="participant-name"
                    value={participantName}
                    onChange={(event) => setParticipantName(event.target.value)}
                    maxLength={100}
                    placeholder="Your name"
                    autoComplete="name"
                    className="border-zinc-700 bg-zinc-950/70 text-zinc-50 placeholder:text-zinc-600"
                  />
                </div>

                {waitingForStart && opensAtMs !== null && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-3 text-sm"
                  >
                    <p className="flex items-center gap-2 font-medium text-amber-100">
                      <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
                      This meeting has not started yet
                    </p>
                    <p className="mt-1 text-xs text-amber-200/80">
                      Starts in {formatCountdown(opensAtMs - nowMs)}. You will be
                      able to join automatically.
                    </p>
                  </div>
                )}

                {knockState === "waiting" && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex items-start gap-3 rounded-xl border border-blue-400/25 bg-blue-500/10 px-3 py-3"
                  >
                    <LoaderCircle
                      className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-300"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 text-sm">
                      <p className="font-medium text-blue-100">
                        Waiting for the host to let you in
                      </p>
                      <p className="mt-0.5 text-xs text-blue-200/80">
                        You will join automatically once they admit you.
                      </p>
                    </div>
                  </div>
                )}

                {knockState === "denied" && (
                  <div
                    role="alert"
                    className="rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-3 text-sm"
                  >
                    <p className="font-medium text-red-100">
                      The host did not admit you
                    </p>
                    <p className="mt-0.5 text-xs text-red-200/80">
                      Ask them to invite you again if that was a mistake.
                    </p>
                  </div>
                )}

                {/* Only rendered for a guest who is not already enrolled. The
                    host and invited participants never see this. */}
                {passcodeRequired && (
                  <div className="space-y-2">
                    <label
                      className="flex items-center gap-2 text-sm font-medium"
                      htmlFor="room-passcode"
                    >
                      <KeyRound className="h-4 w-4 text-zinc-400" />
                      Room passcode
                    </label>
                    <Input
                      id="room-passcode"
                      value={passcode}
                      onChange={(event) => {
                        setPasscode(event.target.value);
                        setPasscodeError(null);
                      }}
                      // `numeric` rather than `number`: a number input allows
                      // exponent characters and strips leading zeros, which a
                      // passcode like 001234 depends on.
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit code"
                      maxLength={16}
                      aria-invalid={passcodeError !== null}
                      aria-describedby={
                        passcodeError === null
                          ? "room-passcode-hint"
                          : "room-passcode-error"
                      }
                      className="border-zinc-700 bg-zinc-950/70 font-mono text-lg tracking-[0.3em] text-zinc-50 placeholder:tracking-normal placeholder:text-zinc-600"
                    />
                    {passcodeError === null ? (
                      <p
                        id="room-passcode-hint"
                        className="text-xs text-zinc-500"
                      >
                        Ask the host for the code shown in their invite.
                      </p>
                    ) : (
                      <p
                        id="room-passcode-error"
                        role="alert"
                        className="text-xs font-medium text-red-400"
                      >
                        {passcodeError}
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Camera className="h-4 w-4 text-zinc-400" />
                    Camera
                  </label>
                  <Select
                    value={selectedCameraId || undefined}
                    onValueChange={handleCameraChange}
                    disabled={devices.cameras.length === 0}
                  >
                    <SelectTrigger className="border-zinc-700 bg-zinc-950/70 text-zinc-50">
                      <SelectValue placeholder="No camera found" />
                    </SelectTrigger>
                    <SelectContent>
                      {devices.cameras.map((device, index) => (
                        <SelectItem key={device.deviceId} value={device.deviceId}>
                          {deviceName(device, "Camera", index)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <AudioLines className="h-4 w-4 text-zinc-400" />
                    Microphone
                  </label>
                  <Select
                    value={selectedMicrophoneId || undefined}
                    onValueChange={handleMicrophoneChange}
                    disabled={devices.microphones.length === 0}
                  >
                    <SelectTrigger className="border-zinc-700 bg-zinc-950/70 text-zinc-50">
                      <SelectValue placeholder="No microphone found" />
                    </SelectTrigger>
                    <SelectContent>
                      {devices.microphones.map((device, index) => (
                        <SelectItem key={device.deviceId} value={device.deviceId}>
                          {deviceName(device, "Microphone", index)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <MonitorSpeaker className="h-4 w-4 text-zinc-400" />
                    Speaker
                  </label>
                  <Select
                    value={selectedSpeakerId || undefined}
                    onValueChange={(deviceId) => void handleSpeakerChange(deviceId)}
                    disabled={
                      devices.speakers.length === 0 ||
                      !speakerSelectionSupported
                    }
                  >
                    <SelectTrigger className="border-zinc-700 bg-zinc-950/70 text-zinc-50">
                      <SelectValue
                        placeholder={
                          speakerSelectionSupported
                            ? "No speaker found"
                            : "Browser default speaker"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {devices.speakers.map((device, index) => (
                        <SelectItem key={device.deviceId} value={device.deviceId}>
                          {deviceName(device, "Speaker", index)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(speakerMessage || !speakerSelectionSupported) && (
                    <p className="text-xs leading-5 text-zinc-500" aria-live="polite">
                      {speakerMessage ??
                        "This browser will use your system's default speaker."}
                    </p>
                  )}
                </div>

                <Button
                  type="submit"
                  size="lg"
                  className="mt-2 w-full bg-blue-600 text-white hover:bg-blue-500"
                  disabled={
                    mediaStatus !== "ready" ||
                    participantName.trim().length === 0 ||
                    isJoining ||
                    // Held until the scheduled start. The countdown above unlocks
                    // this by itself, so no reload is needed.
                    waitingForStart ||
                    knockState === "waiting" ||
                    knockState === "denied"
                  }
                >
                  {isJoining || knockState === "waiting" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : waitingForStart ? (
                    <Clock className="h-4 w-4" />
                  ) : (
                    <Video className="h-4 w-4" />
                  )}
                  {knockState === "waiting"
                    ? "Waiting for the host…"
                    : waitingForStart
                      ? "Not started yet"
                      : isJoining
                        ? "Joining…"
                        : "Join Meeting"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}

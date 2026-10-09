"use client";

/**
 * Cost-free voice recording for the DM composer.
 *
 * Audio never leaves the browser until the user stops and sends it. The result
 * is an ordinary `File`, so it goes through the exact attachment preparation,
 * content inspection, authenticated upload, storage budget and deletion path as
 * every other direct-message attachment.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { MAX_ATTACHMENT_BYTES } from "@/lib/messages/attachment-rules";

/** Short enough to stay below 4 MB even when a browser ignores our bitrate hint. */
export const MAX_VOICE_RECORDING_MS = 3 * 60 * 1000;

/** Speech remains clear at this rate and a three-minute recording is about 1 MB. */
const REQUESTED_AUDIO_BITS_PER_SECOND = 48_000;

/** One chunk per second lets us stop a browser that ignores the bitrate limit. */
const DATA_SLICE_MS = 1000;
const CLOCK_TICK_MS = 250;

export type VoiceRecorderStatus =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping";

interface VoiceRecorderOptions {
  onRecorded: (file: File) => void;
  onError: (message: string) => void;
}

export interface VoiceRecorderController {
  isSupported: boolean;
  status: VoiceRecorderStatus;
  elapsedMs: number;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

interface RecorderFormat {
  /** Candidate passed to `MediaRecorder`; may include a codec parameter. */
  requestedMimeType: string;
  /** Safe extension and base MIME for the File handed to the attachment path. */
  extension: "m4a" | "weba" | "ogg" | "mp3" | "wav";
  mimeType: string;
}

/** Prefer AAC/MP4 when available because it has the broadest playback support. */
const FORMAT_CANDIDATES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
] as const;

function baseMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function formatForMime(value: string): Omit<RecorderFormat, "requestedMimeType"> | null {
  const mimeType = baseMimeType(value);

  switch (mimeType) {
    case "audio/mp4":
    case "video/mp4":
    case "audio/x-m4a":
      return { extension: "m4a", mimeType: "audio/mp4" };
    case "audio/webm":
    case "video/webm":
      // `.weba` tells the server this EBML container carries audio. `.webm` is
      // deliberately retained for manually uploaded videos.
      return { extension: "weba", mimeType: "audio/webm" };
    case "audio/ogg":
    case "application/ogg":
      return { extension: "ogg", mimeType: "audio/ogg" };
    case "audio/mpeg":
      return { extension: "mp3", mimeType: "audio/mpeg" };
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return { extension: "wav", mimeType: "audio/wav" };
    default:
      return null;
  }
}

function supportsMimeType(mimeType: string): boolean {
  try {
    return (
      typeof MediaRecorder.isTypeSupported !== "function" ||
      MediaRecorder.isTypeSupported(mimeType)
    );
  } catch {
    return false;
  }
}

function createRecorder(stream: MediaStream): {
  recorder: MediaRecorder;
  requestedMimeType: string;
} | null {
  for (const requestedMimeType of FORMAT_CANDIDATES) {
    if (!supportsMimeType(requestedMimeType)) {
      continue;
    }

    try {
      return {
        recorder: new MediaRecorder(stream, {
          mimeType: requestedMimeType,
          audioBitsPerSecond: REQUESTED_AUDIO_BITS_PER_SECOND,
        }),
        requestedMimeType,
      };
    } catch {
      // Some implementations report a MIME as supported but reject a bitrate.
      try {
        return {
          recorder: new MediaRecorder(stream, { mimeType: requestedMimeType }),
          requestedMimeType,
        };
      } catch {
        // Try the next real encoder instead of trusting `isTypeSupported`.
      }
    }
  }

  // Older implementations may expose MediaRecorder without exposing a useful
  // `isTypeSupported`. Let the browser choose, then validate its actual output.
  try {
    return {
      recorder: new MediaRecorder(stream, {
        audioBitsPerSecond: REQUESTED_AUDIO_BITS_PER_SECOND,
      }),
      requestedMimeType: "",
    };
  } catch {
    try {
      return { recorder: new MediaRecorder(stream), requestedMimeType: "" };
    } catch {
      return null;
    }
  }
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone access was blocked. Allow it in your browser settings and try again.";
      case "NotFoundError":
        return "No microphone was found on this device.";
      case "NotReadableError":
      case "AbortError":
        return "The microphone is being used by another app or could not be started.";
      default:
        break;
    }
  }

  return "The microphone could not be started. Check its browser permission and try again.";
}

function recordingName(extension: RecorderFormat["extension"]): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `voice-message-${timestamp}.${extension}`;
}

/** `0:04`, `2:17`, used by the recording bar and its accessible label. */
export function formatVoiceDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function useVoiceRecorder({
  onRecorded,
  onError,
}: VoiceRecorderOptions): VoiceRecorderController {
  const [isSupported, setIsSupported] = useState(false);
  const [status, setStatus] = useState<VoiceRecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);

  const mountedRef = useRef(true);
  const sessionRef = useRef(0);
  const statusRef = useRef<VoiceRecorderStatus>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const stopCurrentRef = useRef<(() => void) | null>(null);
  const onRecordedRef = useRef(onRecorded);
  const onErrorRef = useRef(onError);

  // Event handlers may fire several minutes after render; refs keep the current
  // thread callbacks without restarting a live recording.
  onRecordedRef.current = onRecorded;
  onErrorRef.current = onError;

  const clearTimers = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const updateStatus = useCallback((next: VoiceRecorderStatus) => {
    statusRef.current = next;

    if (mountedRef.current) {
      setStatus(next);
    }
  }, []);

  const disposeCurrent = useCallback(
    (updateUi: boolean) => {
      // Invalidates a pending permission request and every late recorder event.
      sessionRef.current += 1;
      clearTimers();
      stopCurrentRef.current = null;

      const recorder = recorderRef.current;
      recorderRef.current = null;

      if (recorder !== null) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;

        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // Tracks are stopped below even if this implementation cannot stop.
          }
        }
      }

      stopTracks(streamRef.current);
      streamRef.current = null;
      statusRef.current = "idle";

      if (updateUi && mountedRef.current) {
        setStatus("idle");
        setElapsedMs(0);
      }
    },
    [clearTimers],
  );

  useEffect(() => {
    mountedRef.current = true;
    setIsSupported(
      window.isSecureContext &&
        typeof window.MediaRecorder !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function",
    );

    return () => {
      mountedRef.current = false;
      disposeCurrent(false);
    };
  }, [disposeCurrent]);

  const cancel = useCallback(() => {
    disposeCurrent(true);
  }, [disposeCurrent]);

  const stop = useCallback(() => {
    stopCurrentRef.current?.();
  }, []);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") {
      return;
    }

    if (
      !window.isSecureContext ||
      typeof window.MediaRecorder === "undefined" ||
      typeof navigator.mediaDevices?.getUserMedia !== "function"
    ) {
      onErrorRef.current(
        window.isSecureContext
          ? "Voice recording is not supported by this browser."
          : "Voice recording requires a secure HTTPS connection.",
      );
      return;
    }

    const session = sessionRef.current + 1;
    sessionRef.current = session;
    updateStatus("requesting");
    setElapsedMs(0);

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: { ideal: 1 },
        },
        video: false,
      });
    } catch (error: unknown) {
      if (session === sessionRef.current && mountedRef.current) {
        updateStatus("idle");
        onErrorRef.current(microphoneError(error));
      }
      return;
    }

    if (session !== sessionRef.current || !mountedRef.current) {
      stopTracks(stream);
      return;
    }

    const created = createRecorder(stream);

    if (created === null) {
      stopTracks(stream);
      updateStatus("idle");
      onErrorRef.current(
        "This browser could not create a compatible voice recording.",
      );
      return;
    }

    const { recorder, requestedMimeType } = created;
    const chunks: Blob[] = [];
    let recordedBytes = 0;
    let exceededSize = false;
    let recorderFailed = false;
    let stopping = false;
    let finalised = false;
    const startedAt = Date.now();

    recorderRef.current = recorder;
    streamRef.current = stream;

    const finish = () => {
      if (finalised) {
        return;
      }

      finalised = true;
      clearTimers();
      stopTracks(stream);

      if (recorderRef.current === recorder) {
        recorderRef.current = null;
      }
      if (streamRef.current === stream) {
        streamRef.current = null;
      }
      stopCurrentRef.current = null;

      if (session !== sessionRef.current || !mountedRef.current) {
        return;
      }

      updateStatus("idle");
      setElapsedMs(0);

      if (recorderFailed) {
        onErrorRef.current("The recording stopped unexpectedly. Please try again.");
        return;
      }

      const actualMimeType =
        recorder.mimeType || chunks[0]?.type || requestedMimeType;
      const format = formatForMime(actualMimeType);

      if (format === null) {
        onErrorRef.current(
          "This browser recorded an audio format that cannot be sent safely.",
        );
        return;
      }

      const blob = new Blob(chunks, { type: format.mimeType });

      if (exceededSize || blob.size > MAX_ATTACHMENT_BYTES) {
        onErrorRef.current(
          "The voice message reached the 4 MB limit. Try a shorter recording.",
        );
        return;
      }

      if (blob.size === 0) {
        onErrorRef.current("No audio was recorded. Check your microphone and try again.");
        return;
      }

      try {
        onRecordedRef.current(
          new File([blob], recordingName(format.extension), {
            type: format.mimeType,
            lastModified: Date.now(),
          }),
        );
      } catch {
        onErrorRef.current(
          "This browser could not prepare the recording as a file.",
        );
      }
    };

    const requestStop = () => {
      if (
        stopping ||
        session !== sessionRef.current ||
        recorder.state === "inactive"
      ) {
        return;
      }

      stopping = true;
      clearTimers();
      updateStatus("stopping");

      try {
        // The final `dataavailable` event fires before `stop`; `finish` runs from
        // `onstop`, never here, so that final chunk cannot be lost.
        recorder.stop();
      } catch {
        recorderFailed = true;
        finish();
      }
    };

    stopCurrentRef.current = requestStop;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size === 0 || session !== sessionRef.current) {
        return;
      }

      chunks.push(event.data);
      recordedBytes += event.data.size;

      if (recordedBytes > MAX_ATTACHMENT_BYTES) {
        exceededSize = true;
        requestStop();
      }
    };

    recorder.onerror = () => {
      recorderFailed = true;

      if (recorder.state === "inactive") {
        finish();
      } else {
        requestStop();
      }
    };
    recorder.onstop = finish;

    try {
      recorder.start(DATA_SLICE_MS);
    } catch {
      recorderFailed = true;
      finish();
      return;
    }

    updateStatus("recording");
    intervalRef.current = window.setInterval(() => {
      if (session === sessionRef.current && mountedRef.current) {
        setElapsedMs(
          Math.min(Date.now() - startedAt, MAX_VOICE_RECORDING_MS),
        );
      }
    }, CLOCK_TICK_MS);
    timeoutRef.current = window.setTimeout(requestStop, MAX_VOICE_RECORDING_MS);
  }, [clearTimers, updateStatus]);

  return { isSupported, status, elapsedMs, start, stop, cancel };
}

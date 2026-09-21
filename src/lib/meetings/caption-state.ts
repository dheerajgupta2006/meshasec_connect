/**
 * Live caption state for a meeting, and the reducer that keeps every client in
 * step.
 *
 * Pure and transport-free so the rules are testable without a room. The LiveKit
 * data channel carries the messages; this decides what they mean. Modelled on
 * `poll-state.ts`, which is the established pattern for room state in this app.
 *
 * ## What is and is not in here
 *
 * Only what was *said* — the original text and the language it was said in.
 * Translations are deliberately absent: each listener translates locally into
 * whichever language they chose, so a speaker broadcasts one message no matter
 * how many languages are in the room, and a listener can switch language without
 * asking anyone to re-send anything. Putting translations in shared state would
 * multiply traffic by the number of distinct languages present and make every
 * listener's private choice public.
 *
 * ## Not persisted
 *
 * A conversation is not a record unless everyone agreed to one. Captions live in
 * the room and die with it, exactly as polls and raised hands do. The cost is a
 * catch-up path: a client joining mid-call asks for a snapshot, and whoever has
 * state answers.
 */

import { isLanguageCode, type LanguageCode } from "@/lib/i18n/languages";

/**
 * One utterance is bounded well below a message body.
 *
 * Recognition emits a growing string for a single stretch of speech and commits
 * it at a pause, so a segment is a sentence or two. Anything far larger is a
 * runaway recogniser rather than a person talking.
 */
export const MAX_CAPTION_CHARS = 600;

/** Display name bound, matching what LiveKit realistically carries. */
export const MAX_SPEAKER_NAME_CHARS = 80;

/**
 * Rolling transcript window.
 *
 * Enough to scroll back through the last few exchanges, small enough that a
 * two-hour call does not accumulate unbounded state in every participant's tab.
 */
export const MAX_SEGMENTS = 60;

export interface CaptionSegment {
  /**
   * Stable for one utterance.
   *
   * Interim results reuse it so the growing text replaces itself in place rather
   * than stacking up as dozens of half-sentences.
   */
  id: string;
  /** LiveKit identity, always taken from the packet rather than the payload. */
  speaker: string;
  speakerName: string;
  /** What the speaker was recognised as speaking. */
  sourceLanguage: LanguageCode;
  /** The original text, as recognised. Never a translation. */
  text: string;
  /** False while the recogniser may still revise the text. */
  isFinal: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CaptionsState {
  segments: CaptionSegment[];
}

export const EMPTY_CAPTIONS_STATE: CaptionsState = { segments: [] };

/** Payload half of a caption message, before the sender is attributed. */
export interface CaptionDraft {
  id: string;
  speakerName: string;
  sourceLanguage: LanguageCode;
  text: string;
  isFinal: boolean;
}

export type CaptionsMessage =
  | { kind: "caption"; caption: CaptionDraft; at: number }
  /** A speaker turning captions off, so their trailing interim does not linger. */
  | { kind: "caption_stopped" }
  /** A late joiner asking whoever is present to send them the current state. */
  | { kind: "snapshot_request" }
  | { kind: "snapshot"; state: CaptionsState };

function trimTo(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Narrows an untrusted caption message off the wire.
 *
 * Every field is checked because the data channel carries whatever another
 * client chose to send, including a client running a different version of this
 * app. Anything malformed is dropped rather than repaired.
 */
export function parseCaptionsMessage(value: unknown): CaptionsMessage | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.kind !== "string") {
    return null;
  }

  if (record.kind === "snapshot_request" || record.kind === "caption_stopped") {
    return { kind: record.kind };
  }

  if (record.kind === "snapshot") {
    const state = parseCaptionsState(record.state);

    return state === null ? null : { kind: "snapshot", state };
  }

  if (record.kind !== "caption") {
    return null;
  }

  const caption = parseCaptionDraft(record.caption);

  if (caption === null) {
    return null;
  }

  return {
    kind: "caption",
    caption,
    at: typeof record.at === "number" && Number.isFinite(record.at)
      ? record.at
      : Date.now(),
  };
}

function parseCaptionDraft(value: unknown): CaptionDraft | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }

  if (typeof record.text !== "string") {
    return null;
  }

  // An unknown language code means this client cannot translate the segment and
  // would render it mislabelled, so the segment is not worth keeping.
  if (!isLanguageCode(record.sourceLanguage)) {
    return null;
  }

  return {
    id: record.id.slice(0, 64),
    speakerName:
      typeof record.speakerName === "string"
        ? trimTo(record.speakerName, MAX_SPEAKER_NAME_CHARS)
        : "",
    sourceLanguage: record.sourceLanguage,
    text: trimTo(record.text, MAX_CAPTION_CHARS),
    isFinal: record.isFinal === true,
  };
}

function parseCaptionsState(value: unknown): CaptionsState | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (!Array.isArray(record.segments)) {
    return null;
  }

  const segments: CaptionSegment[] = [];

  record.segments.forEach((entry: unknown) => {
    const segment = parseCaptionSegment(entry);

    if (segment !== null) {
      segments.push(segment);
    }
  });

  return { segments: segments.slice(-MAX_SEGMENTS) };
}

function parseCaptionSegment(value: unknown): CaptionSegment | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const draft = parseCaptionDraft(record);

  if (draft === null) {
    return null;
  }

  if (typeof record.speaker !== "string" || record.speaker.length === 0) {
    return null;
  }

  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : Date.now();

  return {
    ...draft,
    speaker: record.speaker,
    createdAt,
    updatedAt:
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : createdAt,
  };
}

/**
 * Applies one message from the room.
 *
 * `from` is the identity of the sender, taken from the LiveKit packet rather than
 * the message body — otherwise anyone could put words in somebody else's mouth,
 * which for a transcript is a more serious forgery than a stolen poll vote.
 *
 * Returns the same object when nothing changed, so React can skip re-rendering.
 */
export function reduceCaptions(
  state: CaptionsState,
  message: CaptionsMessage,
  from: string,
): CaptionsState {
  switch (message.kind) {
    case "caption": {
      const { caption } = message;

      // Nothing recognised yet. Dropping it keeps an empty bubble from flashing
      // up the moment someone unmutes.
      if (caption.text.length === 0) {
        return state;
      }

      const index = state.segments.findIndex(
        (segment) => segment.id === caption.id && segment.speaker === from,
      );

      if (index === -1) {
        const segment: CaptionSegment = {
          id: caption.id,
          speaker: from,
          speakerName: caption.speakerName,
          sourceLanguage: caption.sourceLanguage,
          text: caption.text,
          isFinal: caption.isFinal,
          createdAt: message.at,
          updatedAt: message.at,
        };

        // Oldest first, so the newest caption is at the end and the window drops
        // from the front.
        const segments = [...state.segments, segment].slice(-MAX_SEGMENTS);

        return { segments };
      }

      const existing = state.segments[index];

      // A final result is terminal. Packets can arrive out of order, and a late
      // interim must not reopen and corrupt a sentence already committed.
      if (existing.isFinal) {
        return state;
      }

      if (
        existing.text === caption.text &&
        existing.isFinal === caption.isFinal
      ) {
        return state;
      }

      const segments = [...state.segments];

      segments[index] = {
        ...existing,
        text: caption.text,
        isFinal: caption.isFinal,
        // The name can improve mid-utterance, once the room has resolved it.
        speakerName:
          caption.speakerName.length > 0
            ? caption.speakerName
            : existing.speakerName,
        updatedAt: message.at,
      };

      return { segments };
    }

    case "caption_stopped": {
      // Only this speaker's uncommitted tail is discarded. Their finalised
      // sentences stay, because they were really said.
      const segments = state.segments.filter(
        (segment) => segment.speaker !== from || segment.isFinal,
      );

      return segments.length === state.segments.length ? state : { segments };
    }

    case "snapshot": {
      // Only accepted while empty. Otherwise two clients answering the same
      // request would each overwrite the other's newer local state.
      if (state.segments.length > 0) {
        return state;
      }

      return message.state;
    }

    default:
      return state;
  }
}

/**
 * Segments worth showing, oldest first.
 *
 * Interim segments from a speaker who has since committed a newer utterance are
 * dropped: the recogniser occasionally abandons a partial without finalising it,
 * and leaving those on screen makes the transcript read as though people
 * interrupted themselves constantly.
 */
export function visibleSegments(
  state: CaptionsState,
): readonly CaptionSegment[] {
  const newestFinalBySpeaker = new Map<string, number>();

  state.segments.forEach((segment) => {
    if (!segment.isFinal) {
      return;
    }

    const current = newestFinalBySpeaker.get(segment.speaker) ?? 0;

    if (segment.createdAt > current) {
      newestFinalBySpeaker.set(segment.speaker, segment.createdAt);
    }
  });

  return state.segments.filter((segment) => {
    if (segment.isFinal) {
      return true;
    }

    const newestFinal = newestFinalBySpeaker.get(segment.speaker);

    return newestFinal === undefined || segment.createdAt >= newestFinal;
  });
}

/** Mints an utterance id. Room-local and short-lived, so collisions only have
 * to be avoided within one call. */
export function newCaptionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

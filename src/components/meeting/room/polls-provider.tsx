"use client";

import { useDataChannel, useRoomContext } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import * as React from "react";

import {
  EMPTY_POLLS_STATE,
  normalizePollDraft,
  reducePolls,
  type Poll,
  type PollsMessage,
  type PollsState,
  type Question,
  MAX_POLL_QUESTION_CHARS,
  MAX_QUESTION_CHARS,
} from "@/lib/meetings/poll-state";

/**
 * Shared with reactions: LiveKit has one data channel, so a topic is only a
 * filter. A separate topic keeps poll traffic out of the reaction handler.
 */
const POLLS_TOPIC = "meshasec-room-polls";

/** How long to wait for someone to answer a snapshot request before giving up. */
const SNAPSHOT_TIMEOUT_MS = 2500;

interface PollsContextValue {
  state: PollsState;
  /** Null until the room is connected. */
  localIdentity: string | null;
  openPoll: (
    question: string,
    options: string[],
  ) => { ok: boolean; message: string };
  vote: (pollId: string, optionIndex: number) => void;
  closePoll: (pollId: string) => void;
  askQuestion: (body: string) => { ok: boolean; message: string };
  upvoteQuestion: (questionId: string) => void;
  markAnswered: (questionId: string) => void;
}

const PollsContext = React.createContext<PollsContextValue | null>(null);

export function useMeetingPolls(): PollsContextValue {
  const value = React.useContext(PollsContext);

  if (value === null) {
    throw new Error("useMeetingPolls must be used inside MeetingPollsProvider");
  }

  return value;
}

function parsePayload(payload: Uint8Array): PollsMessage | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { kind?: unknown }).kind !== "string"
    ) {
      return null;
    }

    return parsed as PollsMessage;
  } catch {
    return null;
  }
}

function newId(): string {
  // Room-local and short-lived, so uniqueness only has to hold within one call.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Carries polls and Q&A over the room's data channel.
 *
 * Nothing is stored server-side. That keeps a show of hands from becoming a
 * permanent record, at the cost of needing a catch-up path: a client that joins
 * mid-call broadcasts a snapshot request, and whoever already has state answers it.
 */
export function MeetingPollsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const room = useRoomContext();
  const [state, setState] = React.useState<PollsState>(EMPTY_POLLS_STATE);

  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const handleIncoming = React.useCallback(
    (payload: Uint8Array, from: Participant | undefined) => {
      if (from === undefined || from.identity.length === 0) {
        return;
      }

      const message = parsePayload(payload);

      if (message === null) {
        return;
      }

      // A newcomer asking for history. Answer only if there is something to send,
      // so an empty room does not produce a burst of empty snapshots.
      if (message.kind === "snapshot_request") {
        const current = stateRef.current;

        if (current.polls.length === 0 && current.questions.length === 0) {
          return;
        }

        const reply = new TextEncoder().encode(
          JSON.stringify({ kind: "snapshot", state: current }),
        );

        void sendRef.current(reply, { reliable: true }).catch(() => undefined);
        return;
      }

      // The sender's identity comes from the packet, never the payload, so nobody
      // can vote or ask as somebody else.
      setState((current) => reducePolls(current, message, from.identity));
    },
    [],
  );

  const handleIncomingRef = React.useRef(handleIncoming);
  React.useEffect(() => {
    handleIncomingRef.current = handleIncoming;
  }, [handleIncoming]);

  const onDataMessage = React.useCallback(
    (message: { payload: Uint8Array; from?: Participant }) => {
      handleIncomingRef.current(message.payload, message.from);
    },
    [],
  );

  const { send } = useDataChannel(POLLS_TOPIC, onDataMessage);

  const sendRef = React.useRef(send);
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const broadcast = React.useCallback((message: PollsMessage) => {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    void sendRef.current(payload, { reliable: true }).catch(() => undefined);
  }, []);

  // Ask for history once on join. Harmless if nobody answers — the timeout only
  // exists so the request is not repeated.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      broadcast({ kind: "snapshot_request" });
    }, 600);

    const giveUp = window.setTimeout(() => undefined, SNAPSHOT_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(giveUp);
    };
  }, [broadcast]);

  const localIdentity = room.localParticipant.identity || null;

  /** Applies locally as well as broadcasting: the sender sees no round trip. */
  const applyLocally = React.useCallback(
    (message: PollsMessage) => {
      if (localIdentity === null) {
        return;
      }

      setState((current) => reducePolls(current, message, localIdentity));
    },
    [localIdentity],
  );

  const openPoll = React.useCallback(
    (question: string, options: string[]) => {
      const draft = normalizePollDraft(question, options);

      if (!draft.ok) {
        return { ok: false, message: draft.message };
      }

      if (localIdentity === null) {
        return { ok: false, message: "You are not connected to the room yet." };
      }

      const poll: Poll = {
        id: newId(),
        question: draft.question,
        options: draft.options,
        votes: {},
        closed: false,
        createdAt: Date.now(),
        createdBy: localIdentity,
      };

      const message: PollsMessage = { kind: "poll_opened", poll };
      applyLocally(message);
      broadcast(message);

      return { ok: true, message: "Poll opened." };
    },
    [applyLocally, broadcast, localIdentity],
  );

  const vote = React.useCallback(
    (pollId: string, optionIndex: number) => {
      const message: PollsMessage = { kind: "poll_vote", pollId, optionIndex };
      applyLocally(message);
      broadcast(message);
    },
    [applyLocally, broadcast],
  );

  const closePoll = React.useCallback(
    (pollId: string) => {
      const message: PollsMessage = { kind: "poll_closed", pollId };
      applyLocally(message);
      broadcast(message);
    },
    [applyLocally, broadcast],
  );

  const askQuestion = React.useCallback(
    (body: string) => {
      const cleaned = body.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);

      if (cleaned.length === 0) {
        return { ok: false, message: "Write a question first." };
      }

      if (localIdentity === null) {
        return { ok: false, message: "You are not connected to the room yet." };
      }

      const question: Question = {
        id: newId(),
        body: cleaned,
        askedBy: localIdentity,
        askedByName:
          room.localParticipant.name && room.localParticipant.name.length > 0
            ? room.localParticipant.name
            : "Someone",
        upvotes: [],
        answered: false,
        createdAt: Date.now(),
      };

      const message: PollsMessage = { kind: "question_asked", question };
      applyLocally(message);
      broadcast(message);

      return { ok: true, message: "Question posted." };
    },
    [applyLocally, broadcast, localIdentity, room],
  );

  const upvoteQuestion = React.useCallback(
    (questionId: string) => {
      const message: PollsMessage = { kind: "question_upvote", questionId };
      applyLocally(message);
      broadcast(message);
    },
    [applyLocally, broadcast],
  );

  const markAnswered = React.useCallback(
    (questionId: string) => {
      const message: PollsMessage = { kind: "question_answered", questionId };
      applyLocally(message);
      broadcast(message);
    },
    [applyLocally, broadcast],
  );

  const value = React.useMemo<PollsContextValue>(
    () => ({
      state,
      localIdentity,
      openPoll,
      vote,
      closePoll,
      askQuestion,
      upvoteQuestion,
      markAnswered,
    }),
    [
      state,
      localIdentity,
      openPoll,
      vote,
      closePoll,
      askQuestion,
      upvoteQuestion,
      markAnswered,
    ],
  );

  return (
    <PollsContext.Provider value={value}>{children}</PollsContext.Provider>
  );
}

export { MAX_POLL_QUESTION_CHARS, MAX_QUESTION_CHARS };

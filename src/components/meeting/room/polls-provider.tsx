"use client";

import { useDataChannel, useRoomContext } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import * as React from "react";

import {
  closePoll as closePollOnServer,
  launchPoll as launchPollOnServer,
  markQuestionAnswered as markAnsweredOnServer,
} from "@/app/meeting/[code]/polls";
import {
  EMPTY_POLLS_STATE,
  MAX_POLL_QUESTION_CHARS,
  MAX_QUESTION_CHARS,
  POLLS_TOPIC,
  normalizePollDraft,
  normalizeQuestionBody,
  reduceDraft,
  reducePolls,
  shareableState,
  type MessageOrigin,
  type Poll,
  type PollsMessage,
  type PollsState,
  type Question,
} from "@/lib/meetings/poll-state";

import { useMeetingRoles } from "./roles-provider";

/** How long after joining to ask the room for the state so far. */
const SNAPSHOT_REQUEST_DELAY_MS = 600;

export interface PollsActionOutcome {
  ok: boolean;
  message: string;
}

interface PollsContextValue {
  state: PollsState;
  /** Null until the room is connected. */
  localIdentity: string | null;

  // --- Open to everyone in the room. Sent peer-to-peer. ---
  vote: (pollId: string, optionIndex: number) => void;
  askQuestion: (body: string) => PollsActionOutcome;
  upvoteQuestion: (questionId: string) => void;

  // --- Composing, on the host's own client only. Never broadcast. ---
  draftPoll: (question: string, options: string[]) => PollsActionOutcome;
  discardDraft: (pollId: string) => void;

  // --- Moderation. Checked and published by the server. ---
  launchPoll: (pollId: string) => Promise<PollsActionOutcome>;
  closePoll: (pollId: string) => Promise<PollsActionOutcome>;
  markAnswered: (questionId: string) => Promise<PollsActionOutcome>;
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
  // Lowercase alnum plus a hyphen, which is what the server's id check allows.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Carries polls and Q&A over the room's data channel.
 *
 * Nothing is stored server-side. That keeps a show of hands from becoming a
 * permanent record, at the cost of needing a catch-up path: a client that joins
 * mid-call broadcasts a snapshot request, and a moderator who already has state
 * answers it.
 *
 * Two classes of traffic share the topic, and the difference is the whole security
 * model of the feature:
 *
 * - Votes, questions and upvotes are published by the participant doing them. The
 *   media server stamps the sender's identity on the packet, so the actor cannot
 *   be faked, and these apply locally before they are sent so they feel instant.
 * - Launching, closing and marking answered are published by *our server*, after
 *   `src/app/meeting/[code]/polls.ts` has proved the caller moderates the meeting.
 *   They are deliberately not applied locally: the moderator sees the change when
 *   the room does, so a refused or undelivered action never leaves their view
 *   disagreeing with everyone else's.
 */
export function MeetingPollsProvider({
  meetingCode,
  children,
}: {
  meetingCode: string;
  children: React.ReactNode;
}) {
  const room = useRoomContext();
  const { canModerate, moderatorIdentities } = useMeetingRoles();
  const [state, setState] = React.useState<PollsState>(EMPTY_POLLS_STATE);

  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Read inside the data-channel handler, which is deliberately not re-created on
  // every roles poll — a new callback there would re-subscribe the channel.
  const moderatorsRef = React.useRef(moderatorIdentities);
  React.useEffect(() => {
    moderatorsRef.current = moderatorIdentities;
  }, [moderatorIdentities]);

  const canModerateRef = React.useRef(canModerate);
  React.useEffect(() => {
    canModerateRef.current = canModerate;
  }, [canModerate]);

  const handleIncoming = React.useCallback(
    (payload: Uint8Array, from: Participant | undefined) => {
      const message = parsePayload(payload);

      if (message === null) {
        return;
      }

      /**
       * A packet with no sender came from the LiveKit server API, which only this
       * app's server can call and only after a host check. A packet with a sender
       * carries the identity the media server stamped on it.
       *
       * `from` defined but empty is treated as neither: it should not occur, and
       * reading it as server origin would turn an oddity into a bypass.
       */
      if (from !== undefined && from.identity.length === 0) {
        return;
      }

      const origin: MessageOrigin =
        from === undefined
          ? { kind: "server" }
          : { kind: "participant", identity: from.identity };

      // A newcomer asking for history. Answered only by a moderator, and only if
      // there is something to send, so an empty room does not produce a burst of
      // empty snapshots.
      if (message.kind === "snapshot_request") {
        if (origin.kind !== "participant" || !canModerateRef.current) {
          return;
        }

        const current = shareableState(stateRef.current);

        if (current.polls.length === 0 && current.questions.length === 0) {
          return;
        }

        const reply = new TextEncoder().encode(
          JSON.stringify({ kind: "snapshot", state: current }),
        );

        void sendRef.current(reply, { reliable: true }).catch(() => undefined);
        return;
      }

      setState((current) =>
        reducePolls(current, message, {
          origin,
          moderators: moderatorsRef.current,
        }),
      );
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

  // Ask for history once on join. Harmless if nobody answers.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      broadcast({ kind: "snapshot_request" });
    }, SNAPSHOT_REQUEST_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [broadcast]);

  const localIdentity = room.localParticipant.identity || null;

  /**
   * Applies a participant message locally as well as broadcasting it, so the
   * sender sees no round trip. Only ever used for the open actions — moderation
   * waits for the server.
   */
  const applyLocally = React.useCallback(
    (message: PollsMessage) => {
      if (localIdentity === null) {
        return;
      }

      setState((current) =>
        reducePolls(current, message, {
          origin: { kind: "participant", identity: localIdentity },
          moderators: moderatorsRef.current,
        }),
      );
    },
    [localIdentity],
  );

  // --- Composing -------------------------------------------------------------

  const draftPoll = React.useCallback(
    (question: string, options: string[]): PollsActionOutcome => {
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
        status: "draft",
        createdAt: Date.now(),
        createdBy: localIdentity,
      };

      // Local only. Nothing is broadcast until the host launches it, which is what
      // makes "drafts are private" a property of the wire rather than of the UI.
      setState((current) =>
        reduceDraft(current, { kind: "poll_drafted", poll }, localIdentity),
      );

      return { ok: true, message: "Draft saved." };
    },
    [localIdentity],
  );

  const discardDraft = React.useCallback(
    (pollId: string) => {
      if (localIdentity === null) {
        return;
      }

      setState((current) =>
        reduceDraft(current, { kind: "poll_discarded", pollId }, localIdentity),
      );
    },
    [localIdentity],
  );

  // --- Moderation, via the server -------------------------------------------

  const launchPoll = React.useCallback(
    async (pollId: string): Promise<PollsActionOutcome> => {
      const draft = stateRef.current.polls.find((poll) => poll.id === pollId);

      if (draft === undefined || draft.status !== "draft") {
        return { ok: false, message: "That draft is no longer available." };
      }

      try {
        return await launchPollOnServer(meetingCode, {
          id: draft.id,
          question: draft.question,
          options: draft.options,
        });
      } catch {
        return { ok: false, message: "We could not launch that poll." };
      }
    },
    [meetingCode],
  );

  const closePoll = React.useCallback(
    async (pollId: string): Promise<PollsActionOutcome> => {
      try {
        return await closePollOnServer(meetingCode, pollId);
      } catch {
        return { ok: false, message: "We could not close that poll." };
      }
    },
    [meetingCode],
  );

  const markAnswered = React.useCallback(
    async (questionId: string): Promise<PollsActionOutcome> => {
      try {
        return await markAnsweredOnServer(meetingCode, questionId);
      } catch {
        return { ok: false, message: "We could not update that question." };
      }
    },
    [meetingCode],
  );

  // --- Open to everyone ------------------------------------------------------

  const vote = React.useCallback(
    (pollId: string, optionIndex: number) => {
      const message: PollsMessage = { kind: "poll_vote", pollId, optionIndex };
      applyLocally(message);
      broadcast(message);
    },
    [applyLocally, broadcast],
  );

  const askQuestion = React.useCallback(
    (body: string): PollsActionOutcome => {
      const cleaned = normalizeQuestionBody(body);

      if (!cleaned.ok) {
        return { ok: false, message: cleaned.message };
      }

      if (localIdentity === null) {
        return { ok: false, message: "You are not connected to the room yet." };
      }

      const question: Question = {
        id: newId(),
        body: cleaned.body,
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

  const value = React.useMemo<PollsContextValue>(
    () => ({
      state,
      localIdentity,
      vote,
      askQuestion,
      upvoteQuestion,
      draftPoll,
      discardDraft,
      launchPoll,
      closePoll,
      markAnswered,
    }),
    [
      state,
      localIdentity,
      vote,
      askQuestion,
      upvoteQuestion,
      draftPoll,
      discardDraft,
      launchPoll,
      closePoll,
      markAnswered,
    ],
  );

  return (
    <PollsContext.Provider value={value}>{children}</PollsContext.Provider>
  );
}

export { MAX_POLL_QUESTION_CHARS, MAX_QUESTION_CHARS };

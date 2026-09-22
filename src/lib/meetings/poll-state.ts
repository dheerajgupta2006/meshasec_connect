/**
 * Poll and Q&A state, and the reducer that keeps every client in step.
 *
 * Pure and transport-free so the rules are testable without a room. The LiveKit
 * data channel carries the messages; this decides what they mean.
 *
 * Deliberately not persisted. A poll belongs to the conversation happening now,
 * and storing votes would turn a throwaway show of hands into a record nobody
 * agreed to. The trade-off is that state lives only in the room: see `snapshot`
 * for how a late joiner catches up.
 *
 * ## Who is allowed to do what
 *
 * Two tiers, distinguished by where a message came from rather than by anything
 * it claims about itself:
 *
 * - **Anyone in the room** may vote, ask a question and upvote one. These travel
 *   participant-to-participant, and the actor is the identity the media server
 *   stamped on the packet — never a field in the payload.
 * - **Only a host or co-host** may launch a poll, close one, or mark a question
 *   answered. These are not sent by the moderator's browser at all. The browser
 *   calls a server action, the server proves the caller moderates the meeting,
 *   and the *server* publishes the message through the LiveKit server API. Such
 *   packets carry no participant identity, which is the signal every client uses
 *   to recognise the authority behind them.
 *
 * The practical consequence: a regular participant who crafts a `poll_closed` or
 * `question_answered` packet from the console is ignored by every other client,
 * because their packet arrives stamped with their own identity and moderation
 * messages are only honoured when they arrive with none.
 */

/**
 * Data-channel topic for this feature.
 *
 * The one transport detail that lives here, because both ends need the identical
 * string: the browser subscribes with it and the server publishes with it. LiveKit
 * has a single data channel, so a topic is only a filter — it keeps poll traffic
 * out of the reactions and captions handlers.
 */
export const POLLS_TOPIC = "meshasec-room-polls";

export const MAX_POLL_OPTIONS = 6;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_QUESTION_CHARS = 200;
export const MAX_OPTION_CHARS = 80;
export const MAX_QUESTION_CHARS = 300;

/** Bounds so one room cannot be flooded with items. */
export const MAX_POLLS = 20;
export const MAX_QUESTIONS = 100;

/**
 * Where a poll is in its life.
 *
 * - `draft` — composed but not released. Lives only on the author's own client
 *   and is never broadcast, so "only the host can see it" is a fact about the
 *   wire rather than a rule the UI is trusted to keep.
 * - `live` — released to the room. Votes are accepted.
 * - `closed` — voting is over. Results stay readable by everyone.
 */
export type PollStatus = "draft" | "live" | "closed";

export interface Poll {
  id: string;
  question: string;
  options: string[];
  /** Identities that chose each option, by option index. */
  votes: Record<number, string[]>;
  status: PollStatus;
  createdAt: number;
  /** Identity of the moderator who owns it. */
  createdBy: string;
}

export interface Question {
  id: string;
  body: string;
  askedBy: string;
  askedByName: string;
  upvotes: string[];
  answered: boolean;
  createdAt: number;
}

export interface PollsState {
  polls: Poll[];
  questions: Question[];
}

export const EMPTY_POLLS_STATE: PollsState = { polls: [], questions: [] };

/**
 * Messages that travel over the data channel.
 *
 * The three carrying a `by` field are moderation, and are only ever published by
 * the server after it has checked the caller's role. `by` is the moderator the
 * server acted for; clients cross-check it against the roles they read from the
 * database, so a message naming a non-moderator is discarded.
 */
export type PollsMessage =
  | { kind: "poll_vote"; pollId: string; optionIndex: number }
  | { kind: "question_asked"; question: Question }
  | { kind: "question_upvote"; questionId: string }
  /** A late joiner asking whoever is present to send them the current state. */
  | { kind: "snapshot_request" }
  | { kind: "snapshot"; state: PollsState }
  | { kind: "poll_launched"; poll: Poll; by: string }
  | { kind: "poll_closed"; pollId: string; by: string }
  | { kind: "question_answered"; questionId: string; by: string };

/**
 * Drafting actions, kept out of `PollsMessage` on purpose.
 *
 * A draft belongs to one browser and must never reach the wire. Giving these a
 * separate type means a hostile packet claiming `kind: "poll_drafted"` cannot be
 * parsed into something `reducePolls` will act on — it falls through to the
 * default case and is dropped.
 */
export type PollsDraftAction =
  | { kind: "poll_drafted"; poll: Poll }
  | { kind: "poll_discarded"; pollId: string };

/**
 * How a message reached us.
 *
 * `server` means the packet arrived with no participant identity attached, which
 * only happens for messages published through the LiveKit server API — something
 * a browser cannot do. `participant` carries the identity the media server
 * stamped on the packet, which a sender cannot choose.
 */
export type MessageOrigin =
  | { kind: "server" }
  | { kind: "participant"; identity: string };

/** Who sent a message, and who the room currently recognises as a moderator. */
export interface PollsAuthority {
  origin: MessageOrigin;
  /**
   * LiveKit identities of the host and co-hosts, as read from the database by
   * `getMeetingRoles`. Used to sanity-check the actor named in a moderation
   * message and to decide whose snapshot is worth adopting.
   */
  moderators: readonly string[];
}

function trimTo(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Validates a poll draft.
 *
 * Blank options are dropped rather than rejected, because an empty trailing input
 * is the normal state of a form that offers more slots than the user needs.
 */
export function normalizePollDraft(
  question: string,
  options: readonly string[],
):
  | { ok: true; question: string; options: string[] }
  | { ok: false; message: string } {
  const cleanQuestion = trimTo(question, MAX_POLL_QUESTION_CHARS);

  if (cleanQuestion.length === 0) {
    return { ok: false, message: "Write a question first." };
  }

  const cleanOptions: string[] = [];

  options.forEach((option) => {
    const cleaned = trimTo(option, MAX_OPTION_CHARS);

    if (cleaned.length > 0 && cleanOptions.length < MAX_POLL_OPTIONS) {
      cleanOptions.push(cleaned);
    }
  });

  if (cleanOptions.length < MIN_POLL_OPTIONS) {
    return {
      ok: false,
      message: `Give at least ${String(MIN_POLL_OPTIONS)} options.`,
    };
  }

  return { ok: true, question: cleanQuestion, options: cleanOptions };
}

/** Normalizes a question body the same way, for the server to re-check. */
export function normalizeQuestionBody(
  body: string,
): { ok: true; body: string } | { ok: false; message: string } {
  const cleaned = trimTo(body, MAX_QUESTION_CHARS);

  if (cleaned.length === 0) {
    return { ok: false, message: "Write a question first." };
  }

  return { ok: true, body: cleaned };
}

/** Total votes cast on a poll. */
export function totalVotes(poll: Poll): number {
  return Object.values(poll.votes).reduce(
    (sum, voters) => sum + voters.length,
    0,
  );
}

/** Which option an identity chose, or null. */
export function votedOption(poll: Poll, identity: string): number | null {
  for (const [index, voters] of Object.entries(poll.votes)) {
    if (voters.includes(identity)) {
      return Number(index);
    }
  }

  return null;
}

/** Share of the vote for one option, 0-100. Zero when nothing has been cast. */
export function votePercentage(poll: Poll, optionIndex: number): number {
  const total = totalVotes(poll);

  if (total === 0) {
    return 0;
  }

  return Math.round(((poll.votes[optionIndex]?.length ?? 0) / total) * 100);
}

/** Whether a poll is currently accepting votes. */
export function isVotable(poll: Poll): boolean {
  return poll.status === "live";
}

/**
 * The polls one viewer should see.
 *
 * Drafts never leave their author's client, so this only has to hide the
 * author's own drafts from their own *read-only* views; it exists so the drawer
 * and any future surface cannot accidentally render someone else's draft if one
 * ever arrives.
 */
export function visiblePolls(
  polls: readonly Poll[],
  viewer: string | null,
): Poll[] {
  return polls.filter(
    (poll) => poll.status !== "draft" || (viewer !== null && poll.createdBy === viewer),
  );
}

/**
 * State that is safe to hand to another participant.
 *
 * Strips drafts. Without this, answering a newcomer's snapshot request would leak
 * every unreleased poll the answering client happens to be composing.
 */
export function shareableState(state: PollsState): PollsState {
  return {
    polls: state.polls.filter((poll) => poll.status !== "draft"),
    questions: state.questions,
  };
}

function isModerator(
  authority: PollsAuthority,
  identity: string | null,
): boolean {
  return identity !== null && authority.moderators.includes(identity);
}

/**
 * Applies one message from the room.
 *
 * Returns the same object when nothing changed, so React can skip re-rendering.
 */
export function reducePolls(
  state: PollsState,
  message: PollsMessage,
  authority: PollsAuthority,
): PollsState {
  const { origin } = authority;

  switch (message.kind) {
    // --- Moderation. Server-published only. ---

    case "poll_launched": {
      // Two gates. The packet must have arrived without a participant identity,
      // which only the server can achieve, and the moderator it names must still
      // hold the role according to the database.
      if (origin.kind !== "server" || !isModerator(authority, message.by)) {
        return state;
      }

      const existing = state.polls.find((poll) => poll.id === message.poll.id);

      // The author already holds this poll as a draft, so launching promotes it
      // in place rather than adding a duplicate. Everyone else is seeing it for
      // the first time.
      if (existing !== undefined) {
        if (existing.status !== "draft") {
          return state;
        }

        return {
          ...state,
          polls: state.polls.map((poll) =>
            poll.id === message.poll.id
              ? {
                  ...poll,
                  question: message.poll.question,
                  options: message.poll.options,
                  status: "live",
                  votes: {},
                }
              : poll,
          ),
        };
      }

      if (state.polls.length >= MAX_POLLS) {
        return state;
      }

      return {
        ...state,
        polls: [
          ...state.polls,
          {
            ...message.poll,
            status: "live",
            votes: {},
            createdBy: message.by,
          },
        ],
      };
    }

    case "poll_closed": {
      if (origin.kind !== "server" || !isModerator(authority, message.by)) {
        return state;
      }

      let changed = false;

      const polls = state.polls.map((poll) => {
        // Only a live poll closes. A draft was never open, so there is nothing
        // to close — discarding it is a separate, local action.
        if (poll.id !== message.pollId || poll.status !== "live") {
          return poll;
        }

        changed = true;
        return { ...poll, status: "closed" as PollStatus };
      });

      return changed ? { ...state, polls } : state;
    }

    case "question_answered": {
      if (origin.kind !== "server" || !isModerator(authority, message.by)) {
        return state;
      }

      let changed = false;

      const questions = state.questions.map((question) => {
        if (question.id === message.questionId && !question.answered) {
          changed = true;
          return { ...question, answered: true };
        }

        return question;
      });

      return changed ? { ...state, questions } : state;
    }

    // --- Open to every participant. Actor comes from the packet. ---

    case "poll_vote": {
      if (origin.kind !== "participant") {
        return state;
      }

      const from = origin.identity;
      let changed = false;

      const polls = state.polls.map((poll) => {
        if (poll.id !== message.pollId || !isVotable(poll)) {
          return poll;
        }

        if (
          message.optionIndex < 0 ||
          message.optionIndex >= poll.options.length
        ) {
          return poll;
        }

        // One vote per person: an existing choice is moved, not added to.
        const votes: Record<number, string[]> = {};

        poll.options.forEach((_option, index) => {
          const voters = (poll.votes[index] ?? []).filter(
            (voter) => voter !== from,
          );

          votes[index] =
            index === message.optionIndex ? [...voters, from] : voters;
        });

        changed = true;
        return { ...poll, votes };
      });

      return changed ? { ...state, polls } : state;
    }

    case "question_asked": {
      if (origin.kind !== "participant") {
        return state;
      }

      if (
        state.questions.length >= MAX_QUESTIONS ||
        state.questions.some((question) => question.id === message.question.id)
      ) {
        return state;
      }

      return {
        ...state,
        questions: [
          ...state.questions,
          {
            ...message.question,
            askedBy: origin.identity,
            upvotes: [],
            answered: false,
          },
        ],
      };
    }

    case "question_upvote": {
      if (origin.kind !== "participant") {
        return state;
      }

      const from = origin.identity;
      let changed = false;

      const questions = state.questions.map((question) => {
        if (question.id !== message.questionId) {
          return question;
        }

        const already = question.upvotes.includes(from);
        changed = true;

        // Toggling, so a mis-tap is undoable.
        return {
          ...question,
          upvotes: already
            ? question.upvotes.filter((voter) => voter !== from)
            : [...question.upvotes, from],
        };
      });

      return changed ? { ...state, questions } : state;
    }

    case "snapshot": {
      // Only accepted while empty. Otherwise two clients answering the same
      // request would each overwrite the other's newer local state.
      if (state.polls.length > 0 || state.questions.length > 0) {
        return state;
      }

      // A snapshot restates who won a vote and what has been answered, so it
      // carries moderation weight and is taken only from a moderator. A regular
      // participant answering a newcomer could otherwise hand them a room where
      // every question is already marked answered.
      if (
        origin.kind !== "participant" ||
        !isModerator(authority, origin.identity)
      ) {
        return state;
      }

      // Drafts are stripped on send; stripped again here so a doctored snapshot
      // cannot plant one on somebody else's client.
      return shareableState(message.state);
    }

    default:
      return state;
  }
}

/**
 * Applies a drafting action on the author's own client.
 *
 * Separate from `reducePolls` because drafts are never transmitted: there is no
 * origin to check, only the identity of the person composing.
 */
export function reduceDraft(
  state: PollsState,
  action: PollsDraftAction,
  identity: string,
): PollsState {
  switch (action.kind) {
    case "poll_drafted": {
      if (
        state.polls.length >= MAX_POLLS ||
        state.polls.some((poll) => poll.id === action.poll.id)
      ) {
        return state;
      }

      return {
        ...state,
        polls: [
          ...state.polls,
          {
            ...action.poll,
            status: "draft",
            votes: {},
            createdBy: identity,
          },
        ],
      };
    }

    case "poll_discarded": {
      // Only your own draft, and only while it is still a draft: once a poll is
      // live the room has seen it and closing is the way to end it.
      const polls = state.polls.filter(
        (poll) =>
          !(
            poll.id === action.pollId &&
            poll.status === "draft" &&
            poll.createdBy === identity
          ),
      );

      return polls.length === state.polls.length ? state : { ...state, polls };
    }

    default:
      return state;
  }
}

/** Questions sorted for display: unanswered first, then most upvoted. */
export function sortQuestions(questions: readonly Question[]): Question[] {
  return [...questions].sort((first, second) => {
    if (first.answered !== second.answered) {
      return first.answered ? 1 : -1;
    }

    if (first.upvotes.length !== second.upvotes.length) {
      return second.upvotes.length - first.upvotes.length;
    }

    return first.createdAt - second.createdAt;
  });
}

const STATUS_ORDER: Record<PollStatus, number> = {
  draft: 0,
  live: 1,
  closed: 2,
};

/**
 * Polls sorted for display: drafts first because they are waiting on the host,
 * then live, then closed. Newest first within each group.
 */
export function sortPolls(polls: readonly Poll[]): Poll[] {
  return [...polls].sort((first, second) => {
    if (first.status !== second.status) {
      return STATUS_ORDER[first.status] - STATUS_ORDER[second.status];
    }

    return second.createdAt - first.createdAt;
  });
}

/**
 * Poll and Q&A state, and the reducer that keeps every client in step.
 *
 * Pure and transport-free so the rules are testable without a room. The LiveKit
 * data channel carries the messages; this decides what they mean.
 *
 * Deliberately not persisted. A poll belongs to the conversation happening now,
 * and storing votes would turn a throwaway show of hands into a record nobody
 * agreed to. The trade-off is that state lives only in the room: see
 * `applySnapshot` for how a late joiner catches up.
 */

export const MAX_POLL_OPTIONS = 6;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_QUESTION_CHARS = 200;
export const MAX_OPTION_CHARS = 80;
export const MAX_QUESTION_CHARS = 300;

/** Bounds so one participant cannot flood the room with items. */
export const MAX_POLLS = 20;
export const MAX_QUESTIONS = 100;

export interface Poll {
  id: string;
  question: string;
  options: string[];
  /** Identities that chose each option, by option index. */
  votes: Record<number, string[]>;
  closed: boolean;
  createdAt: number;
  /** Identity of the host who opened it. */
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

export type PollsMessage =
  | { kind: "poll_opened"; poll: Poll }
  | { kind: "poll_vote"; pollId: string; optionIndex: number }
  | { kind: "poll_closed"; pollId: string }
  | { kind: "question_asked"; question: Question }
  | { kind: "question_upvote"; questionId: string }
  | { kind: "question_answered"; questionId: string }
  /** A late joiner asking whoever is present to send them the current state. */
  | { kind: "snapshot_request" }
  | { kind: "snapshot"; state: PollsState };

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
): { ok: true; question: string; options: string[] } | { ok: false; message: string } {
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
      message: `Give at least ${MIN_POLL_OPTIONS} options.`,
    };
  }

  return { ok: true, question: cleanQuestion, options: cleanOptions };
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

/**
 * Applies one message from the room.
 *
 * `from` is the identity of the sender, taken from the LiveKit packet rather than
 * the message body — otherwise anyone could vote or upvote as somebody else.
 *
 * Returns the same object when nothing changed, so React can skip re-rendering.
 */
export function reducePolls(
  state: PollsState,
  message: PollsMessage,
  from: string,
): PollsState {
  switch (message.kind) {
    case "poll_opened": {
      if (
        state.polls.length >= MAX_POLLS ||
        state.polls.some((poll) => poll.id === message.poll.id)
      ) {
        return state;
      }

      // Authorship comes from the packet, not the payload.
      return {
        ...state,
        polls: [...state.polls, { ...message.poll, createdBy: from }],
      };
    }

    case "poll_vote": {
      let changed = false;

      const polls = state.polls.map((poll) => {
        if (poll.id !== message.pollId || poll.closed) {
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

    case "poll_closed": {
      let changed = false;

      const polls = state.polls.map((poll) => {
        // Only the person who opened it may close it.
        if (poll.id !== message.pollId || poll.closed || poll.createdBy !== from) {
          return poll;
        }

        changed = true;
        return { ...poll, closed: true };
      });

      return changed ? { ...state, polls } : state;
    }

    case "question_asked": {
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
          { ...message.question, askedBy: from, upvotes: [], answered: false },
        ],
      };
    }

    case "question_upvote": {
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

    case "question_answered": {
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

    case "snapshot": {
      // Only accepted while empty. Otherwise two clients answering the same
      // request would each overwrite the other's newer local state.
      if (state.polls.length > 0 || state.questions.length > 0) {
        return state;
      }

      return message.state;
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

/** Polls sorted newest first, with open ones ahead of closed. */
export function sortPolls(polls: readonly Poll[]): Poll[] {
  return [...polls].sort((first, second) => {
    if (first.closed !== second.closed) {
      return first.closed ? 1 : -1;
    }

    return second.createdAt - first.createdAt;
  });
}

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  EMPTY_POLLS_STATE,
  MIN_POLL_OPTIONS,
  MAX_POLLS,
  MAX_QUESTIONS,
  normalizePollDraft,
  reducePolls,
  sortPolls,
  sortQuestions,
  totalVotes,
  votePercentage,
  votedOption,
  type Poll,
  type PollsState,
  type Question,
} from "@/lib/meetings/poll-state";

const HOST = "user_host";
const A = "user_a";
const B = "user_b";

function poll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: "poll1",
    question: "Lunch?",
    options: ["Pizza", "Salad"],
    votes: {},
    closed: false,
    createdAt: 1000,
    createdBy: HOST,
    ...overrides,
  };
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: "q1",
    body: "Why?",
    askedBy: A,
    askedByName: "A",
    upvotes: [],
    answered: false,
    createdAt: 1000,
    ...overrides,
  };
}

function withPoll(existing: Poll): PollsState {
  return { polls: [existing], questions: [] };
}

describe("normalizePollDraft", () => {
  it("accepts a well-formed draft", () => {
    const result = normalizePollDraft("  Lunch?  ", ["Pizza", " Salad "]);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.question).toBe("Lunch?");
      expect(result.options).toEqual(["Pizza", "Salad"]);
    }
  });

  it("drops blank options rather than rejecting the draft", () => {
    // An empty trailing input is the normal state of a form offering spare slots.
    const result = normalizePollDraft("Lunch?", ["Pizza", "Salad", "", "  "]);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.options).toEqual(["Pizza", "Salad"]);
    }
  });

  it("rejects an empty question", () => {
    expect(normalizePollDraft("   ", ["a", "b"]).ok).toBe(false);
  });

  it("rejects fewer than the minimum options", () => {
    expect(normalizePollDraft("Lunch?", ["Pizza"]).ok).toBe(false);
    expect(normalizePollDraft("Lunch?", ["Pizza", ""]).ok).toBe(false);
  });

  it("bounds the option count", () => {
    const many = Array.from({ length: 20 }, (_v, index) => `Option ${index}`);
    const result = normalizePollDraft("Lunch?", many);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.options.length).toBeLessThanOrEqual(6);
    }
  });

  it("never throws and always yields enough options when it succeeds", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(fc.string(), { maxLength: 12 }),
        (text, options) => {
          const result = normalizePollDraft(text, options);

          if (result.ok) {
            expect(result.options.length).toBeGreaterThanOrEqual(
              MIN_POLL_OPTIONS,
            );
            expect(result.question.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("reducePolls — voting", () => {
  it("records a vote", () => {
    const next = reducePolls(
      withPoll(poll()),
      { kind: "poll_vote", pollId: "poll1", optionIndex: 0 },
      A,
    );

    expect(next.polls[0]?.votes[0]).toEqual([A]);
  });

  it("moves a vote instead of counting it twice", () => {
    let state = withPoll(poll());
    state = reducePolls(
      state,
      { kind: "poll_vote", pollId: "poll1", optionIndex: 0 },
      A,
    );
    state = reducePolls(
      state,
      { kind: "poll_vote", pollId: "poll1", optionIndex: 1 },
      A,
    );

    expect(state.polls[0]?.votes[0]).toEqual([]);
    expect(state.polls[0]?.votes[1]).toEqual([A]);
    expect(totalVotes(state.polls[0] ?? poll())).toBe(1);
  });

  it("attributes the vote to the packet sender, not the payload", () => {
    // The message carries no voter field at all, which is what makes voting as
    // somebody else impossible.
    const next = reducePolls(
      withPoll(poll()),
      { kind: "poll_vote", pollId: "poll1", optionIndex: 0 },
      B,
    );

    expect(next.polls[0]?.votes[0]).toEqual([B]);
  });

  it("ignores a vote on a closed poll", () => {
    const state = withPoll(poll({ closed: true }));
    const next = reducePolls(
      state,
      { kind: "poll_vote", pollId: "poll1", optionIndex: 0 },
      A,
    );

    expect(next).toBe(state);
  });

  it("ignores an out-of-range option", () => {
    for (const optionIndex of [-1, 2, 99]) {
      const state = withPoll(poll());
      const next = reducePolls(
        state,
        { kind: "poll_vote", pollId: "poll1", optionIndex },
        A,
      );

      expect(totalVotes(next.polls[0] ?? poll())).toBe(0);
    }
  });

  it("ignores a vote for an unknown poll", () => {
    const state = withPoll(poll());

    expect(
      reducePolls(
        state,
        { kind: "poll_vote", pollId: "nope", optionIndex: 0 },
        A,
      ),
    ).toBe(state);
  });
});

describe("reducePolls — closing", () => {
  it("lets the author close their poll", () => {
    const next = reducePolls(
      withPoll(poll()),
      { kind: "poll_closed", pollId: "poll1" },
      HOST,
    );

    expect(next.polls[0]?.closed).toBe(true);
  });

  it("refuses anyone else", () => {
    const state = withPoll(poll());

    expect(
      reducePolls(state, { kind: "poll_closed", pollId: "poll1" }, A),
    ).toBe(state);
  });
});

describe("reducePolls — creation limits", () => {
  it("rejects a duplicate poll id", () => {
    const state = withPoll(poll());
    const next = reducePolls(
      state,
      { kind: "poll_opened", poll: poll() },
      HOST,
    );

    expect(next).toBe(state);
  });

  it("caps the number of polls", () => {
    let state: PollsState = EMPTY_POLLS_STATE;

    for (let index = 0; index < MAX_POLLS + 5; index += 1) {
      state = reducePolls(
        state,
        { kind: "poll_opened", poll: poll({ id: `p${index}` }) },
        HOST,
      );
    }

    expect(state.polls.length).toBe(MAX_POLLS);
  });

  it("caps the number of questions", () => {
    let state: PollsState = EMPTY_POLLS_STATE;

    for (let index = 0; index < MAX_QUESTIONS + 5; index += 1) {
      state = reducePolls(
        state,
        { kind: "question_asked", question: question({ id: `q${index}` }) },
        A,
      );
    }

    expect(state.questions.length).toBe(MAX_QUESTIONS);
  });
});

describe("reducePolls — questions", () => {
  it("toggles an upvote so a mis-tap is undoable", () => {
    let state: PollsState = { polls: [], questions: [question()] };

    state = reducePolls(state, { kind: "question_upvote", questionId: "q1" }, B);
    expect(state.questions[0]?.upvotes).toEqual([B]);

    state = reducePolls(state, { kind: "question_upvote", questionId: "q1" }, B);
    expect(state.questions[0]?.upvotes).toEqual([]);
  });

  it("counts each person once", () => {
    let state: PollsState = { polls: [], questions: [question()] };

    state = reducePolls(state, { kind: "question_upvote", questionId: "q1" }, A);
    state = reducePolls(state, { kind: "question_upvote", questionId: "q1" }, B);

    expect(state.questions[0]?.upvotes).toHaveLength(2);
  });

  it("marks a question answered once", () => {
    let state: PollsState = { polls: [], questions: [question()] };

    state = reducePolls(
      state,
      { kind: "question_answered", questionId: "q1" },
      HOST,
    );
    expect(state.questions[0]?.answered).toBe(true);

    const again = reducePolls(
      state,
      { kind: "question_answered", questionId: "q1" },
      HOST,
    );
    expect(again).toBe(state);
  });

  it("strips submitted upvotes and answered state on creation", () => {
    // Otherwise a client could post a question that arrives pre-upvoted.
    const next = reducePolls(
      EMPTY_POLLS_STATE,
      {
        kind: "question_asked",
        question: question({ upvotes: [A, B], answered: true }),
      },
      A,
    );

    expect(next.questions[0]?.upvotes).toEqual([]);
    expect(next.questions[0]?.answered).toBe(false);
  });
});

describe("reducePolls — snapshots", () => {
  it("adopts a snapshot when empty", () => {
    const snapshot: PollsState = { polls: [poll()], questions: [question()] };
    const next = reducePolls(
      EMPTY_POLLS_STATE,
      { kind: "snapshot", state: snapshot },
      HOST,
    );

    expect(next).toEqual(snapshot);
  });

  it("ignores a snapshot once there is local state", () => {
    // Two clients answering the same request would otherwise each clobber the
    // other's newer state.
    const state = withPoll(poll({ id: "mine" }));
    const next = reducePolls(
      state,
      { kind: "snapshot", state: { polls: [poll({ id: "theirs" })], questions: [] } },
      HOST,
    );

    expect(next).toBe(state);
  });
});

describe("vote helpers", () => {
  it("reports the chosen option and null otherwise", () => {
    const voted = poll({ votes: { 0: [A], 1: [B] } });

    expect(votedOption(voted, A)).toBe(0);
    expect(votedOption(voted, B)).toBe(1);
    expect(votedOption(voted, "nobody")).toBeNull();
  });

  it("returns 0% for every option before any vote", () => {
    const empty = poll();

    expect(votePercentage(empty, 0)).toBe(0);
    expect(votePercentage(empty, 1)).toBe(0);
  });

  it("never returns a share outside 0-100", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ minLength: 1 }), { maxLength: 5 }), {
          minLength: 2,
          maxLength: 4,
        }),
        (voterGroups) => {
          const votes: Record<number, string[]> = {};
          voterGroups.forEach((group, index) => {
            votes[index] = group;
          });

          const subject = poll({
            options: voterGroups.map((_g, index) => `Option ${index}`),
            votes,
          });

          voterGroups.forEach((_group, index) => {
            const share = votePercentage(subject, index);
            expect(share).toBeGreaterThanOrEqual(0);
            expect(share).toBeLessThanOrEqual(100);
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("sorting", () => {
  it("puts unanswered questions first, then most upvoted", () => {
    const sorted = sortQuestions([
      question({ id: "answered", answered: true, upvotes: [A, B] }),
      question({ id: "quiet", upvotes: [] }),
      question({ id: "popular", upvotes: [A, B] }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual([
      "popular",
      "quiet",
      "answered",
    ]);
  });

  it("puts open polls before closed, newest first", () => {
    const sorted = sortPolls([
      poll({ id: "old", createdAt: 1 }),
      poll({ id: "closed", closed: true, createdAt: 99 }),
      poll({ id: "new", createdAt: 50 }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["new", "old", "closed"]);
  });

  it("does not mutate its input", () => {
    const input = [question({ id: "a" }), question({ id: "b" })];
    const snapshot = [...input];

    sortQuestions(input);

    expect(input).toEqual(snapshot);
  });
});

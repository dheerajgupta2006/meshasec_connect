import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  EMPTY_POLLS_STATE,
  MAX_POLLS,
  MAX_QUESTIONS,
  MIN_POLL_OPTIONS,
  isVotable,
  normalizePollDraft,
  normalizeQuestionBody,
  reduceDraft,
  reducePolls,
  shareableState,
  sortPolls,
  sortQuestions,
  totalVotes,
  visiblePolls,
  votePercentage,
  votedOption,
  type Poll,
  type PollsAuthority,
  type PollsState,
  type Question,
} from "@/lib/meetings/poll-state";

const HOST = "user_host";
const CO_HOST = "user_cohost";
const A = "user_a";
const B = "user_b";

const MODERATORS = [HOST, CO_HOST];

/** A message the server published after checking the caller's role. */
function fromServer(
  moderators: readonly string[] = MODERATORS,
): PollsAuthority {
  return { origin: { kind: "server" }, moderators };
}

/** A message a participant's browser published. */
function fromParticipant(
  identity: string,
  moderators: readonly string[] = MODERATORS,
): PollsAuthority {
  return { origin: { kind: "participant", identity }, moderators };
}

function poll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: "poll1",
    question: "Lunch?",
    options: ["Pizza", "Salad"],
    votes: {},
    status: "live",
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

function withQuestion(existing: Question): PollsState {
  return { polls: [], questions: [existing] };
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

describe("normalizeQuestionBody", () => {
  it("collapses whitespace and trims", () => {
    const result = normalizeQuestionBody("  why   is   this  ");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.body).toBe("why is this");
    }
  });

  it("rejects a blank body", () => {
    expect(normalizeQuestionBody("    ").ok).toBe(false);
  });

  it("never throws and never returns an empty accepted body", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = normalizeQuestionBody(text);

        if (result.ok) {
          expect(result.body.length).toBeGreaterThan(0);
          expect(result.body.length).toBeLessThanOrEqual(300);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("moderation requires the server as the sender", () => {
  // The point of the whole design: a participant's browser cannot produce a
  // packet without an identity, so these three messages are only honoured when
  // they arrive with none.

  it("refuses a poll launch published by a participant, even a moderator", () => {
    const launched = reducePolls(
      EMPTY_POLLS_STATE,
      { kind: "poll_launched", poll: poll({ status: "live" }), by: HOST },
      fromParticipant(HOST),
    );

    expect(launched).toBe(EMPTY_POLLS_STATE);
  });

  it("refuses a close published by a participant, even a moderator", () => {
    const state = withPoll(poll());

    expect(
      reducePolls(
        state,
        { kind: "poll_closed", pollId: "poll1", by: HOST },
        fromParticipant(HOST),
      ),
    ).toBe(state);
  });

  it("refuses question_answered published by a participant", () => {
    // Previously this message had no check at all, so any client could mark
    // anything answered.
    const state = withQuestion(question());

    expect(
      reducePolls(
        state,
        { kind: "question_answered", questionId: "q1", by: HOST },
        fromParticipant(A),
      ),
    ).toBe(state);
  });

  it("refuses a server message naming someone who does not moderate", () => {
    // Defence in depth: recipients re-check the actor against the roles they read
    // from the database rather than taking the payload's word for it.
    const state = withQuestion(question());

    expect(
      reducePolls(
        state,
        { kind: "question_answered", questionId: "q1", by: A },
        fromServer(),
      ),
    ).toBe(state);
  });

  it("accepts a co-host as the actor", () => {
    const next = reducePolls(
      withQuestion(question()),
      { kind: "question_answered", questionId: "q1", by: CO_HOST },
      fromServer(),
    );

    expect(next.questions[0]?.answered).toBe(true);
  });

  it("refuses everything once the actor has lost the role", () => {
    // A stale packet from a demoted co-host must not still land.
    const state = withPoll(poll());

    expect(
      reducePolls(
        state,
        { kind: "poll_closed", pollId: "poll1", by: CO_HOST },
        fromServer([HOST]),
      ),
    ).toBe(state);
  });
});

describe("poll lifecycle", () => {
  it("promotes the author's draft in place rather than duplicating it", () => {
    const drafted = reduceDraft(
      EMPTY_POLLS_STATE,
      { kind: "poll_drafted", poll: poll({ status: "draft" }) },
      HOST,
    );

    const live = reducePolls(
      drafted,
      { kind: "poll_launched", poll: poll({ status: "live" }), by: HOST },
      fromServer(),
    );

    expect(live.polls).toHaveLength(1);
    expect(live.polls[0]?.status).toBe("live");
  });

  it("inserts the poll for everyone who never held the draft", () => {
    const live = reducePolls(
      EMPTY_POLLS_STATE,
      { kind: "poll_launched", poll: poll(), by: HOST },
      fromServer(),
    );

    expect(live.polls).toHaveLength(1);
    expect(live.polls[0]?.status).toBe("live");
    expect(live.polls[0]?.createdBy).toBe(HOST);
  });

  it("attributes authorship to the moderator the server named", () => {
    const live = reducePolls(
      EMPTY_POLLS_STATE,
      { kind: "poll_launched", poll: poll({ createdBy: A }), by: CO_HOST },
      fromServer(),
    );

    expect(live.polls[0]?.createdBy).toBe(CO_HOST);
  });

  it("discards votes submitted with a launch", () => {
    const live = reducePolls(
      EMPTY_POLLS_STATE,
      {
        kind: "poll_launched",
        poll: poll({ votes: { 0: [A, B] } }),
        by: HOST,
      },
      fromServer(),
    );

    expect(totalVotes(live.polls[0] ?? poll())).toBe(0);
  });

  it("ignores a second launch of a poll that is already live", () => {
    const state = withPoll(poll({ status: "live" }));

    expect(
      reducePolls(
        state,
        { kind: "poll_launched", poll: poll(), by: HOST },
        fromServer(),
      ),
    ).toBe(state);
  });

  it("closes a live poll", () => {
    const next = reducePolls(
      withPoll(poll()),
      { kind: "poll_closed", pollId: "poll1", by: HOST },
      fromServer(),
    );

    expect(next.polls[0]?.status).toBe("closed");
  });

  it("does not close a draft, which was never open", () => {
    const state = withPoll(poll({ status: "draft" }));

    expect(
      reducePolls(
        state,
        { kind: "poll_closed", pollId: "poll1", by: HOST },
        fromServer(),
      ),
    ).toBe(state);
  });

  it("ignores closing something already closed", () => {
    const state = withPoll(poll({ status: "closed" }));

    expect(
      reducePolls(
        state,
        { kind: "poll_closed", pollId: "poll1", by: HOST },
        fromServer(),
      ),
    ).toBe(state);
  });

  it("caps the number of polls", () => {
    let state: PollsState = EMPTY_POLLS_STATE;

    for (let index = 0; index < MAX_POLLS + 5; index += 1) {
      state = reducePolls(
        state,
        { kind: "poll_launched", poll: poll({ id: `p${String(index)}` }), by: HOST },
        fromServer(),
      );
    }

    expect(state.polls.length).toBe(MAX_POLLS);
  });
});

describe("voting", () => {
  it("records a vote", () => {
    const next = reducePolls(
      withPoll(poll()),
      { kind: "poll_vote", pollId: "poll1", optionIndex: 0 },
      fromParticipant(A),
    );

    expect(next.polls[0]?.votes[0]).toEqual([A]);
  });

  it("moves a vote instead of counting it twice", () => {
    let state = withPoll(poll());
    state = reducePolls(
      state,
      { kind: "poll_vote", pollId: "poll1", optionIndex: 0 },
      fromParticipant(A),
    );
    state = reducePolls(
      state,
      { kind: "poll_vote", pollId: "poll1", optionIndex: 1 },
      fromParticipant(A),
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
      fromParticipant(B),
    );

    expect(next.polls[0]?.votes[0]).toEqual([B]);
  });

  it("ignores a vote on a closed poll", () => {
    const state = withPoll(poll({ status: "closed" }));

    expect(
      reducePolls(
        state,
        { kind: "poll_vote", pollId: "poll1", optionIndex: 0 },
        fromParticipant(A),
      ),
    ).toBe(state);
  });

  it("ignores a vote on a draft", () => {
    const state = withPoll(poll({ status: "draft" }));

    expect(
      reducePolls(
        state,
        { kind: "poll_vote", pollId: "poll1", optionIndex: 0 },
        fromParticipant(A),
      ),
    ).toBe(state);
  });

  it("ignores an out-of-range option", () => {
    for (const optionIndex of [-1, 2, 99]) {
      const state = withPoll(poll());
      const next = reducePolls(
        state,
        { kind: "poll_vote", pollId: "poll1", optionIndex },
        fromParticipant(A),
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
        fromParticipant(A),
      ),
    ).toBe(state);
  });

  it("ignores a vote with no participant attached", () => {
    // A vote needs an actor, and the server never casts one.
    const state = withPoll(poll());

    expect(
      reducePolls(
        state,
        { kind: "poll_vote", pollId: "poll1", optionIndex: 0 },
        fromServer(),
      ),
    ).toBe(state);
  });
});

describe("questions", () => {
  it("toggles an upvote so a mis-tap is undoable", () => {
    let state = withQuestion(question());

    state = reducePolls(
      state,
      { kind: "question_upvote", questionId: "q1" },
      fromParticipant(B),
    );
    expect(state.questions[0]?.upvotes).toEqual([B]);

    state = reducePolls(
      state,
      { kind: "question_upvote", questionId: "q1" },
      fromParticipant(B),
    );
    expect(state.questions[0]?.upvotes).toEqual([]);
  });

  it("counts each person once", () => {
    let state = withQuestion(question());

    state = reducePolls(
      state,
      { kind: "question_upvote", questionId: "q1" },
      fromParticipant(A),
    );
    state = reducePolls(
      state,
      { kind: "question_upvote", questionId: "q1" },
      fromParticipant(B),
    );

    expect(state.questions[0]?.upvotes).toHaveLength(2);
  });

  it("marks a question answered once", () => {
    const state = reducePolls(
      withQuestion(question()),
      { kind: "question_answered", questionId: "q1", by: HOST },
      fromServer(),
    );

    expect(state.questions[0]?.answered).toBe(true);

    const again = reducePolls(
      state,
      { kind: "question_answered", questionId: "q1", by: HOST },
      fromServer(),
    );

    expect(again).toBe(state);
  });

  it("attributes a question to the packet sender", () => {
    const next = reducePolls(
      EMPTY_POLLS_STATE,
      { kind: "question_asked", question: question({ askedBy: HOST }) },
      fromParticipant(A),
    );

    expect(next.questions[0]?.askedBy).toBe(A);
  });

  it("strips submitted upvotes and answered state on creation", () => {
    // Otherwise a client could post a question that arrives pre-upvoted and
    // already crossed out.
    const next = reducePolls(
      EMPTY_POLLS_STATE,
      {
        kind: "question_asked",
        question: question({ upvotes: [A, B], answered: true }),
      },
      fromParticipant(A),
    );

    expect(next.questions[0]?.upvotes).toEqual([]);
    expect(next.questions[0]?.answered).toBe(false);
  });

  it("rejects a duplicate question id", () => {
    const state = withQuestion(question());

    expect(
      reducePolls(
        state,
        { kind: "question_asked", question: question() },
        fromParticipant(B),
      ),
    ).toBe(state);
  });

  it("caps the number of questions", () => {
    let state: PollsState = EMPTY_POLLS_STATE;

    for (let index = 0; index < MAX_QUESTIONS + 5; index += 1) {
      state = reducePolls(
        state,
        {
          kind: "question_asked",
          question: question({ id: `q${String(index)}` }),
        },
        fromParticipant(A),
      );
    }

    expect(state.questions.length).toBe(MAX_QUESTIONS);
  });
});

describe("drafts", () => {
  it("keeps a draft out of the shareable state", () => {
    const state: PollsState = {
      polls: [poll({ id: "live" }), poll({ id: "secret", status: "draft" })],
      questions: [],
    };

    expect(shareableState(state).polls.map((entry) => entry.id)).toEqual([
      "live",
    ]);
  });

  it("attributes a draft to the client composing it", () => {
    const next = reduceDraft(
      EMPTY_POLLS_STATE,
      { kind: "poll_drafted", poll: poll({ createdBy: HOST }) },
      CO_HOST,
    );

    expect(next.polls[0]?.createdBy).toBe(CO_HOST);
    expect(next.polls[0]?.status).toBe("draft");
  });

  it("discards only the author's own draft", () => {
    const state = withPoll(poll({ status: "draft", createdBy: HOST }));

    expect(
      reduceDraft(state, { kind: "poll_discarded", pollId: "poll1" }, A),
    ).toBe(state);

    expect(
      reduceDraft(state, { kind: "poll_discarded", pollId: "poll1" }, HOST)
        .polls,
    ).toEqual([]);
  });

  it("will not discard a poll that is already live", () => {
    const state = withPoll(poll({ status: "live", createdBy: HOST }));

    expect(
      reduceDraft(state, { kind: "poll_discarded", pollId: "poll1" }, HOST),
    ).toBe(state);
  });

  it("hides someone else's draft from a viewer", () => {
    const polls = [
      poll({ id: "mine", status: "draft", createdBy: HOST }),
      poll({ id: "theirs", status: "draft", createdBy: CO_HOST }),
      poll({ id: "live" }),
    ];

    expect(visiblePolls(polls, HOST).map((entry) => entry.id)).toEqual([
      "mine",
      "live",
    ]);
  });

  it("hides every draft from a viewer with no identity yet", () => {
    const polls = [poll({ id: "draft", status: "draft" }), poll({ id: "live" })];

    expect(visiblePolls(polls, null).map((entry) => entry.id)).toEqual(["live"]);
  });
});

describe("snapshots", () => {
  it("adopts a moderator's snapshot when empty", () => {
    const snapshot: PollsState = { polls: [poll()], questions: [question()] };
    const next = reducePolls(
      EMPTY_POLLS_STATE,
      { kind: "snapshot", state: snapshot },
      fromParticipant(HOST),
    );

    expect(next).toEqual(snapshot);
  });

  it("refuses a snapshot from a regular participant", () => {
    // Otherwise anyone could hand a newcomer a room where every question is
    // already answered and every poll already closed.
    const snapshot: PollsState = {
      polls: [poll({ status: "closed" })],
      questions: [question({ answered: true })],
    };

    expect(
      reducePolls(
        EMPTY_POLLS_STATE,
        { kind: "snapshot", state: snapshot },
        fromParticipant(A),
      ),
    ).toBe(EMPTY_POLLS_STATE);
  });

  it("strips drafts out of an incoming snapshot", () => {
    const snapshot: PollsState = {
      polls: [poll({ id: "planted", status: "draft" }), poll({ id: "live" })],
      questions: [],
    };

    const next = reducePolls(
      EMPTY_POLLS_STATE,
      { kind: "snapshot", state: snapshot },
      fromParticipant(HOST),
    );

    expect(next.polls.map((entry) => entry.id)).toEqual(["live"]);
  });

  it("ignores a snapshot once there is local state", () => {
    // Two clients answering the same request would otherwise each clobber the
    // other's newer state.
    const state = withPoll(poll({ id: "mine" }));
    const next = reducePolls(
      state,
      {
        kind: "snapshot",
        state: { polls: [poll({ id: "theirs" })], questions: [] },
      },
      fromParticipant(HOST),
    );

    expect(next).toBe(state);
  });
});

describe("unknown messages", () => {
  it("drops anything it does not recognise", () => {
    const state = withPoll(poll());

    // A hostile packet claiming a drafting action: drafts are local-only and have
    // no wire representation, so this must fall through untouched.
    const forged = { kind: "poll_drafted", poll: poll({ id: "planted" }) };

    expect(
      reducePolls(
        state,
        forged as unknown as Parameters<typeof reducePolls>[1],
        fromParticipant(A),
      ),
    ).toBe(state);
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

  it("only treats a live poll as votable", () => {
    expect(isVotable(poll({ status: "live" }))).toBe(true);
    expect(isVotable(poll({ status: "draft" }))).toBe(false);
    expect(isVotable(poll({ status: "closed" }))).toBe(false);
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

  it("never lets one person hold two votes, however they click", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1 }), { maxLength: 20 }),
        (clicks) => {
          let state = withPoll(poll());

          clicks.forEach((optionIndex) => {
            state = reducePolls(
              state,
              { kind: "poll_vote", pollId: "poll1", optionIndex },
              fromParticipant(A),
            );
          });

          expect(totalVotes(state.polls[0] ?? poll())).toBeLessThanOrEqual(1);
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

  it("orders polls draft, then live, then closed", () => {
    const sorted = sortPolls([
      poll({ id: "closed", status: "closed", createdAt: 99 }),
      poll({ id: "live", status: "live", createdAt: 50 }),
      poll({ id: "draft", status: "draft", createdAt: 1 }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual([
      "draft",
      "live",
      "closed",
    ]);
  });

  it("puts the newest first within a status", () => {
    const sorted = sortPolls([
      poll({ id: "old", createdAt: 1 }),
      poll({ id: "new", createdAt: 50 }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["new", "old"]);
  });

  it("does not mutate its input", () => {
    const input = [question({ id: "a" }), question({ id: "b" })];
    const snapshot = [...input];

    sortQuestions(input);

    expect(input).toEqual(snapshot);
  });
});

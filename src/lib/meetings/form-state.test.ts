import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  draftSignature,
  initialFormState,
  meetingCreationReducer,
  type CreationDraft,
  type FormState,
} from "@/lib/meetings/form-state";
import type { CreateMeetingInput } from "@/lib/meetings/types";
import type { ValidationOutcome } from "@/lib/meetings/validation";

const REQUEST_ID_A = "0123456789abcdef0123456789abcdef";
const REQUEST_ID_B = "fedcba9876543210fedcba9876543210";

function draftArb(): fc.Arbitrary<CreationDraft> {
  return fc.record({
    title: fc.string(),
    mode: fc.constantFrom("instant" as const, "scheduled" as const),
    startsAtLocal: fc.string(),
    endsAtLocal: fc.string(),
  });
}

function validOutcome(): ValidationOutcome<CreateMeetingInput> {
  return {
    ok: true,
    value: {
      title: "Team sync",
      mode: "instant",
      startsAt: null,
      endsAt: null,
      creationRequestId: "",
    },
  };
}

function invalidOutcome(): ValidationOutcome<CreateMeetingInput> {
  return {
    ok: false,
    fieldErrors: { title: "Enter a meeting title." },
    formMessage: "Please correct the highlighted fields, then try again.",
  };
}

function stateWithDraft(draft: CreationDraft): FormState {
  return { ...initialFormState, draft };
}

function submit(
  state: FormState,
  outcome: ValidationOutcome<CreateMeetingInput>,
  candidateRequestId = REQUEST_ID_A,
): FormState {
  return meetingCreationReducer(state, {
    type: "SUBMIT_REQUESTED",
    validation: outcome,
    signature: draftSignature(state.draft),
    candidateRequestId,
  });
}

describe("draftSignature", () => {
  it("changes whenever any submitted value changes", () => {
    fc.assert(
      fc.property(draftArb(), draftArb(), (first, second) => {
        const identical =
          first.title === second.title &&
          first.mode === second.mode &&
          first.startsAtLocal === second.startsAtLocal &&
          first.endsAtLocal === second.endsAtLocal;

        if (identical) {
          expect(draftSignature(first)).toBe(draftSignature(second));
        } else {
          expect(draftSignature(first)).not.toBe(draftSignature(second));
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("mode changes preserve entered values", () => {
  it("is the identity on the draft across any sequence of mode switches", () => {
    fc.assert(
      fc.property(
        draftArb(),
        fc.array(fc.constantFrom("instant" as const, "scheduled" as const), {
          maxLength: 8,
        }),
        (draft, modes) => {
          let state = stateWithDraft(draft);

          for (const mode of modes) {
            state = meetingCreationReducer(state, { type: "MODE_CHANGED", mode });
          }

          expect(state.draft.title).toBe(draft.title);
          expect(state.draft.startsAtLocal).toBe(draft.startsAtLocal);
          expect(state.draft.endsAtLocal).toBe(draft.endsAtLocal);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("restores schedule values after a scheduled -> instant -> scheduled round trip", () => {
    let state = stateWithDraft({
      title: "Review",
      mode: "scheduled",
      startsAtLocal: "2026-07-01T09:30",
      endsAtLocal: "2026-07-01T10:30",
    });

    state = meetingCreationReducer(state, { type: "MODE_CHANGED", mode: "instant" });
    state = meetingCreationReducer(state, { type: "MODE_CHANGED", mode: "scheduled" });

    expect(state.draft.startsAtLocal).toBe("2026-07-01T09:30");
    expect(state.draft.endsAtLocal).toBe("2026-07-01T10:30");
  });
});

describe("duplicate submit protection", () => {
  it("ignores submits while loading", () => {
    const loading = submit(stateWithDraft(initialFormState.draft), validOutcome());
    expect(loading.status.kind).toBe("loading");

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (times) => {
        let state = loading;
        for (let i = 0; i < times; i += 1) {
          state = submit(state, validOutcome(), REQUEST_ID_B);
        }
        expect(state).toBe(loading);
      }),
      { numRuns: 40 },
    );
  });

  it("ignores submits once a result has committed", () => {
    let state = submit(stateWithDraft(initialFormState.draft), validOutcome());
    state = meetingCreationReducer(state, {
      type: "SERVER_SUCCEEDED",
      result: {
        meetingCode: "abcdefghijklmnopqrstuv",
        title: "Team sync",
        startsAt: null,
        endsAt: null,
      },
    });

    const afterSuccess = state;
    expect(submit(state, validOutcome(), REQUEST_ID_B)).toBe(afterSuccess);
  });
});

describe("Creation_Request_ID lifecycle", () => {
  it("reuses one identifier across retries of unchanged values", () => {
    let state = submit(stateWithDraft(initialFormState.draft), validOutcome());
    const adopted = state.creationRequestId;
    expect(adopted).toBe(REQUEST_ID_A);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      state = meetingCreationReducer(state, {
        type: "SERVER_FAILED",
        failure: {
          kind: "operational",
          message: "Temporary failure",
          correlationId: "abc",
        },
      });
      state = submit(state, validOutcome(), REQUEST_ID_B);
      expect(state.creationRequestId).toBe(adopted);
    }
  });

  it("rotates the identifier once a submitted value changes", () => {
    let state = submit(stateWithDraft(initialFormState.draft), validOutcome());
    expect(state.creationRequestId).toBe(REQUEST_ID_A);

    state = meetingCreationReducer(state, {
      type: "SERVER_FAILED",
      failure: { kind: "operational", message: "x", correlationId: "y" },
    });
    state = meetingCreationReducer(state, {
      type: "FIELD_CHANGED",
      field: "title",
      value: "A different title",
    });
    state = submit(state, validOutcome(), REQUEST_ID_B);

    expect(state.creationRequestId).toBe(REQUEST_ID_B);
  });
});

describe("failure handling", () => {
  it("retains every draft value and never moves focus", () => {
    fc.assert(
      fc.property(draftArb(), (draft) => {
        let state = submit(stateWithDraft(draft), validOutcome());
        state = meetingCreationReducer(state, {
          type: "SERVER_FAILED",
          failure: {
            kind: "validation",
            fieldErrors: { title: "bad" },
            formMessage: "bad",
          },
        });

        expect(state.draft).toEqual(draft);
        expect(state.focusTarget).toBeNull();
        expect(state.status.kind).toBe("error");
      }),
      { numRuns: 150 },
    );
  });

  it("focuses the first invalid control on client-side rejection", () => {
    const state = submit(stateWithDraft(initialFormState.draft), invalidOutcome());
    expect(state.focusTarget).toBe("title");
    expect(state.status.kind).toBe("idle");
  });
});

describe("announcements", () => {
  it("produces a fresh non-empty announcement on each state entry", () => {
    let state = submit(stateWithDraft(initialFormState.draft), validOutcome());
    const loadingAnnouncement = state.announcement;
    expect(loadingAnnouncement.length).toBeGreaterThan(0);

    state = meetingCreationReducer(state, {
      type: "SERVER_SUCCEEDED",
      result: {
        meetingCode: "abcdefghijklmnopqrstuv",
        title: "Team sync",
        startsAt: null,
        endsAt: null,
      },
    });

    expect(state.announcement.length).toBeGreaterThan(0);
    expect(state.announcement).not.toBe(loadingAnnouncement);
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  EMPTY_CAPTIONS_STATE,
  MAX_CAPTION_CHARS,
  MAX_SEGMENTS,
  MAX_SPEAKER_NAME_CHARS,
  newCaptionId,
  parseCaptionsMessage,
  reduceCaptions,
  visibleSegments,
  type CaptionDraft,
  type CaptionSegment,
  type CaptionsMessage,
  type CaptionsState,
} from "@/lib/meetings/caption-state";

const ALICE = "user_alice";
const BOB = "user_bob";

function draft(overrides: Partial<CaptionDraft> = {}): CaptionDraft {
  return {
    id: "utterance1",
    speakerName: "Alice",
    sourceLanguage: "en",
    text: "hello there",
    isFinal: false,
    ...overrides,
  };
}

function caption(
  overrides: Partial<CaptionDraft> = {},
  at = 1000,
): CaptionsMessage {
  return { kind: "caption", caption: draft(overrides), at };
}

function segment(overrides: Partial<CaptionSegment> = {}): CaptionSegment {
  return {
    id: "utterance1",
    speaker: ALICE,
    speakerName: "Alice",
    sourceLanguage: "en",
    text: "hello there",
    isFinal: true,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function stateOf(...segments: CaptionSegment[]): CaptionsState {
  return { segments };
}

describe("reduceCaptions: new segments", () => {
  it("adds a caption attributed to the packet sender", () => {
    const next = reduceCaptions(EMPTY_CAPTIONS_STATE, caption(), ALICE);

    expect(next.segments).toHaveLength(1);
    expect(next.segments[0].speaker).toBe(ALICE);
    expect(next.segments[0].text).toBe("hello there");
  });

  it("ignores an empty recognition result", () => {
    // Recognition fires the moment the mic opens, before any words. An empty
    // bubble flashing up on unmute is worse than nothing.
    const next = reduceCaptions(
      EMPTY_CAPTIONS_STATE,
      caption({ text: "" }),
      ALICE,
    );

    expect(next).toBe(EMPTY_CAPTIONS_STATE);
  });

  it("keeps captions from different speakers separate even on the same id", () => {
    // Ids are minted per client, so two clients can collide. Speaker plus id is
    // what identifies an utterance.
    const first = reduceCaptions(EMPTY_CAPTIONS_STATE, caption(), ALICE);
    const second = reduceCaptions(first, caption({ text: "different" }), BOB);

    expect(second.segments).toHaveLength(2);
  });

  it("orders segments oldest first", () => {
    const first = reduceCaptions(EMPTY_CAPTIONS_STATE, caption({}, 1000), ALICE);
    const second = reduceCaptions(
      first,
      caption({ id: "utterance2", text: "later" }, 2000),
      ALICE,
    );

    expect(second.segments.map((item) => item.text)).toEqual([
      "hello there",
      "later",
    ]);
  });

  it("drops the oldest segment past the window", () => {
    let state = EMPTY_CAPTIONS_STATE;

    for (let index = 0; index < MAX_SEGMENTS + 10; index += 1) {
      state = reduceCaptions(
        state,
        caption({ id: `utterance${index}`, text: `line ${index}` }, index),
        ALICE,
      );
    }

    expect(state.segments).toHaveLength(MAX_SEGMENTS);
    // A two-hour call must not accumulate unbounded state in every tab.
    expect(state.segments[0].text).toBe("line 10");
  });
});

describe("reduceCaptions: interim updates", () => {
  it("replaces the text in place as an utterance grows", () => {
    // This is what keeps a sentence being spoken from stacking up as a dozen
    // half-sentences.
    let state = reduceCaptions(EMPTY_CAPTIONS_STATE, caption({ text: "I" }), ALICE);
    state = reduceCaptions(state, caption({ text: "I will" }), ALICE);
    state = reduceCaptions(state, caption({ text: "I will send it" }), ALICE);

    expect(state.segments).toHaveLength(1);
    expect(state.segments[0].text).toBe("I will send it");
  });

  it("advances updatedAt but preserves createdAt", () => {
    const first = reduceCaptions(
      EMPTY_CAPTIONS_STATE,
      caption({ text: "I" }, 1000),
      ALICE,
    );
    const second = reduceCaptions(
      first,
      caption({ text: "I will" }, 1500),
      ALICE,
    );

    expect(second.segments[0].createdAt).toBe(1000);
    expect(second.segments[0].updatedAt).toBe(1500);
  });

  it("returns the same object when nothing changed", () => {
    // Identity is what lets React skip a re-render.
    const first = reduceCaptions(EMPTY_CAPTIONS_STATE, caption(), ALICE);
    const second = reduceCaptions(first, caption(), ALICE);

    expect(second).toBe(first);
  });

  it("promotes an interim to final", () => {
    const first = reduceCaptions(
      EMPTY_CAPTIONS_STATE,
      caption({ text: "I will send it" }),
      ALICE,
    );
    const second = reduceCaptions(
      first,
      caption({ text: "I will send it today", isFinal: true }),
      ALICE,
    );

    expect(second.segments).toHaveLength(1);
    expect(second.segments[0].isFinal).toBe(true);
    expect(second.segments[0].text).toBe("I will send it today");
  });

  it("treats a final result as terminal", () => {
    // Packets can arrive out of order. A late interim must not reopen and
    // corrupt a sentence already committed.
    const final = reduceCaptions(
      EMPTY_CAPTIONS_STATE,
      caption({ text: "committed", isFinal: true }),
      ALICE,
    );
    const late = reduceCaptions(
      final,
      caption({ text: "stale partial" }),
      ALICE,
    );

    expect(late).toBe(final);
    expect(late.segments[0].text).toBe("committed");
  });

  it("lets a speaker name improve mid-utterance", () => {
    const first = reduceCaptions(
      EMPTY_CAPTIONS_STATE,
      caption({ speakerName: "" }),
      ALICE,
    );
    const second = reduceCaptions(
      first,
      caption({ speakerName: "Alice", text: "hello there now" }),
      ALICE,
    );

    expect(second.segments[0].speakerName).toBe("Alice");
  });

  it("does not blank a known name with a later empty one", () => {
    const first = reduceCaptions(
      EMPTY_CAPTIONS_STATE,
      caption({ speakerName: "Alice" }),
      ALICE,
    );
    const second = reduceCaptions(
      first,
      caption({ speakerName: "", text: "hello there now" }),
      ALICE,
    );

    expect(second.segments[0].speakerName).toBe("Alice");
  });
});

describe("reduceCaptions: caption_stopped", () => {
  it("drops the speaker's uncommitted tail", () => {
    const state = stateOf(
      segment({ id: "a", isFinal: true, text: "said this" }),
      segment({ id: "b", isFinal: false, text: "half a thou" }),
    );

    const next = reduceCaptions(state, { kind: "caption_stopped" }, ALICE);

    expect(next.segments).toHaveLength(1);
    expect(next.segments[0].text).toBe("said this");
  });

  it("keeps finalised sentences, because they were really said", () => {
    const state = stateOf(segment({ isFinal: true }));

    expect(reduceCaptions(state, { kind: "caption_stopped" }, ALICE)).toBe(
      state,
    );
  });

  it("leaves other speakers untouched", () => {
    const state = stateOf(
      segment({ id: "a", speaker: ALICE, isFinal: false }),
      segment({ id: "b", speaker: BOB, isFinal: false }),
    );

    const next = reduceCaptions(state, { kind: "caption_stopped" }, ALICE);

    expect(next.segments).toHaveLength(1);
    expect(next.segments[0].speaker).toBe(BOB);
  });
});

describe("reduceCaptions: snapshot", () => {
  it("accepts a snapshot while empty", () => {
    const incoming = stateOf(segment({ text: "earlier talk" }));

    const next = reduceCaptions(
      EMPTY_CAPTIONS_STATE,
      { kind: "snapshot", state: incoming },
      BOB,
    );

    expect(next.segments).toHaveLength(1);
    expect(next.segments[0].text).toBe("earlier talk");
  });

  it("refuses a snapshot once local state exists", () => {
    // Two clients answering the same request would otherwise each overwrite the
    // other's newer state.
    const existing = stateOf(segment({ text: "mine" }));

    const next = reduceCaptions(
      existing,
      { kind: "snapshot", state: stateOf(segment({ text: "theirs" })) },
      BOB,
    );

    expect(next).toBe(existing);
  });

  it("ignores a snapshot_request, which is answered by the provider", () => {
    expect(
      reduceCaptions(EMPTY_CAPTIONS_STATE, { kind: "snapshot_request" }, BOB),
    ).toBe(EMPTY_CAPTIONS_STATE);
  });
});

describe("parseCaptionsMessage", () => {
  it("accepts a well-formed caption", () => {
    const parsed = parseCaptionsMessage({
      kind: "caption",
      at: 1234,
      caption: {
        id: "u1",
        speakerName: "Alice",
        sourceLanguage: "te",
        text: "రేపు కలుద్దాం",
        isFinal: true,
      },
    });

    expect(parsed).not.toBeNull();

    if (parsed?.kind === "caption") {
      expect(parsed.caption.sourceLanguage).toBe("te");
      expect(parsed.caption.isFinal).toBe(true);
      expect(parsed.at).toBe(1234);
    }
  });

  it("rejects an unsupported source language", () => {
    // Gujarati is a real language the on-device translator cannot serve. A
    // segment tagged with it would render mislabelled and never translate.
    expect(
      parseCaptionsMessage({
        kind: "caption",
        caption: { ...draft(), sourceLanguage: "gu" },
      }),
    ).toBeNull();
  });

  it("rejects a caption with no id", () => {
    expect(
      parseCaptionsMessage({
        kind: "caption",
        caption: { ...draft(), id: "" },
      }),
    ).toBeNull();
  });

  it("rejects malformed envelopes", () => {
    expect(parseCaptionsMessage(null)).toBeNull();
    expect(parseCaptionsMessage("caption")).toBeNull();
    expect(parseCaptionsMessage({})).toBeNull();
    expect(parseCaptionsMessage({ kind: 42 })).toBeNull();
    expect(parseCaptionsMessage({ kind: "unknown_kind" })).toBeNull();
    expect(parseCaptionsMessage({ kind: "caption" })).toBeNull();
  });

  it("accepts the control messages", () => {
    expect(parseCaptionsMessage({ kind: "snapshot_request" })).toEqual({
      kind: "snapshot_request",
    });
    expect(parseCaptionsMessage({ kind: "caption_stopped" })).toEqual({
      kind: "caption_stopped",
    });
  });

  it("caps caption text and collapses whitespace", () => {
    const parsed = parseCaptionsMessage({
      kind: "caption",
      caption: { ...draft(), text: `  a\n\nb  ${"x".repeat(MAX_CAPTION_CHARS)}` },
    });

    if (parsed?.kind === "caption") {
      expect(parsed.caption.text.length).toBe(MAX_CAPTION_CHARS);
      expect(parsed.caption.text.startsWith("a b")).toBe(true);
    }
  });

  it("caps an overlong speaker name", () => {
    const parsed = parseCaptionsMessage({
      kind: "caption",
      caption: { ...draft(), speakerName: "n".repeat(500) },
    });

    if (parsed?.kind === "caption") {
      expect(parsed.caption.speakerName.length).toBe(MAX_SPEAKER_NAME_CHARS);
    }
  });

  it("defaults a missing timestamp rather than rejecting", () => {
    const parsed = parseCaptionsMessage({ kind: "caption", caption: draft() });

    if (parsed?.kind === "caption") {
      expect(Number.isFinite(parsed.at)).toBe(true);
    }
  });

  it("drops unparseable segments from a snapshot but keeps the rest", () => {
    const parsed = parseCaptionsMessage({
      kind: "snapshot",
      state: {
        segments: [
          { ...segment(), sourceLanguage: "gu" },
          segment(),
          "nonsense",
        ],
      },
    });

    if (parsed?.kind === "snapshot") {
      expect(parsed.state.segments).toHaveLength(1);
    }
  });

  it("rejects a snapshot segment with no speaker", () => {
    // Without a speaker the text cannot be attributed, and an unattributable
    // line in a transcript is worse than a missing one.
    const parsed = parseCaptionsMessage({
      kind: "snapshot",
      state: { segments: [{ ...segment(), speaker: "" }] },
    });

    if (parsed?.kind === "snapshot") {
      expect(parsed.state.segments).toHaveLength(0);
    }
  });

  it("caps a snapshot to the window", () => {
    const segments = Array.from({ length: MAX_SEGMENTS + 25 }, (_value, index) =>
      segment({ id: `u${index}` }),
    );

    const parsed = parseCaptionsMessage({
      kind: "snapshot",
      state: { segments },
    });

    if (parsed?.kind === "snapshot") {
      expect(parsed.state.segments).toHaveLength(MAX_SEGMENTS);
    }
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        parseCaptionsMessage(value);
        return true;
      }),
    );
  });
});

describe("visibleSegments", () => {
  it("returns finalised segments", () => {
    const state = stateOf(segment({ isFinal: true }));

    expect(visibleSegments(state)).toHaveLength(1);
  });

  it("keeps an interim that is the speaker's newest utterance", () => {
    const state = stateOf(
      segment({ id: "a", isFinal: true, createdAt: 1000 }),
      segment({ id: "b", isFinal: false, createdAt: 2000 }),
    );

    expect(visibleSegments(state)).toHaveLength(2);
  });

  it("hides an abandoned interim older than a later final", () => {
    // The recogniser sometimes drops a partial without finalising it. Leaving
    // those on screen makes the transcript read as constant self-interruption.
    const state = stateOf(
      segment({ id: "abandoned", isFinal: false, createdAt: 1000 }),
      segment({ id: "committed", isFinal: true, createdAt: 2000 }),
    );

    const visible = visibleSegments(state);

    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe("committed");
  });

  it("does not let one speaker's final hide another's interim", () => {
    const state = stateOf(
      segment({ id: "a", speaker: BOB, isFinal: false, createdAt: 1000 }),
      segment({ id: "b", speaker: ALICE, isFinal: true, createdAt: 2000 }),
    );

    expect(visibleSegments(state)).toHaveLength(2);
  });
});

describe("newCaptionId", () => {
  it("does not collide across a realistic call", () => {
    const ids = new Set<string>();

    for (let index = 0; index < 2000; index += 1) {
      ids.add(newCaptionId());
    }

    expect(ids.size).toBe(2000);
  });
});

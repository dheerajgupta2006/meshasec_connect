import { describe, expect, it } from "vitest";

import {
  MAX_QUEUE,
  MAX_UTTERANCE_AGE_MS,
  createSpeechController,
  pickVoice,
  readSynthesis,
  type SynthesisLike,
  type UtteranceLike,
  type VoiceLike,
} from "@/lib/translation/speech-synthesis";

function voice(
  lang: string,
  name = lang,
  localService = true,
): VoiceLike {
  return { lang, name, localService };
}

/**
 * A fake synthesiser plus a controllable clock.
 *
 * `finishCurrent()` stands in for the browser firing `onend`, which is what
 * advances the queue, so the tests drive that explicitly rather than waiting.
 */
function harness(
  initialVoices: VoiceLike[] = [voice("ta-IN"), voice("en-US")],
  options: { throwOnSpeak?: boolean } = {},
) {
  let voices = initialVoices;
  let current: UtteranceLike | null = null;
  const spoken: { text: string; lang: string; voice: string | null }[] = [];
  const voicesChanged: (() => void)[] = [];
  let clock = 1000;

  const synthesis: SynthesisLike = {
    speak: (utterance: UtteranceLike) => {
      if (options.throwOnSpeak === true) {
        throw new Error("speak failed");
      }

      current = utterance;
      spoken.push({
        text: utterance.text,
        lang: utterance.lang,
        voice: utterance.voice?.name ?? null,
      });
    },
    cancel: () => {
      current = null;
    },
    getVoices: () => voices,
    addEventListener: (_type, listener) => {
      voicesChanged.push(listener);
    },
    removeEventListener: () => undefined,
    speaking: false,
  };

  return {
    synthesis,
    spoken,
    createUtterance: (text: string): UtteranceLike => ({
      text,
      lang: "",
      voice: null,
      rate: 1,
      pitch: 1,
      volume: 1,
      onend: null,
      onerror: null,
    }),
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    setVoices: (next: VoiceLike[]) => {
      voices = next;
      voicesChanged.forEach((listener) => listener());
    },
    finishCurrent: () => {
      const utterance = current;
      current = null;
      utterance?.onend?.();
    },
    failCurrent: () => {
      const utterance = current;
      current = null;
      utterance?.onerror?.();
    },
  };
}

function controllerFor(fake: ReturnType<typeof harness>) {
  return createSpeechController({
    synthesis: fake.synthesis,
    createUtterance: fake.createUtterance,
    now: fake.now,
  });
}

describe("readSynthesis", () => {
  it("returns null when the globals are absent", () => {
    expect(readSynthesis()).toBeNull();
  });

  it("requires the utterance constructor as well as the synthesiser", () => {
    // `speechSynthesis` alone is useless with nothing to hand it.
    const host = globalThis as { speechSynthesis?: unknown };
    host.speechSynthesis = {
      speak: () => undefined,
      cancel: () => undefined,
      getVoices: () => [],
    };

    try {
      expect(readSynthesis()).toBeNull();
    } finally {
      delete host.speechSynthesis;
    }
  });

  it("accepts a complete pair", () => {
    const host = globalThis as {
      speechSynthesis?: unknown;
      SpeechSynthesisUtterance?: unknown;
    };

    host.speechSynthesis = {
      speak: () => undefined,
      cancel: () => undefined,
      getVoices: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    host.SpeechSynthesisUtterance = class {};

    try {
      expect(readSynthesis()).not.toBeNull();
    } finally {
      delete host.speechSynthesis;
      delete host.SpeechSynthesisUtterance;
    }
  });
});

describe("pickVoice", () => {
  it("matches on the base subtag", () => {
    // A ta-LK voice serves Tamil when no ta-IN one is installed: a regional
    // accent beats silence.
    expect(pickVoice([voice("ta-LK")], "ta-IN")?.lang).toBe("ta-LK");
  });

  it("prefers an exact regional match", () => {
    const chosen = pickVoice([voice("ta-LK"), voice("ta-IN")], "ta-IN");

    expect(chosen?.lang).toBe("ta-IN");
  });

  it("prefers a local voice over a network one", () => {
    // Local starts sooner and survives a bad connection, which matters mid-call.
    const chosen = pickVoice(
      [voice("ta-IN", "remote", false), voice("ta-IN", "local", true)],
      "ta-IN",
    );

    expect(chosen?.name).toBe("local");
  });

  it("falls back to a network voice when that is all there is", () => {
    const chosen = pickVoice([voice("ta-IN", "remote", false)], "ta-IN");

    expect(chosen?.name).toBe("remote");
  });

  it("returns null when nothing matches", () => {
    expect(pickVoice([voice("en-US")], "ta-IN")).toBeNull();
    expect(pickVoice([], "ta-IN")).toBeNull();
  });

  it("ignores case in language tags", () => {
    expect(pickVoice([voice("TA-in")], "ta-IN")).not.toBeNull();
  });
});

describe("unsupported browser", () => {
  it("reports itself unsupported and speaks nothing", () => {
    const controller = createSpeechController({ synthesis: null });

    expect(controller.isSupported()).toBe(false);
    expect(controller.speakableLanguages()).toEqual([]);
    // Must not throw: a call is in progress and this is not worth breaking it.
    expect(() => controller.enqueue("hello", "ta", "alice")).not.toThrow();
    expect(() => controller.stop()).not.toThrow();
  });
});

describe("speakableLanguages", () => {
  it("returns only catalogue languages with an installed voice", () => {
    const fake = harness([voice("ta-IN"), voice("en-US"), voice("de-DE")]);

    expect(controllerFor(fake).speakableLanguages().sort()).toEqual([
      "de",
      "en",
      "ta",
    ]);
  });

  it("excludes a voice outside the catalogue", () => {
    // Gujarati has a voice here but no on-device translator, so offering it would
    // produce a language that can be spoken but never reached.
    const fake = harness([voice("gu-IN")]);

    expect(controllerFor(fake).speakableLanguages()).toEqual([]);
  });

  it("returns nothing when the device has no voices", () => {
    // The realistic Windows case for Tamil and Telugu.
    const fake = harness([]);

    expect(controllerFor(fake).speakableLanguages()).toEqual([]);
  });

  it("picks up voices that arrive after construction", () => {
    // Chrome returns an empty list on first call and populates it later, so a
    // picker built at mount would otherwise show nothing forever.
    const fake = harness([]);
    const controller = controllerFor(fake);

    expect(controller.speakableLanguages()).toEqual([]);

    fake.setVoices([voice("ta-IN")]);

    expect(controller.speakableLanguages()).toEqual(["ta"]);
  });

  it("notifies listeners when the voice list loads", () => {
    const fake = harness([]);
    const controller = controllerFor(fake);
    let notified = 0;

    controller.onVoicesReady(() => {
      notified += 1;
    });

    fake.setVoices([voice("ta-IN")]);

    expect(notified).toBe(1);
  });

  it("stops notifying after unsubscribe", () => {
    const fake = harness([]);
    const controller = controllerFor(fake);
    let notified = 0;

    const unsubscribe = controller.onVoicesReady(() => {
      notified += 1;
    });

    unsubscribe();
    fake.setVoices([voice("ta-IN")]);

    expect(notified).toBe(0);
  });
});

describe("enqueue", () => {
  it("speaks with the matched voice and locale", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("வணக்கம்", "ta", "alice");

    expect(fake.spoken).toEqual([
      { text: "வணக்கம்", lang: "ta-IN", voice: "ta-IN" },
    ]);
  });

  it("drops text in a language with no voice", () => {
    // Quietly: the caller should not have offered it, and throwing mid-call
    // helps nobody.
    const fake = harness([voice("en-US")]);
    const controller = controllerFor(fake);

    controller.enqueue("వణక్కం", "te", "alice");

    expect(fake.spoken).toEqual([]);
  });

  it("ignores blank text", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("   ", "ta", "alice");

    expect(fake.spoken).toEqual([]);
  });

  it("speaks one utterance at a time", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("first", "ta", "alice");
    controller.enqueue("second", "ta", "alice");

    expect(fake.spoken.map((item) => item.text)).toEqual(["first"]);
  });

  it("advances to the next utterance when one ends", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("first", "ta", "alice");
    controller.enqueue("second", "ta", "alice");
    fake.finishCurrent();

    expect(fake.spoken.map((item) => item.text)).toEqual(["first", "second"]);
  });

  it("does not wedge the queue when an utterance fails", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("first", "ta", "alice");
    controller.enqueue("second", "ta", "alice");
    fake.failCurrent();

    expect(fake.spoken.map((item) => item.text)).toEqual(["first", "second"]);
  });

  it("drops the oldest unspoken utterance past the cap", () => {
    // Falling a minute behind is worse than losing a sentence: once replies
    // arrive before questions finish, it has stopped being a conversation.
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("first", "ta", "alice");

    for (let index = 0; index < MAX_QUEUE + 3; index += 1) {
      controller.enqueue(`queued ${index}`, "ta", "alice");
    }

    // Drain fully: each `onend` releases exactly one more utterance.
    for (let index = 0; index < MAX_QUEUE + 4; index += 1) {
      fake.finishCurrent();
    }

    const texts = fake.spoken.map((item) => item.text);

    expect(texts[0]).toBe("first");
    // Only the newest `MAX_QUEUE` survived the cap; the backlog was discarded.
    expect(texts).toHaveLength(1 + MAX_QUEUE);
    expect(texts).toContain(`queued ${MAX_QUEUE + 2}`);
    expect(texts).not.toContain("queued 0");
  });

  it("never interrupts the utterance being spoken", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("speaking now", "ta", "alice");

    for (let index = 0; index < 10; index += 1) {
      controller.enqueue(`later ${index}`, "ta", "alice");
    }

    // Cutting a sentence off mid-word to start another is worse than losing one.
    expect(fake.spoken.map((item) => item.text)).toEqual(["speaking now"]);
  });

  it("skips an utterance that has gone stale", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("current", "ta", "alice");
    controller.enqueue("will go stale", "ta", "alice");

    fake.advance(MAX_UTTERANCE_AGE_MS + 1);
    fake.finishCurrent();

    // A translation of something said long ago is a recap, and speaking it over
    // what is being said now is worse than silence.
    expect(fake.spoken.map((item) => item.text)).toEqual(["current"]);
  });

  it("still speaks an utterance within the age limit", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("current", "ta", "alice");
    controller.enqueue("still fresh", "ta", "alice");

    fake.advance(MAX_UTTERANCE_AGE_MS - 1);
    fake.finishCurrent();

    expect(fake.spoken.map((item) => item.text)).toEqual([
      "current",
      "still fresh",
    ]);
  });

  it("survives a synthesiser that throws", () => {
    const fake = harness([voice("ta-IN")], { throwOnSpeak: true });
    const controller = controllerFor(fake);

    expect(() => controller.enqueue("hello", "ta", "alice")).not.toThrow();
  });
});

describe("events", () => {
  it("reports the speaker when an utterance starts, so it can be ducked", () => {
    const fake = harness();
    const controller = controllerFor(fake);
    const started: string[] = [];

    controller.setEvents({ onStart: (speaker) => started.push(speaker) });
    controller.enqueue("hello", "ta", "alice");

    expect(started).toEqual(["alice"]);
  });

  it("reports idle when the queue drains, so ducking can be released", () => {
    const fake = harness();
    const controller = controllerFor(fake);
    let idle = 0;

    controller.setEvents({ onIdle: () => (idle += 1) });
    controller.enqueue("hello", "ta", "alice");
    fake.finishCurrent();

    expect(idle).toBe(1);
  });
});

describe("stop", () => {
  it("cancels and drops everything queued", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("first", "ta", "alice");
    controller.enqueue("second", "ta", "alice");
    controller.stop();
    fake.finishCurrent();

    expect(fake.spoken.map((item) => item.text)).toEqual(["first"]);
  });

  it("reports idle so ducking is released", () => {
    const fake = harness();
    const controller = controllerFor(fake);
    let idle = 0;

    controller.setEvents({ onIdle: () => (idle += 1) });
    controller.enqueue("hello", "ta", "alice");
    controller.stop();

    expect(idle).toBe(1);
  });

  it("allows speaking again afterwards", () => {
    const fake = harness();
    const controller = controllerFor(fake);

    controller.enqueue("first", "ta", "alice");
    controller.stop();
    controller.enqueue("second", "ta", "alice");

    expect(fake.spoken.map((item) => item.text)).toEqual(["first", "second"]);
  });

  it("is safe to call when nothing is queued", () => {
    const fake = harness();

    expect(() => controllerFor(fake).stop()).not.toThrow();
  });
});

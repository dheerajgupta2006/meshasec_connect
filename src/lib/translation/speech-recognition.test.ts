import { describe, expect, it } from "vitest";

import {
  createDictationController,
  readSpeechRecognitionConstructor,
  type DictationFailure,
  type DictationState,
  type SpeechRecognitionConstructor,
  type SpeechRecognitionLike,
  type SpeechResultEventLike,
} from "@/lib/translation/speech-recognition";

/**
 * A fake recogniser plus a fake clock.
 *
 * Every instance created is recorded, so the tests can assert on restart
 * behaviour, and `run()` drains scheduled callbacks so backoff is exercised
 * without waiting on a real timer.
 */
function harness(options: { throwOnStart?: boolean } = {}) {
  const instances: FakeRecognition[] = [];
  const scheduled: { callback: () => void; delayMs: number }[] = [];

  class FakeRecognition implements SpeechRecognitionLike {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    onresult: ((event: SpeechResultEventLike) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    onstart: (() => void) | null = null;

    started = 0;
    stopped = 0;
    aborted = 0;

    constructor() {
      instances.push(this);
    }

    start(): void {
      this.started += 1;

      if (options.throwOnStart === true) {
        throw new Error("InvalidStateError");
      }

      this.onstart?.();
    }

    stop(): void {
      this.stopped += 1;
    }

    abort(): void {
      this.aborted += 1;
    }
  }

  return {
    Recognition: FakeRecognition as unknown as SpeechRecognitionConstructor,
    instances,
    scheduled,
    schedule: (callback: () => void, delayMs: number) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length - 1;
    },
    cancel: (handle: unknown) => {
      const index = handle as number;

      if (scheduled[index] !== undefined) {
        // Replaced with a no-op rather than spliced, so later handles stay valid.
        scheduled[index] = { callback: () => undefined, delayMs: -1 };
      }
    },
    /** Runs every pending callback once, in order. */
    run: () => {
      const pending = scheduled.splice(0, scheduled.length);
      pending.forEach((entry) => entry.callback());
    },
    latest: () => instances[instances.length - 1],
  };
}

/** Builds a result event of the shape the browser delivers. */
function resultEvent(
  entries: { transcript: string; isFinal: boolean }[],
  resultIndex = 0,
): SpeechResultEventLike {
  const results = entries.map((entry) => ({
    isFinal: entry.isFinal,
    length: 1,
    0: { transcript: entry.transcript },
  }));

  return {
    resultIndex,
    results: Object.assign({ length: results.length }, results),
  } as unknown as SpeechResultEventLike;
}

function collector() {
  const transcripts: { text: string; isFinal: boolean }[] = [];
  const states: DictationState[] = [];
  const failures: DictationFailure[] = [];

  return {
    transcripts,
    states,
    failures,
    handlers: {
      onTranscript: (text: string, isFinal: boolean) =>
        transcripts.push({ text, isFinal }),
      onStateChange: (state: DictationState) => states.push(state),
      onFailure: (failure: DictationFailure) => failures.push(failure),
    },
  };
}

describe("readSpeechRecognitionConstructor", () => {
  it("returns null when neither global exists", () => {
    expect(readSpeechRecognitionConstructor()).toBeNull();
  });

  it("accepts the webkit-prefixed global Chrome ships", () => {
    const host = globalThis as { webkitSpeechRecognition?: unknown };
    host.webkitSpeechRecognition = class {};

    try {
      expect(readSpeechRecognitionConstructor()).not.toBeNull();
    } finally {
      delete host.webkitSpeechRecognition;
    }
  });

  it("prefers the unprefixed global when both exist", () => {
    const host = globalThis as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };

    const standard = class {};
    host.SpeechRecognition = standard;
    host.webkitSpeechRecognition = class {};

    try {
      expect(readSpeechRecognitionConstructor()).toBe(standard);
    } finally {
      delete host.SpeechRecognition;
      delete host.webkitSpeechRecognition;
    }
  });

  it("rejects a non-callable global", () => {
    const host = globalThis as { SpeechRecognition?: unknown };
    host.SpeechRecognition = { not: "a constructor" };

    try {
      expect(readSpeechRecognitionConstructor()).toBeNull();
    } finally {
      delete host.SpeechRecognition;
    }
  });
});

describe("unsupported browser", () => {
  it("reports itself unsupported", () => {
    const controller = createDictationController({ create: null });

    expect(controller.isSupported()).toBe(false);
  });

  it("fails immediately on start rather than silently doing nothing", () => {
    const controller = createDictationController({ create: null });
    const sink = collector();

    controller.start("te-IN", sink.handlers);

    expect(sink.failures).toEqual(["failed"]);
    expect(controller.state()).toBe("failed");
  });
});

describe("start", () => {
  it("configures the recogniser for live captioning", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("te-IN", collector().handlers);

    const instance = fake.latest();

    expect(instance.lang).toBe("te-IN");
    // Continuous so a pause between sentences does not end the stream, interim so
    // text appears while it is still being spoken.
    expect(instance.continuous).toBe(true);
    expect(instance.interimResults).toBe(true);
    expect(instance.maxAlternatives).toBe(1);
    expect(instance.started).toBe(1);
  });

  it("reaches the listening state", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("te-IN", sink.handlers);

    expect(controller.state()).toBe("listening");
    expect(sink.states).toEqual(["starting", "listening"]);
  });

  it("ignores a repeat start in the same language", () => {
    // Restarting here would drop the utterance in progress for no reason.
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("te-IN", collector().handlers);
    controller.start("te-IN", collector().handlers);

    expect(fake.instances).toHaveLength(1);
  });

  it("restarts when the language changes", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("te-IN", collector().handlers);
    controller.start("hi-IN", collector().handlers);

    expect(fake.instances).toHaveLength(2);
    expect(fake.latest().lang).toBe("hi-IN");
    // The previous session is torn down rather than left running in parallel.
    expect(fake.instances[0].aborted).toBe(1);
  });
});

describe("transcripts", () => {
  it("emits interim text as not final", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);
    fake.latest().onresult?.(resultEvent([{ transcript: "I will", isFinal: false }]));

    expect(sink.transcripts).toEqual([{ text: "I will", isFinal: false }]);
  });

  it("emits final text as final", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);
    fake
      .latest()
      .onresult?.(resultEvent([{ transcript: "I will send it", isFinal: true }]));

    expect(sink.transcripts).toEqual([
      { text: "I will send it", isFinal: true },
    ]);
  });

  it("only reads results from resultIndex onward", () => {
    // `results` is cumulative across a session. Reading from zero would repeat
    // every sentence said since the microphone opened.
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);
    fake.latest().onresult?.(
      resultEvent(
        [
          { transcript: "old sentence", isFinal: true },
          { transcript: "new sentence", isFinal: true },
        ],
        1,
      ),
    );

    expect(sink.transcripts).toEqual([
      { text: "new sentence", isFinal: true },
    ]);
  });

  it("ignores a result carrying only whitespace", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);
    fake.latest().onresult?.(resultEvent([{ transcript: "   ", isFinal: false }]));

    expect(sink.transcripts).toEqual([]);
  });

  it("survives a result with no alternatives", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);

    const event = {
      resultIndex: 0,
      results: Object.assign({ length: 1 }, [{ isFinal: false, length: 0 }]),
    } as unknown as SpeechResultEventLike;

    expect(() => fake.latest().onresult?.(event)).not.toThrow();
    expect(sink.transcripts).toEqual([]);
  });
});

describe("automatic restart", () => {
  it("reopens after the recogniser ends on its own", () => {
    // Chrome ends the session after a few seconds of silence even in continuous
    // mode, so staying live means reopening.
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("en-IN", collector().handlers);
    fake.latest().onend?.();

    expect(controller.state()).toBe("starting");

    fake.run();

    expect(fake.instances).toHaveLength(2);
    expect(controller.state()).toBe("listening");
  });

  it("does not reopen after an explicit stop", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("en-IN", collector().handlers);
    controller.stop();
    fake.run();

    expect(fake.instances).toHaveLength(1);
    expect(controller.state()).toBe("idle");
  });

  it("does not treat teardown as an unexpected end", () => {
    // `abort` fires `end` synchronously. If the handler were still attached it
    // would read that as a dropped session and schedule a restart.
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("en-IN", collector().handlers);
    controller.stop();

    expect(fake.instances[0].onend).toBeNull();
  });
});

describe("error handling", () => {
  it("stops permanently when the microphone is refused", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);
    fake.latest().onerror?.({ error: "not-allowed" });
    fake.run();

    expect(sink.failures).toEqual(["denied"]);
    expect(controller.state()).toBe("failed");
    // Retrying a refused permission would just spam the user.
    expect(fake.instances).toHaveLength(1);
  });

  it("stops permanently when there is no microphone", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);
    fake.latest().onerror?.({ error: "audio-capture" });

    expect(sink.failures).toEqual(["no-microphone"]);
  });

  it("treats silence as routine, not a failure", () => {
    // "no-speech" fires constantly on a quiet call. Surfacing it would make the
    // feature look broken every time someone stopped talking.
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);
    fake.latest().onerror?.({ error: "no-speech" });

    expect(sink.failures).toEqual([]);
    expect(controller.state()).toBe("listening");
  });

  it("treats a self-inflicted abort as routine", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);
    fake.latest().onerror?.({ error: "aborted" });

    expect(sink.failures).toEqual([]);
  });

  it("backs off further on each repeated network error", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("en-IN", collector().handlers);

    const delays: number[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      fake.latest().onerror?.({ error: "network" });
      const pending = fake.scheduled[fake.scheduled.length - 1];
      delays.push(pending.delayMs);
      fake.run();
    }

    // Widening intervals rather than a tight loop that pins the CPU and hammers
    // the speech endpoint.
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
  });

  it("gives up after repeated network failures", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      fake.latest()?.onerror?.({ error: "network" });
      fake.run();
    }

    expect(sink.failures).toEqual(["network"]);
    expect(controller.state()).toBe("failed");
  });

  it("forgives past failures once speech is recognised", () => {
    // Recognised text proves the pipeline works end to end, so an earlier wobble
    // should not count toward giving up.
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      fake.latest()?.onerror?.({ error: "network" });
      fake.run();
    }

    fake.latest().onresult?.(resultEvent([{ transcript: "hello", isFinal: true }]));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      fake.latest()?.onerror?.({ error: "network" });
      fake.run();
    }

    expect(sink.failures).toEqual([]);
  });

  it("retries rather than surfacing a double-start error", () => {
    // `start` throws InvalidStateError when a session is already running, which
    // is a race rather than something the user can act on.
    const fake = harness({ throwOnStart: true });
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    const sink = collector();

    controller.start("en-IN", sink.handlers);

    expect(sink.failures).toEqual([]);
    expect(fake.scheduled.length).toBeGreaterThan(0);
  });
});

describe("stop", () => {
  it("is safe to call when never started", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    expect(() => controller.stop()).not.toThrow();
    expect(controller.state()).toBe("idle");
  });

  it("is safe to call twice", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("en-IN", collector().handlers);
    controller.stop();

    expect(() => controller.stop()).not.toThrow();
  });

  it("cancels a restart already scheduled", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("en-IN", collector().handlers);
    fake.latest().onend?.();
    controller.stop();
    fake.run();

    expect(fake.instances).toHaveLength(1);
  });

  it("allows starting again afterwards", () => {
    const fake = harness();
    const controller = createDictationController({
      create: fake.Recognition,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    controller.start("en-IN", collector().handlers);
    controller.stop();
    controller.start("en-IN", collector().handlers);

    expect(fake.instances).toHaveLength(2);
    expect(controller.state()).toBe("listening");
  });
});

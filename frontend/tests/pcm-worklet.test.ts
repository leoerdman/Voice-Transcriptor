import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * The capture worklet, exercised outside an AudioWorkletGlobalScope.
 *
 * ``src/pcm-worklet.js`` is loaded raw by the browser into a scope that
 * has no modules, so it can neither import nor export: the file defines
 * a class and hands it to ``registerProcessor``. That is exactly enough
 * to test it — evaluating the source in a ``vm`` context whose globals
 * are the four the file uses (``AudioWorkletProcessor``,
 * ``registerProcessor``, ``sampleRate``, ``currentTime``) hands back the
 * real processor class, with its real ring buffer and its real message
 * handling. No copy of the arithmetic lives in this file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKLET_SOURCE = readFileSync(resolve(HERE, "../src/pcm-worklet.js"), "utf8");

interface PostedMessage {
  type?: string;
  token?: string;
  samples?: Float32Array;
  sampleRate?: number;
  lastWriteTime?: number;
  /** ``{type:"signal"}``: the held device stopped, or resumed, delivering. */
  silent?: boolean;
}

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][]): boolean;
  maxPendingSamples: number;
}

interface Harness {
  processor: Processor;
  /** Everything the processor has posted to the main thread, in order. */
  posted: Array<Float32Array | PostedMessage>;
  /** Send a control message the way the renderer's port would. */
  send(message: unknown): void;
  /** Render one quantum of audio into the processor. */
  render(samples: Float32Array): void;
  /** Move the AudioContext clock forward, in seconds. */
  advance(seconds: number): void;
  now(): number;
}

const SAMPLE_RATE = 48_000;
const QUANTUM = 128;

function createHarness(): Harness {
  const posted: Array<Float32Array | PostedMessage> = [];
  let clock = 0;
  const port: FakePort = {
    onmessage: null,
    postMessage(message: unknown) {
      posted.push(message as Float32Array | PostedMessage);
    },
  };
  class FakeAudioWorkletProcessor {
    port = port;
  }
  let registered: (new () => Processor) | null = null;
  const sandbox = {
    // The vm realm gets THIS realm's typed-array constructor, so a
    // Float32Array the processor builds is the same class the assertions
    // (and, in the browser, the renderer's ``instanceof`` check on the
    // capture path) test against.
    Float32Array,
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (_name: string, cls: new () => Processor) => {
      registered = cls;
    },
    sampleRate: SAMPLE_RATE,
    // ``currentTime`` is a live getter in the real scope, so it is one
    // here too — the processor reads it whenever it writes to the ring.
    get currentTime() {
      return clock;
    },
  };
  const context = createContext(sandbox);
  runInContext(WORKLET_SOURCE, context);
  if (!registered) throw new Error("pcm-worklet.js did not register a processor");
  const processor = new (registered as new () => Processor)();
  return {
    processor,
    posted,
    send(message: unknown) {
      port.onmessage?.({ data: message });
    },
    render(samples: Float32Array) {
      processor.process([[samples]]);
    },
    advance(seconds: number) {
      clock += seconds;
    },
    now() {
      return clock;
    },
  };
}

/** A quantum whose samples are a known ramp, so order is verifiable. */
function ramp(from: number, count = QUANTUM): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = from + i;
  return out;
}

function renderRamp(h: Harness, from: number, quanta = 1): number {
  let next = from;
  for (let i = 0; i < quanta; i++) {
    h.render(ramp(next));
    h.advance(QUANTUM / SAMPLE_RATE);
    next += QUANTUM;
  }
  return next;
}

function frames(h: Harness): Float32Array[] {
  return h.posted.filter((m): m is Float32Array => m instanceof Float32Array);
}

function messages(h: Harness): PostedMessage[] {
  return h.posted.filter((m): m is PostedMessage => !(m instanceof Float32Array));
}

describe("pcm-worklet capture processor", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it("delivers audio from construction, before any control message", () => {
    // A node is only ever constructed to record right now. Waiting for a
    // ``start`` message would drop every quantum captured before that
    // message crossed the thread boundary.
    renderRamp(h, 0, 4);
    expect(frames(h).length).toBe(1);
    expect(frames(h)[0].length).toBe(512);
  });

  it("batches at the reduced 512-sample threshold", () => {
    expect(h.processor.maxPendingSamples).toBe(512);
    renderRamp(h, 0, 3);
    expect(frames(h).length).toBe(0);
    renderRamp(h, 3 * QUANTUM, 1);
    expect(frames(h).length).toBe(1);
  });

  it("posts nothing at all while armed", () => {
    h.send({ type: "arm", preRollMs: 500 });
    renderRamp(h, 0, 200);
    expect(frames(h).length).toBe(0);
  });

  it("flushes the outgoing batch as it arms — those samples belong to the recording that is ending", () => {
    renderRamp(h, 0, 2);
    expect(frames(h).length).toBe(0);
    h.send({ type: "arm", preRollMs: 500 });
    expect(frames(h).length).toBe(1);
    expect(frames(h)[0].length).toBe(2 * QUANTUM);
  });

  it("hands the ring over on start, oldest sample first, before any live frame", () => {
    h.send({ type: "arm", preRollMs: 500 });
    // Fill the ring well past its capacity so wrap-around is exercised:
    // 500 ms at 48 kHz is 24000 samples, i.e. 187.5 quanta.
    const next = renderRamp(h, 0, 300);
    h.send({ type: "start" });
    const preRoll = messages(h).find((m) => m.type === "pre-roll");
    expect(preRoll).toBeTruthy();
    expect(preRoll?.sampleRate).toBe(SAMPLE_RATE);
    expect(preRoll?.samples?.length).toBe(24_000);
    // The ring holds the LAST 24000 samples of the ramp, in order.
    const written = 300 * QUANTUM;
    expect(preRoll?.samples?.[0]).toBe(written - 24_000);
    expect(preRoll?.samples?.[23_999]).toBe(written - 1);
    // And it is the first thing posted — a live frame cannot precede it.
    expect(h.posted[0]).toBe(preRoll);
    // Delivery resumes for the audio that follows.
    renderRamp(h, next, 4);
    expect(frames(h).length).toBe(1);
    expect(frames(h)[0][0]).toBe(written);
  });

  it("dates the ring by the clock at its last write, not by the start", () => {
    h.send({ type: "arm", preRollMs: 500 });
    renderRamp(h, 0, 9);
    // The clock as the tenth quantum is rendered — the moment the ring
    // last received a sample.
    const lastWrite = h.now();
    h.render(ramp(9 * QUANTUM));
    // The context stopped rendering for a minute (a slept machine); the
    // renderer's staleness check is what catches it, and this is the
    // fact the worklet contributes to it.
    h.advance(60);
    h.send({ type: "start" });
    const preRoll = messages(h).find((m) => m.type === "pre-roll");
    expect(preRoll?.lastWriteTime).toBeCloseTo(lastWrite, 9);
  });

  it("keeps only the last preRollMs of audio", () => {
    h.send({ type: "arm", preRollMs: 100 });
    renderRamp(h, 0, 300);
    h.send({ type: "start" });
    const preRoll = messages(h).find((m) => m.type === "pre-roll");
    expect(preRoll?.samples?.length).toBe(4_800);
  });

  it("reports a ring that never filled at its true length", () => {
    h.send({ type: "arm", preRollMs: 500 });
    renderRamp(h, 0, 3);
    h.send({ type: "start" });
    const preRoll = messages(h).find((m) => m.type === "pre-roll");
    expect(preRoll?.samples?.length).toBe(3 * QUANTUM);
    expect(preRoll?.samples?.[0]).toBe(0);
  });

  it("sends no pre-roll message when the ring is empty or disabled", () => {
    h.send({ type: "arm", preRollMs: 0 });
    renderRamp(h, 0, 100);
    h.send({ type: "start" });
    expect(messages(h).some((m) => m.type === "pre-roll")).toBe(false);
    // And the node is delivering again.
    renderRamp(h, 100 * QUANTUM, 4);
    expect(frames(h).length).toBe(1);
  });

  it("starts a second recording with a ring that holds only the second idle window", () => {
    // Arm → idle → start → record → arm again: the ring must not still
    // be carrying audio from before the first recording.
    h.send({ type: "arm", preRollMs: 500 });
    renderRamp(h, 0, 300);
    h.send({ type: "start" });
    const firstRing = messages(h).find((m) => m.type === "pre-roll");
    expect(firstRing?.samples?.length).toBe(24_000);
    renderRamp(h, 300 * QUANTUM, 4);
    h.send({ type: "arm", preRollMs: 500 });
    const marker = 1_000_000;
    h.render(ramp(marker));
    h.send({ type: "start" });
    const secondRing = messages(h).filter((m) => m.type === "pre-roll")[1];
    expect(secondRing?.samples?.length).toBe(QUANTUM);
    expect(secondRing?.samples?.[0]).toBe(marker);
  });

  it("acknowledges a flush after the frames it flushed", () => {
    renderRamp(h, 0, 2);
    h.send({ type: "flush", token: "t-1" });
    const posted = h.posted;
    expect(posted.length).toBe(2);
    expect(posted[0]).toBeInstanceOf(Float32Array);
    expect((posted[1] as PostedMessage).type).toBe("flush-ack");
    expect((posted[1] as PostedMessage).token).toBe("t-1");
  });

  it("ignores control messages that are not objects", () => {
    expect(() => h.send(null)).not.toThrow();
    expect(() => h.send("start")).not.toThrow();
    expect(h.posted.length).toBe(0);
  });
});

/**
 * A held device that stops delivering — the case a "live" MediaStreamTrack
 * cannot report and a held graph must not carry into a recording.
 */
describe("the armed ring's device watch", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  const QUANTA_PER_SECOND = SAMPLE_RATE / QUANTUM;

  function signals(h: Harness): PostedMessage[] {
    return messages(h).filter((m) => m.type === "signal");
  }

  function renderSilence(h: Harness, seconds: number): void {
    const quanta = Math.round(seconds * QUANTA_PER_SECOND);
    for (let i = 0; i < quanta; i++) {
      h.render(new Float32Array(QUANTUM));
      h.advance(QUANTUM / SAMPLE_RATE);
    }
  }

  it("says nothing while the device keeps delivering, however quiet the room", () => {
    h.send({ type: "arm", preRollMs: 500 });
    // A real input carries its own noise floor; a ramp stands for it.
    renderRamp(h, 0.001, 50);
    expect(signals(h)).toEqual([]);
  });

  it("reports silence once, after a second of digital zeros, and never twice", () => {
    h.send({ type: "arm", preRollMs: 500 });
    renderRamp(h, 0, 4);
    renderSilence(h, 0.9);
    // A device wake-up is ~100 ms of the same zeros (see the cold-start
    // log line "microphone woke"), so the window must be longer than that.
    expect(signals(h)).toEqual([]);
    renderSilence(h, 0.3);
    expect(signals(h)).toEqual([{ type: "signal", silent: true }]);
    renderSilence(h, 2);
    expect(signals(h)).toEqual([{ type: "signal", silent: true }]);
  });

  it("clears the report when audio comes back, and can report the next gap", () => {
    h.send({ type: "arm", preRollMs: 500 });
    renderSilence(h, 1.2);
    renderRamp(h, 0.5, 2);
    expect(signals(h).map((m) => m.silent)).toEqual([true, false]);
    renderSilence(h, 1.2);
    expect(signals(h).map((m) => m.silent)).toEqual([true, false, true]);
  });

  it("counts a quantum with no channel at all as silence", () => {
    h.send({ type: "arm", preRollMs: 500 });
    for (let i = 0; i < QUANTA_PER_SECOND * 1.2; i++) {
      h.processor.process([]);
      h.advance(QUANTUM / SAMPLE_RATE);
    }
    expect(signals(h)).toEqual([{ type: "signal", silent: true }]);
  });

  it("starts a new hold unjudged", () => {
    h.send({ type: "arm", preRollMs: 500 });
    renderSilence(h, 1.2);
    h.send({ type: "start" });
    h.send({ type: "arm", preRollMs: 500 });
    renderSilence(h, 0.5);
    // Nothing new: the second hold has been silent for half a second only.
    expect(signals(h)).toEqual([{ type: "signal", silent: true }]);
  });

  it("stays quiet during a recording: those zeros are the user's own", () => {
    // Not armed: the processor is delivering, and silence is a fact for
    // the mic-health path, not for a hold that does not exist.
    renderSilence(h, 3);
    expect(signals(h)).toEqual([]);
  });
});

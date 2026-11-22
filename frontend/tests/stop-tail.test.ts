import { describe, expect, it } from "vitest";

import { createCaptureLevel, observeCaptureFrame } from "../src/audio-levels";
import { recordingCueLengthMs } from "../src/recording-cues";
import { StopTailWait, VoiceTimeline, decideStopTail, type StopTailConfig } from "../src/stop-tail";

const CONFIG: StopTailConfig = {
  minMs: 120,
  maxMs: 600,
  quietEndMs: 160,
  speechRunMs: 100,
  speechGapMs: 40,
  toneMarginMs: 60,
  graceMs: 100,
};
const FRAME_MS = 10;
/** The stop tone the renderer actually plays: 90 ms plus its 10 ms release. */
const TONE_MS = recordingCueLengthMs("stop");

/** A take whose audio is described one 10 ms frame at a time. */
function take(spec: (atMs: number) => boolean, untilMs: number, timeline = new VoiceTimeline()): VoiceTimeline {
  for (let at = timeline.heardMs; at < untilMs; at += FRAME_MS) timeline.push(FRAME_MS, spec(at));
  return timeline;
}

const STOP = 1_000;

describe("stop tone length", () => {
  it("is the stop cue's whole oscillator run", () => {
    expect(TONE_MS).toBeCloseTo(100, 6);
  });
});

describe("decideStopTail", () => {
  it("waits for the minimum tail before deciding anything", () => {
    const timeline = take(() => false, STOP + 110);
    expect(decideStopTail(timeline, STOP, TONE_MS, CONFIG)).toEqual({ kind: "waiting", boundMs: 120, growing: false });
  });

  it("stops at the minimum when the user had already gone quiet", () => {
    const timeline = take((at) => at < STOP - 200, STOP + 120);
    expect(decideStopTail(timeline, STOP, TONE_MS, CONFIG)).toEqual({ kind: "through", tailMs: 120, reason: "quiet-at-min" });
  });

  it("never takes the stop tone for speech", () => {
    // Silence before the press; the microphone hears the tone (and its
    // latency) from the press until 160 ms after it.
    const tone = (at: number): boolean => at >= STOP && at < STOP + TONE_MS + CONFIG.toneMarginMs;
    const timeline = take(tone, STOP + 120);
    // Up to the minimum the tone looks like speech, so the rule waits to
    // see speech carry on after it...
    expect(decideStopTail(timeline, STOP, TONE_MS, CONFIG)).toMatchObject({ kind: "waiting", growing: true });
    take(tone, STOP + 300, timeline);
    // ...and there is none: the tail stays at the minimum.
    expect(decideStopTail(timeline, STOP, TONE_MS, CONFIG)).toEqual({
      kind: "through",
      tailMs: 120,
      reason: "speech-not-sustained",
    });
  });

  it("keeps a last word that is still sounding at the press until it is over", () => {
    // Speech until 350 ms past the press, then silence.
    const speech = (at: number): boolean => at < STOP + 350;
    const timeline = take(speech, STOP + 400);
    expect(decideStopTail(timeline, STOP, TONE_MS, CONFIG)).toMatchObject({ kind: "waiting", growing: true });
    take(speech, STOP + 510, timeline);
    expect(decideStopTail(timeline, STOP, TONE_MS, CONFIG)).toEqual({
      kind: "through",
      tailMs: 350 + 160,
      reason: "quiet-after-speech",
    });
  });

  it("bridges the gaps between syllables", () => {
    // 80 ms syllables with 20 ms gaps, through 400 ms past the press.
    const syllables = (at: number): boolean => at < STOP + 400 && (at - STOP + 10_000) % 100 < 80;
    const timeline = take(syllables, STOP + 600);
    const state = decideStopTail(timeline, STOP, TONE_MS, CONFIG);
    expect(state.kind).toBe("through");
    if (state.kind === "through") {
      expect(state.reason).toBe("quiet-after-speech");
      expect(state.tailMs).toBeGreaterThanOrEqual(400);
    }
  });

  it("is capped when the user keeps talking", () => {
    const timeline = take(() => true, STOP + 600);
    expect(decideStopTail(timeline, STOP, TONE_MS, CONFIG)).toEqual({ kind: "through", tailMs: 600, reason: "capped" });
  });

  it("without a tone, speech is judged from the minimum on", () => {
    const speech = (at: number): boolean => at < STOP + 200;
    const timeline = take(speech, STOP + 400);
    expect(decideStopTail(timeline, STOP, 0, CONFIG)).toEqual({
      kind: "through",
      tailMs: 200 + 160,
      reason: "quiet-after-speech",
    });
  });

  it("a short click at the press is not speech", () => {
    // 40 ms of energy right before the press: shorter than a speech run.
    const click = (at: number): boolean => at >= STOP - 40 && at < STOP;
    const timeline = take(click, STOP + 120);
    expect(decideStopTail(timeline, STOP, 0, CONFIG)).toEqual({ kind: "through", tailMs: 120, reason: "quiet-at-min" });
  });

  it("judges a burst of frames by the audio in it, not by its arrival", () => {
    // One 300 ms block (a ScriptProcessor-sized delivery) of speech then
    // quiet arrives at once.
    const timeline = take(() => true, STOP);
    timeline.push(300, true);
    timeline.push(200, false);
    expect(decideStopTail(timeline, STOP, TONE_MS, CONFIG)).toEqual({
      kind: "through",
      tailMs: 300 + 160,
      reason: "quiet-after-speech",
    });
  });
});

describe("VoiceTimeline", () => {
  it("keeps only recent history but still counts all audio heard", () => {
    const timeline = new VoiceTimeline(100);
    take(() => true, 1_000, timeline);
    expect(timeline.heardMs).toBe(1_000);
    // Older speech has been dropped: a run of 100 ms is still visible,
    // anything that needs more than the history is not.
    expect(timeline.talkingUntil(1_000, Number.NEGATIVE_INFINITY, CONFIG)).toBe(true);
    expect(timeline.talkingUntil(1_000, Number.NEGATIVE_INFINITY, { ...CONFIG, speechRunMs: 200 })).toBe(false);
  });

  it("ignores frames with no duration", () => {
    const timeline = new VoiceTimeline();
    timeline.push(0, true);
    timeline.push(Number.NaN, true);
    expect(timeline.heardMs).toBe(0);
  });
});

describe("StopTailWait", () => {
  it("ends at the minimum (plus grace) when the capture stops delivering", () => {
    const timeline = take(() => true, STOP);
    const wait = new StopTailWait(timeline, STOP, 0, TONE_MS, 5_000, CONFIG);
    expect(wait.poll(5_000)).toBeNull();
    expect(wait.poll(5_219)).toBeNull();
    expect(wait.poll(5_220)).toEqual({ tailMs: 120, latencyMs: 0, reason: "timeout" });
  });

  it("a growing tail waits up to the maximum (plus grace)", () => {
    const timeline = take(() => true, STOP + 300);
    const wait = new StopTailWait(timeline, STOP, 0, TONE_MS, 0, CONFIG);
    expect(wait.poll(300)).toBeNull();
    expect(wait.poll(699)).toBeNull();
    expect(wait.poll(700)).toEqual({ tailMs: 600, latencyMs: 0, reason: "timeout" });
  });

  it("answers as soon as the audio decides, whatever the clock", () => {
    const timeline = take((at) => at < STOP - 300, STOP + 120);
    const wait = new StopTailWait(timeline, STOP, 0, TONE_MS, 0, CONFIG);
    expect(wait.poll(0)).toEqual({ tailMs: 120, latencyMs: 0, reason: "quiet-at-min" });
  });

  it("names the deadlines at which it is certain to answer", () => {
    const wait = new StopTailWait(new VoiceTimeline(), 0, 0, TONE_MS, 1_000, CONFIG);
    expect(wait.deadlines()).toEqual([1_220, 1_700]);
    expect(wait.poll(1_700)).not.toBeNull();
  });
});

describe("StopTailWait on an input with latency", () => {
  /** Liberty 5 BT: the 300 ms Bluetooth floor plus one ~11 ms worklet batch. */
  const LATENCY = 311;

  it("counts the tail from the press as placed in the audio", () => {
    // Quiet throughout: the minimum is kept past the press's place in the
    // audio, which is LATENCY past what had been delivered.
    const timeline = take(() => false, STOP + LATENCY + 110);
    const wait = new StopTailWait(timeline, STOP, LATENCY, TONE_MS, 0, CONFIG);
    expect(wait.poll(0)).toBeNull();
    take(() => false, STOP + LATENCY + 120, timeline);
    expect(wait.poll(0)).toEqual({ tailMs: 120, latencyMs: LATENCY, reason: "quiet-at-min" });
  });

  it("waits out the latency on the wall clock before giving up on the audio", () => {
    const timeline = take(() => false, STOP);
    const wait = new StopTailWait(timeline, STOP, LATENCY, TONE_MS, 5_000, CONFIG);
    expect(wait.deadlines()).toEqual([5_000 + LATENCY + 220, 5_000 + LATENCY + 700]);
    expect(wait.poll(5_000 + LATENCY + 219)).toBeNull();
    expect(wait.poll(5_000 + LATENCY + 220)).toEqual({ tailMs: 120, latencyMs: LATENCY, reason: "timeout" });
  });

  it("ignores a latency that is not a positive number", () => {
    const timeline = take(() => false, STOP + 120);
    for (const latency of [Number.NaN, -50, 0]) {
      const wait = new StopTailWait(timeline, STOP, latency, TONE_MS, 0, CONFIG);
      expect(wait.poll(0)).toEqual({ tailMs: 120, latencyMs: 0, reason: "quiet-at-min" });
    }
  });
});

describe("the last word on a Bluetooth headset (2026-11-22 20:00:19, take 030022)", () => {
  // The take ended on a word just starting: its last 100 ms rise from the
  // headset's floor (RMS 0.004) to 0.022. Spoken right before the press,
  // that word was still crossing the HFP link when the press landed. In
  // delivered audio: the previous word ends 100 ms before the press, a
  // 150 ms pause, then the last word from +50 ms to +300 ms.
  const lastWord = (at: number): boolean => at < STOP - 100 || (at >= STOP + 50 && at < STOP + 300);

  it("was cut at the delivered position: 70 ms of the word is not a speech run", () => {
    const timeline = take(lastWord, STOP + 120);
    const wait = new StopTailWait(timeline, STOP, 0, TONE_MS, 0, CONFIG);
    // The capture froze 120 ms past the delivered position, inside the word.
    expect(wait.poll(0)).toEqual({ tailMs: 120, latencyMs: 0, reason: "quiet-at-min" });
  });

  it("is kept whole once the press is placed by the headset's latency", () => {
    const latency = 311;
    const timeline = take(lastWord, STOP + 120);
    const wait = new StopTailWait(timeline, STOP, latency, TONE_MS, 0, CONFIG);
    // Not decided at the old point: the press's audio has not arrived.
    expect(wait.poll(0)).toBeNull();
    take(lastWord, STOP + latency + 120, timeline);
    const outcome = wait.poll(0);
    expect(outcome).not.toBeNull();
    // Audio kept past the delivered position covers the whole word.
    expect(outcome!.latencyMs + outcome!.tailMs).toBeGreaterThanOrEqual(300);
  });
});

describe("a cold take's stop on a quiet room (2026-11-22 19:10:59)", () => {
  // The take's 20 ms frames (RMS, thousandths): digital zero, the ramp-in
  // frame, the room at ~0.0055 and two key thumps after the press at
  // 0.46 s. The installed 1.6.24 seeded the floor from the zero frame,
  // took every frame for speech and held the microphone to the 600 ms cap.
  const RMS_MILLI = [
    0.0, 0.6, 3.1, 4.6, 7.3, 5.1, 6.5, 4.4, 5.4, 4.6, 5.3, 5.5, 5.6, 5.2, 5.6, 5.0, 6.4, 5.2, 5.6, 5.5, 5.6, 4.7,
    5.6, 5.2, 6.0, 41.5, 24.6, 22.2, 8.0, 6.3, 5.0, 5.7, 5.7, 5.6, 6.2, 17.1, 43.0, 21.2, 13.1, 6.6, 5.3, 5.8,
    5.4, 6.1, 5.9, 5.6, 5.4, 5.5, 5.1, 5.5, 5.6, 6.7, 6.1, 4.5,
  ];

  it("ends at the minimum tail: the thumps are not sustained speech", () => {
    const level = createCaptureLevel();
    const timeline = new VoiceTimeline();
    for (const m of RMS_MILLI) timeline.push(20, observeCaptureFrame(level, m / 1000, (m / 1000) * 3, 20));
    const state = decideStopTail(timeline, 460, TONE_MS, CONFIG);
    expect(state.kind).toBe("through");
    if (state.kind === "through") {
      expect(state.reason).not.toBe("capped");
      expect(state.tailMs).toBe(CONFIG.minMs);
    }
  });
});

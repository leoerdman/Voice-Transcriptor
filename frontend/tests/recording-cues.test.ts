import { describe, it, expect } from "vitest";

import { CUE_ATTACK_SEC, RECORDING_CUES, createRecordingCuePlayer } from "../src/recording-cues";

function fakeContext(state: AudioContextState = "running") {
  const calls: string[] = [];
  const param = (name: string) => ({
    setValueAtTime: (v: number, t: number) => calls.push(`${name}.set ${v}@${t}`),
    exponentialRampToValueAtTime: (v: number, t: number) => calls.push(`${name}.ramp ${v}@${t}`),
  });
  const ctx = {
    currentTime: 10,
    state,
    destination: {} as AudioDestinationNode,
    resumed: 0,
    resume() { this.resumed += 1; return Promise.resolve(); },
    createOscillator() {
      return {
        type: "sine",
        frequency: param("freq"),
        connect: () => calls.push("osc.connect"),
        start: (t: number) => calls.push(`osc.start@${t}`),
        stop: (t: number) => calls.push(`osc.stop@${t}`),
      };
    },
    createGain() {
      return { gain: param("gain"), connect: () => calls.push("gain.connect") };
    },
  };
  return { ctx: ctx as unknown as AudioContext & { resumed: number }, calls };
}

describe("recording cues", () => {
  it("start rises and stop falls — the overlay's original tones", () => {
    expect(RECORDING_CUES.start.endHz).toBeGreaterThan(RECORDING_CUES.start.baseHz);
    expect(RECORDING_CUES.stop.endHz).toBeLessThan(RECORDING_CUES.stop.baseHz);
  });

  it("ready is a higher rise than start, so the two tones never read as one", () => {
    expect(RECORDING_CUES.ready.endHz).toBeGreaterThan(RECORDING_CUES.ready.baseHz);
    expect(RECORDING_CUES.ready.baseHz).toBeGreaterThan(RECORDING_CUES.start.endHz);
  });

  it("plays the requested tone through the destination", () => {
    const { ctx, calls } = fakeContext();
    const play = createRecordingCuePlayer(() => ctx);
    play("start");
    expect(calls).toContain(`freq.set ${RECORDING_CUES.start.baseHz}@10`);
    expect(calls).toContain(`freq.ramp ${RECORDING_CUES.start.endHz}@${10 + RECORDING_CUES.start.durationSec}`);
    expect(calls).toContain("osc.start@10");
    expect(calls).toContain("gain.connect");
    calls.length = 0;
    play("stop");
    expect(calls).toContain(`freq.set ${RECORDING_CUES.stop.baseHz}@10`);
    expect(calls).toContain(`gain.ramp ${RECORDING_CUES.stop.gainPeak}@${10 + CUE_ATTACK_SEC}`);
  });

  it("opens one AudioContext for every cue, and only when the first cue plays", () => {
    let created = 0;
    const { ctx } = fakeContext();
    const play = createRecordingCuePlayer(() => { created += 1; return ctx; });
    expect(created).toBe(0);
    play("start");
    play("stop");
    play("start");
    expect(created).toBe(1);
  });

  it("resumes a suspended context and schedules the tone only once it runs", async () => {
    // A suspended context's clock stands still: a tone scheduled on it
    // before the resume lands in the past and is cut or dropped.
    const { ctx, calls } = fakeContext("suspended");
    expect(createRecordingCuePlayer(() => ctx)("start")).toBe("resuming");
    expect(ctx.resumed).toBe(1);
    expect(calls).not.toContain("osc.start@10");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toContain("osc.start@10");
  });

  it("says what it did, for the renderer's log line", () => {
    const { ctx } = fakeContext();
    expect(createRecordingCuePlayer(() => ctx)("start")).toBe("played");
    expect(createRecordingCuePlayer(() => null)("start")).toBe("unavailable");
    expect(createRecordingCuePlayer(() => { throw new Error("no device"); })("stop")).toBe("failed");
  });

  it("never throws: no audio support, or a context that fails", () => {
    expect(() => createRecordingCuePlayer(() => null)("start")).not.toThrow();
    expect(() => createRecordingCuePlayer(() => { throw new Error("no device"); })("stop")).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  BoundedChunkWindow,
  WAV_HEADER_BYTES,
  capturedHoursLabel,
  pcmWavDurationSec,
} from "../src/pcm-capture";

const chunk = (n: number): Int16Array => new Int16Array(n);

describe("BoundedChunkWindow (FG-01)", () => {
  it("keeps everything below the cap", () => {
    const w = new BoundedChunkWindow(100);
    expect(w.push(chunk(40))).toBe(false);
    expect(w.push(chunk(60))).toBe(false);
    expect(w.samples).toBe(100);
    expect(w.droppedSamples).toBe(0);
  });

  it("drops the oldest chunks past the cap and reports it once", () => {
    const w = new BoundedChunkWindow(100);
    w.push(chunk(60));
    expect(w.push(chunk(60))).toBe(true);
    expect(w.samples).toBe(60);
    expect(w.droppedSamples).toBe(60);
    expect(w.push(chunk(60))).toBe(false);
    expect(w.droppedSamples).toBe(120);
  });

  it("never drops the newest chunk, even when it alone exceeds the cap", () => {
    const w = new BoundedChunkWindow(10);
    w.push(chunk(50));
    expect(w.samples).toBe(50);
    expect(w.chunks.length).toBe(1);
  });

  it("bounds the tail a failed disk write puts back, keeping write order", () => {
    // The OPFS sink takes everything for a write; the write fails; the
    // taken chunks go back AHEAD of what arrived meanwhile — and the
    // whole tail stays within the window instead of growing without end.
    const w = new BoundedChunkWindow(100);
    const a = chunk(50);
    const b = chunk(50);
    w.push(a);
    const taken = w.take();
    w.push(b);
    expect(w.restoreHead(taken)).toBe(false);
    expect(w.chunks).toEqual([a, b]);
    for (let i = 0; i < 10; i++) w.push(chunk(50));
    expect(w.samples).toBeLessThanOrEqual(100);
    expect(w.bytes).toBe(w.samples * 2);
  });

  it("take empties the window", () => {
    const w = new BoundedChunkWindow(100);
    w.push(chunk(10));
    expect(w.take().length).toBe(1);
    expect(w.samples).toBe(0);
  });
});

describe("pcmWavDurationSec (FG-18, FG-02)", () => {
  const rate = 16_000;
  const wavBytes = (samples: number): number => WAV_HEADER_BYTES + samples * 2;

  it("is the counter's duration when the file holds every counted sample", () => {
    expect(pcmWavDurationSec(wavBytes(32_000), 32_000, rate)).toBe(2);
  });

  it("is the file's duration when the window dropped samples the counter still counts", () => {
    // Two hours kept out of three captured: the file is the truth.
    expect(pcmWavDurationSec(wavBytes(rate * 7200), rate * 10_800, rate)).toBe(7200);
  });

  it("is zero for a header-only or empty file", () => {
    expect(pcmWavDurationSec(WAV_HEADER_BYTES, 1000, rate)).toBe(0);
    expect(pcmWavDurationSec(0, 1000, rate)).toBe(0);
  });

  it("is zero for an unusable sample rate", () => {
    expect(pcmWavDurationSec(wavBytes(100), 100, 0)).toBe(0);
  });
});

describe("capturedHoursLabel (FG-17)", () => {
  it("names the window the notices quote", () => {
    expect(capturedHoursLabel(60 * 120)).toBe("2 hours");
    expect(capturedHoursLabel(3600)).toBe("1 hour");
    expect(capturedHoursLabel(90 * 60)).toBe("90 minutes");
  });
});

import { describe, it, expect } from "vitest";

import {
  createCaptureLevel,
  observeCaptureFrame,
  summarizeCaptureLevel,
} from "../src/audio-levels";
import { DEAD_PEAK_FLOOR } from "../src/mic-health";

/**
 * A synthetic session: `quietFrames` of room tone, then `speechFrames`
 * of speech with a natural onset and decay, all scaled by `gain`.
 *
 * `gain` is the point of the whole exercise — the SAME utterance
 * recorded 20 dB quieter has to be classified the same way, because the
 * gain the capture stack chose is not evidence about the speaker
 * (BUGS_AUDIT_2026-09-03 §4.3).
 */
function quietThenSpeechRamp(gain: number, quietFrames = 40, speechFrames = 40): Array<{
  rms: number;
  peak: number;
  speech: boolean;
}> {
  const frames: Array<{ rms: number; peak: number; speech: boolean }> = [];
  for (let i = 0; i < quietFrames; i++) {
    // Room tone with a little wobble, ~40 dB below the speech that follows.
    const rms = 0.0004 * gain * (1 + 0.2 * Math.sin(i));
    frames.push({ rms, peak: rms * 3, speech: false });
  }
  for (let i = 0; i < speechFrames; i++) {
    // Ramp in over four frames, hold, ramp out over four.
    const envelope = Math.min(1, (i + 1) / 4, (speechFrames - i) / 4);
    const rms = 0.04 * gain * envelope;
    frames.push({ rms, peak: rms * 4, speech: envelope > 0.5 });
  }
  return frames;
}

function runRamp(gain: number): {
  detected: boolean[];
  expected: boolean[];
  summary: ReturnType<typeof summarizeCaptureLevel>;
} {
  const level = createCaptureLevel();
  const frames = quietThenSpeechRamp(gain);
  const detected = frames.map((f) => observeCaptureFrame(level, f.rms, f.peak));
  return { detected, expected: frames.map((f) => f.speech), summary: summarizeCaptureLevel(level) };
}

describe("capture level SSOT", () => {
  describe("quiet-then-speech ramp", () => {
    it("separates the room from the speech at a normal level", () => {
      const { detected, expected } = runRamp(1);
      expected.forEach((isSpeech, i) => {
        if (isSpeech) expect(detected[i]).toBe(true);
      });
      // No frame of room tone is ever mistaken for speech.
      expect(detected.slice(0, 40).some(Boolean)).toBe(false);
    });

    it("classifies the same utterance the same way 20 dB quieter", () => {
      // The absolute thresholds this replaces (rms >= 0.003) call every
      // frame of this session silence: its loudest speech frame is at
      // 0.004 and its quietest at 0.00004.
      const loud = runRamp(1);
      const quiet = runRamp(0.1);
      expect(quiet.detected).toEqual(loud.detected);
      expect(quiet.summary.carriedSpeech).toBe(true);
    });

    it("classifies the same utterance the same way 20 dB louder", () => {
      expect(runRamp(10).detected).toEqual(runRamp(1).detected);
    });

    it("tracks the session floor down to the room, not to the speech", () => {
      const { summary } = runRamp(1);
      expect(summary.floorRms).toBeLessThan(0.001);
      expect(summary.carriedSpeech).toBe(true);
    });
  });

  describe("sessions that carry nothing", () => {
    it("reports digital silence when the pipeline delivers exact zeros", () => {
      const level = createCaptureLevel();
      for (let i = 0; i < 50; i++) expect(observeCaptureFrame(level, 0, 0)).toBe(false);
      const summary = summarizeCaptureLevel(level);
      expect(summary.digitalSilence).toBe(true);
      expect(summary.carriedSpeech).toBe(false);
    });

    it("does not call a live-but-quiet room digital silence", () => {
      const level = createCaptureLevel();
      for (let i = 0; i < 50; i++) observeCaptureFrame(level, DEAD_PEAK_FLOOR, DEAD_PEAK_FLOOR * 4);
      const summary = summarizeCaptureLevel(level);
      expect(summary.digitalSilence).toBe(false);
      // Steady room tone and nothing else: no speech, at any gain.
      expect(summary.carriedSpeech).toBe(false);
    });

    it("never treats dither above the dead floor as speech", () => {
      const level = createCaptureLevel();
      let anySpeech = false;
      for (let i = 0; i < 200; i++) {
        anySpeech = observeCaptureFrame(level, DEAD_PEAK_FLOOR * (i % 3), DEAD_PEAK_FLOOR * 3) || anySpeech;
      }
      expect(anySpeech).toBe(false);
    });
  });

  describe("short utterances", () => {
    it("finds the speech in a single quiet syllable", () => {
      // 20 frames (~0.8 s): a couple of frames of room, one syllable,
      // a couple of frames of room — recorded at −40 dBFS.
      const level = createCaptureLevel();
      const rms = [0.0002, 0.0002, 0.0006, 0.004, 0.009, 0.010, 0.006, 0.001, 0.0003, 0.0002];
      const detected = rms.map((r) => observeCaptureFrame(level, r, r * 4));
      expect(detected.some(Boolean)).toBe(true);
      expect(summarizeCaptureLevel(level).carriedSpeech).toBe(true);
    });
  });

  describe("session summary", () => {
    it("averages the SQUARES of the per-frame RMS", () => {
      const level = createCaptureLevel();
      observeCaptureFrame(level, 0.1, 0.1);
      observeCaptureFrame(level, 0.3, 0.3);
      expect(summarizeCaptureLevel(level).averageRms).toBeCloseTo(Math.sqrt((0.01 + 0.09) / 2), 12);
      expect(summarizeCaptureLevel(level).peakMax).toBe(0.3);
    });

    it("reports nothing for a session with no frames", () => {
      const summary = summarizeCaptureLevel(createCaptureLevel());
      expect(summary.frames).toBe(0);
      expect(summary.averageRms).toBe(0);
      expect(summary.digitalSilence).toBe(false);
      expect(summary.carriedSpeech).toBe(false);
    });
  });
});

describe("a take that starts cold", () => {
  // 20 ms frames (RMS in thousandths) of the installed 1.6.24's take of
  // 2026-11-22 19:10:59 on the built-in microphone: digital zero, the
  // half-filled ramp-in frame, then the room at ~0.0055 RMS with two key
  // thumps (70-100 Hz) after the stop press at ~0.45 s. Before the fix the
  // floor was seeded by the zero frame and every frame was speech, so the
  // stop tail ran to its 600 ms cap.
  const RMS_MILLI = [
    0.0, 0.6, 3.1, 4.6, 7.3, 5.1, 6.5, 4.4, 5.4, 4.6, 5.3, 5.5, 5.6, 5.2, 5.6, 5.0, 6.4, 5.2, 5.6, 5.5, 5.6, 4.7,
    5.6, 5.2, 6.0, 41.5, 24.6, 22.2, 8.0, 6.3, 5.0, 5.7, 5.7, 5.6, 6.2, 17.1, 43.0, 21.2, 13.1, 6.6, 5.3, 5.8,
    5.4, 6.1, 5.9, 5.6, 5.4, 5.5, 5.1, 5.5, 5.6, 6.7, 6.1, 4.5,
  ];
  const frames = RMS_MILLI.map((m) => ({ rms: m / 1000, peak: (m / 1000) * 3 }));

  it("does not take the room for speech once the floor has found it", () => {
    const level = createCaptureLevel();
    const detected = frames.map((f) => observeCaptureFrame(level, f.rms, f.peak, 20));
    // Room frames once the 500 ms window has the room in it and the floor
    // has climbed to it (index 30+, 600 ms), thumps excluded.
    const roomAfterWindow = detected.filter((_, i) => i >= 30 && RMS_MILLI[i] < 9);
    expect(roomAfterWindow.some(Boolean)).toBe(false);
    // The thumps still stand out.
    expect(detected[25]).toBe(true);
    expect(detected[36]).toBe(true);
    expect(summarizeCaptureLevel(level).floorRms).toBeGreaterThan(0.002);
  });

  it("never seeds the floor from digital silence", () => {
    const level = createCaptureLevel();
    for (let i = 0; i < 3; i++) expect(observeCaptureFrame(level, 0, 0)).toBe(false);
    // The first live frame seeds the floor and is not speech itself.
    expect(observeCaptureFrame(level, 0.005, 0.015)).toBe(false);
    expect(observeCaptureFrame(level, 0.0055, 0.016)).toBe(false);
    expect(observeCaptureFrame(level, 0.05, 0.2)).toBe(true);
  });

  it("climbs from a seed below the room to the room within the recovery window", () => {
    const level = createCaptureLevel();
    observeCaptureFrame(level, 0.0006, 0.002, 20);
    let roomSpeech = 0;
    for (let i = 0; i < 10; i++) if (observeCaptureFrame(level, 0.0055, 0.016, 20)) roomSpeech += 1;
    // Until the window holds 500 ms of the room the low seed stands
    // (what a stuck floor did for the whole take)…
    expect(roomSpeech).toBe(10);
    // …and once the window has the room in it, the floor climbs to it.
    for (let i = 0; i < 40; i++) observeCaptureFrame(level, 0.0055, 0.016, 20);
    expect(observeCaptureFrame(level, 0.0055, 0.016, 20)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEAD_PEAK_FLOOR,
  DEAD_RMS_FLOOR,
  MAX_SAMPLE_GAP_MS,
  MIC_LOST_HELP,
  MIC_MUTED_HELP,
  MIC_SILENT_HELP,
  MicHealthTracker,
  PROBE_TIMEOUT_MS,
  SILENT_CONFIRM_MS,
  describeMicHealth,
  reconcileMicHealthStatus,
  initialSnapshot,
  isDigitalSilence,
  nextMicHealth,
  type MicHealthObservation,
  type MicHealthSnapshot,
  type MicHealthState,
} from "../src/mic-health";

/**
 * Drives the pure FSM over a scripted timeline and returns the state after
 * each observation. The FSM derives elapsed time from ``nowMs`` rather than
 * assuming a cadence, so every scenario states its own clock explicitly.
 */
function run(
  steps: Array<{ atMs: number; obs: MicHealthObservation }>,
  from: MicHealthSnapshot = initialSnapshot(),
): { states: MicHealthState[]; notices: Array<string | null>; last: MicHealthSnapshot } {
  let snap = from;
  const states: MicHealthState[] = [];
  const notices: Array<string | null> = [];
  for (const step of steps) {
    const result = nextMicHealth({ nowMs: step.atMs, last: snap, obs: step.obs });
    snap = result.next;
    states.push(snap.state);
    notices.push(result.notice);
  }
  return { states, notices, last: snap };
}

const silence = { kind: "rms", rms: 0, peak: 0 } as const;
const signal = { kind: "rms", rms: 0.02, peak: 0.2 } as const;

describe("isDigitalSilence", () => {
  it("treats exactly zero as silence", () => {
    expect(isDigitalSilence(0, 0)).toBe(true);
  });

  it("treats one 16-bit LSB of peak as proof the pipeline works", () => {
    expect(isDigitalSilence(0, DEAD_PEAK_FLOOR)).toBe(false);
  });

  it("treats a peak just under the dead floor as silence", () => {
    expect(isDigitalSilence(0, DEAD_PEAK_FLOOR * 0.999)).toBe(true);
  });

  it("accepts rms alone at the rms floor, which is a quarter of the peak floor", () => {
    expect(DEAD_RMS_FLOOR).toBeCloseTo(DEAD_PEAK_FLOOR / 4, 12);
    expect(isDigitalSilence(DEAD_RMS_FLOOR, 0)).toBe(false);
    expect(isDigitalSilence(DEAD_RMS_FLOOR * 0.999, 0)).toBe(true);
  });

  it("does not mistake NaN for signal", () => {
    // ``!(NaN >= x)`` is true, so a NaN sample must read as silence rather
    // than silently proving the microphone works.
    expect(isDigitalSilence(Number.NaN, Number.NaN)).toBe(true);
  });
});

describe("nextMicHealth · session lifecycle", () => {
  it("starts probing and remembers the device that opened the session", () => {
    const result = nextMicHealth({
      nowMs: 1000,
      last: initialSnapshot(),
      obs: { kind: "session-start", deviceId: "dev-7" },
    });
    expect(result.next).toEqual({
      state: "probing",
      detail: "waiting for first samples",
      deviceId: "dev-7",
      silenceMs: 0,
      lastSampleMs: 1000,
    });
    expect(result.notice).toBeNull();
  });

  it("returns to the pristine snapshot on session-stop", () => {
    const { last } = run([
      { atMs: 0, obs: { kind: "session-start", deviceId: "dev-7" } },
      { atMs: 100, obs: signal },
      { atMs: 200, obs: { kind: "session-stop" } },
    ]);
    expect(last).toEqual(initialSnapshot());
  });

  it("ignores hardware events while idle", () => {
    const idle = initialSnapshot();
    for (const obs of [
      { kind: "track-ended" } as const,
      { kind: "stream-error", message: "boom" } as const,
      { kind: "track-muted", muted: true } as const,
    ]) {
      const result = nextMicHealth({ nowMs: 500, last: idle, obs });
      expect(result.next).toEqual(idle);
      expect(result.notice).toBeNull();
    }
  });
});

describe("nextMicHealth · probing → live", () => {
  it("goes live on the first sample above the dead floor", () => {
    const { states, notices } = run([
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
    ]);
    expect(states).toEqual(["probing", "live"]);
    expect(notices[1]).toBeNull();
  });

  it("records why it went live", () => {
    const { last } = run([
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
    ]);
    expect(last.detail).toBe("signal detected");
  });
});

describe("nextMicHealth · probing → silent", () => {
  it("flags the microphone once PROBE_TIMEOUT_MS of digital silence has passed", () => {
    const steps: Array<{ atMs: number; obs: MicHealthObservation }> = [
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
    ];
    // 50 ms cadence keeps every delta under MAX_SAMPLE_GAP_MS.
    for (let t = 50; t <= PROBE_TIMEOUT_MS + 50; t += 50) {
      steps.push({ atMs: t, obs: silence });
    }
    const { states, notices, last } = run(steps);
    expect(states[states.length - 1]).toBe("silent");
    expect(last.detail).toBe(`no samples within ${PROBE_TIMEOUT_MS} ms of start`);
    expect(notices.filter((n) => n === MIC_SILENT_HELP)).toHaveLength(1);
  });

  it("stays probing while the accumulated silence is short of the dwell", () => {
    const steps: Array<{ atMs: number; obs: MicHealthObservation }> = [
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
    ];
    for (let t = 50; t < PROBE_TIMEOUT_MS; t += 50) {
      steps.push({ atMs: t, obs: silence });
    }
    const { last } = run(steps);
    expect(last.state).toBe("probing");
    expect(last.silenceMs).toBeLessThan(PROBE_TIMEOUT_MS);
  });

  it("recovers to live when signal finally arrives after being flagged silent", () => {
    const steps: Array<{ atMs: number; obs: MicHealthObservation }> = [
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
    ];
    for (let t = 50; t <= PROBE_TIMEOUT_MS + 50; t += 50) {
      steps.push({ atMs: t, obs: silence });
    }
    steps.push({ atMs: PROBE_TIMEOUT_MS + 100, obs: signal });
    const { last } = run(steps);
    expect(last.state).toBe("live");
    expect(last.detail).toBe("signal recovered");
  });
});

describe("nextMicHealth · live → silent uses the longer mid-session dwell", () => {
  it("tolerates a pause shorter than SILENT_CONFIRM_MS", () => {
    const steps: Array<{ atMs: number; obs: MicHealthObservation }> = [
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
    ];
    for (let t = 100; t < 50 + SILENT_CONFIRM_MS; t += 50) {
      steps.push({ atMs: t, obs: silence });
    }
    expect(run(steps).last.state).toBe("live");
  });

  it("flags the microphone once SILENT_CONFIRM_MS has accumulated", () => {
    const steps: Array<{ atMs: number; obs: MicHealthObservation }> = [
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
    ];
    for (let t = 100; t <= 100 + SILENT_CONFIRM_MS; t += 50) {
      steps.push({ atMs: t, obs: silence });
    }
    const { last } = run(steps);
    expect(last.state).toBe("silent");
    expect(last.detail).toBe(`digital silence for ${SILENT_CONFIRM_MS} ms`);
  });

  it("does not re-announce while it stays silent", () => {
    const steps: Array<{ atMs: number; obs: MicHealthObservation }> = [
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
    ];
    for (let t = 100; t <= 100 + SILENT_CONFIRM_MS * 3; t += 50) {
      steps.push({ atMs: t, obs: silence });
    }
    const { notices } = run(steps);
    expect(notices.filter((n) => n === MIC_SILENT_HELP)).toHaveLength(1);
  });
});

describe("nextMicHealth · MAX_SAMPLE_GAP_MS", () => {
  it("cannot flag the mic from a single observation after a suspended timer", () => {
    // One sample arriving ten minutes late must contribute at most
    // MAX_SAMPLE_GAP_MS, not ten minutes of "silence".
    const { last } = run([
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
      { atMs: 600_000, obs: silence },
    ]);
    expect(last.state).toBe("live");
    expect(last.silenceMs).toBe(MAX_SAMPLE_GAP_MS);
  });

  it("never counts negative time when the clock goes backwards", () => {
    const { last } = run([
      { atMs: 1000, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 1050, obs: signal },
      { atMs: 900, obs: silence },
    ]);
    expect(last.silenceMs).toBe(0);
    expect(last.lastSampleMs).toBe(900);
  });
});

describe("nextMicHealth · muted", () => {
  it("announces the OS mute once and re-probes on unmute", () => {
    const { states, notices } = run([
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
      { atMs: 100, obs: { kind: "track-muted", muted: true } },
      { atMs: 150, obs: { kind: "track-muted", muted: true } },
      { atMs: 200, obs: { kind: "track-muted", muted: false } },
    ]);
    expect(states).toEqual(["probing", "live", "muted", "muted", "probing"]);
    expect(notices).toEqual([null, null, MIC_MUTED_HELP, null, null]);
  });

  it("does not let samples arriving while muted diagnose anything", () => {
    const steps: Array<{ atMs: number; obs: MicHealthObservation }> = [
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
      { atMs: 100, obs: { kind: "track-muted", muted: true } },
    ];
    for (let t = 150; t <= 150 + SILENT_CONFIRM_MS * 2; t += 50) {
      steps.push({ atMs: t, obs: silence });
    }
    const { last } = run(steps);
    expect(last.state).toBe("muted");
    expect(last.silenceMs).toBe(0);
  });

  it("ignores an unmute that was never preceded by a mute", () => {
    const { last } = run([
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
      { atMs: 100, obs: { kind: "track-muted", muted: false } },
    ]);
    expect(last.state).toBe("live");
  });
});

describe("nextMicHealth · lost", () => {
  it("goes lost when the track ends and stays there through later samples", () => {
    const { states, notices, last } = run([
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
      { atMs: 100, obs: { kind: "track-ended" } },
      { atMs: 150, obs: signal },
    ]);
    expect(states).toEqual(["probing", "live", "lost", "lost"]);
    expect(notices[2]).toBe(MIC_LOST_HELP);
    expect(last.lastSampleMs).toBe(150);
  });

  it("carries the stream error text into the detail and the notice", () => {
    const result = nextMicHealth({
      nowMs: 100,
      last: { ...initialSnapshot(), state: "live", lastSampleMs: 50 },
      obs: { kind: "stream-error", message: "NotReadableError" },
    });
    expect(result.next.state).toBe("lost");
    expect(result.next.detail).toBe("NotReadableError");
    expect(result.notice).toBe("Microphone stream error: NotReadableError");
  });

  it("ignores a mute event once the track is already gone", () => {
    const { last } = run([
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: { kind: "track-ended" } },
      { atMs: 100, obs: { kind: "track-muted", muted: true } },
    ]);
    expect(last.state).toBe("lost");
  });
});

describe("nextMicHealth · force-silent", () => {
  it("lets the pipeline failsafe flag the mic with its own reason, once", () => {
    const { states, notices, last } = run([
      { atMs: 0, obs: { kind: "session-start", deviceId: "d" } },
      { atMs: 50, obs: signal },
      { atMs: 100, obs: { kind: "force-silent", reason: "no worklet frames" } },
      { atMs: 150, obs: { kind: "force-silent", reason: "no worklet frames" } },
    ]);
    expect(states).toEqual(["probing", "live", "silent", "silent"]);
    expect(notices).toEqual([null, null, MIC_SILENT_HELP, null]);
    expect(last.detail).toBe("no worklet frames");
  });
});

describe("describeMicHealth", () => {
  it("is the only definition site of the user-visible copy", () => {
    expect(describeMicHealth("silent")).toEqual({
      statusText: MIC_SILENT_HELP,
      statusTone: "error",
    });
    expect(describeMicHealth("muted")).toEqual({
      statusText: MIC_MUTED_HELP,
      statusTone: "warning",
    });
    expect(describeMicHealth("lost")).toEqual({
      statusText: MIC_LOST_HELP,
      statusTone: "error",
    });
  });

  it("says nothing at all while the pipeline is healthy or idle", () => {
    expect(describeMicHealth("idle").statusText).toBe("");
    expect(describeMicHealth("live").statusText).toBe("");
  });
});

describe("MicHealthTracker", () => {
  it("notifies subscribers only on the edge where the state changes", () => {
    let clock = 0;
    const tracker = new MicHealthTracker(() => clock);
    const seen: MicHealthState[] = [];
    tracker.subscribe((snap) => seen.push(snap.state));

    tracker.observe({ kind: "session-start", deviceId: "d" });
    clock = 50;
    tracker.observe(signal);
    clock = 100;
    tracker.observe(signal);
    clock = 150;
    tracker.observe(signal);

    expect(seen).toEqual(["probing", "live"]);
    expect(tracker.get().state).toBe("live");
  });

  it("unsubscribes cleanly", () => {
    let clock = 0;
    const tracker = new MicHealthTracker(() => clock);
    const seen: MicHealthState[] = [];
    const off = tracker.subscribe((snap) => seen.push(snap.state));
    tracker.observe({ kind: "session-start", deviceId: "d" });
    off();
    clock = 50;
    tracker.observe(signal);
    expect(seen).toEqual(["probing"]);
  });

  it("reset() returns to idle and notifies once", () => {
    const clock = 0;
    const tracker = new MicHealthTracker(() => clock);
    const seen: MicHealthState[] = [];
    tracker.subscribe((snap) => seen.push(snap.state));
    tracker.observe({ kind: "session-start", deviceId: "d" });
    tracker.reset();
    tracker.reset();
    expect(seen).toEqual(["probing", "idle"]);
    expect(tracker.get()).toEqual(initialSnapshot());
  });
});

describe("reconcileMicHealthStatus — the warning is withdrawn when the mic recovers", () => {
  const recording = { status: "Recording. Deepgram live streaming is active.", tone: "info" };

  it("a Bluetooth headset's silent first second: warning, then the recording line back", () => {
    const silent = reconcileMicHealthStatus("silent", recording, null);
    expect(silent.patch?.status).toBe(MIC_SILENT_HELP);
    expect(silent.displaced).toEqual(recording);
    const shown = { status: silent.patch!.status, tone: silent.patch!.tone };
    const live = reconcileMicHealthStatus("live", shown, silent.displaced);
    expect(live.patch).toEqual(recording);
    expect(live.displaced).toBeNull();
  });

  it("a newer status written meanwhile is not overwritten by the recovery", () => {
    const silent = reconcileMicHealthStatus("silent", recording, null);
    const newer = { status: "Live stream error: offline", tone: "error" };
    expect(reconcileMicHealthStatus("live", newer, silent.displaced).patch).toBeNull();
  });

  it("a second bad state keeps the original line, not the first warning", () => {
    const silent = reconcileMicHealthStatus("silent", recording, null);
    const muted = reconcileMicHealthStatus("muted", silent.patch!, silent.displaced);
    expect(muted.displaced).toEqual(recording);
  });

  it("a healthy take never touches the line", () => {
    expect(reconcileMicHealthStatus("live", recording, null).patch).toBeNull();
    expect(reconcileMicHealthStatus("probing", recording, null).patch).toBeNull();
  });
});

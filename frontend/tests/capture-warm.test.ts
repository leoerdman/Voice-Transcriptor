import { describe, it, expect } from "vitest";

import {
  builtInMicBarelyHeard,
  captureElapsedMs,
  chooseCaptureDevice,
  isBuiltInInputLabel,
  WARM_HOLD_LIFECYCLE_RELEASES,
  type WarmHoldLifecycleRelease,
  decidePreRoll,
  decideWarmHold,
  decideWarmReuse,
  freezeCaptureForStop,
  handOverHeldCapture,
  isBluetoothInputLabel,
  type WarmHoldInput,
  type WarmReuseInput,
} from "../src/capture-warm";

const holdInput: WarmHoldInput = {
  warmHoldMs: 30_000,
  deviceLabel: "MacBook Pro Microphone",
  trackLive: true,
  contextState: "running",
  workletCapture: true,
};

const reuseInput: WarmReuseInput = {
  now: 10_000,
  heldSince: 5_000,
  warmHoldMs: 30_000,
  heldDeviceId: "mic-a",
  requestedDeviceId: "mic-a",
  trackLive: true,
  contextState: "running",
};

describe("isBluetoothInputLabel", () => {
  it("matches the labels a Bluetooth headset reports, whatever the case", () => {
    expect(isBluetoothInputLabel("AirPods Pro")).toBe(true);
    expect(isBluetoothInputLabel("Leo's Beats Fit Pro")).toBe(true);
    expect(isBluetoothInputLabel("Bluetooth Hands-Free")).toBe(true);
    expect(isBluetoothInputLabel("WH-1000XM5 (Hands-Free AG Audio)")).toBe(true);
  });

  it("leaves wired and built-in inputs alone", () => {
    expect(isBluetoothInputLabel("MacBook Pro Microphone")).toBe(false);
    expect(isBluetoothInputLabel("Yeti Stereo Microphone")).toBe(false);
    expect(isBluetoothInputLabel("External Microphone")).toBe(false);
  });

  it("treats an unnamed device as Bluetooth", () => {
    // A device we cannot name is a device we cannot clear, and the cost
    // of the two mistakes is not symmetric: a false positive costs one
    // optimisation, a false negative degrades the user's headset audio
    // for the whole hold window.
    expect(isBluetoothInputLabel("")).toBe(true);
    expect(isBluetoothInputLabel("   ")).toBe(true);
  });
});

describe("decideWarmHold", () => {
  it("holds a live worklet graph on a wired microphone", () => {
    expect(decideWarmHold(holdInput)).toEqual({ hold: true, reason: "held" });
  });

  it("holds nothing when the TTL is zero — the documented off switch", () => {
    expect(decideWarmHold({ ...holdInput, warmHoldMs: 0 })).toEqual({
      hold: false,
      reason: "disabled",
    });
  });

  it("never holds a Bluetooth input", () => {
    // HFP: any application holding the input keeps the headset in the
    // narrowband hands-free profile and out of A2DP, for the whole hold.
    expect(decideWarmHold({ ...holdInput, deviceLabel: "AirPods Max" })).toEqual({
      hold: false,
      reason: "bluetooth",
    });
  });

  it("never holds a ScriptProcessor session — there is no ring to fill", () => {
    expect(decideWarmHold({ ...holdInput, workletCapture: false })).toEqual({
      hold: false,
      reason: "script-fallback",
    });
  });

  it("does not hold a graph whose track or context has already gone", () => {
    expect(decideWarmHold({ ...holdInput, trackLive: false })).toEqual({
      hold: false,
      reason: "track-ended",
    });
    expect(decideWarmHold({ ...holdInput, contextState: "suspended" })).toEqual({
      hold: false,
      reason: "context-suspended",
    });
    expect(decideWarmHold({ ...holdInput, contextState: "" })).toEqual({
      hold: false,
      reason: "context-unknown",
    });
  });
});

describe("decideWarmReuse", () => {
  it("adopts a graph held for less than the TTL on the same device", () => {
    expect(decideWarmReuse(reuseInput)).toEqual({ reuse: true, reason: "reused" });
  });

  it("refuses a graph older than the TTL even when the timer has not fired", () => {
    // The case this exists for: setTimeout does not run while the
    // machine is asleep, so a lid closed for two hours would otherwise
    // hand a two-hour-old MediaStream to the next press.
    expect(decideWarmReuse({ ...reuseInput, now: 5_000 + 30_001 })).toEqual({
      reuse: false,
      reason: "expired",
    });
    // A clock that moved backwards is not evidence of freshness either.
    expect(decideWarmReuse({ ...reuseInput, now: 4_000 })).toEqual({
      reuse: false,
      reason: "expired",
    });
  });

  it("refuses a graph on a different device than the one now selected", () => {
    expect(decideWarmReuse({ ...reuseInput, requestedDeviceId: "mic-b" })).toEqual({
      reuse: false,
      reason: "device-changed",
    });
  });

  it("accepts the held device when the picker asks for the system default", () => {
    expect(decideWarmReuse({ ...reuseInput, requestedDeviceId: "" })).toEqual({
      reuse: true,
      reason: "reused",
    });
  });

  it("refuses a graph whose track ended or whose context stopped running", () => {
    expect(decideWarmReuse({ ...reuseInput, trackLive: false })).toEqual({
      reuse: false,
      reason: "track-ended",
    });
    expect(decideWarmReuse({ ...reuseInput, contextState: "interrupted" })).toEqual({
      reuse: false,
      reason: "context-interrupted",
    });
  });

  it("reuses nothing when the hold is switched off", () => {
    expect(decideWarmReuse({ ...reuseInput, warmHoldMs: 0 })).toEqual({
      reuse: false,
      reason: "disabled",
    });
  });
});

describe("decidePreRoll", () => {
  const freshRing = { sampleCount: 24_000, sampleRate: 48_000, staleMs: 2, maxAgeMs: 2_000 };

  it("accepts the half-second the ring was holding at the press", () => {
    const verdict = decidePreRoll(freshRing);
    expect(verdict.accept).toBe(true);
    expect(verdict.reason).toBe("accepted");
    expect(verdict.durationMs).toBeCloseTo(500, 6);
    expect(verdict.ageMs).toBeCloseTo(502, 6);
  });

  it("drops a ring that stopped being written — a slept machine", () => {
    // The ring still holds audio, but it is audio from some earlier
    // minute; prepending it would put words the user never just said at
    // the front of the transcript.
    const verdict = decidePreRoll({ ...freshRing, staleMs: 90_000 });
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe("stale");
  });

  it("drops the ring the moment its oldest sample passes the age limit", () => {
    // 2 s of ring, 2 s limit: the oldest sample is exactly at the limit
    // and stays; one millisecond more and the whole ring goes.
    expect(decidePreRoll({ ...freshRing, sampleCount: 96_000, staleMs: 0 }).accept).toBe(true);
    expect(decidePreRoll({ ...freshRing, sampleCount: 96_000, staleMs: 1 }).accept).toBe(false);
  });

  it("has nothing to say about an empty or rate-less ring", () => {
    expect(decidePreRoll({ ...freshRing, sampleCount: 0 })).toEqual({
      accept: false, durationMs: 0, ageMs: 0, reason: "empty",
    });
    expect(decidePreRoll({ ...freshRing, sampleRate: 0 })).toEqual({
      accept: false, durationMs: 0, ageMs: 0, reason: "empty",
    });
  });

  it("treats an unknown staleness as the ring's own age", () => {
    const verdict = decidePreRoll({ ...freshRing, staleMs: Number.NaN });
    expect(verdict.accept).toBe(true);
    expect(verdict.ageMs).toBeCloseTo(500, 6);
  });
});

describe("captureElapsedMs — one clock for 'is this a recording yet?'", () => {
  it("measures a cold start from the press, not the first frame (§4.9)", () => {
    // The press at 1000, the first sample 310 ms later: at 1600 the user
    // has held the hotkey for 600 ms, and a 500 ms floor must keep the
    // recording. Measuring from the frame would say 290 ms and drop a
    // one-word dictation.
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 1_000, startAt: 1_310 })).toBe(600);
  });

  it("measures a warm start from the audio, which begins before the press (§4.7)", () => {
    // Pre-roll: the recording contains half a second captured before the
    // hotkey, so the audio's own clock is the earlier one.
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 1_000, startAt: 500 })).toBe(1_100);
  });

  it("uses whichever clock has started when only one has", () => {
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 0, startAt: 1_310 })).toBe(290);
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 1_000, startAt: 0 })).toBe(600);
  });

  it("is zero before either clock starts, and never negative", () => {
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 0, startAt: 0 })).toBe(0);
    expect(captureElapsedMs({ now: 900, startRequestedAt: 1_000, startAt: 0 })).toBe(0);
  });
});

describe("WARM_HOLD_LIFECYCLE_RELEASES", () => {
  it("names every event that ends a hold, and nothing else", () => {
    // A support-log contract: these are the strings
    // ``[trace warmCapture] released reason=…`` prints, and the renderer
    // has one listener per entry.
    expect([...WARM_HOLD_LIFECYCLE_RELEASES]).toEqual([
      "ttl",
      "window-hidden",
      "pagehide",
      "devicechange",
      "system-suspend",
    ]);
  });

  it("includes sleep, which nothing inside the renderer can infer", () => {
    // setTimeout does not run while the machine is asleep, so the hold's
    // own TTL timer cannot be what releases it — the main process's
    // powerMonitor event is.
    const sleep: WarmHoldLifecycleRelease = "system-suspend";
    expect(WARM_HOLD_LIFECYCLE_RELEASES).toContain(sleep);
  });
});

describe("the stop-sequence ordering (F-001)", () => {
  /**
   * Records the order in which the injected steps ran. The defect this
   * guards against was not a wrong answer, it was a right answer to a
   * question asked too late: the microphone track was stopped before
   * anyone asked whether it should be kept, so ``decideWarmHold`` saw
   * ``trackLive: false`` and returned "track-ended" on every stop the
   * product ever performed.
   */
  function trace(): { calls: string[]; note: (name: string) => void } {
    const calls: string[] = [];
    return { calls, note: (name: string) => { calls.push(name); } };
  }

  it("takes the hold decision BEFORE the microphone track is stopped", () => {
    const { calls, note } = trace();
    freezeCaptureForStop({
      planHold: () => {
        note("planHold");
        return { hold: false, reason: "bluetooth" };
      },
      stopTracks: () => note("stopTracks"),
    });
    expect(calls).toEqual(["planHold", "stopTracks"]);
  });

  it("leaves the microphone open when the hold was accepted", () => {
    const { calls, note } = trace();
    const plan = freezeCaptureForStop({
      planHold: () => {
        note("planHold");
        return { hold: true, reason: "held" };
      },
      stopTracks: () => note("stopTracks"),
    });
    expect(calls).toEqual(["planHold"]);
    expect(plan).toEqual({ hold: true, reason: "held" });
  });

  it("returns the plan verbatim so the trace line reports the real reason", () => {
    const plan = freezeCaptureForStop({
      planHold: () => ({ hold: false, reason: "script-fallback", deviceLabel: "USB Mic" }),
      stopTracks: () => { /* refused hold */ },
    });
    expect(plan.reason).toBe("script-fallback");
    expect(plan.deviceLabel).toBe("USB Mic");
  });

  it("hands the graph over when the plan still holds at teardown", () => {
    const { calls, note } = trace();
    const plan = { hold: true, reason: "held" };
    const held = handOverHeldCapture({
      plan,
      commit: (p) => {
        note("commit");
        expect(p).toBe(plan);
        return true;
      },
      stopTracks: () => note("stopTracks"),
    });
    expect(held).toBe(true);
    expect(calls).toEqual(["commit"]);
  });

  it("stops the microphone when a planned hold does not complete", () => {
    // The one failure mode the reorder could introduce is the worst one
    // available: step 1 declined to stop the track because a hold was
    // planned, and then the hold did not take.
    const { calls, note } = trace();
    const held = handOverHeldCapture({
      plan: { hold: true, reason: "held" },
      commit: () => {
        note("commit");
        return false;
      },
      stopTracks: () => note("stopTracks"),
    });
    expect(held).toBe(false);
    expect(calls).toEqual(["commit", "stopTracks"]);
  });

  it("does not try to hand over a hold that was never planned", () => {
    const { calls, note } = trace();
    const held = handOverHeldCapture({
      plan: { hold: false, reason: "track-ended" },
      commit: () => {
        note("commit");
        return true;
      },
      stopTracks: () => note("stopTracks"),
    });
    expect(held).toBe(false);
    expect(calls).toEqual([]);
  });

  it("end to end: a live track is held, and the same graph refused once it has ended", () => {
    // The predicate and the ordering together. With the old order the
    // second case was the ONLY reachable one.
    const live = decideWarmHold({ ...holdInput, trackLive: true });
    expect(freezeCaptureForStop({ planHold: () => live, stopTracks: () => { /* unused */ } }))
      .toEqual({ hold: true, reason: "held" });

    const ended = decideWarmHold({ ...holdInput, trackLive: false });
    let stopped = 0;
    expect(freezeCaptureForStop({ planHold: () => ended, stopTracks: () => { stopped += 1; } }))
      .toEqual({ hold: false, reason: "track-ended" });
    expect(stopped).toBe(1);
  });
});

describe("chooseCaptureDevice — Bluetooth default → the Mac's built-in microphone", () => {
  const macWithHeadset = [
    { deviceId: "default", label: "Default - Leo Liberty 5 BT (Bluetooth)" },
    { deviceId: "bt-1", label: "Leo Liberty 5 BT (Bluetooth)" },
    { deviceId: "builtin-1", label: "MacBook Pro Microphone (Built-in)" },
    { deviceId: "usb-1", label: "Yeti Stereo Microphone (USB)" },
  ];

  it("records from the built-in mic while the system default is a Bluetooth headset", () => {
    expect(chooseCaptureDevice({ requestedDeviceId: "", preferBuiltInOverBluetooth: true, devices: macWithHeadset }))
      .toEqual({ deviceId: "builtin-1", label: "MacBook Pro Microphone (Built-in)", reason: "bluetooth-default-built-in" });
  });

  it("the built-in mic it picks is then warm-holdable (the point of the setting)", () => {
    const choice = chooseCaptureDevice({ requestedDeviceId: "", preferBuiltInOverBluetooth: true, devices: macWithHeadset });
    expect(decideWarmHold({ ...holdInput, deviceLabel: choice.label })).toEqual({ hold: true, reason: "held" });
  });

  it("the list's \"Default - …\" entry is the system default too, not a pinned device", () => {
    expect(chooseCaptureDevice({ requestedDeviceId: "default", preferBuiltInOverBluetooth: true, devices: macWithHeadset }).deviceId)
      .toBe("builtin-1");
  });

  it("a Bluetooth mic the user picked by name is used as picked", () => {
    expect(chooseCaptureDevice({ requestedDeviceId: "bt-1", preferBuiltInOverBluetooth: true, devices: macWithHeadset }))
      .toEqual({ deviceId: "bt-1", label: "Leo Liberty 5 BT (Bluetooth)", reason: "picked" });
  });

  it("with the setting off, the default stands", () => {
    expect(chooseCaptureDevice({ requestedDeviceId: "", preferBuiltInOverBluetooth: false, devices: macWithHeadset }))
      .toMatchObject({ deviceId: "", reason: "default" });
  });

  it("a non-Bluetooth default is never moved", () => {
    const devices = [
      { deviceId: "default", label: "Default - Yeti Stereo Microphone (USB)" },
      { deviceId: "builtin-1", label: "MacBook Pro Microphone (Built-in)" },
      { deviceId: "usb-1", label: "Yeti Stereo Microphone (USB)" },
    ];
    expect(chooseCaptureDevice({ requestedDeviceId: "", preferBuiltInOverBluetooth: true, devices }))
      .toMatchObject({ deviceId: "", reason: "default" });
  });

  it("a Mac with no built-in mic (mini / Studio) keeps recording from the headset", () => {
    const devices = macWithHeadset.filter((d) => d.deviceId !== "builtin-1");
    expect(chooseCaptureDevice({ requestedDeviceId: "", preferBuiltInOverBluetooth: true, devices }))
      .toMatchObject({ deviceId: "", reason: "bluetooth-default-no-built-in" });
  });

  it("without labels (no permission yet) nothing is guessed", () => {
    const devices = [{ deviceId: "default", label: "" }, { deviceId: "x", label: "" }];
    expect(chooseCaptureDevice({ requestedDeviceId: "", preferBuiltInOverBluetooth: true, devices }))
      .toMatchObject({ deviceId: "", reason: "default" });
  });

  it("follows the headset coming and going (the list it is given is the current one)", () => {
    const unplugged = [
      { deviceId: "default", label: "Default - MacBook Pro Microphone (Built-in)" },
      { deviceId: "builtin-1", label: "MacBook Pro Microphone (Built-in)" },
    ];
    expect(chooseCaptureDevice({ requestedDeviceId: "", preferBuiltInOverBluetooth: true, devices: unplugged }).reason).toBe("default");
    expect(chooseCaptureDevice({ requestedDeviceId: "", preferBuiltInOverBluetooth: true, devices: macWithHeadset }).reason)
      .toBe("bluetooth-default-built-in");
  });
});

describe("isBuiltInInputLabel", () => {
  it.each([
    ["MacBook Pro Microphone (Built-in)", true],
    ["MacBook Air Microphone", true],
    ["Built-in Microphone", true],
    ["iMac Microphone", true],
    ["Leo Liberty 5 BT (Bluetooth)", false],
    ["AirPods Pro", false],
    ["Yeti Stereo Microphone (USB)", false],
    ["", false],
  ])("%s → %s", (label, expected) => {
    expect(isBuiltInInputLabel(label)).toBe(expected);
  });
});

describe("builtInMicBarelyHeard", () => {
  const base = { choiceReason: "bluetooth-default-built-in", recordedMs: 12_000, frames: 1000 };

  it("flags a take the built-in mic barely heard (2026-11-22: 2-5 % speech frames)", () => {
    expect(builtInMicBarelyHeard({ ...base, speechFrames: 30 })).toBe(true);
    expect(builtInMicBarelyHeard({ ...base, speechFrames: 50 })).toBe(true);
  });

  it("leaves a take with ordinary speech alone (headset takes: 30-60 %)", () => {
    expect(builtInMicBarelyHeard({ ...base, speechFrames: 300 })).toBe(false);
    expect(builtInMicBarelyHeard({ ...base, speechFrames: 100 })).toBe(false);
  });

  it("judges only takes the Bluetooth setting moved to the built-in mic", () => {
    for (const choiceReason of ["picked", "default", "bluetooth-default-no-built-in", ""]) {
      expect(builtInMicBarelyHeard({ ...base, choiceReason, speechFrames: 0 })).toBe(false);
    }
  });

  it("does not judge a take too short to say anything", () => {
    expect(builtInMicBarelyHeard({ ...base, recordedMs: 2_999, speechFrames: 0 })).toBe(false);
    expect(builtInMicBarelyHeard({ ...base, frames: 0, speechFrames: 0 })).toBe(false);
  });
});

describe("chooseCaptureDevice with the setting off (the default since 1.6.25)", () => {
  it("records from the Bluetooth default as it is", () => {
    const choice = chooseCaptureDevice({
      requestedDeviceId: "",
      preferBuiltInOverBluetooth: false,
      devices: [
        { deviceId: "default", label: "Default - Leo Liberty 5 BT (Bluetooth)" },
        { deviceId: "bi", label: "MacBook Pro Microphone (Built-in)" },
      ],
    });
    expect(choice.reason).toBe("default");
    expect(choice.deviceId).toBe("");
  });
});

import { describe, expect, it } from "vitest";

import { captureInputLatency, nativeLatencyForLabel, type NativeInputDevice } from "../src/capture-latency";

const BT = "Default - Leo Liberty 5 BT (Bluetooth)";
const BUILT_IN = "MacBook Pro Microphone (Built-in)";
// What the native helper read from Core Audio on 2026-11-23.
const NATIVE: NativeInputDevice[] = [
  { name: "Leo Liberty 5 BT", latencyMs: 30 },
  { name: "MacBook Pro Microphone", latencyMs: 62.8 },
  { name: "BlackHole 2ch", latencyMs: 11.6 },
];
const BASE = { bufferPeriodMs: 10.67, bluetoothFloorMs: 300 };

describe("captureInputLatency", () => {
  it("holds a Bluetooth input to the floor when the device under-reports", () => {
    // Core Audio reports 30 ms for this headset; HFP is far slower.
    expect(captureInputLatency({ ...BASE, deviceLabel: BT, reportedLatencySec: 0.03 })).toEqual({
      ms: 310.67,
      source: "bluetooth",
      reportedMs: 30,
      nativeMs: 0,
    });
  });

  it("holds a Bluetooth input to the floor when nothing is reported", () => {
    expect(captureInputLatency({ ...BASE, deviceLabel: BT, reportedLatencySec: undefined })).toEqual({
      ms: 310.67,
      source: "bluetooth",
      reportedMs: 0,
      nativeMs: 0,
    });
  });

  it("takes a report larger than the floor", () => {
    expect(captureInputLatency({ ...BASE, deviceLabel: BT, reportedLatencySec: 0.4 })).toEqual({
      ms: 410.67,
      source: "reported",
      reportedMs: 400,
      nativeMs: 0,
    });
  });

  it("uses what a wired or built-in input reports", () => {
    expect(captureInputLatency({ ...BASE, deviceLabel: BUILT_IN, reportedLatencySec: 0.01 })).toEqual({
      ms: 20.67,
      source: "reported",
      reportedMs: 10,
      nativeMs: 0,
    });
  });

  it("is one capture buffer when a built-in input reports nothing", () => {
    expect(captureInputLatency({ ...BASE, deviceLabel: BUILT_IN, reportedLatencySec: null })).toEqual({
      ms: 10.67,
      source: "none",
      reportedMs: 0,
      nativeMs: 0,
    });
  });

  it("disbelieves reports that are not a plausible latency", () => {
    for (const reportedLatencySec of [Number.NaN, -1, 0, 5, "fast", {}]) {
      expect(captureInputLatency({ ...BASE, deviceLabel: BUILT_IN, reportedLatencySec }).source).toBe("none");
    }
  });

  it("adds the ScriptProcessor's longer buffer the same way", () => {
    expect(captureInputLatency({ ...BASE, bufferPeriodMs: 85.33, deviceLabel: BT, reportedLatencySec: 0 }).ms).toBeCloseTo(
      385.33,
      6,
    );
  });

  it("treats a non-finite buffer period as none", () => {
    expect(captureInputLatency({ ...BASE, bufferPeriodMs: Number.NaN, deviceLabel: BUILT_IN, reportedLatencySec: 0 })).toEqual({
      ms: 0,
      source: "none",
      reportedMs: 0,
      nativeMs: 0,
    });
  });

  it("takes Core Audio's figure for the built-in microphone, which Chromium reports as 2.9 ms", () => {
    expect(
      captureInputLatency({ ...BASE, deviceLabel: BUILT_IN, reportedLatencySec: 0.002902, nativeDevices: NATIVE }),
    ).toEqual({ ms: 73.47, source: "coreaudio", reportedMs: 2.902, nativeMs: 62.8 });
  });

  it("finds the device behind the system-default alias", () => {
    expect(
      captureInputLatency({
        ...BASE,
        deviceLabel: "Default - MacBook Pro Microphone (Built-in)",
        reportedLatencySec: 0.002902,
        nativeDevices: NATIVE,
      }).nativeMs,
    ).toBe(62.8);
  });

  it("keeps the larger of the two when the track reports more than Core Audio", () => {
    const result = captureInputLatency({ ...BASE, deviceLabel: BUILT_IN, reportedLatencySec: 0.09, nativeDevices: NATIVE });
    expect(result).toEqual({ ms: 100.67, source: "reported", reportedMs: 90, nativeMs: 62.8 });
  });

  it("does not sum the two: both count the delivery buffer", () => {
    const result = captureInputLatency({ ...BASE, bufferPeriodMs: 0, deviceLabel: BUILT_IN, reportedLatencySec: 0.0629, nativeDevices: NATIVE });
    expect(result.ms).toBeCloseTo(62.9, 6);
  });

  it("holds a Bluetooth headset to the floor over Core Audio's 30 ms", () => {
    expect(
      captureInputLatency({ ...BASE, deviceLabel: BT, reportedLatencySec: 0.008, nativeDevices: NATIVE }),
    ).toEqual({ ms: 310.67, source: "bluetooth", reportedMs: 8, nativeMs: 30 });
  });

  it("is what the track reports when Core Audio's list is absent or does not name the device", () => {
    for (const nativeDevices of [undefined, [], [{ name: "Some Other Mic", latencyMs: 90 }]]) {
      expect(
        captureInputLatency({ ...BASE, deviceLabel: BUILT_IN, reportedLatencySec: 0.0029, nativeDevices }),
      ).toEqual({ ms: 13.57, source: "reported", reportedMs: 2.9, nativeMs: 0 });
    }
  });
});

describe("nativeLatencyForLabel", () => {
  it("matches the name Chromium puts before its transport suffix, ignoring case", () => {
    expect(nativeLatencyForLabel("macbook pro microphone (Built-in)", NATIVE)).toBe(62.8);
    expect(nativeLatencyForLabel("BlackHole 2ch (Virtual)", NATIVE)).toBe(11.6);
  });

  it("matches a device that has no suffix at all", () => {
    expect(nativeLatencyForLabel("Iphone 17 Leo Microphone", [{ name: "iPhone 17 Leo Microphone", latencyMs: 20 }])).toBe(20);
  });

  it("matches a name that ends in parentheses of its own before trying to strip a suffix", () => {
    const devices = [
      { name: "Mic", latencyMs: 10 },
      { name: "Mic (2)", latencyMs: 40 },
    ];
    expect(nativeLatencyForLabel("Mic (2) (USB)", devices)).toBe(40);
    expect(nativeLatencyForLabel("Mic (2)", devices)).toBe(40);
    expect(nativeLatencyForLabel("Mic (USB)", devices)).toBe(10);
  });

  it("takes the largest figure among devices that share a name", () => {
    const devices = [
      { name: "Twin", latencyMs: 12 },
      { name: "Twin", latencyMs: 31 },
    ];
    expect(nativeLatencyForLabel("Twin (USB)", devices)).toBe(31);
  });

  it("finds nothing for an empty label, an unknown device or unusable figures", () => {
    expect(nativeLatencyForLabel("", NATIVE)).toBe(0);
    expect(nativeLatencyForLabel("Default - ", NATIVE)).toBe(0);
    expect(nativeLatencyForLabel("Unknown (Built-in)", NATIVE)).toBe(0);
    expect(nativeLatencyForLabel("X", [{ name: "X", latencyMs: Number.NaN }, { name: "X", latencyMs: -3 }])).toBe(0);
  });
});

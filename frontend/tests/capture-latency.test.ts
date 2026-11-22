import { describe, expect, it } from "vitest";

import { captureInputLatency } from "../src/capture-latency";

const BT = "Default - Leo Liberty 5 BT (Bluetooth)";
const BUILT_IN = "MacBook Pro Microphone (Built-in)";
const BASE = { bufferPeriodMs: 10.67, bluetoothFloorMs: 300 };

describe("captureInputLatency", () => {
  it("holds a Bluetooth input to the floor when the device under-reports", () => {
    // Core Audio reports 30 ms for this headset; HFP is far slower.
    expect(captureInputLatency({ ...BASE, deviceLabel: BT, reportedLatencySec: 0.03 })).toEqual({
      ms: 310.67,
      source: "bluetooth",
      reportedMs: 30,
    });
  });

  it("holds a Bluetooth input to the floor when nothing is reported", () => {
    expect(captureInputLatency({ ...BASE, deviceLabel: BT, reportedLatencySec: undefined })).toEqual({
      ms: 310.67,
      source: "bluetooth",
      reportedMs: 0,
    });
  });

  it("takes a report larger than the floor", () => {
    expect(captureInputLatency({ ...BASE, deviceLabel: BT, reportedLatencySec: 0.4 })).toEqual({
      ms: 410.67,
      source: "reported",
      reportedMs: 400,
    });
  });

  it("uses what a wired or built-in input reports", () => {
    expect(captureInputLatency({ ...BASE, deviceLabel: BUILT_IN, reportedLatencySec: 0.01 })).toEqual({
      ms: 20.67,
      source: "reported",
      reportedMs: 10,
    });
  });

  it("is one capture buffer when a built-in input reports nothing", () => {
    expect(captureInputLatency({ ...BASE, deviceLabel: BUILT_IN, reportedLatencySec: null })).toEqual({
      ms: 10.67,
      source: "none",
      reportedMs: 0,
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
    });
  });
});

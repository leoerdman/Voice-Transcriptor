import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkletDeliveryWatchdog } from "../src/worklet-watchdog";

const timers = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

describe("WorkletDeliveryWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms the fallback when the worklet is still silent at the deadline", () => {
    const watchdog = new WorkletDeliveryWatchdog(timers);
    const onSilent = vi.fn();
    watchdog.arm(400, () => false, onSilent);
    vi.advanceTimersByTime(399);
    expect(onSilent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilent).toHaveBeenCalledTimes(1);
    expect(watchdog.armed).toBe(false);
  });

  it("builds nothing when the worklet delivered in time", () => {
    const watchdog = new WorkletDeliveryWatchdog(timers);
    const onSilent = vi.fn();
    let frames = 0;
    watchdog.arm(400, () => frames > 0, onSilent);
    frames = 3;
    vi.advanceTimersByTime(1_000);
    expect(onSilent).not.toHaveBeenCalled();
  });

  it("a cancelled check never fires (the take stopped first)", () => {
    const watchdog = new WorkletDeliveryWatchdog(timers);
    const onSilent = vi.fn();
    watchdog.arm(400, () => false, onSilent);
    watchdog.cancel();
    vi.advanceTimersByTime(1_000);
    expect(onSilent).not.toHaveBeenCalled();
    expect(watchdog.armed).toBe(false);
  });

  it("re-arming replaces the previous take's check", () => {
    const watchdog = new WorkletDeliveryWatchdog(timers);
    const first = vi.fn();
    const second = vi.fn();
    watchdog.arm(400, () => false, first);
    vi.advanceTimersByTime(200);
    watchdog.arm(400, () => false, second);
    vi.advanceTimersByTime(399);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

/**
 * The start path must not build the deprecated node next to a working
 * worklet again: the only callers of the fallback are the "worklet could
 * not be built" branch and the watchdog's silent callback.
 */
describe("ScriptProcessor fallback in the start path", () => {
  const mainTsx = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");

  it("is started in two places only: worklet unavailable, and the watchdog", () => {
    const calls = mainTsx.match(/startScriptProcessorCapture\(\s*sessionAc/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(mainTsx).toContain('startScriptProcessorCapture(sessionAc, sessionSrc, "AudioWorklet delivered no frames", true)');
    expect(mainTsx).not.toContain("preArmScriptProcessorFallback");
    expect(mainTsx).not.toContain("scriptProcessorPreArmed");
  });

  it("the standby is armed only from inside the watchdog's silent callback", () => {
    const armAt = mainTsx.indexOf("workletDeliveryWatchdog.arm(");
    const standbyAt = mainTsx.indexOf('"AudioWorklet delivered no frames", true)');
    expect(armAt).toBeGreaterThan(0);
    expect(standbyAt).toBeGreaterThan(armAt);
    expect(mainTsx.slice(armAt, standbyAt)).not.toContain("\n    }");
  });
});

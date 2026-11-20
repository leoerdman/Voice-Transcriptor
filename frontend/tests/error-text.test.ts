import { describe, it, expect, vi } from "vitest";

import {
  MAX_ERROR_TEXT,
  describeError,
  explainNetworkError,
  installErrorAwareConsole,
  isGenericFetchFailure,
  formatErrorDetail,
  isPermissionRefusal,
  needsErrorText,
} from "../src/error-text";

describe("formatErrorDetail (FU-18)", () => {
  it("renders a FastAPI validation array as readable field messages, not JSON", () => {
    const detail = [
      { loc: ["body", "model"], msg: "field required", type: "missing" },
      { loc: ["query", "limit"], msg: "must be > 0", type: "value_error" },
    ];
    expect(formatErrorDetail(detail)).toBe("model: field required; limit: must be > 0");
  });

  it("uses a string detail as is", () => {
    expect(formatErrorDetail("Preset limit reached")).toBe("Preset limit reached");
  });

  it("keeps an unplanned shape as JSON", () => {
    expect(formatErrorDetail({ code: 7 })).toBe('{"code":7}');
  });
});

describe("isPermissionRefusal (FU-19)", () => {
  it("recognises a refusal by its DOMException name, whatever the message says", () => {
    expect(isPermissionRefusal(new DOMException("Permission dismissed", "NotAllowedError"))).toBe(true);
    expect(isPermissionRefusal(new DOMException("Доступ запрещён", "NotAllowedError"))).toBe(true);
    expect(isPermissionRefusal(new DOMException("blocked", "SecurityError"))).toBe(true);
  });

  it("still recognises a wrapped refusal by its message", () => {
    expect(isPermissionRefusal(new Error("Permission denied by system"))).toBe(true);
  });

  it("lets a device that is busy or absent be retried", () => {
    expect(isPermissionRefusal(new DOMException("Could not start audio source", "NotReadableError"))).toBe(false);
    expect(isPermissionRefusal(new Error("microphone did not open within 2500 ms"))).toBe(false);
  });
});

describe("describeError", () => {
  it("renders a DOMException with its name, which is the diagnostic part", () => {
    // The regression this exists for: every recording fell back from
    // AudioWorklet to ScriptProcessor and the log said only
    // "[object DOMException]". The name is what separates a CSP refusal
    // from a permission denial from a cancellation.
    const err = new DOMException("Failed to load module script", "NotSupportedError");
    expect(describeError(err)).toBe("NotSupportedError: Failed to load module script");
  });

  it("renders an Error the same way", () => {
    expect(describeError(new TypeError("nope"))).toBe("TypeError: nope");
  });

  it("falls back to the bare name when there is no message", () => {
    expect(describeError(new DOMException("", "AbortError"))).toBe("AbortError");
  });

  it("keeps strings and numbers as they are", () => {
    expect(describeError("plain reason")).toBe("plain reason");
    expect(describeError(42)).toBe("42");
  });

  it("handles null and undefined without throwing", () => {
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("reads name/message off an error-shaped plain object", () => {
    // Structured-clone copies across a worker boundary lose their
    // prototype but keep the fields.
    expect(describeError({ name: "QuotaExceededError", message: "disk full" }))
      .toBe("QuotaExceededError: disk full");
  });

  it("serialises a plain object rather than printing [object Object]", () => {
    expect(describeError({ code: 7, detail: "x" })).toBe('{"code":7,"detail":"x"}');
  });

  it("survives an unserialisable object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });

  it("clips a pathological message and says how much was dropped", () => {
    const err = new Error("x".repeat(MAX_ERROR_TEXT + 120));
    const out = describeError(err);
    expect(out.length).toBeLessThan(MAX_ERROR_TEXT + 60);
    expect(out).toContain("chars)");
  });
});

describe("needsErrorText", () => {
  it("is true for the values that format as [object …]", () => {
    expect(needsErrorText(new Error("x"))).toBe(true);
    expect(needsErrorText(new DOMException("x", "AbortError"))).toBe(true);
    expect(needsErrorText({ a: 1 })).toBe(true);
  });

  it("is false for values that already print readably", () => {
    expect(needsErrorText("text")).toBe(false);
    expect(needsErrorText(7)).toBe(false);
    expect(needsErrorText(null)).toBe(false);
    expect(needsErrorText(undefined)).toBe(false);
  });
});

describe("installErrorAwareConsole", () => {
  const makeConsole = () => ({ warn: vi.fn(), error: vi.fn() });

  it("rewrites only the error argument, leaving the context message alone", () => {
    const c = makeConsole();
    const original = { warn: c.warn, error: c.error };
    installErrorAwareConsole(c);
    c.warn("AudioWorklet capture init failed", new DOMException("blocked", "NotSupportedError"));
    expect(original.warn).toHaveBeenCalledWith(
      "AudioWorklet capture init failed",
      "NotSupportedError: blocked",
    );
  });

  it("wraps error as well as warn", () => {
    const c = makeConsole();
    const original = { error: c.error };
    installErrorAwareConsole(c);
    c.error("boom", new Error("detail"));
    expect(original.error).toHaveBeenCalledWith("boom", "Error: detail");
  });

  it("is idempotent, so a hot reload cannot stack wrappers", () => {
    const c = makeConsole();
    const original = c.warn;
    installErrorAwareConsole(c);
    const wrappedOnce = c.warn;
    installErrorAwareConsole(c);
    expect(c.warn).toBe(wrappedOnce);
    c.warn("x", new Error("y"));
    expect(original).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith("x", "Error: y");
  });

  it("passes non-error arguments through untouched", () => {
    const c = makeConsole();
    const original = c.warn;
    installErrorAwareConsole(c);
    c.warn("just", "strings", 5);
    expect(original).toHaveBeenCalledWith("just", "strings", 5);
  });
});

describe("isGenericFetchFailure", () => {
  it("recognises the browsers' generic fetch failures", () => {
    for (const raw of [
      "Failed to fetch",
      "TypeError: Failed to fetch",
      "Load failed",
      "TypeError: Load failed",
      "NetworkError when attempting to fetch resource.",
    ]) {
      expect(isGenericFetchFailure(raw), raw).toBe(true);
    }
  });

  it("recognises Chromium's ERR_ codes inside a longer message", () => {
    expect(isGenericFetchFailure("POST /api/config: net::ERR_CONNECTION_REFUSED")).toBe(true);
    expect(isGenericFetchFailure("ERR_NAME_NOT_RESOLVED")).toBe(true);
    expect(isGenericFetchFailure("something ERR_INTERNET_DISCONNECTED something")).toBe(true);
    expect(isGenericFetchFailure("ERR_CONNECTION_RESET")).toBe(true);
  });

  it("does not treat a backend error that merely contains the words as a network failure", () => {
    // The reason "load failed" is matched only as a whole message: this
    // one used to be redirected into the "you are offline, try a VPN"
    // explainer.
    expect(isGenericFetchFailure("failed to load model 'large-v3': file not found")).toBe(false);
    expect(isGenericFetchFailure("Deepgram HTTP 402: insufficient credits")).toBe(false);
    expect(isGenericFetchFailure("Model load failed for gigaam-v2")).toBe(false);
  });

  it("is case- and whitespace-insensitive, and says no to nothing", () => {
    expect(isGenericFetchFailure("  FAILED TO FETCH  ")).toBe(true);
    expect(isGenericFetchFailure("")).toBe(false);
    expect(isGenericFetchFailure("   ")).toBe(false);
  });
});

/**
 * The advice rules, now that they live where they can be checked.
 */
describe("explainNetworkError", () => {
  it("names the configuration problem rather than the network for a missing key", () => {
    const msg = explainNetworkError(new Error("Deepgram API key is not configured"));
    expect(msg).toContain("Settings");
    expect(msg).not.toContain("VPN");
  });

  it("does not offer local when local is what just failed", () => {
    const err = new Error("Deepgram is unreachable");
    expect(explainNetworkError(err, "Re-transcribe failed"))
      .toContain('switch Provider to "local"');
    const withoutLocal = explainNetworkError(err, "Re-transcribe failed", {
      suggestLocalFallback: false,
    });
    expect(withoutLocal).not.toContain("switch Provider");
    expect(withoutLocal.endsWith("try a VPN.")).toBe(true);
  });

  it("drops the clause from every branch, not only the last one", () => {
    const cases = [
      "Deepgram API key is not configured",
      "Deepgram HTTP 429 rate limit",
      "Deepgram HTTP 402 insufficient credits",
      "Deepgram HTTP 503",
      "Deepgram is unreachable",
      "TypeError: Failed to fetch",
    ];
    for (const raw of cases) {
      const msg = explainNetworkError(new Error(raw), "", { suggestLocalFallback: false });
      expect(msg, raw).not.toContain("switch Provider");
      expect(msg, raw).not.toMatch(/,\s*\./);
    }
  });

  it("keeps a message it has no advice for exactly as it was", () => {
    const raw = "failed to load model 'large-v3': file not found";
    expect(explainNetworkError(new Error(raw))).toBe(raw);
  });

  it("prefixes the context when one is given", () => {
    expect(explainNetworkError(new Error("Deepgram HTTP 429"), "Upload failed"))
      .toMatch(/^Upload failed: /);
  });
});

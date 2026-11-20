import { describe, expect, it } from "vitest";
import {
  PROVIDER_DISPLAY_ORDER,
  isRemoteProvider,
  normalizeProviderSelection,
  providerKeyErrorMessage,
  providerLabel,
  requireRemoteProvider,
} from "../src/providers";

describe("requireRemoteProvider (FG-12)", () => {
  it("refuses a None selection instead of billing it to OpenRouter", () => {
    expect(() => requireRemoteProvider("")).toThrow(/remote provider/);
    expect(() => requireRemoteProvider("local")).toThrow(/remote provider/);
  });

  it("passes a remote provider through", () => {
    expect(requireRemoteProvider("deepgram")).toBe("deepgram");
    expect(requireRemoteProvider("openrouter")).toBe("openrouter");
  });
});

describe("the provider table (FG-16)", () => {
  it("derives the display order, labels, remoteness and key messages from one declaration", () => {
    expect(PROVIDER_DISPLAY_ORDER).toEqual(["local", "openrouter", "deepgram"]);
    expect(providerLabel("openrouter")).toBe("OpenRouter");
    expect(providerLabel("DEEPGRAM")).toBe("Deepgram");
    expect(providerLabel("none")).toBe("None");
    expect(providerLabel("")).toBe("Unknown");
    expect(providerLabel("fal.ai")).toBe("fal.ai");
    expect(isRemoteProvider("local")).toBe(false);
    expect(isRemoteProvider("")).toBe(false);
    expect(isRemoteProvider("deepgram")).toBe(true);
    expect(providerKeyErrorMessage("deepgram")).toBe("Deepgram API key is not configured. Add it in Settings -> API Keys.");
    expect(providerKeyErrorMessage("local")).toBe("Provider API key is not configured.");
  });

  it("normalises a stored selection", () => {
    expect(normalizeProviderSelection("deepgram")).toBe("deepgram");
    expect(normalizeProviderSelection("")).toBe("");
    expect(normalizeProviderSelection("fal")).toBe("local");
    expect(normalizeProviderSelection(undefined, "openrouter")).toBe("");
  });
});

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
  it("refuses a local selection instead of billing it to OpenRouter", () => {
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
    expect(isRemoteProvider("deepgram")).toBe(true);
    expect(providerKeyErrorMessage("deepgram")).toBe("Deepgram API key is not configured. Add it in Settings -> API Keys.");
    expect(providerKeyErrorMessage("local")).toBe("Provider API key is not configured.");
  });

  it("normalises a stored selection", () => {
    expect(normalizeProviderSelection("deepgram")).toBe("deepgram");
    expect(normalizeProviderSelection("fal")).toBe("local");
  });

  it("FU-15 (user decision 2026-11-20: remove None): a stored \"\" migrates to the default provider", () => {
    // Builds that offered "None" persisted it as provider "". There is no
    // "None" any more, so reading one back selects the default provider
    // and transcription is on — never an empty provider.
    expect(normalizeProviderSelection("")).toBe("local");
    expect(normalizeProviderSelection("  ")).toBe("local");
    expect(normalizeProviderSelection("", "openrouter")).toBe("openrouter");
    expect(normalizeProviderSelection(undefined, "openrouter")).toBe("openrouter");
  });
});

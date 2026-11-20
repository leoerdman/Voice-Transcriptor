import { describe, expect, it } from "vitest";
import { fallbackSourceKey, isCurrentPlayerSource } from "../src/player-source";

const key = "rec.txt\n/archive";

describe("isCurrentPlayerSource (FG-15)", () => {
  it("leaves the in-memory fallback alone on a refresh instead of restarting playback", () => {
    expect(isCurrentPlayerSource({ desiredBackendKey: key, attachedKey: fallbackSourceKey(key), hasSrc: true })).toBe(true);
  });

  it("leaves the backend source alone", () => {
    expect(isCurrentPlayerSource({ desiredBackendKey: key, attachedKey: key, hasSrc: true })).toBe(true);
  });

  it("re-renders for another recording, a dropped key (after a media error) or no src", () => {
    expect(isCurrentPlayerSource({ desiredBackendKey: key, attachedKey: "other\n/a", hasSrc: true })).toBe(false);
    expect(isCurrentPlayerSource({ desiredBackendKey: key, attachedKey: "", hasSrc: true })).toBe(false);
    expect(isCurrentPlayerSource({ desiredBackendKey: key, attachedKey: key, hasSrc: false })).toBe(false);
    expect(isCurrentPlayerSource({ desiredBackendKey: "", attachedKey: "", hasSrc: true })).toBe(false);
  });
});

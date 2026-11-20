import { describe, expect, it } from "vitest";

import { MEDIA_URL_EXPIRY_SLACK_MS, mediaErrorRecovery, parseMintedMediaUrl } from "../src/media-url";

describe("S-15 · the History player streams from a minted URL", () => {
  it("reads the mint route's answer", () => {
    expect(parseMintedMediaUrl({ url: "/api/recordings/a.txt/audio/stream?media_token=t", expires_at: 1_000 }))
      .toEqual({ url: "/api/recordings/a.txt/audio/stream?media_token=t", expiresAtMs: 1_000_000 });
  });

  it("refuses anything that is not a same-origin recording URL with an expiry", () => {
    for (const bad of [
      null,
      {},
      { url: "https://elsewhere.example/a", expires_at: 1 },
      { url: "/api/config", expires_at: 1 },
      { url: "/api/recordings/a.txt/audio/stream", expires_at: "soon" },
      { url: "/api/recordings/a.txt/audio/stream", expires_at: 0 },
    ]) {
      expect(() => parseMintedMediaUrl(bad)).toThrow();
    }
  });

  it("an error once the URL has expired re-mints (a seek after a long pause)", () => {
    const minted = { url: "/api/recordings/a.txt/audio/stream", expiresAtMs: 600_000 };
    expect(mediaErrorRecovery(minted, 600_000)).toBe("remint");
    expect(mediaErrorRecovery(minted, 900_000)).toBe("remint");
    expect(mediaErrorRecovery(minted, 600_000 - MEDIA_URL_EXPIRY_SLACK_MS)).toBe("remint");
  });

  it("an error on a fresh URL is a real failure, never a re-mint loop", () => {
    const minted = { url: "/api/recordings/a.txt/audio/stream", expiresAtMs: 600_000 };
    expect(mediaErrorRecovery(minted, 1_000)).toBe("fail");
    expect(mediaErrorRecovery(minted, 600_000 - MEDIA_URL_EXPIRY_SLACK_MS - 1)).toBe("fail");
    expect(mediaErrorRecovery(null, 900_000)).toBe("fail");
  });
});

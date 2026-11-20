import { describe, it, expect, vi, afterEach } from "vitest";

import {
  checkForUpdate,
  compareVersions,
  parseLatestRelease,
  shouldAutoCheck,
  updateCheckOutcome,
  type UpdateMeta,
} from "../src/update-check";

describe("updateCheckOutcome (FU-17)", () => {
  const unknown = { status: "unknown" as const, reason: "offline" };
  it("does not stamp the daily throttle for a check that learned nothing", () => {
    expect(updateCheckOutcome(unknown, "boot").stamp).toBe(false);
    expect(updateCheckOutcome(unknown, "user").stamp).toBe(false);
  });

  it("keeps the passive boot check silent when it could not tell, but answers the button", () => {
    expect(updateCheckOutcome(unknown, "boot").render).toBe(false);
    expect(updateCheckOutcome(unknown, "user").render).toBe(true);
  });

  it("stamps and shows a real answer either way", () => {
    expect(updateCheckOutcome({ status: "up-to-date" }, "boot")).toEqual({ stamp: true, render: true });
  });
});

const meta: UpdateMeta = { version: "1.3.0", repoSlug: "owner/repo" };

function fetchOk(payload: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(payload),
  }) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("compareVersions", () => {
  it("compares numerically per segment (1.10 > 1.9)", () => {
    expect(compareVersions("1.10.0", "1.9.2")).toBeGreaterThan(0);
    expect(compareVersions("1.2.1", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
  });
  it("pads missing segments as zeros", () => {
    expect(compareVersions("1.3", "1.3.0")).toBe(0);
    expect(compareVersions("1.3", "1.3.1")).toBeLessThan(0);
  });
});

describe("parseLatestRelease", () => {
  it("strips a single leading v from the tag", () => {
    expect(parseLatestRelease({ tag_name: "v1.4.0", html_url: "https://x" })).toEqual({
      version: "1.4.0",
      htmlUrl: "https://x",
    });
  });
  it("returns null for drafts, empty tags, or missing url", () => {
    expect(parseLatestRelease({ tag_name: "v1", html_url: "https://x", draft: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: "", html_url: "https://x" })).toBeNull();
    expect(parseLatestRelease({ tag_name: "v1" })).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
  });
});

describe("checkForUpdate", () => {
  it("detects a newer release", async () => {
    const r = await checkForUpdate(meta, fetchOk({ tag_name: "v1.4.0", html_url: "u" }));
    expect(r).toEqual({ status: "update-available", latest: { version: "1.4.0", htmlUrl: "u" } });
  });
  it("reports up-to-date on equal/older", async () => {
    const r = await checkForUpdate(meta, fetchOk({ tag_name: "v1.3.0", html_url: "u" }));
    expect(r.status).toBe("up-to-date");
  });
  it("degrades network failures to unknown with reason", async () => {
    const f = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const r = await checkForUpdate(meta, f);
    expect(r.status).toBe("unknown");
  });
  it("treats non-2xx as unknown, never as up-to-date", async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    const r = await checkForUpdate(meta, f);
    expect(r.status).toBe("unknown");
  });
});

describe("shouldAutoCheck", () => {
  it("checks when never checked before", () => {
    expect(shouldAutoCheck(1000, 0)).toBe(true);
  });
  it("skips within the 24h window", () => {
    expect(shouldAutoCheck(24 * 3600 * 1000, 23 * 3600 * 1000)).toBe(false);
  });
  it("passes after the window elapses", () => {
    expect(shouldAutoCheck(25 * 3600 * 1000, 3600 * 1000)).toBe(true);
  });
});

/**
 * Three ways the checker used to answer wrongly, all of them silent.
 */
describe("a pre-release is never newer than its release (U-012)", () => {
  it("orders a release candidate below the release", () => {
    expect(compareVersions("1.3.0-rc1", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.3.0-rc1")).toBeGreaterThan(0);
  });

  it("still orders by the numbers first", () => {
    expect(compareVersions("1.4.0-rc1", "1.3.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.9", "1.3.0-rc1")).toBeLessThan(0);
  });

  it("orders two candidates of one version among themselves", () => {
    expect(compareVersions("1.3.0-rc1", "1.3.0-rc2")).toBeLessThan(0);
    expect(compareVersions("1.3.0-rc2", "1.3.0-rc2")).toBe(0);
  });

  it("refuses a payload marked prerelease, as its comment always claimed", () => {
    expect(parseLatestRelease({
      tag_name: "v1.4.0",
      html_url: "https://example.invalid/r",
      prerelease: true,
    })).toBeNull();
  });
});

describe("a clock that went backwards does not switch the check off (U-017)", () => {
  it("checks when the stored stamp is in the future", () => {
    const now = 1_700_000_000_000;
    expect(shouldAutoCheck(now, now + 60_000)).toBe(true);
    expect(shouldAutoCheck(now, now + 400 * 24 * 3600 * 1000)).toBe(true);
  });

  it("still throttles a stamp from a minute ago", () => {
    const now = 1_700_000_000_000;
    expect(shouldAutoCheck(now, now - 60_000)).toBe(false);
  });
});

/**
 * Update detection (Level 1 — detect only, no download/install).
 *
 * Silent auto-update via electron-updater is NOT possible for this app:
 * macOS rejects update payloads that are not signed with a real Apple
 * Developer ID certificate, and the project ships ad-hoc signatures.
 * Until that changes, this module answers one question — "is there a
 * newer release on GitHub?" — and the Settings UI links to the release
 * page. The user downloads it themselves, exactly as today, but without
 * having to poll the repo manually.
 *
 * SSOT: version + repo slug are injected at build time from
 * desktop/package.json (see vite.config.ts __APP_UPDATE_META__) — this
 * module never hard-codes either.
 *
 * Pure logic (version compare, release parsing, check scheduling) is
 * separated from network I/O so every rule is unit-tested; fetch is
 * injected.
 */

export interface UpdateMeta {
  version: string;
  /** "owner/repo" — GitHub releases API target. */
  repoSlug: string;
}

export interface LatestRelease {
  version: string;
  /** Human-facing release page (not the asset URL). */
  htmlUrl: string;
}

/**
 * Split a version into its numeric segments and its pre-release tag.
 *
 * "1.3.0-rc1" is 1.3.0 with the tag "rc1". Written out because the
 * segment-wise compare below used to see the string "0-rc1", whose
 * ``Number()`` is NaN, fall into the lexical branch, and conclude that
 * "1.3.0-rc1" is NEWER than "1.3.0" — offering the user a downgrade
 * from their release to a release candidate.
 */
function splitVersion(value: string): { numbers: number[]; pre: string } {
  const raw = String(value || "").trim();
  const cut = raw.search(/[-+]/);
  const core = cut === -1 ? raw : raw.slice(0, cut);
  const pre = cut === -1 ? "" : raw.slice(cut + 1);
  return { numbers: core.split(".").map((seg) => Number(seg)), pre };
}

/**
 * Compare two versions ("1.10.0" vs "1.9.2"). Returns >0 if a is newer.
 *
 * A pre-release is older than the release it leads to
 * ("1.3.0-rc1" < "1.3.0"), and two pre-releases of one version compare
 * lexically. A segment that is not a number compares lexically too.
 */
export function compareVersions(a: string, b: string): number {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  const len = Math.max(va.numbers.length, vb.numbers.length);
  for (let i = 0; i < len; i++) {
    const na = va.numbers[i] ?? 0;
    const nb = vb.numbers[i] ?? 0;
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
      continue;
    }
    const sa = String(va.numbers[i] ?? "0");
    const sb = String(vb.numbers[i] ?? "0");
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  if (va.pre === vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  return va.pre < vb.pre ? -1 : 1;
}

/**
 * Extract {version, htmlUrl} from a GitHub /releases/latest payload.
 *
 * Drafts and pre-releases are not supposed to reach that endpoint, and
 * both are refused here anyway — the previous code said "drafts and
 * prereleases" in its comment and checked only ``draft``, so the one
 * field that documents the case it did not check was the one it did not
 * read. A missing tag name or html_url yields null so callers treat it
 * as "unknown" rather than "up to date".
 */
export function parseLatestRelease(payload: unknown): LatestRelease | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as {
    tag_name?: unknown;
    html_url?: unknown;
    draft?: unknown;
    prerelease?: unknown;
  };
  if (obj.draft === true || obj.prerelease === true) return null;
  const rawTag = typeof obj.tag_name === "string" ? obj.tag_name.trim() : "";
  const htmlUrl = typeof obj.html_url === "string" ? obj.html_url : "";
  if (!rawTag || !htmlUrl) return null;
  // Tags conventionally carry a leading "v"; strip exactly one.
  const version = /^v/i.test(rawTag) ? rawTag.slice(1) : rawTag;
  if (!version) return null;
  return { version, htmlUrl };
}

/**
 * How long the GitHub call may take before it is abandoned.
 *
 * The module's other timing — ``CHECK_INTERVAL_MS`` — is named and
 * declared; this one was an inline literal in the middle of a fetch
 * options object, so "how long does the update check take at worst"
 * could not be answered by reading the two constants of the module.
 * A failed check is silent by design (``status: "unknown"``), so this
 * is a bound on a background request nobody is waiting for, not a
 * user-facing deadline.
 */
const REQUEST_TIMEOUT_MS = 8_000;

export type UpdateCheckResult =
  | { status: "update-available"; latest: LatestRelease }
  | { status: "up-to-date" }
  | { status: "unknown"; reason: string };

/** Run one check against GitHub. Network errors degrade to "unknown". */
export async function checkForUpdate(
  meta: UpdateMeta,
  fetchImpl: typeof fetch,
): Promise<UpdateCheckResult> {
  if (!meta.repoSlug) {
    return { status: "unknown", reason: "repository coordinates unavailable" };
  }
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${meta.repoSlug}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      return { status: "unknown", reason: `GitHub API responded ${res.status}` };
    }
    const latest = parseLatestRelease(await res.json());
    if (!latest) return { status: "unknown", reason: "unrecognised release payload" };
    if (compareVersions(latest.version, meta.version) > 0) {
      return { status: "update-available", latest };
    }
    return { status: "up-to-date" };
  } catch (e) {
    return {
      status: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Who asked for a check: the user's button, or the passive boot check. */
export type UpdateCheckTrigger = "user" | "boot";

/**
 * What the renderer does with a finished check (FU-17).
 *
 *   • `stamp` — whether it counts against the once-a-day throttle. Only
 *     an ANSWER does. Stamping every result meant an offline start (or a
 *     GitHub 403) switched the background check off for 24 hours having
 *     learned nothing.
 *   • `render` — whether the result is shown. The passive boot check is
 *     meant to be silent when it could not tell ("an offline start never
 *     nags"); it used to write "Couldn't check for updates (…)" into
 *     Settings like the button does.
 */
export function updateCheckOutcome(
  result: UpdateCheckResult,
  trigger: UpdateCheckTrigger,
): { stamp: boolean; render: boolean } {
  const answered = result.status !== "unknown";
  return { stamp: answered, render: answered || trigger === "user" };
}

/**
 * Throttle rule for the passive boot-time check: at most once per day.
 *
 * A stamp in the FUTURE is not a throttle, it is a broken clock — a
 * machine whose time was set forward and then corrected, or a timezone
 * change on a system that stores local time. The stamp outlives
 * restarts in localStorage, so treating "now minus a future stamp" as a
 * negative interval switched the background check off permanently. The
 * first line of this function already refused NaN and zero; a stamp
 * that cannot have happened yet is the third way of being unusable.
 */
export function shouldAutoCheck(nowMs: number, lastCheckedMs: number): boolean {
  if (!Number.isFinite(lastCheckedMs) || lastCheckedMs <= 0) return true;
  if (lastCheckedMs > nowMs) return true;
  return nowMs - lastCheckedMs >= CHECK_INTERVAL_MS;
}

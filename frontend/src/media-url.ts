/**
 * Streaming a saved recording into an `<audio>` element (S-15).
 *
 * History used to GET the whole audio file with the API token in a
 * header and play it from a Blob: an uploaded video's audio — hundreds of
 * MB — sat in renderer memory before playback could start. A media
 * element streams (and seeks with Range requests) only from a URL, and it
 * cannot send a header; the API token must never be put in a URL (BM-01).
 * So the backend mints a URL carrying a capability for that one file, for
 * a few minutes (backend/media_tokens.py has the threat model).
 *
 * The element makes its own requests for as long as the recording is
 * open: a seek after the capability expired is answered 401 and surfaces
 * as a media error. That one case is recoverable — mint again and resume
 * where playback was. Any other error (a fresh URL that fails) is a real
 * failure and is reported as one.
 */

export interface MintedMediaUrl {
  url: string;
  /** When the backend stops honouring `url` (epoch ms). */
  expiresAtMs: number;
}

/**
 * A request issued just before the expiry can reach the backend just after
 * it; an error this close to the expiry is treated as an expiry.
 */
export const MEDIA_URL_EXPIRY_SLACK_MS = 5_000;

/** The mint route's answer `{url, expires_at}` (epoch seconds), checked. */
export function parseMintedMediaUrl(raw: unknown): MintedMediaUrl {
  const r = (raw && typeof raw === "object" ? raw : {}) as { url?: unknown; expires_at?: unknown };
  const url = typeof r.url === "string" ? r.url : "";
  const expiresAtSec = Number(r.expires_at);
  // Same-origin path only: the URL comes from our backend and is put into
  // a media element's src.
  if (!url.startsWith("/api/recordings/") || !Number.isFinite(expiresAtSec) || expiresAtSec <= 0) {
    throw new Error("The backend returned no playable audio URL.");
  }
  return { url, expiresAtMs: expiresAtSec * 1000 };
}

/** What a media error on a minted URL calls for. */
export function mediaErrorRecovery(minted: MintedMediaUrl | null, nowMs: number): "remint" | "fail" {
  if (!minted) return "fail";
  return nowMs >= minted.expiresAtMs - MEDIA_URL_EXPIRY_SLACK_MS ? "remint" : "fail";
}

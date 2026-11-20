/**
 * How a recording is named from its own transcript (SSOT).
 *
 * There were two implementations of this rule and they disagreed. The
 * stop path normalised whitespace, capped the result and fell back to
 * the date when there was no text; the Re-transcribe path in History did
 * none of the three. So a recording whose first eight words run past 80
 * characters — compound German, a pasted URL, dictated base64 — came out
 * of Re-transcribe with a title longer than `stopLive` has ever produced,
 * and Re-transcribe on an empty result named it "". Which name an
 * archive entry ended up with depended on which path produced its text,
 * which is not something a user can see or predict.
 *
 * Pure: no DOM, no clock. Unit-tested in tests/recording-title.test.ts.
 */

/** Words kept from the start of the transcript. */
export const SMART_TITLE_MAX_WORDS = 8;
/**
 * Character ceiling, ellipsis included.
 *
 * The list renders one line per recording, and a title that outruns it
 * is truncated by CSS anyway — but the stored title (the transcript's
 * `Title:` line) is also what search matches, so it is capped at the
 * source rather than only in the view. It is metadata only: the archive
 * file name is the recording's time (`backend/recording_names.py`).
 */
export const SMART_TITLE_MAX_CHARS = 80;

/**
 * @param text the transcript to name the recording after
 * @param fallback used when the transcript has no words at all — the
 *   caller's own default, normally "Recording <date>"
 */
export function smartRecordingTitle(text: string, fallback: string): string {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return fallback;
  const preview = words.slice(0, SMART_TITLE_MAX_WORDS).join(" ");
  return preview.length > SMART_TITLE_MAX_CHARS
    ? `${preview.slice(0, SMART_TITLE_MAX_CHARS - 3)}...`
    : preview;
}

/**
 * What actually produced the live text, said beside the model select.
 *
 * The select is a request, not a report: it keeps saying Deepgram while the
 * desk, holding no key, recognises locally. Measured 2026-11-25 — a session
 * with no Deepgram key came back with `source: "local-assist"` while the pane
 * read "Deepgram nova-3", and the owner read the result as "Deepgram works,
 * the wrong words are Deepgram's fault". A note that names the source is the
 * difference between a mystery and a fact.
 */

/** The sources a live session can report, as the wire names them. */
export type LiveSource = "local-assist" | "deepgram-stream" | string;

/** The provider the user picked, as the select stores it. */
export type ChosenProvider = "deepgram" | "openrouter" | "local-whisper" | "gigaam" | string;

/**
 * The line to show, or "" when the pane's own labels already tell the truth.
 *
 * Silent when the chosen provider is the one that ran, and silent when the
 * choice was local in the first place: a note on every recording is noise.
 */
export function liveSourceNote(source: LiveSource, chosen: ChosenProvider): string {
  if (!source) return "";
  if (source === "deepgram-stream") {
    return chosen === "deepgram" ? "" : "Recognised by Deepgram live.";
  }
  if (source === "local-assist") {
    if (chosen === "local-whisper" || chosen === "gigaam") return "";
    return (
      "Recognised on this machine: no key for the selected provider, so nothing " +
      "was sent to it. Add the key in Settings to use it."
    );
  }
  return "";
}

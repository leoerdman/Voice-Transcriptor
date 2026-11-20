/**
 * Is a published recording output a transcript the desktop shell may
 * paste? — pure.
 *
 * Decided from what the publisher SAYS the output is (its ``kind``), never
 * from the words. The rule used to sniff the text — reject "error",
 * "[websocket error]", "[silence]" and anything starting with "http " —
 * because error placeholders once travelled through the same field as
 * transcripts. They no longer do: every error and status is published
 * with its own kind ("error" / "status") and an empty paste text. What
 * the sniffing still did was throw away real dictations: «HTTP server
 * returns 500 on login» was never pasted (Ultra-Audit 2026-11-20 DM-01,
 * renderer half; the desktop half was removed in the same audit).
 */

export type RecordingOutputKind = "" | "transcript" | "status" | "error";

export function recordingOutputIsPasteReady(output: { pasteText: string; kind: RecordingOutputKind }): boolean {
  return output.kind === "transcript" && output.pasteText.trim().length > 0;
}

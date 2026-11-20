/**
 * Upload queue item decisions that are not DOM: what a finished-but-not-
 * saved item still holds, what Retry should redo, and what the queue row
 * and the result pane show for it.
 *
 * FQ-01 / FQ-05. When the transcription job succeeds and the History save
 * fails (archive unwritable, disk full, a 4xx from the save route), the
 * processor deliberately keeps the transcript on the item (``item.text``)
 * and says "Transcript finished, but History save failed". Nothing read it
 * back: the error row and the result pane rendered only the error line,
 * with no Copy, so a paid or minutes-long transcription was unreachable
 * exactly when storage was failing — and Retry wiped the text and ran the
 * whole transcription again (a second provider charge, under whatever
 * provider/model the UI showed by then). The kept transcript is now
 * shown and copyable, Retry re-runs only the save, and "Clear done" does
 * not throw it away.
 */

export type UploadItemStatus = "queued" | "transcribing" | "done" | "error" | "cancelled";

export interface UploadItemSaveState {
  status: UploadItemStatus;
  text?: string;
  savedName?: string;
}

/** A transcript the job produced that never reached History. */
export function uploadTranscriptAwaitingSave(item: UploadItemSaveState): boolean {
  return item.status === "error" && !!String(item.text || "").trim() && !String(item.savedName || "").trim();
}

/** What Retry redoes: only the History save when the transcript is held,
 *  the whole transcription otherwise. */
export function uploadRetryPlan(item: UploadItemSaveState): "save" | "transcribe" {
  return uploadTranscriptAwaitingSave(item) ? "save" : "transcribe";
}

/** "Clear done" drops finished items, never a transcript that exists
 *  nowhere else. Removing one row (×) stays an explicit choice. */
export function isUploadClearable(item: UploadItemSaveState): boolean {
  const terminal = item.status === "done" || item.status === "error" || item.status === "cancelled";
  return terminal && !uploadTranscriptAwaitingSave(item);
}

export interface UploadErrorView {
  /** The error line. */
  error: string;
  /** The held transcript, or "" when there is none to show. */
  transcript: string;
  /** Offer Copy (only when there is a transcript). */
  copyable: boolean;
}

/** What an item in the error state shows, in the row and in the pane. */
export function uploadErrorView(item: UploadItemSaveState & { error?: string }): UploadErrorView {
  const transcript = uploadTranscriptAwaitingSave(item) ? String(item.text || "").trim() : "";
  return { error: String(item.error || ""), transcript, copyable: !!transcript };
}

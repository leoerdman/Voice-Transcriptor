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

/**
 * The next item the processor starts: the OLDEST queued one. The queue
 * is displayed newest-first (each enqueue inserts at the top), and the
 * pump used to take the first queued match from the top — so a batch
 * A, B, C ran C first, and a later batch overtook an earlier one (FQ-08).
 */
export function pickNextQueuedUpload<T extends { status: UploadItemStatus }>(newestFirst: readonly T[]): T | undefined {
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    if (newestFirst[i].status === "queued") return newestFirst[i];
  }
  return undefined;
}

/** The lower-cased extension of a file name or path leaf; "" when none. */
function uploadExtensionFromName(name: string): string {
  const leaf = String(name || "").split(/[\\/]/).filter(Boolean).pop() || "";
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0 || dot >= leaf.length - 1) return "";
  return leaf.slice(dot + 1).toLowerCase();
}

/**
 * The one "can this source be uploaded?" rule, for a dropped File and for
 * a remembered path alike (FQ-11: it was written twice, and the two
 * copies had already drifted in wording). ``allowedExts`` empty means
 * the backend's list has not been hydrated yet; the backend revalidates
 * every upload, so the extension check is skipped rather than guessed.
 */
export function uploadSourceValidationError(input: {
  name: string;
  sizeBytes: number;
  capBytes: number;
  allowedExts: ReadonlySet<string>;
  formatBytes: (bytes: number) => string;
}): string {
  if (input.capBytes > 0 && input.sizeBytes > input.capBytes) {
    return `File too large (${input.formatBytes(input.sizeBytes)} > ${input.formatBytes(input.capBytes)} cap).`;
  }
  const ext = uploadExtensionFromName(input.name);
  if (!ext) {
    return "Unsupported file type. Choose an audio or video file with a supported extension.";
  }
  if (input.allowedExts.size > 0 && !input.allowedExts.has(ext)) {
    return `Unsupported file type ".${ext}". Choose an audio or video file.`;
  }
  return "";
}

/** "Queue · 3 done · 2 failed": failed and cancelled items are not "done" (FQ-16). */
export function uploadQueueTitle(statuses: readonly UploadItemStatus[]): string {
  if (!statuses.length) return "Queue";
  const done = statuses.filter((s) => s === "done").length;
  const failed = statuses.filter((s) => s === "error").length;
  const cancelled = statuses.filter((s) => s === "cancelled").length;
  const parts = [`${done}/${statuses.length} done`];
  if (failed) parts.push(`${failed} failed`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  return `Queue · ${parts.join(" · ")}`;
}

/** Retry is offered for a failed item and for a cancelled one (FQ-22):
 *  a cancelled file used to have to be dropped again. */
export function uploadItemRetryable(status: UploadItemStatus): boolean {
  return status === "error" || status === "cancelled";
}

/** What an item in the error state shows, in the row and in the pane. */
export function uploadErrorView(item: UploadItemSaveState & { error?: string }): UploadErrorView {
  const transcript = uploadTranscriptAwaitingSave(item) ? String(item.text || "").trim() : "";
  return { error: String(item.error || ""), transcript, copyable: !!transcript };
}

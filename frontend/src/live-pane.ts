/**
 * Display contract for the Live Preview pane (#liveOutput).
 *
 * Three states, one function:
 *   1. Preview ON   → transcript text is rendered by the caller (this
 *      module does not touch transcript state).
 *   2. Preview OFF + active recording → a status line proving capture
 *      is alive and naming where the transcript will land ("если я
 *      live превью отключаю, то не знаю, что происходит"). The clock
 *      reuses ``liveTimerText`` — the app's single recording clock.
 *   3. Otherwise → empty string; the pane's CSS data-placeholder
 *      ("Waiting for audio...") shows through.
 *
 * Pure: no DOM, no globals. Unit-tested in tests/live-pane.test.ts and
 * imported by main.tsx's rAF-coalesced renderer.
 */

/**
 * The preview-off states only: with preview on the caller renders the
 * transcript itself and never calls this. (It used to take a
 * ``previewEnabled`` flag whose only legal value was ``false`` and throw
 * on ``true`` — FL-21; the illegal state is now unrepresentable.)
 */
export interface LivePaneInput {
  /** A recording is currently capturing audio. */
  recording: boolean;
  /** The first capture frame has been timestamped (startAt > 0). */
  started: boolean;
  /** Elapsed time formatted by the app's single clock (``fmtTime``), e.g. "00:42". */
  timerText: string;
}

export const LIVE_PANE_STATUS_PREFIX = "● Recording";

export function livePaneDisplayText(input: LivePaneInput): string {
  if (input.recording && input.started) {
    return `${LIVE_PANE_STATUS_PREFIX} ${input.timerText} — live preview is off; the transcript will appear here after Stop.`;
  }
  return "";
}

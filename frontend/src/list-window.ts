/**
 * Windowing policy for the History list (SSOT).
 *
 * The archive is unbounded — a heavy user reaches several thousand
 * recordings — and every filtered item used to get its own DOM row.
 * At ~5900 recordings that is ~35 000 nodes the renderer builds, styles
 * and keeps resident for a list of which the user can see about twenty.
 *
 * Windowing bounds the DOM without changing what the list *means*:
 * search, keyboard navigation and selection all continue to operate over
 * the complete filtered set. Only how much of it is materialised is
 * capped, and the cap grows as the user scrolls toward the end.
 *
 * Two rules make the window safe to reason about:
 *
 *   * It never hides the selected row. `moveRecordingSelection` finds
 *     the row by key and focuses it — and focus() is what scrolls it
 *     into view — so a selection outside the window would silently do
 *     nothing. The window always extends far enough to contain it.
 *   * It only ever grows within a render cycle. Shrinking is an explicit
 *     `reset` — on a new search or a fresh load — so scrolling back up
 *     never destroys rows the user just scrolled past.
 *
 * Pure module: no DOM, no globals, fully unit-testable.
 */

/** Rows materialised on first paint of a list. */
export const RECORDINGS_WINDOW_MINIMUM = 200;
/** Rows added each time the user reaches the growth threshold. */
export const RECORDINGS_WINDOW_CHUNK = 200;
/** Distance from the bottom, in px, at which the window grows. */
const RECORDINGS_WINDOW_GROW_THRESHOLD_PX = 400;

export interface WindowRequest {
  /** Size of the full filtered set. */
  total: number;
  /** Window carried over from the previous render. */
  current: number;
  /** Floor for a freshly reset window. */
  minimum: number;
  /** Index of the selected row in the filtered set, or -1. */
  selectedIndex: number;
}

/**
 * Resolve how many rows to materialise.
 *
 * Clamped to `[minimum, total]`, never below what is needed to include
 * `selectedIndex`, and never below `current` — growth within a list is
 * monotonic.
 */
export function resolveWindowSize(request: WindowRequest): number {
  const total = Math.max(0, Math.floor(request.total));
  if (total === 0) return 0;
  const minimum = Math.max(1, Math.floor(request.minimum));
  const current = Math.max(0, Math.floor(request.current));
  let size = Math.max(minimum, current);
  if (request.selectedIndex >= 0) {
    size = Math.max(size, request.selectedIndex + 1);
  }
  return Math.min(total, size);
}

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * True when the viewport is close enough to the end to warrant growth.
 *
 * A list shorter than its viewport (`scrollHeight <= clientHeight`)
 * reports `scrollTop === 0` and would otherwise read as "at the bottom"
 * forever, growing the window on every scroll event for no reason.
 */
export function shouldGrowWindow(
  metrics: ScrollMetrics,
  thresholdPx: number = RECORDINGS_WINDOW_GROW_THRESHOLD_PX,
): boolean {
  const { scrollTop, clientHeight, scrollHeight } = metrics;
  if (!Number.isFinite(scrollTop) || !Number.isFinite(clientHeight)) return false;
  if (!Number.isFinite(scrollHeight)) return false;
  if (scrollHeight <= clientHeight) return false;
  return scrollHeight - (scrollTop + clientHeight) <= Math.max(0, thresholdPx);
}

/** Next window size after a growth trigger, clamped to the total. */
export function grownWindowSize(
  current: number,
  total: number,
  chunk: number = RECORDINGS_WINDOW_CHUNK,
): number {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeCurrent = Math.max(0, Math.floor(current));
  const step = Math.max(1, Math.floor(chunk));
  return Math.min(safeTotal, safeCurrent + step);
}

/**
 * Human-readable coverage line, or "" when the whole set is shown.
 *
 * A silently truncated list reads as data loss; saying how much is
 * rendered out of how many is what makes the window honest.
 */
export function windowStatusText(rendered: number, total: number): string {
  if (total <= 0 || rendered >= total) return "";
  return `Showing ${rendered} of ${total}`;
}

export interface WindowResetInput {
  /** The archive directory changed, so this is a different list entirely. */
  directoryChanged: boolean;
  /** Keys of the rows that were materialised before the load. */
  previousWindowKeys: ReadonlyArray<string>;
  /** Keys of every row the new payload contains. */
  nextKeys: ReadonlyArray<string>;
}

/**
 * Does a completed load replace the list, or refresh it?
 *
 * The window used to be reset on EVERY load, including the background
 * refresh that runs after each save — so the keyed reconciler preserved
 * the DOM nodes and the reset deleted them one line later, and a user who
 * had scrolled through five hundred rows was thrown back to the top by an
 * event they did not cause. The mechanism worked; the symptom it was
 * written against survived intact.
 *
 * "Replaces the list" is true when the archive directory changed, and
 * when nothing that was on screen is in the new payload — a set with no
 * overlap is a different list, and a window measured against the old one
 * describes nothing. Anything else is the same list with items added or
 * removed, and the position the user scrolled to still means what it
 * meant.
 */
export function shouldResetWindowAfterLoad(input: WindowResetInput): boolean {
  if (input.directoryChanged) return true;
  if (input.previousWindowKeys.length === 0) return true;
  const next = new Set(input.nextKeys);
  return !input.previousWindowKeys.some((key) => next.has(key));
}

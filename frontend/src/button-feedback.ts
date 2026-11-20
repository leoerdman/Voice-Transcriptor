/**
 * "It worked" on the button the user just pressed.
 *
 * There were two of these. History's and the Result pane's Copy buttons
 * flashed classes plus `aria-label`/`title` for 900 ms; Upload's
 * per-item Copy swapped its visible text for 1200 ms with its own
 * `setTimeout`. One gesture, two mechanics, two durations — and the
 * text-swapping one had no way to say "Copy failed" to a screen reader
 * while the class-swapping one had no visible label at all.
 *
 * Both bugs of the surviving implementation are fixed here rather than
 * carried over:
 *
 *  - it read the labels to restore out of the LIVE element, where a
 *    previous flash had already written "Copied", so a second click
 *    inside the window restored "Copied" as if it were the resting
 *    state — permanently, to anyone using a screen reader;
 *  - it never kept the timer handle, so the first flash's restore still
 *    fired after the second flash had begun.
 *
 * The duration is `UI_TOKENS.feedback.flashMs`, passed in: this module
 * is about the mechanism, and the number belongs with the app's other
 * numbers.
 */

import { UI_COPY } from "./ui-copy";

interface ButtonRestoreState {
  timer: number;
  aria: string;
  title: string;
  /** null when the caller is not swapping the visible label. */
  text: string | null;
}

/**
 * Module-scoped and keyed by the element, so a re-render that drops the
 * button drops its entry too — the queue rebuilds its rows on every
 * progress tick.
 */
const restoreByButton = new WeakMap<HTMLButtonElement, ButtonRestoreState>();

export interface FlashOptions {
  /** How long the confirmation stays up. */
  durationMs: number;
  /** Also replace the button's visible text (text buttons). */
  swapLabel?: boolean;
  /** Injected for tests; defaults to the window timers. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/**
 * Flash the outcome of a Copy. The outcome is a boolean, and the
 * label and the visual state are both derived from it.
 *
 * The outcome used to be encoded in the label: the label-only entry
 * point (deleted with its last callers, the Upload Copy buttons) chose
 * the success or failure style by comparing its text argument to the
 * literal "Copied", so any rewording (or translation) of that word would
 * have turned every success into the failure style.
 */
export function flashCopyOutcome(
  btn: HTMLButtonElement,
  ok: boolean,
  restingLabel: string,
  options: FlashOptions,
): void {
  flash(btn, ok, ok ? UI_COPY.copyFeedback.ok : UI_COPY.copyFeedback.failed, restingLabel, options);
}

function flash(
  btn: HTMLButtonElement,
  ok: boolean,
  flashLabel: string,
  restingLabel: string,
  options: FlashOptions,
): void {
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));

  const pending = restoreByButton.get(btn);
  if (pending) clearTimer(pending.timer);
  const state: ButtonRestoreState = pending ?? {
    timer: 0,
    aria: btn.getAttribute("aria-label") || restingLabel,
    title: btn.title || restingLabel,
    text: options.swapLabel ? btn.textContent : null,
  };

  btn.classList.remove("is-copy-ok", "is-copy-failed");
  btn.classList.add(ok ? "is-copy-ok" : "is-copy-failed");
  btn.setAttribute("aria-label", flashLabel);
  btn.title = flashLabel;
  if (options.swapLabel) btn.textContent = flashLabel;

  state.timer = setTimer(() => {
    restoreByButton.delete(btn);
    btn.classList.remove("is-copy-ok", "is-copy-failed");
    btn.setAttribute("aria-label", state.aria);
    btn.title = state.title;
    if (state.text !== null) btn.textContent = state.text;
  }, options.durationMs);
  restoreByButton.set(btn, state);
}

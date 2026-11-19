/**
 * What a press on an empty slot asks of the person pressing it.
 *
 * This used to be nothing: the press quietly enrolled from the newest
 * recording in the archive, so the card said "Keep" and the user's last
 * meeting became their voice — including everyone else in the room. The
 * fix is not a nicer message, it is a recording the user makes on purpose,
 * and a recording needs three facts stated before it starts: what to say,
 * how long they have, and what they will see while it runs.
 *
 * Everything here is arithmetic over those three facts so the card, the
 * countdown and the tests cannot disagree about them.
 */

/** How long a press gets, in seconds. */
export const ENROL_SECONDS = 6;

/**
 * The shortest capture the backend will embed.
 *
 * `voice_enrol.enrol_windows` refuses a take shorter than the mask's 2 s
 * window rather than padding it, so a countdown that could end below this
 * would produce a press that was always going to be refused.
 */
export const ENROL_MIN_SECONDS = 2;

/**
 * The line to read, and the only place it is written.
 *
 * Fourteen words is about six seconds at a speaking pace, it stays inside one
 * line of the card at 360 px, and it is long enough to hold voiced windows
 * across the whole capture — a single "hello" leaves the tail of the take
 * silent, and silence averages the room into the profile.
 */
export const ENROL_SCRIPT =
  "This is my voice. Keep me in the room and leave everyone else out.";

/** The number as the card says it, so markup and countdown cannot drift. */
export function enrolSecondsText(seconds: number = ENROL_SECONDS): string {
  return `${seconds} seconds`;
}

/**
 * What the press is about to do, in one sentence.
 *
 * Rendered into `#voiceEnrolExpectation` at boot from the constant above: the
 * markup carries the same sentence so the card documents itself before any
 * fetch answers, and a test keeps the two in step.
 */
export function enrolExpectationText(seconds: number = ENROL_SECONDS): string {
  return (
    `Press Keep on an empty row and read the line below out loud: ` +
    `${enrolSecondsText(seconds)} of your voice, once. The dot pulses and the ` +
    `seconds count down while the microphone is open, exactly as they do for a ` +
    `take. The capture is measured for the mask and thrown away — it never ` +
    `appears in History.`
  );
}

export interface EnrolLiveView {
  /** Whole seconds left, never below zero. */
  remainingSec: number;
  /** Whether anything is being captured right now. */
  recording: boolean;
  /** The line under the card: what is happening and how much is left. */
  caption: string;
  /** Whether the press can still be salvaged if it stops now. */
  enough: boolean;
}

/**
 * The countdown, from how long the microphone has been open.
 *
 * `ceil`, not `round`: a clock that says "0 s left" while it is still
 * capturing is a clock that lies about the one number the user is watching.
 * The caption switches to "Done" at zero so the last frame is not a capture
 * that looks finished but reads "1 s left".
 */
export function enrolLiveView(
  elapsedMs: number,
  label: string,
  seconds: number = ENROL_SECONDS,
): EnrolLiveView {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const total = Math.max(1, Math.round(seconds));
  const remainingSec = Math.max(0, total - Math.floor(elapsed / 1000));
  const recording = elapsed < total * 1000;
  const caption = recording
    ? `Recording ${label} — ${remainingSec} s left`
    : `Recording ${label} — done, measuring`;
  return {
    remainingSec,
    recording,
    caption,
    // The backend refuses under two seconds; the card says so before the
    // microphone closes rather than after the refusal comes back.
    enough: elapsed >= ENROL_MIN_SECONDS * 1000,
  };
}

/**
 * What the card says when the microphone never opened.
 *
 * A press that produces no row and no line reads as a switch that did
 * nothing; this is the fallback for a failure nobody classified.
 */
export const ENROL_NO_MIC =
  "The microphone did not open. Allow it for this app, then press the switch again.";

/**
 * The page's own situation, as only the page can see it.
 *
 * A granted site permission and a `NotAllowedError` are not a contradiction:
 * a frame needs the embedding page to hand the microphone down, a window that
 * is not a secure context has no capture at all, and a permission the browser
 * reports as `denied` is a different fix from one it reports as `granted`.
 * The sentence cannot name the right action without these three.
 */
export interface MicContext {
  /** `window.self !== window.top`: the page is drawn inside another window. */
  framed: boolean;
  /** `window.isSecureContext`: false means capture is impossible here. */
  secure: boolean;
  /** `navigator.permissions` state for the microphone: granted/denied/prompt/unavailable. */
  permission: string;
  /** The page is drawn by an Electron app, whose own permission handler decides. */
  electron: boolean;
}

/**
 * The same failure, classified.
 *
 * A browser refuses in several ways and they need different actions: a frame
 * to leave, a secure context to reach, a site permission to clear, a device to
 * plug in, an app to close. One sentence for all of them sent the user looking
 * for a setting that was not the problem.
 */
export function enrolMicErrorText(
  error: unknown,
  origin: string,
  context?: MicContext,
): string {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name || "")
      : "";

  // The frame comes first: a granted permission is useless inside one, and
  // this is the only failure the page can name itself.
  if (context?.framed) {
    return (
      `This page is shown inside another window's frame, and a frame cannot use ` +
      `the microphone. Open ${origin} in its own browser tab, then press the switch again.`
    );
  }
  if (context && !context.secure) {
    return (
      `This page is not a secure context (${origin}), so the browser will not open ` +
      "a microphone here. Open it as 127.0.0.1 or over https, then press the switch again."
    );
  }

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      // Granted but still refused is the webview case: the window that hosts
      // the page has its own answer, and clearing the site permission will
      // not change it.
      if (context?.permission === "granted") {
        return (
          `The browser already allows the microphone for ${origin}, and still ` +
          "refused to open it: this window is hosted by an app that decides for itself. " +
          `Open ${origin} in a browser tab, then press the switch again.`
        );
      }
      if (context?.permission === "denied") {
        // Two surfaces, two fixes. An Electron app keeps no site settings to
        // clear; a browser profile has the block written in them, and the
        // address bar is where it comes off.
        if (context.electron) {
          return (
            `The microphone is blocked for ${origin} in this window. This window is an ` +
            `Electron app's panel, and its microphone is that app's decision — no site ` +
            `setting here can change it. Open ${origin} in Chrome, where the site permission ` +
            "lives, and press the switch again."
          );
        }
        return (
          `The microphone is blocked for ${origin} in this browser profile. Open the ` +
          `site settings from the address bar, set Microphone to Allow, reload the page, ` +
          "then press the switch again."
        );
      }
      return (
        `The browser refused the microphone for ${origin}. Allow it for this site, ` +
        "then press the switch again."
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone is connected. Plug one in, then press the switch again.";
    case "NotReadableError":
    case "TrackStartError":
      return (
        "Another app is holding the microphone. Close it, then press the switch again."
      );
    default:
      return (
        `${ENROL_NO_MIC} This page is ${origin}; if it is shown inside another ` +
        "window, open it in a browser tab instead."
      );
  }
}

/**
 * The page has no capture API at all — no permission to grant, nothing to fix
 * from here: the window that hosts it does not expose one.
 */
export const ENROL_NO_CAPTURE_API =
  "This window has no microphone API: open the desk in a browser tab, where the " +
  "microphone can be allowed, then press the switch again.";

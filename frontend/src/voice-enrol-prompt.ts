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
 * nothing; this is the one message that names the permission to grant.
 */
export const ENROL_NO_MIC =
  "The microphone did not open. Allow it for this app, then press the switch again.";

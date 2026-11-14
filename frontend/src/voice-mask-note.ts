/**
 * The line of state a refused voice leaves in the pane (§5.3, §5.4).
 *
 * The mask zeroes a window in the copy that goes to the provider, which
 * in the transcript is indistinguishable from speech the app lost. §5.4
 * is explicit that silence reads as a lost utterance, and that a line of
 * state costs less than one: this module is that line's only writer, so
 * what the pane says about a withheld voice is decided in one place and
 * tested without a DOM.
 *
 * Three rules, in order:
 *   1. A gate that gave up says so. It forwarded audio it never judged —
 *      the opposite of a refusal — and hiding that would be a second,
 *      worse silence.
 *   2. A refusal says how much, and says where the audio still is. The
 *      recording keeps every byte (§1.4); only the provider never saw
 *      them. Without that half the line reads as data loss.
 *   3. Nothing withheld, nothing drawn. The pane carries one line less
 *      rather than a permanent note over a recording that went fine.
 *
 * Pure: no DOM, no globals. Unit-tested in tests/voice-mask-note.test.ts
 * and imported by main.tsx's ws message handler.
 */

/** What the backend reports on the ``voice-mask`` event, per hop of state. */
export interface VoiceMaskState {
  /** ``"idle"`` before any verdict about a voice, then open or closed. */
  state: "idle" | "open" | "closed";
  /** Seconds of audio this gate zeroed on purpose. */
  withheldSec: number;
  /** The gate fell behind and forwarded audio unmasked. */
  degraded: boolean;
  /** The recording's total: sent at stop, after the last flush. */
  final: boolean;
}

export function formatWithheld(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (safe > 0 && safe < 0.1) return "under 0.1 s";
  return `${safe.toFixed(1)} s`;
}

export function voiceMaskNoteText(state: VoiceMaskState): string {
  const withheld = formatWithheld(state.withheldSec);
  const refused = state.withheldSec > 0;

  if (state.degraded) {
    // The one message that must never be optimised away: from here on,
    // everything was sent without a judgement. What was refused before
    // that point still was, so both halves are stated.
    const before = refused
      ? ` ${withheld} was withheld before that.`
      : "";
    return `Voice mask fell behind and the rest of this recording was sent unmasked.${before}`;
  }

  if (!refused) return "";

  if (state.final) {
    // "not sent", not "not transcribed": what the mask withholds never
    // reached the provider, and the recording still holds every byte of
    // it (§1.4). Claiming more than that would be the pane's own bug.
    return `Voice mask withheld ${withheld} of another voice. It is still in the recording; it was not sent.`;
  }

  return `Voice mask is withholding another voice — ${withheld} so far.`;
}

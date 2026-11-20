/**
 * How a stop ends — the decisions ``stopLive`` takes after the capture is
 * torn down, kept out of the 1 700-line function so they can be run and
 * tested on every input instead of being claims about its source text.
 *
 * ── Is this session empty? (``decideDrainedSilence``) ─────────────────
 *
 * The mic-health tracker's terminal state (``silent`` / ``muted`` /
 * ``lost``) exists to EXPLAIN an empty session: "the microphone was
 * muted", not the generic "no speech detected". It was also applied as a
 * VETO on a non-empty one: a headset unplugged after two minutes of
 * dictation ended the tracker in ``lost``, and the stop then wrote
 * "[ Mic not delivering audio ]" over everything that had been captured —
 * no transcript, nothing pasted — although the auto-stop on a lost track
 * exists precisely to hand over "a clean transcript up to the disconnect
 * point". The health state may only explain an empty session, never
 * overrule the evidence that the session held speech.
 */

export interface DrainedSilenceInput {
  /** ``captureSilenceSnapshot(...).silentCapture`` — the session's own
   *  measured verdict (digital silence, or nothing above its noise floor
   *  on a recording too short to trust). Absent when no provider runs. */
  silentCapture: boolean;
  /** A transcription provider is configured for this stop. */
  hasProvider: boolean;
  /** The mic-health tracker ended in a state the stop copy names as the
   *  capture hardware's fault (``STOP_COPY`` membership). */
  micHealthBad: boolean;
  /** ``summarizeCaptureLevel(...).carriedSpeech`` — at least one frame of
   *  this session rose above the room it recorded. */
  carriedSpeech: boolean;
  /** The live transcript the provider streamed back during the session. */
  liveText: string;
}

export interface DrainedSilenceDecision {
  /** End the stop as an empty session: no transcription pass runs. */
  silent: boolean;
  /** The emptiness is the microphone's fault (copy and tone say so). */
  micFault: boolean;
}

export function decideDrainedSilence(input: DrainedSilenceInput): DrainedSilenceDecision {
  const heldSpeech = input.carriedSpeech || !!String(input.liveText || "").trim();
  const micExplainsEmptiness = input.hasProvider && input.micHealthBad && !heldSpeech;
  const silent = input.silentCapture || micExplainsEmptiness;
  return { silent, micFault: silent && input.micHealthBad };
}

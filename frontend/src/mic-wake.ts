/**
 * Is the microphone delivering sound yet, or only its first dead frames?
 *
 * A Bluetooth headset opens its microphone in two steps. The headset has
 * to leave its music profile for the call profile (SCO/HFP) and bring
 * the radio link up in that direction. Chromium does not wait for this:
 * ``getUserMedia`` resolves, the capture graph runs and the worklet
 * delivers frames — every one of them the exact digital silence, every
 * sample 0, until the link is up. The measured lengths run from a few
 * hundred ms up to 2.2 s on a headset that has been idle for minutes
 * (Leo Liberty 5 BT, 2026-11-23: 20261123-033204.wav and -033311.wav
 * start with 2181 / 2175 ms of int16 == 0; the log's ``first-frame``
 * fires on the first of those dead frames, ~0.5 s after the press).
 *
 * Whatever the user says in that time is not in the recording and cannot
 * be got back: there are no samples to recover. What can be honest is
 * the app's own signal. The start tone sounds at the press, and the
 * capsule says "recording", while the microphone is not hearing anyone.
 * This module is the one answer to "has the microphone woken": its
 * first frame with a sample the canonical audio can represent. The
 * renderer uses it for the capsule's state and for a second tone — the
 * "now speak" one — only when the take did begin dead.
 *
 * No timers and no thresholds in time: the verdict is the audio itself.
 * A real microphone never delivers exact zeros for long (its own noise
 * floor, after the 16-bit quantisation the canonical file goes through,
 * is a few LSB); a headset that has woken shows |x| of 5–50 in silence.
 * A device that really outputs digital silence forever (a gated virtual
 * input) keeps the take in "waking" — which is a status, never a gate on
 * the recording itself: every frame is recorded either way.
 */

/**
 * Smallest peak that survives the quantisation to the canonical 16-bit
 * audio as a non-zero sample. The same rounding ``pushCapturedFrame``
 * applies when it encodes the live socket's PCM16 (``Math.round(x *
 * 0x7fff)``), so "dead" here means "int16 == 0 in the recording".
 */
export const MIC_ALIVE_PEAK = 0.5 / 0x7fff;

/** What one observed frame did to the microphone's state. */
export interface MicWakeObservation {
  /** True while the take has not yet delivered a frame with sound. */
  waking: boolean;
  /**
   * True on the one frame that ends a wake the take began in — the
   * first live frame after at least one dead one. Never true for a
   * take whose very first frame was live.
   */
  justWoke: boolean;
  /**
   * Audio duration of the dead frames before the first live one, ms. It
   * is also what the recording's leading zeros amount to.
   */
  silentMs: number;
  /** True on the very first frame of the take, when it was dead. */
  beganDead: boolean;
}

export interface MicWakeTracker {
  /** Feed one captured frame: its peak magnitude and its audio duration. */
  observe(peak: number, frameMs: number): MicWakeObservation;
  /** Still waiting for the first live frame (after at least one frame). */
  readonly waking: boolean;
  /** Dead audio so far, ms. */
  readonly silentMs: number;
}

export function createMicWakeTracker(): MicWakeTracker {
  let seen = false;
  let alive = false;
  let silentMs = 0;
  return {
    observe(peak: number, frameMs: number): MicWakeObservation {
      if (alive) {
        return { waking: false, justWoke: false, silentMs, beganDead: false };
      }
      const first = !seen;
      seen = true;
      const live = Number.isFinite(peak) && peak >= MIC_ALIVE_PEAK;
      if (live) {
        alive = true;
        // A first frame that is already live is no wake at all.
        return { waking: false, justWoke: !first, silentMs, beganDead: false };
      }
      silentMs += Math.max(0, Number.isFinite(frameMs) ? frameMs : 0);
      return { waking: true, justWoke: false, silentMs, beganDead: first };
    },
    get waking() {
      return seen && !alive;
    },
    get silentMs() {
      return silentMs;
    },
  };
}

/**
 * Capture level — the single source of truth for every decision the
 * renderer makes about raw amplitude: "did this frame carry speech?"
 * and "did this session carry any at all?".
 *
 * Why it exists (BUGS_AUDIT_2026-09-03 §4.3). Chromium's automatic gain
 * control was on, so the level a session starts at is a property of the
 * AGC, not of the speaker: all three recordings measured on 2026-09-03
 * opened at 0 dBFS peak with a 7 dB crest factor — a signal sitting in
 * the limiter — and slid 10–15 dB over the first five to ten seconds
 * without ever coming back. A recording made in June sat at −24 dB
 * throughout. A constant like `rms >= 0.003` means "speech" in the first
 * of those and "loud speech only" in the second; on the tail of a
 * recording that has slid to −28 dB it means nothing at all.
 *
 * So nothing here compares against a fixed amplitude. The session's own
 * quietest passage is measured as it arrives, and speech is what rises
 * a fixed number of decibels above it — which is a property of speech
 * (a spoken syllable stands well clear of the room it is spoken in) and
 * not of the gain the capture stack happened to choose.
 *
 * The ONE absolute anchor is digital silence: the floor of a dead
 * capture pipeline, which is not a level at all but the absence of one.
 * It is defined once, in `mic-health.ts`, and imported here so the two
 * modules cannot drift.
 *
 * Pure: no DOM, no state beyond the tracker the caller owns.
 * Unit-tested in tests/audio-levels.test.ts.
 */

import { DEAD_PEAK_FLOOR, DEAD_RMS_FLOOR } from "./mic-health";

/**
 * How far above the session's own noise floor a frame must rise before
 * it counts as speech, and how far above that threshold a frame's PEAK
 * must rise to count on its own.
 *
 * 12 dB (a factor of 4) is the gap between a room and someone speaking
 * in it; it is also small enough that the quiet end of a phrase still
 * clears it. The peak rule catches a short transient — a single
 * plosive, the first consonant of a word cut off by the stop — whose
 * energy never lasts long enough to lift the frame's RMS.
 */
const SPEECH_OVER_FLOOR_RATIO = 4;
const SPEECH_PEAK_CREST_RATIO = 4;

/**
 * How the noise-floor estimate follows the signal: fast down, very
 * slowly up.
 *
 * Down fast, because the floor must find the room quickly — the pause
 * between two words is all the evidence there is, and a floor that lags
 * it would classify the following syllable against the previous word's
 * energy. Up slowly, and ONLY from frames that are not already speech:
 * the floor is an estimate of the room, and letting a long phrase feed
 * it makes the speech measure itself, drift the threshold up behind its
 * own energy, and go silent halfway through a sentence.
 *
 * The threshold is never derived from a floor below `FLOOR_MIN_RMS`.
 * A dead pipeline reports exact zeros, and four times zero is still
 * zero — every sample would qualify as speech. One 16-bit LSB of RMS is
 * the smallest floor that means anything.
 */
const FLOOR_FALL = 0.25;
const FLOOR_RISE = 0.0008;
const FLOOR_MIN_RMS = DEAD_PEAK_FLOOR;

/**
 * The floor is never left below the quietest frame of the last
 * `FLOOR_RECOVERY_WINDOW_MS` of audio: while that minimum sits above it,
 * the floor climbs towards it with a time constant of
 * `FLOOR_RECOVERY_TAU_MS` of audio (whatever the frame length).
 *
 * Without this the floor could get stuck under the room for the whole
 * take. It rises only from frames that are not speech, and every frame
 * is speech against a floor that is too low — so one bad seed was never
 * corrected. A cold start seeds it exactly that way: the capture's first
 * frame is digital zero or the half-filled ramp-in frame, the floor
 * starts near 0, and every frame after it — the room, a key thump —
 * counts as speech. On the installed 1.6.24 that held the stop tail to
 * its 600 ms cap on every cold take (2026-11-22 19:09:30 and 19:10:59,
 * "tail=600ms capped" over a room at ~0.005 RMS) and would have made
 * "the take carried speech" true for any take that started cold.
 *
 * The minimum over a window is how a noise floor is measured
 * (minimum statistics). The window is longer than a stretch of speech
 * without a pause, so the minimum of a stretch of speech is still the
 * room it is spoken in, and a held word does not lift the floor.
 */
const FLOOR_RECOVERY_WINDOW_MS = 500;
const FLOOR_RECOVERY_TAU_MS = 100;
/** Frame length assumed when the caller does not say (one worklet batch). */
const DEFAULT_FRAME_MS = 10.7;

/** Running measurement of one capture session's own level. */
export interface CaptureLevel {
  /** Frames observed so far. */
  frames: number;
  /** Adaptive estimate of the session's noise floor, in RMS. */
  floorRms: number;
  /** Sum of squared per-frame RMS, for the session average. */
  sumSquaredRms: number;
  /** Loudest single-sample magnitude seen. */
  peakMax: number;
  /** Frames that carried speech relative to the floor at the time. */
  speechFrames: number;
  /** The floor has been seeded from a live (non-dead) frame. */
  floorSeeded: boolean;
  /** The last frames' RMS and length, newest last, covering about
   *  `FLOOR_RECOVERY_WINDOW_MS` of audio. */
  recent: Array<{ rms: number; ms: number }>;
}

export interface CaptureLevelSummary {
  frames: number;
  /**
   * Session RMS: the square root of the MEAN OF THE SQUARES of the
   * per-frame RMS. Averaging the per-frame RMS directly under-reports
   * dynamic audio and inflates false-silence verdicts.
   */
  averageRms: number;
  peakMax: number;
  floorRms: number;
  /**
   * The capture pipeline delivered no signal at all — not "a quiet
   * room" but "an ADC that is not running". This is the one verdict
   * that is absolute, and it is the one a level can never fake.
   */
  digitalSilence: boolean;
  /** At least one frame rose above the session's own noise floor. */
  carriedSpeech: boolean;
}

export function createCaptureLevel(): CaptureLevel {
  return {
    frames: 0,
    floorRms: 0,
    sumSquaredRms: 0,
    peakMax: 0,
    speechFrames: 0,
    floorSeeded: false,
    recent: [],
  };
}

/** RMS a frame must reach, given the floor measured so far. */
function speechRmsThreshold(level: CaptureLevel): number {
  return Math.max(level.floorRms, FLOOR_MIN_RMS) * SPEECH_OVER_FLOOR_RATIO;
}

/**
 * Fold one captured frame into the session's level, and answer whether
 * that frame carried speech.
 *
 * The verdict is taken against the floor as it stood BEFORE this frame,
 * so a loud frame cannot lift the floor it is being judged against.
 *
 * The floor is seeded by the first LIVE frame: frames of digital
 * silence at the start (a capture that has not delivered signal yet)
 * say nothing about the room and are never speech. `frameMs` is the
 * frame's audio length (defaults to one worklet batch).
 */
export function observeCaptureFrame(level: CaptureLevel, rms: number, peak: number, frameMs = DEFAULT_FRAME_MS): boolean {
  const frameRms = Number.isFinite(rms) && rms > 0 ? rms : 0;
  const framePeak = Number.isFinite(peak) && peak > 0 ? peak : 0;
  const threshold = speechRmsThreshold(level);
  const isSpeech = level.floorSeeded
    && (frameRms >= threshold || framePeak >= threshold * SPEECH_PEAK_CREST_RATIO);

  if (!level.floorSeeded) {
    if (frameRms >= FLOOR_MIN_RMS) {
      level.floorRms = frameRms;
      level.floorSeeded = true;
    }
  } else if (frameRms < level.floorRms) {
    level.floorRms += (frameRms - level.floorRms) * FLOOR_FALL;
  } else if (!isSpeech) {
    level.floorRms += (frameRms - level.floorRms) * FLOOR_RISE;
  }
  if (level.floorSeeded) recoverFloorFromRecentMinimum(level, frameRms, frameMs);
  level.frames += 1;
  level.sumSquaredRms += frameRms * frameRms;
  if (framePeak > level.peakMax) level.peakMax = framePeak;
  if (isSpeech) level.speechFrames += 1;
  return isSpeech;
}

function recoverFloorFromRecentMinimum(level: CaptureLevel, frameRms: number, frameMs: number): void {
  const ms = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : DEFAULT_FRAME_MS;
  level.recent.push({ rms: frameRms, ms });
  let covered = 0;
  for (const f of level.recent) covered += f.ms;
  // Drop the oldest frames the window no longer needs.
  while (level.recent.length > 1 && covered - level.recent[0].ms >= FLOOR_RECOVERY_WINDOW_MS) {
    covered -= level.recent[0].ms;
    level.recent.shift();
  }
  if (covered < FLOOR_RECOVERY_WINDOW_MS) return;
  let recentMin = Infinity;
  for (const f of level.recent) if (f.rms < recentMin) recentMin = f.rms;
  if (recentMin > level.floorRms) {
    level.floorRms += (recentMin - level.floorRms) * (1 - Math.exp(-ms / FLOOR_RECOVERY_TAU_MS));
  }
}

export function summarizeCaptureLevel(level: CaptureLevel): CaptureLevelSummary {
  const averageRms = level.frames > 0 ? Math.sqrt(level.sumSquaredRms / level.frames) : 0;
  return {
    frames: level.frames,
    averageRms,
    peakMax: level.peakMax,
    floorRms: level.floorRms,
    digitalSilence: level.frames > 0
      && level.peakMax < DEAD_PEAK_FLOOR
      && averageRms < DEAD_RMS_FLOOR,
    carriedSpeech: level.speechFrames > 0,
  };
}

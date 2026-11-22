/**
 * How far the audio delivered to the renderer lags behind the moment it
 * was spoken — the input latency of the capture path.
 *
 * The stop tail (./stop-tail) positions the press in AUDIO time. The
 * audio delivered at the instant of the press is not what was being said
 * at that instant: it is what was said one input latency earlier. On a
 * built-in microphone that is ~10–60 ms and disappears inside the tail.
 * On a Bluetooth headset (HFP) it is the radio link, the SCO packet
 * buffer and the headset's own call DSP — 150–300 ms — and a tail
 * measured from the delivered position closed before the last word had
 * even arrived (2026-11-22, Liberty 5 BT: every stop `tail=120ms
 * quiet-at-min`, last words missing from the audio, one take ending on
 * the first 60 ms of a word).
 *
 * What the platform reports is a lower bound, never the answer:
 *
 *  - `MediaTrackSettings.latency` is Chromium's view of the device
 *    buffer, derived from Core Audio.
 *  - Core Audio itself reports 30 ms for that headset (160 frames of
 *    device latency plus a 320-frame buffer at 16 kHz), against the
 *    built-in microphone's 63 ms. The Bluetooth transport and the
 *    headset's processing are not part of any property it exposes.
 *
 * So the reported figure is taken when it is larger, and a Bluetooth
 * input is held to a floor (`UI_TOKENS.capture.inputLatency`) that
 * covers what nothing reports. Bluetooth is recognised by the track's
 * label — the only signal Chromium gives (./capture-warm explains why,
 * and owns the match). Over-matching costs a longer wait on stop;
 * under-matching costs the last word.
 *
 * On top of the device sits one buffer period of the capture node: the
 * worklet holds up to one batch it has not posted yet (~11 ms), the
 * ScriptProcessor fallback one buffer (~85 ms).
 *
 * Pure: no DOM. Unit-tested in tests/capture-latency.test.ts.
 */

import { isBluetoothInputLabel } from "./capture-warm";

export interface CaptureLatencyInput {
  /** `MediaTrackSettings.latency` of the capture track, in seconds, if any. */
  reportedLatencySec: unknown;
  /** `MediaStreamTrack.label` of the capture track. */
  deviceLabel: string;
  /** One buffer period of the delivering capture node, in ms. */
  bufferPeriodMs: number;
  /** The least latency a Bluetooth input is assumed to have, in ms. */
  bluetoothFloorMs: number;
}

/** Which figure set the device part of the latency. */
export type CaptureLatencySource = "reported" | "bluetooth" | "none";

export interface CaptureLatency {
  /** Total input latency: device plus one capture buffer, in ms. */
  ms: number;
  source: CaptureLatencySource;
  /** What the track itself reported, in ms (0: nothing plausible). */
  reportedMs: number;
}

/** The longest latency a device report is believed for; beyond it the report is noise. */
const MAX_PLAUSIBLE_REPORTED_MS = 2_000;

function reportedMs(value: unknown): number {
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_PLAUSIBLE_REPORTED_MS ? ms : 0;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The capture path's input latency, from what the track says and what it is. */
export function captureInputLatency(input: CaptureLatencyInput): CaptureLatency {
  const reported = reportedMs(input.reportedLatencySec);
  const floor = isBluetoothInputLabel(input.deviceLabel) ? nonNegative(input.bluetoothFloorMs) : 0;
  const buffer = nonNegative(input.bufferPeriodMs);
  if (floor > reported) return { ms: floor + buffer, source: "bluetooth", reportedMs: reported };
  if (reported > 0) return { ms: reported + buffer, source: "reported", reportedMs: reported };
  return { ms: buffer, source: "none", reportedMs: 0 };
}

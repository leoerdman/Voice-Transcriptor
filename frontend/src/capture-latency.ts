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
 *  - `MediaTrackSettings.latency` is Chromium's view of the device's
 *    callback buffer — 2.9 ms for the built-in microphone, 8 ms for the
 *    headset (measured 2026-11-23). It leaves out the rest of what Core
 *    Audio itself knows.
 *  - Core Audio (read by the desktop shell's native helper,
 *    desktop/native/dictation-helper/InputLatency.swift) adds the
 *    device's own latency, the driver's safety offset, the delivery
 *    buffer and the stream's latency: 62.8 ms for the built-in
 *    microphone (13 + 36 + 512 + 2210 frames at 44.1 kHz), 30 ms for
 *    the headset (160 + 320 frames at 16 kHz). The Bluetooth transport
 *    and the headset's processing are not part of any property it
 *    exposes.
 *
 * So the larger of the two figures is taken, and a Bluetooth input is
 * held to a floor (`UI_TOKENS.capture.inputLatency`) that covers what
 * nothing reports. The two are alternatives, never summed: both count the
 * same delivery buffer. Core Audio's figure belongs to a device, found by
 * name — Chromium salts its device ids, but a track's label is the
 * device's name plus a transport suffix, and a "Default - " prefix when
 * it was opened through the system default. Bluetooth is recognised by
 * the label too — the only signal Chromium gives (./capture-warm explains
 * why, and owns the match). Over-matching costs a longer wait on stop;
 * under-matching costs the last word.
 *
 * On top of the device sits one buffer period of the capture node: the
 * worklet holds up to one batch it has not posted yet (~11 ms), the
 * ScriptProcessor fallback one buffer (~85 ms).
 *
 * Pure: no DOM. Unit-tested in tests/capture-latency.test.ts.
 */

import { isBluetoothInputLabel } from "./capture-warm";

/** One input device as the native helper read it from Core Audio. */
export interface NativeInputDevice {
  /** Core Audio's device name — a track's label without prefix and suffix. */
  name: string;
  /** Device, safety offset, buffer and stream latency, in ms. */
  latencyMs: number;
}

export interface CaptureLatencyInput {
  /** `MediaTrackSettings.latency` of the capture track, in seconds, if any. */
  reportedLatencySec: unknown;
  /** The input devices Core Audio knows; empty when the helper is absent. */
  nativeDevices?: readonly NativeInputDevice[];
  /** `MediaStreamTrack.label` of the capture track. */
  deviceLabel: string;
  /** One buffer period of the delivering capture node, in ms. */
  bufferPeriodMs: number;
  /** The least latency a Bluetooth input is assumed to have, in ms. */
  bluetoothFloorMs: number;
}

/** Which figure set the device part of the latency. */
export type CaptureLatencySource = "reported" | "coreaudio" | "bluetooth" | "none";

export interface CaptureLatency {
  /** Total input latency: device plus one capture buffer, in ms. */
  ms: number;
  source: CaptureLatencySource;
  /** What the track itself reported, in ms (0: nothing plausible). */
  reportedMs: number;
  /** What Core Audio says of the track's device, in ms (0: not found). */
  nativeMs: number;
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

/** Chromium's label prefixes for a track opened through a system alias. */
const ALIAS_PREFIX = /^(?:default|communications) - /i;
/** The transport Chromium appends to a device's name: "… (Built-in)". */
const TRANSPORT_SUFFIX = /\s+\([^()]*\)$/;

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Core Audio's latency of the device a track label names, in ms; 0 when no
 * device matches. A label is tried whole first (a name that ends in
 * parentheses of its own), then without the transport suffix. Devices that
 * share a name are held to the largest figure.
 */
export function nativeLatencyForLabel(label: string, devices: readonly NativeInputDevice[] | undefined): number {
  const bare = String(label ?? "").trim().replace(ALIAS_PREFIX, "");
  if (!bare || !devices?.length) return 0;
  const usable = devices.filter((d) => d && typeof d.name === "string" && nonNegative(d.latencyMs) > 0);
  for (const candidate of [bare, bare.replace(TRANSPORT_SUFFIX, "")]) {
    const matches = usable.filter((d) => sameName(d.name, candidate));
    if (matches.length) return Math.max(...matches.map((d) => d.latencyMs));
  }
  return 0;
}

/** The capture path's input latency, from what the track says and what it is. */
export function captureInputLatency(input: CaptureLatencyInput): CaptureLatency {
  const reported = reportedMs(input.reportedLatencySec);
  const native = nativeLatencyForLabel(input.deviceLabel, input.nativeDevices);
  const floor = isBluetoothInputLabel(input.deviceLabel) ? nonNegative(input.bluetoothFloorMs) : 0;
  const buffer = nonNegative(input.bufferPeriodMs);
  const device = Math.max(reported, native);
  const figures = { reportedMs: reported, nativeMs: native };
  if (floor > device) return { ms: floor + buffer, source: "bluetooth", ...figures };
  if (native > reported) return { ms: native + buffer, source: "coreaudio", ...figures };
  if (reported > 0) return { ms: reported + buffer, source: "reported", ...figures };
  return { ms: buffer, source: "none", ...figures };
}

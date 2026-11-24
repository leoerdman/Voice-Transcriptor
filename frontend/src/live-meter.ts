/**
 * The live meter's arithmetic: what the microphone heard, and what Solo did.
 *
 * Two different questions, drawn as two different things, because confusing
 * them is what made this feature hard to explain:
 *
 *   - the spectrum is what the microphone hears — *everybody* in the room.
 *     It moves for the owner and for a stranger alike, and it decides nothing.
 *   - the needle is the cosine Solo actually computed against the profile,
 *     and the two lines are the pair it is judged by. That is the decision.
 *
 * So the honest instrument is both, stacked: a spectrum that answers "is there
 * sound", and a needle that answers "whose".
 */

/** What the gate reported with the last verdict. */
export interface MeterState {
  /** The last cosine, or null before any verdict. */
  score: number | null;
  /** The score at which the gate reopens. */
  openAt: number;
  /** The score below which it closes. */
  closeAt: number;
  /** The gate's own word: idle, open or closed. */
  state: string;
  /** Seconds of audio withheld so far. */
  withheldSec: number;
}

/** Where a score sits on the bar the owner is watching, 0..1. */
export function scorePosition(score: number | null): number {
  if (score === null || !Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

/**
 * The zone the needle is in, in the meter's own words.
 *
 * Deliberately not the gate's `state`: a single verdict says "this window",
 * the gate's state says "what happened to the audio", and between them lies
 * the hysteresis. The meter names the comparison, the pane names the outcome.
 */
export type MeterZone = "owner" | "between" | "stranger" | "nothing";

export function meterZone(state: MeterState): MeterZone {
  if (state.score === null || !Number.isFinite(state.score)) return "nothing";
  if (state.score >= state.openAt) return "owner";
  if (state.score < state.closeAt) return "stranger";
  return "between";
}

/** The one line beside the meter, in the words the owner used himself. */
export function meterCaption(state: MeterState): string {
  const zone = meterZone(state);
  if (zone === "nothing") return "Nothing judged yet — speak.";
  const score = (state.score ?? 0).toFixed(2);
  if (zone === "owner") return `${score} — your voice: let through`;
  if (zone === "stranger") return `${score} — not your voice: withheld`;
  return `${score} — between the lines: follows what came before`;
}

/**
 * The spectrum, folded from FFT bins into the bars a person can read.
 *
 * Logarithmic on both axes, because a linear spectrum of speech is a spike at
 * the bottom and nothing above it: the low harmonics carry the energy, the
 * consonants that tell voices apart live in the top two octaves. `edgesHz`
 * names where each bar starts, so the strip can be labelled.
 */
export const SPECTRUM_BARS = 48;

/** The bar edges, from 80 Hz to 8 kHz — the band a 16 kHz capture holds. */
export function spectrumEdges(
  sampleRate: number,
  bins: number,
  count: number = SPECTRUM_BARS,
): number[] {
  const nyquist = sampleRate / 2;
  const low = 80;
  const high = Math.min(nyquist, 8000);
  const edges: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    edges.push(low * Math.pow(high / low, t));
  }
  // Index into `bins` for each edge; the last bar owns everything to the top.
  return edges.map((hz) => Math.min(bins - 1, Math.max(0, Math.round((hz / nyquist) * bins))));
}

/**
 * One frame of bars, in 0..1 — the loudest bin of each band, on a dB scale.
 *
 * A `-100..0` dBFS range mapped linearly would leave every bar empty until
 * somebody shouted; speech sits around `-30` in its loud bands, so the floor
 * is where a quiet room is and the ceiling is full scale.
 */
export function spectrumBars(
  magnitudes: Float32Array | ArrayLike<number>,
  edges: number[],
  floorDb: number = -90,
): number[] {
  const bars: number[] = [];
  for (let i = 0; i < edges.length; i += 1) {
    const from = edges[i];
    const to = i + 1 < edges.length ? Math.max(from + 1, edges[i + 1]) : magnitudes.length;
    // −Infinity, not 0: every reading here is negative dBFS, so a peak that
    // starts at 0 would never be beaten and every bar would read the floor.
    let peak = Number.NEGATIVE_INFINITY;
    for (let bin = from; bin < to && bin < magnitudes.length; bin += 1) {
      const value = magnitudes[bin];
      if (Number.isFinite(value) && value > peak) peak = value;
    }
    const db = Number.isFinite(peak) ? peak : floorDb;
    bars.push(Math.min(1, Math.max(0, (db - floorDb) / -floorDb)));
  }
  return bars;
}

/** Whether the meter is worth painting at all: a silent room has nothing to say. */
export function meterIsQuiet(bars: number[], threshold: number = 0.04): boolean {
  for (const bar of bars) {
    if (bar > threshold) return false;
  }
  return true;
}

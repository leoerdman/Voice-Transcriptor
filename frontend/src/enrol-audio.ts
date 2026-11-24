/**
 * The arithmetic between a six-second capture and the bytes the backend reads.
 *
 * The recording path already has a resampler (`downsample` in main.tsx), and
 * this module deliberately does not call it: that one carries the remainder of
 * the previous chunk in a module-level variable so its decimation grid stays
 * continuous across a live take. An enrolment is a single buffer that starts
 * from an arbitrary moment, and borrowing state that belongs to a recording
 * would let a press move the recording's grid by half a sample per chunk.
 *
 * Everything here is pure so the format can be checked without a microphone —
 * which is the only way it can be checked in CI at all.
 */

/** The one rate the mask was trained on. */
export const ENROL_SAMPLE_RATE = 16_000;

/**
 * Average-decimate a capture down to 16 kHz.
 *
 * Averaging (rather than picking every n-th sample) is what keeps a 44.1 kHz
 * or 48 kHz device from aliasing a hiss into the band the embedder reads. When
 * the input is already 16 kHz this is a copy, so the common case pays nothing.
 */
export function resampleTo16k(samples: Float32Array, inRate: number): Float32Array {
  const rate = Math.round(inRate) || ENROL_SAMPLE_RATE;
  if (rate <= ENROL_SAMPLE_RATE) return new Float32Array(samples);
  const step = rate / ENROL_SAMPLE_RATE;
  const outLen = Math.floor(samples.length / step);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.round(i * step);
    const end = Math.min(samples.length, Math.round((i + 1) * step));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += samples[j];
      n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

/** One buffer out of the chunks the capture callback hands over. */
export function concatSamples(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Float samples to the little-endian PCM16 the backend expects.
 *
 * Negative and positive halves are scaled separately (±0x8000 / 0x7fff)
 * because two's complement is asymmetric: scaling both by 32767 leaves the
 * loudest negative sample one step short, and scaling both by 32768 wraps the
 * loudest positive one to full-scale negative — a click in every profile.
 */
export function int16FromFloat(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const clamped = x < -1 ? -1 : x > 1 ? 1 : x;
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return out;
}

/** Seconds the buffer holds, for the length check the backend also makes. */
export function pcmSeconds(samples: Int16Array, rate: number = ENROL_SAMPLE_RATE): number {
  return rate > 0 ? samples.length / rate : 0;
}

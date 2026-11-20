/**
 * The decisions of the renderer's PCM capture that do not need a DOM,
 * OPFS or an AudioContext — kept here so they are tested on their own
 * instead of only through a recording.
 *
 *   • `BoundedChunkWindow` — the RAM a PCM sink may hold. The in-memory
 *     sink (no OPFS) and the OPFS sink after a failed disk write both keep
 *     samples in RAM; both are bounded by the same window as the WebM
 *     fallback. The OPFS sink's RAM tail used to have no bound at all,
 *     so a full disk mid-dictation grew renderer memory without limit.
 *   • `pcmWavDurationSec` — how long the WAV a sink produced really is.
 *     The sink's sample counter counts every sample it was GIVEN; a
 *     window that dropped its oldest chunks, or a spool whose last write
 *     never landed, holds fewer. The duration that picks the canonical
 *     audio has to describe the file, not the counter.
 *   • `capturedHoursLabel` — the "2 hours" in the user-facing truncation
 *     notices, derived from the window instead of written beside it.
 */

/** Bytes per PCM16 mono sample. */
const PCM16_BYTES_PER_SAMPLE = 2;
/** Size of the canonical RIFF/WAVE header the sinks prepend. */
export const WAV_HEADER_BYTES = 44;

export class BoundedChunkWindow {
  private readonly capSamples: number;
  private held: Int16Array[] = [];
  private heldSamples = 0;
  private dropped = 0;

  constructor(capSamples: number) {
    this.capSamples = Math.max(1, Math.floor(Number(capSamples) || 0));
  }

  /**
   * Add a chunk and drop the oldest ones beyond the cap (the newest
   * chunk is always kept). Returns true on the first push that dropped
   * anything, so the caller can say so once.
   */
  push(chunk: Int16Array): boolean {
    if (!chunk.length) return false;
    const hadDropped = this.dropped > 0;
    this.held.push(chunk);
    this.heldSamples += chunk.length;
    while (this.heldSamples > this.capSamples && this.held.length > 1) {
      const oldest = this.held.shift()!;
      this.heldSamples -= oldest.length;
      this.dropped += oldest.length;
    }
    return !hadDropped && this.dropped > 0;
  }

  /** Put chunks back at the head (a write that failed after they were taken). */
  restoreHead(chunks: Int16Array[]): boolean {
    const tail = this.take();
    let truncatedNow = false;
    for (const c of [...chunks, ...tail]) {
      if (this.push(c)) truncatedNow = true;
    }
    return truncatedNow;
  }

  /** Hand every held chunk to the caller and empty the window. */
  take(): Int16Array[] {
    const out = this.held;
    this.held = [];
    this.heldSamples = 0;
    return out;
  }

  get chunks(): readonly Int16Array[] {
    return this.held;
  }

  get samples(): number {
    return this.heldSamples;
  }

  get bytes(): number {
    return this.heldSamples * PCM16_BYTES_PER_SAMPLE;
  }

  get droppedSamples(): number {
    return this.dropped;
  }

  clear(): void {
    this.held = [];
    this.heldSamples = 0;
  }
}

/**
 * Duration of a PCM16 mono WAV produced by a sink. The smaller of what
 * the counter says was captured and what the file actually holds.
 */
export function pcmWavDurationSec(fileBytes: number, sampleCount: number, sampleRate: number): number {
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const payloadSamples = Math.max(0, Math.floor((Number(fileBytes) - WAV_HEADER_BYTES) / PCM16_BYTES_PER_SAMPLE));
  const counted = Math.max(0, Math.floor(Number(sampleCount) || 0));
  return Math.min(payloadSamples, counted) / rate;
}

/** "2 hours", "1 hour", "90 minutes" — the capture window in words. */
export function capturedHoursLabel(windowSec: number): string {
  const sec = Math.max(0, Math.floor(Number(windowSec) || 0));
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  const m = Math.round(sec / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

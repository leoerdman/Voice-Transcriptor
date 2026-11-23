/**
 * ── A capture sink that takes frames before its storage exists (``DeferredPcmSink``) ──
 *
 * A take's canonical audio is spooled into an OPFS file. Opening that
 * file takes 13–190 ms (measured 22.11; up to ~500 ms on slow disks), and
 * the start used to await it BEFORE opening the WebSocket and the
 * microphone — every one of those milliseconds sat between the press and
 * the first captured frame (OPTIMIZATION.md §3.4). The old fire-and-forget
 * alternative lost the frames that arrived before the file was ready.
 *
 * This sink is handed to the capture path at once. Frames that arrive
 * before the storage is ready are copied into memory, in order, and
 * written into it the moment it exists; after that every frame goes
 * straight through, and nothing waits:
 *
 *  - ``finalize`` waits for the storage (a take shorter than the open
 *    still finalizes everything it captured);
 *  - ``destroy`` before the storage is ready destroys it when it arrives
 *    and drops the held frames;
 *  - a storage that fails to open is replaced by the fallback (the
 *    in-memory sink), so the held frames still land somewhere.
 */

export interface PcmSinkLike {
  append(samples: Float32Array): void;
  finalize(sampleRate: number, name?: string): Promise<File>;
  destroy(): Promise<void>;
  readonly totalSamples: number;
}

export const DEFERRED_PCM_SINK_MAX_SAMPLES = 32_000;

export class DeferredPcmSink implements PcmSinkLike {
  private target: PcmSinkLike | null = null;
  private held: Float32Array[] = [];
  private heldSamples = 0;
  private destroyed = false;
  private overflowed = false;
  /** Resolves with the storage once the held frames are in it. */
  readonly ready: Promise<PcmSinkLike>;

  constructor(
    storage: Promise<PcmSinkLike>,
    fallback: () => PcmSinkLike,
    onReady?: (sink: PcmSinkLike, heldFrames: number) => void,
    private readonly onOverflow?: () => void,
    private readonly maxHeldSamples = DEFERRED_PCM_SINK_MAX_SAMPLES,
  ) {
    this.ready = storage
      .catch((e) => {
        console.warn("[pcm-sink] capture storage failed to open; holding the take in memory", e);
        return fallback();
      })
      .then((sink) => {
        const heldFrames = this.held.length;
        if (!this.destroyed) {
          // One synchronous pass: no frame can arrive between the last
          // held one and the switch to pass-through.
          for (const frame of this.held) sink.append(frame);
          this.target = sink;
        }
        this.held = [];
        this.heldSamples = 0;
        if (!this.destroyed) {
          try {
            onReady?.(sink, heldFrames);
          } catch (e) {
            console.warn("[pcm-sink] ready observer threw", e);
          }
        }
        return sink;
      });
  }

  get totalSamples(): number {
    return this.target ? this.target.totalSamples : this.heldSamples;
  }

  append(samples: Float32Array): void {
    if (this.destroyed || this.overflowed) return;
    if (this.target) {
      this.target.append(samples);
      return;
    }
    // A copy: the capture path may reuse the buffer it hands over.
    if (this.heldSamples + samples.length > this.maxHeldSamples) {
      if (!this.overflowed) {
        this.overflowed = true;
        this.held = [];
        this.heldSamples = 0;
        if (this.onOverflow) this.onOverflow();
        else throw new Error("Deferred PCM buffer exceeded its configured limit");
      }
      return;
    }
    this.held.push(samples.slice());
    this.heldSamples += samples.length;
  }

  async finalize(sampleRate: number, name?: string): Promise<File> {
    const sink = await this.ready;
    return sink.finalize(sampleRate, name);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.held = [];
    this.heldSamples = 0;
    const sink = await this.ready;
    await sink.destroy();
  }
}

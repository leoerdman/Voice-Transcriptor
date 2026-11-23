export interface PendingWsFrame {
  pcm: ArrayBuffer;
  samples: number;
}

export class PendingWsFrames {
  private readonly frames: PendingWsFrame[] = [];
  private queuedSamples = 0;

  constructor(private readonly maxSamples: number) {
    if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) {
      throw new RangeError("Pending WebSocket frame capacity must be a positive integer");
    }
  }

  get length(): number {
    return this.frames.length;
  }

  enqueue(pcm: ArrayBuffer, samples: number): boolean {
    if (!Number.isSafeInteger(samples) || samples <= 0) {
      throw new RangeError("Pending WebSocket frame sample count must be a positive integer");
    }
    if (this.queuedSamples + samples > this.maxSamples) return false;
    this.frames.push({ pcm, samples });
    this.queuedSamples += samples;
    return true;
  }

  flush(send: (pcm: ArrayBuffer) => boolean): number {
    while (this.frames.length > 0) {
      const frame = this.frames[0];
      if (!send(frame.pcm)) break;
      this.frames.shift();
      this.queuedSamples -= frame.samples;
    }
    return this.frames.length;
  }

  clear(): void {
    this.frames.length = 0;
    this.queuedSamples = 0;
  }
}

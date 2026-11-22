import { describe, expect, it, vi } from "vitest";

import { DeferredPcmSink, type PcmSinkLike } from "../src/deferred-pcm-sink";

class RecordingSink implements PcmSinkLike {
  frames: number[][] = [];
  destroyed = 0;
  append(samples: Float32Array): void {
    this.frames.push(Array.from(samples));
  }
  async finalize(): Promise<File> {
    return new File([new Uint8Array(this.totalSamples)], "take.wav");
  }
  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
  get totalSamples(): number {
    return this.frames.reduce((n, f) => n + f.length, 0);
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("DeferredPcmSink — frames before the storage opens are kept, in order", () => {
  it("holds early frames and writes them into the storage, then passes through", async () => {
    const storage = deferred<PcmSinkLike>();
    const real = new RecordingSink();
    const onReady = vi.fn();
    const sink = new DeferredPcmSink(storage.promise, () => new RecordingSink(), onReady);
    const reused = new Float32Array([1, 2]);
    sink.append(reused);
    reused[0] = 99; // the capture path may reuse its buffer
    sink.append(new Float32Array([3]));
    expect(sink.totalSamples).toBe(3);
    expect(real.frames).toEqual([]);
    storage.resolve(real);
    await sink.ready;
    expect(real.frames).toEqual([[1, 2], [3]]);
    expect(onReady).toHaveBeenCalledWith(real, 2);
    sink.append(new Float32Array([4, 5]));
    expect(real.frames).toEqual([[1, 2], [3], [4, 5]]);
    expect(sink.totalSamples).toBe(5);
  });

  it("a take that stops before the storage opens still finalizes everything it captured", async () => {
    const storage = deferred<PcmSinkLike>();
    const real = new RecordingSink();
    const sink = new DeferredPcmSink(storage.promise, () => new RecordingSink());
    sink.append(new Float32Array([1, 2, 3]));
    const file = sink.finalize(16_000);
    storage.resolve(real);
    expect((await file).size).toBe(3);
  });

  it("destroyed before the storage opens: the storage is destroyed when it arrives, the held frames dropped", async () => {
    const storage = deferred<PcmSinkLike>();
    const real = new RecordingSink();
    const onReady = vi.fn();
    const sink = new DeferredPcmSink(storage.promise, () => new RecordingSink(), onReady);
    sink.append(new Float32Array([1]));
    const destroyed = sink.destroy();
    storage.resolve(real);
    await destroyed;
    expect(real.destroyed).toBe(1);
    expect(real.frames).toEqual([]);
    expect(onReady).not.toHaveBeenCalled();
    sink.append(new Float32Array([2]));
    expect(real.frames).toEqual([]);
  });

  it("a storage that fails to open falls back, and the held frames land in the fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallback = new RecordingSink();
    const sink = new DeferredPcmSink(Promise.reject(new Error("OPFS unavailable")), () => fallback);
    sink.append(new Float32Array([7, 8]));
    await sink.ready;
    expect(fallback.frames).toEqual([[7, 8]]);
    warn.mockRestore();
  });
});

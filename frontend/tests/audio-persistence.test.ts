import { describe, expect, it, vi } from "vitest";

import {
  audioSaveDirs,
  skippedAudioPersistence,
  startAudioPersistence,
  type PersistedAudioRef,
} from "../src/audio-persistence";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("audioSaveDirs — configured folder first, default once", () => {
  it("tries the configured folder, then the default", () => {
    expect(audioSaveDirs("/Volumes/External/Recordings")).toEqual(["/Volumes/External/Recordings", ""]);
  });
  it("does not try the default twice", () => {
    expect(audioSaveDirs("")).toEqual([""]);
  });
});

describe("startAudioPersistence — the take's audio save, off the path to the paste", () => {
  it("returns at once: a slow upload does not hold up the caller (the FINAL signal)", async () => {
    const upload = deferred<PersistedAudioRef>();
    const releaseSpool = vi.fn();
    const persistence = startAudioPersistence({
      archiveDir: "",
      save: () => upload.promise,
      releaseSpool,
    });
    // Starting the save hands back a handle synchronously; the caller goes
    // on to deliver the transcript while the upload runs (stopLive's
    // wiring is pinned in renderer-main-contract.test.ts).
    expect(typeof persistence.releaseSpoolWhenDone).toBe("function");
    let settled = false;
    void persistence.settled.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(releaseSpool).not.toHaveBeenCalled();
    upload.resolve({ name: "rec-1", archiveDir: "/a" });
    expect(await persistence.settled).toEqual({
      kind: "saved",
      persisted: { name: "rec-1", archiveDir: "/a" },
      usedFallbackDir: false,
    });
  });

  it("releases the capture spool only after the upload has landed", async () => {
    const upload = deferred<PersistedAudioRef>();
    const releaseSpool = vi.fn();
    const persistence = startAudioPersistence({ archiveDir: "", save: () => upload.promise, releaseSpool });
    persistence.releaseSpoolWhenDone();
    await flush();
    expect(releaseSpool).not.toHaveBeenCalled();
    upload.resolve({ name: "rec-1", archiveDir: "/a" });
    await persistence.settled;
    await flush();
    expect(releaseSpool).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default folder when the configured one fails", async () => {
    const tried: string[] = [];
    const failures: string[] = [];
    const persistence = startAudioPersistence({
      archiveDir: "/stale/custom",
      save: async (dir) => {
        tried.push(dir);
        if (dir) throw new Error("EACCES");
        return { name: "rec-2", archiveDir: "/default" };
      },
      onAttemptFailed: (dir) => failures.push(dir),
      releaseSpool: () => {},
    });
    expect(await persistence.settled).toEqual({
      kind: "saved",
      persisted: { name: "rec-2", archiveDir: "/default" },
      usedFallbackDir: true,
    });
    expect(tried).toEqual(["/stale/custom", ""]);
    expect(failures).toEqual(["/stale/custom"]);
  });

  it("a save that fails everywhere is an outcome with the backend's message, never a rejection — and keeps the spool until the stop is over", async () => {
    const releaseSpool = vi.fn();
    const persistence = startAudioPersistence({
      archiveDir: "/custom",
      save: async (dir) => { throw new Error(dir ? "first" : "413 Payload Too Large"); },
      releaseSpool,
    });
    expect(await persistence.settled).toEqual({ kind: "failed", message: "413 Payload Too Large" });
    await flush();
    // The stop's last-resort recovery may still read the in-memory file.
    expect(releaseSpool).not.toHaveBeenCalled();
    persistence.releaseSpoolWhenDone();
    persistence.releaseSpoolWhenDone();
    await flush();
    expect(releaseSpool).toHaveBeenCalledTimes(1);
  });

  it("releases the spool once in total, however many times the stop asks", async () => {
    const releaseSpool = vi.fn();
    const persistence = startAudioPersistence({
      archiveDir: "",
      save: async () => ({ name: "rec-3", archiveDir: "/a" }),
      releaseSpool,
    });
    await persistence.settled;
    persistence.releaseSpoolWhenDone();
    await flush();
    expect(releaseSpool).toHaveBeenCalledTimes(1);
  });

  it("a spool release that throws is logged, not raised into the stop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const persistence = startAudioPersistence({
      archiveDir: "",
      save: async () => ({ name: "rec-4", archiveDir: "/a" }),
      releaseSpool: async () => { throw new Error("OPFS gone"); },
    });
    await persistence.settled;
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("skippedAudioPersistence — a take with no audio file", () => {
  it("settles as skipped and releases the spool at once", async () => {
    const releaseSpool = vi.fn();
    const persistence = skippedAudioPersistence(releaseSpool);
    expect(releaseSpool).toHaveBeenCalledTimes(1);
    expect(await persistence.settled).toEqual({ kind: "skipped" });
    persistence.releaseSpoolWhenDone();
    expect(releaseSpool).toHaveBeenCalledTimes(1);
  });
});

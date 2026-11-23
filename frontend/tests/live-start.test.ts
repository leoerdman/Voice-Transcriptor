import { describe, expect, it } from "vitest";

import {
  beginColdCapture,
  planColdCapture,
  runLiveStart,
  type ColdCaptureDeps,
  type ColdCaptureHandle,
  type ColdCaptureMode,
} from "../src/live-start";
import { chooseCaptureDevice } from "../src/capture-warm";
import type { StartBranch } from "../src/start-trace";

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every queued continuation run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

interface FakeStream { id: string; deviceId: string; stopped: boolean }
interface FakeGraph { id: number; closed: boolean }
interface Choice { deviceId: string; reason: string }

/**
 * The resources of a start, each answered by the test: every microphone
 * open, the device list and the graph are pending until settled.
 */
function fakeCapture(options: { initial?: string; mode?: ColdCaptureMode } = {}) {
  const initial = options.initial ?? "built-in";
  const events: string[] = [];
  const marks: Array<[string, StartBranch]> = [];
  // The marks' clock, advanced by the test; ``at`` is when a mark records.
  const clock = { now: 0 };
  const markedAt: number[] = [];
  const opens: Array<{ deviceId: string; answer: ReturnType<typeof deferred<FakeStream>> }> = [];
  const list = deferred<Choice>();
  const graphs: Array<ReturnType<typeof deferred<FakeGraph>>> = [];
  const streams: FakeStream[] = [];
  const closedGraphs: FakeGraph[] = [];
  const deps: ColdCaptureDeps<FakeStream, FakeGraph, Choice> = {
    initialChoice: { deviceId: initial, reason: "known-list" },
    refreshChoice: () => { events.push("list"); return list.promise; },
    acquireMic: (deviceId) => {
      events.push(`open:${deviceId}`);
      const answer = deferred<FakeStream>();
      opens.push({ deviceId, answer });
      return answer.promise;
    },
    releaseMic: (s) => { s.stopped = true; events.push(`release:${s.id}`); },
    prepareGraph: (mark) => {
      events.push("graph");
      const answer = deferred<FakeGraph>();
      graphs.push(answer);
      return answer.promise.then((g) => { mark("audioContext"); mark("workletModule"); return g; });
    },
    releaseGraph: (g) => { g.closed = true; closedGraphs.push(g); events.push(`close:graph${g.id}`); },
    mode: options.mode ?? "parallel",
    now: () => clock.now,
    mark: (label, branch, at) => { marks.push([label, branch]); markedAt.push(at ?? clock.now); },
  };
  const answerOpen = (i: number) => {
    const s: FakeStream = { id: `s${i}`, deviceId: opens[i].deviceId, stopped: false };
    streams.push(s);
    opens[i].answer.resolve(s);
    return s;
  };
  /** The marks in the order of the moments they record. */
  const timeline = () => marks
    .map(([label, branch], i) => ({ label, branch, at: markedAt[i] }))
    .sort((a, b) => a.at - b.at)
    .map((m) => `${m.label}/${m.branch}@${m.at}`);
  return { deps, events, marks, opens, list, graphs, streams, closedGraphs, answerOpen, clock, timeline };
}

describe("runLiveStart — the microphone does not wait for the session", () => {
  it("asks for the microphone and the graph at the press, while the archive, socket, storage and draft are still pending", async () => {
    const world = fakeCapture();
    // The session branch as main.tsx runs it: the archive folder first,
    // then the socket, the capture storage and the previous draft.
    const archive = deferred<string>();
    const socketOpen = deferred<void>();
    const storage = deferred<void>();
    const draftRead = deferred<void>();
    const sessionSteps: string[] = [];
    let handle: ColdCaptureHandle<FakeStream, FakeGraph, Choice> | null = null;
    let connected: { session: string; stream: FakeStream; graph: FakeGraph | null } | null = null;

    const started = runLiveStart({
      beginCapture: () => (handle = beginColdCapture(world.deps)),
      prepareSession: async () => {
        sessionSteps.push("archive");
        const dir = await archive.promise;
        sessionSteps.push("socket");
        await socketOpen.promise;
        sessionSteps.push("storage");
        await storage.promise;
        sessionSteps.push("draft");
        await draftRead.promise;
        return dir;
      },
      connect: async (session, capture) => {
        const opened = await capture.ready;
        connected = { session, stream: opened.stream, graph: opened.graph };
      },
      abandonCapture: (capture) => capture.abandon(),
    });

    // Nothing of the session has answered: the device is already being opened.
    expect(world.events).toEqual(["open:built-in", "list", "graph"]);
    expect(sessionSteps).toEqual(["archive"]);

    // The microphone opens, the list confirms it, the graph is ready —
    // all while the session is still waiting on its archive folder.
    world.answerOpen(0);
    world.list.resolve({ deviceId: "built-in", reason: "fresh-list" });
    world.graphs[0].resolve({ id: 1, closed: false });
    await settle();
    let readyEarly = false;
    void handle!.ready.then(() => { readyEarly = true; });
    await settle();
    expect(readyEarly).toBe(true);
    expect(connected).toBeNull();

    archive.resolve("/archive");
    socketOpen.resolve();
    storage.resolve();
    draftRead.resolve();
    await started;
    expect(sessionSteps).toEqual(["archive", "socket", "storage", "draft"]);
    expect(connected).toEqual({ session: "/archive", stream: world.streams[0], graph: { id: 1, closed: false } });
    // One open, nothing released: the device was right the first time.
    expect(world.opens).toHaveLength(1);
    expect(world.streams[0].stopped).toBe(false);
  });

  it("a session that ends the start releases the microphone that opened beside it, even one that answers later", async () => {
    const world = fakeCapture();
    const archive = deferred<string | null>();
    const started = runLiveStart({
      beginCapture: () => beginColdCapture(world.deps),
      prepareSession: () => archive.promise,
      connect: async () => { throw new Error("must not connect"); },
      abandonCapture: (capture) => capture.abandon(),
    });
    world.graphs[0].resolve({ id: 1, closed: false });
    await settle();
    archive.resolve(null); // the archive folder is not ready
    await started;
    expect(world.closedGraphs).toHaveLength(1);
    // The device answers after the start ended: stopped on arrival.
    const late = world.answerOpen(0);
    await settle();
    expect(late.stopped).toBe(true);
  });

  it("a session that throws abandons the capture and rethrows", async () => {
    const world = fakeCapture();
    const started = runLiveStart({
      beginCapture: () => beginColdCapture(world.deps),
      prepareSession: async () => { throw new Error("session broke"); },
      connect: async () => { /* unreachable */ },
      abandonCapture: (capture) => capture.abandon(),
    });
    await expect(started).rejects.toThrow("session broke");
    world.answerOpen(0);
    await settle();
    expect(world.streams[0].stopped).toBe(true);
  });
});

describe("beginColdCapture — choosing, verifying and preparing", () => {
  it("opens once when the fresh list confirms the choice, whichever answers first", async () => {
    const world = fakeCapture();
    const handle = beginColdCapture(world.deps);
    world.clock.now = 10;
    world.answerOpen(0);
    await settle();
    world.clock.now = 25;
    world.list.resolve({ deviceId: "built-in", reason: "fresh-list" });
    world.graphs[0].resolve({ id: 1, closed: false });
    const opened = await handle.ready;
    expect(opened.stream).toBe(world.streams[0]);
    expect(opened.reopened).toBe(false);
    expect(opened.choice.reason).toBe("fresh-list");
    expect(world.opens).toHaveLength(1);
    // The list answered after the device: that wait is on the chain.
    expect(world.timeline().filter((m) => !m.includes("/graph@"))).toEqual([
      "getUserMedia/mic@10", "loadMics/side@25", "deviceCheck/mic@25",
    ]);
  });

  it("opens the device the fresh list chose and releases the first open", async () => {
    const world = fakeCapture({ initial: "" });
    const handle = beginColdCapture(world.deps);
    // The known list was stale: a device came back under a new id.
    world.list.resolve({ deviceId: "usb-new-id", reason: "picked" });
    await settle();
    expect(world.opens.map((o) => o.deviceId)).toEqual(["", "usb-new-id"]);
    const first = world.answerOpen(0);
    const second = world.answerOpen(1);
    world.graphs[0].resolve({ id: 1, closed: false });
    const opened = await handle.ready;
    await settle();
    expect(opened.stream).toBe(second);
    expect(opened.reopened).toBe(true);
    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(false);
    expect(world.marks.map((m) => m.join("/"))).toContain("micReopen/mic");
    expect(world.marks.map((m) => m.join("/"))).toContain("getUserMedia.discarded/side");
  });

  it("an initial device that cannot be opened is retried on the fresh choice", async () => {
    const world = fakeCapture({ initial: "gone" });
    const handle = beginColdCapture(world.deps);
    world.opens[0].answer.reject(new Error("device gone"));
    world.list.resolve({ deviceId: "", reason: "default" });
    await settle();
    expect(world.opens.map((o) => o.deviceId)).toEqual(["gone", ""]);
    world.answerOpen(1);
    world.graphs[0].resolve({ id: 1, closed: false });
    const opened = await handle.ready;
    expect(opened.stream.deviceId).toBe("");
  });

  it("a list that cannot be read keeps the known choice", async () => {
    const world = fakeCapture();
    const handle = beginColdCapture(world.deps);
    world.list.reject(new Error("enumerate failed"));
    world.answerOpen(0);
    world.graphs[0].resolve({ id: 1, closed: false });
    const opened = await handle.ready;
    expect(opened.choice.deviceId).toBe("built-in");
    expect(world.opens).toHaveLength(1);
  });

  it("hands over the graph prepared beside the microphone instead of building one after it", async () => {
    const world = fakeCapture();
    const handle = beginColdCapture(world.deps);
    // Prepared before the device has answered.
    expect(world.events).toContain("graph");
    world.graphs[0].resolve({ id: 7, closed: false });
    world.list.resolve({ deviceId: "built-in", reason: "fresh-list" });
    await settle();
    world.answerOpen(0);
    const opened = await handle.ready;
    expect(opened.graph).toEqual({ id: 7, closed: false });
    expect(world.graphs).toHaveLength(1);
    expect(world.closedGraphs).toHaveLength(0);
  });

  it("a graph that fails to prepare does not fail the start: the stream is handed over without it", async () => {
    const world = fakeCapture();
    const handle = beginColdCapture(world.deps);
    world.graphs[0].reject(new Error("AudioContext construction failed"));
    world.list.resolve({ deviceId: "built-in", reason: "fresh-list" });
    world.answerOpen(0);
    const opened = await handle.ready;
    expect(opened.graph).toBeNull();
    expect(String(opened.graphError)).toContain("AudioContext construction failed");
    expect(opened.stream.stopped).toBe(false);
  });

  it("a first open discarded by the fresh list is off the path, even when it answered first", async () => {
    const world = fakeCapture({ initial: "" });
    const handle = beginColdCapture(world.deps);
    world.clock.now = 40;
    world.answerOpen(0);
    await settle();
    world.clock.now = 55;
    world.list.resolve({ deviceId: "usb", reason: "picked" });
    await settle();
    world.clock.now = 300;
    world.answerOpen(1);
    world.graphs[0].resolve({ id: 1, closed: false });
    await handle.ready;
    await settle();
    // The reopen began when the list answered: that, not the first open,
    // is the chain. The first open is listed beside it at its own moment.
    expect(world.timeline().filter((m) => !m.includes("/graph@"))).toEqual([
      "getUserMedia.discarded/side@40", "loadMics/mic@55", "micReopen/mic@300",
    ]);
    expect(world.streams[0].stopped).toBe(true);
  });

  it("sequential: the list is read before any open, then the device it chose, then the graph — all on the mic chain", async () => {
    const world = fakeCapture({ mode: "sequential" });
    const handle = beginColdCapture(world.deps);
    await settle();
    expect(world.events).toEqual(["list"]);
    world.list.resolve({ deviceId: "built-in-fresh", reason: "fresh-list" });
    await settle();
    expect(world.events).toEqual(["list", "open:built-in-fresh"]);
    world.answerOpen(0);
    await settle();
    expect(world.events).toEqual(["list", "open:built-in-fresh", "graph"]);
    world.graphs[0].resolve({ id: 1, closed: false });
    const opened = await handle.ready;
    expect(opened.reopened).toBe(false);
    expect(world.opens).toHaveLength(1);
    expect(world.marks.map((m) => m.join("/"))).toEqual([
      "loadMics/mic", "getUserMedia/mic", "audioContext/mic", "workletModule/mic",
    ]);
  });

  it("a microphone that cannot be opened rejects and releases the graph prepared beside it", async () => {
    const world = fakeCapture();
    const handle = beginColdCapture(world.deps);
    world.graphs[0].resolve({ id: 1, closed: false });
    world.list.resolve({ deviceId: "built-in", reason: "fresh-list" });
    world.opens[0].answer.reject(new Error("Permission denied"));
    await expect(handle.ready).rejects.toThrow("Permission denied");
    expect(world.closedGraphs).toEqual([{ id: 1, closed: true }]);
  });

  it("abandon after hand-over is a no-op: the caller owns what it was given", async () => {
    const world = fakeCapture();
    const handle = beginColdCapture(world.deps);
    world.list.resolve({ deviceId: "built-in", reason: "fresh-list" });
    world.answerOpen(0);
    world.graphs[0].resolve({ id: 1, closed: false });
    const opened = await handle.ready;
    handle.abandon();
    expect(opened.stream.stopped).toBe(false);
    expect(world.closedGraphs).toHaveLength(0);
  });
});

describe("planColdCapture — the one rule for running ahead of a fresh device list", () => {
  const builtIn = { deviceId: "mac", label: "MacBook Pro Microphone (Built-in)" };
  const usb = { deviceId: "usb", label: "Shure MV7 (USB)" };
  const headset = { deviceId: "bt", label: "Leo Liberty 5 BT (Bluetooth)" };
  const alias = (d: { label: string }) => ({ deviceId: "default", label: `Default - ${d.label}` });

  it("runs ahead only on a current, named list where neither the choice nor the default is Bluetooth", () => {
    expect(planColdCapture({ listCurrent: true, devices: [alias(builtIn), builtIn, usb], choiceLabel: builtIn.label }))
      .toEqual({ mode: "parallel", reason: "known-list" });
    expect(planColdCapture({ listCurrent: false, devices: [alias(builtIn), builtIn], choiceLabel: builtIn.label }).reason)
      .toBe("list-not-current");
    expect(planColdCapture({ listCurrent: true, devices: [{ deviceId: "", label: "" }], choiceLabel: "" }).reason)
      .toBe("list-unnamed");
    expect(planColdCapture({ listCurrent: true, devices: [alias(builtIn), builtIn, headset], choiceLabel: headset.label }).reason)
      .toBe("bluetooth-choice");
    // A device the list cannot name counts as Bluetooth.
    expect(planColdCapture({ listCurrent: true, devices: [alias(builtIn), builtIn], choiceLabel: "" }).reason)
      .toBe("bluetooth-choice");
    // The built-in mic chosen over a Bluetooth default: the default is still
    // what a failed or default open lands on.
    expect(planColdCapture({ listCurrent: true, devices: [alias(headset), headset, builtIn], choiceLabel: builtIn.label }).reason)
      .toBe("bluetooth-default");
  });

  // The two ways an open ahead of the list put a Bluetooth headset into
  // its call profile: run each through the plan and the capture together.
  async function runStart(plan: ReturnType<typeof planColdCapture>, initial: string, fresh: string) {
    const world = fakeCapture({ initial, mode: plan.mode });
    const handle = beginColdCapture(world.deps);
    await settle();
    const before = [...world.events];
    world.list.resolve({ deviceId: fresh, reason: "fresh-list" });
    await settle();
    world.answerOpen(world.opens.length - 1);
    await settle();
    world.graphs[0]?.resolve({ id: 1, closed: false });
    await handle.ready;
    return { before, world };
  }

  it("a headset that has just connected (the list not yet refreshed): no open and no graph before the fresh list, and the graph after the microphone", async () => {
    // The known list still says built-in; the devicechange has arrived but
    // its enumeration has not finished.
    const plan = planColdCapture({ listCurrent: false, devices: [alias(builtIn), builtIn], choiceLabel: builtIn.label });
    const { before, world } = await runStart(plan, "", "");
    expect(before).toEqual(["list"]);
    expect(world.opens.map((o) => o.deviceId)).toEqual([""]);
    expect(world.events.indexOf("graph")).toBeGreaterThan(world.events.indexOf("open:"));
  });

  it("'Bluetooth → built-in' with a Bluetooth default: the headset's microphone is never opened", async () => {
    const devices = [alias(headset), headset, builtIn];
    const choice = chooseCaptureDevice({ requestedDeviceId: "", preferBuiltInOverBluetooth: true, devices });
    expect(choice.deviceId).toBe("mac");
    // Even on a current list: a failed open would fall back to the default.
    const plan = planColdCapture({ listCurrent: true, devices, choiceLabel: choice.label });
    const { before, world } = await runStart(plan, choice.deviceId, choice.deviceId);
    expect(before).toEqual(["list"]);
    expect(world.opens.map((o) => o.deviceId)).toEqual(["mac"]);
    // A stale list that still names the built-in mic as the default: the
    // default-alias open would land on the headset — not attempted either.
    const stale = planColdCapture({ listCurrent: false, devices: [alias(builtIn), builtIn], choiceLabel: alias(builtIn).label });
    const second = await runStart(stale, "", "mac");
    expect(second.before).toEqual(["list"]);
    expect(second.world.opens.map((o) => o.deviceId)).toEqual(["mac"]);
  });
});

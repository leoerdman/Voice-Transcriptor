import { describe, expect, it } from "vitest";

import { summarizeStartTrace, type StartMark } from "../src/start-trace";

const mark = (label: string, branch: StartMark["branch"], atMs: number): StartMark => ({ label, branch, atMs });

/** How the support-log analysis reads the line: every ``label: Nms`` after the first ``|``. */
function parseChain(detail: string): Array<[string, number]> {
  return Array.from(detail.matchAll(/([\w.-]+): (\d+)ms/g), (m) => [m[1], Number(m[2])] as [string, number]);
}

describe("start trace — the chain that set the total", () => {
  // The 1.6.40 cold start that motivated the branches, as it would run now:
  // the storage and the archive finish during the microphone open.
  const cold: StartMark[] = [
    mark("staleDraftRead", "side", 2),
    mark("archiveReady", "session", 20),
    mark("loadMics", "side", 22),
    mark("wsRequested", "session", 36),
    mark("sessionReady", "session", 37),
    mark("audioContext", "graph", 40),
    mark("pcmSink", "side", 50),
    mark("workletModule", "graph", 55),
    mark("getUserMedia", "mic", 514),
    mark("mediaRecorder", "capture", 515),
    mark("captureConnected", "capture", 517),
    mark("first-frame", "capture", 571),
  ];

  it("lists only the critical branch and the capture as steps, and they add up to the total", () => {
    const s = summarizeStartTrace(cold, 571);
    expect(s.critical).toBe("mic");
    expect(s.chain).toEqual([
      ["getUserMedia", 514],
      ["mediaRecorder", 1],
      ["captureConnected", 2],
      ["first-frame", 54],
    ]);
    expect(s.chain.reduce((n, [, d]) => n + d, 0)).toBe(571);
    expect(s.detail).toBe(
      "getUserMedia: 514ms → mediaRecorder: 1ms → captureConnected: 2ms → first-frame: 54ms" +
      " || branches: mic=514ms graph=55ms session=37ms critical=mic" +
      " | off-path: staleDraftRead@2ms archiveReady@20ms loadMics@22ms wsRequested@36ms sessionReady@37ms audioContext@40ms pcmSink@50ms workletModule@55ms",
    );
  });

  it("a log reader that sums `label: Nms` gets the critical path and nothing else", () => {
    const parsed = parseChain(summarizeStartTrace(cold, 571).detail);
    expect(parsed.map(([l]) => l)).toEqual(["getUserMedia", "mediaRecorder", "captureConnected", "first-frame"]);
    expect(parsed.reduce((n, [, d]) => n + d, 0)).toBe(571);
  });

  it("names the session as critical when it, not the microphone, finished last (warm start)", () => {
    const s = summarizeStartTrace([
      mark("warmCapture", "mic", 0),
      mark("archiveReady", "session", 3),
      mark("wsRequested", "session", 6),
      mark("sessionReady", "session", 7),
      mark("warmWorkletStart", "capture", 7),
      mark("first-frame", "capture", 9),
    ], 9);
    expect(s.critical).toBe("session");
    expect(s.chain).toEqual([
      ["archiveReady", 3], ["wsRequested", 3], ["sessionReady", 1], ["warmWorkletStart", 0], ["first-frame", 2],
    ]);
    expect(s.offPath.map((m) => m.label)).toEqual(["warmCapture"]);
  });

  it("names the capture's context resume as a step of its own, never a second step of the same name", () => {
    // The graph branch marked the context it built; the capture branch then
    // resumed that same context after it had been suspended. Marking the
    // resume as "audioContext" printed the name twice and said two contexts
    // had been built when one had.
    const s = summarizeStartTrace([
      mark("audioContext", "graph", 40),
      mark("workletModule", "graph", 60),
      mark("getUserMedia", "mic", 300),
      mark("audioContextResume", "capture", 301),
      mark("captureConnected", "capture", 303),
      mark("first-frame", "capture", 350),
    ], 350);
    // The capture branch is the one that finished last here, so its resume
    // is a step of the chain and the graph's creation is off-path; both
    // are named, and no name appears twice.
    const labels = [...s.chain.map(([l]) => l), ...s.offPath.map((m) => m.label)];
    expect(labels).toContain("audioContext");
    expect(labels).toContain("audioContextResume");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("a graph slower than the microphone is the critical branch", () => {
    const s = summarizeStartTrace([
      mark("getUserMedia", "mic", 60),
      mark("audioContext", "graph", 70),
      mark("workletModule", "graph", 140),
      mark("sessionReady", "session", 10),
      mark("captureConnected", "capture", 141),
      mark("first-frame", "capture", 160),
    ], 160);
    expect(s.critical).toBe("graph");
    expect(s.chain.map(([l]) => l)).toEqual(["audioContext", "workletModule", "captureConnected", "first-frame"]);
  });
});

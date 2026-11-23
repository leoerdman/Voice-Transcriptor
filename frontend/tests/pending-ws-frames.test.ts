import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { PendingWsFrames } from "../src/pending-ws-frames";
import { liveTakeAfterVoiceTakeNotice, type LiveTake } from "../src/take-collection";

const mainTsx = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const LIVE_SAMPLE_RATE_HZ = 16_000;
const pendingMaxSeconds = Number(/const WS_PENDING_MAX_SEC = (\d+);/.exec(mainTsx)?.[1]);

describe("pending live WebSocket audio", () => {
  it("keeps every frame across a 7.6-second handshake and a failed screen overlay", () => {
    const sessionId = "screen-20261120-100000-000";
    expect(pendingMaxSeconds).toBeGreaterThanOrEqual(7.6);
    const queue = new PendingWsFrames(LIVE_SAMPLE_RATE_HZ * pendingMaxSeconds);
    const frameSamples = Math.round(LIVE_SAMPLE_RATE_HZ / 50);
    const captured: ArrayBuffer[] = [];
    let take: LiveTake = { mode: "screen", screenSessionId: sessionId };

    for (let frame = 0; frame < 380; frame += 1) {
      const pcm = new Uint8Array([frame & 0xff]).buffer;
      captured.push(pcm);
      expect(queue.enqueue(pcm, frameSamples)).toBe(true);
      if (frame === 100) {
        take = liveTakeAfterVoiceTakeNotice(take, sessionId);
        expect(take).toEqual({ mode: "voice", screenSessionId: "" });
      }
    }

    const received: ArrayBuffer[] = [];
    expect(queue.flush((pcm) => { received.push(pcm); return true; })).toBe(0);
    expect(received).toEqual(captured);
    expect(queue.length).toBe(0);
    expect(mainTsx).toContain('flushPendingWsFrames(sessionSocket);');
    const noticeHandler = /function subscribeToScreenVoiceTake\(\): void \{([\s\S]*?)\n\}/.exec(mainTsx)?.[1] || "";
    expect(noticeHandler).toContain("liveTakeAfterVoiceTakeNotice(");
    expect(noticeHandler).not.toContain("wsPendingFrames.clear()");
  });

  it("rejects audio beyond ten seconds instead of silently evicting older frames", () => {
    const queue = new PendingWsFrames(LIVE_SAMPLE_RATE_HZ * pendingMaxSeconds);
    const original = new Uint8Array([1]).buffer;
    const overflow = new Uint8Array([2]).buffer;
    expect(queue.enqueue(original, LIVE_SAMPLE_RATE_HZ * pendingMaxSeconds)).toBe(true);
    expect(queue.enqueue(overflow, 1)).toBe(false);
    const received: ArrayBuffer[] = [];
    expect(queue.flush((pcm) => { received.push(pcm); return true; })).toBe(0);
    expect(received).toEqual([original]);
  });

  it("retains the failed frame and all following frames after a send failure", () => {
    const queue = new PendingWsFrames(1_000);
    const first = new Uint8Array([1]).buffer;
    const second = new Uint8Array([2]).buffer;
    queue.enqueue(first, 10);
    queue.enqueue(second, 10);
    expect(queue.flush(() => false)).toBe(2);
    const received: ArrayBuffer[] = [];
    expect(queue.flush((pcm) => { received.push(pcm); return true; })).toBe(0);
    expect(received).toEqual([first, second]);
  });
});

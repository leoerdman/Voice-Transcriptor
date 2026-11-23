import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const mainTsx = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");

function mainTsxSlice(header: string, next: string): string {
  const start = mainTsx.indexOf(header);
  const end = mainTsx.indexOf(next, start + header.length);
  return start !== -1 && end > start ? mainTsx.slice(start, end) : "";
}

describe("capture startup and playback contracts", () => {
  it("starts the deferred sink without awaiting it and forwards captured frames to storage and transport", () => {
    const start = mainTsxSlice("async function startLive(", "\nasync function stopLive(");
    const capture = mainTsxSlice("function pushCapturedFrame(", "\nfunction ");
    expect(start).toContain("new DeferredPcmSink(");
    expect(start).not.toContain("await createPcmSink(");
    expect(capture).toContain("pcmSink.append(ds);");
    expect(capture.indexOf("pcmSink.append(ds);")).toBeLessThan(capture.indexOf("if (!ws) return;"));
    expect(capture).toContain("dv.setInt16(i * 2, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);");
    expect(capture).toContain("ws.send(pcm);");
  });

  it("uses the range-stream URL for saved Live audio", () => {
    const live = mainTsxSlice("async function renderLatestSavedAudio(", "\nfunction setLatestSavedAudio(");
    expect(live).toContain("mintRecordingStreamUrl(");
    expect(live).toContain("playbackUrl = minted.url;");
    expect(live).not.toContain("fetchSavedAudioFromBackend(");
    expect(live).not.toContain("URL.createObjectURL(audioFile)");
  });
});

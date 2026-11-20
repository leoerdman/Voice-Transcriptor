import { describe, it, expect } from "vitest";

import { livePaneDisplayText, LIVE_PANE_STATUS_PREFIX } from "../src/live-pane";

const base = { recording: false, started: false, timerText: "00:00" };

describe("livePaneDisplayText", () => {
  it("is empty when idle with preview off (placeholder shows through)", () => {
    expect(livePaneDisplayText(base)).toBe("");
  });

  it("is empty while recording but the first frame has not landed yet", () => {
    expect(livePaneDisplayText({ ...base, recording: true })).toBe("");
  });

  it("shows the status line once capture is live", () => {
    const text = livePaneDisplayText({ ...base, recording: true, started: true, timerText: "00:42" });
    expect(text).toBe(
      `${LIVE_PANE_STATUS_PREFIX} 00:42 — live preview is off; the transcript will appear here after Stop.`,
    );
    expect(text).toContain("00:42");
    expect(text).toContain("after Stop");
  });

  it("clears as soon as the recording stops, even before state resets", () => {
    expect(livePaneDisplayText({ ...base, recording: false, started: true, timerText: "1:03" })).toBe("");
  });

  it("cannot be asked to own preview-on rendering — that stays in the caller (FL-21)", () => {
    // Compile-time: ``npm run typecheck`` covers tests/, so a caller that
    // passes a preview flag no longer builds. The run-time half: the
    // function answers only from the preview-off inputs.
    // @ts-expect-error previewEnabled is not part of LivePaneInput
    const text = livePaneDisplayText({ ...base, previewEnabled: true, recording: true, started: true });
    expect(text.startsWith(LIVE_PANE_STATUS_PREFIX)).toBe(true);
  });
});

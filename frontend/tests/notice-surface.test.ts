import { describe, expect, it } from "vitest";
import { historyFailureSurfaces, noticeSurfaces } from "../src/notice-surface";

describe("historyFailureSurfaces (FU-04)", () => {
  it("never writes a failure into the transcript body Copy copies", () => {
    expect(historyFailureSurfaces(true).body).toBe(false);
    expect(historyFailureSurfaces(false).body).toBe(false);
  });

  it("keeps an open transcript and reports through the status pill", () => {
    expect(historyFailureSurfaces(true)).toEqual({ status: true, placeholder: false, body: false });
  });

  it("uses the empty viewer's placeholder when nothing is open", () => {
    expect(historyFailureSurfaces(false)).toEqual({ status: true, placeholder: true, body: false });
  });
});

describe("noticeSurfaces (FU-03)", () => {
  it("shows a notice raised from Settings or History in the status pill too", () => {
    // e.g. "That shortcut is already bound…" while Settings is on screen.
    expect(noticeSurfaces("settings")).toEqual({ banner: true, status: true });
    expect(noticeSurfaces("recordings")).toEqual({ banner: true, status: true });
    expect(noticeSurfaces("upload")).toEqual({ banner: true, status: true });
  });

  it("uses the banner alone while the Live view is on screen", () => {
    expect(noticeSurfaces("record")).toEqual({ banner: true, status: false });
  });

  it("does not drop a notice when no view could be identified", () => {
    expect(noticeSurfaces(null).status).toBe(true);
  });
});

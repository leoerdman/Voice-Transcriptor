import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  UI_COPY,
  applyStaticUiCopy,
  renderAcceptedFormatsHint,
  resultPaneTitle,
} from "../src/ui-copy";

/**
 * Every string below appeared on two surfaces — typed into
 * `index.html` for the state before anything runs, and again as a
 * literal in `main.tsx` where the renderer restores that state. These
 * tests hold the markup to carrying none of them (the half no import
 * can check) and hold `applyStaticUiCopy` to putting all of them back
 * (the half that makes the markup safe to empty).
 */
const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

function markup(): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("the markup carries no copy of its own", () => {
  const strings: Array<[string, string]> = [
    ["result placeholder", UI_COPY.resultPlaceholder],
    ["History viewer placeholder", UI_COPY.recordings.viewerPlaceholder],
    ["History viewer title", UI_COPY.recordings.viewerTitlePlaceholder],
    ["Upload empty-state title", UI_COPY.upload.emptyTitle],
    ["Upload empty-state lead", UI_COPY.upload.emptyLead],
  ];
  for (const [name, value] of strings) {
    it(`does not repeat the ${name}`, () => {
      expect(html).not.toContain(value);
    });
  }

  it("leaves the file dialog's filter to ui-copy", () => {
    const input = markup().getElementById("uploadLargeFileInput") as HTMLInputElement | null;
    expect(input, "#uploadLargeFileInput missing").toBeTruthy();
    expect(input?.getAttribute("accept")).toBeNull();
  });

  it("leaves the shortcut keycaps to the renderer (desktop/shortcut-defaults.json is their source) (FU-09)", () => {
    const rows = Array.from(markup().querySelectorAll(".shortcut-btn .shortcut-keys"));
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.children.length).toBe(0);
      expect(row.getAttribute("aria-label")).toBeNull();
    }
  });

  it("does not claim a list of accepted formats the backend has not reported", () => {
    expect(html).not.toContain("WAV · MP3");
    const el = markup().getElementById("uploadAcceptedFormats");
    expect(el?.textContent?.trim()).toBe("");
    expect(el?.hasAttribute("hidden")).toBe(true);
  });
});

describe("applyStaticUiCopy", () => {
  it("writes every placeholder the markup no longer carries", () => {
    const doc = markup();
    applyStaticUiCopy(doc);
    expect(doc.getElementById("finalOutput")?.getAttribute("data-placeholder"))
      .toBe(UI_COPY.resultPlaceholder);
    expect(doc.getElementById("recordingContent")?.getAttribute("data-placeholder"))
      .toBe(UI_COPY.recordings.viewerPlaceholder);
    expect(doc.getElementById("recordingTitleLabel")?.textContent)
      .toBe(UI_COPY.recordings.viewerTitlePlaceholder);
    expect((doc.getElementById("uploadLargeFileInput") as HTMLInputElement).accept)
      .toBe(UI_COPY.upload.fileAccept);
  });

  it("rebuilds the Upload empty state, keeping History bold", () => {
    const doc = markup();
    applyStaticUiCopy(doc);
    const sub = doc.querySelector("#uploadEmptyState .upload-empty-state-sub");
    expect(doc.querySelector("#uploadEmptyState .upload-empty-state-title")?.textContent)
      .toBe(UI_COPY.upload.emptyTitle);
    expect(sub?.textContent).toBe(
      UI_COPY.upload.emptyLead
      + UI_COPY.upload.emptyTailBefore
      + UI_COPY.upload.emptyTailStrong
      + UI_COPY.upload.emptyTailAfter,
    );
    expect(sub?.querySelector("b")?.textContent).toBe(UI_COPY.upload.emptyTailStrong);
    expect(sub?.querySelector("br")).toBeTruthy();
  });

  it("is idempotent — boot may run it more than once", () => {
    const doc = markup();
    applyStaticUiCopy(doc);
    const first = doc.querySelector("#uploadEmptyState .upload-empty-state-sub")?.innerHTML;
    applyStaticUiCopy(doc);
    expect(doc.querySelector("#uploadEmptyState .upload-empty-state-sub")?.innerHTML).toBe(first);
  });

  it("skips elements a stripped-down document does not have", () => {
    const doc = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
    expect(() => applyStaticUiCopy(doc)).not.toThrow();
  });
});

describe("renderAcceptedFormatsHint", () => {
  it("shows what the backend accepts, upper-cased and sorted", () => {
    const doc = markup();
    renderAcceptedFormatsHint(doc, ["mp3", "wav", "m4a"]);
    const el = doc.getElementById("uploadAcceptedFormats") as HTMLElement;
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("M4A · MP3 · WAV");
  });

  it("tolerates leading dots, blanks and duplicates from the wire", () => {
    const doc = markup();
    renderAcceptedFormatsHint(doc, [".ogg", "", "flac"]);
    expect(doc.getElementById("uploadAcceptedFormats")?.textContent).toBe("FLAC · OGG");
  });

  it("claims nothing while the list is unknown", () => {
    const doc = markup();
    renderAcceptedFormatsHint(doc, ["mp3"]);
    renderAcceptedFormatsHint(doc, []);
    const el = doc.getElementById("uploadAcceptedFormats") as HTMLElement;
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe("");
  });
});

describe("resultPaneTitle", () => {
  const CAP = 60;

  it("names the file being shown", () => {
    expect(resultPaneTitle("interview.m4a", CAP)).toBe("Result · interview.m4a");
  });

  it("truncates a long name instead of dropping it", () => {
    const long = "a".repeat(120);
    const title = resultPaneTitle(long, CAP);
    expect(title.startsWith(UI_COPY.upload.resultTitlePrefix)).toBe(true);
    expect(title.length).toBeLessThanOrEqual(CAP);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toBe(UI_COPY.upload.resultTitleEmpty);
  });

  it("keeps a name that exactly fits whole", () => {
    const exact = "b".repeat(CAP - UI_COPY.upload.resultTitlePrefix.length);
    expect(resultPaneTitle(exact, CAP)).toBe(`${UI_COPY.upload.resultTitlePrefix}${exact}`);
  });

  it("says just Result when there is no item", () => {
    expect(resultPaneTitle("", CAP)).toBe(UI_COPY.upload.resultTitleEmpty);
    expect(resultPaneTitle("   ", CAP)).toBe(UI_COPY.upload.resultTitleEmpty);
  });

  it("says just Result rather than a one-character name", () => {
    expect(resultPaneTitle("interview.m4a", 10)).toBe(UI_COPY.upload.resultTitleEmpty);
  });
});

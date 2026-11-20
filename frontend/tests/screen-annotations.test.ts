import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  annotateTranscript,
  parseScreenManifest,
  regionWords,
  screenSessionDurationMs,
  screenMarksFromManifest,
  speechFractionAt,
  wordStartsFromSegments,
} from "../src/screen-annotations";

const START = 1_700_000_000_000;

const manifest = parseScreenManifest({
  id: "screen-20261120-100000-000",
  dir: "/data/screen-sessions/screen-20261120-100000-000",
  startedAt: START + 300,
  events: [
    { type: "shot", at: START + 15_000, shot: 1, files: ["/d/shot-01.png"] },
    { type: "stroke", at: START + 12_400, shot: 1, xPct: 82, yPct: 14 },
    { type: "bogus", at: START },
    { type: "stroke", at: "never" },
  ],
})!;

describe("screen manifest", () => {
  it("keeps well-formed events only, in time order", () => {
    expect(manifest.events.map((e) => e.type)).toEqual(["stroke", "shot"]);
  });

  it("turns events into marks timed against the recording clock", () => {
    const marks = screenMarksFromManifest(manifest, START);
    expect(marks).toEqual([
      { atMs: 12_400, text: "[✏️ 00:12 линия вверху справа (82%, 14%) → скрин 1]" },
      { atMs: 15_000, text: "[📸 00:15 скрин 1: /d/shot-01.png]" },
    ]);
  });

  it("says a screenshot was not saved when its capture failed", () => {
    const m = parseScreenManifest({ id: "s", dir: "/d", startedAt: START, events: [{ type: "shot", at: START + 1000, shot: 2, files: [] }] })!;
    expect(screenMarksFromManifest(m, START)[0].text).toBe("[📸 00:01 скрин 2 — не сохранён (нет доступа к записи экрана)]");
  });

  it("places from the archived audio clock when the manifest has one", () => {
    const archived = parseScreenManifest({ ...manifest, audioStartedAt: START + 1_000 })!;
    expect(screenMarksFromManifest(archived, START)[0].atMs).toBe(11_400);
  });

  it("knows the take's length from the archived time frame alone", () => {
    expect(screenSessionDurationMs(parseScreenManifest({ ...manifest, audioStartedAt: START, endedAt: START + 30_000 })!)).toBe(30_000);
    expect(screenSessionDurationMs(parseScreenManifest({ ...manifest, endedAt: START + 30_300 })!)).toBe(30_000);
    expect(screenSessionDurationMs(manifest)).toBe(0);
  });

  it("falls back to the session start when the recording clock is unknown", () => {
    expect(screenMarksFromManifest(manifest, 0)[0].atMs).toBe(12_100);
  });

  it("rejects a non-object", () => {
    expect(parseScreenManifest(null)).toBeNull();
    expect(parseScreenManifest("x")).toBeNull();
  });
});

describe("region words", () => {
  it("name the 3x3 cell of the display", () => {
    expect(regionWords(5, 5)).toBe("вверху слева");
    expect(regionWords(50, 50)).toBe("в центре");
    expect(regionWords(95, 95)).toBe("внизу справа");
    expect(regionWords(50, 90)).toBe("внизу по центру");
  });
});

describe("contracts/screen-session.json", () => {
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), "../contracts/screen-session.json"), "utf-8"));

  it("the archived manifest's audio clock is read", () => {
    const m = parseScreenManifest({ ...contract.manifest, ...contract.archivedManifest })!;
    expect(m.audioStartedAt).toBe(contract.archivedManifest.audioStartedAt);
  });

  it("its manifest reads in full and yields one mark per event", () => {
    const m = parseScreenManifest(contract.manifest)!;
    expect(m.events.length).toBe(contract.manifest.events.length);
    const marks = screenMarksFromManifest(m, contract.manifest.startedAt);
    expect(marks[0].text).toBe("[✏️ 00:12 линия вверху справа (82%, 14%) → скрин 1]");
    expect(marks[1].text).toContain(contract.manifest.events[1].files[0]);
  });
});

describe("placement", () => {
  it("spreads a segment's words over its span", () => {
    expect(wordStartsFromSegments([{ start: 1, end: 2, text: "a b" }, { start: 5, end: 5, text: "c" }])).toEqual([
      1000, 1500, 5000,
    ]);
  });

  it("uses word timings when present, duration otherwise", () => {
    expect(speechFractionAt(1600, { wordStartsMs: [1000, 1500, 5000, 6000] })).toBe(0.5);
    expect(speechFractionAt(2500, { durationMs: 10_000 })).toBe(0.25);
    expect(speechFractionAt(2500, {})).toBe(1);
  });

  it("puts a mark at the word boundary of its moment in speech", () => {
    const text = "вот тут кнопка съехала совсем";
    const wordStartsMs = [0, 1000, 2000, 3000, 4000];
    const out = annotateTranscript(text, [{ atMs: 1500, text: "[M]" }], { wordStartsMs });
    expect(out).toBe("вот тут [M] кнопка съехала совсем");
  });

  it("keeps the order of marks that land on the same boundary, and appends late ones", () => {
    const out = annotateTranscript(
      "раз два",
      [
        { atMs: 9000, text: "[late]" },
        { atMs: 100, text: "[a]" },
        { atMs: 200, text: "[b]" },
      ],
      { wordStartsMs: [0, 5000] },
    );
    expect(out).toBe("раз [a] [b] два [late]");
  });

  it("places proportionally in a rewritten text with no timings of its own", () => {
    const out = annotateTranscript("one two three four", [{ atMs: 5000, text: "[M]" }], { durationMs: 10_000 });
    expect(out).toBe("one two [M] three four");
  });

  it("keeps the marks when nothing was said", () => {
    expect(annotateTranscript("", [{ atMs: 1, text: "[a]" }, { atMs: 2, text: "[b]" }])).toBe("[a]\n[b]");
  });

  it("returns the text unchanged with no marks", () => {
    expect(annotateTranscript("as is", [])).toBe("as is");
  });
});

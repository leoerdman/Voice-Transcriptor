import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AFTER_LAST_SHOT_HEADING,
  EMPTY_SCREEN_ANNOTATION,
  SCREEN_COLOR_NAMES,
  annotateTranscript,
  parseScreenManifest,
  regionWords,
  screenAnnotationFromManifest,
  screenSessionDurationMs,
  speechFractionAt,
  wordStartsFromSegments,
  type ScreenAnnotation,
  type ScreenMark,
} from "../src/screen-annotations";

const START = 1_700_000_000_000;

/** Inline marks with no header or sections — what the placement suite places. */
const marksOnly = (marks: ScreenMark[]): ScreenAnnotation => ({ marks, header: "", sections: [] });
const texts = (a: ScreenAnnotation): string[] => a.marks.map((m) => m.text);

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

// ── Manifest v3 (desktop): numbered strokes with tool, shape, frame and
//    crop; shots with a preview and the captured area; clicks. Three
//    shots, the second with nothing drawn on it, and words after the last.
const DIR = "/rec/Screen Sessions/20261121-100000.screens";
const fixtureRaw = {
  version: 3,
  id: "screen-20261121-100000-000",
  dir: DIR,
  startedAt: START,
  audioStartedAt: START,
  endedAt: START + 70_000,
  events: [
    { type: "stroke", at: START + 12_000, endedAt: START + 14_000, color: "#ffcc00", shot: 1, n: 1, tool: "rect", shape: "rect", box: { x: 5, y: 8, w: 20, h: 10 }, xPct: 15, yPct: 13, crop: `${DIR}/shot-01-n1.jpg` },
    { type: "stroke", at: START + 20_000, endedAt: START + 20_400, color: "#FF3B30", shot: 1, n: 2, tool: "pen", shape: "loop", box: { x: 60, y: 40, w: 10, h: 12 }, xPct: 65, yPct: 46, crop: `${DIR}/shot-01-n2.jpg` },
    { type: "shot", at: START + 25_000, shot: 1, files: [`${DIR}/shot-01.png`], preview: `${DIR}/shot-01-preview.jpg`, area: "window", strokes: 2, reason: "hotkey" },
    { type: "shot", at: START + 40_000, shot: 2, files: [`${DIR}/shot-02.png`], preview: `${DIR}/shot-02-preview.jpg`, area: "display", strokes: 0, reason: "capsule" },
    { type: "click", at: START + 45_000, shot: 3, xPct: 80, yPct: 50 },
    { type: "stroke", at: START + 50_000, endedAt: START + 52_000, color: "#123456", shot: 3, n: 1, tool: "rect", shape: "line", box: { x: 40, y: 85, w: 30, h: 0 }, xPct: 55, yPct: 85 },
    { type: "shot", at: START + 60_000, shot: 3, files: [`${DIR}/shot-03.png`], area: "window", strokes: 1, reason: "hotkey" },
  ],
};
const fixture = parseScreenManifest(fixtureRaw)!;
const fixtureAnnotation = screenAnnotationFromManifest(fixture);
// 14 words over 70 s: a word every 5 s.
const SPOKEN = "сейчас жёлтым обведу вот эту шапку она съехала а здесь всё нормально спасибо пока";
const DURATION = { durationMs: 70_000 };

const HEADER = [
  `Диктовка с рисованием по экрану · 3 скрина · папка: ${DIR}`,
  "Как читать: «### Скрин K» — снимок и сказанное с прошлого снимка до него; " +
    "[✏️N …] — штрих N (на картинке тот же номер в кружке), стоит там, где начато рисование, [/N] — где отпущено; " +
    "[🖱 клик …] — клик мышью (кольцо на картинке); цвет только различает штрихи; рамки — в % снятой области. " +
    "Файлы: shot-NN.png — скрин, shot-NN-preview.jpg — уменьшенная копия, shot-NN-nK.jpg — вырезка штриха K (не у каждого).",
].join("\n");

const EXPECTED = [
  HEADER,
  [
    "### Скрин 1 · 00:00–00:25 · shot-01-preview.jpg",
    "Штрихи: 1 — 5–25% × 8–18%; 2 — 60–70% × 40–52%",
    "сейчас жёлтым [✏️1 жёлтый, вверху слева] обведу [/1] вот [✏️2 красный обвод, в центре] эту",
  ].join("\n"),
  [
    "### Скрин 2 · 00:25–00:40 · shot-02-preview.jpg · без пометок",
    "шапку она съехала",
  ].join("\n"),
  [
    "### Скрин 3 · 00:40–01:00 · shot-03.png",
    "Штрихи: 1 — 40–70% × 85%",
    "а [🖱 клик, справа] здесь [✏️1 линия, внизу по центру] всё нормально",
  ].join("\n"),
  [
    "### После последнего скрина",
    "спасибо пока",
  ].join("\n"),
].join("\n\n");

describe("screen manifest", () => {
  it("keeps well-formed events only, in time order", () => {
    expect(manifest.events.map((e) => e.type)).toEqual(["stroke", "shot"]);
  });

  it("places from the archived audio clock when the manifest has one", () => {
    const archived = parseScreenManifest({ ...manifest, audioStartedAt: START + 1_000 })!;
    expect(screenAnnotationFromManifest(archived, START).marks[0].atMs).toBe(11_400);
  });

  it("knows the take's length from the archived time frame alone", () => {
    expect(screenSessionDurationMs(parseScreenManifest({ ...manifest, audioStartedAt: START, endedAt: START + 30_000 })!)).toBe(30_000);
    expect(screenSessionDurationMs(parseScreenManifest({ ...manifest, endedAt: START + 30_300 })!)).toBe(30_000);
    expect(screenSessionDurationMs(manifest)).toBe(0);
  });

  it("falls back to the session start when the recording clock is unknown", () => {
    expect(screenAnnotationFromManifest(manifest, 0).marks[0].atMs).toBe(12_100);
  });

  it("rejects a non-object", () => {
    expect(parseScreenManifest(null)).toBeNull();
    expect(parseScreenManifest("x")).toBeNull();
  });

  it("a manifest with no events adds nothing", () => {
    const empty = parseScreenManifest({ id: "s", dir: "/d", startedAt: START, events: [] })!;
    expect(screenAnnotationFromManifest(empty, START)).toEqual(EMPTY_SCREEN_ANNOTATION);
    expect(annotateTranscript("как есть", screenAnnotationFromManifest(empty, START))).toBe("как есть");
  });
});

describe("screen manifest v3", () => {
  it("reads strokes, shots and clicks in full", () => {
    expect(fixture.version).toBe(3);
    expect(fixture.events[0]).toMatchObject({ n: 1, tool: "rect", shape: "rect", box: { x: 5, y: 8, w: 20, h: 10 }, endedAt: START + 14_000 });
    expect(fixture.events[2]).toMatchObject({ preview: `${DIR}/shot-01-preview.jpg`, area: "window", strokes: 2 });
    expect(fixture.events[4]).toEqual({ type: "click", at: START + 45_000, shot: 3, xPct: 80, yPct: 50 });
  });

  it("drops a malformed frame, shape or tool and keeps the rest of the stroke", () => {
    const m = parseScreenManifest({ version: 2, events: [{ type: "stroke", at: START, shape: "star", tool: "brush", box: { x: 1, y: 2, w: -3, h: 4 }, n: 2 }] })!;
    expect(m.events[0]).toEqual({ type: "stroke", at: START, n: 2 });
  });
});

describe("the transcript of a screen take, one section per screenshot", () => {
  it("header, then each shot's heading, frames and what was said up to it, then what was said after the last", () => {
    expect(annotateTranscript(SPOKEN, fixtureAnnotation, DURATION)).toBe(EXPECTED);
  });

  it("names the folder once, and no file path in any mark or heading", () => {
    const out = annotateTranscript(SPOKEN, fixtureAnnotation, DURATION);
    expect(out.split(DIR)).toHaveLength(2);
    expect(out).not.toContain("📸");
    expect(out).not.toContain("Сводка");
  });

  it("an upscaled rewrite is composed the same way: by share, one header, one section per shot", () => {
    const rewrite = "Сейчас обведу жёлтым шапку: она съехала. Здесь всё нормально. Спасибо, пока.";
    const blocks = annotateTranscript(rewrite, fixtureAnnotation, DURATION).split("\n\n");
    expect(blocks[0]).toBe(HEADER);
    expect(blocks.filter((b) => b.startsWith("### Скрин "))).toHaveLength(3);
    const sections = blocks.slice(1).join("\n");
    expect(sections.match(/\[✏️/g)).toHaveLength(3);
    expect(sections.match(/\[🖱/g)).toHaveLength(1);
    expect(blocks.join("\n").match(/Диктовка с рисованием по экрану/g)).toHaveLength(1);
  });

  it("with nothing said: the header, the stop's reason, then each section with its marks alone", () => {
    const out = annotateTranscript("", fixtureAnnotation, { ...DURATION, silence: "[ Silence ]" });
    const blocks = out.split("\n\n");
    expect(blocks[0]).toBe(HEADER);
    expect(blocks[1]).toBe("[ Silence ]");
    expect(blocks[2]).toBe([
      "### Скрин 1 · 00:00–00:25 · shot-01-preview.jpg",
      "Штрихи: 1 — 5–25% × 8–18%; 2 — 60–70% × 40–52%",
      "[✏️1 жёлтый, вверху слева]",
      "[✏️2 красный обвод, в центре]",
    ].join("\n"));
    expect(blocks[3]).toBe("### Скрин 2 · 00:25–00:40 · shot-02-preview.jpg · без пометок");
    expect(blocks.slice(2).join("\n")).not.toContain("[/");
    expect(out).not.toContain(AFTER_LAST_SHOT_HEADING);
  });

  it("no after-the-last heading when nothing came after the last screenshot", () => {
    const words = "сейчас жёлтым обведу вот эту шапку она съехала а здесь всё нормально";
    const out = annotateTranscript(words, fixtureAnnotation, { durationMs: 60_000 });
    expect(out).not.toContain(AFTER_LAST_SHOT_HEADING);
    expect(out.endsWith("всё нормально")).toBe(true);
  });

  it("a stroke drawn at the very moment of its screenshot stays in that screenshot's section", () => {
    const m = parseScreenManifest({
      version: 3,
      dir: "/d",
      events: [
        { type: "stroke", at: START + 5_000, shot: 1, n: 1, shape: "dot", box: { x: 50, y: 50, w: 0, h: 0 } },
        { type: "shot", at: START + 5_000, shot: 1, files: ["/d/shot-01.png"] },
      ],
    })!;
    const out = annotateTranscript("раз два три четыре", screenAnnotationFromManifest(m, START), { durationMs: 10_000 });
    expect(out.split("\n\n").slice(1)).toEqual([
      "### Скрин 1 · 00:00–00:05 · shot-01.png\nШтрихи: 1 — 50% × 50%\nраз два [✏️1 точка, в центре]",
      `${AFTER_LAST_SHOT_HEADING}\nтри четыре`,
    ]);
  });

  it("keeps the words' own line breaks inside a section", () => {
    const out = annotateTranscript("раз два\nтри четыре", fixtureAnnotation, { durationMs: 1_000_000 });
    expect(out).toContain("раз два\nтри четыре");
  });

  it("a take with marks but no screenshot: the text with its marks follows the header, no headings", () => {
    const m = parseScreenManifest({ version: 3, dir: "/d", events: [{ type: "click", at: START + 5_000 }] })!;
    const out = annotateTranscript("раз два три четыре", screenAnnotationFromManifest(m, START), { durationMs: 10_000 });
    const blocks = out.split("\n\n");
    expect(blocks[0].split("\n")[0]).toBe("Диктовка с рисованием по экрану · без скринов · папка: /d");
    expect(blocks.slice(1)).toEqual(["раз два [🖱 клик] три четыре"]);
  });

  it("a shot whose capture failed says so in its heading", () => {
    const m = parseScreenManifest({ version: 3, events: [{ type: "shot", at: START + 1000, shot: 2, files: [], strokes: 0 }] })!;
    expect(screenAnnotationFromManifest(m, START).sections[0].heading).toBe(
      "### Скрин 2 · 00:00–00:01 · не сохранён (нет доступа к записи экрана)",
    );
  });

  it("a multi-display shot names its preview and the other display's original", () => {
    const m = parseScreenManifest({
      version: 3,
      dir: "/d",
      events: [{ type: "shot", at: START + 1000, shot: 4, files: ["/d/shot-04-display1.png", "/d/shot-04-display2.png"], preview: "/d/shot-04-preview.jpg" }],
    })!;
    expect(screenAnnotationFromManifest(m, START).sections[0].heading).toBe(
      "### Скрин 4 · 00:00–00:01 · shot-04-preview.jpg, shot-04-display2.png · без пометок",
    );
  });
});

describe("marks", () => {
  it("a stroke names its number, colour, shape unless a rectangle, and place — no shot number, no time", () => {
    expect(texts(fixtureAnnotation)).toEqual([
      "[✏️1 жёлтый, вверху слева]",
      "[✏️2 красный обвод, в центре]",
      "[🖱 клик, справа]",
      "[✏️1 линия, внизу по центру]",
    ]);
  });

  it("names every shape but the default rectangle, in the gender the shape word takes", () => {
    const shapes = ["rect", "loop", "line", "curve", "dot"];
    const m = parseScreenManifest({
      version: 3,
      events: shapes.map((shape, i) => ({ type: "stroke", at: START + i, shot: 1, n: i + 1, color: "#34c759", shape, box: { x: 45, y: 45, w: 10, h: 10 } })),
    })!;
    expect(texts(screenAnnotationFromManifest(m, START))).toEqual([
      "[✏️1 зелёный, в центре]",
      "[✏️2 зелёный обвод, в центре]",
      "[✏️3 зелёная линия, в центре]",
      "[✏️4 зелёная кривая, в центре]",
      "[✏️5 зелёная точка, в центре]",
    ]);
  });

  it("a rectangle in no palette colour reads as its place alone; with no place either, its number", () => {
    const m = parseScreenManifest({
      version: 3,
      events: [
        { type: "stroke", at: START, shot: 1, n: 1, shape: "rect", color: "#123456", box: { x: 70, y: 70, w: 20, h: 20 } },
        { type: "stroke", at: START + 1, shot: 1, n: 2, shape: "rect" },
      ],
    })!;
    expect(texts(screenAnnotationFromManifest(m, START))).toEqual(["[✏️1 внизу справа]", "[✏️2]"]);
  });

  it("places a stroke by the centre of its frame, not its reported point", () => {
    const m = parseScreenManifest({ version: 2, events: [{ type: "stroke", at: START, shot: 1, n: 1, shape: "loop", box: { x: 70, y: 70, w: 20, h: 20 }, xPct: 5, yPct: 5 }] })!;
    expect(texts(screenAnnotationFromManifest(m, START))).toEqual(["[✏️1 обвод, внизу справа]"]);
  });

  it("every stroke keeps its own mark: no merging of strokes that read the same", () => {
    const m = parseScreenManifest({
      version: 2,
      events: [1, 2, 3].map((n) => ({ type: "stroke", at: START + 39_100 + n * 40, shot: 2, n, color: "#ff3b30", shape: "dot", box: { x: 40, y: 55, w: 0, h: 0 } })),
    })!;
    expect(texts(screenAnnotationFromManifest(m, START))).toEqual([
      "[✏️1 красная точка, в центре]",
      "[✏️2 красная точка, в центре]",
      "[✏️3 красная точка, в центре]",
    ]);
  });

  it("a click outside the captured area has no place", () => {
    const m = parseScreenManifest({ version: 3, events: [{ type: "click", at: START, shot: 1 }] })!;
    expect(texts(screenAnnotationFromManifest(m, START))).toEqual(["[🖱 клик]"]);
  });

  it("the header mentions clicks only when the take has any", () => {
    const m = parseScreenManifest({ ...fixtureRaw, events: fixtureRaw.events.filter((e) => e.type !== "click") })!;
    expect(screenAnnotationFromManifest(m).header).not.toContain("🖱");
    expect(fixtureAnnotation.header).toContain("[🖱 клик …]");
  });
});

describe("closing marks [/N]", () => {
  it("follow word timings when the text has them", () => {
    const out = annotateTranscript("раз два три четыре", marksOnly([
      { atMs: 900, text: "[✏️1 линия]", endMs: 2_900, closeText: "[/1]" },
    ]), { wordStartsMs: [0, 1_000, 2_000, 3_000] });
    expect(out).toBe("раз [✏️1 линия] два три [/1] четыре");
  });

  it("are left out when no word lies inside the stroke", () => {
    const out = annotateTranscript("раз два три четыре", marksOnly([
      { atMs: 900, text: "[✏️1]", endMs: 990, closeText: "[/1]" },
    ]), { wordStartsMs: [0, 1_000, 2_000, 3_000] });
    expect(out).toBe("раз [✏️1] два три четыре");
  });

  it("a stroke closing at the moment the next opens closes first", () => {
    const out = annotateTranscript("раз два три", marksOnly([
      { atMs: 2_500, text: "[✏️2]" },
      { atMs: 0, text: "[✏️1]", endMs: 2_500, closeText: "[/1]" },
    ]), { wordStartsMs: [0, 1_000, 2_000] });
    expect(out).toBe("раз [✏️1] два три [/1] [✏️2]");
  });
});

describe("header", () => {
  it("says what the text is, how many shots, the folder once, how to read it and the file names by rule", () => {
    expect(fixtureAnnotation.header).toBe(HEADER);
  });

  it("states the file names in the contract's forms", () => {
    const contract = JSON.parse(readFileSync(resolve(process.cwd(), "../contracts/screen-session.json"), "utf-8"));
    for (const form of Object.values(contract.fileNameForms) as string[]) expect(fixtureAnnotation.header).toContain(form);
  });

  it("counts shots in Russian", () => {
    const shots = (n: number) => parseScreenManifest({
      dir: "/d",
      events: Array.from({ length: n }, (_, i) => ({ type: "shot", at: START + i, shot: i + 1, files: [`/d/shot-${i + 1}.png`] })),
    })!;
    const firstLine = (n: number) => screenAnnotationFromManifest(shots(n), START).header.split("\n")[0];
    expect(firstLine(1)).toBe("Диктовка с рисованием по экрану · 1 скрин · папка: /d");
    expect(firstLine(3)).toBe("Диктовка с рисованием по экрану · 3 скрина · папка: /d");
    expect(firstLine(8)).toBe("Диктовка с рисованием по экрану · 8 скринов · папка: /d");
    expect(firstLine(11)).toBe("Диктовка с рисованием по экрану · 11 скринов · папка: /d");
    expect(firstLine(21)).toBe("Диктовка с рисованием по экрану · 21 скрин · папка: /d");
  });
});

// ── Manifest v1 (shipped through 1.6.11): no numbers, shapes or frames.
//    Events as recorded on 2026-11-20 (`…Вот здесь не надо….screens`). ──
describe("manifest v1", () => {
  const V1_DIR = "/rec/Screen Sessions/2026-11-20.screens";
  const v1 = parseScreenManifest({
    version: 1,
    id: "screen-20261120-235139-040",
    dir: V1_DIR,
    startedAt: 1795193499190,
    endedAt: 1795193750100,
    audioStartedAt: 1795193499617,
    events: [
      { type: "stroke", at: 1795193502584, endedAt: 1795193504893, color: "#ff3b30", shot: 1, xPct: 48, yPct: 46 },
      { type: "stroke", at: 1795193505626, endedAt: 1795193507202, color: "#ff3b30", shot: 1, xPct: 17, yPct: 24 },
      { type: "shot", at: 1795193517137, shot: 1, files: [`${V1_DIR}/shot-01.png`], strokes: 2, reason: "hotkey" },
      { type: "stroke", at: 1795193530763, endedAt: 1795193535713, color: "#34c759", shot: 2, xPct: 5, yPct: 38 },
      { type: "shot", at: 1795193543669, shot: 2, files: [`${V1_DIR}/shot-02.png`], strokes: 1, reason: "capsule" },
      { type: "shot", at: 1795193547293, shot: 3, files: [`${V1_DIR}/shot-03.png`], strokes: 0, reason: "hotkey" },
    ],
  })!;
  const a = screenAnnotationFromManifest(v1, 0);

  it("reads a manifest without a version as v1", () => {
    expect(manifest.version).toBe(1);
  });

  it("strokes are numbered by their order on the shot and read as «штрих» in their colour", () => {
    expect(texts(a)).toEqual([
      "[✏️1 красный штрих, в центре]",
      "[✏️2 красный штрих, вверху слева]",
      "[✏️1 зелёный штрих, слева]",
    ]);
  });

  it("the header does not promise numbers on the picture, previews or close-ups", () => {
    expect(a.header).toContain(`3 скрина · папка: ${V1_DIR}`);
    expect(a.header).toContain("штрих N по порядку рисования на скрине");
    expect(a.header).not.toContain("в кружке");
    expect(a.header).not.toContain("preview");
    expect(a.header).toContain("центры — в % экрана");
  });

  it("each shot is a section with its file and its strokes' centres", () => {
    expect(a.sections.map((s) => [s.heading, s.detail])).toEqual([
      ["### Скрин 1 · 00:00–00:17 · shot-01.png", "Штрихи: 1 — центр 48%, 46%; 2 — центр 17%, 24%"],
      ["### Скрин 2 · 00:17–00:44 · shot-02.png", "Штрихи: 1 — центр 5%, 38%"],
      ["### Скрин 3 · 00:44–00:47 · shot-03.png · без пометок", ""],
    ]);
  });

  it("strokes of the same second, place and shot still count once, closing with the last of them", () => {
    const m = parseScreenManifest({
      id: "s",
      dir: "/d",
      startedAt: START,
      events: [
        ...Array.from({ length: 16 }, (_, i) => ({ type: "stroke", at: START + 39_100 + i * 40, endedAt: START + 39_120 + i * 40, shot: 2, xPct: 40, yPct: 55 })),
        { type: "stroke", at: START + 39_900, shot: 2, xPct: 70, yPct: 55 },
        { type: "stroke", at: START + 41_000, shot: 2, xPct: 40, yPct: 55 },
      ],
    })!;
    const marks = screenAnnotationFromManifest(m, START).marks;
    expect(marks.map((x) => x.text)).toEqual([
      "[✏️1 штрих, в центре]",
      "[✏️2 штрих, справа]",
      "[✏️3 штрих, в центре]",
    ]);
    expect(marks[0].endMs).toBe(39_120 + 15 * 40);
  });
});

describe("palette colour names", () => {
  it("every colour of the shell's palette has a name in both genders", () => {
    const src = readFileSync(resolve(process.cwd(), "../desktop/screen-mode.js"), "utf-8");
    const list = /colors:\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
    expect(list).not.toBeNull();
    const palette = [...(list as RegExpExecArray)[1].matchAll(/"(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase());
    expect(palette.length).toBeGreaterThan(0);
    for (const hex of palette) {
      expect(SCREEN_COLOR_NAMES[hex], hex).toBeDefined();
      expect(SCREEN_COLOR_NAMES[hex].m).toBeTruthy();
      expect(SCREEN_COLOR_NAMES[hex].f).toBeTruthy();
    }
  });
});

describe("region words", () => {
  it("name the 3x3 cell of the area", () => {
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

  // Every manifest example the contract carries — `manifest`, and
  // `manifestV1` (what 1.6.x wrote) — reads in full and composes the same way.
  const examples = [contract.manifest, contract.manifestV1].filter(Boolean);

  it("each example: a mark per stroke and click, a section per shot, the folder once in the header and nowhere else", () => {
    for (const raw of examples) {
      const m = parseScreenManifest(raw)!;
      expect(m.events.length).toBe(raw.events.length);
      expect(m.version).toBe(raw.version);
      const a = screenAnnotationFromManifest(m, raw.startedAt);
      const count = (type: string) => raw.events.filter((e: { type: string }) => e.type === type).length;
      expect(a.marks).toHaveLength(count("stroke") + count("click"));
      expect(a.sections).toHaveLength(count("shot"));
      expect(a.header).toContain(`папка: ${raw.dir}`);
      for (const mark of a.marks) expect(mark.text).not.toContain(raw.dir);
      expect(a.sections[0].heading).toMatch(/^### Скрин 1 · 00:00–00:1\d · shot-01(-preview\.jpg|\.png)$/);
    }
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
    const out = annotateTranscript(text, marksOnly([{ atMs: 1500, text: "[M]" }]), { wordStartsMs });
    expect(out).toBe("вот тут [M] кнопка съехала совсем");
  });

  it("keeps the order of marks that land on the same boundary, and appends late ones", () => {
    const out = annotateTranscript(
      "раз два",
      marksOnly([
        { atMs: 9000, text: "[late]" },
        { atMs: 100, text: "[a]" },
        { atMs: 200, text: "[b]" },
      ]),
      { wordStartsMs: [0, 5000] },
    );
    expect(out).toBe("раз [a] [b] два [late]");
  });

  it("places proportionally in a rewritten text with no timings of its own", () => {
    const out = annotateTranscript("one two three four", marksOnly([{ atMs: 5000, text: "[M]" }]), { durationMs: 10_000 });
    expect(out).toBe("one two [M] three four");
  });

  it("keeps the marks when nothing was said", () => {
    expect(annotateTranscript("", marksOnly([{ atMs: 1, text: "[a]" }, { atMs: 2, text: "[b]" }]))).toBe("[a]\n[b]");
  });

  it("returns the text unchanged with no marks", () => {
    expect(annotateTranscript("as is", EMPTY_SCREEN_ANNOTATION)).toBe("as is");
  });
});

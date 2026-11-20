import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
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

/** Inline marks with no header or summary — what the placement suite places. */
const marksOnly = (marks: ScreenMark[]): ScreenAnnotation => ({ marks, header: "", summary: "" });
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

// ── Manifest v2 (desktop screen-tools): numbered strokes with tool, shape,
//    frame and crop; shots with a preview and the captured area. ──────────
const DIR = "/rec/Screen Sessions/take.screens";
const v2Raw = {
  version: 2,
  id: "screen-20261121-100000-000",
  dir: DIR,
  startedAt: START,
  audioStartedAt: START,
  endedAt: START + 60_000,
  events: [
    { type: "stroke", at: START + 12_000, endedAt: START + 14_000, color: "#ffcc00", shot: 1, n: 1, tool: "rect", shape: "rect", box: { x: 5, y: 8, w: 20, h: 10 }, xPct: 15, yPct: 13, crop: `${DIR}/crops/shot-01-1.png` },
    { type: "stroke", at: START + 20_000, endedAt: START + 20_400, color: "#FF3B30", shot: 1, n: 2, tool: "pen", shape: "loop", box: { x: 60, y: 40, w: 10, h: 12 }, xPct: 65, yPct: 46, crop: `${DIR}/crops/shot-01-2.png` },
    { type: "shot", at: START + 25_000, shot: 1, files: [`${DIR}/shot-01.png`], preview: `${DIR}/previews/shot-01.jpg`, area: "window", strokes: 2, reason: "hotkey" },
    { type: "shot", at: START + 40_000, shot: 2, files: [`${DIR}/shot-02.png`], preview: `${DIR}/previews/shot-02.jpg`, area: "display", strokes: 0, reason: "capsule" },
    { type: "stroke", at: START + 50_000, endedAt: START + 52_000, color: "#123456", shot: 3, n: 1, tool: "pen", shape: "line", box: { x: 40, y: 85, w: 30, h: 0 }, xPct: 55, yPct: 85 },
    { type: "shot", at: START + 60_000, shot: 3, files: [`${DIR}/shot-03.png`], area: "window", strokes: 1, reason: "stop" },
  ],
};
const v2 = parseScreenManifest(v2Raw)!;
const v2Annotation = screenAnnotationFromManifest(v2);
// 12 words over 60 s: a word every 5 s.
const SPOKEN = "сейчас жёлтым обведу вот эту шапку она съехала а здесь всё нормально";

const V2_HEADER = [
  `Диктовка с рисованием по экрану · 3 скрина · папка: ${DIR}`,
  "Как читать: [✏️N скрин K: …] — штрих N на скрине K, на картинке тот же номер в кружке; " +
    "стоит там, где начато рисование, [/N] — где отпущено. Цвет только различает штрихи, смысл — в словах. " +
    "[📸 время скрин K] — снимок: сказанное с прошлого снимка относится к нему. Внизу — сводка с файлами.",
].join("\n");

const V2_SUMMARY = [
  "Сводка по скринам:",
  "Скрин 1 · shot-01.png (читать: previews/shot-01.jpg) · окно · 00:00–00:25",
  "  1 · 00:12 жёлтый прямоугольник · 5–25% × 8–18% · вырезка crops/shot-01-1.png",
  "  2 · 00:20 красный обвод · 60–70% × 40–52% · вырезка crops/shot-01-2.png",
  "Скрин 2 · shot-02.png (читать: previews/shot-02.jpg) · экран · 00:25–00:40 · без пометок",
  "Скрин 3 · shot-03.png · окно · 00:40–01:00",
  "  1 · 00:50 линия · 40–70% × 85%",
].join("\n");

describe("screen manifest", () => {
  it("keeps well-formed events only, in time order", () => {
    expect(manifest.events.map((e) => e.type)).toEqual(["stroke", "shot"]);
  });

  it("reads a manifest without a version as v1, and v2 in full", () => {
    expect(manifest.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.events[0]).toMatchObject({ n: 1, tool: "rect", shape: "rect", box: { x: 5, y: 8, w: 20, h: 10 }, endedAt: START + 14_000 });
    expect(v2.events[2]).toMatchObject({ preview: `${DIR}/previews/shot-01.jpg`, area: "window", strokes: 2 });
  });

  it("drops a malformed frame, shape or tool and keeps the rest of the stroke", () => {
    const m = parseScreenManifest({ version: 2, events: [{ type: "stroke", at: START, shape: "star", tool: "brush", box: { x: 1, y: 2, w: -3, h: 4 }, n: 2 }] })!;
    expect(m.events[0]).toEqual({ type: "stroke", at: START, n: 2 });
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

describe("marks — manifest v2", () => {
  it("a stroke reads its number, shot, colour, shape and place; a shot its time and number, no path", () => {
    expect(texts(v2Annotation)).toEqual([
      "[✏️1 скрин 1: жёлтый прямоугольник, вверху слева]",
      "[✏️2 скрин 1: красный обвод, в центре]",
      "[📸 00:25 скрин 1]",
      "[📸 00:40 скрин 2 — без пометок]",
      "[✏️1 скрин 3: линия, внизу по центру]",
      "[📸 01:00 скрин 3]",
    ]);
    expect(texts(v2Annotation).join(" ")).not.toContain(DIR);
  });

  it("names every shape, in the gender the shape word takes", () => {
    const shapes = ["rect", "loop", "line", "curve", "dot"];
    const m = parseScreenManifest({
      version: 2,
      events: shapes.map((shape, i) => ({ type: "stroke", at: START + i, shot: 1, n: i + 1, color: "#34c759", shape, box: { x: 45, y: 45, w: 10, h: 10 } })),
    })!;
    expect(texts(screenAnnotationFromManifest(m, START))).toEqual([
      "[✏️1 скрин 1: зелёный прямоугольник, в центре]",
      "[✏️2 скрин 1: зелёный обвод, в центре]",
      "[✏️3 скрин 1: зелёная линия, в центре]",
      "[✏️4 скрин 1: зелёная кривая, в центре]",
      "[✏️5 скрин 1: зелёная точка, в центре]",
    ]);
  });

  it("a colour outside the palette is named by nothing", () => {
    expect(texts(v2Annotation)[4]).toBe("[✏️1 скрин 3: линия, внизу по центру]");
  });

  it("places a stroke by the centre of its frame, not its reported point", () => {
    const m = parseScreenManifest({ version: 2, events: [{ type: "stroke", at: START, shot: 1, n: 1, shape: "rect", box: { x: 70, y: 70, w: 20, h: 20 }, xPct: 5, yPct: 5 }] })!;
    expect(texts(screenAnnotationFromManifest(m, START))).toEqual(["[✏️1 скрин 1: прямоугольник, внизу справа]"]);
  });

  it("every stroke keeps its own mark: no merging of strokes that read the same", () => {
    const m = parseScreenManifest({
      version: 2,
      events: [1, 2, 3].map((n) => ({ type: "stroke", at: START + 39_100 + n * 40, shot: 2, n, color: "#ff3b30", shape: "dot", box: { x: 40, y: 55, w: 0, h: 0 } })),
    })!;
    expect(texts(screenAnnotationFromManifest(m, START))).toEqual([
      "[✏️1 скрин 2: красная точка, в центре]",
      "[✏️2 скрин 2: красная точка, в центре]",
      "[✏️3 скрин 2: красная точка, в центре]",
    ]);
  });

  it("a shot whose capture failed says so, in words", () => {
    const m = parseScreenManifest({ version: 2, events: [{ type: "shot", at: START + 1000, shot: 2, files: [], strokes: 0 }] })!;
    const a = screenAnnotationFromManifest(m, START);
    expect(texts(a)).toEqual(["[📸 00:01 скрин 2 — не сохранён (нет доступа к записи экрана)]"]);
    expect(a.summary).toBe("Сводка по скринам:\nСкрин 2 · не сохранён (нет доступа к записи экрана) · 00:00–00:01");
  });
});

describe("closing marks [/N]", () => {
  it("stand where the stroke was released, when words were said while it was drawn", () => {
    expect(annotateTranscript(SPOKEN, v2Annotation, { durationMs: 60_000 })).toBe([
      V2_HEADER,
      "сейчас жёлтым [✏️1 скрин 1: жёлтый прямоугольник, вверху слева] обведу [/1] вот " +
        "[✏️2 скрин 1: красный обвод, в центре] эту [📸 00:25 скрин 1] шапку она съехала " +
        "[📸 00:40 скрин 2 — без пометок] а здесь [✏️1 скрин 3: линия, внизу по центру] всё нормально [📸 01:00 скрин 3]",
      V2_SUMMARY,
    ].join("\n\n"));
  });

  it("follow word timings when the text has them", () => {
    const out = annotateTranscript("раз два три четыре", marksOnly([
      { atMs: 900, text: "[✏️1 скрин 1: линия]", endMs: 2_900, closeText: "[/1]" },
    ]), { wordStartsMs: [0, 1_000, 2_000, 3_000] });
    expect(out).toBe("раз [✏️1 скрин 1: линия] два три [/1] четыре");
  });

  it("are left out when no word lies inside the stroke", () => {
    const out = annotateTranscript("раз два три четыре", marksOnly([
      { atMs: 900, text: "[✏️1]", endMs: 990, closeText: "[/1]" },
    ]), { wordStartsMs: [0, 1_000, 2_000, 3_000] });
    expect(out).toBe("раз [✏️1] два три четыре");
  });

  it("are left out when nothing was said at all", () => {
    const [, body] = annotateTranscript("", v2Annotation, { durationMs: 60_000 }).split("\n\n");
    expect(body).not.toContain("[/");
    expect(body.split("\n")).toEqual(texts(v2Annotation));
  });

  it("a stroke closing at the moment the next opens closes first", () => {
    const out = annotateTranscript("раз два три", marksOnly([
      { atMs: 2_500, text: "[✏️2]" },
      { atMs: 0, text: "[✏️1]", endMs: 2_500, closeText: "[/1]" },
    ]), { wordStartsMs: [0, 1_000, 2_000] });
    expect(out).toBe("раз [✏️1] два три [/1] [✏️2]");
  });
});

describe("header and summary", () => {
  it("the header says what the text is, how many shots, the folder once, and how to read the marks", () => {
    expect(v2Annotation.header).toBe(V2_HEADER);
  });

  it("the summary is one item per shot, paths relative to the folder, strokes with frame and crop", () => {
    expect(v2Annotation.summary).toBe(V2_SUMMARY);
  });

  it("the folder appears once in the whole transcript", () => {
    const out = annotateTranscript(SPOKEN, v2Annotation, { durationMs: 60_000 });
    expect(out.split(DIR)).toHaveLength(2);
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

  it("strokes no shot holds are still listed", () => {
    const m = parseScreenManifest({
      version: 2,
      dir: "/d",
      events: [
        { type: "shot", at: START + 1_000, shot: 1, files: ["/d/shot-01.png"], strokes: 0 },
        { type: "stroke", at: START + 2_000, shot: 2, n: 1, shape: "dot", box: { x: 10, y: 10, w: 0, h: 0 } },
      ],
    })!;
    expect(screenAnnotationFromManifest(m, START).summary).toBe([
      "Сводка по скринам:",
      "Скрин 1 · shot-01.png · 00:00–00:01 · без пометок",
      "Скрин 2 · снимка нет",
      "  1 · 00:02 точка · 10% × 10%",
    ].join("\n"));
  });
});

describe("one header and one summary per transcript", () => {
  it("the spoken final gets the header above, the summary below, each once", () => {
    const out = annotateTranscript(SPOKEN, v2Annotation, { durationMs: 60_000 });
    expect(out.match(/Диктовка с рисованием по экрану/g)).toHaveLength(1);
    expect(out.match(/Сводка по скринам/g)).toHaveLength(1);
  });

  it("an upscaled rewrite is composed the same way: marks by share, one header, one summary", () => {
    const rewrite = "Сейчас обведу жёлтым шапку: она съехала. Здесь всё нормально.";
    const out = annotateTranscript(rewrite, v2Annotation, { durationMs: 60_000 });
    const blocks = out.split("\n\n");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe(V2_HEADER);
    expect(blocks[2]).toBe(V2_SUMMARY);
    expect(blocks[1].match(/\[✏️/g)).toHaveLength(3);
    expect(blocks[1].match(/\[📸/g)).toHaveLength(3);
  });
});

// ── Manifest v1 (shipped through 1.6.11): no numbers, shapes or frames.
//    Events as recorded on 2026-11-20 (`…Вот здесь не надо….screens`). ──
describe("marks — manifest v1", () => {
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

  it("strokes are numbered by their order on the shot and read as «штрих» in their colour", () => {
    expect(texts(a)).toEqual([
      "[✏️1 скрин 1: красный штрих, в центре]",
      "[✏️2 скрин 1: красный штрих, вверху слева]",
      "[📸 00:17 скрин 1]",
      "[✏️1 скрин 2: зелёный штрих, слева]",
      "[📸 00:44 скрин 2]",
      "[📸 00:47 скрин 3 — без пометок]",
    ]);
  });

  it("the header does not promise numbers on the picture", () => {
    expect(a.header).toContain(`3 скрина · папка: ${V1_DIR}`);
    expect(a.header).toContain("штрих N на скрине K по порядку рисования");
    expect(a.header).not.toContain("в кружке");
  });

  it("the summary has no crops or previews and gives each stroke's centre", () => {
    expect(a.summary).toBe([
      "Сводка по скринам:",
      "Скрин 1 · shot-01.png · 00:00–00:17",
      "  1 · 00:02 красный штрих · центр 48%, 46%",
      "  2 · 00:06 красный штрих · центр 17%, 24%",
      "Скрин 2 · shot-02.png · 00:17–00:44",
      "  1 · 00:31 зелёный штрих · центр 5%, 38%",
      "Скрин 3 · shot-03.png · 00:44–00:47 · без пометок",
    ].join("\n"));
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
      "[✏️1 скрин 2: штрих, в центре]",
      "[✏️2 скрин 2: штрих, справа]",
      "[✏️3 скрин 2: штрих, в центре]",
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

  // Every manifest example the contract carries — `manifest`, and
  // `manifestV1` (what 1.6.x wrote) where the contract keeps one beside a
  // newer `manifest` — reads in full and composes the same way.
  const examples = [contract.manifest, contract.manifestV1].filter(Boolean);

  it("each manifest example yields one mark per event, the folder once in the header, no path in any mark", () => {
    for (const raw of examples) {
      const m = parseScreenManifest(raw)!;
      expect(m.events.length).toBe(raw.events.length);
      expect(m.version).toBe(raw.version);
      const a = screenAnnotationFromManifest(m, raw.startedAt);
      expect(a.marks).toHaveLength(raw.events.length);
      expect(a.header).toContain(`папка: ${raw.dir}`);
      for (const mark of a.marks) expect(mark.text).not.toContain(raw.dir);
      expect(a.summary).toContain("Скрин 1 · shot-01.png");
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

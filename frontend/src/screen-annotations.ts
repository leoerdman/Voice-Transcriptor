/**
 * Screen-mode marks in a transcript — pure.
 *
 * A screen-mode recording comes back from the desktop shell with a
 * manifest: every stroke the user drew, every screenshot they took and —
 * with the "record clicks" setting on — every plain click, each with an
 * epoch time (desktop/screen-mode.js `screenSessionManifest`). The reader
 * of the result is usually an agent asked to fix what the user pointed
 * at, so the transcript is composed here as:
 *
 *   * a HEADER — what the text is, how many screenshots, the folder they
 *     are in (once: nothing repeats it), and one line on how to read the
 *     rest, which also states the file names once, by rule (their forms
 *     are contracts/screen-session.json `fileNameForms`);
 *   * one SECTION per screenshot, in time order — what was said since the
 *     previous screenshot belongs to this one:
 *
 *       ### Скрин 7 · 01:04–02:47 · shot-07-preview.jpg
 *       Штрихи: 1 — 67–86% × 65–100%; 2 — 10–30% × 5–9%
 *       сейчас обведу [✏️1 жёлтый, вверху справа] вот эту кнопку [/1]
 *       она съехала, и тут [🖱 клик, в центре] ничего не происходит
 *
 *     The heading names the shot's file (its preview when there is one,
 *     else the original) and says «без пометок» when nothing was drawn on
 *     it; the frames of its strokes follow on one line. A stroke's mark
 *     stands where the drawing began, mid-sentence if that is where it
 *     began; `[/N]` closes it where it was released, when at least one
 *     word was said while it was drawn. A mark names the stroke's number
 *     (the same number is drawn in a circle on the picture), its colour,
 *     its shape unless it is the default rectangle, and where it is;
 *   * what was said after the last screenshot, under its own heading.
 *
 * Manifest v1 has no stroke numbers, shapes or frames: a v1 stroke is
 * numbered by its order on the shot, reads as "штрих", and strokes that
 * read the same (one gesture torn into many one-point strokes) count
 * once. Clicks exist from v3 on.
 *
 * Placement. A mark's time is an offset into the audio (`at - startAt`,
 * where `startAt` is the renderer's recording clock — the first audio
 * sample). That offset becomes a FRACTION of what was said by then:
 *
 *   * with timed segments (the live envelope): the share of words spoken
 *     before the offset, each segment's words spread over its span;
 *   * without them: the share of the recording's duration.
 *
 * The fraction is then applied to the word count of the text being
 * annotated and the mark goes in at that word boundary; a screenshot's
 * moment is placed the same way and is where its section ends. Using a
 * fraction rather than an exact word lets the same placement work for the
 * text the segments describe AND for an upscaled rewrite of it, which has
 * no timings of its own.
 *
 * Every caller hands the composer the SPOKEN words — the final as
 * transcribed, its upscaled rewrite, the live text, a crash draft's words
 * (the panel is cleared when a take starts and the draft is last written
 * when its stop begins, so a draft never holds an annotated final) — and
 * the composer adds the header and the sections once per call. Annotated
 * text is never annotated again, so nothing is ever doubled.
 */

import screenContract from "../../contracts/screen-session.json";

import { countWords } from "./text-match";

export type ScreenStrokeTool = "rect" | "pen";
export type ScreenStrokeShape = "rect" | "loop" | "line" | "curve" | "dot";

/** A stroke's frame, whole percent of the captured area (window or display). */
export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenManifestEvent {
  type: "stroke" | "shot" | "click";
  at: number;
  shot?: number;
  /** Stroke: epoch ms the stroke was released. */
  endedAt?: number;
  /** Stroke centre (v1: of its display; v2: of the captured area), or a
   *  click's point in its shot's captured area; whole percent. */
  xPct?: number;
  yPct?: number;
  color?: string;
  /** v2 stroke: its number on its screenshot, from 1. */
  n?: number;
  tool?: ScreenStrokeTool;
  shape?: ScreenStrokeShape;
  box?: ScreenBox;
  /** v2 stroke: absolute path of the stroke's crop. */
  crop?: string;
  /** Shot: absolute paths of its picture(s); empty when the capture failed. */
  files?: string[];
  /** v2 shot: absolute path of its reduced copy. */
  preview?: string;
  area?: "window" | "display";
  /** Shot: how many strokes it carries, as the shell counted them (the
   *  stroke events say the same; the transcript reads those). */
  strokes?: number;
  reason?: string;
}

export interface ScreenManifest {
  /** Manifest schema version: 1 (no stroke numbers), 2, or 3 (clicks). */
  version: number;
  id: string;
  dir: string;
  startedAt: number;
  /**
   * Epoch ms of the recording's first audio sample, written by the backend
   * when the session is archived beside its recording. Absent on a
   * manifest that was never archived (the save failed).
   */
  audioStartedAt?: number;
  /** Epoch ms the session ended (the take stopped). */
  endedAt?: number;
  events: ScreenManifestEvent[];
}

export interface ScreenMark {
  /** Offset into the recording's audio, ms. */
  atMs: number;
  text: string;
  /** Offset the mark's span ends at (a stroke released), ms. */
  endMs?: number;
  /** What closes the span, placed only when words were said inside it. */
  closeText?: string;
}

/** One screenshot's part of the transcript. */
export interface ScreenSection {
  /** Offset of the screenshot, ms: what was said up to it, since the
   *  previous one, is this section's text. */
  atMs: number;
  /** "### Скрин 7 · 01:04–02:47 · shot-07-preview.jpg" */
  heading: string;
  /** The frames of its strokes on one line; "" with none. */
  detail: string;
}

/** Everything a screen take adds to its transcript. */
export interface ScreenAnnotation {
  /** Inline marks (strokes, clicks), in time order. */
  marks: ReadonlyArray<ScreenMark>;
  /** The lines above the text; "" for none. */
  header: string;
  /** One per screenshot, in time order. */
  sections: ReadonlyArray<ScreenSection>;
}

export const EMPTY_SCREEN_ANNOTATION: ScreenAnnotation = Object.freeze({
  marks: Object.freeze([]),
  header: "",
  sections: Object.freeze([]),
});

export interface TimedSegment {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  text: string;
}

const HEADER_TITLE = "Диктовка с рисованием по экрану";
/** The heading of what was said after the last screenshot. */
export const AFTER_LAST_SHOT_HEADING = "### После последнего скрина";
const UNSAVED_SHOT = "не сохранён (нет доступа к записи экрана)";

/**
 * The file names, as forms the header states once (NN — the shot's
 * number, K — a stroke's). The shell names the files; the contract holds
 * the forms both sides are checked against.
 */
const FILE_NAME_FORMS: Readonly<{ shot: string; preview: string; crop: string }> = screenContract.fileNameForms;

/**
 * Colour names by the hex of the shell's palette (`SCREEN_MODE.colors`,
 * desktop/screen-mode.js), in the masculine and feminine forms the shape
 * words need. A colour only tells strokes apart; any other hex is named
 * by nothing.
 */
export const SCREEN_COLOR_NAMES: Readonly<Record<string, { m: string; f: string }>> = Object.freeze({
  "#ff3b30": { m: "красный", f: "красная" },
  "#ffcc00": { m: "жёлтый", f: "жёлтая" },
  "#34c759": { m: "зелёный", f: "зелёная" },
  "#0a84ff": { m: "синий", f: "синяя" },
  "#bf5af2": { m: "фиолетовый", f: "фиолетовая" },
  "#ffffff": { m: "белый", f: "белая" },
});

/**
 * The words for a shape. The rectangle is the tool every take starts with
 * — the default — so its word is never written (`word: ""`): a rectangle
 * reads as its colour alone, «синий» (the colour keeps the rectangle's
 * gender).
 */
const SHAPE_WORDS: Readonly<Record<ScreenStrokeShape, { word: string; gender: "m" | "f" }>> = Object.freeze({
  rect: { word: "", gender: "m" },
  loop: { word: "обвод", gender: "m" },
  line: { word: "линия", gender: "f" },
  curve: { word: "кривая", gender: "f" },
  dot: { word: "точка", gender: "f" },
});
/** A stroke whose shape the manifest does not say (v1). */
const UNKNOWN_SHAPE = { word: "штрих", gender: "m" as const };

const SHAPES = new Set<string>(Object.keys(SHAPE_WORDS));

function fmtOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseBox(value: unknown): ScreenBox | undefined {
  if (!value || typeof value !== "object") return undefined;
  const b = value as Record<string, unknown>;
  const x = finite(b.x);
  const y = finite(b.y);
  const w = finite(b.w);
  const h = finite(b.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined || w < 0 || h < 0) return undefined;
  return { x, y, w, h };
}

const EVENT_TYPES = new Set<string>(["stroke", "shot", "click"]);

/** Read the desktop shell's manifest defensively: anything malformed is absent. */
export function parseScreenManifest(raw: unknown): ScreenManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const events = Array.isArray(obj.events) ? obj.events : [];
  const parsed: ScreenManifestEvent[] = [];
  for (const item of events) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const type = typeof e.type === "string" && EVENT_TYPES.has(e.type) ? (e.type as ScreenManifestEvent["type"]) : null;
    const at = Number(e.at);
    if (!type || !Number.isFinite(at)) continue;
    const event: ScreenManifestEvent = { type, at };
    const shot = finite(e.shot);
    if (shot !== undefined) event.shot = shot;
    if (type === "stroke" || type === "click") {
      const xPct = finite(e.xPct);
      const yPct = finite(e.yPct);
      if (xPct !== undefined) event.xPct = xPct;
      if (yPct !== undefined) event.yPct = yPct;
    }
    if (type === "stroke") {
      const endedAt = finite(e.endedAt);
      if (endedAt !== undefined) event.endedAt = endedAt;
      if (typeof e.color === "string") event.color = e.color;
      const n = finite(e.n);
      if (n !== undefined && n > 0) event.n = n;
      if (e.tool === "rect" || e.tool === "pen") event.tool = e.tool;
      if (typeof e.shape === "string" && SHAPES.has(e.shape)) event.shape = e.shape as ScreenStrokeShape;
      const box = parseBox(e.box);
      if (box) event.box = box;
      const crop = nonEmptyString(e.crop);
      if (crop) event.crop = crop;
    } else if (type === "shot") {
      event.files = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === "string") : undefined;
      const preview = nonEmptyString(e.preview);
      if (preview) event.preview = preview;
      if (e.area === "window" || e.area === "display") event.area = e.area;
      const strokes = finite(e.strokes);
      if (strokes !== undefined) event.strokes = strokes;
      const reason = nonEmptyString(e.reason);
      if (reason) event.reason = reason;
    }
    parsed.push(event);
  }
  const audioStartedAt = Number(obj.audioStartedAt);
  const endedAt = Number(obj.endedAt);
  const version = Number(obj.version);
  return {
    version: Number.isFinite(version) && version >= 1 ? Math.floor(version) : 1,
    id: String(obj.id || ""),
    dir: String(obj.dir || ""),
    startedAt: Number(obj.startedAt) || 0,
    ...(Number.isFinite(audioStartedAt) && audioStartedAt > 0 ? { audioStartedAt } : {}),
    ...(Number.isFinite(endedAt) && endedAt > 0 ? { endedAt } : {}),
    events: parsed.sort((a, b) => a.at - b.at),
  };
}

/**
 * How long the take ran, ms, from the manifest alone: from the audio
 * clock origin (or the session start) to the session end. What a mark's
 * time is a share of when a transcript has no word timings of its own.
 * 0 when the manifest cannot say.
 */
export function screenSessionDurationMs(manifest: ScreenManifest): number {
  const origin = manifest.audioStartedAt || manifest.startedAt;
  return manifest.endedAt && origin && manifest.endedAt > origin ? manifest.endedAt - origin : 0;
}

/**
 * Where on the screen, in words: a 3×3 grid of the area. The shell
 * reports only the percentages; the words are this side's copy.
 */
export function regionWords(xPct: number, yPct: number): string {
  const col = xPct < 100 / 3 ? 0 : xPct < 200 / 3 ? 1 : 2;
  const row = yPct < 100 / 3 ? 0 : yPct < 200 / 3 ? 1 : 2;
  return [
    ["вверху слева", "вверху по центру", "вверху справа"],
    ["слева", "в центре", "справа"],
    ["внизу слева", "внизу по центру", "внизу справа"],
  ][row][col];
}

/** "8 скринов", "1 скрин", "3 скрина"; "без скринов" for none. */
function shotCountWords(count: number): string {
  if (count <= 0) return "без скринов";
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11
    ? "скрин"
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? "скрина"
      : "скринов";
  return `${count} ${word}`;
}

/** A stroke in reading order: its number on its shot and what it looked like. */
interface NumberedStroke {
  n: number;
  shot?: number;
  atMs: number;
  endMs?: number;
  event: ScreenManifestEvent;
}

/** "жёлтый" (a rectangle), "красная линия", "обвод", "штрих" — colour only from the palette. */
function strokeLook(e: ScreenManifestEvent): string {
  const shape = e.shape ? SHAPE_WORDS[e.shape] : UNKNOWN_SHAPE;
  const color = e.color ? SCREEN_COLOR_NAMES[e.color.trim().toLowerCase()] : undefined;
  return [color ? color[shape.gender] : "", shape.word].filter(Boolean).join(" ");
}

/** The point a stroke is "at": its frame's centre, else its reported centre. */
function strokeCentre(e: ScreenManifestEvent): { x: number; y: number } | null {
  if (e.box) return { x: e.box.x + e.box.w / 2, y: e.box.y + e.box.h / 2 };
  if (e.xPct !== undefined && e.yPct !== undefined) return { x: e.xPct, y: e.yPct };
  return null;
}

/**
 * The strokes as the transcript names them. v2 strokes carry their number
 * and each is its own; v1 strokes are numbered by their order on the shot,
 * and strokes of the same second, place and shot count once (a gesture
 * torn into many one-point strokes), the group ending with its last.
 */
function numberedStrokes(manifest: ScreenManifest, origin: number): NumberedStroke[] {
  const strokes = manifest.events.filter((e) => e.type === "stroke");
  const v2 = manifest.version >= 2;
  const out: NumberedStroke[] = [];
  const v1Groups = new Map<string, NumberedStroke>();
  const ordinal = new Map<string, number>();
  for (const e of strokes) {
    const atMs = Math.max(0, e.at - origin);
    const endMs = e.endedAt !== undefined && e.endedAt > e.at ? Math.max(0, e.endedAt - origin) : undefined;
    // v1: what the old mark said — second, place, shot — is the stroke's identity.
    const v1Key = v2 ? "" : `${fmtOffset(atMs)}|${e.xPct ?? ""},${e.yPct ?? ""}|${e.shot ?? ""}`;
    const same = v2 ? undefined : v1Groups.get(v1Key);
    if (same) {
      if (endMs !== undefined && (same.endMs === undefined || endMs > same.endMs)) same.endMs = endMs;
      continue;
    }
    const shotKey = String(e.shot ?? "");
    const next = (ordinal.get(shotKey) || 0) + 1;
    ordinal.set(shotKey, next);
    const stroke: NumberedStroke = { n: v2 && e.n ? e.n : next, shot: e.shot, atMs, endMs, event: e };
    if (!v2) v1Groups.set(v1Key, stroke);
    out.push(stroke);
  }
  return out;
}

/** "[✏️3 синий, вверху по центру]" — no shot number: its section's heading says it. */
function strokeMark(s: NumberedStroke): ScreenMark {
  const centre = strokeCentre(s.event);
  const words = [strokeLook(s.event), centre ? regionWords(centre.x, centre.y) : ""].filter(Boolean).join(", ");
  return {
    atMs: s.atMs,
    text: `[✏️${s.n}${words ? ` ${words}` : ""}]`,
    ...(s.endMs !== undefined ? { endMs: s.endMs, closeText: `[/${s.n}]` } : {}),
  };
}

/** "[🖱 клик, вверху по центру]"; no place when it lay outside the captured area. */
function clickMark(e: ScreenManifestEvent, origin: number): ScreenMark {
  const where = e.xPct !== undefined && e.yPct !== undefined ? `, ${regionWords(e.xPct, e.yPct)}` : "";
  return { atMs: Math.max(0, e.at - origin), text: `[🖱 клик${where}]` };
}

function shotSaved(e: ScreenManifestEvent): boolean {
  return !!(e.files && e.files.length);
}

function relativeTo(dir: string, path: string): string {
  const base = dir.replace(/\/+$/, "");
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function percentRange(from: number, size: number): string {
  const a = Math.round(from);
  const b = Math.round(from + size);
  return a === b ? `${a}` : `${a}–${b}`;
}

/** A stroke's frame for the section's «Штрихи:» line; "" when the manifest has no place. */
function strokeFrame(e: ScreenManifestEvent): string {
  if (e.box) return `${percentRange(e.box.x, e.box.w)}% × ${percentRange(e.box.y, e.box.h)}%`;
  if (e.xPct !== undefined && e.yPct !== undefined) return `центр ${Math.round(e.xPct)}%, ${Math.round(e.yPct)}%`;
  return "";
}

/**
 * A screenshot's section heading and «Штрихи:» line. The file named is
 * what to read: the preview (with any other display's original), else the
 * original(s); paths are relative to the folder the header names.
 */
function shotSection(
  manifest: ScreenManifest,
  event: ScreenManifestEvent,
  spanStart: number,
  atMs: number,
  strokes: ReadonlyArray<NumberedStroke>,
): ScreenSection {
  const own = strokes.filter((s) => s.shot !== undefined && s.shot === event.shot);
  const parts = [`### Скрин ${event.shot ?? ""}`, `${fmtOffset(spanStart)}–${fmtOffset(atMs)}`];
  if (shotSaved(event)) {
    const files = event.files || [];
    const read = event.preview ? [event.preview, ...files.slice(1)] : files;
    parts.push(read.map((f) => relativeTo(manifest.dir, f)).join(", "));
    if (!own.length) parts.push("без пометок");
  } else {
    parts.push(UNSAVED_SHOT);
  }
  const frames = own
    .map((s) => ({ n: s.n, frame: strokeFrame(s.event) }))
    .filter((f) => f.frame)
    .map((f) => `${f.n} — ${f.frame}`);
  return {
    atMs,
    heading: parts.join(" · "),
    detail: frames.length ? `Штрихи: ${frames.join("; ")}` : "",
  };
}

/** NN/K forms of the contract, for the header's one statement of the file names. */
function fileNamesRule(version: number): string {
  if (version < 2) return `${FILE_NAME_FORMS.shot} — скрин`;
  return (
    `${FILE_NAME_FORMS.shot} — скрин, ${FILE_NAME_FORMS.preview} — уменьшенная копия, ` +
    `${FILE_NAME_FORMS.crop} — вырезка штриха K (не у каждого)`
  );
}

function header(manifest: ScreenManifest, shotCount: number, hasClicks: boolean): string {
  const folder = manifest.dir ? ` · папка: ${manifest.dir}` : "";
  const strokes = manifest.version >= 2
    ? "[✏️N …] — штрих N (на картинке тот же номер в кружке), стоит там, где начато рисование, [/N] — где отпущено"
    : "[✏️N …] — штрих N по порядку рисования на скрине, стоит там, где начато рисование, [/N] — где отпущено";
  const clicks = hasClicks ? "; [🖱 клик …] — клик мышью (кольцо на картинке)" : "";
  const frames = manifest.version >= 2 ? "рамки — в % снятой области" : "центры — в % экрана";
  return [
    `${HEADER_TITLE} · ${shotCountWords(shotCount)}${folder}`,
    "Как читать: «### Скрин K» — снимок и сказанное с прошлого снимка до него; " +
      `${strokes}${clicks}; цвет только различает штрихи; ${frames}. ` +
      `Файлы: ${fileNamesRule(manifest.version)}.`,
  ].join("\n");
}

/**
 * The marks, header and sections of one screen take, its times relative
 * to the recording's audio. The origin is the archived ``audioStartedAt``;
 * ``fallbackStartAt`` (the renderer's live clock) only matters for a
 * manifest the save never archived, and the session's own start is the
 * last resort. A manifest with no events adds nothing.
 */
export function screenAnnotationFromManifest(manifest: ScreenManifest, fallbackStartAt = 0): ScreenAnnotation {
  if (!manifest.events.length) return EMPTY_SCREEN_ANNOTATION;
  const origin = manifest.audioStartedAt || (fallbackStartAt > 0 ? fallbackStartAt : manifest.startedAt);
  const strokes = numberedStrokes(manifest, origin);
  const clicks = manifest.events.filter((e) => e.type === "click");
  const marks = [
    ...strokes.map(strokeMark),
    ...clicks.map((e) => clickMark(e, origin)),
  ].sort((a, b) => a.atMs - b.atMs);
  const sections: ScreenSection[] = [];
  let spanStart = 0;
  for (const event of manifest.events) {
    if (event.type !== "shot") continue;
    const atMs = Math.max(0, event.at - origin);
    sections.push(shotSection(manifest, event, spanStart, atMs, strokes));
    spanStart = atMs;
  }
  return { marks, header: header(manifest, sections.length, clicks.length > 0), sections };
}

/** The annotation adds something to a transcript. */
export function hasScreenAnnotation(annotation: ScreenAnnotation): boolean {
  return annotation.marks.length > 0 || !!annotation.header || annotation.sections.length > 0;
}

/** Each word's start time, ms, spread evenly over its segment. */
export function wordStartsFromSegments(segments: ReadonlyArray<TimedSegment>): number[] {
  const out: number[] = [];
  for (const seg of segments) {
    const n = countWords(seg.text || "");
    if (!n) continue;
    const start = Math.max(0, Number(seg.start) || 0) * 1000;
    const end = Math.max(start, (Number(seg.end) || 0) * 1000);
    for (let i = 0; i < n; i += 1) out.push(start + ((end - start) * i) / n);
  }
  return out.sort((a, b) => a - b);
}

/** Fraction (0..1) of the speech that came before `atMs`. */
export function speechFractionAt(atMs: number, opts: Pick<AnnotateOptions, "wordStartsMs" | "durationMs">): number {
  const words = opts.wordStartsMs || [];
  if (words.length) {
    let before = 0;
    for (const w of words) if (w <= atMs) before += 1;
    return before / words.length;
  }
  const duration = Number(opts.durationMs) || 0;
  if (duration > 0) return Math.max(0, Math.min(1, atMs / duration));
  return 1;
}

export interface AnnotateOptions {
  /** Each word's start, ms — the text's own timings (the live envelope). */
  wordStartsMs?: number[];
  /** The recording's length, ms — placement by share without timings. */
  durationMs?: number;
  /**
   * What stands for the words when nothing was said — the stop's reason,
   * "[ Silence ]" / "[ Mic not delivering audio ]": it heads the body,
   * above the sections and under the header. Unused when words were said.
   */
  silence?: string;
}

/** What goes in at a word boundary: a mark, a mark's close, or a screenshot's end of section. */
interface Placed {
  k: number;
  ms: number;
  /** 0 a close, 1 a mark, 2 a section end: at one boundary and moment a
   *  span closes first, and a stroke or click drawn at the very moment of
   *  a screenshot is still that screenshot's. */
  rank: 0 | 1 | 2;
  text: string;
}

/**
 * The spoken words cut into one run per section (and one after the last
 * section), with the marks put in at the boundaries their moments point
 * to. Each run keeps the words' own spacing and line breaks; with no
 * words at all, a run lists its marks one per line.
 */
function placeRuns(body: string, annotation: ScreenAnnotation, opts: AnnotateOptions): string[] {
  const tokens = body ? body.split(/(\s+)/) : [];
  const wordTokenIndexes: number[] = [];
  tokens.forEach((t, i) => { if (t && !/^\s+$/.test(t)) wordTokenIndexes.push(i); });
  const wordCount = wordTokenIndexes.length;
  // boundary k = before word k; k === wordCount = after the last word.
  // With no words every moment is boundary 0, and time alone orders them.
  const boundary = (ms: number): number =>
    wordCount ? Math.max(0, Math.min(wordCount, Math.round(speechFractionAt(ms, opts) * wordCount))) : 0;
  const placed: Placed[] = [];
  for (const mark of annotation.marks) {
    const k = boundary(mark.atMs);
    placed.push({ k, ms: mark.atMs, rank: 1, text: mark.text });
    if (mark.closeText && mark.endMs !== undefined) {
      const end = boundary(mark.endMs);
      if (end > k) placed.push({ k: end, ms: mark.endMs, rank: 0, text: mark.closeText });
    }
  }
  for (const section of annotation.sections) placed.push({ k: boundary(section.atMs), ms: section.atMs, rank: 2, text: "" });
  // Equal keys keep their input order (stable sort): marks by time.
  placed.sort((a, b) => a.k - b.k || a.ms - b.ms || a.rank - b.rank);

  const runs: string[] = [];
  let run: string[] = [];
  let cursor = 0;
  const endRun = () => {
    runs.push(run.join("").trim());
    run = [];
  };
  const putMarks = (k: number, before: boolean) => {
    // Marks at boundary k, in order; a section end closes the run.
    while (cursor < placed.length && placed[cursor].k === k) {
      const p = placed[cursor];
      cursor += 1;
      if (p.rank === 2) {
        endRun();
        continue;
      }
      // With no words, a run is its marks alone, one per line.
      if (before) run.push(p.text, " ");
      else run.push(run.length ? (wordCount ? " " : "\n") : "", p.text);
    }
  };
  let word = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (wordTokenIndexes[word] === i) {
      putMarks(word, true);
      word += 1;
    }
    if (/^\s+$/.test(tokens[i]) && !run.length) continue;
    run.push(tokens[i]);
  }
  putMarks(wordCount, false);
  endRun();
  return runs;
}

/**
 * The transcript of a screen take: the header, then one section per
 * screenshot — its heading, its strokes' frames, what was said up to it
 * with the marks in place — then what was said after the last one, under
 * its own heading; blocks separated by a blank line. With no screenshot
 * the text with its marks follows the header as one block. `text` is the
 * spoken words (see the module comment); with none, ``opts.silence``
 * heads the body. With an empty annotation the text is returned as it is.
 */
export function annotateTranscript(
  text: string,
  annotation: ScreenAnnotation,
  opts: AnnotateOptions = {},
): string {
  if (!hasScreenAnnotation(annotation)) return text;
  const body = String(text || "").trim();
  const runs = placeRuns(body, annotation, opts);
  const blocks: string[] = [annotation.header];
  if (!body) blocks.push(String(opts.silence || "").trim());
  annotation.sections.forEach((section, i) => {
    blocks.push([section.heading, section.detail, runs[i]].filter(Boolean).join("\n"));
  });
  const after = runs[annotation.sections.length];
  if (after) blocks.push(annotation.sections.length ? `${AFTER_LAST_SHOT_HEADING}\n${after}` : after);
  return blocks.filter((block) => block.trim()).join("\n\n");
}

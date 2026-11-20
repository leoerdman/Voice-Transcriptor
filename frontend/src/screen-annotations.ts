/**
 * Screen-mode marks in a transcript — pure.
 *
 * A screen-mode recording comes back from the desktop shell with a
 * manifest: every stroke the user drew and every screenshot they took,
 * each with an epoch time (desktop/screen-mode.js `screenSessionManifest`).
 * The reader of the result is usually an agent asked to fix what the user
 * pointed at, so the transcript carries three things, composed here:
 *
 *   * a HEADER — what the text is, how many screenshots, the folder they
 *     are in (once: no mark repeats it), and how to read the marks;
 *   * the spoken text with short bracketed MARKS at the moments they
 *     happened in speech:
 *
 *       «сейчас жёлтым обведу [✏️3 скрин 7: жёлтый обвод, вверху слева]
 *        вот эту кнопку [/3] она съехала [📸 03:53 скрин 7]»
 *
 *     A stroke's mark stands where the drawing began, mid-sentence if
 *     that is where it began; `[/N]` closes it where it was released,
 *     when at least one word was said while it was drawn;
 *   * a SUMMARY — one item per screenshot: its file, its preview, its
 *     time span, and each stroke on it with its frame and its crop.
 *
 * Manifest v2 numbers each stroke on its screenshot (the same number is
 * drawn in a circle on the picture) and names its tool and shape; v1 has
 * neither, so a v1 stroke is numbered by its order on the shot, reads as
 * "штрих", and strokes that read the same (one gesture torn into many
 * one-point strokes) still count once.
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
 * annotated and the mark goes in at that word boundary. Using a fraction
 * rather than an exact word lets the same placement work for the text the
 * segments describe AND for an upscaled rewrite of it, which has no
 * timings of its own.
 *
 * Every caller hands the composer the SPOKEN words — the final as
 * transcribed, its upscaled rewrite, the live text, a crash draft's words
 * (the panel is cleared when a take starts and the draft is last written
 * when its stop begins, so a draft never holds an annotated final) — and
 * the composer adds the header and the summary once per call. Annotated
 * text is never annotated again, so nothing is ever doubled.
 */

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
  type: "stroke" | "shot";
  at: number;
  shot?: number;
  /** Stroke: epoch ms the stroke was released. */
  endedAt?: number;
  /** Stroke centre, percent of its display (desktop/screen-mode.js). */
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
  /** Manifest schema version: 1 (no stroke numbers) or 2. */
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

/** Everything a screen take adds to its transcript. */
export interface ScreenAnnotation {
  /** Inline marks, in time order. */
  marks: ReadonlyArray<ScreenMark>;
  /** The lines above the text; "" for none. */
  header: string;
  /** The lines below the text; "" for none. */
  summary: string;
}

export const EMPTY_SCREEN_ANNOTATION: ScreenAnnotation = Object.freeze({
  marks: Object.freeze([]),
  header: "",
  summary: "",
});

export interface TimedSegment {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  text: string;
}

const HEADER_TITLE = "Диктовка с рисованием по экрану";
const SUMMARY_TITLE = "Сводка по скринам:";
const UNSAVED_SHOT = "не сохранён (нет доступа к записи экрана)";

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

const SHAPE_WORDS: Readonly<Record<ScreenStrokeShape, { word: string; gender: "m" | "f" }>> = Object.freeze({
  rect: { word: "прямоугольник", gender: "m" },
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

/** Read the desktop shell's manifest defensively: anything malformed is absent. */
export function parseScreenManifest(raw: unknown): ScreenManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const events = Array.isArray(obj.events) ? obj.events : [];
  const parsed: ScreenManifestEvent[] = [];
  for (const item of events) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const type = e.type === "stroke" || e.type === "shot" ? e.type : null;
    const at = Number(e.at);
    if (!type || !Number.isFinite(at)) continue;
    const event: ScreenManifestEvent = { type, at };
    const shot = finite(e.shot);
    if (shot !== undefined) event.shot = shot;
    if (type === "stroke") {
      const endedAt = finite(e.endedAt);
      if (endedAt !== undefined) event.endedAt = endedAt;
      const xPct = finite(e.xPct);
      const yPct = finite(e.yPct);
      if (xPct !== undefined) event.xPct = xPct;
      if (yPct !== undefined) event.yPct = yPct;
      if (typeof e.color === "string") event.color = e.color;
      const n = finite(e.n);
      if (n !== undefined && n > 0) event.n = n;
      if (e.tool === "rect" || e.tool === "pen") event.tool = e.tool;
      if (typeof e.shape === "string" && SHAPES.has(e.shape)) event.shape = e.shape as ScreenStrokeShape;
      const box = parseBox(e.box);
      if (box) event.box = box;
      const crop = nonEmptyString(e.crop);
      if (crop) event.crop = crop;
    } else {
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
 * Where on the screen, in words: a 3×3 grid of the display. The shell
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

/** "жёлтый обвод", "красная линия", "штрих" — colour only from the palette. */
function strokeLook(e: ScreenManifestEvent): string {
  const shape = e.shape ? SHAPE_WORDS[e.shape] : UNKNOWN_SHAPE;
  const color = e.color ? SCREEN_COLOR_NAMES[e.color.trim().toLowerCase()] : undefined;
  return color ? `${color[shape.gender]} ${shape.word}` : shape.word;
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

function strokeMark(s: NumberedStroke): ScreenMark {
  const centre = strokeCentre(s.event);
  const where = centre ? `, ${regionWords(centre.x, centre.y)}` : "";
  const shot = s.shot ? ` скрин ${s.shot}` : "";
  return {
    atMs: s.atMs,
    text: `[✏️${s.n}${shot}: ${strokeLook(s.event)}${where}]`,
    ...(s.endMs !== undefined ? { endMs: s.endMs, closeText: `[/${s.n}]` } : {}),
  };
}

function shotSaved(e: ScreenManifestEvent): boolean {
  return !!(e.files && e.files.length);
}

/** No stroke of the manifest is on the shot (the stroke events are the one record of them). */
function shotIsBlank(e: ScreenManifestEvent, strokes: ReadonlyArray<NumberedStroke>): boolean {
  return !strokes.some((s) => s.shot !== undefined && s.shot === e.shot);
}

function shotMark(e: ScreenManifestEvent, atMs: number, strokes: ReadonlyArray<NumberedStroke>): ScreenMark {
  const label = `[📸 ${fmtOffset(atMs)} скрин ${e.shot ?? ""}`;
  if (!shotSaved(e)) return { atMs, text: `${label} — ${UNSAVED_SHOT}]` };
  return { atMs, text: shotIsBlank(e, strokes) ? `${label} — без пометок]` : `${label}]` };
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

function strokeSummaryLine(s: NumberedStroke, dir: string): string {
  const e = s.event;
  const parts = [`  ${s.n} · ${fmtOffset(s.atMs)} ${strokeLook(e)}`];
  if (e.box) {
    parts.push(`${percentRange(e.box.x, e.box.w)}% × ${percentRange(e.box.y, e.box.h)}%`);
  } else if (e.xPct !== undefined && e.yPct !== undefined) {
    parts.push(`центр ${Math.round(e.xPct)}%, ${Math.round(e.yPct)}%`);
  }
  if (e.crop) parts.push(`вырезка ${relativeTo(dir, e.crop)}`);
  return parts.join(" · ");
}

const AREA_WORDS: Readonly<Record<"window" | "display", string>> = Object.freeze({
  window: "окно",
  display: "экран",
});

function header(manifest: ScreenManifest, shotCount: number): string {
  const folder = manifest.dir ? ` · папка: ${manifest.dir}` : "";
  const numbering = manifest.version >= 2
    ? "штрих N на скрине K, на картинке тот же номер в кружке"
    : "штрих N на скрине K по порядку рисования";
  return [
    `${HEADER_TITLE} · ${shotCountWords(shotCount)}${folder}`,
    `Как читать: [✏️N скрин K: …] — ${numbering}; стоит там, где начато рисование, [/N] — где отпущено. ` +
      "Цвет только различает штрихи, смысл — в словах. " +
      "[📸 время скрин K] — снимок: сказанное с прошлого снимка относится к нему. Внизу — сводка с файлами.",
  ].join("\n");
}

function summary(
  manifest: ScreenManifest,
  shots: ReadonlyArray<{ event: ScreenManifestEvent; atMs: number }>,
  strokes: ReadonlyArray<NumberedStroke>,
): string {
  const dir = manifest.dir;
  const lines: string[] = [SUMMARY_TITLE];
  const listed = new Set<NumberedStroke>();
  let spanStart = 0;
  for (const { event, atMs } of shots) {
    const own = strokes.filter((s) => s.shot !== undefined && s.shot === event.shot);
    own.forEach((s) => listed.add(s));
    const parts = [`Скрин ${event.shot ?? ""}`];
    if (shotSaved(event)) {
      const files = (event.files || []).map((f) => relativeTo(dir, f)).join(", ");
      parts.push(event.preview ? `${files} (читать: ${relativeTo(dir, event.preview)})` : files);
    } else {
      parts.push(UNSAVED_SHOT);
    }
    if (event.area) parts.push(AREA_WORDS[event.area]);
    parts.push(`${fmtOffset(spanStart)}–${fmtOffset(atMs)}`);
    if (shotSaved(event) && shotIsBlank(event, strokes)) parts.push("без пометок");
    lines.push(parts.join(" · "));
    own.forEach((s) => lines.push(strokeSummaryLine(s, dir)));
    spanStart = atMs;
  }
  // Strokes no screenshot holds: drawn after the last one, or on a shot
  // whose event is missing. Still listed — they are part of what was shown.
  const orphans = strokes.filter((s) => !listed.has(s));
  const orphanShots: Array<number | undefined> = [];
  for (const s of orphans) if (!orphanShots.includes(s.shot)) orphanShots.push(s.shot);
  for (const shot of orphanShots) {
    lines.push(shot !== undefined ? `Скрин ${shot} · снимка нет` : "Без скрина");
    orphans.filter((s) => s.shot === shot).forEach((s) => lines.push(strokeSummaryLine(s, dir)));
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * The marks, header and summary of one screen take, its times relative to
 * the recording's audio. The origin is the archived ``audioStartedAt``;
 * ``fallbackStartAt`` (the renderer's live clock) only matters for a
 * manifest the save never archived, and the session's own start is the
 * last resort. A manifest with no events adds nothing.
 */
export function screenAnnotationFromManifest(manifest: ScreenManifest, fallbackStartAt = 0): ScreenAnnotation {
  if (!manifest.events.length) return EMPTY_SCREEN_ANNOTATION;
  const origin = manifest.audioStartedAt || (fallbackStartAt > 0 ? fallbackStartAt : manifest.startedAt);
  const strokes = numberedStrokes(manifest, origin);
  const shots = manifest.events
    .filter((e) => e.type === "shot")
    .map((event) => ({ event, atMs: Math.max(0, event.at - origin) }));
  const marks = [
    ...strokes.map(strokeMark),
    ...shots.map(({ event, atMs }) => shotMark(event, atMs, strokes)),
  ].sort((a, b) => a.atMs - b.atMs);
  return {
    marks,
    header: header(manifest, shots.length),
    summary: summary(manifest, shots, strokes),
  };
}

/** The annotation adds something to a transcript. */
export function hasScreenAnnotation(annotation: ScreenAnnotation): boolean {
  return annotation.marks.length > 0 || !!annotation.header || !!annotation.summary;
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
   * above the marks and under the header. Unused when words were said.
   */
  silence?: string;
}

/** The spoken words with the marks put in at the boundaries their moments point to. */
function placeMarks(body: string, marks: ReadonlyArray<ScreenMark>, opts: AnnotateOptions): string {
  // Nothing was said: the reason, if the stop gave one, then the marks
  // alone, one per line — the user drew without speaking, and the marks
  // are still the record of it. No span holds a word, so nothing is closed.
  if (!body) {
    const silence = String(opts.silence || "").trim();
    const lines = marks.map((m) => m.text).join("\n");
    return [silence, lines].filter(Boolean).join("\n\n");
  }
  if (!marks.length) return body;
  const tokens = body.split(/(\s+)/);
  const wordTokenIndexes: number[] = [];
  tokens.forEach((t, i) => { if (t && !/^\s+$/.test(t)) wordTokenIndexes.push(i); });
  const wordCount = wordTokenIndexes.length;
  // boundary k = before word k; k === wordCount = after the last word.
  const boundary = (ms: number): number =>
    Math.max(0, Math.min(wordCount, Math.round(speechFractionAt(ms, opts) * wordCount)));
  const placed: Array<{ k: number; ms: number; closes: boolean; text: string }> = [];
  for (const mark of marks) {
    const k = boundary(mark.atMs);
    placed.push({ k, ms: mark.atMs, closes: false, text: mark.text });
    if (mark.closeText && mark.endMs !== undefined) {
      const end = boundary(mark.endMs);
      if (end > k) placed.push({ k: end, ms: mark.endMs, closes: true, text: mark.closeText });
    }
  }
  // Same boundary: time order; a span that closes at the moment another
  // opens closes first. Equal keys keep their input order (stable sort).
  placed.sort((a, b) => a.k - b.k || a.ms - b.ms || Number(b.closes) - Number(a.closes));
  const byBoundary = new Map<number, string[]>();
  for (const p of placed) {
    const list = byBoundary.get(p.k) || [];
    list.push(p.text);
    byBoundary.set(p.k, list);
  }
  const out: string[] = [];
  let word = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (wordTokenIndexes[word] === i) {
      const here = byBoundary.get(word);
      if (here) out.push(here.join(" "), " ");
      word += 1;
    }
    out.push(tokens[i]);
  }
  const tail = byBoundary.get(wordCount);
  if (tail) out.push(" ", tail.join(" "));
  return out.join("");
}

/**
 * The transcript of a screen take: the header, the spoken words with the
 * marks placed in them, the summary — blocks separated by a blank line.
 * `text` is the spoken words (see the module comment); with none,
 * ``opts.silence`` heads the body. With an empty annotation the text is
 * returned as it is.
 */
export function annotateTranscript(
  text: string,
  annotation: ScreenAnnotation,
  opts: AnnotateOptions = {},
): string {
  if (!hasScreenAnnotation(annotation)) return text;
  const body = placeMarks(String(text || "").trim(), annotation.marks, opts);
  return [annotation.header, body, annotation.summary].filter((block) => block.trim()).join("\n\n");
}

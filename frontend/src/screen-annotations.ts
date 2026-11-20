/**
 * Screen-mode marks in a transcript — pure.
 *
 * A screen-mode recording comes back from the desktop shell with a
 * manifest: every stroke the user drew and every screenshot they took,
 * each with an epoch time (desktop/screen-mode.js `screenSessionManifest`).
 * This module turns that manifest into short bracketed marks and puts
 * each one into the transcript at the point where it happened in speech:
 *
 *   «вот тут [✏️ 00:12 линия вверху справа (82%, 14%) → скрин 1] кнопка
 *    съехала [📸 00:15 скрин 1: /…/screen-…/shot-01.png]»
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
 */

export interface ScreenManifestEvent {
  type: "stroke" | "shot";
  at: number;
  shot?: number;
  /** Stroke centre, percent of its display (desktop/screen-mode.js). */
  xPct?: number;
  yPct?: number;
  color?: string;
  files?: string[];
}

export interface ScreenManifest {
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
}

export interface TimedSegment {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  text: string;
}

function fmtOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
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
    parsed.push({
      type,
      at,
      shot: Number.isFinite(Number(e.shot)) ? Number(e.shot) : undefined,
      xPct: Number.isFinite(Number(e.xPct)) ? Number(e.xPct) : undefined,
      yPct: Number.isFinite(Number(e.yPct)) ? Number(e.yPct) : undefined,
      color: typeof e.color === "string" ? e.color : undefined,
      files: Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === "string") : undefined,
    });
  }
  const audioStartedAt = Number(obj.audioStartedAt);
  const endedAt = Number(obj.endedAt);
  return {
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

/**
 * One mark per event, its time relative to the recording's audio. The
 * origin is the archived ``audioStartedAt``; ``fallbackStartAt`` (the
 * renderer's live clock) only matters for a manifest the save never
 * archived, and the session's own start is the last resort.
 */
export function screenMarksFromManifest(manifest: ScreenManifest, fallbackStartAt = 0): ScreenMark[] {
  const origin = manifest.audioStartedAt || (fallbackStartAt > 0 ? fallbackStartAt : manifest.startedAt);
  return manifest.events.map((e) => {
    const atMs = Math.max(0, e.at - origin);
    const time = fmtOffset(atMs);
    if (e.type === "stroke") {
      const placed = e.xPct !== undefined && e.yPct !== undefined;
      const where = placed ? ` ${regionWords(e.xPct as number, e.yPct as number)}` : "";
      const pos = placed ? ` (${e.xPct}%, ${e.yPct}%)` : "";
      const shot = e.shot ? ` → скрин ${e.shot}` : "";
      return { atMs, text: `[✏️ ${time} линия${where}${pos}${shot}]` };
    }
    const files = e.files && e.files.length
      ? `: ${e.files.join(", ")}`
      : " — не сохранён (нет доступа к записи экрана)";
    return { atMs, text: `[📸 ${time} скрин ${e.shot ?? ""}${files}]` };
  });
}

function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
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
export function speechFractionAt(atMs: number, opts: { wordStartsMs?: number[]; durationMs?: number }): number {
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

/**
 * Insert the marks into `text` at the word boundaries their fractions
 * point to. Marks that share a boundary keep their time order. An empty
 * text becomes the marks alone, one per line — the user drew without
 * speaking, and the marks are still the record of it.
 */
export function annotateTranscript(
  text: string,
  marks: ReadonlyArray<ScreenMark>,
  opts: { wordStartsMs?: number[]; durationMs?: number } = {},
): string {
  if (!marks.length) return text;
  const body = String(text || "").trim();
  if (!body) return marks.map((m) => m.text).join("\n");
  const tokens = body.split(/(\s+)/);
  const wordTokenIndexes: number[] = [];
  tokens.forEach((t, i) => { if (t && !/^\s+$/.test(t)) wordTokenIndexes.push(i); });
  const wordCount = wordTokenIndexes.length;
  // boundary k = before word k; k === wordCount = after the last word.
  const byBoundary = new Map<number, string[]>();
  for (const mark of [...marks].sort((a, b) => a.atMs - b.atMs)) {
    const k = Math.max(0, Math.min(wordCount, Math.round(speechFractionAt(mark.atMs, opts) * wordCount)));
    const list = byBoundary.get(k) || [];
    list.push(mark.text);
    byBoundary.set(k, list);
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

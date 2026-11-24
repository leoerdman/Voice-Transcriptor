/**
 * The tuner's arithmetic: what a threshold pair does to a take's windows.
 *
 * This module is pure so the strip, the summary line and the tests cannot
 * disagree about what a slider position means. The backend supplies the
 * numbers (one cosine and one level per window, exactly what the gate
 * compares); everything here is reading them against a pair.
 */

/** One scored window, as the tune route reports it. */
export interface TuneWindow {
  /** Where the window starts in the take, in milliseconds. */
  start_ms: number;
  /** Cosine to the profile's direction, in [−1, 1] as the net gives it. */
  score: number;
  /** The window's own loudness, dBFS RMS. */
  level_db: number;
  /** The level rule already decided this window: withheld as far field. */
  far: boolean;
}

/** What the tune route returns for one slot against one take. */
export interface TuneData {
  slot: number;
  name: string;
  recording: string;
  self_floor: number;
  level_db: number;
  open_at: number;
  close_at: number;
  /** True when the pair was set by hand, false when the floor derived it. */
  tuned: boolean;
  windows: TuneWindow[];
}

/** Thresholds live on a cosine axis; a third decimal is finer than ears. */
function cleanThreshold(value: unknown): number {
  const x = Number(value);
  if (!Number.isFinite(x)) return 0;
  return Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
}

/** The owner's pair, or nothing: 0 means "derive it from the floor". */
export function normalizeTuneData(raw: unknown): TuneData | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const slot = Number(data.slot);
  if (!Number.isInteger(slot) || slot < 1) return null;
  const rawWindows = Array.isArray(data.windows) ? data.windows : [];
  const windows: TuneWindow[] = [];
  for (const entry of rawWindows) {
    if (!entry || typeof entry !== "object") continue;
    const w = entry as Record<string, unknown>;
    const score = Number(w.score);
    if (!Number.isFinite(score)) continue;
    windows.push({
      start_ms: Number.isFinite(Number(w.start_ms)) ? Number(w.start_ms) : 0,
      score,
      level_db: Number.isFinite(Number(w.level_db)) ? Number(w.level_db) : 0,
      far: w.far === true,
    });
  }
  return {
    slot,
    name: typeof data.name === "string" ? data.name : "",
    recording: typeof data.recording === "string" ? data.recording : "",
    self_floor: cleanThreshold(data.self_floor),
    level_db: Number.isFinite(Number(data.level_db)) ? Number(data.level_db) : 0,
    open_at: cleanThreshold(data.open_at),
    close_at: cleanThreshold(data.close_at),
    tuned: data.tuned === true,
    windows,
  };
}

/** A slider position as the gate stores it: three decimals, inside (0, 1). */
export function clampOpen(value: number): number {
  const x = Number.isFinite(value) ? value : 0.5;
  return Math.round(Math.min(0.98, Math.max(0.02, x)) * 1000) / 1000;
}

/** The close never reaches the open: a hysteresis needs a gap to live in. */
export function clampClose(value: number, openAt: number): number {
  const ceiling = clampOpen(openAt) - 0.01;
  const x = Number.isFinite(value) ? value : ceiling;
  return Math.round(Math.min(ceiling, Math.max(0.01, x)) * 1000) / 1000;
}

/** One decimal of a cosine is what a bar can show. */
export function tuneBarHeight(score: number): number {
  const x = Number.isFinite(score) ? score : 0;
  return Math.round(Math.min(1, Math.max(0, x)) * 1000) / 10;
}

/**
 * What the gate does with one window, read statically.
 *
 * The real gate is a hysteresis over time; a strip is a picture, so a window
 * between the two lines is drawn as its own zone rather than guessed:
 * ≥ open passes for sure, < close is withheld for sure, and the band between
 * depends on what came before it — which is exactly what the amber means.
 */
export type TuneZone = "kept" | "cut" | "between" | "far";

export function windowZone(w: TuneWindow, openAt: number, closeAt: number): TuneZone {
  if (w.far) return "far";
  if (w.score >= openAt) return "kept";
  if (w.score < closeAt) return "cut";
  return "between";
}

export function tuneDecisions(
  windows: TuneWindow[],
  openAt: number,
  closeAt: number,
): TuneZone[] {
  return windows.map((w) => windowZone(w, openAt, closeAt));
}

export interface TuneSummary {
  total: number;
  kept: number;
  cut: number;
  between: number;
  far: number;
  /** Kept share of the windows the level rule did not already decide. */
  keptShare: number;
  /** Withheld share (cut + far) of all windows. */
  withheldShare: number;
}

export function tuneSummary(
  windows: TuneWindow[],
  openAt: number,
  closeAt: number,
): TuneSummary {
  let kept = 0;
  let cut = 0;
  let between = 0;
  let far = 0;
  for (const w of windows) {
    const zone = windowZone(w, openAt, closeAt);
    if (zone === "kept") kept += 1;
    else if (zone === "cut") cut += 1;
    else if (zone === "between") between += 1;
    else far += 1;
  }
  const judged = windows.length - far;
  return {
    total: windows.length,
    kept,
    cut,
    between,
    far,
    keptShare: judged > 0 ? kept / judged : 0,
    withheldShare: windows.length > 0 ? (cut + far) / windows.length : 0,
  };
}

/** The one sentence under the strip, in percent because bars are percent. */
export function tuneSummaryText(s: TuneSummary): string {
  if (s.total === 0) return "This take has no window Solo could score.";
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const parts = [
    `${pct(s.keptShare)} of your scored windows pass`,
    `${pct(s.withheldShare)} of the take is withheld`,
  ];
  if (s.between > 0) {
    parts.push(`${s.between} sit between the lines and follow what came before`);
  }
  if (s.far > 0) {
    parts.push(`${s.far} withheld by the level rule alone`);
  }
  return parts.join("; ") + ".";
}

export function tuneSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

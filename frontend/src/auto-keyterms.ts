/**
 * Settings → Deepgram: the self-filling key-term vocabulary.
 *
 * The backend mines the archive and owns every decision about it — which
 * terms, which are sent, the token budget they spend
 * (`backend/auto_keyterms.py`, `GET /api/deepgram/auto-keyterms`). The
 * renderer only shows that payload and sends three intents back: switch
 * it, remove a term, restore a term. This module is the pure half: parse
 * the payload defensively (it crosses a process boundary — a backend
 * mid-upgrade must render as "nothing mined yet", never as a half-built
 * list), word the summary, and compute the one edit the renderer does
 * own — appending a pinned term to the manual key-terms field, which is
 * the field's text and is saved with it through `/api/config`.
 */

export interface AutoKeyterm {
  term: string;
  recordings: number;
  /** Whether the shared token budget had room for it. */
  included: boolean;
}

export interface AutoKeytermsState {
  enabled: boolean;
  terms: AutoKeyterm[];
  blocked: string[];
  manualCount: number;
  autoCount: number;
  tokensUsed: number;
  tokenBudget: number;
  /** ISO time of the last recompute, or "" before the first one. */
  computedAt: string;
  recordings: number;
}

export const AUTO_KEYTERMS_EMPTY: AutoKeytermsState = {
  enabled: true,
  terms: [],
  blocked: [],
  manualCount: 0,
  autoCount: 0,
  tokensUsed: 0,
  tokenBudget: 0,
  computedAt: "",
  recordings: 0,
};

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseAutoKeytermsState(raw: unknown): AutoKeytermsState {
  if (!raw || typeof raw !== "object") return { ...AUTO_KEYTERMS_EMPTY };
  const r = raw as Record<string, unknown>;
  const terms: AutoKeyterm[] = [];
  for (const row of Array.isArray(r.terms) ? r.terms : []) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const term = text(item.term);
    if (!term) continue;
    terms.push({ term, recordings: count(item.recordings), included: item.included === true });
  }
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : AUTO_KEYTERMS_EMPTY.enabled,
    terms,
    blocked: (Array.isArray(r.blocked) ? r.blocked : []).map(text).filter(Boolean),
    manualCount: count(r.manualCount),
    autoCount: count(r.autoCount),
    tokensUsed: count(r.tokensUsed),
    tokenBudget: count(r.tokenBudget),
    computedAt: text(r.computedAt),
    recordings: count(r.recordings),
  };
}

/** The line under the switch: what the request spends, and from what. */
export function autoKeytermsSummary(state: AutoKeytermsState): string {
  const budget = state.tokenBudget
    ? `${state.tokensUsed} of ${state.tokenBudget} tokens used`
    : "";
  const split = state.enabled
    ? `${state.manualCount} yours + ${state.autoCount} automatic`
    : `${state.manualCount} yours; automatic terms are off`;
  const source = state.computedAt
    ? `Learned from ${state.recordings} recording${state.recordings === 1 ? "" : "s"}.`
    : "Nothing learned yet — the archive is read in the background.";
  return [budget && `${budget} (${split}).`, source].filter(Boolean).join(" ");
}

/**
 * The manual key-terms text with *term* appended, in the separator the
 * text already uses (newline-separated lists stay newline-separated).
 * Unchanged when the term is already there, compared case-insensitively
 * — the same rule the backend's parser dedupes by.
 */
export function appendKeyterm(raw: string, term: string): string {
  const clean = term.trim();
  if (!clean) return raw;
  const existing = raw
    .split(/[,\n]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (existing.includes(clean.toLowerCase())) return raw;
  const body = raw.replace(/[\s,]+$/, "");
  if (!body) return clean;
  const newlineList = body.includes("\n") && !body.includes(",");
  return `${body}${newlineList ? "\n" : ", "}${clean}`;
}

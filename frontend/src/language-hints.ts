/**
 * "Expected languages" — the Nova-3 multilingual language hints.
 *
 * Since Deepgram's 2026-10-23 switch, ``language=multi`` is a 55-language
 * model that labels this user's Russian as Latvian, Ukrainian, Persian…
 * The user declares the languages they actually speak; the backend sends
 * them as ``language_hint`` and the dual-stream merge treats a stretch in
 * any other language as a mislabel (``backend/deepgram_language.py``,
 * ``backend/deepgram_dual.py``). The backend owns the offer and the
 * default (bootstrap ``live_defaults.language_hint_options`` /
 * ``language_hints``); this module owns what a stored, missing or broken
 * preference resolves to — with the same rule as ./deepgram-dual: absent
 * means the backend's default, never "none", because the next autosave
 * would persist whatever is shown.
 *
 * Pure — tests/language-hints.test.ts.
 */

export interface LanguageHintDefaults {
  /** Codes the backend accepts, in the picker's order. */
  options: string[];
  /** What an absent preference means. */
  defaults: string[];
}

function codes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const code = String(item ?? "").trim().toLowerCase();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/** The bootstrap pair, or ``null`` when the backend did not publish it. */
export function parseLanguageHintDefaults(options: unknown, defaults: unknown): LanguageHintDefaults | null {
  const offered = codes(options);
  if (!offered.length || !Array.isArray(defaults)) return null;
  return { options: offered, defaults: codes(defaults).filter((c) => offered.includes(c)) };
}

/**
 * The hints the picker should show for a stored preference: an absent
 * (non-array) value is the backend default; a stored list keeps only the
 * codes still offered, in the offer's order; ``[]`` stays "no hints".
 */
export function resolveLanguageHints(stored: unknown, backend: LanguageHintDefaults): string[] {
  const chosen = Array.isArray(stored) ? codes(stored) : backend.defaults;
  return backend.options.filter((code) => chosen.includes(code));
}

/** Human label for a hint code in the picker. */
export function languageHintLabel(code: string): string {
  return code.toUpperCase();
}

/**
 * The words of History's screenshot strip (a screen-mode recording's
 * screenshots under its transcript).
 *
 * The strip used to be mouse-only images labelled by their file names
 * ("shot-3.png"), and a screenshot that failed to load was a console line
 * only — if every one failed the row simply stayed hidden, and nothing
 * said the recording had screenshots at all. Each thumbnail is a button
 * now, named for what it is and what pressing it does, and failures are
 * counted where the screenshots would have been.
 */

export function screenThumbLabel(index: number, total: number, expanded: boolean): string {
  const which = total > 1 ? `Screenshot ${index + 1} of ${total}` : "Screenshot";
  return `${which} — ${expanded ? "collapse" : "expand"}`;
}

/** The note shown in the strip when some screenshots could not be loaded, or null. */
export function screensStripNote(failed: number, total: number): string | null {
  const bad = Math.max(0, Math.trunc(failed));
  if (!bad) return null;
  if (bad >= total) {
    return bad === 1 ? "The screenshot could not be loaded." : `${bad} screenshots could not be loaded.`;
  }
  return `${bad} of ${total} screenshots could not be loaded.`;
}

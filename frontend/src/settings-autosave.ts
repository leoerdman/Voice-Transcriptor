/**
 * When the renderer is allowed to write the user's preferences back.
 *
 * `buildUiPreferencesSavePlan` collects the WHOLE `preferences` block out
 * of the DOM — archive directory, keyterms, dual-stream, microphone,
 * upscale model, both hotkeys — and the backend's `_deep_merge` treats a
 * key that is present with an empty value as a value, not as an absence.
 * So an autosave that fires while the DOM still shows markup defaults
 * does not save "nothing": it overwrites the user's real configuration
 * with blanks, successfully and silently, and the failure surface never
 * lights up because nothing failed.
 *
 * Two different states have to be told apart, and conflating them is
 * what made this a bug:
 *
 *   • `suppressed` — a load is in progress and is itself writing to the
 *     DOM. A re-entrancy guard, cleared in `finally`.
 *   • `loaded` — the preferences have been read from the backend at
 *     least once, so the DOM is the user's choices rather than the
 *     markup's. A `finally` block cannot clear this, because a failed
 *     load is exactly the branch that runs it.
 *
 * `deepgram-dual.ts` already makes this argument for two fields
 * ("absent means the documented default, never off"). This is the same
 * rule for the whole set.
 */

export interface UiPreferencesAutosaveState {
  /** A configuration load has completed successfully at least once. */
  loaded: boolean;
  /** A configuration load is currently populating the DOM. */
  suppressed: boolean;
}

export function mayAutosaveUiPreferences(state: UiPreferencesAutosaveState): boolean {
  if (state.suppressed) return false;
  return state.loaded;
}

/**
 * The value a catalog-backed preference (the upscale preset) holds right
 * now, given what its select shows and the id parked while the catalog
 * could not be read.
 *
 * When the catalog request fails the select is rebuilt with one disabled
 * "unavailable" row and an empty value, and the user's id is parked until
 * the next successful load. An unloaded catalog means "unknown", not
 * "none": the preference block is saved whole, so reading the empty
 * select would write a blank over the user's choice — the rule above,
 * for the one key it did not cover.
 */
export function catalogChoiceForSave(selected: string, parked: string): string {
  const chosen = String(selected || "").trim();
  if (chosen) return chosen;
  return String(parked || "").trim();
}

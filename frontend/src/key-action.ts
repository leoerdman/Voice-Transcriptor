/**
 * What the one button beside a provider's API-key field does.
 *
 * The button is Save while the user has typed a key and Delete while a
 * key is stored and nothing new is typed. `handleKeyAction` used to pick
 * the action by reading the button's CSS class, and Delete went straight
 * to posting an empty key — no confirmation — although focusing the
 * masked field clears the mask, so the button reads "Delete key" over an
 * empty focused field and one click destroys a secret the user may have
 * no copy of. The action is decided from state here; deleting asks first
 * (as presets, models and Delete-all already do for cheaper data).
 */

export type KeyAction = "save" | "delete" | "none";

export interface KeyFieldState {
  /** A key is stored for this provider. */
  saved: boolean;
  /** The field shows the stored key's mask, not user input. */
  masked: boolean;
  /** What the field holds. */
  value: string;
}

export function keyAction(state: KeyFieldState): KeyAction {
  const hasTyped = !state.masked && !!String(state.value || "").trim();
  if (hasTyped) return "save";
  if (state.saved) return "delete";
  return "none";
}

function deleteKeyConfirmation(providerName: string): string {
  return `Delete the saved ${providerName} API key?\n\nThis cannot be undone — you will need the key again to use ${providerName}.`;
}

export interface KeyActionDeps {
  providerName: string;
  confirm(message: string): boolean;
  save(): Promise<void>;
  remove(): Promise<void>;
}

/** Run the button's action; a delete happens only after the user confirms it. */
export async function performKeyAction(state: KeyFieldState, deps: KeyActionDeps): Promise<KeyAction> {
  const action = keyAction(state);
  if (action === "delete") {
    if (!deps.confirm(deleteKeyConfirmation(deps.providerName))) return "none";
    await deps.remove();
  } else if (action === "save") {
    await deps.save();
  }
  return action;
}

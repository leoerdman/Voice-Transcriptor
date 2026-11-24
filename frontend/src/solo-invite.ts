/**
 * Solo's one-time call: the line that meets the feature before anything is
 * learned, and the flag that makes it once.
 *
 * Nothing here decides when Solo can be turned on — `voiceMaskView` does that.
 * This module answers two questions and nothing else: does the call show, and
 * has it already been answered. A press on either of its controls writes the
 * flag, so the call cannot come back to ask again; a learned voice ends it by
 * itself, because then the button it points at exists.
 */

/** Written once, read at boot. A storage that throws is treated as "not yet". */
export const SOLO_INVITE_KEY = "transcriptor.solo.invite.dismissed";

/** The call itself: what the feature does, and what it costs to try. */
export const SOLO_INVITE_TEXT =
  "Keep only your voice: Solo learns it from twenty seconds of speech.";

export interface SoloInviteState {
  /** Nothing is learned yet and the feature can actually be turned on. */
  invite: boolean;
  /** A press already answered the call. */
  dismissed: boolean;
}

export function soloInviteShows(state: SoloInviteState): boolean {
  return state.invite && !state.dismissed;
}

/** Only the exact stored value counts: anything else is "not yet answered". */
export function readSoloInviteDismissed(store: Pick<Storage, "getItem"> | null): boolean {
  if (!store) return false;
  try {
    return store.getItem(SOLO_INVITE_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberSoloInviteDismissed(store: Pick<Storage, "setItem"> | null): void {
  if (!store) return;
  try {
    store.setItem(SOLO_INVITE_KEY, "1");
  } catch {
    // A full or private-mode storage costs the user one repeated call, and
    // nothing else: the press itself still works.
  }
}

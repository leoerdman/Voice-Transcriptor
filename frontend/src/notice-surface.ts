/**
 * Where a session notice is shown.
 *
 * The notice banner (`#recordSessionNotice`) lives inside the Live view,
 * and `switchView` hides whole views. A notice raised while Settings or
 * History is on screen — "that shortcut is already bound", "settings
 * were not saved", the recovery summary at start — went into a hidden
 * banner and expired (6–9 s) before the user came back to Live. The
 * delete-all handler learned this once and switched to the status pill;
 * the other callers kept writing to the invisible banner.
 *
 * The rule, in one place: the banner always gets the message (it is
 * still there if the user returns before it expires), and when the Live
 * view is not the one on screen the status pill — visible from every
 * view — gets it too.
 */

export type NoticeView = "record" | "upload" | "recordings" | "settings";

export interface NoticeSurfaces {
  banner: boolean;
  status: boolean;
}

export function noticeSurfaces(visibleView: NoticeView | null): NoticeSurfaces {
  return { banner: true, status: visibleView !== "record" };
}

/**
 * Where a failure of a History action (Refresh) is shown.
 *
 * Never in the transcript body: `#recordingContent` is what Copy copies,
 * and `openRecording` already moved its own failure out of it because
 * "Could not open this recording…" ended up on the user's clipboard as
 * if it were their transcript. Refresh kept writing there, over the
 * transcript the user had open. The status pill always reports it; the
 * viewer's placeholder does only when nothing is open (the open
 * transcript is still valid — the file is on disk).
 */
export interface HistoryFailureSurfaces {
  status: boolean;
  placeholder: boolean;
  body: boolean;
}

export function historyFailureSurfaces(hasOpenRecording: boolean): HistoryFailureSurfaces {
  return { status: true, placeholder: !hasOpenRecording, body: false };
}

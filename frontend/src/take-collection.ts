/**
 * Which History collection a live take belongs to — decided in one place
 * for every path that files it: the live socket, the stop's save, the
 * crash-time draft and its recovery, and the promotion of an audio spool.
 *
 * The draft paths used to send the `live` literal whatever the take was
 * (FL-12 / S-01), so a screen take recovered after a crash was filed under
 * Live Capsule without its screenshots; and a screen take whose screen
 * session never started stayed a "screen" take, filed under Screen
 * Sessions — whose retention keeps far fewer recordings' audio — with no
 * screenshots at all (S-04).
 */

export const RECORDING_COLLECTIONS = {
  live: "live",
  uploads: "uploads",
  // Screen-mode takes (drawing + screenshots); the backend keeps the
  // audio of the newest few (its retention setting, not a number here).
  screen: "screen",
} as const;
export type RecordingCollection = typeof RECORDING_COLLECTIONS[keyof typeof RECORDING_COLLECTIONS];

/**
 * What the current take is: an ordinary voice recording, or a screen-mode
 * one (started by its own hotkey; main owns the overlays and screenshots
 * under the take's screen session id and hands them back at stop).
 */
export type LiveRecordingMode = "voice" | "screen";

export interface LiveTake {
  mode: LiveRecordingMode;
  screenSessionId: string;
}

export const VOICE_TAKE: LiveTake = Object.freeze({ mode: "voice", screenSessionId: "" });

/** The take a start request describes: a screen take needs its session id. */
export function liveTakeFromRequest(request: { mode?: string; screenSessionId?: string } = {}): LiveTake {
  const id = String(request.screenSessionId || "");
  return request.mode === "screen" && id ? { mode: "screen", screenSessionId: id } : VOICE_TAKE;
}

export function liveRecordingCollection(mode: LiveRecordingMode): RecordingCollection {
  return mode === "screen" ? RECORDING_COLLECTIONS.screen : RECORDING_COLLECTIONS.live;
}

/**
 * Main says the screen session `screenSessionId` could not start: the take
 * goes on as a voice take. A notice for any other take — one that already
 * stopped, or a newer one — changes nothing.
 */
export function liveTakeAfterVoiceTakeNotice(take: LiveTake, screenSessionId: string): LiveTake {
  return take.mode === "screen" && !!screenSessionId && take.screenSessionId === screenSessionId ? VOICE_TAKE : take;
}

/**
 * The collection a STOPPED take is saved under. A screen take is a Screen
 * Sessions recording only if its screen session actually produced a
 * manifest: a take stopped before its session started (the controller's
 * ENDED answer), or whose session failed, has no screenshots and no
 * marks — it is a voice take, kept under Live's retention rather than
 * Screen Sessions' keep-few (D3 residue).
 */
export function stoppedTakeCollection(mode: LiveRecordingMode, screenManifest: unknown): RecordingCollection {
  return liveRecordingCollection(mode === "screen" && screenManifest ? "screen" : "voice");
}

/** The live-socket control message type for a changed take (contracts/live-socket.json). */
export const LIVE_TAKE_CONTROL_TYPE = "take";

/**
 * What the renderer tells the live socket when the take changed after it
 * opened, so the backend re-files the take's recovery sidecar — a crash
 * after a screen take was demoted must recover it under Live.
 */
export function liveTakeUpdateMessage(take: LiveTake): { type: typeof LIVE_TAKE_CONTROL_TYPE; recording_collection: RecordingCollection } {
  return { type: LIVE_TAKE_CONTROL_TYPE, recording_collection: liveRecordingCollection(take.mode) };
}

/**
 * The collection a crash-time draft was written for. A draft from before
 * the draft carried it, or with a value this build does not know, is a
 * Live take — what every draft was filed as until now.
 */
export function recordingCollectionFromDraft(value: unknown): RecordingCollection {
  const known = Object.values(RECORDING_COLLECTIONS) as string[];
  const raw = typeof value === "string" ? value.trim() : "";
  return known.includes(raw) ? raw as RecordingCollection : RECORDING_COLLECTIONS.live;
}

/**
 * The body of `POST /api/live/recoveries/{id}/promote`. No collection: the
 * recovery sidecar holds the one the live session was opened with, and the
 * backend files the take there (with its staged screenshots for a screen
 * take). A collection sent from here would override it.
 */
export function recoveryPromoteBody(archiveDir: string): { archive_dir?: string } {
  return archiveDir ? { archive_dir: archiveDir } : {};
}

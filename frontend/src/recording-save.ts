/**
 * Saving a recording's text (and audio) to the archive — the request,
 * decided once.
 *
 * `saveRecordingText` had three branches — with an audio file
 * (multipart), from a source path (JSON), text only (JSON) — that
 * restated the same nine fields and the same response parsing three
 * times, and only the multipart branch knew about screen mode. A caller
 * that passed `screenSessionId` without an audio file had it dropped
 * silently: the backend adopts a staged screen session only on
 * `save-with-audio`, and the other two branches never looked at it. That
 * combination is refused here now instead.
 */

export type RecordingSaveRoute = "save-with-audio" | "save-from-path" | "save";

export interface RecordingSaveInput {
  hasAudioFile: boolean;
  audioSourcePath: string;
  consumeAudioSourcePath: boolean;
  existingName: string;
  archiveDir: string;
  recordingCollection: string;
  requireExisting: boolean;
  title: string;
  sourceText: string;
  transcriptText: string;
  provider: string;
  model: string;
  language: string;
  liveSessionId?: string;
  screenSessionId?: string;
  screenAudioStartedAt?: number;
}

export interface RecordingSavePlan {
  route: RecordingSaveRoute;
  /** JSON body (JSON routes) or the form fields besides `file` (multipart). */
  fields: Record<string, string | boolean>;
}

export function planRecordingSave(input: RecordingSaveInput): RecordingSavePlan {
  const route: RecordingSaveRoute = input.hasAudioFile
    ? "save-with-audio"
    : input.audioSourcePath
      ? "save-from-path"
      : "save";
  if (input.screenSessionId && route !== "save-with-audio") {
    throw new Error("A screen-mode recording is saved with its audio file; the screen session cannot be attached to a text-only save.");
  }
  const common: Record<string, string | boolean> = {
    name: input.existingName,
    recording_collection: input.recordingCollection,
    require_existing: input.requireExisting,
    title: input.title,
    source_text: input.sourceText,
    transcript_text: input.transcriptText,
    provider: input.provider,
    model: input.model,
    language: input.language,
  };
  if (input.archiveDir) common.archive_dir = input.archiveDir;
  if (route === "save-from-path") {
    return {
      route,
      fields: { ...common, source_path: input.audioSourcePath, consume_source_path: input.consumeAudioSourcePath },
    };
  }
  if (route === "save") return { route, fields: common };
  // Multipart: a form field is a string and the backend's `Form("")`
  // defaults read an absent field as empty/false, so the optional fields
  // are sent only when they carry something (as this branch always did).
  const fields = { ...common };
  if (!input.existingName) delete fields.name;
  if (!input.recordingCollection) delete fields.recording_collection;
  if (!input.requireExisting) delete fields.require_existing;
  if (input.liveSessionId) fields.live_session_id = input.liveSessionId;
  if (input.screenSessionId) {
    fields.screen_session_id = input.screenSessionId;
    if (input.screenAudioStartedAt && input.screenAudioStartedAt > 0) {
      fields.screen_audio_started_at = String(input.screenAudioStartedAt);
    }
  }
  return { route, fields };
}

/** The plan's fields as multipart entries (a form field is a string). */
export function recordingSaveFormEntries(fields: Record<string, string | boolean>): Array<[string, string]> {
  return Object.entries(fields).map(([key, value]) => [key, typeof value === "boolean" ? String(value) : value]);
}

export interface RecordingSaveResult {
  name: string;
  archiveDir: string;
  /** Older recordings' audio (or screenshot folders) removed by retention on this save. */
  prunedAudioCount: number;
  screensManifest?: unknown;
}

export function parseRecordingSaveResponse(
  js: unknown,
  fallback: { name: string; archiveDir: string },
): RecordingSaveResult {
  const body = (js && typeof js === "object" ? js : {}) as {
    name?: unknown;
    archive_dir?: unknown;
    pruned_audio_count?: unknown;
    screens?: unknown;
  };
  const out: RecordingSaveResult = {
    name: String(body.name || fallback.name || "").trim(),
    archiveDir: String(body.archive_dir || fallback.archiveDir || "").trim(),
    prunedAudioCount: Math.max(0, Math.trunc(Number(body.pruned_audio_count) || 0)),
  };
  if (body.screens !== undefined && body.screens !== null) out.screensManifest = body.screens;
  return out;
}

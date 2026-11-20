/**
 * Transcription catalog + selection SSOT.
 *
 * ONE canonical structure drives every transcription-model surface in
 * the app — the Transcribe toolbar, the Upload toolbar, and the live
 * preview's derived assist model. Nothing else may derive provider
 * groups by prefix-sniffing or hardcode model lists.
 *
 * The backend /api/health model catalog owns the taxonomy
 * (`local.whisper_models`, `local.gigaam_models`,
 * `remote.deepgram.audio_models`, `remote.openrouter.audio_models`,
 * `local.engines`); this module shapes it into provider groups and owns
 * the UI↔wire mapping:
 *
 *   UI group "gigaam"  →  wire provider "local" + model "gigaam-*"
 *   UI group "local-whisper" → wire provider "local" + whisper model
 *   UI group "deepgram" / "openrouter" → wire provider + remote model
 *
 * Pure: no DOM, no state. Unit-tested in tests/transcription-catalog.test.ts
 */

export type TranscriptionGroupId =
  | "local-whisper"
  | "gigaam"
  | "deepgram"
  | "openrouter";

/**
 * A provider is always selected (FU-15, user decision 2026-11-20): the
 * Live toolbar no longer offers "None", so transcription cannot be
 * switched off by accident and there is no empty provider on the wire.
 */
export type WireProvider = "local" | "deepgram" | "openrouter";

export interface TranscriptionModelOption {
  id: string;
  label: string;
  /** Engine/package present on this machine (local groups only). */
  available: boolean;
}

export interface TranscriptionGroup {
  id: TranscriptionGroupId;
  label: string;
  models: TranscriptionModelOption[];
}

export interface TranscriptionCatalogInput {
  whisperModels: string[];
  gigaamModels: string[];
  /** engine id → installed (from /api/health local.engines). */
  engines: Record<string, boolean>;
  deepgramModels: string[];
  openrouterModels: string[];
}

const WHISPER_LABELS: Record<string, string> = {
  tiny: "Whisper Tiny",
  base: "Whisper Base",
  small: "Whisper Small",
  medium: "Whisper Medium",
  "large-v3": "Whisper Large-v3",
};

const GIGAAM_LABELS: Record<string, string> = {
  "gigaam-v3-e2e-rnnt": "GigaAM v3 E2E RNNT",
};

/** Human label for a model id inside a group; falls back to the id. */
export function transcriptionModelLabel(group: TranscriptionGroupId, id: string): string {
  if (group === "local-whisper") return WHISPER_LABELS[id] || `Whisper ${id}`;
  if (group === "gigaam") return GIGAAM_LABELS[id] || id;
  return id;
}

/** Build the provider groups from the backend catalog payload pieces. */
export function buildTranscriptionCatalog(
  input: TranscriptionCatalogInput,
): TranscriptionGroup[] {
  const whisperAvailable = input.engines.whisper !== false;
  const gigaamAvailable = input.engines.gigaam === true;
  return [
    {
      id: "local-whisper",
      label: "Local Whisper",
      models: input.whisperModels.map((id) => ({
        id,
        label: transcriptionModelLabel("local-whisper", id),
        available: whisperAvailable,
      })),
    },
    {
      id: "gigaam",
      label: "GigaAM (Russian)",
      models: input.gigaamModels.map((id) => ({
        id,
        label: transcriptionModelLabel("gigaam", id),
        available: gigaamAvailable,
      })),
    },
    {
      id: "deepgram",
      label: "Deepgram",
      models: input.deepgramModels.map((id) => ({
        id,
        label: id,
        available: true,
      })),
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      models: input.openrouterModels.map((id) => ({
        id,
        label: id,
        available: true,
      })),
    },
  ];
}

/** Wire provider a UI group transcribes through. */
export function wireProviderForGroup(group: TranscriptionGroupId): WireProvider {
  if (group === "deepgram") return "deepgram";
  if (group === "openrouter") return "openrouter";
  return "local";
}

/** Map a persisted wire selection back to its UI group. */
export function groupFromWire(
  provider: string,
  model: string,
): TranscriptionGroupId {
  const p = String(provider || "").trim();
  if (p === "deepgram") return "deepgram";
  if (p === "openrouter") return "openrouter";
  if (p === "local") {
    return String(model || "").startsWith("gigaam-") ? "gigaam" : "local-whisper";
  }
  return "local-whisper";
}

export function isLocalGroup(group: TranscriptionGroupId): boolean {
  return group === "local-whisper" || group === "gigaam";
}

/**
 * The model a group falls back to when nothing has been chosen in it.
 *
 * There must be exactly one answer to this. The selector rendered
 * `group.models[0]?.id` while the reader of the selection fell back to
 * the global default model, so switching the group to GigaAM showed a
 * GigaAM model and ran Whisper `small` — the user picked one engine and
 * another one transcribed. Both sides now ask this function.
 *
 * Prefers an available model: an engine whose package is not installed
 * cannot be the implicit choice, and offering it silently would move the
 * same failure one step later.
 */
export function defaultModelForGroup(
  groups: ReadonlyArray<TranscriptionGroup>,
  group: TranscriptionGroupId,
): string {
  const models = groups.find((g) => g.id === group)?.models || [];
  return (models.find((m) => m.available) || models[0])?.id || "";
}

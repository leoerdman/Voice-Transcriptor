import "./styles.css";
import {
  MicHealthTracker,
  describeMicHealth,
  type MicHealthSnapshot,
  type MicHealthState,
} from "./mic-health";
import {
  createCaptureLevel,
  observeCaptureFrame,
  summarizeCaptureLevel,
} from "./audio-levels";
import { decideLiveTranscriptAdoption } from "./live-coverage";
import {
  describeLiveFinalStats,
  parseLiveFinalEnvelope,
  type LiveFinalEnvelopeFields as LiveFinalEnvelopeBody,
  type LiveFinalStats,
} from "./live-envelope";
import {
  computeEnvelopeDeadlineMs,
  envelopeMissing,
  envelopeTranscript,
  type FinalizeBudgetAnnouncement,
  type StopTranscriptSource,
} from "./envelope-deadline";
import {
  captureElapsedMs,
  decidePreRoll,
  decideWarmHold,
  decideWarmReuse,
  freezeCaptureForStop,
  handOverHeldCapture,
  type WarmHoldLifecycleRelease,
} from "./capture-warm";
import {
  dualStreamTradeOffText,
  resolveDualStreamPreference,
  type DualStreamDefaults,
} from "./deepgram-dual";
import { UI_COPY, applyStaticUiCopy, renderAcceptedFormatsHint, resultPaneTitle } from "./ui-copy";
import { flashButtonFeedback } from "./button-feedback";
import { acceleratorToDisplayTokens } from "./shortcut-display";
// D-015: the ONE retired-shortcut-pair rule, shared with desktop/main.js
// rather than re-derived here. See the module's own docstring for why —
// two hand-written copies of "this stored pair is retired" drifted when
// a third migration was added to one side and not the other, so on
// Windows the main process registered the migrated accelerator while
// Settings kept displaying the retired one. Pure CommonJS, zero Node
// dependencies (no `require`, no `fs`), so it is exactly as safe to
// bundle into the renderer as ``shortcut-defaults.json``'s data already
// is (see ``__SHORTCUT_DEFAULTS__`` below).
import { migrateShortcutPair } from "../../desktop/shortcut-migration.js";
import { createGatedPoll, type GatedPoll } from "./gated-poll";
import {
  explainNetworkError,
  installErrorAwareConsole,
  isGenericFetchFailure,
} from "./error-text";
import {
  RECORDINGS_WINDOW_MINIMUM,
  grownWindowSize,
  resolveWindowSize,
  shouldGrowWindow,
  shouldResetWindowAfterLoad,
  windowStatusText,
} from "./list-window";
import { reconcileRecordingsList } from "./recordings-list-reconciler";
import { livePaneDisplayText } from "./live-pane";
import {
  buildTranscriptionCatalog,
  groupFromWire,
  defaultModelForGroup,
  isLocalGroup,
  wireProviderForGroup,
  type TranscriptionGroupId,
  type TranscriptionGroup,
  type WireProvider,
} from "./transcription-catalog";
import {
  countWords,
  normalizeTranscriptWhitespace,
} from "./text-match";
import {
  composeLivePreviewText,
  joinTranscriptSegments,
  richerTranscript,
} from "./transcript-merge";
import { mergeInterim } from "./live-source";
import { checkForUpdate, shouldAutoCheck } from "./update-check";
import { mayAutosaveUiPreferences } from "./settings-autosave";
import {
  CLI_ACCESS_OFF,
  cliSectionView,
  normalizeCliStatus,
  type CliAccessStatus,
} from "./cli-section";
import { smartRecordingTitle } from "./recording-title";
import {
  UPLOAD_QUEUE_RESTORE_FAILED_STATUS,
  decideUploadQueueRestore,
  shouldDropLegacyUploadQueueSnapshot,
} from "./upload-queue-restore";

declare global {
  interface Window {
    __transcriptorMicHealth?: { get(): MicHealthSnapshot };
  }
}

/**
 * The provider a transcription is sent to, in the shape the wire uses.
 *
 * Declared once, by the catalogue that also maps UI groups onto it —
 * ``WireProvider`` was exported there and imported by nobody while this
 * file declared the same four members again and bridged the two with a
 * cast at every boundary.
 */
type Provider = WireProvider;
/**
 * A provider that is not on this machine.
 *
 * There is no second concept here: a remote provider is exactly a
 * provider that needs an API key, which is why ``RemoteProvider`` and
 * ``RemoteProvider`` were byte-identical unions used as the key of two
 * different ``Record``s. One name, so a fourth provider cannot be added
 * to one of them and not the other.
 */
type RemoteProvider = Exclude<Provider, "local" | "">;
// Installed before any of THIS module's code can throw or log, which is
// where startup failures actually happen — a failure during startup is
// exactly the one you cannot reproduce, and it must not be recorded as
// "[object DOMException]". It cannot be earlier than this: in an ES
// module the importing body runs after every import has been evaluated.
// That is harmless here because all twenty of them are pure.
installErrorAwareConsole(console);

type ViewName = "upload" | "record" | "recordings" | "settings";

/**
 * SSOT for "is this pane on screen right now?".
 *
 * `switchView` toggles `.view[data-view=…]`'s `hidden` attribute, so the
 * DOM is the authority — a mirrored `currentView` variable would be a
 * second copy that can drift. Every background poll gates on this
 * rather than re-querying the DOM its own way.
 */
function isViewVisible(view: ViewName): boolean {
  const node = document.querySelector<HTMLElement>(`.view[data-view="${view}"]`);
  return !!node && !node.hidden;
}

/** True when the renderer window is actually being displayed. */
function rendererIsVisible(): boolean {
  return document.visibilityState !== "hidden";
}

/**
 * Re-evaluate every gated poll.
 *
 * Called from the two things that move a gate — a view switch and a
 * window visibility change — so no caller has to know which polls exist
 * or what each one cares about.
 */
const gatedPolls: GatedPoll[] = [];

function syncGatedPolls(): void {
  for (const poll of gatedPolls) poll.sync();
}

/**
 * Stop every registered poll.
 *
 * Teardown used to be written per instance, beside each poll, so the
 * registry that exists precisely to spare callers that knowledge was
 * used for ``sync`` and not for ``stop`` — and the one poll whose
 * author did not write the boilerplate (``local-models``) simply kept
 * running after ``pagehide``, through Electron reloads and dev hot
 * reloads. One listener, over the registry, at the bottom of this file.
 */
function stopGatedPolls(): void {
  for (const poll of gatedPolls) poll.stop();
}

type UiTone = "neutral" | "info" | "success" | "warning" | "error";

interface NetworkStatusResponse {
  online: boolean;
  latency_ms: number | null;
  backend_ok?: boolean;
}

interface AppConfig {
  providers?: {
    openrouter?: { key?: string };
    deepgram?: { key?: string };
  };
  _meta?: {
    config_path?: string;
  };
  preferences?: {
    remote_provider?: string;
    recordings_dir?: string;
    openrouter?: { model?: string };
    // Deepgram Nova-3 Keyterm Prompting (BUGS_AUDIT_2026-09-03.md §1):
    // a single raw string exactly as the user typed it (comma- or
    // newline-separated) — the backend owns normalisation into the
    // Deepgram ``keyterm`` query params. The frontend never parses it.
    //
    // ``dual_stream`` / ``dual_secondary_language`` are the dual-stream
    // Auto contract: two Nova-3 streams (multi + one fixed language)
    // merged by word timestamps, which on 2026-09-04 closed both
    // language-switch holes of the trilingual recording at twice the
    // Deepgram minutes. Raw here too — the backend validates them, and
    // they only apply while the live language is Auto. Absent means the
    // documented defaults (on, "ru"), never "off": a config written by
    // an older build must not silently disable a feature the backend
    // has on by default.
    deepgram?: {
      keyterms?: string;
      dual_stream?: boolean;
      dual_secondary_language?: string;
    };
    ui?: {
      provider?: string;
      language?: string;
      local_model?: string;
      mic_id?: string;
      auto_transcribe?: boolean;
      live_preview?: boolean;
      upscale_enabled?: boolean;
      upscale_preset?: string;
      upscale_model?: string;
      auto_send_enter?: boolean;
      auto_stop_silence_enabled?: boolean;
      auto_stop_silence_seconds?: number;
      auto_stop_silence_db?: number;
      remote_model_openrouter?: string;
      remote_model_deepgram?: string;
      shortcut_record?: string;
      shortcut_paste?: string;
      /**
       * Live-tab speaker diarization. Its two neighbours in the same
       * popover (``auto_transcribe``, ``live_preview``) have always been
       * persisted and its Upload twin (``upload_diarize``) has too; this
       * one alone reset to the markup default on every launch.
       */
      diarize?: boolean;
      // Upload tab persistent state — provider/language/diarize were
      // previously DOM-only and reset to defaults on every app launch.
      // Mirrored into the same ``preferences.ui`` namespace as the
      // Live tab keys (``provider``, ``language``) — separate keys so
      // the two tabs don't fight over the same value.
      provider_group?: string;
      upload_language?: string;
      upload_diarize?: boolean;
    };
  };
}

interface RecordingItem {
  name: string;
  display_name: string;
  source_file?: string;
  archive_dir?: string;
  recording_collection?: string;
  modified_at: string;
  size_bytes: number;
  provider: string;
  language: string;
  has_audio?: boolean;
  audio_name?: string;
  audio_size_bytes?: number;
  audio_mime?: string;
}

interface RecordingsStats {
  total_recordings: number;
  total_words: number;
  total_chars: number;
  avg_words_per_recording: number;
  avg_chars_per_recording: number;
  avg_duration_sec: number;
  min_duration_sec: number;
  max_duration_sec: number;
  top_words: Array<{ word: string; count: number }>;
  providers: Array<{ name: string; count: number }>;
  languages: Array<{ name: string; count: number }>;
}

interface UpscalePresetItem {
  id: string;
  name: string;
  builtin: boolean;
  instruction?: string;
  default_instruction?: string;
}

interface FinishedRecordingEntry {
  recordingId: number;
  finishedAt: number;
  text: string;
}

/**
 * Canonical live recording session state — single source of truth.
 *
 * Every field listed here is either rendered to the UI (see
 * ``renderCurrentRecordingSummary``) or consumed by a reconcile /
 * conflict-detection path. Fields that had no consumer were removed in
 * the SSOT cleanup (provider/model/language/durationSec/audioBytes/
 * transcriptChars/transcriptWords/recovered) — they used to be written
 * to a now-deleted context strip and were ghost state.
 */
interface CurrentRecordingSummary {
  /** Short human title derived from the live draft. Rendered indirectly
   *  via ``setStatus`` chips that prefer status over title. */
  title: string;
  /** User-visible status line. Rendered via ``setStatus`` on every
   *  update and into the session notice banner when tone escalates. */
  status: string;
  /** Drives the notice banner tone and persisted status severity. */
  tone: UiTone;
  /** Wall-clock milliseconds from stop → transcript-ready. Rendered
   *  into the ``transcribeLatency`` pill on every update. */
  transcribeLatencyMs?: number;
  /** Name of the persisted file inside the archive. The reconcile
   *  helper reads this to catch the case where the archive has been
   *  mutated outside the app. */
  savedName?: string;
}

type StatusKind = "idle" | "recording" | "processing" | "done" | "error" | "warning" | "info";

interface LatestSavedAudioState {
  savedName?: string;
  archiveDir?: string;
  title: string;
  sizeBytes?: number;
  downloadName?: string;
  mimeType?: string;
  file?: File | null;
}

interface SavedRecordingRef {
  name: string;
  archiveDir: string;
}

interface LoadRecordingsOptions {
  keepSelection: boolean;
  background?: boolean;
  reopenSelected?: boolean;
}

interface OpenRecordingOptions {
  silent?: boolean;
}

const RECORDING_COLLECTIONS = {
  live: "live",
  uploads: "uploads",
} as const;
type RecordingCollection = typeof RECORDING_COLLECTIONS[keyof typeof RECORDING_COLLECTIONS];

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Deepgram diarization index when enabled. undefined otherwise. */
  speaker?: number;
}

interface LocalTranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  durationSec: number;
  audioSourcePath?: string;
}

interface RemoteTranscriptionResult {
  text: string;
  provider: string;
  model?: string;
  durationSec?: number;
  audioSourcePath?: string;
}

interface BackendJobCreated {
  job_id: string;
  audio_source_path?: string;
  audioSourcePath?: string;
}

interface BackendJobState<T> {
  job_id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  error?: string | null;
  result?: T | null;
}

interface LiveSessionSnapshot {
  provider: Provider;
  effectiveProvider: Provider;
  model: string;
  language: string;
  /**
   * Speaker diarization as it was at the START, snapshotted like the
   * language and the model beside it.
   *
   * The recovery and final passes used to re-read the checkbox at the
   * moment they ran, so a user who toggled it mid-recording had the
   * live stream transcribed with one setting and the recovery pass with
   * the other — two readings of one recording that the stop path then
   * compares, one of them carrying speaker labels and a different
   * paragraph separator (``hasDiarization`` in ``appendSegmentsToBuffer``).
   */
  diarize: boolean;
  assistLocalModel: string;
  finalLocalModel: string;
}

type LiveWsMode = "none" | "local-assist" | "deepgram-stream";

/**
 * The stop envelope's fields, owned by ``./live-envelope`` — the
 * renderer's half of a contract whose other half is
 * ``backend/live_envelope.py``. Both halves are checked against one
 * fixture, ``contracts/live-final-envelope.json``, which the backend's
 * own builder produces.
 */
type LiveFinalEnvelopeFields = LiveFinalEnvelopeBody<TranscriptSegment>;

/** The same fields, as the stop path holds them (the ``type`` tag is gone). */
type LiveFinalEnvelope = Omit<Extract<LiveWsMessage, { type: "final" }>, "type">;

/**
 * Discriminated union of server → client messages on /ws/transcribe.
 *
 * Matches the protocol documented on the Python side in ``backend.main``
 * and ``backend.remote_deepgram_live``. The ``parseLiveWsMessage``
 * helper below is the ONLY place we cast ``unknown`` into this type —
 * every consumer should use its narrowed output.
 */
type LiveWsMessage =
  // No ``isFinal``/``speechFinal``: they were parsed from ``is_final``
  // and ``speech_final`` and read by nobody (``case "segments"`` ignored
  // them), while ``backend/live.py`` does not send them at all — so for
  // the local-assist path they were silently ``false``, a contract
  // mismatch that only stayed harmless because there was no reader.
  | { type: "segments"; segments: TranscriptSegment[] }
  | { type: "interim"; segment: TranscriptSegment }
  /**
   * The stop envelope. ``LiveFinalEnvelope`` is this branch minus its
   * ``type`` tag — the two used to be ten fields written out twice,
   * where adding a field to one of them was a silent no-op on the other.
   */
  | ({ type: "final" } & LiveFinalEnvelopeFields)
  | { type: "error"; error: string; fatal: boolean }
  /**
   * The backend's stop deadline, sent the moment it is chosen and
   * before the waiting begins. ``budgetMs`` is the worst case it may
   * spend flushing the provider; ``expectsMore`` is its coverage
   * verdict — whether that wait is expected to yield words we do not
   * already have. One number, decided where the coverage data lives.
   */
  | { type: "finalizing"; budgetMs: number; expectsMore: boolean };

function parseLiveWsMessage(raw: string): LiveWsMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const type = String(obj.type || "").trim();

  if (type === "segments") {
    const rawSegs = Array.isArray(obj.segments) ? obj.segments : [];
    const segments = rawSegs
      .map((s) => normalizeTranscriptSegment(s))
      .filter((s): s is TranscriptSegment => !!s);
    return { type: "segments", segments };
  }

  if (type === "interim") {
    const segment = normalizeTranscriptSegment(obj.segment);
    if (!segment) return null;
    return { type: "interim", segment };
  }

  if (type === "finalizing") {
    const budgetMs = Number(obj.budgetMs);
    return {
      type: "finalizing",
      budgetMs: Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0,
      expectsMore: !!obj.expectsMore,
    };
  }

  if (type === "final") {
    // One shape, read in one place (B-038). ``./live-envelope`` mirrors
    // ``backend/live_envelope.py`` field for field and both are checked
    // against the same committed fixture, so a backend that starts
    // sending a different envelope fails a test rather than quietly
    // handing the user a shorter transcript.
    return {
      type: "final",
      ...parseLiveFinalEnvelope(obj, normalizeTranscriptSegment),
    };
  }

  if (type === "error") {
    return {
      type: "error",
      error: String(obj.error || "live stream error"),
      fatal: !!obj.fatal,
    };
  }

  return null;
}

type RecordingFinalSignalKind = "" | "transcript" | "status" | "error";
type AutoStopSilenceConfig = { enabled: boolean; seconds: number; thresholdDb: number };
type LiveStatusSnapshot = {
  status: string;
  statusKind: StatusKind;
  timerText: string;
  busy: boolean;
  recording: boolean;
  recordingId: number;
  autoSendEnter: boolean;
  autoStopSilence: AutoStopSilenceConfig;
};
type ShortcutBridgeAction = "capture-start" | "capture-cancel" | "update";
type ShortcutPair = { record: string; paste: string };
type ShortcutDefaultsManifest = {
  platformDefaults: {
    darwin: ShortcutPair;
    default: ShortcutPair;
  };
  legacy: {
    unpressablePaste: string;
    macFunctionPair: ShortcutPair;
  };
};

type ModelCatalogPayload = {
  local?: {
    models?: unknown;
    whisper_models?: unknown;
    gigaam_models?: unknown;
    default_model?: unknown;
    live_assist_models?: unknown;
    live_preview_models?: unknown;
    default_live_preview_model?: unknown;
    engines?: Record<string, unknown>;
  };
  remote?: {
    openrouter?: { audio_models?: unknown; default_audio_model?: unknown };
    deepgram?: { audio_models?: unknown; default_audio_model?: unknown };
  };
  upscale?: { openrouter_models?: unknown; default_model?: unknown };
};

type BackendLiveDefaultsPayload = {
  languages?: unknown;
  dual_stream?: unknown;
  dual_secondary_language?: unknown;
  dual_secondary_languages?: unknown;
  keyterm_token_budget?: unknown;
};

type BackendBootstrapPayload = {
  max_upload_bytes?: unknown;
  accepted_audio_exts?: unknown;
  audio_ext_to_mime?: unknown;
  live_sample_rate_hz?: unknown;
  live_defaults?: BackendLiveDefaultsPayload;
  model_catalog?: ModelCatalogPayload;
  runtime_limits?: {
    upload_queue_max_parallel?: unknown;
    upload_queue_max_persisted_items?: unknown;
  };
};

/**
 * What the backend says its live path defaults to. ``null`` until the
 * bootstrap payload lands.
 *
 * The renderer has no opinion of its own here (B-027 / R-016): these two
 * values used to be declared in ``deepgram-dual.ts`` as a third copy of
 * ``backend/model_catalog.py``, and because the renderer's resolution of
 * an absent preference is what the next autosave persists, a copy that
 * disagreed with the backend would rewrite the backend's own default on
 * disk. ``null`` here means "not known", and nothing writes a
 * not-known value — see ``buildUiPreferencesSavePlan``.
 */
let backendLiveDefaults: DualStreamDefaults | null = null;

// Compile-time injected by vite.config.ts from desktop/package.json's
// ``version`` field. SSOT for the version label rendered in the
// Settings tab — previously hardcoded ``1.1.1`` in index.html and
// drifted across every release.
declare const __APP_VERSION__: string;
/** Injected from desktop/package.json (version + repository.url) — see vite.config.ts. */
declare const __APP_UPDATE_META__: { version: string; repoSlug: string };
declare const __SHORTCUT_DEFAULTS__: ShortcutDefaultsManifest;

declare global {
  interface Window {
    __TRANSCRIPTOR_API_TOKEN?: string;
    __TRANSCRIPTOR_BOOTSTRAP?: BackendBootstrapPayload;
    __transcriptorVuLevel?: number;
    __transcriptorRmsLevel?: number;
    __transcriptorLastFrameAt?: number;
    __transcriptorIsRecording?: boolean;
    __transcriptorLastFinishedText?: string;
    __transcriptorLastFinishedAt?: number;
    __transcriptorCurrentRecordingId?: number;
    __transcriptorLastFinishedRecordingId?: number;
    __transcriptorFinishedRecords?: FinishedRecordingEntry[];
    __transcriptorLastUiFinalText?: string;
    __transcriptorLastUiFinalAt?: number;
    __transcriptorLastUiFinalRecordingId?: number;
    __transcriptorLastUiFinalKind?: RecordingFinalSignalKind;
    __transcriptorLiveStatusSnapshot?: () => LiveStatusSnapshot;
    __transcriptorRecordingTooShort?: () => boolean;
    __transcriptorSetMainStatus?: (status: string, kind?: StatusKind) => boolean;
    __transcriptorShortcutStatus?: {
      record?: { active?: string; desired?: string; error?: string };
      paste?: { active?: string; desired?: string; error?: string };
      macFnState?: boolean | null;
      platform?: string;
    };
    __setBackendBootStatus?: (msg: string) => void;
    __setBackendBootError?: (msg: string) => void;
    /**
     * Open the OS file manager (Finder / Explorer / Files) at the
     * transcript file matching the given recording. Implemented by setting
     * ``document.title`` to a known prefix; the Electron main process
     * intercepts via ``page-title-updated`` and calls
     * ``shell.showItemInFolder``. No-op in plain-browser dev preview.
     */
    __transcriptorRevealRecording?: (name: string, archiveDir: string) => void;
    /**
     * Electron preload bridge. Returns an absolute filesystem path for
     * a File obtained from the OS picker/drag-drop, or "" in browser dev
     * preview and other unsupported contexts.
     */
    __transcriptorFilePathForFile?: (file: File) => string;
    /**
     * Engine lifecycle bridge (Electron main process). Absent in
     * browser dev preview — every consumer must feature-check.
     */
    __transcriptorEngine?: {
      getStatus: () => Promise<EngineInstallStatus>;
      install: () => Promise<EngineInstallStatus & { ok?: boolean; status?: string }>;
    };
    /**
     * Accessibility/paste-capability bridge (Electron main process,
     * D-009). Absent in browser dev preview and on non-macOS desktop
     * shells — every consumer must feature-check.
     *
     * ``state`` is one of "unknown" / "untrusted" / "active" / "broken"
     * (desktop/paste-capability.js); ``title``/``fix`` are non-empty
     * exactly when there is something the user can act on. This used to
     * reach the renderer only reactively, folded into a recording-status
     * string AFTER a paste had already failed — so a stale or missing
     * grant was invisible until a dictation silently went nowhere.
     */
    __transcriptorPasteCapability?: {
      getStatus: () => Promise<{ state: string; title: string; fix: string; repairable?: boolean }>;
      /**
       * Drop the stale TCC row and re-probe (main runs `tccutil reset`
       * for both services and answers with the new state). Offered only
       * while ``repairable`` is true.
       */
      repair: () => Promise<{ ok?: boolean; status?: string; state?: string; title?: string; fix?: string }>;
    };
    /**
     * Recording-output bridge (Electron preload → main). Absent in
     * browser dev preview — every consumer must feature-check.
     *
     * The main process used to learn that a transcript was ready by
     * injecting ``executeJavaScript`` into this renderer every 30 ms for
     * up to 32 s — up to a thousand synchronous evaluations landing
     * exactly while the renderer finalizes Deepgram, runs the paste
     * upscale and serialises audio (BUGS_AUDIT_2026-09-03 §6.7). This
     * says it once, when it happens.
     *
     * ``final`` is the explicit finality flag §6.8 asked for: the same
     * recording publishes provisional text (pre-upscale, a status, an
     * error) and then, if it produces one, the paste-ready transcript.
     * Only the latter carries ``final: true``. Without the flag the
     * main process could not tell them apart and pasted whichever
     * arrived before its deadline — one recording, two possible
     * results. ``source`` is a free-form label for the main process's
     * trace log and carries the publishing phase.
     */
    transcriptor?: {
      recordingFinal?: (payload: {
        recordingId: number;
        text: string;
        final: boolean;
        source: string;
      }) => boolean;
      /**
       * "The machine is going to sleep, or the screen is locking."
       *
       * ``powerMonitor`` is a main-process API, so the main process is
       * the only one that can say this; the preload forwards it on the
       * fixed ``system-suspend`` channel (``reason`` is "suspend" or
       * "lock-screen") and returns an unsubscribe function.
       *
       * The renderer needs it for exactly one thing: a warm capture hold
       * must not survive sleep. Nothing else in the app can tell —
       * ``setTimeout`` does not run while the machine is asleep, so the
       * hold's own TTL timer cannot fire, and the OS may hand the input
       * device to something else while we are not looking.
       */
      onSystemSuspend?: (
        callback: (payload: { reason: string }) => void,
      ) => (() => void);
    };
  }
}

/** Phase of the desktop-side GigaAM engine install state machine. */
type EngineInstallPhase = "idle" | "probing" | "installing" | "done" | "failed";

interface EngineInstallStatus {
  phase: EngineInstallPhase;
  reason?: string;
  error?: string;
  startedAtMs?: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
};

const fmtTime = (s: number): string => {
  const sec = Math.max(0, Math.floor(Number(s) || 0));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
};
const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "-";
  return d.toLocaleString();
};
/**
 * Durations are formatted by the same clock as elapsed time. These were
 * two byte-identical implementations under two names, which is two
 * places for `mm:ss` to become something else.
 */
const fmtDur = fmtTime;
/**
 * What both player time labels read before any audio is attached.
 *
 * Typed out as "0:00" in two elements of the markup and two assignments
 * in the reset path — a fifth format, in a build where the clock says
 * ``00:00``.
 */
const PLAYER_TIME_ZERO = fmtTime(0);
const fmtMs = (ms: number): string => {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
};
const fmtBytes = (bytes: number): string => {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 ** 3) {
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(value / 1024 ** 3).toFixed(value < 10 * 1024 ** 3 ? 1 : 0)} GB`;
};

type AppearanceMediaBinding = {
  query: string;
  className: string;
  dataKey: string;
  enabledValue: string;
  disabledValue: string;
};

function installAppearanceStateClasses(): void {
  const root = document.documentElement;
  const bindings: AppearanceMediaBinding[] = [
    {
      query: "(prefers-reduced-transparency: reduce)",
      className: "reduce-transparency",
      dataKey: "reduceTransparency",
      enabledValue: "reduce",
      disabledValue: "no-preference",
    },
    {
      query: "(prefers-contrast: more)",
      className: "increased-contrast",
      dataKey: "contrast",
      enabledValue: "more",
      disabledValue: "no-preference",
    },
    {
      query: "(prefers-reduced-motion: reduce)",
      className: "reduce-motion",
      dataKey: "reduceMotion",
      enabledValue: "reduce",
      disabledValue: "no-preference",
    },
    {
      query: "(forced-colors: active)",
      className: "forced-colors",
      dataKey: "forcedColors",
      enabledValue: "active",
      disabledValue: "none",
    },
  ];
  const media = bindings.map((binding) => ({
    binding,
    mql: window.matchMedia(binding.query),
  }));
  const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
  const lightScheme = window.matchMedia("(prefers-color-scheme: light)");
  const cleanupFns: Array<() => void> = [];

  const apply = () => {
    for (const { binding, mql } of media) {
      const enabled = !!mql.matches;
      root.classList.toggle(binding.className, enabled);
      root.dataset[binding.dataKey] = enabled ? binding.enabledValue : binding.disabledValue;
    }
    const scheme = darkScheme.matches ? "dark" : (lightScheme.matches ? "light" : "no-preference");
    root.classList.toggle("scheme-dark", scheme === "dark");
    root.classList.toggle("scheme-light", scheme === "light");
    root.dataset.colorScheme = scheme;
  };

  const bindMedia = (mql: MediaQueryList) => {
    const listener = () => apply();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", listener);
      cleanupFns.push(() => mql.removeEventListener("change", listener));
      return;
    }
    const legacy = mql as MediaQueryList & {
      addListener?: (listener: () => void) => void;
      removeListener?: (listener: () => void) => void;
    };
    legacy.addListener?.(listener);
    cleanupFns.push(() => legacy.removeListener?.(listener));
  };

  for (const { mql } of media) bindMedia(mql);
  bindMedia(darkScheme);
  bindMedia(lightScheme);
  apply();
  window.addEventListener("pagehide", () => {
    for (const cleanup of cleanupFns.splice(0)) cleanup();
  }, { once: true });
}

installAppearanceStateClasses();

/**
 * The renderer → main-process bridge that rides on ``document.title``.
 *
 * Electron's ``page-title-updated`` is the one channel available to a
 * renderer that has no preload IPC for these three messages: the main
 * process reads the sentinel and ``preventDefault()``s the real title
 * change. The idiom — save the title, write the sentinel, restore on the
 * next tick — was copied three times with four literals spread over two
 * processes, and two messages posted in one tick made the second capture
 * the FIRST one's sentinel as the title to restore, leaving it on the
 * document for main.js to read a second time.
 *
 * ``desktop/main.js`` holds the same three prefixes; the two sides are
 * pinned by ``tests/renderer-main-contract.test.ts``.
 */
const TITLE_BRIDGE_PREFIX = {
  shortcuts: "__app_shortcuts__",
  recordToggle: "__app_record_toggle__",
  revealRecording: "__app_reveal_recording__",
} as const;

/** The real document title, saved before the first sentinel of a burst. */
let titleBridgeRestore = "";
let titleBridgeRestoreTimer = 0;

function postTitleBridgeMessage(prefix: string, payload = ""): void {
  if (!titleBridgeRestoreTimer) {
    titleBridgeRestore = document.title;
  }
  document.title = prefix + payload;
  // main.js consumes the sentinel through page-title-updated and
  // preventDefault()s the real title change. Restored defensively for
  // browser dev preview and any future non-Electron surface — and once
  // per burst, from the title that was there before the burst began.
  window.clearTimeout(titleBridgeRestoreTimer);
  titleBridgeRestoreTimer = window.setTimeout(() => {
    titleBridgeRestoreTimer = 0;
    document.title = titleBridgeRestore || "Transcriptor";
  }, 0);
}

const wsBase = (): string => (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host;
// Backend-owned; injected in window.__TRANSCRIPTOR_BOOTSTRAP and refreshed
// through /api/health. Until it arrives, the renderer falls back to the
// last value the backend ever reported (cached in localStorage below) so
// the client-side size check works from the first cold-start frame
// instead of silently skipping validation until hydration lands
// (BUG-03). The cached value is a cache with explicit provenance, not a
// second source of truth: the backend cap always wins once known.
const UPLOAD_CAP_CACHE_KEY = "transcriptor.uploadCapBytes.v1";
let MAX_FILE_BYTES = (() => {
  try {
    const cached = Number(localStorage.getItem(UPLOAD_CAP_CACHE_KEY));
    return Number.isFinite(cached) && cached > 0 ? Math.trunc(cached) : 0;
  } catch {
    return 0;
  }
})();
// SSOT: backend/main.py exposes backend.audio_constants.LIVE_SAMPLE_RATE_HZ
// through bootstrap and /api/health. This fallback is only for dev shells
// that load the renderer without backend-injected bootstrap.
let LIVE_SAMPLE_RATE_HZ = 16_000;
const UI_TOKENS = {
  polling: {
    remoteChunkSettleTimeoutMs: 3_000,
  },
  draft: {
    autosaveIntervalMs: 1_200,
  },
  timer: {
    tickMs: 200,
  },
  network: {
    refreshIntervalMs: 10_000,
  },
  settings: {
    saveDebounceMs: 260,
  },
  /**
   * How long a button shows that it did the thing.
   *
   * One number, because it is one gesture: the two Copy buttons of
   * History and the Result pane flashed for 900 ms through
   * ``flashButtonFeedback`` while Upload's own Copy swapped its label
   * for 1200 ms — two mechanics and two durations for one feedback.
   */
  feedback: {
    flashMs: 900,
  },
  /**
   * The session notice's life, as a three-step scale rather than four
   * literals sprinkled through the file (6000, 7000, 7000 again as an
   * argument that repeated the default, 9000).
   *
   * The steps differ by how much the user has to do about the message:
   * a confirmation of something they just asked for is read at a
   * glance; the default suits a sentence; something that happened
   * without them asking — a recovered draft, a failed startup — has to
   * survive them looking back at the screen.
   */
  notice: {
    briefMs: 6_000,
    defaultMs: 7_000,
    longMs: 9_000,
  },
  /**
   * History. The one sub-area of the UI that had no entry here at all,
   * so its timings lived as bare literals inside the functions that
   * used them and its two debounce steps could not be compared.
   */
  recordings: {
    /** Longest wait for a <audio> element to report itself playable. */
    viewerAudioReadyTimeoutMs: 1_500,
    /** Cap on the first archive read, after which the view opens empty. */
    bootstrapTimeoutMs: 15_000,
    /** Coalescing window after a save, before the archive is re-read. */
    deferredRefreshMs: 160,
    /** Retry step while a recording or a stop is still in progress. */
    deferredRefreshBusyRetryMs: 220,
    /** Retry step when a refresh arrived while one was running. */
    deferredRefreshCoalesceMs: 120,
    /** How many chips the stats panel shows before it stops. */
    statsTopProviders: 10,
    statsTopLanguages: 8,
  },
  upload: {
    /** Debounce on the queue snapshot PUT. */
    queueSaveDebounceMs: 180,
    /** Cap on the file name in the result pane's title. */
    resultTitleMaxChars: 60,
    /**
     * Provider a queue item falls back to when the stored one is
     * unreadable. Was written out at the fallback and again at two of
     * its three callers.
     */
    defaultProvider: "deepgram",
  },
  upscale: {
    livePasteReadyTimeoutMs: 3_000,
  },
  capture: {
    /**
     * Start the ScriptProcessor fallback ALONGSIDE the worklet, held
     * back, instead of waiting to find out whether the worklet works.
     *
     * The watchdog this replaces armed nothing for 1.3 s and only then
     * asked whether any frame had arrived: on the one host where it
     * fired (2026-08-31 21:12) the first 1.3 s of the recording did not
     * exist, and for a moment both capture paths were connected and
     * every sample was captured twice (BUGS_AUDIT_2026-09-03 §4.5). The
     * pre-armed fallback buffers from the first buffer period and
     * commits only if the worklet has produced nothing by then; the
     * worklet's first frame disposes of it. Exactly one path is ever
     * committed, and neither window exists.
     *
     * Off: the fallback is only constructed when the worklet cannot be,
     * and a worklet that connects but never delivers is left to the
     * pipeline failsafe. A kill switch, not a second behaviour.
     */
    preArmScriptProcessorFallback: true,
    vuAmplify: 4,
    /**
     * How long the capture graph — MediaStream, AudioContext, capture
     * worklet — stays alive after Stop, waiting for the next press.
     *
     * A cold start costs `getUserMedia: 82 ms → audioContext: 33 ms →
     * first-frame: 172 ms` (measured 2026-09-03, §4.7), and seconds when
     * the input device is busy. None of it is paid again inside this
     * window: the next start adopts the graph that is already running,
     * and the worklet has been keeping `preRollMs` of audio in a ring the
     * whole time, so the recording begins before the press instead of
     * ~310 ms after it.
     *
     * THE VISIBLE COST: the operating system's microphone indicator — the
     * orange dot on macOS, the tray icon on Windows — stays lit for these
     * 30 s after every recording, and other applications see the input as
     * in use. That is the honest price of not clipping the first word,
     * and it is bounded exactly by this number. 0 disables the hold
     * entirely and restores the pre-§4.7 behaviour (release at Stop);
     * there is deliberately no UI for it yet.
     *
     * 30 s matches Handy's "lazy stream close" option. It is long enough
     * to cover a dictate-paste-dictate cycle (the case where the clipping
     * is most noticeable, because the user is already mid-thought) and
     * short enough that a walk away from the machine ends with the
     * microphone released. Bluetooth inputs never take the hold at all —
     * see ./capture-warm.
     */
    warmHoldMs: 30_000,
    /**
     * How much audio from BEFORE the hotkey the recording starts with.
     *
     * The worklet keeps this much in a ring while the graph is held warm
     * and hands it over on the next start. 500 ms is what whisper-local
     * trims its idle deque to and sits between Hex's 450 ms pre-roll and
     * its 1 s ring; it comfortably covers the ~310 ms the cold path used
     * to lose plus the gap between deciding to speak and pressing.
     *
     * Only reachable on the warm path: a graph that has just been created
     * has no past to offer.
     */
    preRollMs: 500,
    /**
     * Oldest pre-roll sample that may still be prepended to a recording.
     *
     * While the context is rendering, the ring is rewritten every 2.7 ms
     * and its oldest sample is exactly `preRollMs` old. A ring that
     * stopped being written — suspended context, a machine that slept
     * between two presses — holds audio from some earlier minute, and
     * prepending that would put words the user did not just say at the
     * front of the transcript. Past this age the ring is dropped whole
     * and the recording simply starts at the press. Mirrors OpenWhispr's
     * `PRE_ROLL_MAX_AGE_MS`.
     */
    preRollMaxAgeMs: 2_000,
    /**
     * Shortest recording that is kept. Below it the press is treated as
     * a double-tap on the hotkey and nothing is produced at all.
     *
     * 500 ms, from the archive: across 3681 recordings the shortest are
     * 0.00 s (six of them — a second press landing before any audio
     * arrived), 0.22 s and 0.25 s, and then NOTHING until 0.55 s. The
     * floor sits inside that gap, so it discards every accident on
     * record (8 of 3681, 0.22 %) and no recording that looks like
     * speech. Eight is also the entire population it can affect.
     */
    minRecordingMs: 500,
    /**
     * How much longer the microphone stays open after Stop.
     *
     * Stop lands while the user is still finishing the last word far more
     * often than it looks: across 112 measured stops, 39 % left NO
     * trailing silence at all and 45 % left 100 ms or less. Two saved
     * recordings analysed directly end with speech at full level in the
     * final 50 ms frame — the word is not "lost in transcription", it is
     * not in the audio, and no amount of re-decoding can recover it.
     * A word also needs its release and a moment of silence before a
     * recogniser will seal it.
     *
     * Fixed, deliberately: no speech detection, no variable window. Stop
     * means stop, 200 ms later, every time.
     */
    stopTailHoldMs: 200,
    /**
     * Below this length, "the session was silent" is not a conclusion
     * worth drawing.
     *
     * A recording this short may contain no speech simply because the
     * user has not started yet, and the level summary has too few frames
     * to say anything about the room. Sits between ``minRecordingMs``
     * (the double-tap floor) and the shortest dictation worth keeping.
     */
    silenceTrustMinSec: 1.25,
    /**
     * Ceiling on the audio each fallback sink holds in memory, as a
     * recording length.
     *
     * Both fallbacks are bounded by it: the WebM container (one chunk
     * per second, so the window is a chunk count) and the in-memory PCM
     * sink used when OPFS is unavailable (a sample count — 16 kHz Int16
     * is ~32 KB/s, so two hours is ~230 MB, and it used to have no
     * bound at all while the comment beside it claimed the sink was
     * "bounded by definition"). One number, because it is one decision
     * about how much of a very long dictation a machine without a disk
     * spool can keep.
     */
    fallbackWindowSec: 60 * 120,
  },
  finalize: {
    // Tolerance for "these two segments describe the same moment" in
    // ``mergeTranscriptSegments`` below — the renderer's own dedup of
    // segments ALREADY SENT, by any provider, in its preview pane.
    //
    // NOT ``backend/live.py``'s ``LiveConfig.emit_epsilon_sec`` (0.05),
    // and deliberately not derived from it (S-06) — the two look alike
    // and are different questions, explained on that constant's own
    // comment. This one is a property of how close two providers' word
    // timestamps for the same instant can land after their own
    // rounding; the backend one is a property of Whisper's timestamps
    // across two overlapping inference passes and governs what a
    // single session EMITS, before anything reaches this renderer.
    // Tying them together would make a Whisper-only value decide how a
    // Deepgram segment pair is deduplicated on screen.
    segmentEpsilonSec: 0.08,
    /**
     * How long the stop waits for the backend's ``final`` envelope
     * after ``{type:"finalize"}`` is sent.
     *
     * Covers Deepgram's 700 ms endpointing threshold, its server-side
     * finalize (~500-1500 ms), the network round trip and the backend
     * forward. Raised 2000 → 4000 in 1.1.13 after tail-truncation
     * reports on slow cross-region links (RU → us-east): 500 ms pause
     * + 700 ms endpointing + 1500 ms finalize + 600 ms RTT is a 3300 ms
     * round trip that only barely beat the old budget, and the user's
     * last utterance was dropped from the transcript and the paste
     * whenever it did not.
     *
     * It lived as a bare ``4000`` at the call site while its three
     * neighbours below were named and argued for.
     */
    envelopeWaitMs: 4_000,
    /**
     * Recovery budgets. Named and reasoned about since they were
     * written, but they lived outside UI_TOKENS while every other stop
     * timing lived inside it, so "all the budgets of a stop" was not
     * something you could read in one place.
     *
     *   smallAudioUiMs      — Deepgram REST on a payload under
     *                         ``REMOTE_SMALL_AUDIO_BYTES``; the UI gives
     *                         up before the request does.
     *   shortEmptyRecoveryMs — an empty transcript on a short recording:
     *                         there is little audio to re-decode, so
     *                         waiting long buys nothing.
     *   defaultEmptyRecoveryMs — the same for a recording of any length.
     */
    smallAudioUiMs: 13_000,
    shortEmptyRecoveryMs: 8_000,
    defaultEmptyRecoveryMs: 20_000,
  },
  drain: {
    maxWaitMs: 450,
    pollStepMs: 30,
  },
  /**
   * Auto-stop-on-silence: one product decision — "how many seconds
   * below what level end a recording" — and one set of numbers for the
   * three layers that used to each carry their own copy (the
   * ``index.html`` input attributes, ``getAutoStopSilenceConfig``,
   * ``loadCfg``, and ``desktop/main.js``). Four copies of three numbers
   * and two ranges, with no cross-reference between them and nothing —
   * no test, no type, and no backend validation, since ``config.py``
   * has no ``ui`` branch at all — that would notice them diverging.
   *
   * 2 s: shorter cuts into an ordinary pause between phrases (the RMS
   * EMA window is ~120 ms, see the capture tokens above); longer and
   * the user concludes auto-stop is broken. −42 dBFS: between a typical
   * room floor (−55…−48) and quiet speech (−35…−28) on the 2026-09-03
   * recordings.
   *
   * The markup no longer carries these as attributes;
   * ``applyAutoStopSilenceBounds`` writes them at boot from here.
   */
  autoStopSilence: {
    defaultEnabled: false,
    defaultSeconds: 2,
    minSeconds: 1,
    maxSeconds: 120,
    defaultThresholdDb: -42,
    minThresholdDb: -80,
    maxThresholdDb: -10,
  },
} as const;
const ACCEPTED_AUDIO_VIDEO_EXTS = new Set<string>();
const LEGACY_LIVE_DRAFT_STORAGE_KEY = "transcriptor.liveDraft.v1";
const LEGACY_LIVE_DRAFT_CORRUPT_STORAGE_PREFIX = "transcriptor.liveDraft.corrupt.";
const LEGACY_UPLOAD_QUEUE_STORAGE_KEY = "transcriptor.uploadQueue.v1";
// Schema version the SERVER reported for the queue snapshot (SSOT:
// backend UPLOAD_QUEUE_STATE_VERSION); gates the legacy-localStorage read.
let uploadQueueServerVersion = 1;
const LEGACY_UPLOAD_QUEUE_CORRUPT_STORAGE_PREFIX = "transcriptor.uploadQueue.corrupt.";
/**
 * How many quarantined payloads are kept per prefix.
 *
 * A snapshot that fails to parse, or that carries a schema version this
 * build does not understand, is copied aside rather than thrown away —
 * it is the only evidence of what went wrong, and it may be a
 * recoverable transcript. But nothing ever read those keys and nothing
 * ever removed them, so each incident left a full JSON payload in
 * localStorage permanently. Keeping the most recent few preserves the
 * salvage and bounds the cost; the keys are timestamped, so "most
 * recent" is a lexical sort.
 */
const QUARANTINE_SNAPSHOTS_KEPT = 3;

/**
 * Copy a payload aside under a timestamped key, then prune the prefix.
 */
function quarantineCorruptSnapshot(prefix: string, raw: string): void {
  try {
    localStorage.setItem(`${prefix}${Date.now()}`, raw);
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    keys.sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - QUARANTINE_SNAPSHOTS_KEPT))) {
      localStorage.removeItem(key);
    }
  } catch (e) {
    // Quota or private mode. The salvage is best-effort by nature: the
    // parse has already failed and the caller falls back regardless.
    console.warn(`Quarantine of a corrupt snapshot under ${prefix} failed`, e);
  }
}
let uploadQueueMaxPersistedItems = Number.MAX_SAFE_INTEGER;
let uploadQueueMaxParallel = 1;
let LOCAL_TRANSCRIPTION_MODELS: string[] = [];
let DEFAULT_LOCAL_TRANSCRIPTION_MODEL = "";
let LOCAL_LIVE_ASSIST_MODELS: string[] = [];
let LOCAL_LIVE_PREVIEW_MODELS: string[] = [];
let LOCAL_ENGINE_AVAILABILITY: Record<string, boolean> = { whisper: true, gigaam: false };
let DEFAULT_LIVE_PREVIEW_LOCAL_MODEL = "";
// Explicit engine taxonomy from /api/health (SSOT for provider groups).
let LOCAL_WHISPER_MODELS: string[] = [];
let LOCAL_GIGAAM_MODELS: string[] = [];
// Last local group the user had selected — remote selections must not
// lose it, so fallback paths keep a valid local engine.
let lastLocalGroup: "local-whisper" | "gigaam" = "local-whisper";
let OPENROUTER_AUDIO_MODELS: string[] = [];
let DEFAULT_OPENROUTER_AUDIO_MODEL = "";
let DEEPGRAM_AUDIO_MODELS: string[] = [];
let DEFAULT_DEEPGRAM_AUDIO_MODEL = "";

/**
 * Text-generation models suitable for upscaling a raw transcript into
 * polished prose. These are separate from ``OPENROUTER_AUDIO_MODELS``
 * — audio models accept audio input while upscale models take the
 * "text + instruction -> text" shape. The backend injects the concrete
 * list before the first toolbar render.
 */
interface UpscaleModelOption {
  id: string;
  label: string;
}
let OPENROUTER_UPSCALE_MODELS: UpscaleModelOption[] = [];
let DEFAULT_UPSCALE_MODEL = "";

function labelForUpscaleModel(id: string): string {
  const known = OPENROUTER_UPSCALE_MODELS.find((m) => m.id === id);
  if (known) return known.label;
  // Custom/unknown IDs: strip the vendor prefix and any ``-preview``
  // suffix so long paths like ``openai/gpt-4.1-mini-preview`` don't
  // blow out the dropdown width.
  const short = id.split("/").pop() || id;
  return short.replace(/-preview$/, "").trim() || id;
}

function normalizeModelList(value: unknown, fallback: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const source = Array.isArray(value) ? value : fallback;
  for (const raw of source) {
    const model = String(raw || "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out.length ? out : fallback.slice();
}

function normalizeDefaultModel(value: unknown, models: string[], fallback: string): string {
  const model = String(value || "").trim();
  if (model && models.includes(model)) return model;
  return models.includes(fallback) ? fallback : models[0] || fallback;
}

function normalizeUpscaleModelOptions(value: unknown, fallback: UpscaleModelOption[]): UpscaleModelOption[] {
  const seen = new Set<string>();
  const out: UpscaleModelOption[] = [];
  const source = Array.isArray(value) ? value : fallback;
  for (const raw of source) {
    const item = raw && typeof raw === "object" ? raw as { id?: unknown; label?: unknown } : null;
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: String(item?.label || labelForUpscaleModel(id)).trim() || id });
  }
  return out.length ? out : fallback.slice();
}

// ── Unified transcription selection (SSOT) ───────────────────────────
//
// ONE state drives every transcription-model surface: the Transcribe
// toolbar, the Upload mirror toolbar, the live preview's derived assist
// model, and every request builder. The taxonomy comes from
// transcription-catalog.ts (backend /api/health is the upstream SSOT);
// these selects are VIEWS — never re-derive provider groups or model
// lists from the DOM.

let uiProviderGroup: TranscriptionGroupId | "" = "local-whisper";
const uiModelByGroup: Record<string, string> = {};
let transcriptionCatalogCache: TranscriptionGroup[] | null = null;

function splitLocalModels(): { whisper: string[]; gigaam: string[] } {
  return {
    whisper: LOCAL_TRANSCRIPTION_MODELS.filter((m) => !m.startsWith("gigaam-")),
    gigaam: LOCAL_TRANSCRIPTION_MODELS.filter((m) => m.startsWith("gigaam-")),
  };
}

function transcriptionCatalog(): TranscriptionGroup[] {
  if (!transcriptionCatalogCache) {
    const split = splitLocalModels();
    transcriptionCatalogCache = buildTranscriptionCatalog({
      whisperModels: LOCAL_WHISPER_MODELS.length ? LOCAL_WHISPER_MODELS : split.whisper,
      gigaamModels: LOCAL_GIGAAM_MODELS.length ? LOCAL_GIGAAM_MODELS : split.gigaam,
      engines: LOCAL_ENGINE_AVAILABILITY,
      deepgramModels: DEEPGRAM_AUDIO_MODELS,
      openrouterModels: OPENROUTER_AUDIO_MODELS,
    });
  }
  return transcriptionCatalogCache;
}

function invalidateTranscriptionCatalog(): void {
  transcriptionCatalogCache = null;
}

/**
 * Render BOTH toolbars (Transcribe + Upload mirror) from the single
 * state. Idempotent rebuild (BUG-58 pattern): options are rewritten only
 * when their value:availability signature changes, so the 2 s health
 * poll never closes an open dropdown.
 */
function renderTranscriptionSelectors(): void {
  const groups = transcriptionCatalog();
  for (const id of ["providerSelect", "uploadProviderMirror"]) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (!sel) continue;
    // "None" (no transcription) is a Transcribe-toolbar concept; the
    // Upload mirror always transcribes. It is part of the signature
    // because it is part of what gets rendered: without it the signature
    // described four options while the select held five, never matched
    // again after the first build, and the idempotence guard this
    // function is built around silently inverted into "rebuild every
    // time" — closing the dropdown under the user on every 10 s health
    // poll, which is the exact regression it was written to prevent.
    const wantsNone = id === "providerSelect";
    const signature = [
      ...groups.map((g) => `${g.id}:${g.models.some((m) => m.available) ? "1" : "0"}`),
      ...(wantsNone ? [":1"] : []),
    ].join("|");
    const current = Array.from(sel.options)
      .map((o) => `${o.value}:${o.disabled ? "0" : "1"}`)
      .join("|");
    if (signature !== current) {
      sel.innerHTML = "";
      for (const g of groups) {
        const opt = document.createElement("option");
        opt.value = g.id;
        opt.textContent = g.label;
        opt.disabled = !g.models.some((m) => m.available);
        sel.appendChild(opt);
      }
      if (wantsNone) {
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "None";
        sel.appendChild(none);
      }
    }
    // The empty string is assigned too, on the select that has a "None"
    // option: skipping it let the browser fall back to the first option,
    // so the toolbar read "Local Whisper" while the SSOT said "None".
    // These selects are views, and a view that declines to show one of
    // its states is not one. The Upload mirror is the exception on
    // purpose — it has no "None" to show, so it keeps its selection
    // rather than blanking out.
    if (wantsNone || uiProviderGroup) sel.value = uiProviderGroup;
  }
  const group = groups.find((g) => g.id === uiProviderGroup) || null;
  for (const id of ["remoteModelSelect", "uploadModelMirror"]) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (!sel) continue;
    if (!group) {
      sel.hidden = true;
      continue;
    }
    sel.hidden = false;
    const signature = group.models
      .map((m) => `${m.id}:${m.available ? "1" : "0"}`)
      .join("|");
    const current = Array.from(sel.options)
      .map((o) => `${o.value}:${o.disabled ? "0" : "1"}`)
      .join("|");
    if (signature !== current) {
      sel.innerHTML = "";
      for (const m of group.models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.available ? m.label : `${m.label} — engine not installed`;
        opt.disabled = !m.available;
        sel.appendChild(opt);
      }
    }
    sel.value = uiModelByGroup[group.id] || group.models[0]?.id || "";
  }
}

/** Single writer for the unified selection. */
function setTranscriptionSelection(group: TranscriptionGroupId | "", model?: string): void {
  uiProviderGroup = group;
  if (group) {
    // Selecting a GROUP selects a model in it. The group's change
    // handler has no model to pass, and leaving the slot empty made the
    // selection ambiguous: the selector displayed the group's first
    // model while the reader fell back to the global default. A user who
    // switched to GigaAM saw a GigaAM model and had Whisper `small`
    // transcribe — the WS query in the log says `model=small` on five
    // consecutive sessions. Resolving here, through the same function
    // the selector renders from, leaves one answer.
    const resolved = (
      model
      || uiModelByGroup[group]
      || defaultModelForGroup(transcriptionCatalog(), group)
    ).trim();
    if (resolved) uiModelByGroup[group] = resolved;
  }
  renderTranscriptionSelectors();
  queueUiPreferencesSave();
  // Unconditional call: ``scheduleLocalWarmup`` is the single gate on
  // whether a local engine is actually reached. Testing ``isLocalGroup``
  // here as well was a second, weaker copy of that rule — it missed the
  // case where a remote group is selected but has no usable key, which
  // resolves to the local engine and does need the warm.
  scheduleLocalWarmup();
}

function readProviderGroup(): TranscriptionGroupId | "" {
  return uiProviderGroup;
}

function readProviderSelection(): Provider {
  return wireProviderForGroup(uiProviderGroup);
}

// Canonical reader of the user's local-model choice: every flow that
// sends a LOCAL transcription request — record, re-transcribe and the
// upload queue — must go through this, not re-derive the value. When a
// remote group is selected it still reports the last local model, so
// fallback paths (remote provider down → local) keep a valid engine.
function selectedLocalModel(): string {
  const localGroup = isLocalGroup(uiProviderGroup) ? uiProviderGroup : lastLocalGroup;
  const group = localGroup || "local-whisper";
  const value = (uiModelByGroup[group] || "").trim();
  if (LOCAL_TRANSCRIPTION_MODELS.includes(value)) return value;
  // Fall back INSIDE the chosen group before falling back to the global
  // default. The global default is a Whisper model, so answering with it
  // for a GigaAM group silently changes the engine the user picked.
  const groupDefault = defaultModelForGroup(transcriptionCatalog(), group);
  if (groupDefault && LOCAL_TRANSCRIPTION_MODELS.includes(groupDefault)) return groupDefault;
  return DEFAULT_LOCAL_TRANSCRIPTION_MODEL;
}

type LocalModelRow = {
  key: string;
  id: string;
  engine: string;
  downloaded: boolean;
  status?: string;
  progress?: number;
  error?: string;
  note?: string;
  size_hint_bytes?: number | null;
};

let localModelsCache: LocalModelRow[] = [];
let localModelsFetchFailed = false;
/** Why the last local-model read failed, in the user's words. */
let localModelsFetchError = "";
/**
 * A model whose download was CONFIRMED and successfully started. When it
 * lands, ``refreshLocalModels`` applies it to the unified selection.
 */
let pendingModelSelection: string | null = null;
/**
 * The model the download modal is currently ASKING about.
 *
 * Separate from the pin above, and that separation is the whole fix: the
 * confirm handler read ``pendingModelSelection``, which nothing on the
 * path that opens the modal ever set — every assignment to it is either
 * ``null`` or the assignment inside that same confirm handler, under
 * ``if (id)``. So ``id`` was always null, ``requestModelDownload`` was
 * never reached from the modal, and pressing "Download" after being told
 * "medium is not on this machine yet (~1.4 GB download). Download it
 * now?" did nothing at all: no request, no status, no error, just a
 * modal closing.
 */
let pendingModelDownloadCandidate: string | null = null;
// Desktop-side GigaAM engine install state machine mirror. Populated via
// the __transcriptorEngine bridge; absent entirely in browser dev preview
// where gigaam rows simply show their backend-reported note.
let engineInstallState: EngineInstallStatus = { phase: "idle" };

function findLocalModelRow(id: string): LocalModelRow | undefined {
  return localModelsCache.find((m) => m.id === id);
}

function isLocalModelReady(id: string): boolean {
  const row = findLocalModelRow(id);
  return !!row && row.downloaded;
}

function renderLocalModels(): void {
  const wrap = document.getElementById("localModelsTable");
  if (!wrap) return;
  if (localModelsCache.length === 0) {
    // Empty state (BUG-31): a blank card reads as "broken". Say what is
    // happening instead. The reconciler drops this keyless node
    // automatically once real rows arrive.
    const placeholder = document.createElement("div");
    placeholder.className = "model-row model-row-empty";
    // Not "backend offline": that named a cause nothing had checked.
    // ``apiGet`` throws for a missing API token, an HTTP error and a
    // refused connection alike, and the reason was swallowed by a
    // bare ``catch`` — in an app that installs an error-aware console
    // precisely so reasons survive.
    placeholder.textContent = localModelsFetchFailed
      ? `Model list unavailable — ${localModelsFetchError || "the backend did not answer"}`
      : "Loading models…";
    wrap.replaceChildren(placeholder);
    return;
  }
  for (const row of localModelsCache) row.key = `model:${row.id}`;
  // BUG-42: card content must be a pure function of row state, applied
  // identically on create AND update — otherwise a node born mid-download
  // never grows a retry button after an error, and an idle-born node
  // keeps a clickable Download ghost during progress.
  const applyRowToCard = (card: HTMLElement, row: LocalModelRow): void => {
    let name = card.querySelector<HTMLElement>(".model-name");
    if (!name) {
      name = document.createElement("span");
      name.className = "model-name";
      card.prepend(name);
    }
    name.textContent = row.id + (row.note ? ` — ${row.note}` : "");
    // The size column exists on EVERY row, even when the catalog has no
    // hint for that model. An element that appears and disappears per
    // row cannot line up into a column — which is exactly what the sizes
    // failed to do before: each row's figure sat wherever that row's
    // name happened to end.
    let size = card.querySelector<HTMLElement>(".model-size");
    if (!size) {
      size = document.createElement("span");
      size.className = "model-size";
      name.after(size);
    }
    size.textContent = row.size_hint_bytes ? fmtBytes(row.size_hint_bytes) : "";
    let state = card.querySelector<HTMLElement>(".model-state");
    if (!state) {
      state = document.createElement("span");
      state.className = "model-state";
      (size ?? name).after(state);
    }
    if (row.status === "downloading") {
      state.textContent = `↓ ${Math.round(row.progress || 0)}%`;
      state.classList.remove("ok", "err");
    } else if (row.status === "error") {
      state.textContent = "failed — retry";
      state.classList.add("err");
    } else if (row.downloaded) {
      state.textContent = "✓";
      state.classList.add("ok");
    } else {
      state.textContent = "";
      state.classList.remove("ok", "err");
    }
    // The button exists exactly when a download CAN be started from here:
    // whisper engine, not on disk, and no download in flight. GigaAM rows
    // get an ENGINE-install button instead — the engine is installed at
    // the desktop layer, never via the backend model manager.
    const installing = engineInstallState.phase === "installing" || engineInstallState.phase === "probing";
    let btn = card.querySelector<HTMLButtonElement>(".model-dl");
    if (row.engine === "gigaam" && !row.downloaded) {
      if (installing) {
        btn?.remove();
        state.textContent = "Installing engine…";
        state.classList.remove("ok", "err");
      } else if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn model-dl";
        btn.textContent = "Install engine";
        btn.dataset.engineInstall = "gigaam";
        card.appendChild(btn);
      }
      card.classList.toggle("ready", false);
      return;
    }
    const wantButton = !row.downloaded && row.engine === "whisper" && row.status !== "downloading";
    if (wantButton && !btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn model-dl";
      btn.textContent = "Download";
      btn.dataset.dlModel = row.id;
      card.appendChild(btn);
    } else if (!wantButton && btn) {
      btn.remove();
    }
    // Delete is the inverse of Download and belongs on the same row.
    // Offered only for a Whisper model actually on disk with nothing in
    // flight — GigaAM is an engine the desktop layer installs, and the
    // backend refuses to "delete" it for the same reason.
    const wantDelete = row.downloaded && row.engine === "whisper" && row.status !== "downloading";
    let del = card.querySelector<HTMLButtonElement>(".model-del");
    if (wantDelete && !del) {
      del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost model-del";
      del.textContent = "Delete";
      del.title = "Remove these weights from disk";
      del.dataset.delModel = row.id;
      card.appendChild(del);
    } else if (!wantDelete && del) {
      del.remove();
    }
    card.classList.toggle("ready", row.downloaded);
  };
  reconcileRecordingsList(wrap, localModelsCache, {
    create: (row) => {
      const card = document.createElement("div");
      card.className = "model-row" + (row.downloaded ? " ready" : "");
      // Reconciler identity (BUG-56): without dataset.recordingKey the
      // keyed lookup never matches, so every 2 s poll dropped and
      // recreated the whole table (lost hover state, button flicker).
      card.dataset.recordingKey = row.key;
      applyRowToCard(card, row);
      return card;
    },
    update: (card, row) => {
      applyRowToCard(card, row);
    },
  });
}

async function refreshLocalModels(): Promise<void> {
  try {
    const js = await apiGet<{ ok: boolean; models: LocalModelRow[] }>("/api/models/local");
    localModelsCache = Array.isArray(js.models) ? js.models : [];
    localModelsFetchFailed = false;
    localModelsFetchError = "";
    renderLocalModels();
    invalidateTranscriptionCatalog(); renderTranscriptionSelectors();
    void syncEngineInstallState();
    // A pending selection becomes real the moment its model lands:
    // the download worker finishes with status "done" (the only
    // terminal success state the backend emits).
    if (
      pendingModelSelection &&
      isLocalModelReady(pendingModelSelection) &&
      findLocalModelRow(pendingModelSelection)?.status === "done"
    ) {
      // Apply through the SSOT: the group stays whatever it is (the
      // downloaded model's group becomes the selection), both toolbars
      // re-render from the single state.
      const group = pendingModelSelection.startsWith("gigaam-") ? "gigaam" : "local-whisper";
      setTranscriptionSelection(group, pendingModelSelection);
      lastLocalGroup = group;
      pendingModelSelection = null;
    }
    // A pending pin whose download ENDED IN ERROR must not survive
    // (BUG-71): it would pin the select to lastAppliedLocalModel forever
    // (syncLocalModelOptions forces that value while a pin exists) and
    // silently swallow every later user choice. The row keeps its
    // "failed — retry" button, so releasing the pin costs nothing.
    if (
      pendingModelSelection &&
      findLocalModelRow(pendingModelSelection)?.status === "error"
    ) {
      pendingModelSelection = null;
      invalidateTranscriptionCatalog(); renderTranscriptionSelectors();
    }
  } catch (e) {
    // BUG-31: surface the failure instead of leaving a blank table. A
    // populated cache is kept (stale rows beat a flickering empty
    // state); only the never-loaded case shows the placeholder.
    console.warn("Local model list refresh failed", e);
    localModelsFetchFailed = true;
    localModelsFetchError = sanitizeUiErrorMessage(e, "the backend did not answer");
    if (localModelsCache.length === 0) renderLocalModels();
  }
  ensureLocalModelsPolling();
}

/**
 * Local-models poll gate.
 *
 * Two reasons to run: the Settings pane is on screen (rows must stay
 * live under the user's eyes), or work is in flight whose progress we
 * are tracking even if the user navigated away — a model download or an
 * engine install, both of which the user expects to find finished when
 * they come back.
 *
 * The previous form hand-rolled its own start/stop bookkeeping around a
 * `setInterval` handle, and its stop branch forgot `engineInstalling`,
 * so an install with no concurrent download stopped being polled the
 * moment the user left Settings. Expressing the gate as a predicate
 * makes that class of asymmetry unrepresentable: there is one condition,
 * and the scheduler arms or suspends from it.
 */
function shouldPollLocalModels(): boolean {
  if (!rendererIsVisible()) return false;
  if (isViewVisible("settings")) return true;
  if (localModelsCache.some((m) => m.status === "downloading")) return true;
  return engineInstallState.phase === "installing" || engineInstallState.phase === "probing";
}

const localModelsPoll = createGatedPoll({
  name: "local-models",
  intervalMs: 2000,
  shouldRun: shouldPollLocalModels,
  tick: () => refreshLocalModels(),
});
gatedPolls.push(localModelsPoll);

function ensureLocalModelsPolling(): void {
  localModelsPoll.sync();
}

/**
 * Delete a downloaded model's weights.
 *
 * Confirmation is mandatory: the smallest Whisper model is 75 MB and
 * large-v3 is 3.1 GB, so an accidental click costs a long re-download on
 * a connection we know nothing about. The backend's refusal messages
 * (download in flight, engine-managed model) are written to be shown
 * verbatim, so they pass straight through to the status line.
 */
async function requestModelDelete(id: string): Promise<boolean> {
  const row = localModelsCache.find((m) => m.id === id);
  const size = row?.size_hint_bytes ? ` (${fmtBytes(row.size_hint_bytes)})` : "";
  const confirmed = window.confirm(
    `Delete the "${id}" model${size} from this machine?\n\n`
    + "The weights are removed from disk and will have to be downloaded "
    + "again before this model can transcribe. Your recordings and "
    + "transcripts are not affected.",
  );
  if (!confirmed) return false;
  try {
    await apiDelete<{ ok: boolean; freed_bytes?: number }>(
      `/api/models/local/${encodeURIComponent(id)}`,
    );
    setStatus(`Deleted ${id}.`, "info");
    await refreshLocalModels();
    return true;
  } catch (e) {
    const detail = sanitizeUiErrorMessage(e, "Could not delete the model.");
    setStatus(`Could not delete ${id}: ${detail}`, "error");
    return false;
  }
}

async function requestModelDownload(id: string): Promise<boolean> {
  try {
    await apiPost<{ ok: boolean }>(`/api/models/local/${encodeURIComponent(id)}/download`, {});
    setStatus(`Downloading ${id}…`, "info");
    await refreshLocalModels();
    return true;
  } catch (e) {
    // Through the same sanitiser the Delete action of this very row
    // already used: offline, the two used to say "The computer appears
    // to be offline…" and "Failed to fetch".
    setStatus(`Download failed for ${id}: ${sanitizeUiErrorMessage(e, "Could not start the download.")}`, "error");
    // BUG-40: a failed request must not leave a pending pin behind — the
    // caller only arms auto-apply when this resolves truthy.
    return false;
  }
}

// Engine install consent flag for the shared confirm modal. Distinct
// from pendingModelSelection so one modal serves both flows without
// overloading model ids with engine semantics.
let pendingEngineInstall = false;

async function requestEngineInstall(): Promise<void> {
  const bridge = window.__transcriptorEngine;
  if (!bridge) {
    setStatus("Engine install is only available in the desktop app", "error");
    return;
  }
  try {
    const result = await bridge.install();
    engineInstallState = result;
    if (result.phase === "done") {
      setStatus("GigaAM engine installed — restarting backend", "info");
      await refreshLocalModels();
    } else if (result.phase === "failed") {
      const why = result.reason || result.error || "unknown error";
      setStatus(`GigaAM engine install failed: ${why}`, "error");
    }
  } catch (e) {
    setStatus(`Engine install failed: ${sanitizeUiErrorMessage(e, "Could not install the engine.")}`, "error");
  }
}

/**
 * Mirror the desktop engine-install state machine into renderer state.
 * Called from the same poll cycle as the local-models table (2 s while
 * Settings is visible, or while an install runs) — pull beats push here:
 * no subscription lifecycle to leak across window reloads. Skipped when
 * the bridge is absent (browser dev preview).
 */
async function syncEngineInstallState(): Promise<void> {
  const bridge = window.__transcriptorEngine;
  if (!bridge) return;
  const needsWatch =
    engineInstallState.phase === "installing" ||
    engineInstallState.phase === "probing";
  const anyGigaamPending = localModelsCache.some((m) => m.engine === "gigaam" && !m.downloaded);
  if (!needsWatch && !anyGigaamPending) return;
  try {
    const next = await bridge.getStatus();
    if (next.phase !== engineInstallState.phase) {
      engineInstallState = next;
      renderLocalModels();
      if (next.phase === "done") {
        // The main process restarts the backend on completion; the next
        // health poll flips LOCAL_ENGINE_AVAILABILITY and enables the
        // gigaam options. Nudge the first refresh immediately.
        void refreshLocalModels();
      }
    } else {
      engineInstallState = next;
    }
  } catch { /* transient IPC failure — retried on the next tick */ }
}

function wireLocalModelsUi(): void {
  // The modal is set up FIRST: the table's click handler opens it, and
  // when these ``const``s were declared below that listener the code
  // only worked because the callback happened to run after the temporal
  // dead zone had passed. Declaration order that has to be reasoned
  // about is declaration order in the wrong place.
  const modal = document.getElementById("modelDownloadModal");
  const titleEl = document.getElementById("modelDownloadTitle");
  const textEl = document.getElementById("modelDownloadText");
  const confirmBtn = document.getElementById("modelDownloadConfirmBtn");
  const cancelBtn = document.getElementById("modelDownloadCancelBtn");
  const openModelModal = (copy: { title: string; body: string; confirmLabel: string }): void => {
    if (titleEl) titleEl.textContent = copy.title;
    if (textEl) textEl.textContent = copy.body;
    if (confirmBtn) confirmBtn.textContent = copy.confirmLabel;
    if (modal) modal.hidden = false;
    confirmBtn?.focus();
  };
  const closeModal = (): void => {
    if (modal) modal.hidden = true;
    pendingEngineInstall = false;
    // Only the question is dropped. The unified selection state is
    // mutated on a CONFIRMED, successful download (auto-apply in
    // refreshLocalModels), so Cancel has nothing to restore — the
    // BUG-45 stale-select class cannot exist when the selects are views
    // of the SSOT rather than its source — and a pin left by an EARLIER
    // download that is still in flight is not this modal's to discard.
    pendingModelDownloadCandidate = null;
  };
  cancelBtn?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (ev) => {
    if (ev.target === modal) closeModal();
  });
  confirmBtn?.addEventListener("click", () => {
    const engineRequested = pendingEngineInstall;
    const id = pendingModelDownloadCandidate;
    closeModal();
    if (engineRequested) void requestEngineInstall();
    if (id) void requestModelDownload(id).then((started) => {
      if (!started) return; // BUG-40: never pin on a failed request
      pendingModelSelection = id; // applied automatically once ready
    });
  });

  const table = document.getElementById("localModelsTable");
  table?.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const id = target?.closest?.("[data-dl-model]")?.getAttribute("data-dl-model");
    if (id) void requestModelDownload(id);
    const deleteId = target?.closest?.("[data-del-model]")?.getAttribute("data-del-model");
    if (deleteId) void requestModelDelete(deleteId);
    // Engine install (GigaAM): desktop-layer action with explicit user
    // consent — a multi-GB download must never start from a stray click.
    if (target?.closest?.("[data-engine-install]")) {
      pendingEngineInstall = true;
      // One modal, two questions — so the heading and the button have to
      // be part of what the question sets. They used to be markup
      // constants, which meant this branch asked "Install the Russian
      // GigaAM engine?" under a heading that said "Model not downloaded"
      // above a button that said "Download".
      openModelModal({
        title: "Install the GigaAM engine",
        body: "Install the Russian GigaAM engine? This downloads ~2 GB and needs "
          + "8 GB of free disk space. The backend restarts when it finishes.",
        confirmLabel: "Install",
      });
    }
  });

  const modelSel = document.getElementById("remoteModelSelect") as HTMLSelectElement | null;
  if (modelSel) {
    modelSel.addEventListener("change", () => {
      const value = modelSel.value;
      // ``#remoteModelSelect`` is ONE select for every group, so this
      // handler sees Deepgram's nova-3 and OpenRouter's models too.
      // Neither has a row in the local-model table, so
      // ``isLocalModelReady`` returned false for them and the user was
      // asked to download cloud weights onto their disk. Only a local
      // group has anything to download.
      if (!isLocalGroup(readProviderGroup())) return;
      if (isLocalModelReady(value)) return;
      // Not on disk yet: remember what the modal is asking about, keep
      // the candidate visible in the VIEW while it asks, but mutate the
      // SSOT state only after a confirmed, successful download
      // (auto-apply above) — the BUG-45 stale-select class cannot exist
      // when selects are views.
      pendingModelDownloadCandidate = value;
      const rowSize = findLocalModelRow(value)?.size_hint_bytes;
      openModelModal({
        title: "Model not downloaded",
        body: `${value} is not on this machine yet`
          + (rowSize ? ` (~${fmtBytes(rowSize)} download)` : "")
          + ". Download it now?",
        confirmLabel: "Download",
      });
    });
  }
}

function applyHealthModelCatalog(catalog: unknown): void {
  if (!catalog || typeof catalog !== "object") return;
  const root = catalog as ModelCatalogPayload;
  LOCAL_TRANSCRIPTION_MODELS = normalizeModelList(root.local?.models, LOCAL_TRANSCRIPTION_MODELS);
  LOCAL_WHISPER_MODELS = normalizeModelList(root.local?.whisper_models, []);
  LOCAL_GIGAAM_MODELS = normalizeModelList(root.local?.gigaam_models, []);
  DEFAULT_LOCAL_TRANSCRIPTION_MODEL = normalizeDefaultModel(
    root.local?.default_model,
    LOCAL_TRANSCRIPTION_MODELS,
    DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
  );
  LOCAL_LIVE_ASSIST_MODELS = normalizeModelList(root.local?.live_assist_models, LOCAL_LIVE_ASSIST_MODELS);
  const engines = root.local?.engines;
  if (engines && typeof engines === "object") {
    LOCAL_ENGINE_AVAILABILITY = { ...LOCAL_ENGINE_AVAILABILITY };
    for (const [engine, available] of Object.entries(engines as Record<string, unknown>)) {
      LOCAL_ENGINE_AVAILABILITY[engine] = available === true;
    }
  }
  LOCAL_LIVE_PREVIEW_MODELS = normalizeModelList(root.local?.live_preview_models, LOCAL_LIVE_PREVIEW_MODELS);
  DEFAULT_LIVE_PREVIEW_LOCAL_MODEL = normalizeDefaultModel(
    root.local?.default_live_preview_model,
    LOCAL_LIVE_PREVIEW_MODELS,
    DEFAULT_LIVE_PREVIEW_LOCAL_MODEL || LOCAL_LIVE_PREVIEW_MODELS[0] || DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
  );

  OPENROUTER_AUDIO_MODELS = normalizeModelList(root.remote?.openrouter?.audio_models, OPENROUTER_AUDIO_MODELS);
  const previousOpenrouterDefault = DEFAULT_OPENROUTER_AUDIO_MODEL;
  DEFAULT_OPENROUTER_AUDIO_MODEL = normalizeDefaultModel(
    root.remote?.openrouter?.default_audio_model,
    OPENROUTER_AUDIO_MODELS,
    DEFAULT_OPENROUTER_AUDIO_MODEL,
  );
  if (!remoteModelByProvider.openrouter || remoteModelByProvider.openrouter === previousOpenrouterDefault) {
    remoteModelByProvider.openrouter = DEFAULT_OPENROUTER_AUDIO_MODEL;
  }

  DEEPGRAM_AUDIO_MODELS = normalizeModelList(root.remote?.deepgram?.audio_models, DEEPGRAM_AUDIO_MODELS);
  const previousDeepgramDefault = DEFAULT_DEEPGRAM_AUDIO_MODEL;
  DEFAULT_DEEPGRAM_AUDIO_MODEL = normalizeDefaultModel(
    root.remote?.deepgram?.default_audio_model,
    DEEPGRAM_AUDIO_MODELS,
    DEFAULT_DEEPGRAM_AUDIO_MODEL,
  );
  if (!remoteModelByProvider.deepgram || remoteModelByProvider.deepgram === previousDeepgramDefault) {
    remoteModelByProvider.deepgram = DEFAULT_DEEPGRAM_AUDIO_MODEL;
  }

  OPENROUTER_UPSCALE_MODELS = normalizeUpscaleModelOptions(
    root.upscale?.openrouter_models,
    OPENROUTER_UPSCALE_MODELS,
  );
  const previousUpscaleDefault = DEFAULT_UPSCALE_MODEL;
  DEFAULT_UPSCALE_MODEL = normalizeDefaultModel(
    root.upscale?.default_model,
    OPENROUTER_UPSCALE_MODELS.map((m) => m.id),
    DEFAULT_UPSCALE_MODEL,
  );
  const upscaleSel = document.getElementById("upscaleModelSelect") as HTMLSelectElement | null;
  if (upscaleSel && !hasStoredUpscaleModelPreference) {
    const selected = (upscaleSel.value || "").trim();
    if (!selected || selected === previousUpscaleDefault) {
      upscaleSel.value = DEFAULT_UPSCALE_MODEL;
    }
  }

  invalidateTranscriptionCatalog();
  renderTranscriptionSelectors();
  populateUpscaleModelOptions();
}

function applyBackendBootstrap(): void {
  const bootstrap = window.__TRANSCRIPTOR_BOOTSTRAP;
  if (!bootstrap || typeof bootstrap !== "object") return;
  applyBackendRuntimeConfig(bootstrap);
  applyHealthModelCatalog(bootstrap.model_catalog);
  wireLocalModelsUi();
  void refreshLocalModels();
  applyRuntimeLimits(bootstrap.runtime_limits);
}

function applyBackendRuntimeConfig(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const root = payload as {
    max_upload_bytes?: unknown;
    accepted_audio_exts?: unknown;
    audio_ext_to_mime?: unknown;
    live_sample_rate_hz?: unknown;
    live_defaults?: BackendLiveDefaultsPayload;
  };
  const uploadBytes = Number(root.max_upload_bytes);
  if (Number.isFinite(uploadBytes) && uploadBytes > 0) {
    MAX_FILE_BYTES = Math.trunc(uploadBytes);
    // Persist the backend-reported cap so cold starts validate sizes
    // before /api/health lands (BUG-03). Cache only — server wins.
    try {
      localStorage.setItem(UPLOAD_CAP_CACHE_KEY, String(MAX_FILE_BYTES));
    } catch {
      /* quota/private-mode: validation just falls back to skip-until-hydrated */
    }
  }
  const sampleRate = Number(root.live_sample_rate_hz);
  if (Number.isFinite(sampleRate) && sampleRate >= 8_000 && sampleRate <= 96_000) {
    LIVE_SAMPLE_RATE_HZ = Math.trunc(sampleRate);
  }
  if (Array.isArray(root.accepted_audio_exts)) {
    const nextExts = root.accepted_audio_exts
      .map((value) => String(value || "").trim().toLowerCase().replace(/^\./, ""))
      .filter((value) => /^[a-z0-9]+$/.test(value));
    if (nextExts.length > 0) {
      ACCEPTED_AUDIO_VIDEO_EXTS.clear();
      for (const ext of nextExts) ACCEPTED_AUDIO_VIDEO_EXTS.add(ext);
      renderAcceptedFormatsHint(document, ACCEPTED_AUDIO_VIDEO_EXTS);
    }
  }
  applyAudioMimeMap(root.audio_ext_to_mime);
  applyBackendLiveDefaults(root.live_defaults);
}

/**
 * Invert the backend's ext → MIME map into the renderer's MIME → ext one.
 *
 * First extension wins: several MIMEs are shared by two extensions
 * (``audio/ogg`` by ogg and oga, ``video/mp4`` by mp4 and m4v,
 * ``video/mpeg`` by mpg and mpeg) and the backend's map lists the
 * canonical one first, which is why insertion order is preserved on the
 * way here rather than sorted.
 */
function applyAudioMimeMap(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([ext, mime]) => [
      String(ext || "").trim().toLowerCase().replace(/^\./, ""),
      String(mime || "").trim().toLowerCase(),
    ] as const)
    .filter(([ext, mime]) => /^[a-z0-9]+$/.test(ext) && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime));
  if (!entries.length) return;
  for (const key of Object.keys(MIME_TO_AUDIO_EXT)) delete MIME_TO_AUDIO_EXT[key];
  for (const [ext, mime] of entries) {
    if (!MIME_TO_AUDIO_EXT[mime]) MIME_TO_AUDIO_EXT[mime] = ext;
  }
}

/**
 * Adopt the live path's backend-owned facts: which languages it offers,
 * what it defaults the second stream to, and the keyterm token budget it
 * enforces.
 *
 * The LANG picker's option list is rewritten from ``languages`` — the
 * Upload picker and the dual-stream picker are both filled FROM that
 * picker, so all three follow one list. The markup keeps the same three
 * options as the pre-hydration state (``frontend/tests/renderer-main-contract.test.ts``
 * checks that it still agrees with the backend), and this replaces them
 * the moment the payload lands.
 */
function applyBackendLiveDefaults(raw: BackendLiveDefaultsPayload | undefined): void {
  if (!raw || typeof raw !== "object") return;
  const languages = Array.isArray(raw.languages)
    ? raw.languages.map((code) => String(code || "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (languages.length) applyLiveLanguageOptions(languages);
  const secondary = String(raw.dual_secondary_language || "").trim().toLowerCase();
  if (typeof raw.dual_stream === "boolean" && secondary) {
    const first = backendLiveDefaults === null;
    backendLiveDefaults = { dualStream: raw.dual_stream, secondaryLanguage: secondary };
    // The markup default becomes the BACKEND's default, before loadCfg
    // reads the stored preference over the top of it. Without this the
    // checked attribute in index.html would be a second answer to the
    // same question rather than a pre-hydration placeholder.
    //
    // ONCE, on the first payload only: this function is also reached
    // from the periodic /api/health poll, and re-applying the default
    // there would tick a box the user had just unticked.
    const dualCheck = first ? dualStreamCheckbox() : null;
    if (dualCheck) {
      dualCheck.defaultChecked = raw.dual_stream;
      dualCheck.checked = raw.dual_stream;
    }
  }
  const budget = Number(raw.keyterm_token_budget);
  if (Number.isFinite(budget) && budget > 0) applyKeytermBudgetNote(Math.trunc(budget));
}

/**
 * Rewrite ``#language``'s options from the backend's list, keeping the
 * current selection when it survives. Runs before ``loadCfg``, so the
 * stored language is applied against the list the backend actually
 * offers rather than against whatever the markup happened to carry.
 */
function applyLiveLanguageOptions(codes: ReadonlyArray<string>): void {
  const select = document.getElementById("language") as HTMLSelectElement | null;
  if (!select) return;
  const existing = Array.from(select.options).map((option) => option.value);
  if (existing.length === codes.length && existing.every((code, i) => code === codes[i])) return;
  const selected = select.value;
  select.replaceChildren();
  for (const code of codes) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = code === "auto" ? "Auto" : code.toUpperCase();
    select.appendChild(option);
  }
  if (codes.includes(selected)) select.value = selected;
}

/**
 * State the keyterm budget the backend actually enforces, next to the
 * field that spends it. ``normalize_keyterms`` drops terms once the
 * running token estimate passes this number, and the note used to
 * describe the field without ever saying so.
 */
function applyKeytermBudgetNote(budget: number): void {
  const note = document.getElementById("deepgramKeytermsNote");
  if (!note) return;
  const sentence = ` Up to ${budget} tokens in total — terms past that are dropped.`;
  const base = (note.textContent || "").replace(/\s+Up to \d+ tokens in total[^]*$/, "").trimEnd();
  note.textContent = base + sentence;
}

function applyRuntimeLimits(limits: unknown): void {
  if (!limits || typeof limits !== "object") return;
  const root = limits as {
    upload_queue_max_parallel?: unknown;
    upload_queue_max_persisted_items?: unknown;
  };
  const uploadParallel = Number(root.upload_queue_max_parallel);
  if (Number.isFinite(uploadParallel) && uploadParallel >= 1 && uploadParallel <= 8) {
    uploadQueueMaxParallel = Math.trunc(uploadParallel);
  }
  const persistedItems = Number(root.upload_queue_max_persisted_items);
  if (Number.isFinite(persistedItems) && persistedItems >= 1 && persistedItems <= 1000) {
    uploadQueueMaxPersistedItems = Math.trunc(persistedItems);
  }
}

let isBusy = false;
let isRecording = false;
let liveStatusText = "Idle";
let liveStatusKind: StatusKind = "idle";
let liveTimerText = "00:00";
let mediaRecorder: MediaRecorder | null = null;
let recordedWebmChunks: Blob[] = [];
let isNetworkOnline = true;
let hasOpenrouterKey = false;
let hasDeepgramKey = false;
let uiPrefSaveTimer: number | null = null;
let suppressUiPrefAutosave = false;
/**
 * Have the user's preferences ever been read from the backend?
 *
 * While they have not, the DOM shows MARKUP defaults, not the user's
 * choices: an empty archive path, empty keyterms, an empty microphone
 * picker, the platform shortcut defaults. Autosaving in that state does
 * not save nothing — ``buildUiPreferencesSavePlan`` collects the WHOLE
 * ``preferences`` block out of the DOM, and the backend's ``_deep_merge``
 * treats a key that is present-but-empty as a value, not as an absence.
 * So the first toggle the user touches after a backend that was still
 * starting up would overwrite keyterms, the archive directory, the
 * microphone, the upscale model and both hotkeys with defaults, silently
 * and successfully.
 *
 * This is the same argument ``deepgram-dual.ts`` already makes for two
 * fields ("absent means the documented default, never off"), applied to
 * the whole set instead of to the two that happened to be noticed.
 * ``suppressUiPrefAutosave`` cannot carry it: that flag is a re-entrancy
 * guard around a load in progress and is cleared in ``finally``, which
 * is exactly the branch a failed load takes.
 */
let uiPreferencesLoaded = false;
let preferredMicId = "";
let upscalePresets: UpscalePresetItem[] = [];
let pendingUpscalePresetId = "";
let defaultUpscalePresetId = "";
let hasStoredUpscaleModelPreference = false;
let currentRecordingAudioObjectUrl = "";
let currentRecordingAudioSourceKey = "";
let currentRecordingAudioRenderSeq = 0;
let recordingViewerAudioObjectUrl = "";
let activeLiveSessionId = "";
let activeLiveArchiveDir = "";
let activeLiveSessionSnapshot: LiveSessionSnapshot | null = null;
/**
 * Who owns the result pane right now.
 *
 * Non-empty from the first line of the app: "nothing has been recorded
 * yet" is a UI session like any other, and giving it a real token is
 * what lets a scoped write be checked by plain equality in that state
 * too. It used to start as "", which ``isCurrentUiSession`` reads as
 * "unscoped, always current" — so the guard re-transcribe relies on was
 * inert on the commonest path of all (cold open → open a recording →
 * re-transcribe), and re-transcribe worked around it by minting a token
 * for itself, installing it globally and removing it again in a
 * ``finally``. ``createClientSessionId`` is a function declaration, so
 * it is hoisted above this initialiser.
 */
let activeUiSessionToken = createClientSessionId();
let currentRecordingSummary: CurrentRecordingSummary | null = null;
let latestSavedAudioState: LatestSavedAudioState | null = null;
let recordSessionNoticeTimer: number | null = null;
let busyScopeToken = "";
let liveStartAbortReason = "";
const remoteModelByProvider: Record<RemoteProvider, string> = {
  openrouter: DEFAULT_OPENROUTER_AUDIO_MODEL,
  deepgram: DEFAULT_DEEPGRAM_AUDIO_MODEL,
};
// Placeholder shown for a stored key. Long enough to read as a full
// secret, short enough not to overflow the field and run under the
// action button — the value is never sent anywhere, so its length
// carries no information about the real key.
const MASKED_KEY_VALUE = "••••••••••••••••••••••••";
const keySavedState: Record<RemoteProvider, boolean> = {
  openrouter: false,
  deepgram: false,
};

const apiToken = (): string => {
  const token = (window.__TRANSCRIPTOR_API_TOKEN || "").trim();
  if (!token) {
    throw new Error("API token is missing. Restart app.");
  }
  return token;
};

const authHeaders = (): HeadersInit => ({ "X-Api-Token": apiToken() });
const WS_AUTH_SUBPROTOCOL = "transcriptor-auth";
const WS_AUTH_TOKEN_PREFIX = "transcriptor-token.";

function base64UrlEncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Escape a value for use inside an attribute selector.
 *
 * The hand-written fallback that used to stand here was unreachable —
 * `CSS.escape` has shipped in every Chromium the shell can run on — and
 * wrong where it was not: its `^-?\d` alternative matched TWO characters
 * on a leading hyphen while the callback escaped only the first, so
 * `"-5abc"` came out as `"\2d abc"` with the digit dropped, and its
 * `\w` had no `u` flag, so it split surrogate pairs. Dead code that
 * would misbehave if it ever ran is worse than no code: it reads as a
 * guarantee.
 *
 * The one real caller passes a `data-recording-key`, which is already
 * `encodeURIComponent`'d, so what remains is a formality that costs
 * nothing.
 */
function cssEscape(value: string): string {
  const nativeEscape = globalThis.CSS?.escape;
  if (typeof nativeEscape === "function") return nativeEscape(String(value));
  // Quoted attribute-selector context: a backslash before every
  // character that could end the string or the selector is sufficient
  // and, unlike the previous attempt, cannot lose one.
  return String(value).replace(/["'\\\]]/g, (char) => `\\${char}`);
}

function websocketAuthProtocols(): string[] {
  return [
    WS_AUTH_SUBPROTOCOL,
    `${WS_AUTH_TOKEN_PREFIX}${base64UrlEncodeUtf8(apiToken())}`,
  ];
}

function createClientSessionId(): string {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `live-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function revokeCurrentRecordingAudioUrl(): void {
  if (!currentRecordingAudioObjectUrl) return;
  URL.revokeObjectURL(currentRecordingAudioObjectUrl);
  currentRecordingAudioObjectUrl = "";
  currentRecordingAudioSourceKey = "";
}

function revokeRecordingViewerAudioUrl(): void {
  if (!recordingViewerAudioObjectUrl) return;
  URL.revokeObjectURL(recordingViewerAudioObjectUrl);
  recordingViewerAudioObjectUrl = "";
}

function setRecordingViewerAudioRowVisible(visible: boolean, hydrating = false): void {
  const row = $("recordingAudioRow");
  row.hidden = !visible;
  row.classList.toggle("is-audio-hydrating", visible && hydrating);
  row.setAttribute("aria-busy", visible && hydrating ? "true" : "false");
}

/**
 * Wait until the viewer's player can say something about the file.
 *
 * Resolves "ready" for metadata, a timeout — which means "took too
 * long, show the controls anyway" — and REJECTS on a media error. The
 * error listener used to call the same ``finish`` as ``canplay``, so a
 * file the decoder refused was reported as ready: the row appeared,
 * the controls were live, and pressing play did nothing at all. The
 * caller already has a catch that hides the row; this makes the error
 * reach it.
 */
function waitForRecordingViewerAudioReady(player: HTMLAudioElement): Promise<void> {
  if (player.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = 0;
    const detach = (): void => {
      window.clearTimeout(timeoutId);
      player.removeEventListener("loadedmetadata", onReady);
      player.removeEventListener("canplay", onReady);
      player.removeEventListener("error", onError);
    };
    function onReady(): void {
      if (settled) return;
      settled = true;
      detach();
      resolve();
    }
    function onError(): void {
      if (settled) return;
      settled = true;
      detach();
      const code = player.error?.code ?? 0;
      reject(new Error(`Audio for this recording could not be decoded (media error ${code}).`));
    }

    player.addEventListener("loadedmetadata", onReady, { once: true });
    player.addEventListener("canplay", onReady, { once: true });
    player.addEventListener("error", onError, { once: true });
    timeoutId = window.setTimeout(onReady, UI_TOKENS.recordings.viewerAudioReadyTimeoutMs);
  });
}

/**
 * May a write tagged with this token still land?
 *
 * An empty token means the write is UNSCOPED — the caller did not claim
 * a session, so nothing can supersede it. Any other token must equal
 * the session that owns the pane; a live session started since then
 * makes the write stale, and stale writes are dropped rather than
 * allowed to clobber the fresh session's output.
 */
function isCurrentUiSession(token = ""): boolean {
  if (!token) return true;
  return token === activeUiSessionToken;
}

function latestRecordingAudioUrl(savedName = "", archiveDir = ""): string {
  const safeName = String(savedName || "").trim();
  if (!safeName) return "";
  const params = new URLSearchParams();
  const safeArchiveDir = String(archiveDir || "").trim();
  if (safeArchiveDir) params.set("archive_dir", safeArchiveDir);
  const qs = params.toString();
  return `/api/recordings/${encodeURIComponent(safeName)}/audio${qs ? `?${qs}` : ""}`;
}

/**
 * MIME → canonical extension, INVERTED FROM THE BACKEND'S OWN MAP.
 *
 * Used when the backend's ``Content-Disposition`` header is absent or
 * unparseable and a filename has to be synthesised from the saved-name
 * stem. The mapping is the backend's (``backend/audio_mime.py``), and it
 * arrives in the bootstrap payload as ``audio_ext_to_mime`` (S-04).
 *
 * It used to be a hand-written 12-entry table here against the
 * backend's 19: it knew no video container and no ``.oga``, so a
 * screen recording played back through the header-missing path was
 * named ``.bin``, and it invented four MIME spellings
 * (``audio/x-wav``, ``audio/wave``, ``audio/x-m4a``, ``audio/x-flac``)
 * that this backend cannot emit — an import-time assert in
 * ``backend/main.py`` requires every accepted extension to have an
 * explicit MIME, so the fallback that produced those spellings is
 * unreachable for a served recording.
 *
 * Empty until the payload lands, which is before any recording can be
 * fetched; an unknown MIME falls back to ``bin`` exactly as before.
 */
const MIME_TO_AUDIO_EXT: Record<string, string> = {};

// RFC 6266 Content-Disposition filename parser.
// Handles:
//   - filename="audio.webm"
//   - filename=audio.webm
//   - filename*=UTF-8''audio.webm  (RFC 5987 percent-encoded)
// Returns "" when the header is absent, malformed, or contains a path
// separator (defensive against backend bugs that could let a server
// dictate where the upload will be persisted client-side).
function parseContentDispositionFilename(header: string): string {
  if (!header) return "";
  // RFC 5987 / 6266 ext-value (UTF-8'') takes precedence over the plain form.
  const extMatch = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extMatch) {
    try {
      const decoded = decodeURIComponent(extMatch[2].trim());
      if (decoded && !/[\\/]/.test(decoded)) return decoded;
    } catch {
      // Fall through to plain parser.
    }
  }
  const plainMatch = /filename\s*=\s*("([^"]+)"|([^;]+))/i.exec(header);
  if (plainMatch) {
    const raw = (plainMatch[2] ?? plainMatch[3] ?? "").trim();
    if (raw && !/[\\/]/.test(raw)) return raw;
  }
  return "";
}

// Fetch the saved audio file from the backend with HONEST extension
// and MIME — both derived from the backend's response headers, which
// are the single source of truth for the on-disk file's actual
// container.
//
// ROOT CAUSE this replaces (Re-transcribe failure on packaged builds):
//   The previous Re-transcribe path did:
//     audioFile = new File([blob], savedName.replace(/\.txt$/, ".wav"),
//                            { type: "audio/wav" });
//   But the on-disk audio is usually ``.webm`` (live recordings) —
//   ``selectCanonicalCapturedAudio`` writes ``live-<ts>.webm`` for
//   the streaming path. Forcing ``.wav`` + ``audio/wav`` on a WebM
//   payload breaks BOTH provider paths:
//     - Deepgram REST: routes via Content-Type → mismatch → HTTP 400
//       "invalid audio data".
//     - Local Whisper: backend's ``ensure_wav_16k`` fast-path tries
//       ``soundfile.info`` on the ``.wav``-named bytes; fails; falls
//       through to ffmpeg, which sniffs WebM correctly when ffmpeg
//       is bundled but raises a generic exception (NOT AudioError)
//       when ffmpeg degrades silently — uncaught by the AudioError
//       handler at main.py:2823 → HTTP 500.
//   Both fail simultaneously on a valid 1.3 MB recording — exactly
//   the user-reported symptom.
//
// ROOT CAUSE this also replaces (OPFS-dangling blob on Re-transcribe):
//   The same handler also had a "prefer in-memory ``audioState.file``
//   over backend GET" branch that broke after pcmSink.destroy() ran:
//   the lazy ``Blob([header, opfsSpool])`` composite reads as zero
//   bytes once OPFS reaps the spool. Same class as the e2a39c8
//   playback bug; the playback path was already migrated to backend-
//   served URL but Re-transcribe was missed.
//
// Strategy: ALWAYS go through the backend HTTP endpoint. The disk
// file is the canonical source. Round-trip cost is loopback (<10ms
// for typical 1-2 MB recordings) — negligible compared to the
// transcription job that follows.
async function fetchSavedAudioFromBackend(
  savedName: string,
  archiveDir: string,
): Promise<File> {
  const tFetch = performance.now();
  const audioUrl = latestRecordingAudioUrl(savedName, archiveDir);
  if (!audioUrl) throw new Error("Saved recording name is missing.");
  const audioResp = await fetch(audioUrl, { headers: authHeaders() });
  if (!audioResp.ok) {
    console.log(`[trace fetchAudio] FAIL ${traceAudioRefStats(savedName, archiveDir)} status=${audioResp.status} statusText="${audioResp.statusText}" durMs=${(performance.now() - tFetch).toFixed(0)}`);
    throw new Error(`Audio fetch failed: HTTP ${audioResp.status} ${audioResp.statusText}`.trim());
  }
  const audioBlob = await audioResp.blob();
  if (audioBlob.size === 0) {
    console.log(`[trace fetchAudio] FAIL empty body ${traceAudioRefStats(savedName, archiveDir)} durMs=${(performance.now() - tFetch).toFixed(0)}`);
    // Defensive: a 200 OK with an empty body would otherwise look
    // healthy at the upload boundary and only fail downstream inside
    // ffmpeg/libsndfile with a vague "invalid data" error. Surface
    // the truncation here so the user-facing message is precise.
    throw new Error("Audio fetch returned an empty file.");
  }
  // Backend's Content-Type header IS the SSOT — never override it
  // with a local guess. A missing/blank header is the only case we
  // synthesize a fallback for.
  const headerType = (audioResp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const mimeType = headerType || audioBlob.type || "application/octet-stream";
  // Filename: prefer backend's Content-Disposition (the on-disk file
  // name verbatim), then fall back to the savedName stem with the
  // canonical extension for the MIME type, then the savedName stem
  // with .bin (very last resort — should never trigger in practice).
  const dispositionFilename = parseContentDispositionFilename(
    audioResp.headers.get("content-disposition") || "",
  );
  const filename = dispositionFilename
    || (savedName.endsWith(".txt")
      ? savedName.replace(/\.txt$/, "." + (MIME_TO_AUDIO_EXT[mimeType] || "bin"))
      : savedName);
  console.log(`[trace fetchAudio] OK ${traceAudioRefStats(savedName, archiveDir, filename)} mime="${mimeType}" sizeBytes=${audioBlob.size} durMs=${(performance.now() - tFetch).toFixed(0)}`);
  return new File([audioBlob], filename, { type: mimeType });
}

/**
 * Enable/disable the transport and say why through the player itself.
 *
 * The row used to carry a trailing text label ("No recording yet",
 * "Audio unavailable", or the file size). It competed with the player
 * for horizontal space — squeezing the transport until the duration
 * read-out overflowed the player's border — and two of its three states
 * were redundant with the disabled styling right next to it.
 *
 * The empty state now reads as a disabled player, which is what a
 * disabled player already means. The one state that carries real
 * information the user cannot otherwise infer — audio that was expected
 * but could not be loaded — is a genuine failure, so it goes to the
 * pane's session notice where every other failure in this pane already
 * appears, and to the player's own tooltip.
 */
function setPlayerEnabled(enabled: boolean, reason = ""): void {
  for (const id of ["cpPlayBtn", "cpSeek"]) {
    const el = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null;
    if (el) el.disabled = !enabled;
  }
  const player = document.getElementById("currentRecordingPlayer");
  if (player) {
    if (reason) player.title = reason;
    else player.removeAttribute("title");
  }
}

/** One sentence, two surfaces (the disabled player and the session notice). */
const AUDIO_LOAD_FAILED_TEXT = "Audio for this recording could not be loaded.";

async function renderLatestSavedAudio(): Promise<void> {
  const renderSeq = ++currentRecordingAudioRenderSeq;
  const row = $("currentRecordingAudioRow");
  const audioEl = $("currentRecordingAudio") as HTMLAudioElement;

  // Compute the new playback URL FIRST. If the desired URL equals the
  // currently-playing one, do nothing — previously we unconditionally
  // `pause() + removeAttribute("src") + load()` on every refresh,
  // which reset playback to position 0 even when called from a
  // routine `loadRecordings(true)` triggered by an unrelated save.
  // Real-world symptom: user starts playing back audio via the
  // native <audio controls>, a concurrent save refresh fires this
  // function, and playback jumps to the start mid-listen.
  const desiredBackendKey = latestSavedAudioState?.savedName
    ? `${latestSavedAudioState.savedName}\n${latestSavedAudioState.archiveDir || ""}`
    : "";
  // If the audio source isn't changing AND we already have a src
  // attribute, skip the disruptive reset. We only need to ensure
  // the row is shown and meta is up to date.
  //
  // Updated for the backend-URL-prefer fix: with savedName set we
  // play from the backend URL even when ``file`` is also present.
  // The skip-rerender guard now applies whenever the CURRENTLY-
  // ATTACHED src matches the desired backend URL — regardless of
  // whether ``file`` exists. Without this update, the second
  // setCurrentRecordingAudio call (post-save, with savedName) was
  // forced through a full re-render, revoking + re-creating an
  // unused ObjectURL on every save tick.
  if (
    latestSavedAudioState
    && latestSavedAudioState.savedName
    && desiredBackendKey
    && currentRecordingAudioSourceKey === desiredBackendKey
    && !!audioEl.getAttribute("src")
  ) {
    row.hidden = false;
    const retranscribeBtn = document.getElementById("retranscribeBtn");
    if (retranscribeBtn) {
      retranscribeBtn.hidden = !latestSavedAudioState.savedName;
    }
    return;
  }

  audioEl.pause();
  revokeCurrentRecordingAudioUrl();

  if (!latestSavedAudioState) {
    // The player row is a permanent part of the Transcribe pane: with no
    // recording yet it renders as a disabled empty state, never hides.
    // The seek thumb parks at the START (a dot at the beginning), and
    // both time labels reset.
    audioEl.pause();
    audioEl.removeAttribute("src");
    audioEl.load();
    setPlayerEnabled(false, "No recording yet.");
    const seekEl = document.getElementById("cpSeek") as HTMLInputElement | null;
    const curEl = document.getElementById("cpCurrentTime") as HTMLSpanElement | null;
    const durEl = document.getElementById("cpDuration") as HTMLSpanElement | null;
    if (seekEl) seekEl.value = "0";
    if (curEl) curEl.textContent = PLAYER_TIME_ZERO;
    if (durEl) durEl.textContent = PLAYER_TIME_ZERO;
    return;
  }

  // Source preference order:
  //   1. Backend refetch when savedName is known — DURABLE: the backend
  //      wrote the file to disk via atomic_write_bytes, and the renderer
  //      fetches it with header auth before attaching a blob URL.
  //   2. In-memory blob URL when the file is fresh from MediaRecorder /
  //      PcmSink and not yet uploaded to backend (the recording-just-
  //      stopped window before save completes — typically <500 ms).
  //
  // ROOT CAUSE for "audio doesn't play on Windows" (user report):
  //   OpfsPcmSink.finalize() returns a ``File`` whose Blob references
  //   the OPFS-backed spool lazily — ``new Blob([header, spool])``.
  //   When deferredSinkDestroy.destroy() removes the OPFS file (right
  //   after the upload completes), the lazy blob composite is
  //   effectively a dangling pointer. Chromium on macOS happens to
  //   cache blob bytes more aggressively in this scenario, so the
  //   <audio> element kept playing. Chromium on Windows reads blob
  //   bytes lazily on play, hits the deleted OPFS handle, and the
  //   media element fires a silent error code=4 (src-not-supported).
  //
  //   Switching to a backend-authenticated blob once savedName is set
  //   bypasses the OPFS lifecycle entirely — same bytes, durable.
  //   The blob URL stays as the first-render fallback for the brief
  //   pre-save window.
  let playbackUrl = "";
  let playbackSourceKey = "";
  if (latestSavedAudioState.savedName) {
    try {
      const audioFile = await fetchSavedAudioFromBackend(
        latestSavedAudioState.savedName,
        latestSavedAudioState.archiveDir || "",
      );
      if (renderSeq !== currentRecordingAudioRenderSeq) return;
      playbackUrl = URL.createObjectURL(audioFile);
      playbackSourceKey = desiredBackendKey;
    } catch (e) {
      // The staleness guard has to be repeated here. It sat only on the
      // success branch, so a rejected fetch — which happens on the
      // ordinary path, because the backend prunes archived audio by
      // retention on every save — carried a superseded render all the
      // way through: it overwrote ``currentRecordingAudioObjectUrl``
      // (leaking the fresh render's multi-megabyte blob for the rest of
      // the session), pointed the player at the PREVIOUS recording, and
      // pinned that substitution through the source-key skip guard.
      // ``openRecording`` gets this right; this function did not.
      if (renderSeq !== currentRecordingAudioRenderSeq) return;
      console.warn("Saved audio playback fetch failed; falling back to in-memory file", e);
    }
  }
  if (renderSeq !== currentRecordingAudioRenderSeq) return;
  if (!playbackUrl && latestSavedAudioState.file) {
    playbackUrl = URL.createObjectURL(latestSavedAudioState.file);
    playbackSourceKey = latestSavedAudioState.savedName
      ? `${desiredBackendKey}\nfallback-file`
      : "session-file";
  }
  if (!playbackUrl) {
    audioEl.pause();
    audioEl.removeAttribute("src");
    audioEl.load();
    // A real failure: audio was expected for this recording and could
    // not be loaded from the backend or from memory. Surface it where
    // the pane's other failures appear rather than in a label the user
    // has to notice.
    setPlayerEnabled(false, AUDIO_LOAD_FAILED_TEXT);
    showRecordSessionNotice(AUDIO_LOAD_FAILED_TEXT, "warning", UI_TOKENS.notice.briefMs);
    return;
  }
  // Track ObjectURL ownership so revokeCurrentRecordingAudioUrl can
  // free it later. Media never receives the persistent API token in URL.
  setPlayerEnabled(true);
  currentRecordingAudioObjectUrl = playbackUrl;
  currentRecordingAudioSourceKey = playbackSourceKey;
  audioEl.src = playbackUrl;
  audioEl.load();
  row.hidden = false;
  // Show Re-transcribe button when we have a saved audio file
  const retranscribeBtn = document.getElementById("retranscribeBtn");
  if (retranscribeBtn) {
    retranscribeBtn.hidden = !latestSavedAudioState.savedName;
  }
}

function setLatestSavedAudio(state: LatestSavedAudioState | null): void {
  latestSavedAudioState = state
    ? {
      title: String(state.title || "").trim() || "Recording audio",
      savedName: String(state.savedName || "").trim(),
      archiveDir: String(state.archiveDir || "").trim(),
      sizeBytes: Math.max(0, Number(state.sizeBytes) || 0),
      downloadName: String(state.downloadName || "").trim(),
      mimeType: String(state.mimeType || "").trim(),
      file: state.file || null,
    }
    : null;
  void renderLatestSavedAudio();
}

function setCurrentRecordingAudio(file: File | null, savedName = "", archiveDir = "", sessionToken = ""): void {
  if (sessionToken && !isCurrentUiSession(sessionToken)) return;
  if (!file) {
    setLatestSavedAudio(null);
    return;
  }
  setLatestSavedAudio({
    title: savedName ? "Saved audio" : "Session audio",
    savedName,
    archiveDir,
    sizeBytes: file.size,
    downloadName: file.name || "recording.wav",
    mimeType: file.type || "",
    file,
  });
}

// Wire the explicit Download button (added in index.html because the
// native <audio controls> three-dot "Download" entry doesn't reliably
// appear in Electron on Windows for blob: URLs).
//
// We re-derive the URL on click rather than caching it so the button
// always points at the freshest source — when the user re-transcribes
// the same audio, the in-memory File is replaced and the cached URL
// would otherwise download the previous take.
// ── Custom player controls ───────────────────────────────────────────
// The native <audio controls> chrome looks like a web widget inside the
// Electron shell. The audio element stays (hidden) as the media engine;
// every control below is app-styled DOM driving it programmatically.
(() => {
  const audio = document.getElementById("currentRecordingAudio") as HTMLAudioElement | null;
  const playBtn = document.getElementById("cpPlayBtn") as HTMLButtonElement | null;
  const seek = document.getElementById("cpSeek") as HTMLInputElement | null;
  const cur = document.getElementById("cpCurrentTime") as HTMLSpanElement | null;
  const dur = document.getElementById("cpDuration") as HTMLSpanElement | null;
  if (!audio || !playBtn || !seek || !cur || !dur) return;
  // One clock for the whole app: this used to be a third formatter
  // with a fourth format (``m:ss`` against fmtTime's ``mm:ss``), so the
  // player and the live timer disagreed about the same duration.
  // fmtTime coerces a non-finite duration — an <audio> element that has
  // no metadata yet reports NaN — to the same zero the labels start at.
  const fmt = fmtTime;
  const syncPlayIcon = (): void => {
    playBtn.textContent = audio.paused ? "▶" : "❚❚";
    playBtn.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  };
  playBtn.addEventListener("click", () => {
    if (audio.paused) void audio.play().catch(() => { /* no src yet */ });
    else audio.pause();
  });
  audio.addEventListener("play", syncPlayIcon);
  audio.addEventListener("pause", syncPlayIcon);
  audio.addEventListener("ended", () => { audio.currentTime = 0; syncPlayIcon(); });
  let seekDragging = false;
  audio.addEventListener("timeupdate", () => {
    cur.textContent = fmt(audio.currentTime);
    if (!seekDragging) {
      seek.value = String(audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0);
    }
  });
  audio.addEventListener("loadedmetadata", () => { dur.textContent = fmt(audio.duration); });
  seek.addEventListener("input", () => {
    if (audio.duration) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
  });
  seek.addEventListener("pointerdown", () => { seekDragging = true; });
  seek.addEventListener("pointerup", () => { seekDragging = false; });
  syncPlayIcon();
})();

(() => {
  const btn = document.getElementById("currentRecordingDownloadBtn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!latestSavedAudioState) return;
    const file = latestSavedAudioState.file;
    const fileName = latestSavedAudioState.downloadName
      || latestSavedAudioState.savedName
      || "recording.wav";
    // Mirror the playback source-preference order from
    // renderLatestSavedAudio: prefer the backend URL once savedName
    // is set (durable, OPFS-independent), fall back to the in-memory
    // File blob only during the brief pre-save window.
    let url = "";
    let revokeAfter = false;
    try {
      if (latestSavedAudioState.savedName) {
        const audioFile = await fetchSavedAudioFromBackend(
          latestSavedAudioState.savedName,
          latestSavedAudioState.archiveDir || "",
        );
        url = URL.createObjectURL(audioFile);
        revokeAfter = true;
      } else if (file) {
        url = URL.createObjectURL(file);
        revokeAfter = true;
      }
    } catch (e) {
      console.warn("Audio download fetch failed", e);
      setStatus(`Audio download failed: ${sanitizeUiErrorMessage(e, "Could not download audio.")}`, "error");
      return;
    }
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (revokeAfter) {
      // Defer revoke so the browser's download stream finishes reading
      // the blob first. 30 s is generous for a multi-MB recording.
      window.setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch { /* idempotent */ }
      }, 30_000);
    }
  });
})();

// Audio element error handler — Windows users reported playback fails
// on the just-recorded clip. Without this hook the failure was silent;
// now any media-element error is logged so we can diagnose codec /
// MIME / blob-revocation issues from the support bundle.
(() => {
  const audioEl = document.getElementById("currentRecordingAudio") as HTMLAudioElement | null;
  if (!audioEl) return;
  audioEl.addEventListener("error", () => {
    const err = audioEl.error;
    const code = err ? err.code : -1;
    const msg = err ? (err.message || "") : "";
    const src = audioEl.currentSrc || audioEl.src || "";
    const fileType = latestSavedAudioState?.file?.type || "";
    console.warn(`[currentRecordingAudio] media error code=${code} msg=${msg} mime=${fileType} src=${src.slice(0, 120)}`);
  });
})();

function providerLabel(provider: string): string {
  const value = String(provider || "").trim().toLowerCase();
  if (!value || value === "unknown") return "Unknown";
  if (value === "none") return "None";
  if (value === "local") return "Local";
  if (value === "openrouter") return "OpenRouter";
  if (value === "deepgram") return "Deepgram";
  return provider;
}

/**
 * The order the three providers are shown in, wherever a list of them
 * is shown. Was written out twice in a row inside the stats renderer,
 * three lines apart, as the third copy of a fact already stated by
 * ``providerLabel`` and by the ``Provider`` type.
 */
const PROVIDER_DISPLAY_ORDER: ReadonlyArray<string> = ["local", "openrouter", "deepgram"];

/**
 * Whether a provider name recorded in the archive is one this build has.
 *
 * The archive spans versions: recordings made before a provider was
 * removed still carry its name, under whatever spellings that provider
 * ever used ("fal", "fal.ai", "falai" for the one removed so far). They
 * are not errors and not worth a chart entry.
 */
const RETIRED_PROVIDER_NAMES: ReadonlySet<string> = new Set(["fal", "fal.ai", "falai"]);

function isKnownProviderName(name: string): boolean {
  const key = String(name || "").trim().toLowerCase();
  return !!key && !RETIRED_PROVIDER_NAMES.has(key);
}

function normalizeProviderSelection(value: unknown, fallback: Provider = "local"): Provider {
  const provider = String(value ?? "").trim();
  if (provider === "" || provider === "local" || provider === "openrouter" || provider === "deepgram") {
    return provider;
  }
  return fallback;
}

const REMOTE_SMALL_AUDIO_BYTES = 1 * 1024 * 1024;
const DEEPGRAM_SMALL_AUDIO_UI_TIMEOUT_MS = UI_TOKENS.finalize.smallAudioUiMs;
const LIVE_SHORT_EMPTY_RECOVERY_TIMEOUT_MS = UI_TOKENS.finalize.shortEmptyRecoveryMs;
const LIVE_DEFAULT_EMPTY_RECOVERY_TIMEOUT_MS = UI_TOKENS.finalize.defaultEmptyRecoveryMs;
function isRemoteProvider(provider: Provider): provider is RemoteProvider {
  return provider === "openrouter" || provider === "deepgram";
}

function isRemoteProviderReachable(provider: Provider, providerReachabilityHint = false): boolean {
  return isRemoteProvider(provider) && (providerReachabilityHint || isNetworkOnline);
}

function remoteProviderOfflineMessage(provider: Provider): string {
  return `${providerLabel(provider)} is unavailable because the internet probe is offline.`;
}

function inferRemoteJobTimeoutMs(file: File, provider: Provider): number | null {
  if (provider === "deepgram" && file.size > 0 && file.size <= REMOTE_SMALL_AUDIO_BYTES) {
    return DEEPGRAM_SMALL_AUDIO_UI_TIMEOUT_MS;
  }
  return null;
}

function createLinkedAbortSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | null,
): { signal: AbortSignal | undefined; cleanup: () => void; didTimeout: () => boolean } {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: parentSignal,
      cleanup: () => { },
      didTimeout: () => false,
    };
  }
  const controller = new AbortController();
  let timeoutId: number | null = null;
  let timedOut = false;
  const cleanup = () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
    parentSignal?.removeEventListener("abort", onParentAbort);
  };
  const onParentAbort = () => {
    cleanup();
    controller.abort();
  };
  timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (parentSignal?.aborted) {
    cleanup();
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup,
    didTimeout: () => timedOut,
  };
}

function traceTextStats(label: string, text: string): string {
  const value = String(text || "");
  return `${label}Len=${value.length} ${label}Words=${countWords(value)}`;
}

function traceAudioRefStats(savedName = "", archiveDir = "", filename = ""): string {
  const name = String(savedName || "");
  const dir = String(archiveDir || "");
  const file = String(filename || "");
  return `savedNameLen=${name.length} archiveDirSet=${dir.trim() ? "1" : "0"} filenameLen=${file.length}`;
}

function sanitizeUiErrorMessage(error: unknown, fallback: string): string {
  const raw = normalizeTranscriptWhitespace(String((error as Error)?.message || error || ""));
  if (!raw) return fallback;
  // Promote raw network failures (TypeError "Failed to fetch",
  // NetworkError, ECONNREFUSED) into the human-readable offline /
  // VPN-needed message BEFORE the sanitize pass would filter them
  // as generic "TypeError".
  const lowRaw = raw.toLowerCase();
  if (
    isGenericFetchFailure(lowRaw) ||
    // Any Deepgram-shaped backend error — file-transcription path
    // (via sanitizeUiErrorMessage) must get the same VPN/region
    // guidance as the live-stream path. Without this, Deepgram
    // REST errors leak raw into the file-transcribe UI.
    lowRaw.startsWith("deepgram ")
  ) {
    return explainNetworkError(error);
  }
  const cleaned = raw
    .replace(/^(referenceerror|typeerror|error):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  if (
    /is not defined/i.test(cleaned) ||
    /cannot read properties/i.test(cleaned) ||
    /undefined is not an object/i.test(cleaned) ||
    /script error/i.test(cleaned) ||
    /failed to fetch dynamically imported module/i.test(cleaned) ||
    /unexpected token/i.test(cleaned)
  ) {
    return fallback;
  }
  // Length cap raised from 160 → 800 chars. The 160 cap was a defensive
  // filter against raw stack traces leaking into the UI, but it ALSO
  // truncated legitimate actionable error messages from
  // ``request_with_retry`` that include both the underlying network
  // error AND a one-liner hint ("upload timed out — file too large
  // for current upload speed; try smaller file or switch to local").
  // Such hints run ~200-280 chars and were silently dropped to the
  // fallback "Transcription failed." — the screenshot the user showed
  // had exactly this symptom: bare fallback with no detail. 800 chars
  // is plenty for any actionable backend message; raw stack traces
  // are filtered by the regex tests above (which trigger the fallback
  // before we ever reach the length comparison).
  return cleaned.length > 800 ? fallback : cleaned;
}

function normalizeTranscriptSegment(raw: unknown, timeOffsetSec = 0): TranscriptSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown };
  const text = normalizeTranscriptWhitespace(String(source.text || ""));
  const start = Math.max(0, Number(source.start || 0) + timeOffsetSec);
  const end = Math.max(start, Number(source.end || 0) + timeOffsetSec);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  // The backend also attaches per-word times to every final segment
  // (``normalize_words`` in ``remote_deepgram_live``). They are not
  // parsed: the only thing that ever read them was the renderer's
  // seam-time merge of two readings, and there is one reading now. The
  // words still travel on the wire for the backend's own splice, which
  // is where placing a word by its time belongs.
  const segment: TranscriptSegment = { start, end, text };
  if (source.speaker !== undefined && source.speaker !== null) {
    const speakerIndex = Number(source.speaker);
    if (Number.isFinite(speakerIndex) && speakerIndex >= 0) {
      segment.speaker = Math.floor(speakerIndex);
    }
  }
  return segment;
}

function mergeTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (!segments.length) return [];
  const epsilon = UI_TOKENS.finalize.segmentEpsilonSec;
  // Speaker-aware equality. Both undefined ↔ both undefined (mono
  // stream); a numbered speaker on one side and undefined on the
  // other counts as DIFFERENT (don't conflate diarized into mono).
  // Two distinct speaker indices are ALWAYS different — even when
  // the text and timing happen to match, they're genuinely two
  // utterances and must both be kept. Without this gate, a
  // call-recording with cross-talk where speaker 0 and speaker 1
  // utter "yeah" within the same epsilon window had ONE of them
  // silently dropped from the transcript and the auto-paste was
  // missing a turn. Subtle data-loss bug visible only with
  // diarize=on.
  const sameSpeaker = (a: TranscriptSegment, b: TranscriptSegment): boolean =>
    a.speaker === b.speaker;
  // Sort by start asc, then end DESC, then speaker asc. The
  // longer / later-ending segment for the same (start, speaker)
  // lands FIRST in the merged list, so the shorter overlapping
  // interim that follows is dropped by the is-prefix-of-prev test
  // below. Without the descending end-tie-break the shorter
  // interim arrived first and the longer final was kept,
  // leaving both in the transcript and producing visible
  // duplication — exactly the user-reported "Просто расскажу," +
  // "Просто расскажу кратко. И ты тоже" pattern within a single
  // recording. The speaker tertiary keeps diarized output
  // deterministic when two speakers share a start tick.
  const ordered = [...segments].sort(
    (a, b) =>
      (a.start - b.start) ||
      (b.end - a.end) ||
      ((a.speaker ?? -1) - (b.speaker ?? -1)),
  );
  const merged: TranscriptSegment[] = [];
  for (const segment of ordered) {
    const prev = merged[merged.length - 1];
    // 1. Exact duplicate (same speaker, same timing, same text): drop.
    if (
      prev &&
      sameSpeaker(prev, segment) &&
      Math.abs(prev.start - segment.start) <= epsilon &&
      Math.abs(prev.end - segment.end) <= epsilon &&
      prev.text === segment.text
    ) {
      continue;
    }
    // 2. Prefix-overlap dedup: when a later interim emission shares
    //    the same start AND speaker as a kept segment AND its text
    //    is a strict prefix of the kept segment's text (within
    //    whitespace normalisation), drop the shorter interim.
    //    Deepgram streaming emits this pattern: an interim
    //    "Сергей привет" is followed by the final "Сергей привет,
    //    как дела" — both arrive with identical start times. The
    //    previous merge only dropped EXACT duplicates so both ended
    //    up in the transcript, the user saw their utterance twice
    //    in the paste, and the auto-paste delivered both halves
    //    back-to-back. Comparing on whitespace-normalised lowercase
    //    guards against trailing-comma / spacing differences
    //    between the two emissions ("hello world," vs "hello world
    //    , "). Speaker-aware: cross-talk between two speakers at
    //    the same start is preserved.
    if (
      prev &&
      sameSpeaker(prev, segment) &&
      Math.abs(prev.start - segment.start) <= epsilon
    ) {
      const prevNorm = prev.text.replace(/\s+/g, " ").trim().toLowerCase();
      const curNorm = segment.text.replace(/\s+/g, " ").trim().toLowerCase();
      if (prevNorm.startsWith(curNorm)) {
        // Current segment's text is wholly contained in prev (which
        // ended later thanks to the descending end-tie-break) → drop.
        continue;
      }
      if (curNorm.startsWith(prevNorm)) {
        // Reverse case — shouldn't happen with the desc-end sort
        // but defensive: replace prev with the longer segment.
        merged[merged.length - 1] = segment;
        continue;
      }
    }
    merged.push(segment);
  }
  return merged;
}

/**
 * Format an ordered list of transcript segments for display.
 *
 * When ``speaker`` is populated (Deepgram diarize), consecutive
 * segments from the same speaker are coalesced under one ``Speaker N:``
 * prefix. Speaker transitions start a new paragraph so the user can
 * visually separate voices in the live preview.
 */
function formatSegmentsForDisplay(segments: TranscriptSegment[], separator: string): string {
  if (!segments.length) return "";
  const parts: string[] = [];
  let lastSpeaker: number | undefined;
  for (const seg of segments) {
    const t = seg.text.trim();
    if (!t) continue;
    if (seg.speaker !== undefined && seg.speaker !== lastSpeaker) {
      // New speaker — add a speaker-prefixed chunk.
      if (parts.length) parts.push("\n");
      // Deepgram numbers speakers from 0. "Speaker 0:" is an array
      // index shown to a person; the first speaker is Speaker 1.
      parts.push(`Speaker ${seg.speaker + 1}: ${t}`);
      lastSpeaker = seg.speaker;
    } else {
      if (parts.length && parts[parts.length - 1] !== "\n") {
        parts.push(separator);
      }
      parts.push(t);
    }
  }
  return parts.join("").trim();
}

function recordingTitleFromName(name: string): string {
  return decodeURIComponent(String(name || "").replace(/\.txt$/i, ""));
}

function resetRecordSessionNotice(): void {
  if (recordSessionNoticeTimer) {
    window.clearTimeout(recordSessionNoticeTimer);
    recordSessionNoticeTimer = null;
  }
  const el = $("recordSessionNotice");
  el.hidden = true;
  el.className = "session-notice";
  $("recordSessionNoticeText").textContent = "";
}

function showRecordSessionNotice(
  message: string,
  tone: UiTone = "info",
  timeoutMs: number = UI_TOKENS.notice.defaultMs,
  sessionToken = "",
): void {
  if (!isCurrentUiSession(sessionToken)) return;
  const text = String(message || "").trim();
  if (!text) {
    resetRecordSessionNotice();
    return;
  }
  // Show ALL tones (info, success, warning, error) — previously info/success
  // would silently call resetRecordSessionNotice() and return without showing
  // the message, which also dismissed any active warning banner. Now every
  // tone with a non-empty message is surfaced; warnings/errors stay until
  // their timer fires rather than being killed by a subsequent success event.
  if (recordSessionNoticeTimer) {
    window.clearTimeout(recordSessionNoticeTimer);
    recordSessionNoticeTimer = null;
  }
  const el = $("recordSessionNotice");
  el.hidden = false;
  el.className = `session-notice ${tone}`;
  $("recordSessionNoticeText").textContent = text;
  if (timeoutMs > 0) {
    recordSessionNoticeTimer = window.setTimeout(() => {
      resetRecordSessionNotice();
    }, timeoutMs);
  }
}

/**
 * Render the current recording summary to the live DOM.
 *
 * The summary is the SSOT for "what is happening right now". Every time
 * it changes we push:
 *   - the status text into the header status pill (``setStatus``)
 *   - warning/error tones into the session notice banner so the user
 *     gets a persistent visual cue without extra wiring at call sites.
 *
 * Rendering is debounced against a previous-state snapshot so that no
 * identical status line is re-broadcast twice. This keeps the notice
 * banner from flashing on repeated patches with the same text.
 */
let lastRenderedStatusText = "";
let lastRenderedStatusTone: UiTone = "neutral";
let lastNoticedStatusKey = "";

function toneToStatusKind(tone: UiTone, fallbackText: string): StatusKind {
  switch (tone) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "success":
      return inferStatusKindFromText(fallbackText) === "recording" ? "recording" : "done";
    case "info":
      return inferStatusKindFromText(fallbackText) === "recording" ? "recording" : "processing";
    default:
      return inferStatusKindFromText(fallbackText);
  }
}

function inferStatusKindFromText(text: string): StatusKind {
  const t = (text || "").trim();
  const lower = t.toLowerCase();
  if (!t) return "idle";
  if (lower === "idle") return "idle";
  if (
    lower === "done" ||
    lower.startsWith("recording completed") ||
    lower.startsWith("final transcript is ready") ||
    lower.startsWith("transcript is ready")
  ) {
    return "done";
  }
  if (lower === "error" || lower === "backend error" || lower.startsWith("error")) return "error";
  if (
    lower === "recording" ||
    lower.startsWith("recording.") ||
    lower.startsWith("recording with ") ||
    lower.startsWith("recording audio only") ||
    lower.startsWith("recording exceeds ")
  ) {
    return "recording";
  }
  if (
    lower === "processing" ||
    lower.startsWith("processing") ||
    lower === "starting" ||
    lower === "refining..." ||
    lower.startsWith("finalizing") ||
    lower.startsWith("transcribing") ||
    lower.startsWith("upscaling")
  ) {
    return "processing";
  }
  return "info";
}

let lastRenderedLatencyMs: number | null = null;

function renderCurrentRecordingSummary(
  summary: CurrentRecordingSummary | null,
  sessionToken = ""
): void {
  if (!summary) {
    lastRenderedStatusText = "";
    lastRenderedStatusTone = "neutral";
    lastNoticedStatusKey = "";
    lastRenderedLatencyMs = null;
    // Reset the shared status surface to an explicit idle state so the
    // topbar never keeps the previous session's "Done"/"Upscaling" label.
    setStatus("", "idle");
    return;
  }
  const status = String(summary.status || "").trim();
  const tone = (summary.tone || "neutral") as UiTone;
  if (status && (status !== lastRenderedStatusText || tone !== lastRenderedStatusTone)) {
    lastRenderedStatusText = status;
    lastRenderedStatusTone = tone;
    setStatus(status, toneToStatusKind(tone, status));
    if (tone === "warning" || tone === "error") {
      const noticeKey = `${tone}::${status}`;
      if (noticeKey !== lastNoticedStatusKey) {
        lastNoticedStatusKey = noticeKey;
        showRecordSessionNotice(status, tone, UI_TOKENS.notice.defaultMs, sessionToken);
      }
    }
  }
  if (
    summary.transcribeLatencyMs !== undefined &&
    summary.transcribeLatencyMs !== lastRenderedLatencyMs
  ) {
    lastRenderedLatencyMs = summary.transcribeLatencyMs;
    $("transcribeLatency").textContent = fmtMs(summary.transcribeLatencyMs);
  }
}

function setCurrentRecordingSummary(summary: CurrentRecordingSummary | null, sessionToken = ""): void {
  if (!isCurrentUiSession(sessionToken)) return;
  currentRecordingSummary = summary ? { ...summary } : null;
  renderCurrentRecordingSummary(currentRecordingSummary, sessionToken);
}

function patchCurrentRecordingSummary(patch: Partial<CurrentRecordingSummary>, sessionToken = ""): void {
  if (!isCurrentUiSession(sessionToken)) return;
  const next: CurrentRecordingSummary = {
    title: currentRecordingSummary?.title || "Recording summary",
    status: currentRecordingSummary?.status || "",
    tone: currentRecordingSummary?.tone || "neutral",
    ...(currentRecordingSummary || {}),
    ...patch,
  };
  setCurrentRecordingSummary(next, sessionToken);
}

let deferredRecordingsRefreshPending = false;
let deferredRecordingsRefreshInFlight = false;
let deferredRecordingsRefreshTimer = 0;
let deferredRecordingsRefreshLastSaved: SavedRecordingRef | null = null;
let mainProcessRecordingStatus = "Idle";

function isMainProcessRecordingStatusActive(status = mainProcessRecordingStatus): boolean {
  const value = String(status || "").trim().toLowerCase();
  return !!value && value !== "idle";
}

/**
 * @param reason why the refresh was scheduled. Traced, not branched on —
 *   five call sites compute a distinct label and it used to be received
 *   as `_reason` and dropped, so the labels described nothing.
 */
function scheduleDeferredRecordingsRefresh(
  reason = "save",
  delayMs: number = UI_TOKENS.recordings.deferredRefreshMs,
): void {
  if (!deferredRecordingsRefreshPending) return;
  if (deferredRecordingsRefreshTimer) {
    window.clearTimeout(deferredRecordingsRefreshTimer);
  }
  deferredRecordingsRefreshTimer = window.setTimeout(() => {
    deferredRecordingsRefreshTimer = 0;
    void flushDeferredRecordingsRefresh(reason);
  }, Math.max(0, delayMs));
}

function requestDeferredRecordingsRefresh(saved: SavedRecordingRef | null, reason = "save"): void {
  deferredRecordingsRefreshPending = true;
  if (saved?.name) {
    deferredRecordingsRefreshLastSaved = {
      name: saved.name,
      archiveDir: saved.archiveDir || "",
    };
  }
  if (isBusy || stopTransitionInFlight || isRecording || isMainProcessRecordingStatusActive()) return;
  scheduleDeferredRecordingsRefresh(reason);
}

async function flushDeferredRecordingsRefresh(reason = "manual"): Promise<void> {
  if (!deferredRecordingsRefreshPending || deferredRecordingsRefreshInFlight) return;
  if (isBusy || stopTransitionInFlight || isRecording || recordingsUiLoading || isMainProcessRecordingStatusActive()) {
    scheduleDeferredRecordingsRefresh(reason, UI_TOKENS.recordings.deferredRefreshBusyRetryMs);
    return;
  }

  deferredRecordingsRefreshPending = false;
  deferredRecordingsRefreshInFlight = true;
  const pendingTarget = deferredRecordingsRefreshLastSaved
    ? { ...deferredRecordingsRefreshLastSaved }
    : null;
  const selectedKeyBeforeRefresh = selectedRecordingKey();
  const shouldReopenSelected =
    !!pendingTarget?.name &&
    selectedKeyBeforeRefresh === recordingIdentityKey(pendingTarget.name, pendingTarget.archiveDir);
  try {
    await loadRecordings({
      keepSelection: true,
      background: true,
      reopenSelected: shouldReopenSelected,
    });
  } catch (e) {
    console.warn("Deferred History refresh failed", e);
    const msg = sanitizeUiErrorMessage(e, "Could not refresh the archive.");
    setStatus(`Saved. History refresh failed: ${msg}`, "warning");
  } finally {
    deferredRecordingsRefreshInFlight = false;
    deferredRecordingsRefreshLastSaved = null;
    if (deferredRecordingsRefreshPending) {
      scheduleDeferredRecordingsRefresh("coalesced", UI_TOKENS.recordings.deferredRefreshCoalesceMs);
    }
  }
}

function setBusy(nextBusy: boolean, scopeToken = ""): void {
  const wasBusy = isBusy;
  if (scopeToken) {
    if (nextBusy) {
      busyScopeToken = scopeToken;
    } else if (busyScopeToken && busyScopeToken !== scopeToken) {
      return;
    } else {
      busyScopeToken = "";
    }
  } else if (!nextBusy) {
    busyScopeToken = "";
  }
  isBusy = !!nextBusy;
  ["providerSelect", "remoteModelSelect", "upscaleToggle", "upscalePresetSelect", "upscalePresetAddBtn", "upscalePresetDeleteBtn", "upscalePresetSaveBtn", "upscalePresetCancelBtn", "orKeyActionBtn", "deepgramKeyActionBtn"].forEach((id) => {
    const el = document.getElementById(id) as HTMLButtonElement | HTMLSelectElement | null;
    if (el) el.disabled = isBusy;
  });
  if (wasBusy && !isBusy) {
    scheduleDeferredRecordingsRefresh("busy-release", 380);
  }
}

function setStatusScoped(scopeToken: string, st: string, kind?: StatusKind): void {
  if (!isCurrentUiSession(scopeToken)) return;
  setStatus(st, kind);
}

/**
 * Single writer for the recording flag, and for the control that shows it.
 *
 * Every start/stop path flows through here — the in-window button, the
 * global hotkey, and the main-process status sync — so the button's
 * label and the live pane's preview-off status line change exactly once
 * per transition regardless of which path caused it, and the button
 * cannot drift out of step with a recording the hotkey started.
 */
function setRecordButton(recording: boolean): void {
  const was = isRecording;
  isRecording = !!recording;
  const btn = document.getElementById("recordToggleBtn");
  const label = document.getElementById("recordToggleLabel");
  if (btn) {
    btn.classList.toggle("is-recording", isRecording);
    btn.setAttribute("aria-pressed", isRecording ? "true" : "false");
    btn.title = isRecording ? "Stop recording" : "Start recording";
  }
  if (label) label.textContent = isRecording ? "Stop" : "Record";
  if (was !== isRecording) {
    syncLiveOutputFromState();
  }
}

/**
 * The status dot's modifier class.
 *
 * This was a nineteen-line `switch` mapping each `StatusKind` to a
 * string equal to itself. The class names ARE the kinds — that is the
 * contract with `styles.css`, and spelling it out twice only created a
 * place for the two to disagree. `idle` deliberately has no rule there:
 * the base `.window-status-dot` is the idle appearance.
 */
function statusKindToDotClass(kind: StatusKind): string {
  return kind || "idle";
}

/**
 * Maximum length of the status line, in characters.
 *
 * Two mechanisms used to truncate this one string with two unrelated
 * numbers: this cap, and `max-width: min(360px, 42vw)` plus
 * `text-overflow: ellipsis` in the stylesheet. 42 characters at the
 * pill's 10px font is roughly 250px, so on a wide window the CSS bound
 * never fired and on a narrow one it ellipsised an already-ellipsised
 * string — two "…" in a row.
 *
 * The stylesheet now bounds the pill in `ch` from
 * `--status-pill-max-chars`, so both layers describe the same length;
 * a stylesheet cannot import this file, so the two are pinned together
 * by `tests/styles-tokens.test.ts` — the same arrangement the
 * auto-stop bounds use for `desktop/main.js`. JavaScript still owns
 * WHICH part survives: it prefers the phrase before the first ":" or em
 * dash, which no stylesheet can do, and the full text stays in the
 * hover title and the aria-label.
 */
const STATUS_PILL_MAX_CHARS = 42;


function abbreviateForStatusPill(text: string): string {
  const t = (text || "").trim();
  if (t.length <= STATUS_PILL_MAX_CHARS) return t;
  // Prefer the part before the first ":" or "—" — usually the
  // high-level phrase ("Live stream error") without the raw cause.
  const head = t.split(/[:\u2014\u2013]/)[0].trim();
  if (head && head.length <= STATUS_PILL_MAX_CHARS) return head + "…";
  return t.slice(0, STATUS_PILL_MAX_CHARS - 1).trimEnd() + "…";
}

function setStatus(st: string, kind?: StatusKind): void {
  const full = String(st || "").trim();
  const text = full || "Idle";
  liveStatusText = abbreviateForStatusPill(text);
  liveStatusKind = kind || inferStatusKindFromText(text);
  const pill = document.getElementById("statusPill");
  const dot = document.getElementById("statusDot");
  const label = document.getElementById("statusText");
  if (pill) {
    pill.setAttribute("title", text);
    pill.setAttribute("aria-label", `Application status: ${text}`);
  }
  if (dot) {
    dot.className = `window-status-dot ${statusKindToDotClass(liveStatusKind)}`;
  }
  if (label) {
    label.textContent = liveStatusText;
  }
}

window.__transcriptorSetMainStatus = (status: string, kind?: StatusKind): boolean => {
  mainProcessRecordingStatus = String(status || "Idle").trim() || "Idle";
  setStatus(mainProcessRecordingStatus, kind);
  if (!isMainProcessRecordingStatusActive(mainProcessRecordingStatus)) {
    scheduleDeferredRecordingsRefresh("main-status-release", UI_TOKENS.recordings.deferredRefreshCoalesceMs);
  }
  return true;
};

function setSettingsArchiveStatus(message: string, tone: UiTone = "neutral"): void {
  const el = document.getElementById("settingsArchiveStatus");
  if (!el) return;
  const text = String(message || "").trim();
  el.textContent = text;
  el.hidden = !text;
  el.className = `settings-save-status settings-save-status-${tone}`;
}

/**
 * D-009: pull the Accessibility/paste-capability verdict and show it, or
 * hide the note when there is nothing to act on.
 *
 * Absent bridge (browser dev preview, non-macOS desktop shell) leaves
 * the note exactly as the markup declared it: hidden. A rejected/failed
 * call is swallowed rather than shown, the same call this file already
 * makes for the analogous network probe — a transient IPC hiccup is not
 * evidence of a broken permission and must not flash a false warning.
 */
async function refreshPasteCapabilityNote(): Promise<void> {
  const el = document.getElementById("pasteCapabilityNote");
  const button = document.getElementById("pasteCapabilityRepair") as HTMLButtonElement | null;
  if (!el) return;
  try {
    const status = await window.__transcriptorPasteCapability?.getStatus();
    const fix = String(status?.fix || "").trim();
    const title = String(status?.title || "").trim();
    el.textContent = fix ? `${title} ${fix}` : "";
    el.hidden = !fix;
    if (button) {
      // Offered only when there is a TCC row to drop: a bundle replaced
      // under the running process is repaired by a relaunch, which the
      // note already says.
      button.hidden = !fix || !status?.repairable;
      button.disabled = false;
    }
  } catch (e) {
    console.debug("paste-capability status unavailable", e);
  }
}

/**
 * "Repair permissions": ask main to drop the stale TCC grant so macOS
 * asks again. Everything about WHICH services and HOW lives in the main
 * process (desktop/paste-capability.js); this reports the outcome and
 * re-reads the note, which is the same status the button was shown by.
 */
async function repairPastePermissions(): Promise<void> {
  const button = document.getElementById("pasteCapabilityRepair") as HTMLButtonElement | null;
  const el = document.getElementById("pasteCapabilityNote");
  if (!button || !window.__transcriptorPasteCapability?.repair) return;
  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = "Repairing…";
  let repaired = false;
  try {
    const result = await window.__transcriptorPasteCapability.repair();
    repaired = !!result?.ok;
  } catch (e) {
    console.debug("paste-capability repair failed", e);
  }
  button.textContent = previousLabel || "Repair permissions";
  button.disabled = false;
  // The note is re-read first, so what the user ends up looking at is
  // the state main just measured — not a claim this function made.
  await refreshPasteCapabilityNote();
  if (repaired && el && el.hidden) {
    el.textContent = "Permissions repaired. macOS will ask again the next time Transcriptor pastes.";
    el.hidden = false;
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampAutoStopSeconds(raw: number): number {
  const t = UI_TOKENS.autoStopSilence;
  return clampNumber(
    Number.isFinite(raw) ? Math.round(raw) : t.defaultSeconds,
    t.minSeconds,
    t.maxSeconds,
  );
}

function clampAutoStopThresholdDb(raw: number): number {
  const t = UI_TOKENS.autoStopSilence;
  return clampNumber(
    Number.isFinite(raw) ? Math.round(raw) : t.defaultThresholdDb,
    t.minThresholdDb,
    t.maxThresholdDb,
  );
}

function getAutoStopSilenceConfig(): AutoStopSilenceConfig {
  return {
    enabled: !!($("autoStopSilenceEnabled") as HTMLInputElement).checked,
    seconds: clampAutoStopSeconds(Number(($("autoStopSilenceSeconds") as HTMLInputElement).value)),
    thresholdDb: clampAutoStopThresholdDb(Number(($("autoStopSilenceDb") as HTMLInputElement).value)),
  };
}

/**
 * Write the bounds and defaults into the markup at boot.
 *
 * The `min`/`max`/`value` attributes used to be typed into
 * `index.html`, where they were the third copy of these numbers and,
 * being `<input type=number>` attributes, decorative anyway: Chromium
 * does not enforce them against typed input, so the clamp above was
 * already the only thing bounding the value. They are still worth
 * setting — the spinner arrows and the invalid-state styling read them
 * — but from the token, not from a literal.
 */
function applyAutoStopSilenceBounds(): void {
  const t = UI_TOKENS.autoStopSilence;
  const seconds = document.getElementById("autoStopSilenceSeconds") as HTMLInputElement | null;
  if (seconds) {
    seconds.min = String(t.minSeconds);
    seconds.max = String(t.maxSeconds);
    seconds.value = String(t.defaultSeconds);
  }
  const db = document.getElementById("autoStopSilenceDb") as HTMLInputElement | null;
  if (db) {
    db.min = String(t.minThresholdDb);
    db.max = String(t.maxThresholdDb);
    db.value = String(t.defaultThresholdDb);
  }
  const enabled = document.getElementById("autoStopSilenceEnabled") as HTMLInputElement | null;
  if (enabled) enabled.checked = t.defaultEnabled;
}

/**
 * Write every string that appears on two surfaces into the markup.
 *
 * The counterpart of ``applyAutoStopSilenceBounds`` for copy: the
 * declarations live in ``ui-copy.ts`` (static strings), in
 * ``deepgram-dual.ts`` (the one sentence about what the second stream
 * costs) and in the backend's own extension list.
 */
function applyStaticCopyToMarkup(): void {
  applyStaticUiCopy(document);
  renderAcceptedFormatsHint(document, ACCEPTED_AUDIO_VIDEO_EXTS);
  const dualNote = document.getElementById("deepgramDualStreamNote");
  if (dualNote) dualNote.textContent = dualStreamTradeOffText();
  const curEl = document.getElementById("cpCurrentTime");
  if (curEl) curEl.textContent = PLAYER_TIME_ZERO;
  const durEl = document.getElementById("cpDuration");
  if (durEl) durEl.textContent = PLAYER_TIME_ZERO;
}

function keyInput(provider: RemoteProvider): HTMLInputElement {
  return $(provider === "openrouter" ? "orKey" : "deepgramKey") as HTMLInputElement;
}

function keyActionButton(provider: RemoteProvider): HTMLButtonElement {
  return $(provider === "openrouter" ? "orKeyActionBtn" : "deepgramKeyActionBtn") as HTMLButtonElement;
}

function isMaskedKeyInput(el: HTMLInputElement): boolean {
  return el.dataset.masked === "1";
}

/**
 * Reflect "a key is stored for this provider" on the input.
 *
 * ``data-masked`` is the single source of truth for the masked state:
 * JS sets the attribute and the value, the stylesheet decides how a
 * masked field looks. The previous version also wrote
 * ``style.cursor`` and ``style.pointerEvents`` inline — the exact two
 * declarations the ``[data-masked="1"]`` rule already made — so the
 * same decision lived in two places, and the inline copy won.
 *
 * That copy was also what made the field feel broken:
 * ``pointer-events: none`` plus ``tabIndex = -1`` meant a saved key
 * could not be clicked, focused or selected at all. The only way to
 * replace one was to notice that the adjacent button had silently
 * become a Delete button, press it, and start over. Now the field
 * accepts focus and clears the mask on the first interaction, so
 * clicking it and typing replaces the key — what the control looks
 * like it should do.
 *
 * ``readOnly`` stays while masked so the placeholder dots cannot be
 * partially edited into a corrupt key; the focus handler lifts it.
 */
function markKeyMasked(provider: RemoteProvider, saved: boolean): void {
  const el = keyInput(provider);
  const isSaved = !!saved;
  keySavedState[provider] = isSaved;
  if (isSaved) {
    el.value = MASKED_KEY_VALUE;
    el.dataset.masked = "1";
    el.readOnly = true;
  } else {
    el.value = "";
    delete el.dataset.masked;
    el.readOnly = false;
  }
}

/**
 * Drop the mask so the field is ready to accept a replacement key.
 *
 * Idempotent, and safe to call from focus, pointerdown or input — all
 * three are "the user is about to type here".
 */
function clearMaskedKeyOnEdit(provider: RemoteProvider): void {
  const el = keyInput(provider);
  if (!isMaskedKeyInput(el)) return;
  el.value = "";
  delete el.dataset.masked;
  el.readOnly = false;
}

function syncKeyActionButton(provider: RemoteProvider): void {
  const btn = keyActionButton(provider);
  const input = keyInput(provider);
  const masked = isMaskedKeyInput(input);
  const hasTyped = !masked && !!input.value.trim();
  const canDelete = keySavedState[provider] && !hasTyped;
  const canSave = hasTyped;
  btn.classList.toggle("delete", canDelete);
  btn.classList.toggle("save", !canDelete);
  btn.disabled = !(canDelete || canSave);
  btn.title = canDelete ? "Delete key" : "Save key";
  btn.setAttribute("aria-label", canDelete ? "Delete key" : "Save key");
}

// Auto-stop silence detection is handled exclusively by the Electron main
// process recording-state monitor. The frontend only publishes VU/RMS samples.

/**
 * Translate a raw fetch/network error into a user-actionable message.
 *
 * The native "Failed to fetch" / "NetworkError when attempting to
 * fetch" / "ECONNREFUSED" strings are developer jargon. End users need
 * to know: (1) is the internet down, (2) is the provider blocked, or
 * (3) is our local backend dead. This helper inspects the error and
 * surfaces one of those three actionable diagnoses.
 */
async function parseError(r: Response): Promise<string> {
  // 1.1.25 fix: previously called ``await r.json()`` then on failure
  // ``await r.text()``. ``Response`` body is a one-shot stream — once
  // ``json()`` consumes it (even on a malformed-JSON failure path),
  // ``text()`` always rejects with "body stream already read". Every
  // non-JSON error response was reduced to the bare ``HTTP <status>``
  // line, dropping the actual server error message. Fix: read once
  // as text, then attempt JSON parsing on the buffered string.
  const status = `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ""}`;
  let raw = "";
  try {
    raw = await r.text();
  } catch (textError) {
    console.debug("parseError: response body unavailable", textError);
    return status;
  }
  const trimmed = raw.trim();
  if (!trimmed) return status;
  try {
    const j: unknown = JSON.parse(trimmed);
    if (typeof j === "object" && j && "detail" in j) {
      const detail = (j as { detail?: unknown }).detail;
      const detailRaw = typeof detail === "string" ? detail : JSON.stringify(j);
      return `${status}: ${detailRaw}`;
    }
    return `${status}: ${JSON.stringify(j)}`;
  } catch {
    // Body wasn't JSON — surface the raw text payload (e.g., a plain
    // HTTP 500 traceback or proxy error page).
    return `${status}: ${trimmed}`;
  }
}

async function apiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { headers: authHeaders(), signal });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as T;
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as T;
}

/**
 * Browsers cap the body of a ``keepalive`` request at 64 KiB across all
 * in-flight keepalive requests; over that the fetch rejects outright.
 * A queue snapshot carrying two hundred transcripts can exceed it, and
 * a rejected save is worse than an interrupted one, so the flag is
 * dropped for a payload that would not fit.
 */
const KEEPALIVE_MAX_BODY_BYTES = 60_000;

async function apiPut<T>(
  url: string,
  body: unknown,
  options: { keepalive?: boolean } = {},
): Promise<T> {
  const payload = JSON.stringify(body);
  const keepalive = !!options.keepalive
    && new TextEncoder().encode(payload).length <= KEEPALIVE_MAX_BODY_BYTES;
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: payload,
    keepalive,
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as T;
}

async function apiDelete<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as T;
}

// Input samples left over from the previous ``downsample`` call — fewer
// than one output-sample worth. Carrying them makes the decimation grid
// CONTINUOUS across capture chunks.
//
// The previous implementation restarted the grid at index 0 on every
// chunk and emitted ``Math.round(buf.length / r)`` samples, so on any
// device whose AudioContext is not an integer multiple of 16 kHz
// (44.1 kHz is the common case on Windows and on many USB mics) each
// chunk boundary rounded independently: up to half an input sample was
// duplicated or discarded ~21 times per second. That is both a slow
// timing drift against wall-clock and a per-chunk discontinuity right
// in the middle of the audio Whisper/Deepgram has to decode.
let downsampleCarry = new Float32Array(0);

function resetDownsampleState(): void {
  downsampleCarry = new Float32Array(0);
}

function downsample(buf: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate === inRate) return new Float32Array(buf);
  const r = inRate / outRate;
  let src = buf;
  if (downsampleCarry.length > 0) {
    src = new Float32Array(downsampleCarry.length + buf.length);
    src.set(downsampleCarry, 0);
    src.set(buf, downsampleCarry.length);
  }
  // floor(), not round(): only emit output samples whose full input
  // window is present. The remainder is carried, never dropped.
  const outLen = Math.floor(src.length / r);
  const out = new Float32Array(outLen);
  let consumed = 0;
  for (let i = 0; i < outLen; i++) {
    const start = Math.round(i * r);
    const end = Math.min(src.length, Math.round((i + 1) * r));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += src[j];
      n++;
    }
    out[i] = n ? sum / n : 0;
    consumed = end;
  }
  downsampleCarry = consumed < src.length ? src.slice(consumed) : new Float32Array(0);
  return out;
}

// ── PCM capture sink ──────────────────────────────────────────────────
//
// A bounded-memory replacement for the old ``chunks: Float32Array[]``
// module-level array. Two implementations:
//
//   * ``OpfsPcmSink`` — spools PCM16LE samples to the Origin Private
//     File System (``navigator.storage.getDirectory()``) in real time
//     so the JS heap never holds more than a handful of milliseconds
//     of audio at once. At finalize, a WAV header is prepended and a
//     ``File`` backed by the concatenated [header + spooled bytes] is
//     returned. Cleanup is explicit via ``destroy()``.
//
//   * ``MemoryPcmSink`` — in-memory fallback for environments without
//     OPFS (old browsers, test harnesses) or when a mid-recording
//     write fails. Keeps samples as ``Int16Array`` chunks (half the
//     footprint of the old Float32Array path) and assembles a WAV
//     ``File`` at finalize.
//
// The factory ``createPcmSink`` tries OPFS first and gracefully
// degrades to memory on any failure, so callers never have to
// branch. ``isDiskBacked`` lets the UI report which mode is active.
//
// Orphan cleanup: if the app crashes mid-recording, a ``.pcm16`` file
// is left in ``pcm-spool/`` inside OPFS. ``cleanupOrphanPcmSpool``
// runs once at module load and removes every file older than the
// current session, so the cleanup window never grows without bound.

interface PcmSink {
  append(samples: Float32Array): void;
  finalize(sampleRate: number, name?: string): Promise<File>;
  destroy(): Promise<void>;
  readonly totalSamples: number;
  readonly isDiskBacked: boolean;
  readonly lastWriteError: Error | null;
}

function floatSamplesToInt16LE(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const clamped = x < -1 ? -1 : x > 1 ? 1 : x;
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return out;
}

function buildWavHeader(sampleRate: number, dataBytes: number, channels = 1): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  // "RIFF" chunk
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(8, 0x57415645, false);
  // "fmt " subchunk
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true); // subchunk1Size (PCM)
  view.setUint16(20, 1, true); // audioFormat = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byteRate
  view.setUint16(32, channels * 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  // "data" subchunk
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataBytes, true);
  return header;
}

type OpfsFileSystemWritableFileStream = {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};
interface OpfsFileSystemFileHandle {
  name: string;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsFileSystemWritableFileStream>;
  getFile(): Promise<File>;
}
interface OpfsFileSystemDirectoryHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileSystemFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileSystemDirectoryHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterableIterator<OpfsFileSystemFileHandle & { kind: "file" | "directory" }>;
}

const PCM_SPOOL_DIR = "pcm-spool";
/** All `.pcm16` file names that are currently being written to by an
 *  active recording session. `cleanupOrphanPcmSpool` skips these so
 *  it never deletes a spool file that is still in use. */
const _activePcmSpoolNames = new Set<string>();

async function getPcmSpoolDir(create = true): Promise<OpfsFileSystemDirectoryHandle | null> {
  // The built-in ``FileSystemDirectoryHandle`` type in some TS lib
  // versions doesn't yet declare ``values()`` / ``getFileHandle()``
  // with the exact shape we need, so we fence off the entire OPFS
  // surface area as ``unknown`` and take ownership of the types via
  // our ``OpfsFileSystem*`` interfaces. All subsequent calls are
  // structurally typed against our contract and will fail loudly at
  // runtime if the browser diverges (caught by the try/catch).
  const navStorage = (navigator as { storage?: { getDirectory?: () => Promise<unknown> } }).storage;
  if (!navStorage || typeof navStorage.getDirectory !== "function") {
    return null;
  }
  try {
    const root = (await navStorage.getDirectory()) as unknown as OpfsFileSystemDirectoryHandle;
    return await root.getDirectoryHandle(PCM_SPOOL_DIR, { create });
  } catch (e) {
    console.debug("OPFS spool dir unavailable:", e);
    return null;
  }
}

async function cleanupOrphanPcmSpool(): Promise<void> {
  const dir = await getPcmSpoolDir(true);
  if (!dir) return;
  try {
    const victims: string[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && entry.name.endsWith(".pcm16")) {
        // Skip any file that belongs to an active recording session.
        if (_activePcmSpoolNames.has(entry.name)) continue;
        victims.push(entry.name);
      }
    }
    for (const name of victims) {
      try {
        await dir.removeEntry(name);
      } catch (e) {
        console.debug("pcm-spool: failed to remove orphan", name, e);
      }
    }
    if (victims.length) {
      console.info(`pcm-spool: cleaned ${victims.length} orphaned capture file(s)`);
    }
  } catch (e) {
    console.debug("pcm-spool: orphan scan skipped:", e);
  }
}

class OpfsPcmSink implements PcmSink {
  private dir: OpfsFileSystemDirectoryHandle;
  private fileHandle: OpfsFileSystemFileHandle;
  private writable: OpfsFileSystemWritableFileStream | null;
  private pendingChunks: Int16Array[] = [];
  private pendingBytes = 0;
  private flushInProgress = false;
  /** Awaitable handle for the currently-running flush; resolves when done. */
  private flushDone: Promise<void> = Promise.resolve();
  private flushScheduled = false;
  private destroyed = false;
  /**
   * Set once ``finalize`` has drained and is about to close the stream.
   *
   * ``close()`` is awaited, and ``writable`` was only nulled AFTER it
   * resolved — so for the whole duration of the close a microtask flush
   * scheduled by a late ``append`` still saw a non-null ``writable`` and
   * wrote into a closing stream. The stream rejects that with
   * "Cannot write to a closing writable stream", which landed in the
   * support log as "disk may be full or permissions revoked": an
   * internal ordering bug, reported to the user as failing hardware.
   */
  private closing = false;
  /** Samples that arrived after the finalize drain barrier. */
  private strandedAfterDrain = 0;
  totalSamples = 0;
  readonly isDiskBacked = true;
  lastWriteError: Error | null = null;

  constructor(
    dir: OpfsFileSystemDirectoryHandle,
    fileHandle: OpfsFileSystemFileHandle,
    writable: OpfsFileSystemWritableFileStream,
  ) {
    this.dir = dir;
    this.fileHandle = fileHandle;
    this.writable = writable;
  }

  static async create(sessionId: string): Promise<OpfsPcmSink | null> {
    const dir = await getPcmSpoolDir(true);
    if (!dir) return null;
    let name = "";
    try {
      const safeId = sessionId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 96) || `s${Date.now()}`;
      name = `${safeId}.pcm16`;
      // Register BEFORE creating the file handle so the cleanup scan
      // never races with the file's existence on disk.
      _activePcmSpoolNames.add(name);
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable({ keepExistingData: false });
      return new OpfsPcmSink(dir, handle, writable);
    } catch (e) {
      if (name) {
        _activePcmSpoolNames.delete(name);
        try {
          await dir.removeEntry(name);
        } catch {
          // Best effort: a failed create may not have left an entry behind,
          // and OPFS implementations differ on when the file becomes visible.
        }
      }
      console.warn("OpfsPcmSink: create failed, falling back to memory sink", e);
      return null;
    }
  }

  append(samples: Float32Array): void {
    if (this.destroyed) return;
    if (!samples.length) return;
    if (this.closing) {
      // Past the finalize drain barrier. ``stopLive`` flushes the
      // worklet port and waits for the capture graph to go idle before
      // finalizing, so reaching here means a straggler outran that
      // barrier. Counted rather than silently dropped — a rising count
      // would mean the barrier itself is wrong.
      this.strandedAfterDrain += samples.length;
      return;
    }
    const int16 = floatSamplesToInt16LE(samples);
    this.pendingChunks.push(int16);
    this.pendingBytes += int16.byteLength;
    this.totalSamples += int16.length;
    if (this.lastWriteError) return;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    if (this.closing) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flushPending();
    });
  }

  private async flushPending(): Promise<void> {
    if (this.flushInProgress) return;
    if (this.destroyed) return;
    // ``writable`` stays non-null for the whole of ``close()``, so it
    // cannot be the test for "may I still write".
    if (this.closing) return;
    if (!this.writable) return;
    if (!this.pendingChunks.length) return;
    this.flushInProgress = true;
    // Record a promise that outer callers (finalize) can await instead
    // of polling flushInProgress with a bounded busy-wait.
    let _resolveDone!: () => void;
    this.flushDone = new Promise<void>((r) => { _resolveDone = r; });
    const chunks = this.pendingChunks;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    try {
      const totalBytes = chunks.reduce((a, c) => a + c.byteLength, 0);
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const c of chunks) {
        merged.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), offset);
        offset += c.byteLength;
      }
      await this.writable.write(merged);
    } catch (e) {
      this.lastWriteError = e instanceof Error ? e : new Error(String(e));
      // Re-enqueue the failed chunks so finalize() can still produce a
      // WAV from in-memory data via the WebM fallback path. Without this
      // the samples in ``chunks`` are GC'd and permanently lost.
      this.pendingChunks = [...chunks, ...this.pendingChunks];
      this.pendingBytes = this.pendingChunks.reduce((a, c) => a + c.byteLength, 0);
      console.warn("OpfsPcmSink: write failed — disk may be full or permissions revoked", e);
    } finally {
      this.flushInProgress = false;
      _resolveDone();
      this.flushDone = Promise.resolve();
      if (this.pendingChunks.length && !this.lastWriteError) {
        this.scheduleFlush();
      }
    }
  }

  async finalize(sampleRate: number, name = `live-${Date.now()}.wav`): Promise<File> {
    // Drain any pending chunks first.
    await this.flushPending();
    // If a flush was already in-progress when we called flushPending()
    // (it returned early because flushInProgress was true), wait for
    // the live flush Promise to settle — no busy-wait, no timeout.
    await this.flushDone;
    // One more drain for anything that arrived during the wait.
    await this.flushPending();
    // Final barrier: wait for that drain to settle too.
    await this.flushDone;

    // From here nothing may reach the stream. Set BEFORE close() is
    // awaited: that await is the window a scheduled flush used to slip
    // through, because `writable` is still non-null throughout it.
    this.closing = true;
    if (this.strandedAfterDrain > 0) {
      console.warn(
        `OpfsPcmSink: ${this.strandedAfterDrain} sample(s) arrived after the `
        + "finalize drain barrier and were not written",
      );
    }

    if (this.writable) {
      try {
        await this.writable.close();
      } catch (e) {
        console.debug("OpfsPcmSink: close failed", e);
      }
      this.writable = null;
    }
    // Spool file is no longer being written; remove from the active set
    // so a subsequent cleanupOrphanPcmSpool call can delete it.
    _activePcmSpoolNames.delete(this.fileHandle.name);

    if (this.lastWriteError) {
      // 1.1.25 fix: previously returned an empty WAV here even though
      // ``flushPending``'s catch branch deliberately
      // re-enqueues failed chunks into ``pendingChunks`` so finalize
      // can salvage them from RAM. Returning empty discarded the bytes
      // and forced the lower-fidelity WebM fallback for what was
      // typically a transient disk hiccup. Now we splice the in-memory
      // chunks together with whatever DID land on the OPFS spool: the
      // spool prefix + the unwritten tail = a complete WAV.
      try {
        const spoolFile = await this.fileHandle.getFile();
        const spoolBytes = spoolFile.size;
        const tailChunks = this.pendingChunks;
        const tailBytes = tailChunks.reduce((a, c) => a + c.byteLength, 0);
        const totalDataBytes = spoolBytes + tailBytes;
        if (totalDataBytes === 0) {
          return new File([new Blob([], { type: "audio/wav" })], name, { type: "audio/wav" });
        }
        const tailMerged = new Uint8Array(tailBytes);
        let off = 0;
        for (const c of tailChunks) {
          tailMerged.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), off);
          off += c.byteLength;
        }
        const header = buildWavHeader(sampleRate, totalDataBytes);
        const blob = new Blob([header, spoolFile, tailMerged], { type: "audio/wav" });
        return new File([blob], name, { type: "audio/wav" });
      } catch (salvageErr) {
        // Spool file was already lost too — last-resort empty WAV.
        console.warn("OpfsPcmSink.finalize: salvage failed after lastWriteError", salvageErr);
        return new File([new Blob([], { type: "audio/wav" })], name, { type: "audio/wav" });
      }
    }

    const spool = await this.fileHandle.getFile();
    const dataBytes = spool.size;
    const header = buildWavHeader(sampleRate, dataBytes);
    const blob = new Blob([header, spool], { type: "audio/wav" });
    return new File([blob], name, { type: "audio/wav" });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    _activePcmSpoolNames.delete(this.fileHandle.name);
    if (this.writable) {
      try {
        await this.writable.close();
      } catch (e) {
        console.debug("OpfsPcmSink: destroy close failed", e);
      }
      this.writable = null;
    }
    try {
      await this.dir.removeEntry(this.fileHandle.name);
    } catch (e) {
      console.debug("OpfsPcmSink: destroy remove failed", e);
    }
    this.pendingChunks = [];
    this.pendingBytes = 0;
  }
}

/**
 * PCM sink for hosts where OPFS is unavailable.
 *
 * Bounded by the same window as the WebM fallback. It used to grow
 * without any limit — 16 kHz Int16 is ~32 KB/s, so ~115 MB an hour of
 * renderer memory — while the comment at ``createPcmSink`` asserted that
 * "the 2h rotating-window dance is gone, the sink is bounded by
 * definition". That was true of the OPFS sink, which spools to disk, and
 * false of this one, which is the only sink a machine without OPFS gets.
 */
class MemoryPcmSink implements PcmSink {
  private chunks: Int16Array[] = [];
  private bufferedSamples = 0;
  private truncationWarned = false;
  private destroyed = false;
  totalSamples = 0;
  readonly isDiskBacked = false;
  lastWriteError: Error | null = null;

  append(samples: Float32Array): void {
    if (this.destroyed) return;
    if (!samples.length) return;
    const int16 = floatSamplesToInt16LE(samples);
    this.chunks.push(int16);
    this.bufferedSamples += int16.length;
    this.totalSamples += int16.length;
    const cap = UI_TOKENS.capture.fallbackWindowSec * LIVE_SAMPLE_RATE_HZ;
    while (this.bufferedSamples > cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bufferedSamples -= dropped ? dropped.length : 0;
      if (!this.truncationWarned) {
        this.truncationWarned = true;
        // Once per session, and said out loud: silently dropping the
        // start of a recording reads as data loss, which is what it is.
        showRecordSessionNotice(
          "Recording exceeds 2 hours and this system has no disk spool — only the last 2 h of audio is kept.",
          "warning",
          9000,
        );
      }
    }
  }

  async finalize(sampleRate: number, name = `live-${Date.now()}.wav`): Promise<File> {
    const totalBytes = this.chunks.reduce((a, c) => a + c.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), offset);
      offset += c.byteLength;
    }
    const header = buildWavHeader(sampleRate, totalBytes);
    const blob = new Blob([header, merged], { type: "audio/wav" });
    return new File([blob], name, { type: "audio/wav" });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.chunks = [];
    this.bufferedSamples = 0;
    this.totalSamples = 0;
  }
}

async function createPcmSink(sessionId: string): Promise<PcmSink> {
  const opfs = await OpfsPcmSink.create(sessionId);
  if (opfs) return opfs;
  console.info("PcmSink: OPFS unavailable, using in-memory sink");
  return new MemoryPcmSink();
}

async function probeAudioFileDuration(file: File): Promise<number | null> {
  if (!(file instanceof File) || file.size <= 0) return null;
  const url = URL.createObjectURL(file);
  try {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const duration = await new Promise<number | null>((resolve) => {
      let settled = false;
      const finish = (value: number | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      audio.onloadedmetadata = () => {
        const value = Number(audio.duration);
        finish(Number.isFinite(value) && value > 0 ? value : null);
      };
      audio.onerror = () => finish(null);
      window.setTimeout(() => finish(null), 2500);
      audio.src = url;
    });
    return duration;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Weights for the choice of canonical audio.
 *
 * Which file the user's recording IS — the WAV the PCM sink produced or
 * the WebM the MediaRecorder produced — was decided by five bare numbers
 * inside the scoring expression. They are a product decision, not
 * arithmetic, so they are named here with what each is for. The score is
 * in seconds throughout: a candidate's distance from the expected
 * duration, plus penalties expressed as the number of seconds of error
 * they are considered equivalent to.
 */
/** PCM coverage above which the WebM probe is not worth its cost. */
const CANONICAL_AUDIO_PCM_FAST_PATH_COVERAGE = 0.95;
/**
 * Tie-break against the container when both candidates fit equally well.
 * The PCM spool is the higher-fidelity path (no lossy re-encode, exact
 * sample count), so the container has to be measurably better, not
 * merely equal, to win.
 */
const CANONICAL_AUDIO_CONTAINER_BIAS_SEC = 0.08;
/** The same, doubled, for a container whose duration could not be probed at all. */
const CANONICAL_AUDIO_UNPROBED_CONTAINER_BIAS_SEC = 0.16;
/** Shortfall tolerated before a candidate counts as having missed audio. */
const CANONICAL_AUDIO_UNDER_CAPTURE_TOLERANCE_SEC = 0.35;
/**
 * Penalty for missing audio. Larger than the tolerance it follows,
 * because a recording that is short is missing something the user said,
 * while one that runs long merely has silence on the end.
 */
const CANONICAL_AUDIO_UNDER_CAPTURE_PENALTY_SEC = 0.45;

async function selectCanonicalCapturedAudio(opts: {
  /** Pre-built WAV file returned by ``PcmSink.finalize``. The file
   *  is either a Blob backed by an OPFS spool entry (disk-spilled)
   *  or an in-memory Int16 buffer. Either way it's already a valid
   *  WAV — no encoding happens here. */
  pcmFile: File | null;
  /** Total sample count reported by the sink. Used to derive
   *  duration without loading the file back into an
   *  ``HTMLAudioElement``. */
  pcmSampleCount: number;
  pcmSampleRate: number;
  recordedChunks: Blob[];
  expectedDurationSec: number;
}): Promise<{ file: File | null; durationSec: number; kind: "pcm" | "container" | "none" }> {
  const expectedDurationSec = Math.max(0, Number(opts.expectedDurationSec) || 0);
  const candidates: Array<{ file: File; durationSec: number; kind: "pcm" | "container"; fidelityBias: number }> = [];

  // A valid WAV from the sink has header (44 bytes) + payload. Empty
  // or header-only files indicate a sink write error; skip them and
  // fall back to the WebM container candidate below.
  if (opts.pcmFile && opts.pcmFile.size > 44 && opts.pcmSampleCount > 0) {
    const pcmDurationSec = opts.pcmSampleCount / opts.pcmSampleRate;
    const pcmFile = opts.pcmFile;
    // FAST PATH: a PCM capture that covers essentially all of the
    // expected duration skips the slow WebM probe altogether — the sink
    // already produced a ready-to-play WAV and the exact sample count is
    // known.
    const pcmCoverage =
      expectedDurationSec > 0 ? pcmDurationSec / expectedDurationSec : 1;
    if (pcmCoverage >= CANONICAL_AUDIO_PCM_FAST_PATH_COVERAGE) {
      return { file: pcmFile, durationSec: pcmDurationSec, kind: "pcm" };
    }
    candidates.push({ file: pcmFile, durationSec: pcmDurationSec, kind: "pcm", fidelityBias: 0 });
  }

  if (opts.recordedChunks.length > 0) {
    const webmBlob = new Blob(opts.recordedChunks, { type: "audio/webm" });
    const webmFile = new File([webmBlob], `live-${Date.now()}.webm`, { type: webmBlob.type || "audio/webm" });
    const webmDurationSec = await probeAudioFileDuration(webmFile);
    if (webmDurationSec && webmDurationSec > 0) {
      candidates.push({
        file: webmFile,
        durationSec: webmDurationSec,
        kind: "container",
        fidelityBias: CANONICAL_AUDIO_CONTAINER_BIAS_SEC,
      });
    } else if (!candidates.length) {
      candidates.push({
        file: webmFile,
        durationSec: 0,
        kind: "container",
        fidelityBias: CANONICAL_AUDIO_UNPROBED_CONTAINER_BIAS_SEC,
      });
    }
  }

  if (!candidates.length) return { file: null, durationSec: 0, kind: "none" };
  if (candidates.length === 1) {
    const only = candidates[0];
    return { file: only.file, durationSec: only.durationSec, kind: only.kind };
  }

  const scored = candidates
    .map((candidate) => {
      const diff = Math.abs(expectedDurationSec - candidate.durationSec);
      const underCapturePenalty =
        candidate.durationSec + CANONICAL_AUDIO_UNDER_CAPTURE_TOLERANCE_SEC < expectedDurationSec
          ? CANONICAL_AUDIO_UNDER_CAPTURE_PENALTY_SEC
          : 0;
      return {
        ...candidate,
        score: diff + underCapturePenalty + candidate.fidelityBias,
      };
    })
    .sort((a, b) => a.score - b.score || b.durationSec - a.durationSec || a.fidelityBias - b.fidelityBias);

  const best = scored[0];
  return { file: best.file, durationSec: best.durationSec, kind: best.kind };
}

// Hardwired local timeout for ``stopMediaRecorderAndFlush``.
//
// The old code reused ``UI_TOKENS.polling.remoteChunkSettleTimeoutMs``
// (3000 ms) as a safety ceiling, and it was awaited in the middle of the
// stop path, so every stop paid for it. It is now started at step 1 of
// the stop sequence and awaited only where ``recordedWebmChunks`` is
// read, which makes the ceiling a bound on lateness rather than on
// latency.
//
// What a hit ceiling can cost is the container's final sub-second chunk
// — and only the container's. The canonical audio is the PCM spool,
// whose completeness is proven by the worklet flush ack, so a WebM that
// comes up short simply loses the coverage comparison in
// ``selectCanonicalCapturedAudio`` instead of shortening the recording.
// 500 ms is therefore ample even on the warm-hold branch, where the
// microphone is deliberately still open while the recorder stops.
const MEDIA_RECORDER_STOP_FALLBACK_MS = 500;

async function stopMediaRecorderAndFlush(): Promise<void> {
  const recorder = mediaRecorder;
  if (!recorder || recorder.state === "inactive") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    recorder.addEventListener("stop", finish, { once: true });
    window.setTimeout(finish, MEDIA_RECORDER_STOP_FALLBACK_MS);
    try {
      recorder.requestData();
    } catch (e) {
      console.debug("MediaRecorder requestData rejected (harmless)", e);
    }
    try {
      recorder.stop();
    } catch (e) {
      console.debug("MediaRecorder stop rejected (harmless)", e);
      finish();
    }
  });
}

function getRemoteModelValue(provider: Provider): string {
  if (!provider) return "";
  if (provider === "openrouter") {
    const v = (uiModelByGroup.openrouter || remoteModelByProvider.openrouter || "").trim();
    return v || DEFAULT_OPENROUTER_AUDIO_MODEL;
  }
  if (provider === "deepgram") {
    const v = (uiModelByGroup.deepgram || remoteModelByProvider.deepgram || "").trim();
    return v || DEFAULT_DEEPGRAM_AUDIO_MODEL;
  }
  return selectedLocalModel();
}

function appendRemoteModelFormFields(fd: FormData, provider: Provider, model: string | undefined): void {
  if (!isRemoteProvider(provider)) return;
  const value = String(model || "").trim();
  fd.set("model", value);
  fd.set("remote_model", value);
  // Legacy backend alias. Keep it derived here so there is still one caller-side SSOT.
  fd.set("openrouter_model", value);
}

function remoteModelJsonFields(provider: Provider, model: string | undefined): Record<string, string> {
  if (!isRemoteProvider(provider)) return {};
  const value = String(model || "").trim();
  return {
    model: value,
    remote_model: value,
    openrouter_model: value,
  };
}

async function remoteJob(
  file: File,
  opts: { provider: Provider; language: string; diarize: boolean; remoteModel?: string; signal?: AbortSignal }
): Promise<BackendJobCreated> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("provider", opts.provider || "openrouter");
  fd.set("language", opts.language || "auto");
  fd.set("diarize", String(!!opts.diarize));
  appendRemoteModelFormFields(fd, opts.provider, opts.remoteModel);
  const r = await fetch("/api/remote/jobs", {
    method: "POST",
    body: fd,
    headers: authHeaders(),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as BackendJobCreated;
}

async function localJob(
  file: File,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean; signal?: AbortSignal },
): Promise<BackendJobCreated> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("language", opts.language || "auto");
  fd.set("model", opts.model || DEFAULT_LOCAL_TRANSCRIPTION_MODEL);
  fd.set("split_stereo", String(!!opts.splitStereo));
  fd.set("word_timestamps", String(!!opts.wordTimestamps));
  const r = await fetch("/api/jobs", {
    method: "POST",
    body: fd,
    headers: authHeaders(),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as BackendJobCreated;
}

async function remoteJobFromPath(
  sourcePath: string,
  opts: { provider: Provider; language: string; diarize: boolean; remoteModel?: string; signal?: AbortSignal },
): Promise<BackendJobCreated> {
  const r = await fetch("/api/remote/jobs/from-path", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    signal: opts.signal,
    body: JSON.stringify({
      source_path: sourcePath,
      provider: opts.provider || "openrouter",
      language: opts.language || "auto",
      diarize: !!opts.diarize,
      ...remoteModelJsonFields(opts.provider, opts.remoteModel),
    }),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as BackendJobCreated;
}

async function localJobFromPath(
  sourcePath: string,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean; signal?: AbortSignal },
): Promise<BackendJobCreated> {
  const r = await fetch("/api/jobs/from-path", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    signal: opts.signal,
    body: JSON.stringify({
      source_path: sourcePath,
      language: opts.language || "auto",
      model: opts.model || DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
      split_stereo: !!opts.splitStereo,
      word_timestamps: !!opts.wordTimestamps,
    }),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as BackendJobCreated;
}

async function cancelBackendJob(jobId: string): Promise<void> {
  try {
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
  } catch (e) {
    console.debug("backend job cancel failed", e);
  }
}

async function waitForBackendJob<T>(
  jobId: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (job: BackendJobState<T>) => void;
  } = {},
): Promise<T> {
  const startedAt = performance.now();
  while (true) {
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(),
      signal: opts.signal,
    });
    if (!r.ok) throw new Error(await parseError(r));
    const job = (await r.json()) as BackendJobState<T>;
    opts.onProgress?.(job);
    if (job.status === "done") {
      if (!job.result) throw new Error("Job finished without a result.");
      return job.result;
    }
    if (job.status === "error") {
      throw new Error(String(job.error || "Transcription failed."));
    }
    if (job.status === "cancelled") {
      throw new DOMException("Aborted", "AbortError");
    }
    const pollMs = performance.now() - startedAt > 30_000 ? 3_000 : 900;
    await new Promise<void>((resolve, reject) => {
      const signal = opts.signal;
      let timer = 0;
      const cleanup = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      timer = window.setTimeout(() => {
        cleanup();
        resolve();
      }, pollMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

async function waitForQueuedRemoteJob(
  created: BackendJobCreated,
  opts: {
    provider: Provider;
    language: string;
    diarize: boolean;
    remoteModel?: string;
    signal?: AbortSignal;
    onProcessingProgress?: (fraction: number) => void;
  },
): Promise<RemoteTranscriptionResult> {
  const onAbort = () => { void cancelBackendJob(created.job_id); };
  if (opts.signal?.aborted) {
    await cancelBackendJob(created.job_id);
    throw new DOMException("Aborted", "AbortError");
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let result: RemoteTranscriptionResult;
  try {
    result = await waitForBackendJob<RemoteTranscriptionResult>(created.job_id, {
      signal: opts.signal,
      onProgress: (job) => {
        opts.onProcessingProgress?.(Math.max(0, Math.min(1, Number(job.progress || 0))));
      },
    });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return {
    text: String(result?.text || "").trim(),
    provider: String(result?.provider || opts.provider || ""),
    model: String(result?.model || "").trim() || undefined,
    durationSec: Math.max(0, Number((result as { duration?: unknown; durationSec?: unknown })?.durationSec ?? (result as { duration?: unknown })?.duration ?? 0) || 0),
    audioSourcePath: String(created.audio_source_path || created.audioSourcePath || "").trim() || undefined,
  };
}

async function remoteJobQueued(
  file: File,
  opts: {
    provider: Provider;
    language: string;
    diarize: boolean;
    remoteModel?: string;
    signal?: AbortSignal;
    onProcessingProgress?: (fraction: number) => void;
  },
): Promise<RemoteTranscriptionResult> {
  return waitForQueuedRemoteJob(await remoteJob(file, opts), opts);
}

async function remoteJobQueuedFromPath(
  sourcePath: string,
  opts: {
    provider: Provider;
    language: string;
    diarize: boolean;
    remoteModel?: string;
    signal?: AbortSignal;
    onProcessingProgress?: (fraction: number) => void;
  },
): Promise<RemoteTranscriptionResult> {
  return waitForQueuedRemoteJob(await remoteJobFromPath(sourcePath, opts), opts);
}

function normalizeLocalTranscriptionResult(raw: { text?: string; duration?: number; segments?: Array<{ start?: number; end?: number; text?: string }> } | null | undefined): LocalTranscriptionResult {
  const rawSegments = Array.isArray(raw?.segments) ? raw?.segments || [] : [];
  const segments = rawSegments
    .map((segment) => normalizeTranscriptSegment(segment))
    .filter((segment): segment is TranscriptSegment => !!segment);
  return {
    text: normalizeTranscriptWhitespace(String(raw?.text || "")),
    segments,
    durationSec: Math.max(0, Number(raw?.duration || 0)),
  };
}

async function waitForQueuedLocalJob(
  created: BackendJobCreated,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean; signal?: AbortSignal },
): Promise<LocalTranscriptionResult> {
  const onAbort = () => { void cancelBackendJob(created.job_id); };
  if (opts.signal?.aborted) {
    await cancelBackendJob(created.job_id);
    throw new DOMException("Aborted", "AbortError");
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let result: { text?: string; duration?: number; segments?: Array<{ start?: number; end?: number; text?: string }> };
  try {
    result = await waitForBackendJob(created.job_id, { signal: opts.signal });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return {
    ...normalizeLocalTranscriptionResult(result),
    audioSourcePath: String(created.audio_source_path || created.audioSourcePath || "").trim() || undefined,
  };
}

async function localJobQueued(
  file: File,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean; signal?: AbortSignal },
): Promise<LocalTranscriptionResult> {
  return waitForQueuedLocalJob(await localJob(file, opts), opts);
}

async function localJobQueuedFromPath(
  sourcePath: string,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean; signal?: AbortSignal },
): Promise<LocalTranscriptionResult> {
  return waitForQueuedLocalJob(await localJobFromPath(sourcePath, opts), opts);
}

async function remoteJobSync(
  file: File,
  opts: {
    provider: Provider;
    language: string;
    diarize: boolean;
    remoteModel?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    providerReachabilityHint?: boolean;
  }
): Promise<{ text: string; provider: string; model?: string }> {
  if (isRemoteProvider(opts.provider) && !isRemoteProviderReachable(opts.provider, opts.providerReachabilityHint)) {
    throw new Error(remoteProviderOfflineMessage(opts.provider));
  }
  const timeoutMs = opts.timeoutMs ?? inferRemoteJobTimeoutMs(file, opts.provider);
  const abortSignal = createLinkedAbortSignal(opts.signal, timeoutMs);
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("provider", opts.provider || "openrouter");
  fd.set("language", opts.language || "auto");
  fd.set("diarize", String(!!opts.diarize));
  appendRemoteModelFormFields(fd, opts.provider, opts.remoteModel);
  try {
    const r = await fetch("/api/remote/transcribe-sync", {
      method: "POST",
      body: fd,
      headers: authHeaders(),
      signal: abortSignal.signal,
    });
    if (!r.ok) throw new Error(await parseError(r));
    const js = (await r.json()) as { ok?: boolean; result?: { text?: string; provider?: string; model?: string } };
    return {
      text: String(js?.result?.text || "").trim(),
      provider: String(js?.result?.provider || opts.provider || ""),
      model: String(js?.result?.model || "").trim() || undefined,
    };
  } catch (e) {
    if (abortSignal.didTimeout()) {
      throw new Error(`${providerLabel(opts.provider)} request timed out after ${Math.round((timeoutMs || 0) / 1000)}s.`);
    }
    throw e;
  } finally {
    abortSignal.cleanup();
  }
}

function isProviderKeyConfigured(provider: Provider): boolean {
  if (provider === "local" || !provider) return true;
  if (provider === "openrouter") {
    return hasOpenrouterKey;
  }
  if (provider === "deepgram") {
    return hasDeepgramKey;
  }
  return true;
}

function providerKeyErrorMessage(provider: Provider): string {
  if (provider === "deepgram") {
    return "Deepgram API key is not configured. Add it in Settings -> API Keys.";
  }
  if (provider === "openrouter") {
    return "OpenRouter API key is not configured. Add it in Settings -> API Keys.";
  }
  return "Provider API key is not configured.";
}

function syncRecordingsSearchControls(): void {
  const clearBtn = $("recordingsSearchClearBtn") as HTMLButtonElement;
  const hasQuery = !!recordingsSearchQuery.trim();
  clearBtn.disabled = recordingsUiLoading || !hasQuery;
}

function modalFocusableElements(modal: HTMLElement): HTMLElement[] {
  return Array.from(
    modal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute("hidden"));
}

function openModal(modalId: string, focusSelector = ""): void {
  const modal = $(modalId);
  lastModalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.hidden = false;
  activeModalId = modalId;
  const focusTarget = focusSelector ? (modal.querySelector(focusSelector) as HTMLElement | null) : null;
  const fallback = modalFocusableElements(modal)[0] || modal;
  (focusTarget || fallback).focus();
}

function closeModal(modalId: string): void {
  const modal = $(modalId);
  modal.hidden = true;
  if (activeModalId === modalId) activeModalId = "";
  if (lastModalFocus && document.contains(lastModalFocus)) {
    lastModalFocus.focus();
  }
  lastModalFocus = null;
}

async function localJobSync(
  file: File,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean; signal?: AbortSignal }
): Promise<LocalTranscriptionResult> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("language", opts.language || "auto");
  fd.set("model", opts.model || DEFAULT_LOCAL_TRANSCRIPTION_MODEL);
  fd.set("split_stereo", String(!!opts.splitStereo));
  fd.set("word_timestamps", String(!!opts.wordTimestamps));
  const r = await fetch("/api/transcribe-sync", {
    method: "POST",
    body: fd,
    headers: authHeaders(),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(await parseError(r));
  const js = (await r.json()) as {
    ok?: boolean;
    result?: {
      text?: string;
      duration?: number;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };
  };
  return normalizeLocalTranscriptionResult(js?.result);
}

async function transcribeCanonicalAudioLocally(
  file: File,
  language: string,
  model: string,
  signal?: AbortSignal
): Promise<LocalTranscriptionResult> {
  return localJobSync(file, {
    language: resolveFastLocalLanguage(language),
    model: (model || "").trim() || DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
    splitStereo: false,
    wordTimestamps: false,
    signal,
  });
}

/**
 * Ask the backend to load a local model before it is needed.
 *
 * A warm that cannot happen is not a failure. The backend answers
 * ``200 {ok:false, state:"offline"}`` when the weights are not on disk
 * and the network cannot fetch them — the exact situation the offline
 * transition creates, since going offline is what makes the local
 * engine the effective one in the first place. That is an answer, not
 * an error: it returns quietly, and the caller neither retries nor
 * logs (BUGS_AUDIT_2026-09-03 §7, where the same case arrived five
 * times as a 500 with an httpx traceback).
 */
async function warmLocalModel(model: string): Promise<void> {
  const resolvedModel = (model || "").trim() || DEFAULT_LOCAL_TRANSCRIPTION_MODEL;
  const fd = new FormData();
  fd.set("model", resolvedModel);
  const r = await fetch("/api/transcribe/warmup", { method: "POST", body: fd, headers: authHeaders() });
  if (!r.ok) throw new Error(await parseError(r));
  const body = await r.json().catch(() => null) as { ok?: unknown; state?: unknown } | null;
  if (body && body.ok === false && body.state !== "offline") {
    throw new Error(String(body.state || "local model warmup declined"));
  }
}

async function discardLiveRecovery(sessionId: string): Promise<void> {
  const safeSessionId = (sessionId || "").trim();
  if (!safeSessionId) return;
  const r = await fetch(`/api/live/recoveries/${encodeURIComponent(safeSessionId)}/discard`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error(await parseError(r));
}

async function recoverBackendAudioSessions(): Promise<void> {
  const r = await apiGet<{ items: Array<{ session_id: string }> }>("/api/live/recoveries");
  const items = Array.isArray(r.items) ? r.items : [];
  if (!items.length) return;
  const archiveDir = currentArchiveDirSnapshot();
  // Process each recovery independently. A single failure (e.g. a
  // spool file that's under the minimum duration threshold and hits
  // a 400 "live recovery too short") must NOT abort the loop — the
  // remaining recoveries still deserve to be promoted. We collect
  // counts and surface a single notice at the end.
  let succeeded = 0;
  let failed = 0;
  for (const item of items) {
    const sessionId = String(item?.session_id || "").trim();
    if (!sessionId) continue;
    try {
      const resp = await fetch(`/api/live/recoveries/${encodeURIComponent(sessionId)}/promote`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...(archiveDir ? { archive_dir: archiveDir } : {}),
          recording_collection: RECORDING_COLLECTIONS.live,
        }),
      });
      if (!resp.ok) {
        failed += 1;
        console.warn(
          `Recovery promote failed for ${sessionId}:`,
          await parseError(resp),
        );
        continue;
      }
      succeeded += 1;
    } catch (e) {
      failed += 1;
      console.warn(`Recovery promote exception for ${sessionId}:`, e);
    }
  }
  if (succeeded > 0) {
    showRecordSessionNotice(
      `Recovered ${succeeded} interrupted recording${succeeded === 1 ? "" : "s"} into Recordings.`,
      "success",
      9000,
    );
    void loadRecordings(true).catch((e) => {
      console.warn("Recovery History refresh failed", e);
      const msg = sanitizeUiErrorMessage(e, "Could not refresh the archive.");
      setStatus(`Recovery saved. History refresh failed: ${msg}`, "warning");
      showRecordSessionNotice(
        `Recovered ${succeeded} interrupted recording${succeeded === 1 ? "" : "s"}, but History refresh failed: ${msg}`,
        "warning",
        9000,
      );
    });
  }
  if (failed > 0 && succeeded === 0) {
    showRecordSessionNotice(
      `Could not recover ${failed} interrupted recording${failed === 1 ? "" : "s"}. Check the Recordings folder manually.`,
      "warning",
      9000,
    );
  }
}

function resolveFastLocalLanguage(language: string): string {
  const raw = String(language || "").trim();
  if (raw && raw.toLowerCase() !== "auto") return raw;
  return "auto";
}

function resolveFastLiveLocalModel(model: string): string {
  const raw = String(model || "").trim() || DEFAULT_LOCAL_TRANSCRIPTION_MODEL;
  if (raw && LOCAL_LIVE_ASSIST_MODELS.includes(raw)) return raw;
  return DEFAULT_LOCAL_TRANSCRIPTION_MODEL || LOCAL_LIVE_ASSIST_MODELS[0] || raw;
}

function resolveLivePreviewLocalModel(model: string): string {
  const raw = String(model || "").trim() || DEFAULT_LOCAL_TRANSCRIPTION_MODEL;
  if (raw && LOCAL_LIVE_PREVIEW_MODELS.includes(raw)) return raw;
  return DEFAULT_LIVE_PREVIEW_LOCAL_MODEL || LOCAL_LIVE_PREVIEW_MODELS[0] || DEFAULT_LOCAL_TRANSCRIPTION_MODEL || raw;
}

function resolveSessionLocalModels(selectedProvider: Provider): { assistLocalModel: string; finalLocalModel: string } {
  const configuredLocalModel = selectedLocalModel();
  const finalLocalModel = configuredLocalModel || DEFAULT_LOCAL_TRANSCRIPTION_MODEL;
  return {
    assistLocalModel: localEngineInUse(selectedProvider)
      ? resolveFastLiveLocalModel(configuredLocalModel)
      : resolveLivePreviewLocalModel(configuredLocalModel),
    finalLocalModel,
  };
}

/**
 * Returns the WebSocket mode for a given session snapshot.
 *
 * SSOT routing rules:
 *   - deepgram (online)  → dedicated Deepgram streaming WebSocket
 *   - local / remote fallback → local faster-whisper assist pipeline
 *   - no provider        → no live transcription transport
 */
function resolveLiveWsMode(snapshot: LiveSessionSnapshot | null): LiveWsMode {
  const provider = snapshot
    ? snapshot.effectiveProvider
    : resolveEffectiveProvider(readProviderSelection());
  if (!provider) {
    return "none";
  }
  if (provider === "deepgram" && isProviderKeyConfigured("deepgram")) {
    return "deepgram-stream";
  }
  return "local-assist";
}

function getCanonicalLiveSourceText(): string {
  // The live reading of the active session: the committed finals plus
  // the current interim, folded in by the seam rules in ./live-source so
  // a rolling re-decode cannot duplicate a clause.
  //
  // This is DISPLAY AND DRAFT state. It is what the preview shows and
  // what the draft autosave and the archive's ``source_text`` record;
  // it is never merged into the delivered transcript, which is the
  // backend's ``final`` envelope and only that.
  return mergeInterim(liveDraftText, liveInterimText);
}

function getVisibleLivePreviewText(): string {
  const committed = liveDraftDisplayText.trim();
  const interim = liveInterimText.trim();
  if (committed && interim) return `${committed} ${interim}`;
  return committed || interim;
}

function scheduleLocalWarmup(): void {
  const selectedProvider = readProviderSelection();
  if (!selectedProvider) return;
  // Warm ONLY when the session will actually run a local engine.
  //
  // Root cause this guard fixes: the previous version warmed the
  // live-preview model for every provider, so a user transcribing
  // exclusively through Deepgram or OpenRouter still loaded
  // faster-whisper into the backend — ~700 MB resident and 5-16 s of
  // CPU per launch for weights that were never asked to transcribe
  // anything. ``localEngineInUse`` — the same predicate the session,
  // the upload path and the model resolver read — already collapses to
  // "local" for the two cases where a local engine IS reached:
  // no/unusable remote key, and remote unreachable (offline). Both
  // transitions re-enter this function via ``setTranscriptionSelection``
  // and ``refreshNetworkState``, so the warm still happens ahead of the
  // first local window — just not before we know we need it.
  if (!localEngineInUse(selectedProvider)) return;
  const sessionModels = resolveSessionLocalModels(selectedProvider);
  const modelsToWarm = new Set<string>([
    sessionModels.assistLocalModel,
    sessionModels.finalLocalModel,
  ]);
  modelsToWarm.forEach((model) => {
    warmLocalModel(model).catch((e) => {
      console.warn(`Local model warmup failed for ${model}`, e);
    });
  });
}

function setNetworkState(online: boolean, latencyMs: number | null = null): void {
  const wasOnline = isNetworkOnline;
  isNetworkOnline = !!online;
  // Connectivity flip changes which engine the next session reaches:
  // going offline collapses a remote provider to the local fallback.
  // Warm on the transition only — this runs on every network poll, and
  // re-warming on each tick would defeat the point of not loading the
  // model until it is needed. ``scheduleLocalWarmup`` is a no-op while
  // the effective provider is still remote, so the online→offline and
  // offline→online cases both route through the same single gate.
  if (wasOnline !== isNetworkOnline) scheduleLocalWarmup();
  const dot = $("netDot");
  const text = $("netText");
  dot.className = "net-dot" + (online ? " online" : " offline");
  text.textContent = online ? "Online" : "Offline";
  const pill = $("netPill");
  if (!online) {
    pill.setAttribute("title", "Internet unavailable");
    return;
  }
  pill.setAttribute("title", latencyMs != null ? `Internet is available (${latencyMs} ms)` : "Internet is available");
}

function parseViewName(value: string): ViewName {
  return value === "upload" || value === "recordings" || value === "settings" || value === "record"
    ? value
    : "record";
}

function switchView(view: ViewName): void {
  if (view === "settings") {
    void refreshLocalModels();
    // Cheap, and the answer moves without the renderer touching it:
    // the backend rewrites the connection file when its port changes,
    // and the defaults line follows the Upload tab. Re-read on every
    // visit rather than caching a sentence that can go stale.
    void refreshCliSection();
  }
  // A popover belongs to the view that opened it.
  setTranscribeSettingsOpen(false);
  document.querySelectorAll(".view").forEach((el) => {
    const node = el as HTMLElement;
    node.hidden = node.dataset.view !== view;
  });
  document.querySelectorAll(".sb-item").forEach((el) => {
    const active = (el as HTMLElement).dataset.view === view;
    el.classList.toggle("active", active);
    if (active) {
      el.setAttribute("aria-current", "page");
    } else {
      el.removeAttribute("aria-current");
    }
  });
  $("windowViewLabel").textContent =
    view === "upload" ? "Upload"
      : view === "settings" ? "Settings"
      : view === "recordings" ? "History"
      : "Live";
  if (view === "recordings") {
    // Only reload from the server if we have no cached items yet. If
    // the list was already loaded (e.g. from initRecordingsBootstrap
    // or a previous tab visit), just re-render without a network call
    // to prevent the list "shaking" / reloading every time the user
    // switches tabs. A manual Refresh button or a new recording save
    // still triggers a full reload.
    if (!recordingItems.length) {
      void loadRecordings(true).catch((e) => {
        console.warn("History initial load failed", e);
        const msg = sanitizeUiErrorMessage(e, "Could not load the archive.");
        setStatus(`History load failed: ${msg}`, "warning");
        resetRecordingViewer(msg);
      });
    }
  }
  // Panes just changed visibility: a poll whose surface went off screen
  // suspends, one whose surface appeared arms. Must run AFTER the
  // `hidden` flags above, since `isViewVisible` reads them.
  syncGatedPolls();
}

function resolveEffectiveProvider(preferred: Provider): Provider {
  if (!preferred) return "";
  if (preferred === "local") return "local";
  if (!isRemoteProvider(preferred)) return "local";
  if (!isProviderKeyConfigured(preferred)) return "local";
  if (isRemoteProviderReachable(preferred)) return preferred;
  return "local";
}

/**
 * The one predicate for "this selection reaches the local engine".
 *
 * Every place that has to know — whether to warm faster-whisper, which
 * model a session will load, which engine an upload will run on — asks
 * this. It used to be re-derived: ``resolveEffectiveUploadProvider``
 * was a second copy of ``resolveEffectiveProvider`` with the same four
 * rules in the same order, and the warmup asked its own version of the
 * question. Two copies of "is the local engine in use" is how a user
 * transcribing exclusively through an API ends up loading a 700 MB
 * model (BUGS_AUDIT_2026-09-03 §7).
 */
function localEngineInUse(preferred: Provider): boolean {
  return !!preferred && resolveEffectiveProvider(preferred) === "local";
}

function localFallbackReason(preferred: Provider): string {
  if (!isRemoteProvider(preferred)) return "Transcribing locally.";
  if (!isProviderKeyConfigured(preferred)) {
    return `${providerLabel(preferred)} key is not configured. Transcribing locally.`;
  }
  if (!isRemoteProviderReachable(preferred)) {
    return "Internet is unavailable. Transcribing locally.";
  }
  return "Transcribing locally.";
}

async function refreshNetworkState(): Promise<void> {
  try {
    // The one request that does NOT go through ``apiGet``, on purpose:
    // /api/health is the liveness probe, it is answered before the API
    // token exists, and a non-ok answer here is the boot signal this
    // function is built around rather than an error to throw upward.
    const health = await fetch("/api/health");
    if (!health.ok) throw new Error(`health ${health.status}`);
    try {
      // Read once. This used to ``clone()`` the response for a single
      // read, which buffers the whole body a second time for nothing.
      const healthJson = (await health.json()) as BackendBootstrapPayload;
      applyBackendRuntimeConfig(healthJson);
      applyHealthModelCatalog(healthJson?.model_catalog);
      applyRuntimeLimits(healthJson?.runtime_limits);
    } catch (e) {
      // Non-JSON or shape mismatch — keep prior backend runtime config.
      console.debug("health body parse skipped", e);
    }
    // First successful /api/health means the Python backend is up and
    // serving — drop the boot overlay. hideBootOverlayOnce is idempotent
    // so later refreshes don't re-trigger work after the first success.
    hideBootOverlayOnce();
    // A renderer that started before the backend did has its settings
    // marked "never loaded", and stays that way — and refuses to save —
    // until they are actually read. The backend is answering now.
    void loadCfgOnce();
    // /api/network performs outbound probes, so it stays behind the same
    // token + rate-limit guard as the rest of the API.
    const netResp = await fetch("/api/network", { headers: authHeaders() });
    if (!netResp.ok) {
      setNetworkState(true, null);
      return;
    }
    const s = (await netResp.json()) as NetworkStatusResponse;
    // Honor the backend's ``online`` field instead of forcing true.
    // The old hardcoded ``true`` ignored the backend's connectivity
    // probe entirely — even when /api/network reported the network
    // unreachable, ``resolveEffectiveProvider`` kept routing to remote
    // providers, which then timed out with a confusing "remote
    // provider unreachable" error instead of falling back to local
    // Whisper as the offline indicator was supposed to enforce.
    setNetworkState(s.online !== false, s.latency_ms ?? null);
  } catch {
    setNetworkState(false, null);
  }
}

// Idempotent boot-overlay-hide hook. Called from ``refreshNetworkState``
// on first successful /api/health. Defined as function declaration so it
// hoists above refreshNetworkState's invocations.
let _bootOverlayHidden = false;
function hideBootOverlayOnce(): void {
  const overlay = document.getElementById("bootOverlay");
  if (!overlay) return;
  if (_bootOverlayHidden) return;
  if (overlay.hidden) return;
  // A diagnosis on screen outranks a health probe that happened to
  // succeed. ``__setBackendBootError`` re-shows the overlay in the
  // error state and clears ``_bootOverlayHidden``; the very next
  // ten-second network poll used to close it over the message, and the
  // user was left with a working-looking app whose backend had failed
  // to start for a reason they never got to read. The Retry button is
  // the way out of the error state.
  if (overlay.dataset.state === "error") return;
  _bootOverlayHidden = true;
  overlay.dataset.state = "success";
  const statusEl = document.getElementById("bootOverlayStatus");
  if (statusEl) statusEl.textContent = "Ready";
  // 1.1.25 fix: previously set ``overlay.hidden = true`` immediately,
  // which removes the element from layout INSTANTLY — no CSS
  // transition can run on a hidden element. The comment claimed
  // "fade out then fully hide" but the code did a hard cut. Now the
  // dataset.state="success" change drives the CSS opacity transition
  // (~300 ms in styles.css), and we wait for it to finish before
  // marking ``hidden``. When the overlay starts hidden (normal app
  // path), return above so we do not keep an invisible fixed surface
  // and spinner in the render tree.
  window.setTimeout(() => { overlay.hidden = true; }, 320);
}

document.querySelectorAll(".sb-item").forEach((e) => {
  e.addEventListener("click", () => {
    const v = parseViewName((e as HTMLElement).dataset.view || "record");
    switchView(v);
  });
});

async function loadMics(forceReload = false): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
    ($("micSelect") as HTMLSelectElement).replaceChildren(new Option("Microphone API unavailable", ""));
    return;
  }
  try {
    const sel = $("micSelect") as HTMLSelectElement;
    if (forceReload) {
      sel.replaceChildren(new Option("Loading...", ""));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    }
    const devs = await navigator.mediaDevices.enumerateDevices();
    const curVal = sel.value;
    sel.replaceChildren(new Option("Default", ""));
    const mics = devs.filter((d) => d.kind === "audioinput");
    if (mics.length === 0) {
      sel.replaceChildren(new Option("No microphones", ""));
    } else {
      mics.forEach((d, i) => {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || "Microphone " + (i + 1);
        sel.appendChild(o);
      });
    }
    const nextVal = curVal || preferredMicId || "";
    if (nextVal && Array.from(sel.options).some((o) => o.value === nextVal)) {
      sel.value = nextVal;
    }
  } catch (e) {
    console.error("Error loading microphones:", e);
    const sel = $("micSelect") as HTMLSelectElement;
    // Classify DOMException.name so the user sees actionable copy
    // instead of a single misleading "Permission denied" catch-all.
    // NotAllowed → user action (grant permission); NotFound → hardware
    // problem (plug in a mic, pick another audio device in OS); the
    // rest → transient / environment issues that need a different
    // remediation path.
    const name = (e && typeof e === "object" && "name" in (e as object))
      ? String((e as { name?: string }).name || "")
      : "";
    let label: string;
    switch (name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        label = "Permission denied";
        break;
      case "NotFoundError":
      case "DevicesNotFoundError":
        label = "No microphone detected";
        break;
      case "NotReadableError":
      case "TrackStartError":
        label = "Microphone in use by another app";
        break;
      case "OverconstrainedError":
      case "ConstraintNotSatisfiedError":
        label = "Requested microphone unavailable";
        break;
      case "SecurityError":
        label = "Microphone blocked (insecure context)";
        break;
      case "AbortError":
        label = "Microphone request was cancelled";
        break;
      default:
        label = "Microphone unavailable";
    }
    // Always rewrite — the prior condition guarded behind a dead
    // `/loading/i.test(sel.value)` regex (`sel.value` is an attribute
    // value, never the display text, so the check never fired).
    sel.replaceChildren(new Option(label, ""));
    // Tooltip carries the technical name for bug reports without
    // polluting the select's rendered text.
    sel.title = name ? `${label} (${name})` : label;
  }
}

// Mic list refreshes when the dropdown is OPENED (the reload button is
    // gone from the topbar). Debounced: getUserMedia re-probe is expensive
    // and spaming it on every open would flicker the device list.
let lastMicProbeAt = 0;
($("micSelect") as HTMLSelectElement).addEventListener("pointerdown", () => {
  const now = Date.now();
  if (now - lastMicProbeAt < 3000) return;
  lastMicProbeAt = now;
  void loadMics(true);
});

const WAVE_METER_INTERVAL_MS = 50;
const PIPELINE_FAILSAFE_MS = 10_000;

/**
 * Audio processing profile for dictation capture — the single definition
 * used by every ``getUserMedia`` call that opens a recording stream.
 *
 * Chromium defaults to a call-oriented profile. Echo cancellation and
 * noise suppression are tuned for conferencing: both attenuate a quiet
 * source and gate low-energy speech, which shows up as "the recording is
 * too quiet" and as clipped words at the start and end of a phrase.
 *
 * Automatic gain control is off for the same reason, and the reason is
 * measured, not assumed (BUGS_AUDIT_2026-09-03 §4.3): all three
 * recordings captured on 2026-09-03 start at a peak of 0 dBFS — 1.00 in
 * consecutive 100 ms windows — with an RMS of −7 dB. A crest factor of
 * 7 dB where speech normally shows 12–18 dB is a signal held in a
 * limiter: the AGC opens at maximum gain, the first words are recorded
 * in clip, and over the next five to ten seconds the gain slides back
 * 10–15 dB and never returns. A recording made in June, before the same
 * code path was reached, sat at −24 dB throughout. Nothing in the
 * renderer applies gain of its own — ``pushCapturedFrame``,
 * ``downsample`` and the worklet were checked — so the level the file
 * carries is the level the browser chose.
 *
 * There is no normaliser in its place. The PCM the WAV and the live
 * socket carry stays exactly what the device delivered; the code that
 * has to tell speech from silence measures the session's own level
 * instead of comparing it against a constant (see ./audio-levels).
 */
const DICTATION_AUDIO_PROCESSING = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

function micCaptureConstraints(deviceId: string): MediaStreamConstraints {
  const id = String(deviceId || "").trim();
  return {
    audio: id
      ? { deviceId: { exact: id }, ...DICTATION_AUDIO_PROCESSING }
      : { ...DICTATION_AUDIO_PROCESSING },
  };
}

/**
 * Longest a single ``getUserMedia`` attempt may take before it is treated
 * as wedged. Opening an input device that is free resolves in tens of
 * milliseconds; the multi-second cases are all "something else is
 * holding it" — macOS Dictation, a just-quit instance of ourselves, a
 * device still being enumerated moments after login.
 */
const MIC_ACQUIRE_TIMEOUT_MS = 2500;
const MIC_ACQUIRE_ATTEMPTS = 3;

/**
 * Acquire the capture stream without ever hanging the caller.
 *
 * ``getUserMedia`` has no timeout of its own. When the input device is
 * busy it simply never settles, and because ``startLive`` awaits it, the
 * whole start hangs: the main process gives up waiting for confirmation
 * after 8 s, the capsule sits at 00:00, and nothing recovers. Seen in
 * main.log at 21:41:33 — ``recording_start_not_confirmed`` after
 * 8709 ms, on the first hotkey press after a launch.
 *
 * Each attempt is bounded and retried, falling back to the system
 * default device once the pinned one has failed. A stream that arrives
 * after its attempt timed out is stopped rather than leaked, so a late
 * resolution can never leave the microphone open behind our back.
 */
async function acquireMicStream(deviceId: string): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    micCaptureConstraints(deviceId),
    micCaptureConstraints(deviceId),
    micCaptureConstraints(""),
  ].slice(0, MIC_ACQUIRE_ATTEMPTS);

  let lastError: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    let timedOut = false;
    try {
      const pending = navigator.mediaDevices.getUserMedia(attempts[i]);
      // Stop a stream that lands after we stopped waiting for it.
      pending
        .then((late) => {
          if (timedOut) late.getTracks().forEach((t) => t.stop());
        })
        .catch(() => { /* reported through the race below */ });
      // The timer handle MUST be cleared on success (BUG-72): an uncleared
      // timer fires 2.5 s after every successful open and its reject has
      // no consumer left — an unhandled promise rejection per mic start.
      let timerId: number | undefined;
      const stream = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timerId = window.setTimeout(() => {
            timedOut = true;
            reject(new Error(`microphone did not open within ${MIC_ACQUIRE_TIMEOUT_MS} ms`));
          }, MIC_ACQUIRE_TIMEOUT_MS);
        }).finally(() => {
          if (timerId !== undefined) window.clearTimeout(timerId);
        }),
      ]);
      if (stream.getAudioTracks().some((t) => t.readyState === "live")) return stream;
      stream.getTracks().forEach((t) => t.stop());
      lastError = new Error("microphone opened with no live audio track");
    } catch (e) {
      lastError = e;
      const msg = String((e as Error)?.message || e || "").toLowerCase();
      // A permission refusal will not become a yes on retry.
      if (msg.includes("notallowed") || msg.includes("permission denied")) throw e;
    }
    console.warn(
      `[trace startLive] microphone acquire attempt ${i + 1}/${attempts.length} failed: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    // Brief pause so a device being released by another process has a
    // moment to actually come free before the next attempt.
    if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 250));
  }
  throw lastError instanceof Error ? lastError : new Error("microphone could not be opened");
}

let vu = 0;
function setVU(rms: number): void {
  window.__transcriptorRmsLevel = Math.max(0, Number.isFinite(rms) ? rms : 0);
  vu = vu * 0.7 + rms * 0.3;
  window.__transcriptorVuLevel = Math.max(0, Math.min(1, vu * UI_TOKENS.capture.vuAmplify));
}

function resetVU(): void {
  vu = 0;
  window.__transcriptorRmsLevel = 0;
  window.__transcriptorVuLevel = 0;
  setVU(0);
}

const micHealth = new MicHealthTracker();
window.__transcriptorMicHealth = {
  get: () => micHealth.get(),
};

/** Topbar pill labels. Hidden entirely while the mic is idle. */
const MIC_PILL_LABEL: Record<MicHealthState, string> = {
  idle: "Mic idle",
  probing: "Mic connecting",
  live: "Mic live",
  silent: "Mic: no audio",
  muted: "Mic muted",
  lost: "Mic lost",
};

const MIC_PILL_TOOLTIP: Record<MicHealthState, string> = {
  idle: "Microphone status",
  probing: "Waiting for the first microphone samples…",
  live: "Microphone is delivering audio.",
  silent: describeMicHealth("silent").statusText,
  muted: describeMicHealth("muted").statusText,
  lost: describeMicHealth("lost").statusText,
};

/** Every state class this pill can carry, so a swap can clear the rest. */
const MIC_PILL_STATE_CLASSES: readonly string[] = [
  "idle", "probing", "live", "silent", "muted", "lost",
].map((state) => `mic-pill-${state}`);

function renderMicHealthPill(snap: MicHealthSnapshot): void {
  const pill = document.getElementById("micPill");
  const text = document.getElementById("micText");
  if (!pill || !text) return;
  // Swap ONLY the state class. This used to assign `className`
  // wholesale, which also wiped `status-chip` — the class that gives
  // all three topbar chips their shared background, border and radius.
  // The pill therefore rendered as bare text next to two capsules from
  // the first state change onward, and no amount of fixing the
  // stylesheet could show, because the markup had already lost the
  // class the rules were keyed to. A state writer must not own the
  // whole class attribute.
  const nextState = `mic-pill-${snap.state}`;
  for (const cls of MIC_PILL_STATE_CLASSES) {
    pill.classList.toggle(cls, cls === nextState);
  }
  text.textContent = MIC_PILL_LABEL[snap.state];
  pill.setAttribute("title", MIC_PILL_TOOLTIP[snap.state]);
  (pill as HTMLElement).hidden = snap.state === "idle";
}

micHealth.subscribe(renderMicHealthPill);

function applyMicHealthStatus(snap: MicHealthSnapshot): void {
  if (snap.state !== "silent" && snap.state !== "muted" && snap.state !== "lost") return;
  const { statusText, statusTone } = describeMicHealth(snap.state);
  patchCurrentRecordingSummary(
    { status: statusText, tone: statusTone },
    activeUiSessionToken || "",
  );
}

micHealth.subscribe(applyMicHealthStatus);

interface PersistedLiveDraft {
  /**
   * Payload schema version (BUG-12). The backend stores this blob
   * opaquely; bump on any breaking field change and branch the reader
   * on it instead of minting another LEGACY_* storage key.
   */
  schema_version: number;
  session_id?: string;
  started_at?: number;
  recording?: boolean;
  timer?: string;
  title?: string;
  source_text?: string;
  transcript_text?: string;
  provider?: string;
  provider_present?: boolean;
  model?: string;
  language?: string;
  archive_dir?: string;
  recording_collection?: string;
  updated_at?: number;
}

/** Bump on any breaking change to PersistedLiveDraft. */
const LIVE_DRAFT_SCHEMA_VERSION = 2;

type LiveDraftOperation =
  | { kind: "put"; payload: PersistedLiveDraft }
  | { kind: "clear"; sessionToken: string };

const liveDraftOperationQueue: LiveDraftOperation[] = [];
let liveDraftOperationRunner: Promise<void> | null = null;

function buildLiveDraftPayload(recording: boolean): PersistedLiveDraft {
  const provider = activeLiveSessionSnapshot?.provider ?? readProviderSelection();
  return {
    schema_version: LIVE_DRAFT_SCHEMA_VERSION,
    session_id: activeLiveSessionId || activeUiSessionToken || "",
    started_at: startAt || Date.now(),
    updated_at: Date.now(),
    recording,
    timer: liveTimerText,
    title: "Recording " + new Date(startAt || Date.now()).toLocaleString(),
    source_text: getCanonicalLiveSourceText(),
    transcript_text: ($("finalOutput").textContent || "").trim(),
    provider,
    model: activeLiveSessionSnapshot?.model || getRemoteModelValue(provider),
    language: activeLiveSessionSnapshot?.language || (($("language") as HTMLSelectElement).value || "auto"),
    archive_dir: activeLiveArchiveDir || currentArchiveDirSnapshot(),
    recording_collection: RECORDING_COLLECTIONS.live,
  };
}

async function drainLiveDraftOperations(): Promise<void> {
  try {
    while (liveDraftOperationQueue.length) {
      const op = liveDraftOperationQueue.shift();
      if (!op) continue;
      try {
        if (op.kind === "put") {
          await apiPut<{ ok?: boolean }>("/api/ui/live-draft", op.payload);
        } else {
          const query = op.sessionToken ? `?session_id=${encodeURIComponent(op.sessionToken)}` : "";
          await apiDelete<{ ok?: boolean }>(`/api/ui/live-draft${query}`);
        }
      } catch (e) {
        console.debug(`live draft ${op.kind} skipped`, e);
      }
    }
  } finally {
    liveDraftOperationRunner = null;
    if (liveDraftOperationQueue.length) {
      void startLiveDraftOperationRunner();
    }
  }
}

function startLiveDraftOperationRunner(): Promise<void> {
  if (!liveDraftOperationRunner) {
    liveDraftOperationRunner = drainLiveDraftOperations();
  }
  return liveDraftOperationRunner;
}

function enqueueLiveDraftOperation(op: LiveDraftOperation): Promise<void> {
  const lastIndex = liveDraftOperationQueue.length - 1;
  const last = lastIndex >= 0 ? liveDraftOperationQueue[lastIndex] : null;
  if (op.kind === "put" && last?.kind === "put") {
    liveDraftOperationQueue[lastIndex] = op;
  } else {
    liveDraftOperationQueue.push(op);
  }
  return startLiveDraftOperationRunner();
}

function persistLiveDraftPayload(payload: PersistedLiveDraft): Promise<void> {
  return enqueueLiveDraftOperation({ kind: "put", payload });
}

function persistLiveDraft(recording: boolean): void {
  try {
    void persistLiveDraftPayload(buildLiveDraftPayload(recording));
  } catch (e) {
    console.debug("persistLiveDraft skipped", e);
  }
}

function clearLegacyLiveDraft(sessionToken = ""): void {
  try {
    if (sessionToken) {
      const raw = localStorage.getItem(LEGACY_LIVE_DRAFT_STORAGE_KEY) || "";
      if (raw) {
        const parsed = JSON.parse(raw) as { session_id?: unknown };
        const owner = String(parsed.session_id || "").trim();
        if (owner && owner !== sessionToken) return;
      }
    }
    localStorage.removeItem(LEGACY_LIVE_DRAFT_STORAGE_KEY);
  } catch (e) {
    console.debug("legacy live draft cleanup skipped", e);
  }
}

function clearLiveDraft(sessionToken = ""): Promise<void> {
  clearLegacyLiveDraft(sessionToken);
  return enqueueLiveDraftOperation({ kind: "clear", sessionToken });
}

function parsePersistedLiveDraftPayload(parsed: unknown): PersistedLiveDraft | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  // Schema gate (BUG-73): a payload written by a NEWER schema version
  // must not be fed through the old reader — structural coercion would
  // silently misread fields instead of taking the corrupt-quarantine
  // path. Missing version = pre-versioning legacy, accepted as v1.
  const rawVersion = (parsed as Record<string, unknown>).schema_version;
  const storedVersion = typeof rawVersion === "number" ? rawVersion : 1;
  if (!Number.isFinite(storedVersion) || storedVersion > LIVE_DRAFT_SCHEMA_VERSION) {
    console.warn(
      `live draft: schema_version ${storedVersion} > supported ${LIVE_DRAFT_SCHEMA_VERSION}, discarding`,
    );
    return null;
  }
  // Structural type guard: every field that we use is coerced to its
  // expected type; anything unparseable degrades to empty string /
  // zero. This is stricter than a bare ``as`` cast and guarantees
  // downstream code never sees ``null`` / ``undefined`` / arrays /
  // wrong types in fields we promise are strings.
  const obj = parsed as Record<string, unknown>;
  const pickString = (key: string): string => {
    const v = obj[key];
    return typeof v === "string" ? v : "";
  };
  const pickNumber = (key: string): number => {
    const v = obj[key];
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    schema_version: LIVE_DRAFT_SCHEMA_VERSION,
    session_id: pickString("session_id"),
    started_at: pickNumber("started_at"),
    recording: obj.recording === true,
    timer: pickString("timer"),
    title: pickString("title"),
    source_text: pickString("source_text"),
    transcript_text: pickString("transcript_text"),
    provider: pickString("provider"),
    provider_present: Object.prototype.hasOwnProperty.call(obj, "provider"),
    model: pickString("model"),
    language: pickString("language"),
    archive_dir: pickString("archive_dir"),
    recording_collection: pickString("recording_collection"),
    updated_at: pickNumber("updated_at"),
  };
}

function parsePersistedLiveDraft(raw: string): PersistedLiveDraft | null {
  try {
    return parsePersistedLiveDraftPayload(JSON.parse(raw));
  } catch (e) {
    console.warn("live draft: invalid JSON, discarding", e);
    return null;
  }
}

async function readBackendLiveDraft(): Promise<PersistedLiveDraft | null> {
  try {
    const state = await apiGet<{ draft?: unknown }>("/api/ui/live-draft");
    return parsePersistedLiveDraftPayload(state.draft);
  } catch (e) {
    console.debug("live draft: backend read failed", e);
    return null;
  }
}

function readLegacyLiveDraft(): PersistedLiveDraft | null {
  let raw = "";
  try {
    raw = localStorage.getItem(LEGACY_LIVE_DRAFT_STORAGE_KEY) || "";
  } catch (e) {
    console.debug("live draft: legacy read failed", e);
    return null;
  }
  if (!raw) return null;
  const draft = parsePersistedLiveDraft(raw);
  if (!draft) {
    quarantineCorruptSnapshot(LEGACY_LIVE_DRAFT_CORRUPT_STORAGE_PREFIX, raw);
    clearLegacyLiveDraft();
    return null;
  }
  return draft;
}

async function recoverLiveDraftIfAny(): Promise<void> {
  let draft = await readBackendLiveDraft();
  if (!draft) {
    draft = readLegacyLiveDraft();
    if (draft) void persistLiveDraftPayload(draft);
  }
  if (!draft) return;
  try {
    const sourceText = String(draft.source_text || "").trim();
    const transcriptText = String(draft.transcript_text || "").trim();
    const sessionId = String(draft.session_id || "").trim();
    if (!sourceText && !transcriptText) {
      await clearLiveDraft(sessionId);
      return;
    }
    const stamp = Number(draft.updated_at || Date.now());
    const recovered = await saveRecordingText({
      archiveDir: String(draft.archive_dir || "").trim() || currentArchiveDirSnapshot(),
      title: String(draft.title || "Recovered recording") + " (Recovered)",
      sourceText,
      transcriptText,
      provider: draft.provider_present
        ? (String(draft.provider || "").trim() || "none")
        : "local",
      model: String(draft.model || "-"),
      language: String(draft.language || "auto"),
      recordingCollection: RECORDING_COLLECTIONS.live,
    });
    const recoveredText = transcriptText || sourceText;
    publishRecordingOutput({
      recordingId: 0,
      pasteText: recoveredText,
      domText: recoveredText,
      kind: "transcript",
    });
    setCurrentRecordingSummary({
      title: String(draft.title || "Recovered recording"),
      status: "Recovered unsaved draft from the previous session.",
      tone: "warning",
      savedName: recovered.name,
    });
    showRecordSessionNotice(
      "Recovered the last unsaved draft from a previous session.",
      "warning",
      UI_TOKENS.notice.longMs,
    );
    setStatus("Recovered " + new Date(stamp).toLocaleTimeString());
    await clearLiveDraft(sessionId);
  } catch (e) {
    console.warn("Live draft recovery failed; keeping draft for next startup", e);
  }
}

// Deepgram Nova-3 Keyterm Prompting field. Reads the raw textarea value
// as typed — no splitting/normalizing here, the backend owns that (see
// the AppConfig.preferences.deepgram doc comment). Trim only strips
// accidental leading/trailing whitespace from the whole field, the same
// treatment every other free-text preference gets (recordings_dir,
// mic_id) — internal newlines/commas the user typed are preserved.
function readDeepgramKeyterms(): string {
  const el = document.getElementById("deepgramKeytermsInput") as HTMLTextAreaElement | null;
  return (el?.value || "").trim();
}

/**
 * Dual-stream Auto, as the two controls in the Deepgram card have it.
 *
 * Both fall back to the documented backend defaults when the control is
 * missing (a shell rendering an older index.html) rather than to "off"
 * or "": persisting a value the user never chose would turn a backend
 * default off behind their back on the very first autosave. The defaults
 * and the resolution rule live in ./deepgram-dual, where they are tested.
 */
function dualStreamCheckbox(): HTMLInputElement | null {
  return document.getElementById("deepgramDualStreamCheck") as HTMLInputElement | null;
}

function dualSecondaryLanguageSelect(): HTMLSelectElement | null {
  return document.getElementById("deepgramDualSecondaryLang") as HTMLSelectElement | null;
}

/**
 * The dual-stream preference the autosave will persist, or ``undefined``
 * when this renderer genuinely does not know it.
 *
 * It used to fall back to a ``DUAL_STREAM_DEFAULT`` written in the
 * renderer — a third copy of a backend constant (B-027 / R-016), and the
 * dangerous kind: the value returned here is written back to the config
 * on the next debounced autosave, so a renderer copy that ever said
 * "off" where the backend says "on" would switch the feature off on
 * disk, permanently and invisibly. There is no renderer copy now. With
 * the control present its state is the answer; without it, the backend's
 * own default (from the bootstrap payload) is; and if neither is
 * available the key is simply not written, which leaves whatever is
 * stored alone.
 */
function readDeepgramDualStream(): boolean | undefined {
  const el = dualStreamCheckbox();
  return el ? el.checked : backendLiveDefaults?.dualStream;
}

function readDeepgramDualSecondaryLanguage(): string {
  const el = dualSecondaryLanguageSelect();
  const value = (el?.value || "").trim();
  return value || backendLiveDefaults?.secondaryLanguage || "";
}

/**
 * The one reader of ``#diarizeCheck``.
 *
 * There were five, four of them a raw ``document.getElementById`` with a
 * non-null cast — which is a ``TypeError`` in a handler the moment the
 * markup and the renderer disagree, where the Upload twin
 * (``#uploadDiarize``) has always used ``?.``.
 */
function readDiarizeEnabled(): boolean {
  return !!(document.getElementById("diarizeCheck") as HTMLInputElement | null)?.checked;
}

function collectUiPreferences(): NonNullable<NonNullable<AppConfig["preferences"]>["ui"]> {
  const silence = getAutoStopSilenceConfig();
  return {
    provider: readProviderSelection(),
    provider_group: readProviderGroup(),
    language: (($("language") as HTMLSelectElement).value || "auto").trim(),
    local_model: selectedLocalModel(),
    mic_id: (($("micSelect") as HTMLSelectElement).value || "").trim(),
    auto_transcribe: !!($("autoTranscribeToggle") as HTMLInputElement).checked,
    live_preview: !!($("livePreviewToggle") as HTMLInputElement).checked,
    upscale_enabled: !!($("upscaleToggle") as HTMLInputElement).checked,
    upscale_preset: upscalePresetId(),
    upscale_model: getUpscaleModelValue(),
    auto_send_enter: readAutoSendEnterEnabled(),
    auto_stop_silence_enabled: silence.enabled,
    auto_stop_silence_seconds: silence.seconds,
    auto_stop_silence_db: silence.thresholdDb,
    remote_model_openrouter: (uiModelByGroup.openrouter || remoteModelByProvider.openrouter || "").trim() || DEFAULT_OPENROUTER_AUDIO_MODEL,
    remote_model_deepgram: (uiModelByGroup.deepgram || remoteModelByProvider.deepgram || "").trim() || DEFAULT_DEEPGRAM_AUDIO_MODEL,
    shortcut_record: currentShortcuts.record,
    shortcut_paste: currentShortcuts.paste,
    // Upload tab — mirrors current DOM values. Optional-chained because
    // setupUploadView may not have run yet on a page that loaded
    // without the Upload section (defensive against future view splits).
    upload_language: ((document.getElementById("uploadLanguage") as HTMLSelectElement | null)?.value || "auto").trim(),
    upload_diarize: !!(document.getElementById("uploadDiarize") as HTMLInputElement | null)?.checked,
    diarize: readDiarizeEnabled(),
  };
}

// ── Keyboard Shortcut Picker ────────────────────────────────────────────────

const _isMacRenderer = (() => {
  try {
    return /Mac|iPhone|iPad/.test(navigator.platform || "")
        || /Mac OS X/.test(navigator.userAgent || "");
  } catch { return false; }
})();
const DEFAULT_SHORTCUTS = _isMacRenderer
  ? __SHORTCUT_DEFAULTS__.platformDefaults.darwin
  : __SHORTCUT_DEFAULTS__.platformDefaults.default;
let currentShortcuts = { ...DEFAULT_SHORTCUTS };
let activeShortcutBtn: HTMLButtonElement | null = null;
function postShortcutBridgeMessage(action: ShortcutBridgeAction, shortcuts: ShortcutPair = currentShortcuts): void {
  const payload = encodeURIComponent(JSON.stringify({
    action,
    record: shortcuts.record,
    paste: shortcuts.paste,
    nonce: `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  }));
  postTitleBridgeMessage(TITLE_BRIDGE_PREFIX.shortcuts, payload);
}

function publishShortcutUpdateToMain(): void {
  // One channel, one fact. This used to ALSO stash the pair on
  // ``window.__transcriptorPendingShortcuts`` for the main process to
  // poll every 2 s — a second copy of what the bridge message already
  // carries, which cost a cross-process executeJavaScript round-trip
  // for the entire life of the app and delivered the change up to 2 s
  // later than the event did.
  postShortcutBridgeMessage("update");
}

// acceleratorToDisplayTokens lives in ./shortcut-display (SSOT — the
// unit-tested module this file imports at the top); _isMacRenderer is
// injected per call so the module itself stays platform-pure.

function renderShortcutKeys(container: Element, accelerator: string): void {
  const tokens = acceleratorToDisplayTokens(accelerator, _isMacRenderer);
  container.replaceChildren(...tokens.map((token) => {
    const keycap = document.createElement("span");
    keycap.className = "shortcut-key";
    keycap.textContent = token;
    return keycap;
  }));
  container.setAttribute("aria-label", tokens.join(" "));
}

function renderShortcutCapturePrompt(container: Element): void {
  const keycap = document.createElement("span");
  keycap.className = "shortcut-key shortcut-key-prompt";
  keycap.textContent = "Press keys...";
  container.replaceChildren(keycap);
  container.setAttribute("aria-label", "Press keys");
}

/** Convert KeyboardEvent → Electron accelerator string */
function keyEventToAccelerator(e: KeyboardEvent): string | null {
  // Ignore standalone modifier keys (still being held down).
  if (["Alt", "Control", "Meta", "Shift"].includes(e.key)) return null;
  // Standalone (no-modifier) keys are allowed when the key is a
  // function-row key (F1–F12), an arrow / nav key, or another
  // dedicated control key. These are safe to bind alone because
  // they don't conflict with normal text input. Letter / digit /
  // punctuation standalone bindings would steal user typing in
  // the renderer, so those still REQUIRE at least one modifier.
  // Without this gate the Settings → Shortcuts capture refused
  // every press of F9/F10/Arrow/etc. and silently never bound.
  const hasModifier = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
  const code = String(e.code || "").trim();
  const key = String(e.key || "").trim();
  const isFunctionKey = /^F\d{1,2}$/.test(key) || /^F\d{1,2}$/.test(code);
  const isStandaloneAllowed = (
    isFunctionKey
    || key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown"
    || code === "ArrowLeft" || code === "ArrowRight" || code === "ArrowUp" || code === "ArrowDown"
    || key === "Home" || key === "End" || key === "PageUp" || key === "PageDown"
    || key === "Insert" || key === "Delete"
    || code === "Home" || code === "End" || code === "PageUp" || code === "PageDown"
    || code === "Insert" || code === "Delete"
  );
  if (!hasModifier && !isStandaloneAllowed) return null;

  const parts: string[] = [];
  // Separate Control (Ctrl) from Command (Meta/Cmd) unless BOTH are
  // held (extremely rare; fall back to the generic CommandOrControl).
  // The old `ctrlKey || metaKey → CommandOrControl` collapse silently
  // hijacked Cmd+X bindings on macOS users who meant Ctrl+X, and vice
  // versa. Electron accepts all three forms; this produces the most
  // precise binding the user actually pressed.
  if (e.ctrlKey && e.metaKey) parts.push("CommandOrControl");
  else if (e.metaKey) parts.push("Command");
  else if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  // Prefer KeyboardEvent.code for layout-stable keys so the shortcut
  // survives non-Latin keyboard layouts and remains consistent across
  // macOS / Windows / Linux. For punctuation we still accept the
  // actual emitted ASCII symbol first because Electron accelerators
  // are defined in terms of symbols, not DOM code names.
  // (`code` and `key` already declared above for the standalone-allowed
  // gate; reuse those values here.)
  let mapped: string | null = null;
  if (/^Key[A-Z]$/.test(code)) mapped = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) mapped = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) mapped = `num${code.slice(6)}`;
  else if (code === "NumpadDecimal") mapped = "numdec";
  else if (code === "NumpadAdd") mapped = "numadd";
  else if (code === "NumpadSubtract") mapped = "numsub";
  else if (code === "NumpadMultiply") mapped = "nummult";
  else if (code === "NumpadDivide") mapped = "numdiv";
  else if (key === "ArrowLeft" || code === "ArrowLeft") mapped = "Left";
  else if (key === "ArrowRight" || code === "ArrowRight") mapped = "Right";
  else if (key === "ArrowUp" || code === "ArrowUp") mapped = "Up";
  else if (key === "ArrowDown" || code === "ArrowDown") mapped = "Down";
  else if (key === " " || code === "Space") mapped = "Space";
  else if (key === "Enter" || code === "Enter" || code === "NumpadEnter") mapped = "Enter";
  else if (key === "Backspace" || code === "Backspace") mapped = "Backspace";
  else if (key === "Delete" || code === "Delete") mapped = "Delete";
  else if (key === "Insert" || code === "Insert") mapped = "Insert";
  else if (key === "Home" || code === "Home") mapped = "Home";
  else if (key === "End" || code === "End") mapped = "End";
  else if (key === "PageUp" || code === "PageUp") mapped = "PageUp";
  else if (key === "PageDown" || code === "PageDown") mapped = "PageDown";
  else if (key === "Tab" || code === "Tab") mapped = "Tab";
  else if (key === "Escape" || code === "Escape") mapped = "Escape";
  else if (/^F\d{1,2}$/.test(key)) mapped = key.toUpperCase();
  else if (key.length === 1 && /^[!@#$%^&*()_+\-=\]{}\\|;:'",.<>/?`~]$/.test(key)) mapped = key;
  else if (code === "Backquote") mapped = "`";
  else if (code === "Minus") mapped = "-";
  else if (code === "Equal") mapped = "=";
  else if (code === "BracketLeft") mapped = "[";
  else if (code === "BracketRight") mapped = "]";
  else if (code === "Backslash") mapped = "\\";
  else if (code === "Semicolon") mapped = ";";
  else if (code === "Quote") mapped = "'";
  else if (code === "Comma") mapped = ",";
  else if (code === "Period") mapped = ".";
  else if (code === "Slash") mapped = "/";
  if (!mapped) return null;
  parts.push(mapped);

  return parts.join("+");
}

function updateShortcutDisplay(btnId: string, accelerator: string): void {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) return;
  const keysSpan = btn.querySelector(".shortcut-keys");
  if (keysSpan) renderShortcutKeys(keysSpan, accelerator);
}

/**
 * Poll `window.__transcriptorShortcutStatus` (published by Electron main
 * after every globalShortcut.register) and toggle a conflict class on
 * the shortcut buttons. Without this, a shortcut that the OS refused
 * (already bound by another app) looks "saved" in Settings but does
 * nothing at all — the user has no way to know.
 */
function refreshShortcutConflictState(): void {
  const status = window.__transcriptorShortcutStatus;
  if (!status) return;
  // On macOS, detect the "F-keys as media keys" mode. When fnState is
  // explicitly false AND the user kept an F-key accelerator, the OS
  // silently eats the press as Mission Control / Exposé — register
  // succeeds but the handler never fires. Badge the affected shortcut
  // button with a hint so the user can diagnose.
  const isMacFnCollision = status.platform === "darwin" && status.macFnState === false;
  const isFKeyAccel = (accel: string | undefined): boolean => !!accel && /^F([1-9]|1[0-2])$/.test(accel);
  for (const id of ["record", "paste"] as const) {
    const entry = status[id];
    if (!entry) continue;
    const btn = document.getElementById(`shortcut${id[0].toUpperCase()}${id.slice(1)}`) as HTMLButtonElement | null;
    if (!btn) continue;
    const active = !!entry.active;
    const desired = entry.desired || "";
    // A shortcut is "conflicted" if (a) registration failed OR (b)
    // registration succeeded but macOS is going to intercept it as a
    // media key. Case (b) is invisible without this extra check.
    const macBlocked = isMacFnCollision && isFKeyAccel(desired);
    const hasConflict = !active || macBlocked;
    btn.classList.toggle("shortcut-conflict", hasConflict);
    if (!active) {
      btn.title = `Not registered: ${entry.error || "unknown reason"}`;
    } else if (macBlocked) {
      btn.title = (
        `macOS is intercepting ${desired} as a media key. ` +
        `Either enable System Settings → Keyboard → Keyboard Shortcuts → Function Keys → "Use F1, F2 as standard function keys", ` +
        `or hold Fn while pressing ${desired}, ` +
        `or pick a non-F-key accelerator here.`
      );
    } else {
      btn.title = "";
    }
  }
}
// Conflict-state badge on Settings → Shortcuts. The badge only exists
// on that pane, so the poll only exists while that pane is on screen —
// previously it woke every 2 s for the entire life of the app and
// returned early, which with `backgroundThrottling: false` is a real
// timer firing forever to decide to do nothing.
const _shortcutConflictPoll = createGatedPoll({
  name: "shortcut-conflict",
  intervalMs: 2000,
  shouldRun: () => rendererIsVisible() && isViewVisible("settings"),
  tick: () => { refreshShortcutConflictState(); },
});
gatedPolls.push(_shortcutConflictPoll);
// Symmetric cleanup: a ``pagehide`` event fires before any teardown
// (Electron renderer reload, dev hot-reload, real navigation away),
// so clearing here prevents a stale handle from leaking across hot
// reloads in development.
window.addEventListener("pagehide", () => {
  if (activeShortcutBtn) {
    stopShortcutRecording(true);
  }
}, { once: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && activeShortcutBtn) {
    stopShortcutRecording(true);
  }
  // The window appearing or disappearing moves every gate.
  syncGatedPolls();
});

function startShortcutRecording(btn: HTMLButtonElement): void {
  // Cancel any existing recording
  stopShortcutRecording(false, false);
  activeShortcutBtn = btn;
  btn.classList.add("recording");
  const keysSpan = btn.querySelector(".shortcut-keys");
  if (keysSpan) renderShortcutCapturePrompt(keysSpan);
  postShortcutBridgeMessage("capture-start");
  // Add global keydown listener
  document.addEventListener("keydown", handleShortcutKeydown, true);
  // Outside-click cancel: without this, clicking ANYWHERE other than
  // a shortcut row left capture mode active. The keydown listener
  // stayed attached to ``document`` and any subsequent keypress
  // (typing in another field, pressing arrow keys to scroll, etc.)
  // silently rebound the user's shortcut. The visible ``.recording``
  // class on the button was the only cue that capture was still
  // active, and a user who navigated to another tab couldn't even
  // see it. Capture phase so we beat per-element click handlers.
  document.addEventListener("mousedown", handleShortcutOutsideMousedown, true);
}

function stopShortcutRecording(restoreDisplay: boolean, notifyMain = true): void {
  if (!activeShortcutBtn) return;
  activeShortcutBtn.classList.remove("recording");
  if (restoreDisplay) {
    const id = activeShortcutBtn.dataset.shortcutId;
    const acc = id === "record" ? currentShortcuts.record : currentShortcuts.paste;
    const keysSpan = activeShortcutBtn.querySelector(".shortcut-keys");
    if (keysSpan) renderShortcutKeys(keysSpan, acc);
  }
  document.removeEventListener("keydown", handleShortcutKeydown, true);
  document.removeEventListener("mousedown", handleShortcutOutsideMousedown, true);
  activeShortcutBtn = null;
  if (notifyMain && restoreDisplay) {
    postShortcutBridgeMessage("capture-cancel");
  }
}

/**
 * Outside-click cancel for the shortcut-recording mode. Fires before
 * any element-level click handler (capture phase) so we can revert
 * display + detach the keydown listener BEFORE a click on the OTHER
 * shortcut row's button triggers its own ``startShortcutRecording``
 * (which itself calls ``stopShortcutRecording(false)`` for a clean
 * hand-off, but there's no harm in our cancelling first).
 *
 * Containment check uses ``Node.contains`` so clicks on the keys-span
 * inside the active button (e.g. the user double-clicks the visible
 * accelerator text) are treated as clicks ON the button — recording
 * stays active so the user can press fresh keys.
 */
function handleShortcutOutsideMousedown(e: MouseEvent): void {
  if (!activeShortcutBtn) return;
  const target = e.target as Node | null;
  if (!target) return;
  if (activeShortcutBtn.contains(target)) return;
  stopShortcutRecording(true);
}

function handleShortcutKeydown(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  if (e.key === "Escape") {
    stopShortcutRecording(true);
    return;
  }

  const accelerator = keyEventToAccelerator(e);
  if (!accelerator) return; // Still pressing only modifiers

  if (!activeShortcutBtn) return;
  const id = activeShortcutBtn.dataset.shortcutId;
  const otherId = id === "record" ? "paste" : "record";
  // Reject duplicates: if the user rebinds one action to the SAME
  // accelerator as the other, only one globalShortcut.register call
  // succeeds (the second overwrites/fails), leaving the first action
  // silently broken. Surface the conflict and revert instead.
  if (accelerator === currentShortcuts[otherId as "record" | "paste"]) {
    showRecordSessionNotice(
      `That shortcut is already bound to "${otherId === "record" ? "Record" : "Paste"}". Pick a different combination.`,
      "warning",
      6000,
    );
    stopShortcutRecording(true);
    return;
  }
  if (id === "record") {
    currentShortcuts.record = accelerator;
  } else if (id === "paste") {
    currentShortcuts.paste = accelerator;
  }

  // Update display
  const keysSpan = activeShortcutBtn.querySelector(".shortcut-keys");
  if (keysSpan) renderShortcutKeys(keysSpan, accelerator);

  stopShortcutRecording(false);

  // Persist to config
  queueUiPreferencesSave();

  // Signal the Electron main process to reload shortcuts immediately.
  // The window flag remains as a fallback for older/polling paths, but
  // the title bridge is the durable transport: it avoids the debounce
  // race with /api/config writes and temporarily-suspended hotkeys are
  // re-registered in the same path that received the captured keys.
  publishShortcutUpdateToMain();
  void flushUiPreferencesSaveNow();
}

function shouldUpscale(): boolean {
  return !!($("upscaleToggle") as HTMLInputElement).checked;
}

function readAutoSendEnterEnabled(): boolean {
  const settingsToggle = document.getElementById("settingsAutoSendEnterToggle") as HTMLInputElement | null;
  return !!settingsToggle?.checked;
}

/**
 * The auto-send label was hardcoded to the macOS combination in
 * index.html, so Windows and Linux users read "Auto-send Cmd+Ctrl
 * Enter" while the main process actually sends plain Ctrl+Enter
 * (`SendKeys "^{ENTER}"` / `xdotool key ctrl+Return`). Derive it from
 * the platform the renderer is running on so the setting names the
 * keystroke the user will really get.
 */
function syncAutoSendEnterLabel(): void {
  const toggle = document.getElementById("settingsAutoSendEnterToggle");
  const label = toggle?.closest("label")?.querySelector("span");
  if (!label) return;
  label.textContent = _isMacRenderer
    ? "Auto-send Cmd+Ctrl Enter"
    : "Auto-send Ctrl+Enter";
}

function setAutoSendEnterEnabled(enabled: boolean): void {
  const on = !!enabled;
  const settingsToggle = document.getElementById("settingsAutoSendEnterToggle") as HTMLInputElement | null;
  if (settingsToggle && settingsToggle.checked !== on) {
    settingsToggle.checked = on;
  }
}

function upscalePresetId(): string {
  return (($("upscalePresetSelect") as HTMLSelectElement).value || "").trim();
}

function selectedUpscalePreset(): UpscalePresetItem | undefined {
  const id = upscalePresetId();
  return upscalePresets.find((x) => x.id === id);
}

function syncUpscalePresetControls(): void {
  const upscaleEnabled = shouldUpscale();
  const catalogAvailable = upscalePresets.length > 0;
  const controlsEnabled = upscaleEnabled && catalogAvailable;
  const sel = $("upscalePresetSelect") as HTMLSelectElement;
  const wrap = $("upscalePresetWrap") as HTMLDivElement;
  const editBtn = $("upscalePresetEditBtn") as HTMLButtonElement;
  const addBtn = $("upscalePresetAddBtn") as HTMLButtonElement;
  const delBtn = $("upscalePresetDeleteBtn") as HTMLButtonElement;
  // The preset dropdown (Clean / Business / AI & Code / Refine) must
  // ALWAYS be visible so the user can see what upscale variations
  // exist and choose one BEFORE turning the toggle on. Hiding the
  // controls when upscale is off made the whole toolbar look empty
  // and the user reported "вариации апскейла не отображаются". We
  // now disable instead of hiding — the controls dim out at 0.5
  // opacity when the toggle is off, signalling that they are
  // inactive but still available, and become fully interactive the
  // moment the toggle is flipped on.
  wrap.hidden = false;
  sel.disabled = !controlsEnabled;
  editBtn.hidden = false;
  editBtn.disabled = !controlsEnabled;
  addBtn.hidden = false;
  addBtn.disabled = !controlsEnabled;
  delBtn.hidden = false;
  const canDelete = !!(selectedUpscalePreset() && !selectedUpscalePreset()!.builtin);
  delBtn.disabled = !controlsEnabled || !canDelete;
  delBtn.classList.toggle("can-delete", controlsEnabled && canDelete);
  // The model select is a sibling of the preset-wrap, not inside it,
  // so it must be toggled separately. Previously this was omitted —
  // the model dropdown stayed fully interactive even when the entire
  // upscale toolbar was at 0.5 opacity, confusing users into thinking
  // they could configure upscale while it was disabled.
  const modelSel = document.getElementById("upscaleModelSelect") as HTMLSelectElement | null;
  if (modelSel) modelSel.disabled = !upscaleEnabled;
  // Visual dimming for the entire toolbar when upscale is OFF.
  // pointer-events: none prevents cursor/hover artefacts on the
  // dimmed row; individual disabled attributes still block keyboard.
  // The copy-paste bug (both branches were "") is fixed here.
  const toolbar = wrap.closest(".pane-toolbar-actions-upscale") as HTMLElement | null;
  if (toolbar) {
    toolbar.style.opacity = controlsEnabled ? "1" : "0.5";
    toolbar.style.pointerEvents = controlsEnabled ? "" : "none";
  }
}

async function loadUpscalePresets(preferredId = ""): Promise<void> {
  const sel = $("upscalePresetSelect") as HTMLSelectElement;
  const prev = preferredId || sel.value || pendingUpscalePresetId || "";
  let items: UpscalePresetItem[] = [];
  let fallbackPresetId = "";
  let loadedFromBackend = false;
  try {
    const r = await apiGet<{ items: UpscalePresetItem[]; default_preset_id?: string }>("/api/upscale/presets");
    items = Array.isArray(r.items) ? r.items : [];
    fallbackPresetId = String(r.default_preset_id || "").trim();
    loadedFromBackend = true;
  } catch (e) {
    console.warn("loadUpscalePresets: backend preset catalog unavailable", e);
  }
  upscalePresets = items;
  if (loadedFromBackend) {
    defaultUpscalePresetId = fallbackPresetId;
  }
  sel.innerHTML = "";
  if (!upscalePresets.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "Presets unavailable";
    o.disabled = true;
    sel.appendChild(o);
    sel.value = "";
    pendingUpscalePresetId = prev;
    syncUpscalePresetControls();
    return;
  } else {
    upscalePresets.forEach((item) => {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.name;
      sel.appendChild(o);
    });
  }
  // Default selection strategy when the user hasn't saved a preference yet:
  //   1. Honour explicitly-requested preferredId / pendingUpscalePresetId
  //   2. Use backend-published default_preset_id
  //   3. Fall back to the first backend preset in the list
  let next: string;
  const defaultPresetId = defaultUpscalePresetId && upscalePresets.some((x) => x.id === defaultUpscalePresetId)
    ? defaultUpscalePresetId
    : "";
  if (prev && upscalePresets.some((x) => x.id === prev)) {
    next = prev;
  } else if (defaultPresetId) {
    next = defaultPresetId;
  } else {
    next = upscalePresets[0]?.id || "";
  }
  sel.value = next;
  pendingUpscalePresetId = "";
  const addBtn = $("upscalePresetAddBtn") as HTMLButtonElement;
  const customCount = upscalePresets.filter((x) => !x.builtin).length;
  addBtn.disabled = customCount >= 3;
  syncUpscalePresetControls();
}

function openUpscalePresetModal(): void {
  const name = $("upscalePresetNameInput") as HTMLInputElement;
  const instruction = $("upscalePresetInstructionInput") as HTMLTextAreaElement;
  $("upscalePresetMsg").textContent = "";
  name.value = "";
  instruction.value =
    "Improve transcript quality: keep same language as input, preserve meaning, fix punctuation and grammar. Return only final transcript text without quotes.";
  openModal("upscalePresetModal", "#upscalePresetNameInput");
}

function closeUpscalePresetModal(): void {
  closeModal("upscalePresetModal");
}

function openUpscalePromptModal(): void {
  const preset = selectedUpscalePreset();
  if (!preset) return;
  ($("upscalePromptPresetName") as HTMLInputElement).value = preset.name || preset.id;
  ($("upscalePromptPresetId") as HTMLInputElement).value = preset.id;
  ($("upscalePromptInstructionInput") as HTMLTextAreaElement).value =
    String(preset.instruction || preset.default_instruction || "").trim();
  $("upscalePromptMsg").textContent = "";
  openModal("upscalePromptModal", "#upscalePromptInstructionInput");
}

let upscalePromptSaveCloseTimer: number | null = null;

function closeUpscalePromptModal(): void {
  if (upscalePromptSaveCloseTimer !== null) {
    clearTimeout(upscalePromptSaveCloseTimer);
    upscalePromptSaveCloseTimer = null;
  }
  closeModal("upscalePromptModal");
}

function getUpscaleModelValue(): string {
  const el = document.getElementById("upscaleModelSelect") as HTMLSelectElement | null;
  const fromDropdown = (el?.value || "").trim();
  if (fromDropdown) return fromDropdown;
  return DEFAULT_UPSCALE_MODEL;
}

function populateUpscaleModelOptions(): void {
  const sel = document.getElementById("upscaleModelSelect") as HTMLSelectElement | null;
  if (!sel) return;
  const preferred = (sel.value || "").trim() || DEFAULT_UPSCALE_MODEL;
  const ids = new Set<string>(OPENROUTER_UPSCALE_MODELS.map((m) => m.id));
  // Keep any user-added custom model by merging it into the list.
  if (preferred) ids.add(preferred);
  sel.innerHTML = "";
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = labelForUpscaleModel(id);
    // Keep the full id in the title attribute for hover — the short
    // label in the dropdown is for layout, not for hiding the source
    // model.
    opt.title = id;
    sel.appendChild(opt);
  }
  sel.value = ids.has(preferred) ? preferred : DEFAULT_UPSCALE_MODEL;
}

/**
 * Serialises upscale calls so the user can never accidentally fire
 * two concurrent requests on the same input (e.g., by stopping one
 * recording and immediately stopping another, or by toggling the
 * upscale switch mid-flight).
 *
 * Keyed by sessionToken to guarantee that only one upscale per
 * session is in flight, but multiple sessions can still process in
 * parallel (important when the user stops B while A is still being
 * upscaled). The in-flight promise is returned so the second caller
 * observes the same result as the first.
 */
const upscaleInFlightBySession = new Map<string, Promise<string>>();

async function runUpscaleIfEnabled(
  text: string,
  sessionToken = "",
  opts: { setDoneStatus?: boolean } = {},
): Promise<string> {
  const input = String(text || "").trim();
  if (!input) return "";
  const setDoneStatus = opts.setDoneStatus !== false;
  if (!shouldUpscale()) {
    if (isCurrentUiSession(sessionToken)) {
      $("upscaleOutput").textContent = "";
      $("upscaleLatency").textContent = "--";
    }
    return input;
  }
  // When caller omits sessionToken, two concurrent file-transcription
  // paths would share the placeholder key and the second call would
  // receive the FIRST call's upscaled text — writing the wrong result
  // into the second session's DOM. Make the placeholder unique per
  // invocation so coalescing only happens for a genuine same-session
  // duplicate (which always carries an explicit token).
  const inflightKey = sessionToken || `__no_session__:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const existing = upscaleInFlightBySession.get(inflightKey);
  if (existing) {
    return existing;
  }
  // Per-invocation nonce for the DOM's placeholder ownership.
  // Passed alongside the "Upscaling..." write via dataset so a late
  // completing session can check "is the DOM still showing MY
  // placeholder, or did someone else write something since?". Text-
  // equality to "Upscaling..." is too weak — pass-14 used it and
  // collided because two sessions write the identical literal.
  const placeholderNonce = `${inflightKey}:${Math.random().toString(36).slice(2, 10)}`;
  const upscaleOutputEl = $("upscaleOutput") as HTMLElement;
  const promise = (async (): Promise<string> => {
    setStatusScoped(sessionToken, "Upscaling");
    if (isCurrentUiSession(sessionToken)) {
      upscaleOutputEl.textContent = "Upscaling...";
      upscaleOutputEl.dataset.upscaleNonce = placeholderNonce;
    }
    const t0 = performance.now();
    const upscaleModel = getUpscaleModelValue();
    try {
      const selectedPresetId = upscalePresetId();
      const payload: { text: string; preset_id?: string; model?: string } = {
        text: input,
        model: upscaleModel || undefined,
      };
      if (selectedPresetId) payload.preset_id = selectedPresetId;
      const r = await apiPost<{ ok: boolean; text: string; preset_id: string; model: string; trimmed_chars?: number }>("/api/upscale", payload);
      const out = String(r.text || "").trim();
      if (!out) throw new Error("Upscale returned empty text");
      const trimmedChars = Number(r.trimmed_chars || 0);
      if (trimmedChars > 0) {
        console.warn(`Upscale: backend trimmed ${trimmedChars} leading chars`);
        setStatusScoped(sessionToken, `Upscaling trimmed first ${trimmedChars.toLocaleString()} chars`, "warning");
      }
      // Session-aware success write. We write if EITHER:
      //   (a) this session is still the current UI session, OR
      //   (b) the DOM is still showing OUR specific placeholder
      //       (dataset.upscaleNonce === placeholderNonce). This
      //       covers the pass-12 stuck-on-placeholder case without
      //       letting session A clobber session B's IDENTICAL
      //       "Upscaling..." string (pass-14's text-equality sentinel
      //       collided because both sessions wrote the same literal).
      const isStillOurPlaceholder =
        upscaleOutputEl.dataset.upscaleNonce === placeholderNonce;
      if (isCurrentUiSession(sessionToken) || isStillOurPlaceholder) {
        upscaleOutputEl.textContent = out;
        upscaleOutputEl.dataset.upscaleNonce = "";
        $("upscaleLatency").textContent = fmtMs(performance.now() - t0);
      }
      if (setDoneStatus) setStatusScoped(sessionToken, "Done");
      return out;
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e || "Unknown upscale error");
      // Surface actionable guidance for the most common failure modes
      // instead of raw backend text. Users who see "HTTP 400
      // OpenRouter key is not configured" don't know that they need
      // to open Settings → API Keys → OpenRouter and paste a key.
      let friendly: string;
      const low = rawMsg.toLowerCase();
      // Match HTTP status tokens only as standalone words, not bare
      // substrings — a request id, timestamp, or unrelated payload
      // could contain "401" / "429" as four digits and wrongly map
      // to the wrong branch. Backend emits "HTTP 4XX" shape tokens.
      if (
        low.includes("openrouter key is not configured") ||
        /\bhttp\s*401\b/.test(low) ||
        /\b401\s+(unauthorized|forbidden)\b/.test(low)
      ) {
        friendly = "Upscale needs an OpenRouter API key.\n\nOpen Settings → API Keys → OpenRouter and paste your key, then try again.";
      } else if (/\bhttp\s*429\b/.test(low) || low.includes("rate limit")) {
        friendly = "Upscale hit the OpenRouter rate limit.\n\nWait a moment and try again, or pick a less-busy model in Settings → Upscale.\n\nUsing original transcript.";
      } else if (/\bhttp\s*402\b/.test(low) || low.includes("insufficient credit") || low.includes("out of credit") || low.includes("quota exceeded")) {
        friendly = "OpenRouter account is out of credits.\n\nTop up at openrouter.ai/credits or switch the upscale model to a free-tier option in Settings → Upscale.\n\nUsing original transcript.";
      } else if (/\bhttp\s*404\b/.test(low) || low.includes("model not found") || low.includes("no endpoints found for")) {
        friendly = "Upscale model is unavailable.\n\nYou may have picked a paid-tier model without a paid OpenRouter account. Open Settings → Upscale and pick a different model.\n\nUsing original transcript.";
      } else if (/\bhttp\s*5\d{2}\b/.test(low) || low.includes("service unavailable") || low.includes("bad gateway")) {
        friendly = "OpenRouter is temporarily unavailable (provider-side error).\n\nTry again in a minute, or switch upscale model in Settings → Upscale.\n\nUsing original transcript.";
      } else if (low.includes("content filter") || low.includes("content policy") || low.includes("refused to")) {
        friendly = "Upscale model refused to process this text (content filter).\n\nThe original transcript is used as-is.";
      } else if (isGenericFetchFailure(low)) {
        friendly = "Upscale request failed: the OpenRouter API is unreachable.\n\nCheck your internet connection or try a VPN. OpenRouter is sometimes blocked in certain regions.\n\nUsing original transcript.";
      } else if (low.includes("unsupported upscale preset")) {
        friendly = "Upscale preset is missing.\n\nOpen Settings → Upscale and re-select a preset.";
      } else {
        friendly = `Upscale failed: ${rawMsg}\n\nUsing original transcript.`;
      }
      // Error-path write: same nonce-gated logic as success. If the
      // DOM still shows OUR placeholder (no newer session has
      // overwritten), render the friendly error so the user sees
      // feedback — even for a session that has moved on. Otherwise
      // skip silently (don't clobber a newer session's result).
      const isStillOurPlaceholderErr =
        upscaleOutputEl.dataset.upscaleNonce === placeholderNonce;
      if (isCurrentUiSession(sessionToken) || isStillOurPlaceholderErr) {
        upscaleOutputEl.textContent = friendly;
        upscaleOutputEl.dataset.upscaleNonce = "";
        $("upscaleLatency").textContent = fmtMs(performance.now() - t0);
      }
      if (setDoneStatus) setStatusScoped(sessionToken, "Done");
      return input;
    } finally {
      upscaleInFlightBySession.delete(inflightKey);
    }
  })();
  upscaleInFlightBySession.set(inflightKey, promise);
  return promise;
}

const ASYNC_TIMEOUT_SENTINEL = Symbol("async-timeout");

function waitForTimeoutMs(ms: number): Promise<typeof ASYNC_TIMEOUT_SENTINEL> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(ASYNC_TIMEOUT_SENTINEL), Math.max(0, ms));
  });
}

async function runLivePasteUpscaleWithinSla(
  text: string,
  sessionToken: string,
  opts: { setDoneStatus?: boolean } = {},
): Promise<string> {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (!shouldUpscale()) {
    return runUpscaleIfEnabled(raw, sessionToken, opts);
  }
  const timeoutMs = UI_TOKENS.upscale.livePasteReadyTimeoutMs;
  const upscalePromise = runUpscaleIfEnabled(raw, sessionToken, opts);
  const result = await Promise.race([
    upscalePromise,
    waitForTimeoutMs(timeoutMs),
  ]);
  if (result !== ASYNC_TIMEOUT_SENTINEL) {
    return String(result || raw).trim() || raw;
  }
  console.warn(
    `Live paste-ready upscale exceeded ${timeoutMs}ms; publishing original transcript and letting upscale finish in background.`,
  );
  void upscalePromise.catch((e) => {
    console.warn("Late live upscale failed after paste-ready fallback:", e);
  });
  if (isCurrentUiSession(sessionToken)) {
    patchCurrentRecordingSummary({
      status: "Transcript is ready. Upscale is still finishing in the background.",
      tone: "info",
    }, sessionToken);
  }
  return raw;
}

// Serialized settings-save pipeline.
//
// ``queueUiPreferencesSave`` can be called many times per second
// (slider drag, select change, toggle click). We debounce so only
// the LAST change within ``settings.saveDebounceMs`` fires, but
// two rapid bursts could still produce back-to-back fire events
// whose apiPost calls overlap — and the backend ``save_config``
// is not atomic against concurrent writes (load_config → merge →
// tmp write → replace). Overlapping saves can lose fields or
// serialize updates in the wrong order.
//
// We serialize with an in-flight chain: each new save awaits the
// previous save's completion before issuing its own request. The
// debounce still batches bursts, and the chain guarantees FIFO
// ordering so the last write always wins.
let uiPrefInFlightChain: Promise<void> = Promise.resolve();
let uiPrefPendingSave = false;

function buildUiPreferencesSavePlan() {
  const provider = readProviderSelection();
  const remoteProvider = provider === "openrouter" || provider === "deepgram" ? provider : "openrouter";
  const openrouterModel = (remoteModelByProvider.openrouter || "").trim() || DEFAULT_OPENROUTER_AUDIO_MODEL;
  const nextRecordingsDir = ($("recordingsDirInput") as HTMLInputElement).value.trim();
  const dualStreamPref = readDeepgramDualStream();
  const dualSecondaryPref = readDeepgramDualSecondaryLanguage();
  return {
    nextRecordingsDir,
    shouldRefreshRecordingsArchive: nextRecordingsDir !== configuredRecordingsDir,
    payload: {
      preferences: {
        recordings_dir: nextRecordingsDir,
        remote_provider: remoteProvider,
        // SSOT: derive default from OPENROUTER_AUDIO_MODELS so a future
        // version bump (e.g. gemini-2.6-flash) flows through; the prior
        // hardcoded literal would silently keep stuck on 2.5-flash.
        openrouter: { model: openrouterModel || DEFAULT_OPENROUTER_AUDIO_MODEL },
        // Raw, unparsed string — see the AppConfig.preferences.deepgram
        // doc comment. Sent through the same debounced/serialized save
        // as every other preference, so a stale backend that doesn't
        // yet know this key still round-trips it via config.py's
        // deep-merge (unvalidated keys pass through untouched).
        // A key this renderer cannot answer for is NOT written: config.py
        // deep-merges the update, so an omitted key leaves the stored
        // value untouched. Writing a guess instead is what would make an
        // absent backend payload switch a backend default off on disk.
        deepgram: {
          keyterms: readDeepgramKeyterms(),
          ...(dualStreamPref === undefined ? {} : { dual_stream: dualStreamPref }),
          ...(dualSecondaryPref ? { dual_secondary_language: dualSecondaryPref } : {}),
        },
        ui: collectUiPreferences(),
      },
    },
  };
}

function enqueueUiPreferencesSave(plan: ReturnType<typeof buildUiPreferencesSavePlan>): Promise<void> {
  // Chain each save after the previous one's completion (success
  // or failure — we don't want one transient 500 to block all
  // future saves). The ``Promise.resolve()`` tail guarantees the
  // chain never carries a rejected state forward.
  uiPrefInFlightChain = uiPrefInFlightChain
    .catch(() => { })
    .then(async () => {
      try {
        await apiPost<{ ok: boolean }>("/api/config", plan.payload);
        configuredRecordingsDir = plan.nextRecordingsDir;
        if (!plan.shouldRefreshRecordingsArchive) return;
        setSettingsArchiveStatus("Archive folder saved.", "success");
        activeResolvedRecordingsDir = "";
        recordingsBootstrapReady = false;
        const reloadTask = loadRecordings(false).catch((e) => {
          console.warn("Recordings archive reload failed", e);
          const msg = sanitizeUiErrorMessage(e, "Recordings archive reload failed.");
          setSettingsArchiveStatus(`Archive reload failed: ${msg}`, "warning");
        });
        const trackedReloadPromise = reloadTask.finally(() => {
          if (recordingsBootstrapPromise === trackedReloadPromise) {
            recordingsBootstrapPromise = null;
          }
          recordingsBootstrapReady = !!currentArchiveDirSnapshot();
        });
        recordingsBootstrapPromise = trackedReloadPromise;
      } catch (e) {
        const msg = sanitizeUiErrorMessage(e, "Settings were not saved.");
        setStatus(`Settings save failed: ${msg}`, "error");
        if (plan.shouldRefreshRecordingsArchive) {
          setSettingsArchiveStatus(`Archive settings save failed: ${msg}`, "error");
        }
        showRecordSessionNotice(`Settings were not saved: ${msg}`, "error", UI_TOKENS.notice.defaultMs);
      }
    });
  return uiPrefInFlightChain;
}

function queueUiPreferencesSave(): void {
  if (!mayAutosaveUiPreferences({
    loaded: uiPreferencesLoaded,
    suppressed: suppressUiPrefAutosave,
  })) {
    // Never write preferences we never read. See ./settings-autosave.
    if (!suppressUiPrefAutosave) {
      console.warn("settings autosave suppressed: preferences have never been loaded");
    }
    return;
  }
  uiPrefPendingSave = true;
  if (uiPrefSaveTimer) {
    clearTimeout(uiPrefSaveTimer);
    uiPrefSaveTimer = null;
  }
  uiPrefSaveTimer = window.setTimeout(() => {
    uiPrefSaveTimer = null;
    if (!uiPrefPendingSave) return;
    uiPrefPendingSave = false;
    void enqueueUiPreferencesSave(buildUiPreferencesSavePlan());
  }, UI_TOKENS.settings.saveDebounceMs);
}

function flushUiPreferencesSaveNow(): Promise<void> {
  if (uiPrefSaveTimer) {
    clearTimeout(uiPrefSaveTimer);
    uiPrefSaveTimer = null;
  }
  if (!uiPrefPendingSave) {
    return uiPrefInFlightChain.catch(() => { });
  }
  uiPrefPendingSave = false;
  return enqueueUiPreferencesSave(buildUiPreferencesSavePlan());
}

function flushUiPreferencesSaveBestEffort(): void {
  void flushUiPreferencesSaveNow();
}

window.addEventListener("pagehide", flushUiPreferencesSaveBestEffort, { capture: true });
window.addEventListener("beforeunload", flushUiPreferencesSaveBestEffort, { capture: true });

async function loadCfg(): Promise<void> {
  suppressUiPrefAutosave = true;
  let shouldPersistShortcutMigration = false;
  try {
    const cfg = await apiGet<AppConfig>("/api/config");
    const orK = ((cfg.providers || {}).openrouter || {}).key;
    const dgK = ((cfg.providers || {}).deepgram || {}).key;
    hasOpenrouterKey = !!String(orK || "").trim();
    hasDeepgramKey = !!String(dgK || "").trim();
    markKeyMasked("openrouter", hasOpenrouterKey);
    markKeyMasked("deepgram", hasDeepgramKey);
    keyInput("openrouter").placeholder = "OPENROUTER_API_KEY";
    keyInput("deepgram").placeholder = "DEEPGRAM_API_KEY";
    syncKeyActionButton("openrouter");
    syncKeyActionButton("deepgram");
    // SSOT default mirrors DEFAULT_OPENROUTER_AUDIO_MODEL. Same SSOT
    // rationale as the autosave path above.
    const cfgOpenrouterModel = (cfg.preferences || {}).openrouter?.model || DEFAULT_OPENROUTER_AUDIO_MODEL;
    configuredRecordingsDir = (cfg.preferences || {}).recordings_dir || "";
    ($("recordingsDirInput") as HTMLInputElement).value = configuredRecordingsDir;
    const deepgramPrefs = (cfg.preferences || {}).deepgram || {};
    const keytermsEl = document.getElementById("deepgramKeytermsInput") as HTMLTextAreaElement | null;
    if (keytermsEl) keytermsEl.value = String(deepgramPrefs.keyterms || "");
    // The options come from ``#language`` itself, so the two lists cannot
    // drift; this runs before the stored value is applied, or there would
    // be nothing to select it from.
    fillDualSecondaryLanguageOptions();
    const dualLangSel = dualSecondaryLanguageSelect();
    const dualCheck = dualStreamCheckbox();
    if (backendLiveDefaults) {
      const dualPrefs = resolveDualStreamPreference({
        dualStream: deepgramPrefs.dual_stream,
        secondaryLanguage: deepgramPrefs.dual_secondary_language,
        availableLanguages: dualLangSel
          ? Array.from(dualLangSel.options).map((o) => o.value)
          : [backendLiveDefaults.secondaryLanguage],
        // The backend's answer to "what does an absent preference mean",
        // not the renderer's (B-027 / R-016).
        fallback: backendLiveDefaults,
      });
      if (dualCheck) dualCheck.checked = dualPrefs.dualStream;
      if (dualLangSel && Array.from(dualLangSel.options).some((o) => o.value === dualPrefs.secondaryLanguage)) {
        dualLangSel.value = dualPrefs.secondaryLanguage;
      }
    } else if (typeof deepgramPrefs.dual_stream === "boolean" && dualCheck) {
      // No bootstrap payload reached this renderer, so what an ABSENT
      // preference means is unknown and must not be invented — only an
      // explicitly stored value may move the control. Anything the
      // renderer showed here would be persisted by the next autosave.
      dualCheck.checked = deepgramPrefs.dual_stream;
    }
    const ui = (cfg.preferences || {}).ui || {};
    remoteModelByProvider.openrouter = String(ui.remote_model_openrouter || cfgOpenrouterModel || "").trim() || DEFAULT_OPENROUTER_AUDIO_MODEL;
    remoteModelByProvider.deepgram = String(ui.remote_model_deepgram || DEFAULT_DEEPGRAM_AUDIO_MODEL || "").trim() || DEFAULT_DEEPGRAM_AUDIO_MODEL;
    const languageSel = $("language") as HTMLSelectElement;
    if (ui.language && Array.from(languageSel.options).some((o) => o.value === ui.language)) {
      languageSel.value = ui.language;
    }
    syncAutoLanguageUi();
    // Restore the unified selection from persisted wire values
    // (provider + local_model + per-provider remote models). The UI
    // group is DERIVED (gigaam-* local model ⇒ gigaam group), never
    // persisted — the wire format stays backward compatible.
    {
      const hasStoredProvider = Object.prototype.hasOwnProperty.call(ui, "provider");
      const wire = hasStoredProvider
        ? normalizeProviderSelection(ui.provider, "local")
        : "local";
      const storedLocal = String(ui.local_model || "").trim();
      const group = groupFromWire(wire, storedLocal);
      if (group === "local-whisper" || group === "gigaam") {
        if (storedLocal && LOCAL_TRANSCRIPTION_MODELS.includes(storedLocal)) {
          uiModelByGroup[group] = storedLocal;
        }
        lastLocalGroup = group;
      }
      uiModelByGroup.deepgram = remoteModelByProvider.deepgram;
      uiModelByGroup.openrouter = remoteModelByProvider.openrouter;
      // The "None" provider option was removed: transcription always has
      // a provider now, so a legacy stored "" coerces to Whisper.
      uiProviderGroup = group;
    }
    const auto = $("autoTranscribeToggle") as HTMLInputElement;
    const livePreview = $("livePreviewToggle") as HTMLInputElement;
    auto.checked = ui.auto_transcribe !== false;
    // Live preview defaults to OFF. History: the original ``=== true``
    // gate left fresh users staring at an empty pane ("live транскрипция
    // не работает" was the default, not broken streaming), so it became
    // ``!== false``; the user then explicitly chose OFF as the shipped
    // default — streaming itself was never the problem, and a pane that
    // fills in uninvited is noise during dictation. Strict-equal keeps
    // existing explicit ``true`` preferences working unchanged.
    livePreview.checked = ui.live_preview === true;
    const autoStopEnabledEl = $("autoStopSilenceEnabled") as HTMLInputElement;
    const autoStopSecondsEl = $("autoStopSilenceSeconds") as HTMLInputElement;
    const autoStopDbEl = $("autoStopSilenceDb") as HTMLInputElement;
    autoStopEnabledEl.checked = ui.auto_stop_silence_enabled === true;
    autoStopSecondsEl.value = String(clampAutoStopSeconds(Number(ui.auto_stop_silence_seconds)));
    autoStopDbEl.value = String(clampAutoStopThresholdDb(Number(ui.auto_stop_silence_db)));
    const upscaleToggle = $("upscaleToggle") as HTMLInputElement;
    upscaleToggle.checked = ui.upscale_enabled === true;
    setAutoSendEnterEnabled(ui.auto_send_enter === true);
    pendingUpscalePresetId = String(ui.upscale_preset || "").trim();
    // Restore persisted upscale model; populateUpscaleModelOptions
    // merges it into the dropdown if it's not in the built-in list.
    const storedUpscaleModel = String(ui.upscale_model || "").trim();
    hasStoredUpscaleModelPreference = !!storedUpscaleModel;
    const upscaleModelSelectEl = document.getElementById("upscaleModelSelect") as HTMLSelectElement | null;
    if (upscaleModelSelectEl) {
      upscaleModelSelectEl.value = storedUpscaleModel || DEFAULT_UPSCALE_MODEL;
    }
    populateUpscaleModelOptions();
    preferredMicId = String(ui.mic_id || "").trim();
    renderTranscriptionSelectors();
    await loadUpscalePresets(pendingUpscalePresetId);

    // Upload tab — provider/model mirrors are rendered from the SAME
    // unified SSOT state as the Transcribe toolbar (no separate
    // upload provider any more); only language/diarize are
    // upload-specific and restored here.
    renderTranscriptionSelectors();
    updateUploadProviderHint();
    const uploadLanguageEl = document.getElementById("uploadLanguage") as HTMLSelectElement | null;
    if (uploadLanguageEl && ui.upload_language) {
      const wanted = String(ui.upload_language).trim();
      if (Array.from(uploadLanguageEl.options).some((o) => o.value === wanted)) {
        uploadLanguageEl.value = wanted;
      }
    }
    const uploadDiarizeEl = document.getElementById("uploadDiarize") as HTMLInputElement | null;
    if (uploadDiarizeEl && typeof ui.upload_diarize === "boolean") {
      uploadDiarizeEl.checked = ui.upload_diarize;
    }
    const diarizeEl = document.getElementById("diarizeCheck") as HTMLInputElement | null;
    if (diarizeEl && typeof ui.diarize === "boolean") {
      diarizeEl.checked = ui.diarize;
    }

    // Load keyboard shortcuts. Defaults are platform-specific
    // (DEFAULT_SHORTCUTS at module scope) — Mac=Option+Left/Shift+V,
    // Win/Linux=Control+Alt+Shift+R/V.
    //
    // Retired-pair rewrites are ONE rule now (D-015),
    // ``desktop/shortcut-migration.js``'s ``migrateShortcutPair``,
    // driven by ``shortcut-defaults.json``'s ``legacy`` entries — the
    // same rule desktop/main.js runs on the SAME data before this
    // renderer ever reads the config. This used to be two hand-written
    // `if` blocks here, one migration behind main.js's three: the
    // Windows/Linux F9/F10 retirement (BUGS_AUDIT §6.10) was added to
    // main.js alone, so on Windows the main process registered
    // `Control+Alt+Shift+R` while Settings kept displaying `F9` and the
    // next autosave wrote `F9`/`F10` back to disk. Calling the shared
    // rule instead of re-deriving it is what keeps that from happening
    // again the next time a pair is retired.
    const stored = {
      record: String(ui.shortcut_record || "").trim(),
      paste: String(ui.shortcut_paste || "").trim(),
    };
    const migrated = migrateShortcutPair(stored, {
      manifest: __SHORTCUT_DEFAULTS__,
      defaults: DEFAULT_SHORTCUTS,
      platform: _isMacRenderer ? "darwin" : "other",
    }) as { record: string; paste: string; applied: Array<{ id: string; from: string; to: string }> };
    const rawRecord: string = migrated.record;
    const rawPaste: string = migrated.paste;
    const didMigrate = migrated.applied.length > 0;
    for (const step of migrated.applied) {
      console.log(`[trace shortcuts] migrated stale ${step.from} → ${step.to} (${step.id})`);
    }
    if (rawRecord) currentShortcuts.record = rawRecord;
    if (rawPaste) currentShortcuts.paste = rawPaste;
    updateShortcutDisplay("shortcutRecord", currentShortcuts.record);
    updateShortcutDisplay("shortcutPaste", currentShortcuts.paste);
    if (didMigrate) {
      // Persist + signal Electron to re-register globalShortcut with
      // the migrated accelerators immediately.
      publishShortcutUpdateToMain();
      shouldPersistShortcutMigration = true;
    }
    // The DOM now reflects the backend, so — and only so — autosave may
    // write it back.
    uiPreferencesLoaded = true;
  } catch (configError) {
    console.warn("Initial config load failed, retrying backend preset catalog load", configError);
    const msg = sanitizeUiErrorMessage(configError, "Settings could not be loaded.");
    setSettingsArchiveStatus(
      `Settings are not loaded (${msg}). Changes are not being saved — reopen Settings once the backend is ready.`,
      "error",
    );
    showRecordSessionNotice(
      `Settings could not be loaded: ${msg}. Your saved preferences are intact, but changes made now will not be saved.`,
      "error",
      9000,
    );
    try {
      await loadUpscalePresets(pendingUpscalePresetId);
    } catch (presetError) {
      console.warn("Backend preset catalog retry failed", presetError);
    }
  } finally {
    suppressUiPrefAutosave = false;
    if (shouldPersistShortcutMigration) queueUiPreferencesSave();
  }
}

/**
 * Load the configuration if it has never been loaded, at most once at a
 * time.
 *
 * The startup call and the health poll both go through here. Without the
 * retry, "we are not saving your settings" would be the permanent state
 * of a session that merely started before the backend did — the ordinary
 * case on a cold machine. Without the single-flight, the 10 s health poll
 * would stack a fresh `GET /api/config` on top of the startup one that
 * has not answered yet. It stops retrying the moment a load succeeds.
 * (The boot overlay's Retry button needs no hook: it reloads the renderer
 * outright.)
 */
let configLoadInFlight: Promise<void> | null = null;
function loadCfgOnce(): Promise<void> {
  if (uiPreferencesLoaded) return Promise.resolve();
  if (!configLoadInFlight) {
    configLoadInFlight = loadCfg().finally(() => {
      configLoadInFlight = null;
    });
  }
  return configLoadInFlight;
}

/**
 * Light client-side validation before POSTing a provider key.
 *
 * Catches the obvious user mistakes (empty, pasted with surrounding
 * quotes / whitespace, "Bearer " prefix, way too short) with a clear
 * inline error instead of letting the wrong value hit the provider
 * later and surface as a confusing HTTP 401 during transcription. We
 * deliberately do NOT enforce provider-specific regex shapes beyond
 * this — providers rotate their key formats (Deepgram already moved
 * from hex-only to JWT-style in 2024) and a too-strict frontend
 * rejects legitimate new-format keys.
 */
function validateProviderKey(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  let v = (raw || "").trim();
  // Strip common paste-from-email artefacts.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  // Strip an accidental "Bearer " prefix that users copy from API docs.
  if (/^bearer\s+/i.test(v)) {
    v = v.replace(/^bearer\s+/i, "").trim();
  }
  if (!v) return { ok: false, error: "Key is empty. Paste your API key and try again." };
  if (v.includes(" ") || v.includes("\t") || v.includes("\n")) {
    return { ok: false, error: "Key contains whitespace. API keys should be a single token with no spaces." };
  }
  if (v.length < 16) {
    return { ok: false, error: "Key looks too short. Make sure you copied the full key from the provider dashboard." };
  }
  return { ok: true, value: v };
}

async function saveProviderKey(provider: RemoteProvider): Promise<void> {
  const input = keyInput(provider);
  const raw = isMaskedKeyInput(input) ? "" : input.value;
  if (!raw && isMaskedKeyInput(input)) {
    // Masked placeholder state — nothing to save, stay silent (user
    // opened Settings but didn't edit). Same behaviour as before the
    // validation hook.
    return;
  }
  const v = validateProviderKey(raw);
  if (!v.ok) {
    throw new Error(v.error);
  }
  // Reflect the sanitized value back into the input so the user sees
  // exactly what we saved (e.g., if we stripped surrounding quotes).
  input.value = v.value;
  await apiPost<{ ok: boolean }>("/api/config", {
    providers: {
      [provider]: { key: v.value },
    },
  });
  if (provider === "openrouter") {
    hasOpenrouterKey = true;
  } else {
    hasDeepgramKey = true;
  }
  markKeyMasked(provider, true);
  syncKeyActionButton(provider);
}

async function deleteProviderKey(provider: RemoteProvider): Promise<void> {
  await apiPost<{ ok: boolean }>("/api/config", {
    providers: {
      [provider]: { key: "" },
    },
  });
  if (provider === "openrouter") {
    hasOpenrouterKey = false;
  } else {
    hasDeepgramKey = false;
  }
  markKeyMasked(provider, false);
  syncKeyActionButton(provider);
}

async function handleKeyAction(provider: RemoteProvider): Promise<void> {
  const btn = keyActionButton(provider);
  if (btn.classList.contains("delete")) {
    await deleteProviderKey(provider);
    return;
  }
  await saveProviderKey(provider);
}

($("recordingsDirInput") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("deepgramKeytermsInput") as HTMLTextAreaElement).addEventListener("change", () => queueUiPreferencesSave());
($("autoStopSilenceEnabled") as HTMLInputElement).addEventListener("change", () => {
  queueUiPreferencesSave();
});
($("autoStopSilenceSeconds") as HTMLInputElement).addEventListener("change", () => {
  // Reflect the clamped value back into the DOM. `getAutoStopSilenceConfig`
  // already clamps via `clampNumber(..., 1, 120)`, but the input element
  // itself kept the raw user-typed value. Result was a UI/state mismatch:
  // user typed `999` and saw `999` while the persisted config held `120`.
  // Now the displayed value matches the saved value at all times.
  const inp = $("autoStopSilenceSeconds") as HTMLInputElement;
  const cfg = getAutoStopSilenceConfig();
  if (String(cfg.seconds) !== inp.value) inp.value = String(cfg.seconds);
  queueUiPreferencesSave();
});
($("autoStopSilenceDb") as HTMLInputElement).addEventListener("change", () => {
  // Same UI/state-mismatch fix as above for the silence threshold.
  const inp = $("autoStopSilenceDb") as HTMLInputElement;
  const cfg = getAutoStopSilenceConfig();
  if (String(cfg.thresholdDb) !== inp.value) inp.value = String(cfg.thresholdDb);
  queueUiPreferencesSave();
});
($("upscaleToggle") as HTMLInputElement).addEventListener("change", () => {
  syncUpscalePresetControls();
  queueUiPreferencesSave();
});
["openrouter", "deepgram"].forEach((providerName) => {
  const provider = providerName as RemoteProvider;
  const input = keyInput(provider);
  const btn = keyActionButton(provider);
  input.addEventListener("focus", () => {
    clearMaskedKeyOnEdit(provider);
    syncKeyActionButton(provider);
  });
  input.addEventListener("blur", () => {
    // Restore the mask when the user leaves without typing.
    //
    // Focus clears it so a click lands you straight into typing a
    // replacement. Without this counterpart, clicking the field and
    // clicking away left it EMPTY — showing the placeholder, so a
    // provider with a perfectly good stored key looked unconfigured.
    // Restoring is safe precisely because the mask is a display of
    // stored state, never the state itself: the real key lives in the
    // backend config and the field is only ever a view of "one is set".
    if (keySavedState[provider] && !input.value.trim()) {
      markKeyMasked(provider, true);
    }
    syncKeyActionButton(provider);
  });
  input.addEventListener("input", () => {
    syncKeyActionButton(provider);
  });
  btn.addEventListener("click", () => {
    void handleKeyAction(provider).catch((e: Error) => {
      // Surface failures to the user. Pre-fix, a bad key / network
      // error was logged to the devtools console only — the Save
      // button would silently revert and the user had no idea why
      // transcription still complained about "key not configured".
      console.error(e?.message || e);
      const providerLabel = provider === "openrouter" ? "OpenRouter" : "Deepgram";
      const detail = sanitizeUiErrorMessage(e, "Could not save the key.");
      setStatus(`Could not save ${providerLabel} key: ${detail}`, "error");
      // Visual marker on the input so the user sees where the
      // problem is, even if they've scrolled away from the status
      // pill. Cleared automatically on the next focus/input event.
      const inputEl = keyInput(provider);
      inputEl.setAttribute("aria-invalid", "true");
      inputEl.classList.add("has-error");
      const clearError = () => {
        inputEl.removeAttribute("aria-invalid");
        inputEl.classList.remove("has-error");
        inputEl.removeEventListener("focus", clearError);
        inputEl.removeEventListener("input", clearError);
      };
      inputEl.addEventListener("focus", clearError);
      inputEl.addEventListener("input", clearError);
      syncKeyActionButton(provider);
    });
  });
});
($("settingsAutoSendEnterToggle") as HTMLInputElement).addEventListener("change", () => {
  setAutoSendEnterEnabled(($("settingsAutoSendEnterToggle") as HTMLInputElement).checked);
  queueUiPreferencesSave();
});
($("upscalePresetSelect") as HTMLSelectElement).addEventListener("change", () => {
  syncUpscalePresetControls();
  queueUiPreferencesSave();
});
($("upscalePresetAddBtn") as HTMLButtonElement).addEventListener("click", () => openUpscalePresetModal());
($("upscalePresetEditBtn") as HTMLButtonElement).addEventListener("click", () => openUpscalePromptModal());
($("upscalePresetCancelBtn") as HTMLButtonElement).addEventListener("click", () => closeUpscalePresetModal());
($("upscalePresetModal") as HTMLDivElement).addEventListener("click", (e) => {
  if (e.target === $("upscalePresetModal")) closeUpscalePresetModal();
});
($("upscalePromptCancelBtn") as HTMLButtonElement).addEventListener("click", () => closeUpscalePromptModal());
($("upscalePromptModal") as HTMLDivElement).addEventListener("click", (e) => {
  if (e.target === $("upscalePromptModal")) closeUpscalePromptModal();
});
($("upscalePresetSaveBtn") as HTMLButtonElement).addEventListener("click", () => {
  const name = (($("upscalePresetNameInput") as HTMLInputElement).value || "").trim();
  const instruction = (($("upscalePresetInstructionInput") as HTMLTextAreaElement).value || "").trim();
  const msg = $("upscalePresetMsg");
  if (!name) {
    msg.textContent = "Preset name is required.";
    return;
  }
  if (!instruction) {
    msg.textContent = "Instruction is required.";
    return;
  }
  msg.textContent = "Saving...";
  void apiPost<{ ok: boolean; item: UpscalePresetItem }>("/api/upscale/presets", { name, instruction })
    .then(async (r) => {
      closeUpscalePresetModal();
      await loadUpscalePresets(r.item?.id || "");
      queueUiPreferencesSave();
    })
    .catch((e: Error) => {
      msg.textContent = e.message;
    });
});
($("upscalePromptSaveBtn") as HTMLButtonElement).addEventListener("click", () => {
  const presetId = (($("upscalePromptPresetId") as HTMLInputElement).value || "").trim();
  const instruction = (($("upscalePromptInstructionInput") as HTMLTextAreaElement).value || "").trim();
  const msg = $("upscalePromptMsg");
  if (!presetId) {
    msg.textContent = "Preset is missing.";
    return;
  }
  if (!instruction) {
    msg.textContent = "Instruction is required.";
    return;
  }
  msg.textContent = "Saving...";
  void apiPut<{ ok: boolean; item: UpscalePresetItem }>(`/api/upscale/presets/${encodeURIComponent(presetId)}`, { instruction })
    .then(async () => {
      await loadUpscalePresets(presetId);
      queueUiPreferencesSave();
      msg.textContent = "Saved";
      // Cancellable — closeUpscalePromptModal clears this handle if the
      // user dismisses the modal manually (Esc, click-outside) before
      // the 220ms elapses, preventing the timer from firing on an
      // already-closed or freshly-reopened modal.
      if (upscalePromptSaveCloseTimer !== null) clearTimeout(upscalePromptSaveCloseTimer);
      upscalePromptSaveCloseTimer = window.setTimeout(() => {
        upscalePromptSaveCloseTimer = null;
        closeUpscalePromptModal();
      }, 220);
    })
    .catch((e: Error) => {
      msg.textContent = e.message;
    });
});
($("upscalePromptDefaultBtn") as HTMLButtonElement).addEventListener("click", () => {
  const presetId = (($("upscalePromptPresetId") as HTMLInputElement).value || "").trim();
  const msg = $("upscalePromptMsg");
  if (!presetId) return;
  msg.textContent = "Resetting...";
  void apiPost<{ ok: boolean; item: UpscalePresetItem }>(`/api/upscale/presets/${encodeURIComponent(presetId)}/reset-default`, {})
    .then(async () => {
      await loadUpscalePresets(presetId);
      const preset = selectedUpscalePreset();
      ($("upscalePromptInstructionInput") as HTMLTextAreaElement).value =
        String(preset?.instruction || preset?.default_instruction || "").trim();
      queueUiPreferencesSave();
      msg.textContent = "Default applied";
    })
    .catch((e: Error) => {
      msg.textContent = e.message;
    });
});
($("upscalePresetDeleteBtn") as HTMLButtonElement).addEventListener("click", () => {
  const cur = selectedUpscalePreset();
  if (!cur || cur.builtin) return;
  // Confirm before destructive action. Custom upscale presets can
  // hold dozens of lines of carefully-tuned prompt instructions —
  // a single accidental click previously dropped them with no undo.
  // The delete-all-recordings flow has a modal for the same reason;
  // mirror that severity floor here. ``window.confirm`` is the
  // simplest blocking primitive that respects keyboard navigation
  // and matches the platform's native dialog style.
  const presetLabel = String(cur.name || cur.id || "this preset").trim();
  const confirmed = window.confirm(
    `Delete the upscale preset “${presetLabel}”?\n\nThis cannot be undone.`,
  );
  if (!confirmed) return;
  void fetch(`/api/upscale/presets/${encodeURIComponent(cur.id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(await parseError(r));
      await loadUpscalePresets("");
      queueUiPreferencesSave();
    })
    .catch((e: Error) => {
      $("upscaleOutput").textContent = `Preset delete failed: ${e.message}`;
    });
});
($("pickRecordingsDirBtn") as HTMLButtonElement).addEventListener("click", () => {
  const btn = $("pickRecordingsDirBtn") as HTMLButtonElement;
  btn.disabled = true;
  setSettingsArchiveStatus("Choosing archive folder...", "info");
  void apiPost<{ path: string }>("/api/recordings/pick-folder", {})
    .then((r) => {
      ($("recordingsDirInput") as HTMLInputElement).value = r.path || "";
      setSettingsArchiveStatus("Archive folder selected. Saving settings...", "success");
      queueUiPreferencesSave();
    })
    .catch((e: Error) => {
      const msg = sanitizeUiErrorMessage(e, "Could not choose archive folder.");
      console.error(e.message);
      setSettingsArchiveStatus(`Choose folder failed: ${msg}`, "error");
      setStatus(`Choose folder failed: ${msg}`, "error");
    })
    .finally(() => {
      btn.disabled = false;
    });
});
($("openRecordingsDirBtn") as HTMLButtonElement).addEventListener("click", () => {
  const btn = $("openRecordingsDirBtn") as HTMLButtonElement;
  btn.disabled = true;
  setSettingsArchiveStatus("Opening archive folder...", "info");
  void apiPost<{ ok: boolean; path: string }>("/api/recordings/open-folder", {
    path: ($("recordingsDirInput") as HTMLInputElement).value.trim(),
  })
    .then(() => {
      setSettingsArchiveStatus("Archive folder opened.", "success");
    })
    .catch((e: Error) => {
      const msg = sanitizeUiErrorMessage(e, "Could not open archive folder.");
      console.error(e.message);
      setSettingsArchiveStatus(`Open folder failed: ${msg}`, "error");
      setStatus(`Open folder failed: ${msg}`, "error");
    })
    .finally(() => {
      btn.disabled = false;
    });
});

// ── Shortcut picker click listeners ─────────────────────────────────────────
$("shortcutRecord").addEventListener("click", (e) => {
  e.preventDefault();
  startShortcutRecording($("shortcutRecord") as HTMLButtonElement);
});
$("shortcutPaste").addEventListener("click", (e) => {
  e.preventDefault();
  startShortcutRecording($("shortcutPaste") as HTMLButtonElement);
});
$("resetShortcutsBtn").addEventListener("click", () => {
  currentShortcuts = { ...DEFAULT_SHORTCUTS };
  updateShortcutDisplay("shortcutRecord", currentShortcuts.record);
  updateShortcutDisplay("shortcutPaste", currentShortcuts.paste);
  // Push to main process for live reload.
  publishShortcutUpdateToMain();
  queueUiPreferencesSave();
  void flushUiPreferencesSaveNow();
});

// ── Settings → Command line ─────────────────────────────────────────────────
//
// The backend is the only author of what this section shows (see
// src/cli-section.ts). Here: fetch it, paint it, and post the switch.

let cliAccessStatus: CliAccessStatus = CLI_ACCESS_OFF;
/** Set while a switch request is in flight, so the toggle cannot race itself. */
let cliAccessBusy = false;

function setCliAccessError(message: string): void {
  const node = $("cliAccessError");
  const text = String(message || "").trim();
  node.textContent = text;
  node.hidden = !text;
}

function renderCliSection(): void {
  const view = cliSectionView(cliAccessStatus);
  const toggle = $("cliAccessToggle") as HTMLInputElement;
  toggle.checked = view.enabled;
  toggle.disabled = cliAccessBusy;
  $("cliAccessNote").textContent = view.summary;

  const wrap = $("cliAccessCards");
  wrap.hidden = !view.showCards;
  wrap.textContent = "";
  for (const card of view.cards) {
    const row = document.createElement("div");
    row.className = "cli-card";

    const head = document.createElement("div");
    head.className = "cli-card-head";
    const title = document.createElement("span");
    title.className = "cli-card-title";
    title.textContent = card.title;
    head.appendChild(title);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn btn-ghost cli-card-copy";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", `Copy: ${card.title}`);
    // The command travels on the element, not through a lookup by index
    // into a list that re-renders under it.
    copy.addEventListener("click", () => {
      void copyCliCard(copy, card.text, card.title);
    });
    head.appendChild(copy);
    row.appendChild(head);

    // textContent, never innerHTML: this string is a shell command with
    // a filesystem path in it, and the path is the user's.
    const body = document.createElement("pre");
    body.className = "cli-card-text";
    body.textContent = card.text;
    row.appendChild(body);

    if (card.note) {
      const note = document.createElement("p");
      note.className = "cli-card-note";
      note.textContent = card.note;
      row.appendChild(note);
    }
    wrap.appendChild(row);
  }
}

async function copyCliCard(btn: HTMLButtonElement, text: string, title: string): Promise<void> {
  const ok = await writeTextToClipboard(text);
  flashButtonFeedback(btn, ok ? "Copied" : "Copy failed", `Copy: ${title}`, {
    durationMs: UI_TOKENS.feedback.flashMs,
    // A text button: the visible label swaps too, not only the one a
    // screen reader hears.
    swapLabel: true,
  });
}

async function refreshCliSection(): Promise<void> {
  try {
    cliAccessStatus = normalizeCliStatus(await apiGet<unknown>("/api/cli"));
    setCliAccessError("");
  } catch (e) {
    // Do not leave the previous answer on screen: an unreachable
    // backend is not evidence that access is still on.
    cliAccessStatus = CLI_ACCESS_OFF;
    setCliAccessError(sanitizeUiErrorMessage(e, "Could not read command-line access."));
  }
  renderCliSection();
}

async function setCliAccess(next: boolean): Promise<void> {
  if (cliAccessBusy) return;
  cliAccessBusy = true;
  renderCliSection();
  try {
    const route = next ? "/api/cli/enable" : "/api/cli/disable";
    cliAccessStatus = normalizeCliStatus(await apiPost<unknown>(route, {}));
    setCliAccessError("");
    setStatus(next ? "Command-line access is on." : "Command-line access is off.", "info");
  } catch (e) {
    // The switch reports what the backend holds, so a failed write
    // leaves it where the backend left it — re-read rather than
    // assuming the click took effect.
    setCliAccessError(
      sanitizeUiErrorMessage(
        e,
        next ? "Could not switch command-line access on." : "Could not switch it off.",
      ),
    );
    try {
      cliAccessStatus = normalizeCliStatus(await apiGet<unknown>("/api/cli"));
    } catch {
      cliAccessStatus = CLI_ACCESS_OFF;
    }
  } finally {
    cliAccessBusy = false;
    renderCliSection();
  }
}

$("cliAccessToggle").addEventListener("change", (e) => {
  void setCliAccess((e.target as HTMLInputElement).checked);
});

let recordingItems: RecordingItem[] = [];
let selectedRecordingName = "";
let selectedRecordingArchiveDir = "";
let recordingsStatsOpen = false;
let recordingsSearchQuery = "";
// How many filtered rows are currently materialised. Grows as the user
// scrolls toward the end; reset (never silently shrunk) whenever the
// filtered set is replaced wholesale. See ./list-window for the policy.
let recordingsWindowSize = RECORDINGS_WINDOW_MINIMUM;

/**
 * Single writer for the History search query.
 *
 * Changing the query replaces the filtered set, which makes the carried
 * window meaningless — a window grown to 1400 rows over the previous
 * query would materialise 1400 rows of the new one on its first paint.
 * Routing every write through here is what keeps the reset paired with
 * the change; four separate call sites previously each assigned the
 * variable directly.
 */
function setRecordingsSearchQuery(next: string): void {
  const normalized = String(next || "").trim().toLowerCase();
  if (normalized === recordingsSearchQuery) return;
  recordingsSearchQuery = normalized;
  invalidateFilteredRecordings();
  resetRecordingsWindow();
}

function resetRecordingsWindow(): void {
  recordingsWindowSize = RECORDINGS_WINDOW_MINIMUM;
}
let recordingsLoadRequestSeq = 0;
let recordingOpenRequestSeq = 0;
let recordingsStatsRequestSeq = 0;
/**
 * How many foreground archive reads are in flight.
 *
 * A boolean here meant the ``finally`` of a SUPERSEDED request cleared
 * the state a newer one had set — the alternative to the original bug,
 * where only the winner cleared it and an error on a superseded request
 * left History disabled forever. A count has neither failure: every
 * request clears its own, and the controls come back when the last one
 * is done.
 */
let recordingsForegroundLoads = 0;
let recordingsUiLoading = false;
let configuredRecordingsDir = "";
let activeResolvedRecordingsDir = "";
let recordingsBootstrapReady = false;
let recordingsBootstrapPromise: Promise<void> | null = null;
let activeModalId = "";
let lastModalFocus: HTMLElement | null = null;

function syncRecordingsStatsVisibility(): void {
  $("recordingsStatsPanel").hidden = !recordingsStatsOpen;
  const btn = $("recordingsStatsBtn") as HTMLButtonElement;
  if (recordingsStatsOpen) {
    btn.classList.add("active");
    btn.textContent = "Hide";
    btn.setAttribute("aria-label", "Hide stats");
    btn.setAttribute("aria-pressed", "true");
  } else {
    btn.classList.remove("active");
    btn.textContent = "Stats";
    btn.setAttribute("aria-label", "Show stats");
    btn.setAttribute("aria-pressed", "false");
  }
}

async function refreshRecordingsStatsIfVisible(): Promise<void> {
  // No request, so nothing to cancel: this used to bump the request
  // sequence here, which is the cancellation mechanism, from the branch
  // that makes no request. Closing the panel is what cancels an
  // in-flight read, and that is where the bump lives now.
  if (!recordingsStatsOpen) return;
  await loadRecordingsStats();
}

function updateRecordingCopyState(): void {
  const btn = $("recordingCopyBtn") as HTMLButtonElement;
  const hasText = !!($("recordingContent").textContent || "").trim();
  btn.disabled = !hasText;
}

function resetRecordingViewer(placeholder: string = UI_COPY.recordings.viewerPlaceholder): void {
  $("recordingTitleLabel").textContent = UI_COPY.recordings.viewerTitlePlaceholder;
  $("recordingMeta").textContent = "";
  $("recordingContent").setAttribute("aria-busy", "false");
  $("recordingContent").setAttribute("data-placeholder", placeholder);
  $("recordingContent").textContent = "";
  const player = $("recordingAudio") as HTMLAudioElement;
  player.pause();
  revokeRecordingViewerAudioUrl();
  player.removeAttribute("src");
  player.load();
  setRecordingViewerAudioRowVisible(false);
  updateRecordingCopyState();
}

function setRecordingViewerLoading(displayName: string, willLoadAudio = false): void {
  $("recordingTitleLabel").textContent = displayName || "Loading recording";
  $("recordingMeta").textContent = "Loading…";
  $("recordingContent").setAttribute("aria-busy", "true");
  $("recordingContent").setAttribute("data-placeholder", "Loading recording...");
  $("recordingContent").textContent = "";
  const player = $("recordingAudio") as HTMLAudioElement;
  player.pause();
  revokeRecordingViewerAudioUrl();
  player.removeAttribute("src");
  player.load();
  setRecordingViewerAudioRowVisible(willLoadAudio, willLoadAudio);
  updateRecordingCopyState();
}

function reconcileCurrentRecordingSummaryWithArchive(): void {
  const savedName = String(currentRecordingSummary?.savedName || "").trim();
  if (!savedName) return;
  const savedArchiveDir = String(latestSavedAudioState?.archiveDir || "").trim();
  if (recordingItems.some((item) =>
    item.name === savedName &&
    (!savedArchiveDir || recordingArchiveDir(item) === savedArchiveDir)
  )) return;
  setCurrentRecordingSummary({
    ...(currentRecordingSummary as CurrentRecordingSummary),
    savedName: "",
    tone: currentRecordingSummary?.tone === "error" ? "error" : "warning",
    status: "Saved files for this session are no longer present in the active recordings archive.",
  });
}

function syncLatestSavedAudioFromRecordings(): void {
  reconcileCurrentRecordingSummaryWithArchive();
  // If the current audio state holds an in-memory File blob from an
  // active or just-completed stopLive session, do NOT overwrite it.
  // The in-memory blob is the authoritative audio for the CURRENT
  // recording and is always the freshest. Overwriting it with a
  // backend-served URL from ``recordingItems`` can regress to a STALE
  // recording if the recordings list hasn't refreshed yet or if audio
  // retention hasn't pruned the old file. The user reported "старая
  // голосовуха всё ещё висит" because this function ran from a fire-
  // and-forget ``loadRecordings`` and replaced the fresh in-memory
  // blob with a backend reference to the previous recording's audio.
  if (latestSavedAudioState?.file) return;

  const freshestWithAudio = recordingItems.find((item) => item.has_audio);
  if (!freshestWithAudio) {
    setLatestSavedAudio(null);
    return;
  }
  const current = latestSavedAudioState;
  const archiveDir = recordingArchiveDir(freshestWithAudio);
  const sameRecording = !!current?.savedName &&
    current.savedName === freshestWithAudio.name &&
    (!current.archiveDir || current.archiveDir === archiveDir);
  setLatestSavedAudio({
    title: freshestWithAudio.display_name || recordingTitleFromName(freshestWithAudio.name),
    savedName: freshestWithAudio.name,
    archiveDir,
    sizeBytes: Number(freshestWithAudio.audio_size_bytes || current?.sizeBytes || 0),
    downloadName: freshestWithAudio.audio_name || current?.downloadName || `${freshestWithAudio.name.replace(/\.txt$/i, "")}.wav`,
    mimeType: freshestWithAudio.audio_mime || current?.mimeType || "",
    file: sameRecording ? (current?.file || null) : null,
  });
}

/**
 * The filtered archive, memoised.
 *
 * Recomputing it is an O(N) pass that concatenates six fields, lowercases
 * the result and substring-searches it, over an archive `list-window.ts`
 * itself sizes at ~5900 entries. It was being recomputed on every scroll
 * event — first line of the scroll handler, ahead of the cheap geometry
 * test that answers "is there anything to do?" — and twice per frame
 * whenever the window actually grew, which is the exact cost the
 * windowing exists to avoid. It ran twice per keystroke while searching,
 * too.
 *
 * Only two things change the answer, and both invalidate here: the
 * payload of a completed load, and the search query.
 */
let filteredRecordingsCache: RecordingItem[] | null = null;

function invalidateFilteredRecordings(): void {
  filteredRecordingsCache = null;
}

function getFilteredRecordings(): RecordingItem[] {
  if (filteredRecordingsCache) return filteredRecordingsCache;
  const query = recordingsSearchQuery.trim().toLowerCase();
  const result = !query ? recordingItems : recordingItems.filter((item) => {
    const haystack = [
      item.display_name,
      item.source_file || "",
      item.name,
      item.provider,
      item.language,
      item.recording_collection || "",
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
  filteredRecordingsCache = result;
  return result;
}

function setRecordingsUiLoading(nextLoading: boolean): void {
  recordingsUiLoading = !!nextLoading;
  $("recordingsList").setAttribute("aria-busy", recordingsUiLoading ? "true" : "false");
  ($("recordingsRefreshBtn") as HTMLButtonElement).disabled = recordingsUiLoading;
  ($("recordingsSearchInput") as HTMLInputElement).disabled = recordingsUiLoading;
  syncRecordingsSearchControls();
}

async function writeTextToClipboard(text: string): Promise<boolean> {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) {
    console.debug("navigator.clipboard.writeText failed; trying fallback", e);
  }

  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "true");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return document.execCommand("copy") === true;
  } catch (e) {
    console.warn("execCommand copy fallback failed", e);
    return false;
  } finally {
    ta.remove();
  }
}

async function copyRecordingText(): Promise<void> {
  const text = ($("recordingContent").textContent || "").trim();
  if (!text) return;
  const btn = $("recordingCopyBtn") as HTMLButtonElement;
  const ok = await writeTextToClipboard(text);
  flashButtonFeedback(btn, ok ? "Copied" : "Copy failed", "Copy recording text", {
    durationMs: UI_TOKENS.feedback.flashMs,
  });
}

async function copyTextContent(text: string, btnId = ""): Promise<void> {
  const value = String(text || "").trim();
  if (!value) return;
  const ok = await writeTextToClipboard(value);
  if (btnId) {
    const btn = $(btnId) as HTMLButtonElement;
    flashButtonFeedback(
      btn,
      ok ? "Copied" : "Copy failed",
      btnId === "resultCopyBtn" ? "Copy result text" : "Copy upscale text",
      { durationMs: UI_TOKENS.feedback.flashMs },
    );
  }
}

function isArchiveMutationConflict(error: unknown): boolean {
  const message = String((error as Error)?.message || "").toLowerCase();
  return message.includes("no longer exists in the target archive") || message.includes("archive directory is no longer available");
}

function currentArchiveDirSnapshot(): string {
  return String(activeResolvedRecordingsDir || "").trim();
}

function recordingArchiveDir(item: RecordingItem | null | undefined): string {
  return String(item?.archive_dir || currentArchiveDirSnapshot() || "").trim();
}

function recordingIdentityKey(name: string, archiveDir = ""): string {
  return `${String(archiveDir || "").trim()}\u0000${String(name || "").trim()}`;
}

function recordingItemKey(item: RecordingItem | null | undefined): string {
  if (!item) return "";
  return recordingIdentityKey(item.name, recordingArchiveDir(item));
}

function selectedRecordingKey(): string {
  return recordingIdentityKey(selectedRecordingName, selectedRecordingArchiveDir);
}

function isSelectedRecordingItem(item: RecordingItem): boolean {
  return recordingItemKey(item) === selectedRecordingKey();
}

function setSelectedRecording(item: RecordingItem | null | undefined): void {
  selectedRecordingName = item?.name || "";
  selectedRecordingArchiveDir = item ? recordingArchiveDir(item) : "";
}

function findRecordingItem(name: string, archiveDir = ""): RecordingItem | undefined {
  const safeName = String(name || "").trim();
  if (!safeName) return undefined;
  const safeArchiveDir = String(archiveDir || "").trim();
  if (safeArchiveDir) {
    const key = recordingIdentityKey(safeName, safeArchiveDir);
    const exact = recordingItems.find((item) => recordingItemKey(item) === key);
    if (exact) return exact;
  }
  return recordingItems.find((item) => item.name === safeName);
}

function recordingDomKey(item: RecordingItem): string {
  return encodeURIComponent(recordingItemKey(item));
}

async function ensureRecordingsArchiveReady(): Promise<string> {
  if (currentArchiveDirSnapshot()) {
    recordingsBootstrapReady = true;
    return currentArchiveDirSnapshot();
  }
  if (recordingsBootstrapPromise) {
    await recordingsBootstrapPromise;
    const resolved = currentArchiveDirSnapshot();
    if (resolved) {
      recordingsBootstrapReady = true;
      return resolved;
    }
  }
  await loadRecordings(false);
  const resolved = currentArchiveDirSnapshot();
  if (!resolved) {
    throw new Error("Recordings archive is not ready yet. Please try again.");
  }
  recordingsBootstrapReady = true;
  return resolved;
}

function renderRecordingsEmptyState(message: string, actionLabel: string, onClick: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "recordings-empty-state";
  const text = document.createElement("p");
  text.className = "hint";
  text.textContent = message;
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost recordings-empty-action";
  btn.type = "button";
  btn.textContent = actionLabel;
  btn.onclick = onClick;
  wrap.appendChild(text);
  wrap.appendChild(btn);
  return wrap;
}

function buildRecordingItemButton(it: RecordingItem): HTMLButtonElement {
  const itemKey = recordingItemKey(it);
  const isActive = itemKey === selectedRecordingKey();
  const btn = document.createElement("button");
  btn.className = "recording-item" + (isActive ? " active" : "");
  btn.type = "button";
  btn.dataset.recordingName = it.name;
  btn.dataset.recordingKey = recordingDomKey(it);
  btn.dataset.archiveDir = recordingArchiveDir(it);
  btn.setAttribute("aria-current", isActive ? "true" : "false");
  const title = document.createElement("span");
  title.className = "rec-title";
  const meta = document.createElement("span");
  meta.className = "rec-meta";
  const badges = document.createElement("div");
  badges.className = "rec-badges";
  // Always attach the badges container even when empty — its
  // ``min-height: 22px`` rule gives every recording-item the same
  // intrinsic content height, so old recordings (no provider,
  // no language, no audio) render at the same size as new ones
  // with full badge metadata. The "у старых записей огромного
  // размера разросшиеся" report was caused by the mix of
  // differently-tall items across new/old content.
  btn.appendChild(title);
  btn.appendChild(meta);
  btn.appendChild(badges);
  updateRecordingItemButton(btn, it);
  return btn;
}

function updateRecordingItemButton(btn: HTMLElement, it: RecordingItem): void {
  const itemKey = recordingItemKey(it);
  const isActive = itemKey === selectedRecordingKey();
  const nextClassName = "recording-item" + (isActive ? " active" : "");
  if (btn.className !== nextClassName) {
    btn.className = nextClassName;
  }
  btn.dataset.recordingName = it.name;
  btn.dataset.archiveDir = recordingArchiveDir(it);
  btn.setAttribute("aria-current", isActive ? "true" : "false");
  const title = btn.querySelector<HTMLElement>(".rec-title");
  const nextTitle = it.display_name;
  if (title && title.textContent !== nextTitle) {
    title.textContent = nextTitle;
  }
  const meta = btn.querySelector<HTMLElement>(".rec-meta");
  const nextMeta = `${fmtDateTime(it.modified_at)} · ${fmtBytes(it.size_bytes)}`;
  if (meta && meta.textContent !== nextMeta) {
    meta.textContent = nextMeta;
  }
  const badges = btn.querySelector<HTMLElement>(".rec-badges");
  if (badges) syncRecordingBadges(badges, it);
  btn.onclick = () => void openRecording(it.name, recordingArchiveDir(it));
}

function syncRecordingBadges(container: HTMLElement, it: RecordingItem): void {
  const wanted: Array<[string, string]> = [];
  // No ``!== "unknown"`` guard: the recordings payload writes "" for an
  // unknown provider (``_build_recordings_list_payload``), and the only
  // producer of the literal "unknown" is the stats payload, which never
  // reaches a badge.
  if (it.provider) {
    wanted.push(["rec-provider rec-provider-provider", providerLabel(it.provider)]);
  }
  if (it.language) {
    wanted.push(["rec-provider rec-provider-language", String(it.language).toUpperCase()]);
  }
  if (it.has_audio) {
    wanted.push(["rec-provider rec-provider-audio", "Audio"]);
  }
  const existing = Array.from(container.children) as HTMLElement[];
  let changed = existing.length !== wanted.length;
  if (!changed) {
    for (let i = 0; i < wanted.length; i++) {
      const [cls, text] = wanted[i];
      const node = existing[i];
      if (node.className !== cls || node.textContent !== text) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;
  container.replaceChildren(
    ...wanted.map(([cls, text]) => {
      const badge = document.createElement("span");
      badge.className = cls;
      badge.textContent = text;
      return badge;
    })
  );
}

/**
 * Rebuild the recordings list WITHOUT discarding unchanged DOM nodes.
 *
 * The list refreshes on every background reload (post-save, post-
 * transcribe, focus return), and each of those used to run
 * ``replaceChildren()`` + full rebuild — which resets the container's
 * scrollTop to 0. With several hundred recordings the user reading the
 * middle of the list was yanked back to the top by any unrelated
 * background refresh ("я пролистал пятьсот элементов, а меня откидывает
 * наверх"). Reconciling by ``data-recording-key`` keeps every untouched
 * row's DOM node — and therefore the scroll position, hover state and
 * focus — exactly where it was, while still reflecting adds/removes/
 * metadata updates. A full replacement remains for the empty-state
 * transitions where there is nothing to reconcile.
 *
 * The reconciliation algorithm itself is the unit-tested SSOT in
 * ``./recordings-list-reconciler``; this function supplies only the
 * domain pieces: key derivation (archive-scoped name) and row
 * construction/update callbacks.
 */
function renderRecordingsList(): void {
  const list = $("recordingsList");
  const filteredItems = getFilteredRecordings();
  syncRecordingsSearchControls();
  if (!recordingItems.length) {
    list.replaceChildren(
      renderRecordingsEmptyState("No recordings yet.", "Start Recording", () => {
        switchView("record");
      })
    );
    // "Showing 200 of 5900" is written at the END of this function, past
    // both early returns, so an archive that emptied — a deleted
    // directory, a search that matches nothing — kept the previous
    // count hanging over an empty list.
    renderRecordingsWindowStatus(0, 0);
    return;
  }
  if (!filteredItems.length) {
    list.replaceChildren(
      renderRecordingsEmptyState(UI_COPY.recordings.noSearchMatches, "Clear Search", () => {
        setRecordingsSearchQuery("");
        const input = $("recordingsSearchInput") as HTMLInputElement;
        input.value = "";
        renderRecordingsList();
        if (!selectedRecordingName && recordingItems.length) {
          const first = recordingItems[0];
          setSelectedRecording(first);
          void openRecording(first.name, recordingArchiveDir(first));
        }
      })
    );
    renderRecordingsWindowStatus(0, 0);
    return;
  }

  // Windowed render. The archive is unbounded — a heavy user reaches
  // several thousand recordings — and materialising every filtered item
  // meant ~35 000 DOM nodes for a list showing about twenty. The window
  // caps what is built; search, keyboard navigation and selection still
  // run over the complete ``filteredItems`` array, so nothing about what
  // the list MEANS changes. ``resolveWindowSize`` guarantees the
  // selected row is always inside the window, which is what keeps
  // moveRecordingSelection working: it looks the row up by key and
  // focuses it, and focus() is what scrolls it into view.
  const selectedIndex = filteredItems.findIndex((item) => isSelectedRecordingItem(item));
  recordingsWindowSize = resolveWindowSize({
    total: filteredItems.length,
    current: recordingsWindowSize,
    minimum: RECORDINGS_WINDOW_MINIMUM,
    selectedIndex,
  });
  const windowItems = filteredItems.slice(0, recordingsWindowSize);

  // Rows carry their identity on data-recording-key (set by
  // buildRecordingItemButton); the keyed reconciler reuses matching DOM
  // nodes, inserts new ones at the right position and drops the rest —
  // untouched rows keep scroll position, hover state and focus.
  reconcileRecordingsList(
    list,
    windowItems.map((it) => ({ key: recordingDomKey(it), item: it })),
    {
      create: ({ item }) => buildRecordingItemButton(item),
      update: (row, { item }) => updateRecordingItemButton(row, item),
    },
  );
  renderRecordingsWindowStatus(windowItems.length, filteredItems.length);
}

/**
 * Coverage line under the search box.
 *
 * A list that silently stops at row 200 reads as data loss. This says
 * how much is materialised out of how many match, and disappears once
 * the whole set is on screen. It lives in the toolbar rather than at the
 * end of the list because the keyed reconciler owns every child of
 * ``#recordingsList`` and removes anything without a row key.
 */
function renderRecordingsWindowStatus(rendered: number, total: number): void {
  const toolbar = document.querySelector<HTMLElement>(".recordings-list-toolbar");
  if (!toolbar) return;
  const text = windowStatusText(rendered, total);
  let node = toolbar.querySelector<HTMLElement>(".recordings-window-status");
  if (!text) {
    node?.remove();
    return;
  }
  if (!node) {
    node = document.createElement("div");
    node.className = "recordings-window-status hint";
    node.setAttribute("aria-live", "polite");
    toolbar.appendChild(node);
  }
  if (node.textContent !== text) node.textContent = text;
}

/**
 * Grow the window when the user scrolls toward the end.
 *
 * Attached once; a no-op while everything already fits. Growth is
 * monotonic within a filtered set, so scrolling back up never tears
 * down rows the user just passed.
 */
function handleRecordingsListScroll(): void {
  // Geometry first: it is three property reads and answers "is there
  // anything to do?" for all but a handful of the events this handler
  // receives. `{passive: true}` keeps the compositor free, not the main
  // thread, so what runs here still runs on every scroll tick.
  const list = $("recordingsList");
  if (!shouldGrowWindow({
    scrollTop: list.scrollTop,
    clientHeight: list.clientHeight,
    scrollHeight: list.scrollHeight,
  })) {
    return;
  }
  const total = getFilteredRecordings().length;
  if (recordingsWindowSize >= total) return;
  recordingsWindowSize = grownWindowSize(recordingsWindowSize, total);
  renderRecordingsList();
}

async function moveRecordingSelection(step: number): Promise<void> {
  const filteredItems = getFilteredRecordings();
  if (!filteredItems.length) return;
  const currentIndex = Math.max(0, filteredItems.findIndex((item) => isSelectedRecordingItem(item)));
  const nextIndex = Math.min(filteredItems.length - 1, Math.max(0, currentIndex + step));
  const next = filteredItems[nextIndex];
  if (!next) return;
  setSelectedRecording(next);
  renderRecordingsList();
  await openRecording(next.name, recordingArchiveDir(next));
  const target = $("recordingsList").querySelector<HTMLElement>(`[data-recording-key="${cssEscape(recordingDomKey(next))}"]`);
  target?.focus();
}

function normalizeLoadRecordingsOptions(input: boolean | LoadRecordingsOptions): LoadRecordingsOptions {
  if (typeof input === "boolean") {
    return { keepSelection: input };
  }
  return {
    keepSelection: !!input.keepSelection,
    background: !!input.background,
    reopenSelected: input.reopenSelected !== false,
  };
}

function syncSelectedRecordingViewerMetaFromList(): void {
  const selected = findRecordingItem(selectedRecordingName, selectedRecordingArchiveDir);
  if (!selected) return;
  $("recordingTitleLabel").textContent = selected.display_name || recordingTitleFromName(selected.name);
  $("recordingMeta").textContent = `${fmtDateTime(selected.modified_at)} · ${fmtBytes(selected.size_bytes || 0)}`;
}

async function loadRecordings(optionsOrKeepSelection: boolean | LoadRecordingsOptions): Promise<void> {
  const options = normalizeLoadRecordingsOptions(optionsOrKeepSelection);
  const requestSeq = ++recordingsLoadRequestSeq;
  const selectedKeyBeforeLoad = selectedRecordingKey();
  // Snapshot what is on screen BEFORE the payload replaces the items, so
  // the window decision below can ask whether this is the same list.
  const previousWindowKeys = getFilteredRecordings()
    .slice(0, recordingsWindowSize)
    .map(recordingItemKey);
  const previousResolvedDir = activeResolvedRecordingsDir;
  if (!options.background) {
    recordingsForegroundLoads += 1;
    setRecordingsUiLoading(true);
  }
  try {
    const r = await apiGet<{ items: RecordingItem[]; directory: string }>("/api/recordings");
    if (requestSeq !== recordingsLoadRequestSeq) return;
    recordingItems = r.items || [];
    invalidateFilteredRecordings();
    activeResolvedRecordingsDir = String(r.directory || "").trim();
    // A load that REPLACES the list invalidates the window; a load that
    // refreshes it does not. Resetting unconditionally meant the
    // background refresh after every save threw a user who had scrolled
    // through hundreds of rows back to the top — deleting exactly the
    // nodes the keyed reconciler had just preserved.
    if (shouldResetWindowAfterLoad({
      directoryChanged: previousResolvedDir !== "" && previousResolvedDir !== activeResolvedRecordingsDir,
      previousWindowKeys,
      nextKeys: recordingItems.map(recordingItemKey),
    })) {
      resetRecordingsWindow();
    }
    syncLatestSavedAudioFromRecordings();
    const filteredItems = getFilteredRecordings();
    if (!options.keepSelection || !filteredItems.some((x) => isSelectedRecordingItem(x))) {
      setSelectedRecording(filteredItems[0] || null);
    }
    const selectedKeyAfterLoad = selectedRecordingKey();
    renderRecordingsList();
    await refreshRecordingsStatsIfVisible();
    if (selectedRecordingName) {
      const selectedChanged = selectedKeyBeforeLoad !== selectedKeyAfterLoad;
      if (options.background && !options.reopenSelected && !selectedChanged) {
        syncSelectedRecordingViewerMetaFromList();
      } else {
        await openRecording(selectedRecordingName, selectedRecordingArchiveDir, {
          silent: options.background && !selectedChanged,
        });
      }
    } else {
      resetRecordingViewer(recordingsSearchQuery
        ? UI_COPY.recordings.noSearchMatches
        : UI_COPY.recordings.viewerPlaceholder);
    }
  } finally {
    if (!options.background) {
      recordingsForegroundLoads = Math.max(0, recordingsForegroundLoads - 1);
      setRecordingsUiLoading(recordingsForegroundLoads > 0);
    }
  }
}

/**
 * Say that the numbers could not be read, instead of showing zeroes.
 *
 * The counters keep whatever they last showed — a stale number the user
 * has already seen is honest as long as the panel says the refresh
 * failed; replacing them with zeroes is not.
 */
function showRecordingsStatsUnavailable(message: string): void {
  setRecordingsStatsError(message);
}

function setRecordingsStatsError(message: string): void {
  const panel = document.getElementById("recordingsStatsPanel");
  if (!panel) return;
  let node = panel.querySelector<HTMLElement>(".recordings-stats-error");
  if (!message) {
    node?.remove();
    return;
  }
  if (!node) {
    node = document.createElement("div");
    node.className = "recordings-stats-error hint";
    node.setAttribute("role", "status");
    panel.prepend(node);
  }
  if (node.textContent !== message) node.textContent = message;
}

async function loadRecordingsStats(): Promise<void> {
  const requestSeq = ++recordingsStatsRequestSeq;
  let s: RecordingsStats;
  try {
    s = await apiGet<RecordingsStats>("/api/recordings/stats/summary");
  } catch (e) {
    // Stats are decorative — a backend error must not abort the caller
    // (loadRecordings) or leave the panel in a permanent loading state.
    // But it must not read as an empty archive either: the panel used to
    // keep its markup zeroes, so a user looking at a list of recordings
    // was told "Recordings 0, Words 0".
    console.warn("loadRecordingsStats: stats fetch failed (non-fatal)", e);
    if (requestSeq === recordingsStatsRequestSeq) {
      showRecordingsStatsUnavailable(sanitizeUiErrorMessage(e, "Statistics are unavailable."));
    }
    return;
  }
  if (requestSeq !== recordingsStatsRequestSeq) return;
  setRecordingsStatsError("");
  $("statsTotal").textContent = String(s.total_recordings || 0);
  $("statsWords").textContent = String(s.total_words || 0);
  $("statsChars").textContent = String(s.total_chars || 0);
  $("statsWpr").textContent = String(s.avg_words_per_recording || 0);
  $("statsAvgDur").textContent = fmtDur(s.avg_duration_sec || 0);
  $("statsMinDur").textContent = fmtDur(s.min_duration_sec || 0);
  $("statsMaxDur").textContent = fmtDur(s.max_duration_sec || 0);
  const top = $("statsTopWords");
  top.innerHTML = "";
  if (!s.top_words?.length) {
    const empty = document.createElement("span");
    empty.className = "hint";
    empty.textContent = "No word stats yet.";
    top.appendChild(empty);
  } else {
    s.top_words.forEach((w) => {
      const chip = document.createElement("span");
      chip.className = "word-chip";
      chip.textContent = `${w.word} (${w.count})`;
      top.appendChild(chip);
    });
  }

  const providers = $("statsProviders");
  providers.innerHTML = "";
  const providerTotals = new Map<string, number>();
  (s.providers || []).forEach((p) => {
    const key = String(p.name || "").trim().toLowerCase();
    // Archive entries older than the removal of the fal.ai provider name
    // it under three spellings. The filter belongs to the one function
    // that decides which providers this build knows about, not inline in
    // a chart renderer.
    if (!isKnownProviderName(key)) return;
    providerTotals.set(key, (providerTotals.get(key) || 0) + Number(p.count || 0));
  });
  PROVIDER_DISPLAY_ORDER.forEach((key) => {
    if (!providerTotals.has(key)) providerTotals.set(key, 0);
  });
  const providerItems = Array.from(providerTotals.entries())
    .sort((a, b) => {
      const ia = PROVIDER_DISPLAY_ORDER.indexOf(a[0]);
      const ib = PROVIDER_DISPLAY_ORDER.indexOf(b[0]);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return b[1] - a[1];
    })
    .slice(0, UI_TOKENS.recordings.statsTopProviders)
    .map(([name, count]) => ({ name, count }));
  providerItems.forEach((p) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    // The list badges say "Deepgram" through providerLabel; the stats
    // chips said "deepgram". Both are on screen at once.
    chip.textContent = `${providerLabel(p.name)} (${p.count})`;
    providers.appendChild(chip);
  });

  const languages = $("statsLanguages");
  languages.innerHTML = "";
  const languageTotals = new Map<string, number>();
  (s.languages || []).forEach((l) => {
    const key = String(l.name || "").trim().toLowerCase();
    if (!key) return;
    languageTotals.set(key, (languageTotals.get(key) || 0) + Number(l.count || 0));
  });
  if (!languageTotals.has("auto")) languageTotals.set("auto", 0);
  const languageItems = Array.from(languageTotals.entries())
    .sort((a, b) => {
      if (a[0] === "auto") return -1;
      if (b[0] === "auto") return 1;
      return b[1] - a[1];
    })
    .slice(0, UI_TOKENS.recordings.statsTopLanguages)
    .map(([name, count]) => ({ name, count }));
  languageItems.forEach((l) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.textContent = `${l.name} (${l.count})`;
    languages.appendChild(chip);
  });
}

async function openRecording(name: string, archiveDir = "", options: OpenRecordingOptions = {}): Promise<void> {
  const matchedItem = findRecordingItem(name, archiveDir);
  const effectiveArchiveDir = matchedItem
    ? recordingArchiveDir(matchedItem)
    : String(archiveDir || selectedRecordingArchiveDir || currentArchiveDirSnapshot()).trim();
  const previousSelectedKey = selectedRecordingKey();
  selectedRecordingName = name;
  selectedRecordingArchiveDir = effectiveArchiveDir;
  const requestKey = selectedRecordingKey();
  if (!options.silent || previousSelectedKey !== requestKey) {
    renderRecordingsList();
  }
  const requestSeq = ++recordingOpenRequestSeq;
  const pendingDisplayName = matchedItem?.display_name || recordingTitleFromName(name);
  if (!options.silent) {
    setRecordingViewerLoading(pendingDisplayName, !!matchedItem?.has_audio);
  }
  try {
    const params = new URLSearchParams();
    if (effectiveArchiveDir) params.set("archive_dir", effectiveArchiveDir);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    // ``display_text`` is written by ``_read_recording_payload`` on every
    // response (``display or raw``) — it was read through a cast that
    // bypassed this very declaration, so the type said the field did not
    // exist while the code depended on it. ``content`` is the raw file
    // including the Title/Saved-at header; only the export path wants it.
    const r = await apiGet<{
      name: string;
      archive_dir?: string;
      modified_at: string;
      size_bytes: number;
      content: string;
      display_text: string;
      source_file?: string;
      has_audio?: boolean;
      audio_name?: string;
      audio_size_bytes?: number;
    }>(
      "/api/recordings/" + encodeURIComponent(name) + suffix
    );
    if (requestSeq !== recordingOpenRequestSeq || selectedRecordingKey() !== requestKey) return;
    const displayName = matchedItem?.display_name || recordingTitleFromName(name);
    $("recordingTitleLabel").textContent = displayName;
    $("recordingMeta").textContent = `${fmtDateTime(r.modified_at)} · ${fmtBytes(r.size_bytes || 0)}`;
    $("recordingContent").setAttribute("aria-busy", "false");
    $("recordingContent").setAttribute("data-placeholder", UI_COPY.resultPlaceholder);
    $("recordingContent").textContent = r.display_text || r.content || "";
    const player = $("recordingAudio") as HTMLAudioElement;
    if (r.has_audio) {
      const keepExistingAudio = options.silent && previousSelectedKey === requestKey && !!player.getAttribute("src");
      if (keepExistingAudio) {
        setRecordingViewerAudioRowVisible(true);
      } else {
        try {
          const audioFile = await fetchSavedAudioFromBackend(name, String(r.archive_dir || effectiveArchiveDir).trim());
          if (requestSeq !== recordingOpenRequestSeq || selectedRecordingKey() !== requestKey) return;
          player.pause();
          revokeRecordingViewerAudioUrl();
          recordingViewerAudioObjectUrl = URL.createObjectURL(audioFile);
          player.src = recordingViewerAudioObjectUrl;
          setRecordingViewerAudioRowVisible(true, true);
          player.load();
          await waitForRecordingViewerAudioReady(player);
          if (requestSeq !== recordingOpenRequestSeq || selectedRecordingKey() !== requestKey) return;
          setRecordingViewerAudioRowVisible(true);
        } catch (audioErr) {
          if (requestSeq !== recordingOpenRequestSeq || selectedRecordingKey() !== requestKey) return;
          console.warn("Recording audio playback fetch failed", audioErr);
          player.pause();
          revokeRecordingViewerAudioUrl();
          player.removeAttribute("src");
          player.load();
          setRecordingViewerAudioRowVisible(false);
        }
      }
    } else {
      player.pause();
      revokeRecordingViewerAudioUrl();
      player.removeAttribute("src");
      player.load();
      setRecordingViewerAudioRowVisible(false);
    }
    // Reveal-in-folder button — surfaced when running inside Electron
    // (``__transcriptorRevealRecording`` injected by main.tsx and
    // dispatched by main.js via the page-title-updated channel).
    // Hidden in plain-browser dev preview where the helper is undefined.
    const revealBtn = document.getElementById("recordingRevealBtn") as HTMLButtonElement | null;
    if (revealBtn) {
      const hasReveal = hostCanRevealFiles();
      revealBtn.hidden = !hasReveal;
      revealBtn.onclick = () => {
        const fn = window.__transcriptorRevealRecording;
        if (fn) fn(name, String(r.archive_dir || effectiveArchiveDir).trim());
      };
    }
    updateRecordingCopyState();
  } catch (e) {
    if (requestSeq !== recordingOpenRequestSeq || selectedRecordingKey() !== requestKey) return;
    const message = sanitizeUiErrorMessage(e, "Could not open this recording.");
    $("recordingTitleLabel").textContent = pendingDisplayName;
    $("recordingMeta").textContent = "Load failed";
    $("recordingContent").setAttribute("aria-busy", "false");
    // The message goes in the placeholder, NOT the body. The body is
    // what "Copy recording text" copies and what updateRecordingCopyState
    // measures to decide whether that button is even enabled — writing
    // the failure there put "Could not open this recording…" on the
    // user's clipboard as if it were their transcript.
    $("recordingContent").setAttribute("data-placeholder", message);
    $("recordingContent").textContent = "";
    const player = $("recordingAudio") as HTMLAudioElement;
    player.pause();
    revokeRecordingViewerAudioUrl();
    player.removeAttribute("src");
    player.load();
    setRecordingViewerAudioRowVisible(false);
    const revealBtn = document.getElementById("recordingRevealBtn") as HTMLButtonElement | null;
    if (revealBtn) revealBtn.hidden = true;
    updateRecordingCopyState();
  }
}

async function saveRecordingText(opts: {
  name?: string;
  archiveDir?: string;
  requireExisting?: boolean;
  title: string;
  sourceText: string;
  transcriptText: string;
  provider: string;
  model: string;
  language: string;
  recordingCollection?: RecordingCollection;
  audioFile?: File | null;
  audioSourcePath?: string;
  consumeAudioSourcePath?: boolean;
  /** When set, the backend atomically discards the live-recovery spool
   *  for this session ID immediately after the audio is persisted —
   *  closing the race window between a successful save and the
   *  separate discardLiveRecovery() call in the frontend. */
  liveSessionId?: string;
  refreshList?: boolean;
}): Promise<SavedRecordingRef> {
  const hasArchiveDirOption = Object.prototype.hasOwnProperty.call(opts, "archiveDir");
  if (!hasArchiveDirOption && !recordingsBootstrapReady) {
    await ensureRecordingsArchiveReady();
  }
  const sourceText = (opts.sourceText || "").trim();
  const transcriptText = (opts.transcriptText || "").trim();
  const audioFile = opts.audioFile || null;
  const audioSourcePath = normalizeUploadSourcePath(opts.audioSourcePath || "");
  const existingName = (opts.name || "").trim();
  const archiveDir = (hasArchiveDirOption ? String(opts.archiveDir || "") : currentArchiveDirSnapshot()).trim();
  const recordingCollection = String(opts.recordingCollection || "").trim();
  const requireExisting = !!opts.requireExisting;
  if (!sourceText && !transcriptText && !audioFile && !audioSourcePath) {
    return { name: existingName, archiveDir };
  }
  let savedName = existingName;
  let savedArchiveDir = archiveDir;
  // Audio-retention observability (BUG-02): the backend deletes older
  // recordings' audio on every save (policy: newest keeps audio,
  // transcripts are forever). The count comes back in every save
  // response; surface it so the deletion is never silent.
  let prunedAudioCount = 0;
  if (audioFile) {
    const fd = new FormData();
    fd.append("file", audioFile, audioFile.name || "recording.wav");
    if (existingName) fd.set("name", existingName);
    if (archiveDir) fd.set("archive_dir", archiveDir);
    if (recordingCollection) fd.set("recording_collection", recordingCollection);
    if (requireExisting) fd.set("require_existing", "true");
    fd.set("title", opts.title);
    fd.set("source_text", sourceText);
    fd.set("transcript_text", transcriptText);
    fd.set("provider", opts.provider);
    fd.set("model", opts.model);
    fd.set("language", opts.language);
    if (opts.liveSessionId) fd.set("live_session_id", opts.liveSessionId);
    const r = await fetch("/api/recordings/save-with-audio", { method: "POST", body: fd, headers: authHeaders() });
    if (!r.ok) throw new Error(await parseError(r));
    const js = (await r.json()) as { name?: string; archive_dir?: string; pruned_audio_count?: number };
    savedName = String(js.name || existingName || "").trim();
    savedArchiveDir = String(js.archive_dir || archiveDir || "").trim();
    prunedAudioCount = Math.max(0, Math.trunc(Number(js.pruned_audio_count) || 0));
  } else if (audioSourcePath) {
    const payload: Record<string, unknown> = {
      source_path: audioSourcePath,
      name: existingName,
      recording_collection: recordingCollection,
      require_existing: requireExisting,
      title: opts.title,
      source_text: sourceText,
      transcript_text: transcriptText,
      provider: opts.provider,
      model: opts.model,
      language: opts.language,
      consume_source_path: !!opts.consumeAudioSourcePath,
    };
    if (archiveDir) payload.archive_dir = archiveDir;
    const js = await apiPost<{ ok: boolean; name: string; archive_dir?: string; pruned_audio_count?: number }>("/api/recordings/save-from-path", {
      ...payload,
    });
    savedName = String(js.name || existingName || "").trim();
    savedArchiveDir = String(js.archive_dir || archiveDir || "").trim();
    prunedAudioCount = Math.max(0, Math.trunc(Number(js.pruned_audio_count) || 0));
  } else {
    const payload: Record<string, unknown> = {
      name: existingName,
      recording_collection: recordingCollection,
      require_existing: requireExisting,
      title: opts.title,
      source_text: sourceText,
      transcript_text: transcriptText,
      provider: opts.provider,
      model: opts.model,
      language: opts.language,
    };
    if (archiveDir) payload.archive_dir = archiveDir;
    const js = await apiPost<{ ok: boolean; name: string; archive_dir?: string; pruned_audio_count?: number }>("/api/recordings/save", {
      ...payload,
    });
    savedName = String(js.name || existingName || "").trim();
    savedArchiveDir = String(js.archive_dir || archiveDir || "").trim();
    prunedAudioCount = Math.max(0, Math.trunc(Number(js.pruned_audio_count) || 0));
  }
  // Fire-and-forget, coalesced through a background queue. Live saves
  // happen while the single recording capsule is still busy; direct
  // loadRecordings() here made History redraw during finalization and
  // visibly flicker the latest recording timestamp. The queue flushes
  // after busy release, or shortly after non-live saves such as Upload.
  if (opts.refreshList !== false) {
    requestDeferredRecordingsRefresh({
      name: savedName,
      archiveDir: savedArchiveDir,
    }, "save");
  }
  // BUG-02: audio retention deletes older recordings' audio on every
  // save (policy: newest keeps audio, transcripts are forever). The
  // deletion must never be silent — the user otherwise discovers it
  // only when trying to re-listen to a previous take.
  if (prunedAudioCount > 0) {
    setStatus(
      `Saved. Audio removed from ${prunedAudioCount} older recording${prunedAudioCount === 1 ? "" : "s"} (storage policy keeps audio for the latest recording only).`,
      "info",
    );
  }
  return {
    name: savedName,
    archiveDir: savedArchiveDir,
  };
}

$("recordingsRefreshBtn").addEventListener("click", () =>
  void loadRecordings(true).catch((e: Error) => {
    $("recordingContent").textContent = sanitizeUiErrorMessage(e, "Could not refresh the archive.");
    updateRecordingCopyState();
  })
);
// Window growth. Passive: the handler only reads geometry and never
// calls preventDefault, so it must not block the compositor's scroll.
$("recordingsList").addEventListener("scroll", handleRecordingsListScroll, { passive: true });
$("recordingsSearchInput").addEventListener("input", (ev) => {
  setRecordingsSearchQuery(String((ev.target as HTMLInputElement).value || ""));
  const filteredItems = getFilteredRecordings();
  if (selectedRecordingName && !filteredItems.some((item) => isSelectedRecordingItem(item))) {
    setSelectedRecording(filteredItems[0] || null);
    renderRecordingsList();
    if (selectedRecordingName) {
      void openRecording(selectedRecordingName, selectedRecordingArchiveDir);
    } else {
      resetRecordingViewer(UI_COPY.recordings.noSearchMatches);
    }
    return;
  }
  renderRecordingsList();
});
$("recordingsSearchClearBtn").addEventListener("click", () => {
  if (!recordingsSearchQuery) return;
  setRecordingsSearchQuery("");
  const input = $("recordingsSearchInput") as HTMLInputElement;
  input.value = "";
  renderRecordingsList();
  if (!selectedRecordingName && recordingItems.length) {
    const first = recordingItems[0];
    setSelectedRecording(first);
    void openRecording(first.name, recordingArchiveDir(first));
  }
});
($("recordingsList") as HTMLDivElement).addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    void moveRecordingSelection(1);
    return;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    void moveRecordingSelection(-1);
    return;
  }
  if (ev.key === "Home") {
    ev.preventDefault();
    const first = getFilteredRecordings()[0];
    if (!first) return;
    setSelectedRecording(first);
    renderRecordingsList();
    void openRecording(first.name, recordingArchiveDir(first)).then(() => {
      const target = $("recordingsList").querySelector<HTMLElement>(`[data-recording-key="${cssEscape(recordingDomKey(first))}"]`);
      target?.focus();
    });
    return;
  }
  if (ev.key === "End") {
    ev.preventDefault();
    const filtered = getFilteredRecordings();
    const last = filtered[filtered.length - 1];
    if (!last) return;
    setSelectedRecording(last);
    renderRecordingsList();
    void openRecording(last.name, recordingArchiveDir(last)).then(() => {
      const target = $("recordingsList").querySelector<HTMLElement>(`[data-recording-key="${cssEscape(recordingDomKey(last))}"]`);
      target?.focus();
    });
  }
});
($("recordingsSearchInput") as HTMLInputElement).addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (!recordingsSearchQuery) return;
    setRecordingsSearchQuery("");
    const input = ev.currentTarget as HTMLInputElement;
    input.value = "";
    renderRecordingsList();
    if (!selectedRecordingName && recordingItems.length) {
      const first = recordingItems[0];
      setSelectedRecording(first);
      void openRecording(first.name, recordingArchiveDir(first));
    }
    return;
  }
  if (ev.key === "Enter") {
    const first = getFilteredRecordings()[0];
    if (!first) return;
    setSelectedRecording(first);
    void openRecording(first.name, recordingArchiveDir(first));
  }
});
$("recordingsStatsBtn").addEventListener("click", () => {
  recordingsStatsOpen = !recordingsStatsOpen;
  // Closing the panel abandons whatever read is in flight: its response
  // must not paint into a panel the user has dismissed.
  if (!recordingsStatsOpen) recordingsStatsRequestSeq += 1;
  syncRecordingsStatsVisibility();
  void refreshRecordingsStatsIfVisible();
});
$("recordingCopyBtn").addEventListener("click", () => void copyRecordingText());
$("resultCopyBtn").addEventListener("click", () => void copyTextContent($("finalOutput").textContent || "", "resultCopyBtn"));
$("upscaleCopyBtn").addEventListener("click", () => void copyTextContent($("upscaleOutput").textContent || "", "upscaleCopyBtn"));

// Re-transcribe button: re-runs transcription on the saved audio file.
// Prefers Deepgram REST when a key is configured (best quality for
// recordings that had a bad streaming connection). Falls back to local
// Whisper automatically — no key needed, always available.
$("retranscribeBtn").addEventListener("click", async () => {
  const btn = $("retranscribeBtn") as HTMLButtonElement;
  if (btn.disabled) return;
  const audioState = latestSavedAudioState;
  if (!audioState?.savedName) {
    $("finalOutput").textContent = "No saved audio to re-transcribe.";
    return;
  }
  // What re-transcribe needs from a guard is one thing: "has a live
  // session begun since I started?" — plain equality against the token
  // as it was at the start. That works in every state now that
  // ``activeUiSessionToken`` is never empty (see its declaration); the
  // phantom token this function used to mint, install and release is
  // gone with the state it was invented for.
  const capturedToken = activeUiSessionToken;
  const stillOwnsResultPane = (): boolean => activeUiSessionToken === capturedToken;
  btn.disabled = true;
  btn.classList.add("is-busy");
  // Visible-progress writer. The user reported the re-transcribe job
  // is invisible — the button's ``is-busy`` class is far from the eye
  // and finalOutput shows the OLD transcript (or whatever was there
  // before) until success or failure. Mirroring every state transition
  // into finalOutput is the simplest way to make the running job
  // unambiguous, AND it doubles as the "what stage are we in" hint
  // when the eventual error message is shown (the last status the
  // user saw is now the most recent provider that was tried).
  //
  // Every write through this helper goes through the same
  // ``isCurrentUiSession`` gate that ``$("finalOutput").textContent``
  // assignments below already use, so a fresh live session that
  // started DURING re-transcribe never gets stomped by a stale status.
  const setRetranscribeStatus = (text: string): void => {
    if (stillOwnsResultPane()) {
      $("finalOutput").textContent = text;
    }
  };
  // Track which providers were actually attempted so the final error
  // message tells the user precisely what was tried — "switch to local
  // in Settings" was misleading when the code had already fallen
  // through to local under the hood and local ALSO failed. The hint
  // surface is rebuilt below from this list, not hardcoded.
  const triedProviders: string[] = [];
  // Lifted out of the inner ``try`` so the outer ``catch`` can include
  // the FIRST upstream error (typically the Deepgram failure) in the
  // user-visible error message. Previously the Deepgram error was
  // captured only inside the inner try, so by the time we reached the
  // outer catch the variable was out of scope and only the LAST
  // (local Whisper) error was displayed.
  let lastProviderError: unknown = null;
  try {
    setRetranscribeStatus("Preparing audio…");
    // ALWAYS fetch from the backend — never trust the in-memory blob.
    //
    // The previous "prefer in-memory ``audioState.file`` over backend
    // GET" optimization saved one loopback round-trip but had two
    // catastrophic failure modes that hit the user simultaneously:
    //
    //  1. ``audioState.file`` is the lazy OPFS-backed ``Blob([header,
    //     spool])`` from ``OpfsPcmSink.finalize()``. After
    //     ``deferredSinkDestroy.destroy()`` runs (right after the
    //     initial save completes, in stopLive's tail), the spool is
    //     gone and the Blob reads as zero bytes. The same lifecycle
    //     bug already broke playback on Windows and was fixed in
    //     ``renderLatestSavedAudio`` (line 601-605) by routing through
    //     the backend URL — Re-transcribe was missed.
    //  2. The construction also FORCED ``.wav`` extension and
    //     ``audio/wav`` MIME on a payload that is usually WebM-Opus
    //     for live recordings (see selectCanonicalCapturedAudio at
    //     line 1841: ``live-<ts>.webm``). That lie breaks Deepgram
    //     REST (Content-Type-driven container detection) and breaks
    //     local Whisper (ensure_wav_16k's ``.wav``-fast-path probes
    //     soundfile.info → fails → falls through to ffmpeg which
    //     sometimes succeeds via content-sniffing, sometimes raises
    //     a generic non-AudioError exception that the backend's
    //     ``except AudioError`` handler at main.py:2823 lets escape
    //     as HTTP 500). User-visible: BOTH providers fail on the
    //     same valid 1.3 MB / 41-second recording.
    //
    // ``fetchSavedAudioFromBackend`` derives BOTH the filename and
    // the MIME from the backend's response headers — the on-disk
    // file is the canonical source.
    const audioFile = await fetchSavedAudioFromBackend(audioState.savedName, audioState.archiveDir || "");
    const lang = (($("language") as HTMLSelectElement).value || "auto").trim();
    let text = "";
    let usedProvider: Provider = "local";

    // 1. Try Deepgram REST — higher accuracy than local Whisper for most
    //    languages. Only attempted when the user has a key configured.
    if (isProviderKeyConfigured("deepgram")) {
      const dgModel = getRemoteModelValue("deepgram") || DEFAULT_DEEPGRAM_AUDIO_MODEL;
      triedProviders.push(`Deepgram ${dgModel}`);
      setRetranscribeStatus(`Re-transcribing via Deepgram (${dgModel})…`);
      try {
        const result = await remoteJobSync(audioFile, {
          provider: "deepgram",
          language: lang,
          diarize: readDiarizeEnabled(),
          remoteModel: dgModel,
        });
        text = String(result.text || "").trim();
        usedProvider = "deepgram";
      } catch (deepgramErr) {
        // Network timeout, rate-limit, bad key — log and fall through to
        // local Whisper so the user still gets a usable transcript.
        lastProviderError = deepgramErr;
        console.warn("Re-transcribe: Deepgram REST failed, trying local Whisper:", deepgramErr);
      }
    }

    // 2. Local Whisper fallback — always available, no API key required.
    if (!text) {
      const model = selectedLocalModel();
      triedProviders.push(`local Whisper ${model}`);
      // Two-line message captures both the fallback context AND the
      // current step: the user sees Deepgram-failed reason without
      // losing the "we are still working" signal.
      const fallbackHint = lastProviderError
        ? `Deepgram failed — trying local Whisper (${model})…`
        : `Re-transcribing via local Whisper (${model})…`;
      setRetranscribeStatus(fallbackHint);
      const localResult = await transcribeCanonicalAudioLocally(audioFile, lang, model);
      text = localResult.text.trim();
      usedProvider = "local";
    }

    if (text) {
      // Session-gated writes: if the user started a new live recording
      // while we were transcribing, the new session owns `finalOutput`
      // and we must NOT overwrite it.
      if (stillOwnsResultPane()) {
        $("finalOutput").textContent = text;
      }
      // Persist the new transcript over the previous save so the
      // Recordings view reflects the improved result. This is safe to
      // do regardless of session state — it's archive-side state, not
      // live UI state.
      let archiveSaveFailureMessage = "";
      try {
        await saveRecordingText({
          name: audioState.savedName,
          archiveDir: audioState.archiveDir || "",
          requireExisting: true,
          title: smartRecordingTitle(text, audioState.savedName || "Recording"),
          sourceText: text,
          transcriptText: text,
          provider: usedProvider,
          model: usedProvider === "deepgram"
            ? getRemoteModelValue("deepgram")
            : selectedLocalModel(),
          language: lang,
        });
      } catch (saveErr) {
        console.warn("Re-transcribe: transcript archive save failed:", saveErr);
        archiveSaveFailureMessage = sanitizeUiErrorMessage(saveErr, "History save failed.");
      }
      // AI Upscale: if the user has upscale enabled, the re-transcript
      // should get the same rewrite treatment as a fresh live session.
      // Without this, re-transcribe produces a raw transcript that
      // visibly differs from what live recording produces for the same
      // audio — surprising inconsistency. `runUpscaleIfEnabled` is a
      // no-op when the toggle is off, and already session-guards its
      // own DOM writes via the placeholderNonce pattern. Keep final
      // status ownership here so a save warning is not overwritten by
      // the upscale helper's generic "Done" status.
      try {
        await runUpscaleIfEnabled(text, capturedToken, { setDoneStatus: false });
      } catch (upscaleErr) {
        // runUpscaleIfEnabled handles its own UI error states;
        // swallow here so retranscribe's overall success status is
        // preserved for the user.
        console.warn("Re-transcribe: upscale step failed:", upscaleErr);
      }
      if (stillOwnsResultPane()) {
        if (archiveSaveFailureMessage) {
          patchCurrentRecordingSummary({
            status: `Re-transcribed, but History save failed: ${archiveSaveFailureMessage}`,
            tone: "warning",
          }, capturedToken);
        } else {
          patchCurrentRecordingSummary({
            status: usedProvider === "deepgram"
              ? "Re-transcribed via Deepgram REST."
              : "Re-transcribed via local Whisper.",
            tone: "success",
          }, capturedToken);
        }
      }
    } else {
      if (stillOwnsResultPane()) {
        const tried = triedProviders.length ? ` (tried: ${triedProviders.join(", ")})` : "";
        $("finalOutput").textContent = `Re-transcribe returned empty result${tried}.`;
      }
    }
  } catch (e) {
    if (stillOwnsResultPane()) {
      // Build a precise error message that names what was tried.
      // The default ``explainNetworkError`` hint suggested "switch
      // Provider to local in Settings" — misleading here because the
      // code ALREADY fell through to local under the hood (and local
      // is what just failed). Append the tried-providers tail so the
      // user understands the local fallback ran and also failed; the
      // suggestion to "switch to local" is suppressed when local is
      // in the tried list.
      const msg = explainNetworkError(e, "Re-transcribe failed", {
        // Local already ran, under the hood, and failed: telling the
        // user to switch to it is actively unhelpful.
        suggestLocalFallback: !triedProviders.some((p) => p.startsWith("local")),
      });
      const triedSuffix = triedProviders.length ? ` Tried: ${triedProviders.join(", ")}.` : "";
      // Surface the FIRST upstream error (typically the Deepgram
      // failure) when both providers were attempted. Previously the
      // Deepgram error was logged only via console.warn — invisible
      // to a packaged-build user — and the toast showed only the
      // local Whisper failure. With both errors visible, the user can
      // distinguish "Deepgram returned 401 → expected, local picked
      // it up but failed for unrelated reason" from "both failed for
      // the SAME reason (e.g., upload bytes corrupt)".
      let firstProviderTail = "";
      if (lastProviderError && triedProviders.length > 1) {
        const firstMsg = lastProviderError instanceof Error
          ? lastProviderError.message
          : String(lastProviderError || "");
        const firstShort = firstMsg.split("\n")[0].slice(0, 200).trim();
        if (firstShort) {
          firstProviderTail = ` First: ${firstShort}.`;
        }
      }
      $("finalOutput").textContent = `${msg}${triedSuffix}${firstProviderTail}`;
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-busy");
  }
});

// ── Delete All recordings ──
$("recordingsDeleteAllBtn").addEventListener("click", () => {
  openModal("deleteAllModal", "#deleteAllConfirmBtn");
});
$("deleteAllCancelBtn").addEventListener("click", () => {
  closeModal("deleteAllModal");
});
($("deleteAllModal") as HTMLDivElement).addEventListener("click", (e) => {
  if (e.target === $("deleteAllModal")) closeModal("deleteAllModal");
});
$("deleteAllConfirmBtn").addEventListener("click", async () => {
  try {
    // Use Authorization header instead of ?token= query param: query
    // params are logged by uvicorn's access log at INFO level, which
    // leaks the API token into plaintext logs on every delete.
    const r = await fetch("/api/recordings", { method: "DELETE", headers: authHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { deleted?: unknown; failed?: unknown };
    setLatestSavedAudio(null);
    if (currentRecordingSummary?.savedName) {
      patchCurrentRecordingSummary({
        savedName: "",
        status: "Recording archive was cleared. Session summary is kept, but saved files were deleted.",
        tone: "warning",
      });
    }
    // Coerce to non-negative integer so a backend shape drift (`null`,
    // missing key, truncated JSON, middleware-injected body) renders
    // "Deleted 0 recording(s)" instead of "Deleted undefined...". Also
    // surface partial failures — the backend may skip files it cannot
    // unlink (permission-denied, file in use on Windows) and previously
    // the user was told "success" while N files silently survived.
    const deletedCount = Math.max(0, Number.isFinite(Number(data?.deleted)) ? Number(data.deleted) : 0);
    const failedCount = Math.max(0, Number.isFinite(Number(data?.failed)) ? Number(data.failed) : 0);
    const tone = failedCount > 0 ? "error" : "warning";
    const summary = failedCount > 0
      ? `Deleted ${deletedCount} recording(s) — ${failedCount} failed (see main.log).`
      : `Deleted ${deletedCount} recording(s).`;
    // Reported through the status pill, which is visible from every
    // view. ``showRecordSessionNotice`` writes into ``#recordSessionNotice``,
    // which lives inside the Record view — hidden at the moment this
    // button can be pressed — and the viewer body it also wrote to was
    // wiped one line later by ``loadRecordings`` → ``resetRecordingViewer``.
    // So a partial failure the backend does count was reported to nobody.
    setStatus(summary, tone === "error" ? "error" : "done");
    showRecordSessionNotice(summary, tone);
    $("recordingMeta").textContent = "";
    await loadRecordings(true);
    // After the reload, so it survives ``resetRecordingViewer``.
    resetRecordingViewer(summary);
  } catch (e: unknown) {
    const msg = sanitizeUiErrorMessage(e, "Could not delete the archive.");
    setStatus(`Delete all failed: ${msg}`, "error");
    $("recordingContent").textContent = msg;
  } finally {
    closeModal("deleteAllModal");
  }
});
document.addEventListener("keydown", (ev) => {
  if (!activeModalId) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeModal(activeModalId);
    return;
  }
  if (ev.key !== "Tab") return;
  const modal = $(activeModalId);
  const focusables = modalFocusableElements(modal);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (ev.shiftKey && active === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
});

// ── Transcribe settings gear popup ──
//
// Three things were missing and one was dead. The outside-click handler
// tested ``e.target !== transcribeSettingsBtn``, which can never be
// false: the button's own handler stops the event before it reaches
// the document. The button never announced whether the popup was open,
// Escape did not close it, and leaving the view did not either — so the
// popup stayed up over History.
const transcribeSettingsBtn = $("transcribeSettingsBtn") as HTMLButtonElement;
const transcribeSettingsPopup = $("transcribeSettingsPopup") as HTMLElement;

function setTranscribeSettingsOpen(open: boolean): void {
  transcribeSettingsPopup.hidden = !open;
  transcribeSettingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
}
setTranscribeSettingsOpen(false);
transcribeSettingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setTranscribeSettingsOpen(!!transcribeSettingsPopup.hidden);
});
document.addEventListener("click", (e) => {
  if (!transcribeSettingsPopup.hidden && !transcribeSettingsPopup.contains(e.target as Node)) {
    setTranscribeSettingsOpen(false);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || transcribeSettingsPopup.hidden) return;
  setTranscribeSettingsOpen(false);
  transcribeSettingsBtn.focus();
});

syncRecordingsStatsVisibility();

const autoToggle = $("autoTranscribeToggle") as HTMLInputElement;
autoToggle.addEventListener("change", () => {
  queueUiPreferencesSave();
});
// The third toggle of the same popover. Its two neighbours have had a
// listener, a `collectUiPreferences` field and an accessor since they
// were written; this one had none of the three, so speaker diarization
// was the only setting in the app that reset itself on every launch.
document.getElementById("diarizeCheck")?.addEventListener("change", () => {
  queueUiPreferencesSave();
});
const livePreviewToggle = $("livePreviewToggle") as HTMLInputElement;
livePreviewToggle.addEventListener("change", () => {
  if (!livePreviewToggle.checked) {
    liveInterimText = "";
  }
  syncLiveOutputFromState();
  queueUiPreferencesSave();
});

function shouldAutoTranscribe(): boolean {
  return autoToggle.checked;
}

function shouldLivePreview(): boolean {
  return livePreviewToggle.checked;
}

($("providerSelect") as HTMLSelectElement).addEventListener("change", () => {
  setTranscriptionSelection(
    ($("providerSelect") as HTMLSelectElement).value as TranscriptionGroupId | "",
  );
});
($("remoteModelSelect") as HTMLSelectElement).addEventListener("change", () => {
  const v = (($("remoteModelSelect") as HTMLSelectElement).value || "").trim();
  setTranscriptionSelection(readProviderGroup(), v || undefined);
});

/**
 * Fill the dual-stream secondary-language select from ``#language``.
 *
 * The language list is written out once, in index.html, on ``#language``.
 * Copying it into a second markup block — or into a constant here —
 * would be a second source that drifts the first time a language is
 * added. "Auto" is the one option that cannot appear: the secondary
 * stream exists precisely to be monolingual, and an Auto secondary would
 * be the multi stream twice.
 */
/**
 * Copy ``#language``'s options onto ``#uploadLanguage``.
 *
 * The comment on the live language wiring states the rule outright —
 * "the language list is written out once, in index.html, on #language;
 * copying it into a second markup block would be a second source that
 * drifts" — and the Upload tab was that second markup block. Same
 * mechanism as ``fillDualSecondaryLanguageOptions`` below, which already
 * derives its list this way.
 */
function fillUploadLanguageOptions(): void {
  const target = document.getElementById("uploadLanguage") as HTMLSelectElement | null;
  if (!target || target.options.length) return;
  const source = document.getElementById("language") as HTMLSelectElement | null;
  if (!source) return;
  for (const option of Array.from(source.options)) {
    const copy = document.createElement("option");
    copy.value = option.value;
    copy.textContent = option.textContent || option.value;
    target.appendChild(copy);
  }
}

function fillDualSecondaryLanguageOptions(): void {
  const target = dualSecondaryLanguageSelect();
  if (!target || target.options.length) return;
  const source = document.getElementById("language") as HTMLSelectElement | null;
  if (!source) return;
  for (const option of Array.from(source.options)) {
    const value = (option.value || "").trim().toLowerCase();
    if (!value || value === "auto") continue;
    const copy = document.createElement("option");
    copy.value = value;
    copy.textContent = option.textContent || value.toUpperCase();
    target.appendChild(copy);
  }
}

/**
 * Everything the live LANG selection decides outside the select itself.
 *
 * Dual-stream Auto — the second, monolingual Nova-3 stream merged into
 * the first by word timestamps (BUGS_AUDIT_2026-09-03.md §1) — is the
 * cost/benefit trade-off Settings › API Keys explains next to its own
 * controls (``deepgramDualStreamNote``, written from
 * ``dualStreamTradeOffText``). It applies to Auto and nothing else: a
 * fixed language has no second stream to add. So its row lives or dies
 * by that one condition, decided here.
 *
 * The Live view used to carry a second copy of the trade-off explanation
 * under the MIC/LANG/REC row (``#languageAutoHint`` /
 * ``#languageAutoDualHint``) — removed 2026-09-05 (user request): one
 * explanation, in Settings next to the controls it explains, is enough.
 */
function syncAutoLanguageUi(): void {
  const lang = (($("language") as HTMLSelectElement).value || "auto").trim().toLowerCase();
  const isAuto = lang === "auto";
  const dualRow = document.getElementById("deepgramDualStreamRow");
  if (dualRow) dualRow.hidden = !isAuto;
}

($("language") as HTMLSelectElement).addEventListener("change", () => {
  syncAutoLanguageUi();
  queueUiPreferencesSave();
});
// Both dual-stream controls persist through the same debounced
// ``/api/config`` save as Key terms. Neither changes whether the row
// itself belongs on screen — only #language's own value does — so
// there is nothing here for syncAutoLanguageUi to re-decide.
dualStreamCheckbox()?.addEventListener("change", () => {
  queueUiPreferencesSave();
});
dualSecondaryLanguageSelect()?.addEventListener("change", () => {
  queueUiPreferencesSave();
});
($("micSelect") as HTMLSelectElement).addEventListener("change", () => {
  queueUiPreferencesSave();
});

let ws: WebSocket | null = null;
// Buffer for PCM frames that arrive while the WS is still CONNECTING.
// Flushed in FIFO order on the first ``pushCapturedFrame`` call after
// the socket transitions to OPEN. Prevents word loss at the start of
// a recording when the AudioWorklet fires frames before the WS
// handshake completes (50–300 ms window).
let wsPendingFrames: ArrayBuffer[] = [];
// Cap measured in OUTPUT SAMPLES, not frame count (BUG-59): a frame
// holds the worklet's input quantum (e.g. 128 samples at 48 kHz),
// which downsamples to ~42.7 output samples — 500 frames were ~1.3 s
// of audio, not the 4 s the old comment promised, so a slow handshake
// silently dropped opening words. 64 000 samples = 4 s at 16 kHz.
const WS_PENDING_MAX_SAMPLES = 64_000;
let wsPendingFrameSamples = 0;
/**
 * Frames captured for this session that never reached the backend —
 * discarded at the pending-buffer cap, lost to a failed ``send``, or
 * still queued when the socket went away.
 *
 * This is the client half of the coverage contract. The backend's
 * ``complete`` flag certifies that everything it *received* reached the
 * model; it cannot know about audio that never left the renderer. Both
 * halves must be clean before a live transcript may be adopted in place
 * of re-transcribing the saved recording.
 */
let wsFramesNeverSent = 0;

/**
 * Frames/bytes actually handed to ``WebSocket.send`` on the live socket
 * for this session — the client's own count of what left the renderer,
 * independent of anything the backend infers from what it received.
 *
 * PROTOCOL CONTRACT C1: these are the counts the ``{type:"finalize"}``
 * message carries (``framesSent``/``bytesSent``), so the backend can
 * drain exactly the in-flight frames instead of guessing from a fixed
 * dwell time. Incremented in exactly one place — ``recordWsFrameSent``
 * — even though two call sites hand frames to the socket (the live
 * capture path and the CONNECTING-buffer flush), so the two numbers can
 * never drift apart from the counting logic itself.
 */
let wsFramesSent = 0;
let wsBytesSent = 0;

/** SSOT for accounting a frame that was just handed to ``socket.send``. */
function recordWsFrameSent(byteLength: number): void {
  wsFramesSent += 1;
  wsBytesSent += byteLength;
}

/**
 * Send everything buffered while the socket was still CONNECTING.
 *
 * Frames only used to be drained from inside ``pushCapturedFrame``, so
 * the flush depended on another frame arriving after the socket opened.
 * A recording that ended inside the handshake window — a short dictated
 * phrase — kept its opening frames in the buffer forever and streamed a
 * transcript that was missing its first words. Now the socket's own
 * ``open`` event drains it, and stop drains it once more before
 * finalize so nothing can be left behind by a late-opening socket.
 *
 * @returns the number of frames that could not be sent.
 */
function flushPendingWsFrames(socket: WebSocket | null): number {
  if (!socket || socket.readyState !== WebSocket.OPEN) return wsPendingFrames.length;
  while (wsPendingFrames.length > 0) {
    const queued = wsPendingFrames[0];
    try {
      socket.send(queued);
      recordWsFrameSent(queued.byteLength);
    } catch (e) {
      // The socket transitioned to CLOSING between the readyState read
      // and the native send. Leave the rest queued; the caller accounts
      // for them as never-sent.
      console.debug("live ws flush interrupted", e);
      break;
    }
    wsPendingFrames.shift();
  }
  if (wsPendingFrames.length === 0) wsPendingFrameSamples = 0;
  return wsPendingFrames.length;
}
let ac: AudioContext | null = null;
let stream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let scriptSinkGain: GainNode | null = null;
let src: MediaStreamAudioSourceNode | null = null;
let timer: number | null = null;
let vuIntervalId: ReturnType<typeof setInterval> | null = null;
let pipelineFailsafeId: ReturnType<typeof setTimeout> | null = null;
let startAt = 0;
/**
 * When the renderer was ASKED to record — the hotkey press or the
 * toggle, as received, before any device is opened.
 *
 * Distinct from ``startAt`` (the first captured SAMPLE) on purpose. On
 * a cold start the two are ~310 ms apart the wrong way round —
 * ``getUserMedia`` + AudioContext + first frame measured 82 + 33 + 172
 * ms on 2026-09-03 (BUGS_AUDIT_2026-09-03 §4.7/§4.9). On a warm start
 * they are apart the other way: the worklet's pre-roll ring hands over
 * audio from before the press, and ``startAt`` is set back by its
 * duration. ``startAt`` remains the clock for everything the user is
 * shown — the elapsed timer, the saved ``started_at``, the duration of
 * the audio that exists — because that is what the recording actually
 * contains.
 */
let startRequestedAt = 0;

/**
 * Is the recording in progress too short to be one?
 *
 * The clock is the earlier of "when we were asked" and "when the audio
 * we hold begins" — see ``captureElapsedMs``. Measuring from the first
 * frame alone silently added the ~310 ms of device start-up to the
 * threshold: a 500 ms minimum became ~810 ms of held hotkey, and a
 * one-word dictation ("да", "стоп") was discarded as a mis-press
 * (§4.9). Measuring from the press alone would now under-count the
 * other way, because a warm start hands over half a second of audio
 * captured before the press ever happened (§4.7).
 *
 * Exported on ``window`` because the main process asks the same question
 * before it queues any post-stop work: one clock, one threshold, one
 * answer. Two measurements would disagree at the boundary, and the
 * disagreement would be the main process waiting for a transcript the
 * renderer had already thrown away.
 */
function recordingIsTooShortToKeep(): boolean {
  if (!isRecording) return false;
  const elapsedMs = captureElapsedMs({
    now: Date.now(),
    startRequestedAt,
    startAt,
  });
  return elapsedMs < UI_TOKENS.capture.minRecordingMs;
}
window.__transcriptorRecordingTooShort = recordingIsTooShortToKeep;
/**
 * PCM capture sink for the current recording session. Lazily created
 * inside ``startLive`` once the mic has yielded its first frames,
 * consumed by ``pushCapturedFrame``, drained at ``stopLive``, and
 * destroyed in the teardown path. Replaces the old ``chunks:
 * Float32Array[]`` module-level array that grew without bound.
 */
let pcmSink: PcmSink | null = null;
let draftSaveTimer: number | null = null;
let workletLastFrameAt = 0;
/**
 * Frames the pre-armed ScriptProcessor has captured while the worklet
 * was still being given the chance to prove itself, and which of the
 * three states that fallback is in.
 *
 * "armed"     — connected, capturing into ``scriptFallbackPending``,
 *               delivering nothing;
 * "committed" — this IS the capture path; frames go straight through;
 * "off"       — not connected, or disposed of because the worklet
 *               delivered first.
 */
type ScriptFallbackState = "off" | "armed" | "committed";
let scriptFallbackState: ScriptFallbackState = "off";
let scriptFallbackPending: Float32Array[] = [];
/**
 * One buffer period of whichever capture node is delivering, in ms.
 *
 * Measured from the frames themselves rather than assumed, so it is
 * right for the worklet's batch size and for the ScriptProcessor's
 * buffer without either having to declare it. This is the unit the stop
 * barrier is expressed in: "everything the device had handed us has
 * been handed on" is one buffer period plus one delivered frame, not a
 * guess about how long silence takes to appear.
 */
let captureBufferPeriodMs = 0;
/**
 * ScriptProcessor buffer size. 4096 samples is ~85 ms at 48 kHz: long
 * enough that main-thread jitter cannot drop audio, short enough that
 * the arbitration between it and the worklet happens within a tenth of
 * a second of the recording starting.
 */
const SCRIPT_PROCESSOR_BUFFER_SAMPLES = 4096;
// The session's own measured level. Every "is this speech or silence?"
// question the capture path asks is answered against it and never
// against a constant amplitude (./audio-levels, BUGS_AUDIT_2026-09-03
// §4.3).
let captureLevel = createCaptureLevel();
let liveDraftText = "";
let liveDraftDisplayText = "";
let liveInterimText = "";
let liveTranscriptSegments: TranscriptSegment[] = [];
let liveRecordingSeq = 0;
let currentRecordingId = 0;
let stopTransitionInFlight = false;
let stopTransitionOwnerToken = "";
// Synchronous guard set at the top of startLive BEFORE any await.  This
// prevents a second startLive call from racing through the same
// `if (isBusy)` check while the first call is still awaiting the
// archive-ready promise.  Without this, two concurrent starts would
// allocate two PcmSinks / WebSockets / MediaRecorders and the second's
// globals would silently leak the first.
let startLiveInFlight = false;
let liveStartAttemptSeq = 0;
// ── Start-path timing ───────────────────────────────────────────────
// The stop chain has carried a per-phase breakdown since the latency
// work; the start chain had nothing, so "the capsule takes about a
// second to come up" could only be guessed at. The endpoint that
// matters is the FIRST CAPTURED FRAME — the moment audio is really
// being recorded, not the moment the function returns — and that
// arrives after startLive has resolved, so the clock and the phase
// list live at module scope. One summary line per recording, emitted
// from pushCapturedFrame.
let startTimings: Array<[string, number]> = [];
let startT0 = 0;
let startFirstFrameSeen = false;
function markStartPhase(label: string): void {
  if (startT0 <= 0 || startFirstFrameSeen) return;
  startTimings.push([label, performance.now() - startT0]);
}
let flushRequestSeq = 0;
const pendingWorkletFlushes = new Map<string, () => void>();
let liveWsMode: LiveWsMode = "none";

function liveStatusSnapshot(): LiveStatusSnapshot {
  return {
    status: liveStatusText,
    statusKind: liveStatusKind,
    timerText: liveTimerText,
    busy: isBusy,
    recording: isRecording,
    recordingId: currentRecordingId,
    autoSendEnter: readAutoSendEnterEnabled(),
    autoStopSilence: getAutoStopSilenceConfig(),
  };
}

window.__transcriptorLiveStatusSnapshot = liveStatusSnapshot;

function resolvePendingWorkletFlushes(): void {
  for (const finish of Array.from(pendingWorkletFlushes.values())) {
    finish();
  }
  pendingWorkletFlushes.clear();
}

function detachWorkletCapture(reason: string): void {
  const node = workletNode;
  if (!node) {
    resolvePendingWorkletFlushes();
    return;
  }
  try {
    node.disconnect();
  } catch (e) {
    console.debug(`AudioWorklet disconnect failed during ${reason}`, e);
  }
  node.port.onmessage = null;
  workletNode = null;
  resolvePendingWorkletFlushes();
}

function teardownScriptProcessorCapture(): void {
  try {
    if (src && scriptNode) src.disconnect(scriptNode);
  } catch { /* best effort */ }
  try { scriptNode?.disconnect(); } catch { /* best effort */ }
  try { scriptSinkGain?.disconnect(); } catch { /* best effort */ }
  if (scriptNode) scriptNode.onaudioprocess = null;
  scriptNode = null;
  scriptSinkGain = null;
  scriptFallbackState = "off";
  scriptFallbackPending = [];
}

/**
 * The worklet has delivered. Throw the pre-armed fallback away —
 * including everything it captured, which is the same audio the worklet
 * already delivered, and which double-counts if it is committed too.
 */
function disarmPreArmedFallback(): void {
  if (scriptFallbackState !== "armed") return;
  teardownScriptProcessorCapture();
}

/**
 * The worklet has not delivered by the time the fallback's first buffer
 * arrived, so the fallback becomes the capture path — including
 * everything it captured while it was waiting to find out. That is the
 * blind window closing: the audio from the start of the recording is
 * still here.
 */
function commitPreArmedFallback(): void {
  if (scriptFallbackState !== "armed") return;
  scriptFallbackState = "committed";
  detachWorkletCapture("AudioWorklet connected but delivered no frames");
  const buffered = scriptFallbackPending;
  scriptFallbackPending = [];
  console.warn(
    `ScriptProcessor fallback committed: AudioWorklet delivered no frames (${buffered.length} buffered frames replayed)`,
  );
  showMicFallbackNotice();
  for (const frame of buffered) pushCapturedFrame(frame);
}

function showMicFallbackNotice(): void {
  if (!shouldLivePreview()) return;
  const cur = liveDraftDisplayText || "";
  if (cur.includes("[Mic fallback engaged]")) return;
  setLiveDraftState(liveDraftText, (cur ? `${cur}\n` : "") + "[Mic fallback engaged]");
}

/**
 * Connect the ScriptProcessor capture path.
 *
 * ``armed`` connects it as the STANDBY path: it captures into
 * ``scriptFallbackPending`` and delivers nothing until the first of its
 * own buffers arrives, at which point exactly one of two things is
 * true — the worklet has delivered frames (dispose of this) or it has
 * not (commit this, replaying what it holds). Not armed, it is the
 * capture path from the first buffer, which is the case where the
 * worklet could not be constructed at all.
 */
function startScriptProcessorCapture(
  localAc: AudioContext,
  localSrc: MediaStreamAudioSourceNode,
  reason: string,
  armed: boolean,
): boolean {
  if (scriptNode) return true;
  try {
    scriptNode = localAc.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SAMPLES, 1, 1);
    scriptSinkGain = localAc.createGain();
    scriptSinkGain.gain.value = 0;
    scriptFallbackState = armed ? "armed" : "committed";
    scriptFallbackPending = [];
    scriptNode.onaudioprocess = (ev: AudioProcessingEvent) => {
      const ch = ev.inputBuffer.getChannelData(0);
      if (!ch || !ch.length) return;
      const frame = new Float32Array(ch);
      if (scriptFallbackState !== "armed") {
        pushCapturedFrame(frame);
        return;
      }
      scriptFallbackPending.push(frame);
      // Arbitration, decided by evidence rather than by a clock: a
      // working worklet posts its first batch within a few ms, long
      // before this buffer completed.
      if (captureLevel.frames > 0) disarmPreArmedFallback();
      else commitPreArmedFallback();
    };
    localSrc.connect(scriptNode);
    scriptNode.connect(scriptSinkGain);
    scriptSinkGain.connect(localAc.destination);
    if (!armed) {
      showMicFallbackNotice();
      console.warn(`ScriptProcessor fallback engaged: ${reason}`);
    }
    return true;
  } catch (e) {
    console.warn("ScriptProcessor fallback init failed", e);
    teardownScriptProcessorCapture();
    return false;
  }
}

/**
 * Empty the module-level ``ac`` slot, closing any context found there.
 *
 * The slot has exactly one owner at a time, and this is the only way to
 * vacate it. An AudioContext that loses its last reference is NOT
 * collected while it is running — Chromium keeps the realtime
 * AudioWorklet thread and its V8 isolate alive — so overwriting the
 * slot without closing the previous context leaks both for the lifetime
 * of the renderer.
 *
 * Returns true when a context was actually closed, so the start path
 * can flag a slot that a teardown should already have emptied.
 */
async function closeAudioContextSlot(): Promise<boolean> {
  const current = ac;
  if (!current) return false;
  ac = null;
  try {
    await current.close();
  } catch { /* already closed — nothing left to release */ }
  return true;
}

/**
 * Vacate the slot before a new capture session claims it.
 *
 * Reaching this with a context still in place means some teardown path
 * returned early; the warning makes that visible instead of letting it
 * accumulate silently, one leaked realtime audio thread per session.
 */
async function releaseOrphanedAudioContext(reason: string): Promise<void> {
  if (await closeAudioContextSlot()) {
    console.warn(`Closed an AudioContext left behind by a previous session (${reason})`);
  }
}

// ── Warm capture ────────────────────────────────────────────────────
//
// The capture graph that outlives a recording (BUGS_AUDIT_2026-09-03
// §4.7). Exactly one of three things is true of it at any moment:
//
//   • a session owns it — the module slots (``ac``/``stream``/``src``/
//     ``workletNode``) hold it and ``warmCapture`` is null;
//   • it is held idle — ``warmCapture`` holds it and the module slots
//     are null;
//   • it does not exist.
//
// Ownership MOVES, it is never shared: ``holdWarmCapture`` empties the
// module slots as it fills the hold, ``takeWarmCapture`` empties the
// hold as the next session fills the slots. That is what keeps a
// failed start from closing a context the hold still points at, and a
// TTL from stopping the tracks of a recording in progress.

interface WarmCapture {
  ac: AudioContext;
  stream: MediaStream;
  src: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
  /** ``deviceId`` the held track reports, for the "same mic?" check. */
  deviceId: string;
  /** Track label, kept for the trace line. */
  deviceLabel: string;
  heldSince: number;
  expiryTimer: number | null;
}

let warmCapture: WarmCapture | null = null;
/**
 * Did the running session adopt a warm graph, and how much pre-roll did
 * it actually accept? Both are read once, by the start trace line, so
 * the support log says whether the mechanism did anything on this host.
 */
let sessionStartedWarm = false;
let sessionPreRollMs = 0;

function streamHasLiveAudio(s: MediaStream | null): boolean {
  if (!s) return false;
  try {
    return s.getAudioTracks().some((t) => t.readyState === "live");
  } catch {
    // A stream whose tracks cannot be read is not one we can record from.
    return false;
  }
}

function micTrackLabel(s: MediaStream | null): string {
  if (!s) return "";
  try {
    return s.getAudioTracks()[0]?.label || "";
  } catch {
    // Same as above: unreadable means "cannot vouch for this device".
    return "";
  }
}

function micTrackDeviceId(s: MediaStream | null): string {
  if (!s) return "";
  try {
    return String(s.getAudioTracks()[0]?.getSettings?.()?.deviceId || "");
  } catch {
    // Settings are advisory; an unreadable one just fails the match.
    return "";
  }
}

/**
 * Tear down the held graph. The ONLY way the hold is vacated other than
 * a session adopting it, and therefore the only place the microphone is
 * actually released once a recording has ended.
 */
function releaseWarmCapture(reason: string): void {
  const held = warmCapture;
  if (!held) return;
  warmCapture = null;
  if (held.expiryTimer !== null) window.clearTimeout(held.expiryTimer);
  const heldMs = Date.now() - held.heldSince;
  try { held.workletNode.port.onmessage = null; } catch { /* port already dead */ }
  try { held.workletNode.disconnect(); } catch { /* already disconnected */ }
  try { held.src.disconnect(); } catch { /* already disconnected */ }
  try { held.stream.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
  if (micTrackWatchersStream === held.stream) micTrackWatchersStream = null;
  void held.ac.close().catch(() => { /* already closing — nothing to release */ });
  console.log(`[trace warmCapture] released reason=${reason} heldMs=${heldMs}`);
}

/**
 * Release the microphone held in the module slot.
 *
 * One helper, because the stop path now has two places that must stop
 * the same track — step 1 when the hold is refused, and the handover
 * when a planned hold does not complete — and "the microphone is
 * released on every path" is not a property you want spelled out twice.
 */
function stopCaptureTracks(): void {
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    console.debug("MediaStream stop failed (non-fatal)", e);
  }
}

/**
 * The outcome of the hold decision, taken at the top of the stop
 * sequence and acted on in the teardown.
 *
 * The decision and the ownership move are two steps for one reason:
 * ``decideWarmHold`` asks whether the track is ``readyState === "live"``,
 * and the first thing the stop sequence used to do was stop it. Asking
 * afterwards can only ever answer "track-ended" — which is exactly what
 * production logs showed, 15 stops out of 15, with every start cold.
 * So the question is asked first, while the answer still means
 * something, and the graph is handed over later, at the point in the
 * teardown where the module slots are given up anyway.
 */
interface WarmHoldPlan {
  hold: boolean;
  reason: string;
  deviceLabel: string;
  /** The graph this plan promised to keep. Null unless ``hold``. */
  ac: AudioContext | null;
  stream: MediaStream | null;
  src: MediaStreamAudioSourceNode | null;
  workletNode: AudioWorkletNode | null;
}

function refusedWarmHold(reason: string, deviceLabel: string): WarmHoldPlan {
  return { hold: false, reason, deviceLabel, ac: null, stream: null, src: null, workletNode: null };
}

/**
 * Decide whether the capture graph of the ending session may be kept,
 * and — on a "yes" — arm the worklet's pre-roll ring.
 *
 * Called as step 1 of the stop sequence, in place of stopping the
 * microphone track. Arming gives the same guarantee that
 * ``track.stop()`` gave: the worklet flushes what it was holding and
 * then delivers nothing further, so no frame captured after this point
 * can reach ``pcmSink.append`` or the live socket. The difference is
 * that the microphone itself stays open, which is the entire point of
 * the mechanism.
 *
 * Module slots are deliberately LEFT IN PLACE here — the flush barrier
 * that follows reads ``workletNode``. Ownership moves in
 * ``commitWarmCaptureHold``.
 */
function planWarmCaptureHold(): WarmHoldPlan {
  const deviceLabel = micTrackLabel(stream);
  const decision = decideWarmHold({
    warmHoldMs: UI_TOKENS.capture.warmHoldMs,
    deviceLabel,
    trackLive: streamHasLiveAudio(stream),
    contextState: ac?.state || "closed",
    // The pre-roll ring lives in the worklet; a session that fell back
    // to the ScriptProcessor has nothing to hold that would pay for the
    // microphone staying open.
    workletCapture: !!workletNode && scriptFallbackState !== "committed",
  });
  if (!decision.hold) return refusedWarmHold(decision.reason, deviceLabel);
  const heldAc = ac;
  const heldStream = stream;
  const heldSrc = src;
  const heldNode = workletNode;
  if (!heldAc || !heldStream || !heldSrc || !heldNode) {
    return refusedWarmHold("incomplete-graph", deviceLabel);
  }
  try {
    heldNode.port.postMessage({ type: "arm", preRollMs: UI_TOKENS.capture.preRollMs });
  } catch (e) {
    // The port is gone, so the ring can never be filled and the hold
    // would buy nothing but a lit microphone indicator.
    console.debug("warm capture: arming the pre-roll ring failed", e);
    return refusedWarmHold("arm-failed", deviceLabel);
  }
  return {
    hold: true,
    reason: decision.reason,
    deviceLabel,
    ac: heldAc,
    stream: heldStream,
    src: heldSrc,
    workletNode: heldNode,
  };
}

/**
 * Move the planned graph out of the module slots and into the hold.
 *
 * Called from the stop teardown BEFORE the unconditional disconnects:
 * on a "yes" the module slots are emptied here, so every teardown step
 * that follows finds a null and does nothing, and the graph is left
 * running with its worklet armed. On a "no" nothing moves and the
 * ordinary teardown releases everything exactly as it did before.
 *
 * Returns whether the hold actually took, which is not the same as
 * whether it was planned: anything that replaced a module slot between
 * the two steps invalidates the plan, and a graph we can no longer
 * account for is released rather than held.
 */
function commitWarmCaptureHold(plan: WarmHoldPlan): boolean {
  if (!plan.hold) return false;
  if (ac !== plan.ac || stream !== plan.stream || src !== plan.src || workletNode !== plan.workletNode) {
    console.warn("warm capture: graph changed between the hold decision and the handover; releasing");
    return false;
  }
  const heldAc = plan.ac;
  const heldStream = plan.stream;
  const heldSrc = plan.src;
  const heldNode = plan.workletNode;
  if (!heldAc || !heldStream || !heldSrc || !heldNode) return false;
  // Per-session edges come off HERE, while ``src`` is still in the
  // module slot: the teardown steps that follow all read that slot, and
  // this function is about to empty it. The analyser and the pre-armed
  // ScriptProcessor belong to the recording that is ending — left
  // connected they would accumulate one dead node per warm session on a
  // source node that now outlives them all. The worklet edge is the one
  // that stays: it is what keeps filling the pre-roll ring.
  if (analyser) {
    try { heldSrc.disconnect(analyser); } catch { /* never connected */ }
  }
  teardownScriptProcessorCapture();
  warmCapture = {
    ac: heldAc,
    stream: heldStream,
    src: heldSrc,
    workletNode: heldNode,
    deviceId: micTrackDeviceId(heldStream),
    deviceLabel: plan.deviceLabel,
    heldSince: Date.now(),
    expiryTimer: window.setTimeout(
      () => releaseWarmCaptureOnLifecycle("ttl"),
      UI_TOKENS.capture.warmHoldMs,
    ),
  };
  // Ownership has moved. Everything below in the teardown chain now
  // finds empty slots, which is precisely the intent.
  ac = null;
  stream = null;
  src = null;
  workletNode = null;
  return true;
}

/**
 * Adopt the held graph for the recording that is starting, or release
 * it and let the caller take the cold path.
 *
 * Every "no" releases rather than leaves the hold in place: whatever
 * made it unusable for this press — an expired TTL, a device the user
 * has since changed, a track that ended while we were idle — makes it
 * unusable for the next one too, and holding a microphone open for a
 * graph nobody can use is the worst of both designs.
 */
function takeWarmCapture(requestedDeviceId: string): WarmCapture | null {
  const held = warmCapture;
  if (!held) return null;
  const decision = decideWarmReuse({
    now: Date.now(),
    heldSince: held.heldSince,
    warmHoldMs: UI_TOKENS.capture.warmHoldMs,
    heldDeviceId: held.deviceId,
    requestedDeviceId,
    trackLive: streamHasLiveAudio(held.stream),
    contextState: held.ac.state,
  });
  if (!decision.reuse) {
    releaseWarmCapture(decision.reason);
    return null;
  }
  warmCapture = null;
  if (held.expiryTimer !== null) window.clearTimeout(held.expiryTimer);
  return held;
}

// The hold survives an idle window, not a change of circumstances — one
// listener per entry of ``WARM_HOLD_LIFECYCLE_RELEASES`` (./capture-warm,
// where each reason and its rationale live), all of them going through
// the one release path. ``releaseWarmCapture`` itself takes any string,
// because ``decideWarmReuse`` hands it its own rejection reasons; this
// wrapper is what holds the lifecycle listeners to the named set.
// Declared, not assigned to a const: the expiry timer in
// ``holdWarmCapture`` above refers to it, and a hoisted declaration
// cannot be reached before it exists.
function releaseWarmCaptureOnLifecycle(reason: WarmHoldLifecycleRelease): void {
  releaseWarmCapture(reason);
}
//
// Note what is NOT here: "hidden" is not tested at Stop. Dictation by
// global hotkey routinely happens with the main window hidden, so a
// hold refused whenever the document is hidden would be a hold that
// never once applied to the case it was built for. It is the
// TRANSITION to hidden that releases.
try {
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    releaseWarmCaptureOnLifecycle("devicechange");
  });
} catch (e) {
  // Older shells expose mediaDevices without EventTarget semantics; the
  // TTL still bounds the hold.
  console.debug("warm capture: devicechange listener unavailable", e);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") releaseWarmCaptureOnLifecycle("window-hidden");
});
window.addEventListener("pagehide", () => releaseWarmCaptureOnLifecycle("pagehide"));
// Holds the unsubscribe ``onSystemSuspend`` returns, so
// ``subscribeToSystemSuspend`` (see its own doc comment, D-053) can
// retire its own prior listener before installing a new one.
let systemSuspendUnsubscribe: (() => void) | null = null;

/**
 * Sleep and lock-screen. Called once at renderer boot and meant to
 * outlive every recording — the hold outlives them too, so the release
 * has to as well. The renderer cannot see this event on its own —
 * ``setTimeout`` does not run while the machine is asleep, so the hold's
 * TTL timer cannot fire, and the OS may hand the microphone to another
 * application while we are not looking. A shell without the bridge (an
 * older desktop build, or the app opened in a plain browser) is not
 * broken by its absence: ``decideWarmReuse`` re-checks the wall clock at
 * the next press and refuses a hold that slept through.
 *
 * D-053: ``onSystemSuspend`` returns an unsubscribe, and the call site
 * used to discard it inline at the top level — meaning if this function
 * (or the top-level script that used to inline it) ever ran a second
 * time in one page lifetime, the previous listener stayed registered
 * and a second one stacked on top of it, so one real suspend fired
 * ``releaseWarmCaptureOnLifecycle`` twice. A Vite dev-server HMR update
 * is exactly that kind of re-run: it re-executes top-level code WITHOUT
 * a page reload, which is the only thing that tears down the preload
 * world's listeners. Harmless by luck (the release function is
 * idempotent) rather than by design. Retiring the prior subscription
 * first, unconditionally, makes a second call — from HMR or any future
 * refactor that invokes this more than once — safe by construction
 * instead of by luck.
 */
function subscribeToSystemSuspend(): void {
  try {
    systemSuspendUnsubscribe?.();
    systemSuspendUnsubscribe = window.transcriptor?.onSystemSuspend?.(({ reason }) => {
      console.log(`[trace warmCapture] system suspend (${reason || "unknown"}) — releasing the hold`);
      releaseWarmCaptureOnLifecycle("system-suspend");
    }) ?? null;
  } catch (e) {
    console.debug("warm capture: system-suspend bridge unavailable", e);
  }
}
subscribeToSystemSuspend();

/**
 * The stream this session's device watchers are already attached to.
 *
 * A warm start hands the SAME ``MediaStream`` — and the same tracks — to
 * the next recording, so attaching per session would stack one pair of
 * mute/unmute listeners per press onto a track that now lives for as
 * long as the hold chain does. The watchers are therefore attached once
 * per stream and read the live session state when they fire, rather than
 * closing over the token of the session that installed them.
 */
let micTrackWatchersStream: MediaStream | null = null;

/**
 * Watch the capture device for the failures that make a recording
 * silently worthless.
 *
 * Device disconnect mid-recording: when AirPods/USB mic disconnect, the
 * audio track fires ``ended`` but nothing used to listen. The recording
 * continued in silence until the user pressed Stop, and the transcript
 * was missing everything after the disconnect. Auto-stopping on
 * ``ended`` gives a clean transcript up to the disconnect point and a
 * visible status. ``mute``/``unmute`` are watched for the same reason:
 * a session where the OS-level input is muted mid-recording (common with
 * USB headsets / AirPods) would otherwise produce a zero-signal WAV and
 * a "No speech captured" message that names the wrong cause.
 */
function attachMicTrackWatchers(target: MediaStream): void {
  if (micTrackWatchersStream === target) return;
  micTrackWatchersStream = target;
  for (const track of target.getAudioTracks()) {
    track.addEventListener("ended", () => {
      if (!isRecording) return;
      console.warn("Audio track ended (device disconnect) — auto-stopping");
      micHealth.observe({ kind: "track-ended" });
      patchCurrentRecordingSummary(
        { status: "Microphone disconnected. Saving what was captured.", tone: "warning" },
        activeUiSessionToken,
      );
      void stopLive(shouldAutoTranscribe());
    }, { once: true });
    track.addEventListener("mute", () => {
      if (!isRecording) return;
      micHealth.observe({ kind: "track-muted", muted: true });
    });
    track.addEventListener("unmute", () => {
      if (!isRecording) return;
      micHealth.observe({ kind: "track-muted", muted: false });
    });
  }
}

/**
 * The capture worklet's single message handler.
 *
 * Installed both when the node is created and when a held node is
 * adopted, so a warm start and a cold start deliver audio through
 * exactly the same path.
 */
function handleWorkletMessage(ev: MessageEvent): void {
  const msg = ev.data as unknown;
  if (msg instanceof Float32Array) {
    // The worklet works. Whatever the pre-armed fallback has captured
    // is this same audio; committing both would double every sample,
    // so it goes away here and now (§4.5).
    disarmPreArmedFallback();
    pushCapturedFrame(msg);
    return;
  }
  if (!msg || typeof msg !== "object") return;
  const data = msg as { type?: unknown; token?: unknown; samples?: unknown; lastWriteTime?: unknown };
  if (data.type === "flush-ack") {
    const token = String(data.token || "");
    const resolve = pendingWorkletFlushes.get(token);
    if (resolve) resolve();
    return;
  }
  if (data.type === "pre-roll") acceptPreRoll(data.samples, Number(data.lastWriteTime));
}

/**
 * The audio from before the press.
 *
 * It arrives ahead of every live frame (a MessagePort preserves order),
 * so pushing it through the ordinary capture path is all that is needed
 * to put it at the front of the WAV, at the front of the live socket's
 * stream, and in front of the recording's own clock — ``startAt`` moves
 * back by its duration, in the one place that sets it.
 */
function acceptPreRoll(samples: unknown, lastWriteTime: number): void {
  if (!(samples instanceof Float32Array) || !ac) return;
  const staleMs = Number.isFinite(lastWriteTime)
    ? (ac.currentTime - lastWriteTime) * 1000
    : Number.POSITIVE_INFINITY;
  const verdict = decidePreRoll({
    sampleCount: samples.length,
    sampleRate: ac.sampleRate,
    staleMs,
    maxAgeMs: UI_TOKENS.capture.preRollMaxAgeMs,
  });
  if (!verdict.accept) {
    console.warn(
      `[trace startLive] pre-roll discarded reason=${verdict.reason} ` +
      `ageMs=${verdict.ageMs.toFixed(0)} durationMs=${verdict.durationMs.toFixed(0)}`,
    );
    return;
  }
  sessionPreRollMs = verdict.durationMs;
  disarmPreArmedFallback();
  pushCapturedFrame(samples, verdict.durationMs);
}

async function cleanupCancelledStartCaptureResources(): Promise<void> {
  if (vuIntervalId) {
    clearInterval(vuIntervalId);
    vuIntervalId = null;
  }
  if (pipelineFailsafeId) {
    clearTimeout(pipelineFailsafeId);
    pipelineFailsafeId = null;
  }
  detachWorkletCapture("cancelled live start");
  teardownScriptProcessorCapture();
  try { analyser?.disconnect(); } catch { /* best effort */ }
  analyser = null;
  try { src?.disconnect(); } catch { /* best effort */ }
  src = null;
  if (mediaRecorder) {
    try { mediaRecorder.ondataavailable = null; } catch { /* best effort */ }
    try {
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch { /* best effort */ }
    mediaRecorder = null;
    recordedWebmChunks = [];
  }
  if (stream) {
    try { stream.getTracks().forEach((track) => track.stop()); } catch { /* best effort */ }
    stream = null;
  }
  await closeAudioContextSlot();
}
/**
 * Finalize barrier for the live WebSocket.
 *
 * Each recording session has its own slot, keyed by the session UI
 * token. A second recording started before the first one has finished
 * finalizing cannot leak its envelope into the first one — when the
 * first session's ``waitForLiveFinalEnvelope(token, ms)`` resolves, it
 * reads only the slot that belongs to its own token.
 */
interface LiveFinalSlot {
  envelope: LiveFinalEnvelope | null;
  waiters: Array<(envelope: LiveFinalEnvelope | null) => void>;
}

/**
 * Per-session live PREVIEW state: the committed finals and the current
 * hypothesis for the tail, and nothing else.
 *
 * It used to carry two more fields — ``lastInterimText`` (the
 * hypothesis the last final displaced) and ``recoveredTailText`` (what
 * every earlier final dropped from its own interim, accumulated) —
 * because the stop path read this buffer and delivered what it found.
 * It no longer does. Recovering a word the provider's finals dropped is
 * the backend's word-level splice's job, where the word goes back where
 * it was spoken; the renderer's version of it could only append, which
 * put "трёх в" on the end of session ``a9fd3fd9``'s transcript. The
 * preview never regresses visibly without them either: the display floor
 * in ``scheduleLiveOutputRender`` is monotonic.
 */
interface LiveTranscriptBuffer {
  segments: TranscriptSegment[];
  committedText: string;
  committedDisplayText: string;
  interimText: string;
  interimSegment: TranscriptSegment | null;
  committedDisplayCache: string;
  wsMode: LiveWsMode;
}

const liveFinalSlots = new Map<string, LiveFinalSlot>();
const liveTranscriptBuffers = new Map<string, LiveTranscriptBuffer>();
// Session-scoped live-stream error map. Was previously a single
// global ``let liveStreamError = ""``; that allowed an OLD session's
// error event (fired through a buffered ws.onmessage tick) to bleed
// into a fresh session's ``liveStreamErrorAtStop`` snapshot at
// stopLive time, causing the new session's fast-path to short-
// circuit on a phantom error from the previous recording. Keying
// on ``sessionUiToken`` makes each session's error scope-pure.
const liveStreamErrors = new Map<string, string>();
function getLiveStreamError(token: string): string {
  if (!token) return "";
  return liveStreamErrors.get(token) || "";
}
function setLiveStreamError(token: string, err: string): void {
  if (!token) return;
  if (err) liveStreamErrors.set(token, err);
  else liveStreamErrors.delete(token);
}

function createLiveTranscriptBuffer(wsMode: LiveWsMode): LiveTranscriptBuffer {
  return {
    segments: [],
    committedText: "",
    committedDisplayText: "",
    interimText: "",
    interimSegment: null,
    committedDisplayCache: "",
    wsMode,
  };
}

function getLiveTranscriptBuffer(token: string): LiveTranscriptBuffer | null {
  if (!token) return null;
  return liveTranscriptBuffers.get(token) || null;
}

function ensureLiveTranscriptBuffer(token: string, wsMode: LiveWsMode): LiveTranscriptBuffer {
  const existing = getLiveTranscriptBuffer(token);
  if (existing) return existing;
  const buffer = createLiveTranscriptBuffer(wsMode);
  liveTranscriptBuffers.set(token, buffer);
  return buffer;
}

function canonicalTextFromBuffer(buffer: LiveTranscriptBuffer): string {
  return mergeInterim(buffer.committedText, buffer.interimText);
}

function getSessionCanonicalLiveSourceText(token: string): string {
  const buffer = getLiveTranscriptBuffer(token);
  return buffer ? canonicalTextFromBuffer(buffer) : getCanonicalLiveSourceText();
}

function appendSegmentsToBuffer(
  buffer: LiveTranscriptBuffer,
  rawSegments: unknown[],
): void {
  const nextSegments = Array.isArray(rawSegments)
    ? rawSegments
      .map((segment) => normalizeTranscriptSegment(segment))
      .filter((segment): segment is TranscriptSegment => !!segment)
    : [];
  if (!nextSegments.length) return;

  const prevLen = buffer.segments.length;
  const combined = buffer.segments.concat(nextSegments);
  const merged = mergeTranscriptSegments(combined);
  const appendOnly =
    merged.length === combined.length &&
    merged.length >= prevLen &&
    merged.slice(0, prevLen).every((seg, i) => seg === buffer.segments[i]);

  buffer.segments = merged;
  // The final retires the hypothesis that produced it. Whatever the
  // final did not carry over is the backend's to splice back in, at the
  // time it was spoken — see the LiveTranscriptBuffer doc.
  buffer.interimText = "";
  buffer.interimSegment = null;

  const separator = buffer.wsMode === "deepgram-stream" ? " " : "\n";
  const hasDiarization = buffer.segments.some((s) => s.speaker !== undefined);
  if (hasDiarization) {
    buffer.committedDisplayCache = formatSegmentsForDisplay(buffer.segments, separator);
  } else if (appendOnly) {
    let delta = "";
    for (let i = prevLen; i < merged.length; i++) {
      const t = merged[i].text;
      if (!t) continue;
      if (delta) delta += separator;
      delta += t;
    }
    if (delta) {
      buffer.committedDisplayCache = buffer.committedDisplayCache
        ? `${buffer.committedDisplayCache}${separator}${delta}`
        : delta;
    }
  } else {
    buffer.committedDisplayCache = merged
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(separator)
      .trim();
  }
  buffer.committedText = joinTranscriptSegments(buffer.segments);
  buffer.committedDisplayText = buffer.committedDisplayCache || buffer.committedText;
}

function hasStreamingActivity(buffer: LiveTranscriptBuffer | null): boolean {
  if (!buffer) return false;
  return (
    buffer.segments.length > 0 ||
    !!buffer.committedText.trim() ||
    !!buffer.interimText.trim()
  );
}

function projectLiveTranscriptBufferToActiveState(buffer: LiveTranscriptBuffer): void {
  liveTranscriptSegments = buffer.segments;
  liveInterimText = buffer.interimText;
  setLiveDraftState(buffer.committedText, buffer.committedDisplayText);
}

function ensureLiveFinalSlot(token: string): LiveFinalSlot {
  let slot = liveFinalSlots.get(token);
  if (!slot) {
    slot = { envelope: null, waiters: [] };
    liveFinalSlots.set(token, slot);
  }
  return slot;
}

function resolveLiveFinal(token: string, envelope: LiveFinalEnvelope): void {
  if (!token) {
    logger_warn_client("resolveLiveFinal called without session token; ignored");
    return;
  }
  const slot = ensureLiveFinalSlot(token);
  slot.envelope = envelope;
  const waiters = slot.waiters;
  slot.waiters = [];
  for (const waiter of waiters) {
    try {
      waiter(envelope);
    } catch (e) {
      console.warn("live final waiter threw", e);
    }
  }
}

function clearLiveStreamState(): void {
  // Drop only stale slots that have no waiters. A previous stopLive may
  // still be awaiting its final envelope while a new recording starts;
  // forcing those waiters to null here breaks recording/transcription
  // parallelism and discards the post-CloseStream tail.
  const activeToken = activeUiSessionToken || "";
  for (const [token, slot] of liveFinalSlots) {
    if (token === activeToken) continue;
    if (slot.waiters.length === 0) liveFinalSlots.delete(token);
  }
  // Session-scoped error map: drop entries for stale sessions only.
  // The active session's error (if any) is preserved so that a tail-
  // running stopLive can still see it.
  for (const token of [...liveStreamErrors.keys()]) {
    if (token !== activeToken && !liveFinalSlots.has(token)) liveStreamErrors.delete(token);
  }
  for (const token of [...liveTranscriptBuffers.keys()]) {
    if (token !== activeToken && !liveFinalSlots.has(token)) {
      liveTranscriptBuffers.delete(token);
    }
  }
  liveInterimText = "";
}

function waitForLiveFinalEnvelope(
  token: string,
  timeoutMs: number
): Promise<LiveFinalEnvelope | null> {
  if (!token) {
    return Promise.resolve(null);
  }
  const slot = ensureLiveFinalSlot(token);
  if (slot.envelope) {
    return Promise.resolve(slot.envelope);
  }
  return new Promise((resolve) => {
    let settled = false;
    // The timeout handle is kept so an envelope that arrives in the
    // first second does not leave a timer to wake up four seconds later
    // for nothing. ``settled`` makes that harmless, not free — and the
    // two neighbouring waits in this file
    // (``waitForLiveEnvelopeWithAnnouncedBudget``, ``flushWorkletPort``)
    // both clear theirs.
    let timerId: number | null = null;
    const done = (value: LiveFinalEnvelope | null): void => {
      if (settled) return;
      settled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      slot.waiters = slot.waiters.filter((w) => w !== handler);
      resolve(value);
    };
    const handler = (envelope: LiveFinalEnvelope | null): void => done(envelope);
    slot.waiters.push(handler);
    timerId = window.setTimeout(
      () => done(slot.envelope),
      Math.max(0, timeoutMs)
    );
  });
}

// Tiny helper so the logger_warn_client reference above is not a
// dangling name during initialization.
function logger_warn_client(message: string): void {
  console.warn(message);
}

/**
 * ── Recording output SSOT ───────────────────────────────────────────────
 *
 * There are two distinct semantic channels the rest of the system reads:
 *
 *   1. ``pasteReady`` — consumed by the Electron main process through
 *      ``window.__transcriptorLastFinished*`` and
 *      ``window.__transcriptorFinishedRecords``. This tells Electron main
 *      "a transcript is ready to paste NOW".
 *
 *   2. ``uiFinal`` — consumed by the Electron main process through
 *      ``window.__transcriptorLastUiFinal*`` for recording state machines
 *      that need to know what the UI is currently showing. This is also
 *      what drives the ``$finalOutput`` DOM element.
 *
 * All callers go through ``publishRecordingFinalSignal`` (which passes a
 * session token) or ``publishRecordingOutput`` directly. One call = one
 * atomic update of both channels plus the DOM.
 */
/**
 * How many finished recordings stay on ``window.__transcriptorFinishedRecords``.
 *
 * Both sides of this contract trim to the same depth — the renderer here
 * and ``desktop/main.js`` again when it reads — and the number was
 * written out in both. This is the renderer's side of it; the main
 * process cannot import from here, so the two are pinned by a test
 * instead.
 */
const FINISHED_RECORDS_KEPT = 30;

interface RecordingOutputSignal {
  recordingId: number;
  /** The canonical, paste-ready text (post-upscale if upscaling was used).
   *  Passing an empty string means "no paste is available". */
  pasteText?: string;
  /** The text to render in the ``$finalOutput`` DOM element. Defaults to
   *  ``pasteText`` when omitted. Pass explicit ``""`` to clear the DOM. */
  domText?: string;
  /** Classification of this event for the recording state machine. */
  kind?: RecordingFinalSignalKind;
  /**
   * What the renderer is doing at this publish ("upscaling",
   * "no-speech", …). Rides along in the IPC signal's ``source`` label
   * so the desktop side can show a phase it used to derive by polling.
   */
  phase?: string;
  sessionToken?: string;
}

function recordingOutputIsInvalidTranscript(payload: string): boolean {
  const lower = payload.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (!payload) return true;
  if (lower === "error" || lower === "[websocket error]") return true;
  if (lower.startsWith("http ")) return true;
  if (compact === "[silence]") return true;
  return false;
}

function publishRecordingOutput(signal: RecordingOutputSignal): void {
  const rid = Math.max(0, Number(signal.recordingId || 0));
  const pasteText = String(signal.pasteText || "").trim();
  const domText =
    signal.domText === undefined ? pasteText : String(signal.domText || "").trim();
  const kind: RecordingFinalSignalKind = pasteText
    ? signal.kind || "transcript"
    : signal.kind || "";
  const now = Date.now();
  const uiFinalText = domText;
  const hasUiFinal = !!kind && !!uiFinalText;

  // Channel 1: paste-ready history (only for valid transcripts).
  const isPasteReady = !!pasteText && !recordingOutputIsInvalidTranscript(pasteText);
  if (isPasteReady) {
    window.__transcriptorLastFinishedText = pasteText;
    window.__transcriptorLastFinishedAt = now;
    window.__transcriptorLastFinishedRecordingId = rid;
    if (rid > 0) {
      const list = Array.isArray(window.__transcriptorFinishedRecords)
        ? window.__transcriptorFinishedRecords.slice()
        : [];
      const next = list.filter((entry) => Number(entry?.recordingId || 0) !== rid);
      next.push({ recordingId: rid, finishedAt: now, text: pasteText });
      window.__transcriptorFinishedRecords = next.slice(-FINISHED_RECORDS_KEPT);
    }
  }

  // Channel 1b: the same fact, pushed to the Electron main process
  // instead of waiting to be polled for it (§6.7). Every publish for a
  // real recording emits one signal — a recording that ends without a
  // transcript at all still says so, which is how the main process
  // learns it is terminal without waiting out its deadline. The text on
  // a non-final signal is whatever the UI is showing; judging it is the
  // main process's job (it owns the paste decision), and a second
  // opinion here would be a second policy.
  if (rid > 0) {
    window.transcriptor?.recordingFinal?.({
      recordingId: rid,
      text: isPasteReady ? pasteText : domText,
      final: isPasteReady,
      source: signal.phase ? `${kind || "status"}:${signal.phase}` : (kind || "status"),
    });
  }

  // Channel 2: UI-final signal (always updated so Electron main can track
  // both transcript and error/status states).
  window.__transcriptorLastUiFinalText = hasUiFinal ? uiFinalText : "";
  window.__transcriptorLastUiFinalAt = hasUiFinal ? now : 0;
  window.__transcriptorLastUiFinalRecordingId = hasUiFinal ? rid : 0;
  window.__transcriptorLastUiFinalKind = hasUiFinal ? kind : "";

  // Channel 3: the DOM itself. Respects the active UI session so that a
  // stale async handler from a previous recording cannot clobber the
  // current display.
  if (isCurrentUiSession(signal.sessionToken || "")) {
    // The live preview pane is deliberately NOT cleared here: the user
    // compares the streamed reading against the final transcript
    // (Deepgram sometimes swallows words, and the pane is the evidence).
    // It clears when the NEXT recording starts, in
    // ``resetLiveDraftState``. This used to be written as an ``if`` with
    // a comment for a body, which hides the intent rather than stating
    // it — a reader had to prove to themselves that nothing was missing.
    $("finalOutput").textContent = domText;
  }
}

/**
 * Atomic reset of EVERY window.__transcriptor* scalar Electron main
 * reads. Called when a new recording begins or when an explicit
 * ``resetOutputs()`` fires.
 *
 * The ``__transcriptorFinishedRecords`` history array is intentionally
 * NOT cleared here — it's keyed by recordingId and bounded at 30
 * entries, and Electron main uses it as a lookup table to recover the
 * text for a specific finished recordingId even after newer sessions
 * have overwritten the scalar pointers.
 *
 * Previously this function only reset Channel 2 (ui-final), leaving
 * Channel 1 (paste-ready: LastFinishedText/At/RecordingId) pointing at
 * the PREVIOUS session's transcript. During the startup window of a
 * new recording, Electron main could observe stale paste-ready state
 * and trigger a recording transition keyed on it.
 */
function clearRecordingOutput(): void {
  // Channel 1 — paste-ready scalars.
  window.__transcriptorLastFinishedText = "";
  window.__transcriptorLastFinishedAt = 0;
  window.__transcriptorLastFinishedRecordingId = 0;
  // Channel 2 — ui-final signal.
  window.__transcriptorLastUiFinalText = "";
  window.__transcriptorLastUiFinalAt = 0;
  window.__transcriptorLastUiFinalRecordingId = 0;
  window.__transcriptorLastUiFinalKind = "";
}

function clearRecordingFinalSignal(): void {
  clearRecordingOutput();
}

function publishRecordingFinalSignal(opts: {
  recordingId: number;
  signalText?: string;
  domText?: string;
  kind?: RecordingFinalSignalKind;
  phase?: string;
  sessionToken?: string;
}): void {
  publishRecordingOutput({
    recordingId: opts.recordingId,
    pasteText: opts.signalText,
    domText: opts.domText,
    kind: opts.kind,
    phase: opts.phase,
    sessionToken: opts.sessionToken,
  });
}

/**
 * Live-output render coalescing.
 *
 * Deepgram interim events can arrive at 10–20 Hz and every segment
 * commit rewrites ``$("liveOutput").textContent`` + scrolls to the
 * bottom. Naively doing that on every event produces layout thrash
 * and visible jank. We coalesce all updates into a single rAF tick so
 * no matter how many events arrive between paints, the DOM is touched
 * at most once per frame.
 */
let liveOutputRenderScheduled = false;
let livePreviewFloorText = "";

function scheduleLiveOutputRender(): void {
  if (liveOutputRenderScheduled) return;
  liveOutputRenderScheduled = true;
  const run = (): void => {
    liveOutputRenderScheduled = false;
    const el = $("liveOutput");
    if (!shouldLivePreview()) {
      // Preview off must not mean a dark pane: while a recording is
      // active the user still needs proof that capture is alive and
      // where the transcript will land ("если я live превью отключаю,
      // то не знаю, что происходит"). The elapsed clock reuses
      // ``liveTimerText`` — the same value the per-second tick and the
      // liveStatusSnapshot publish — so the app has exactly ONE
      // recording clock. Interim capture keeps filling the session
      // buffer underneath; only its display is suppressed here, and
      // Stop still renders the full transcript as usual.
      // The display contract (including the exact status wording) is
      // the unit-tested pure function in ./live-pane.
      const status = livePaneDisplayText({
        previewEnabled: false,
        recording: isRecording,
        started: startAt > 0,
        timerText: liveTimerText,
      });
      if (el.textContent !== status) {
        el.textContent = status;
      }
      return;
    }
    // B-041 / ONE rule (see ./transcript-merge's composeLivePreviewText):
    // once THIS session's stop envelope has resolved, it is the text —
    // verbatim, not unioned with the committed/interim reading it
    // replaces. Checked before the monotonic floor below on purpose: a
    // resolved envelope can legitimately read as fewer words than the
    // floor (its own dedup differs from the incremental reading's), and
    // the floor's job — never regress a still-updating hypothesis — has
    // nothing to arbitrate once there is nothing left to update.
    //
    // ``envelopeMissing`` (not a bare null check) is what decides
    // "resolved": ws.onclose resolves the slot with a synthetic
    // error/empty envelope the moment an unclean close is seen, which
    // can happen mid-recording while streaming keeps going on committed
    // text alone (see the ``error`` case above) — treating that as an
    // authoritative empty transcript would blank the preview out from
    // under an active recording. stopLive draws the same line via the
    // same predicate for what it delivers.
    const sessionEnvelope = liveFinalSlots.get(activeUiSessionToken)?.envelope || null;
    const resolvedEnvelopeText = envelopeMissing(sessionEnvelope) ? null : (sessionEnvelope?.text ?? null);
    const candidate = getVisibleLivePreviewText();
    const text = resolvedEnvelopeText !== null
      ? composeLivePreviewText(candidate, resolvedEnvelopeText)
      : richerTranscript(livePreviewFloorText, candidate);
    livePreviewFloorText = text;
    if (el.textContent !== text) {
      el.textContent = text;
      el.scrollTop = el.scrollHeight;
    }
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    window.setTimeout(run, 16);
  }
}

function syncLiveOutputFromState(): void {
  scheduleLiveOutputRender();
}

function resetLiveDraftState(): void {
  livePreviewFloorText = "";
  liveDraftText = "";
  liveDraftDisplayText = "";
  liveInterimText = "";
  liveTranscriptSegments = [];
  syncLiveOutputFromState();
}

function setLiveDraftState(text: string, displayText = text): void {
  liveDraftText = normalizeTranscriptWhitespace(text);
  liveDraftDisplayText = String(displayText || "").trim();
  syncLiveOutputFromState();
}

// The authoritative committed/interim state lives in LiveTranscriptBuffer
// per session; ``liveDraftText``/``liveInterimText`` above are only the
// currently active UI projection kept for the existing renderer and
// main-process read paths.

/**
 * The stop deadline the backend announced for the current session.
 *
 * PROTOCOL CONTRACT C3 (BUGS_AUDIT_2026-09-03 §2.1). Set from the
 * ``finalizing`` message, which arrives the moment the backend picks its
 * flush budget and BEFORE it starts waiting — but "before it starts
 * waiting" on the backend's clock, not the renderer's: the message
 * still has to cross the WS and land median +126ms (p90 +186ms) after
 * the fast path enters. A plain ``Map`` read once, synchronously, at
 * the moment the wait's deadline was chosen could never see a message
 * that showed up later — 312 of 479 measured stops picked a budget the
 * backend had already told them was wrong, and 65% of stops overall
 * never benefited from the announcement at all.
 *
 * This is now a slot per session — same shape as ``liveFinalSlots`` —
 * with a value AND waiters, so a wait that is already in progress when
 * the announcement lands gets notified and can recompute its deadline
 * instead of having already given up. Keyed by session token so a late
 * message from a superseded recording cannot move the next one's
 * deadline (R5).
 */
interface FinalizeBudgetSlot {
  value: FinalizeBudgetAnnouncement | null;
  waiters: Array<(value: FinalizeBudgetAnnouncement) => void>;
}
const finalizeBudgetSlots = new Map<string, FinalizeBudgetSlot>();

function ensureFinalizeBudgetSlot(token: string): FinalizeBudgetSlot {
  let slot = finalizeBudgetSlots.get(token);
  if (!slot) {
    slot = { value: null, waiters: [] };
    finalizeBudgetSlots.set(token, slot);
  }
  return slot;
}

/** Resolved by the ``finalizing`` WS handler; read by ``waitForLiveEnvelopeWithAnnouncedBudget``. */
function announceFinalizeBudget(token: string, value: FinalizeBudgetAnnouncement): void {
  if (!token) return;
  const slot = ensureFinalizeBudgetSlot(token);
  slot.value = value;
  const waiters = slot.waiters;
  slot.waiters = [];
  for (const waiter of waiters) {
    try {
      waiter(value);
    } catch (e) {
      console.warn("finalize budget waiter threw", e);
    }
  }
}

/**
 * Confirmation window when the backend expects its wait to add nothing.
 *
 * Sized from the round trips that DO arrive: p50 550 ms on 2026-08-25.
 * Waiting longer than this for a message the producer says is not coming
 * is pure latency, which is what the "stop takes 5-7 seconds" complaint
 * was made of. Also the deadline in effect before any announcement has
 * arrived — see ``computeEnvelopeDeadlineMs``.
 */
const LIVE_ENVELOPE_CONFIRM_MS = 1_500;

/** Delivery slack on top of the announced budget: one WS hop plus the backend's own close. */
const LIVE_ENVELOPE_DELIVERY_MARGIN_MS = 800;

/**
 * Hard ceiling regardless of what was announced.
 *
 * A stop must end. This bounds a backend that announces something
 * unreasonable, and it is above the worst finalize measured (9.4 s) by
 * enough to cover it while still terminating.
 */
const LIVE_ENVELOPE_MAX_WAIT_MS = 11_000;

/**
 * PROTOCOL CONTRACT C3: race the final envelope against the backend's
 * ``finalizing`` announcement (which may arrive after this wait has
 * already started) and a confirm timer, instead of freezing a deadline
 * before the announcement can possibly have landed.
 *
 * The deadline decision itself is the pure, unit-tested
 * ``computeEnvelopeDeadlineMs`` (frontend/src/envelope-deadline.ts) —
 * this function is only the plumbing that arms/re-arms a timer against
 * that decision and resolves as soon as either the envelope or the
 * timer fires, whichever is first.
 */
function waitForLiveEnvelopeWithAnnouncedBudget(token: string): Promise<LiveFinalEnvelope | null> {
  const tEnv = performance.now();
  const deadlineConfig = {
    confirmMs: LIVE_ENVELOPE_CONFIRM_MS,
    marginMs: LIVE_ENVELOPE_DELIVERY_MARGIN_MS,
    maxWaitMs: LIVE_ENVELOPE_MAX_WAIT_MS,
  };
  return new Promise((resolve) => {
    let settled = false;
    let timerId: number | null = null;

    const finish = (envelope: LiveFinalEnvelope | null): void => {
      if (settled) return;
      settled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      resolve(envelope);
    };
    const armTimer = (deadlineMs: number): void => {
      if (timerId !== null) window.clearTimeout(timerId);
      const remaining = Math.max(0, deadlineMs - (performance.now() - tEnv));
      timerId = window.setTimeout(() => finish(envSlot.envelope), remaining);
    };

    const envSlot = ensureLiveFinalSlot(token);
    if (envSlot.envelope) {
      finish(envSlot.envelope);
      return;
    }
    envSlot.waiters.push(finish);

    const budgetSlot = ensureFinalizeBudgetSlot(token);
    const applyAnnouncement = (announcement: FinalizeBudgetAnnouncement): void => {
      if (settled) return;
      const deadlineMs = computeEnvelopeDeadlineMs(announcement, deadlineConfig);
      console.log(
        `[trace stopLive] backend announced finalize budget=${announcement.budgetMs}ms ` +
        `expectsMore=${announcement.expectsMore ? 1 : 0} newDeadline=${deadlineMs.toFixed(0)}ms ` +
        `elapsed=${(performance.now() - tEnv).toFixed(0)}ms`,
      );
      armTimer(deadlineMs);
    };
    if (budgetSlot.value) {
      applyAnnouncement(budgetSlot.value);
    } else {
      budgetSlot.waiters.push(applyAnnouncement);
      armTimer(LIVE_ENVELOPE_CONFIRM_MS);
    }
  });
}

function resetOutputs(): void {
  resetRecordSessionNotice();
  setCurrentRecordingSummary(null);
  resetLiveDraftState();
  publishRecordingOutput({ recordingId: 0, pasteText: "", domText: "", kind: "" });
  $("upscaleOutput").textContent = "";
  // Reset the placeholder-ownership nonce so any still-in-flight
  // upscale from a prior session sees "not my placeholder anymore"
  // and declines to clobber the freshly-cleared DOM.
  ($("upscaleOutput") as HTMLElement).dataset.upscaleNonce = "";
  $("transcribeLatency").textContent = "--";
  $("upscaleLatency").textContent = "--";
  liveTimerText = "00:00";
  $("progressRow").hidden = true;
  // ``#downloadRow`` was removed from the markup: it was hidden here on
  // every boot and never shown again, and its two <a href="#"> links had
  // neither a click handler nor a CSS rule, so "Exports TXT / JSON"
  // advertised a feature that did not exist and scrolled the pane when
  // clicked. Export lives in History, on a recording that has been saved.
  $("progressFill").style.width = "0%";
  $("progressText").textContent = "0%";
  // Clear stale audio from the previous recording so the user
  // never sees a 3-second "ghost" audio player while a new 52-second
  // recording is in progress. The new session's audio will be
  // rendered after stopLive persists it.
  setCurrentRecordingAudio(null);
}

// EMA (exponential moving average) smoothing factor for
// ``__transcriptorRmsLevel``. The main-process silence detector polls
// this value every 120 ms, while the worklet posts batched capture
// chunks roughly every 40-50 ms on common 44.1/48 kHz devices.
// Without smoothing, the monitor samples ONE instantaneous window and
// can catch a micro-pause between syllables (natural in conversational speech) as
// "silence", accumulate 2 s of intermittent dips, and trigger a
// false auto-stop WHILE THE USER IS STILL SPEAKING. An EMA with
// alpha ~0.06 gives a ~45-frame smoothing window (~120 ms) that
// tracks speech energy faithfully but rides through inter-word
// gaps without dropping to zero.
let captureRmsEma = 0;
const CAPTURE_RMS_EMA_ALPHA = 0.06;

/**
 * Take one frame of captured audio.
 *
 * ``preRollMs`` is non-zero only for the single frame the worklet's ring
 * hands over at a warm start, and it says how much of the audio in that
 * frame was captured BEFORE this frame was delivered. It exists so the
 * recording's clock can be set from the audio rather than from the
 * delivery: ``startAt`` is the moment the first sample was taken, which
 * on a warm start is half a second before the hotkey.
 */
function pushCapturedFrame(input: Float32Array, preRollMs = 0): void {
  if (!(input instanceof Float32Array) || !input.length) return;
  workletLastFrameAt = Date.now();
  if (startAt <= 0) {
    // The one place the recording's clock is set, for both paths.
    startAt = workletLastFrameAt - Math.max(0, Math.round(preRollMs));
  }
  if (!startFirstFrameSeen && startT0 > 0) {
    // First audio of the session. Everything before this is start-up
    // cost the user experiences as the capsule not doing anything yet.
    markStartPhase("first-frame");
    startFirstFrameSeen = true;
    const totalMs = performance.now() - startT0;
    const labels = startTimings
      .map(([label, t], i) => {
        const prev = i > 0 ? startTimings[i - 1][1] : 0;
        return `${label}: ${(t - prev).toFixed(0)}ms`;
      })
      .join(" → ");
    console.log(
      `[trace startLive] total=${totalMs.toFixed(0)}ms to first audio frame ` +
      `warm=${sessionStartedWarm ? 1 : 0} preRollMs=${sessionPreRollMs.toFixed(0)} | ${labels}`,
    );
    (window as unknown as { __transcriptorStartTimings?: unknown }).__transcriptorStartTimings = {
      totalMs,
      phases: startTimings,
    };
  }
  window.__transcriptorLastFrameAt = workletLastFrameAt;
  // The pre-roll frame is half a second of audio delivered in one go and
  // says nothing about how much the capture node can be holding back —
  // which is the only question this measurement answers (see
  // ``waitForCaptureDrain``). Only live frames define the period.
  if (!preRollMs && ac && ac.sampleRate > 0) {
    captureBufferPeriodMs = (input.length / ac.sampleRate) * 1000;
  }
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    sum += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / input.length);
  // Updates the session's measured level in place — every "speech or
  // silence?" question the capture path asks is answered against it
  // (./audio-levels). The per-frame verdict itself has no reader: the
  // stop path used to keep the last speech-carrying sample offset for
  // its tail-gap arithmetic, and that arithmetic is the backend's now.
  observeCaptureFrame(captureLevel, rms, peak);
  // Smooth RMS via EMA so the main-process silence detector sees the
  // energy trend over ~120 ms, not a single 2.67 ms micro-window
  // that might happen to land on an inter-syllable gap.
  captureRmsEma = CAPTURE_RMS_EMA_ALPHA * rms + (1 - CAPTURE_RMS_EMA_ALPHA) * captureRmsEma;
  // CRITICAL: set __transcriptorRmsLevel here too, not just in setVU.
  // Electron main reads this for silence detection.
  // setVU runs in rAF which stalls when the window is hidden.
  window.__transcriptorRmsLevel = Math.max(0, Number.isFinite(captureRmsEma) ? captureRmsEma : 0);
  window.__transcriptorVuLevel = Math.max(0, Math.min(1, rms * UI_TOKENS.capture.vuAmplify));
  if (!ac) return;
  const ds = downsample(input, ac.sampleRate, LIVE_SAMPLE_RATE_HZ);

  // ── Canonical-audio sink path ──────────────────────────────────────
  // Samples go into the session's ``PcmSink``. The OPFS-backed
  // variant spools them to disk as they arrive so the JS heap is
  // never holding more than a few milliseconds of pending audio.
  // The memory-backed fallback (OPFS unavailable) keeps Int16Array
  // chunks — still half the footprint of the old Float32Array
  // accumulator. Either way the old ``chunks: Float32Array[]``
  // consolidation / 2h rotating-window dance is gone — the sink is
  // bounded by definition.
  if (pcmSink) {
    pcmSink.append(ds);
  }

  // ── Live WebSocket path ───────────────────────────────────────────
  // Independent of the canonical sink: the PCM16 bytes are streamed
  // to the backend /ws/transcribe in real time when a transcription
  // transport exists for this session.
  //
  // IMPORTANT: if the WS is still CONNECTING (not yet OPEN), buffer
  // the frame and flush the buffer once the socket opens. This fixes
  // word loss at the START of a recording — the AudioWorklet starts
  // producing frames immediately on mic connect, but the WS handshake
  // can take 50-300 ms. Without buffering those early frames were
  // silently dropped and Deepgram never heard the first syllables.
  const pcm = new ArrayBuffer(ds.length * 2);
  const dv = new DataView(pcm);
  for (let i = 0; i < ds.length; i++) {
    const x = Math.max(-1, Math.min(1, ds[i]));
    // Math.round: setInt16 truncates toward zero on a raw float
    // multiply, producing a ~0.5 LSB systematic negative bias on
    // positive samples. Must match encodeWav and floatSamplesToInt16LE
    // so the live-WS PCM stream and the canonical WAV written at
    // stop contain bit-identical samples for the same input.
    dv.setInt16(i * 2, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
  }
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    // Buffered frames go first so FIFO order is preserved.
    flushPendingWsFrames(ws);
    try {
      ws.send(pcm);
      recordWsFrameSent(pcm.byteLength);
    } catch (e) {
      // The socket transitioned to CLOSING between the readyState read
      // and the native send call. This audio is in the canonical sink
      // but never reached the live transport, so the session can no
      // longer claim complete coverage.
      console.debug("live ws send skipped", e);
      wsFramesNeverSent += 1;
    }
  } else if (ws.readyState === WebSocket.CONNECTING) {
    // Buffer up to 4 seconds of audio, measured in OUTPUT SAMPLES
    // (BUG-59): the old 500-frame cap actually held ~1.3 s because each
    // worklet frame downsamples to ~42.7 samples at 16 kHz, so slow
    // handshakes silently dropped opening words and failed the
    // coverage contract.
    if (wsPendingFrameSamples + ds.length <= WS_PENDING_MAX_SAMPLES) {
      wsPendingFrames.push(pcm);
      wsPendingFrameSamples += ds.length;
    } else {
      wsFramesNeverSent += 1;
    }
  } else {
    // CLOSING / CLOSED. The recording is ending, but the audio still
    // existed, so it counts against coverage rather than vanishing
    // without a trace.
    wsFramesNeverSent += 1;
  }
}

/**
 * Drain the capture worklet's pending frames.
 *
 * Returns true when the worklet ACKNOWLEDGED the flush. That
 * acknowledgement is a complete delivery barrier, not a hint: the
 * processor runs `flushPending()` and posts `flush-ack` in the same
 * handler, and a MessagePort preserves order — so every PCM message
 * posted before the ack has already been handed to this thread.
 *
 * False means there is no worklet (the ScriptProcessor fallback) or the
 * ack never came, and the caller has no barrier from here.
 */
async function flushWorkletPort(timeoutMs = 350): Promise<boolean> {
  const node = workletNode;
  if (!node) return false;
  const token = `flush-${Date.now()}-${++flushRequestSeq}`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timerId: number | null = null;
    const finish = (acked: boolean): void => {
      if (settled) return;
      settled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      pendingWorkletFlushes.delete(token);
      resolve(acked);
    };
    pendingWorkletFlushes.set(token, () => finish(true));
    timerId = window.setTimeout(() => finish(false), timeoutMs);
    try {
      node.port.postMessage({ type: "flush", token });
    } catch (e) {
      console.debug("flushWorkletPort: postMessage failed", e);
      finish(false);
    }
  });
}

function micErrorTag(e: unknown): string {
  const err = e as { name?: unknown; message?: unknown };
  const name = String(err?.name || "").trim();
  const msg = String(err?.message || "").trim();
  return [name, msg].filter(Boolean).join(": ");
}

async function startLive(): Promise<void> {
  // Single-flight guard. isBusy is only set AFTER the first await below
  // (ensureRecordingsArchiveReady), which means two concurrent startLive
  // calls — e.g. rapid hotkey double-press, hotkey + button click — could
  // both pass the isBusy check and race to allocate two PcmSinks, two
  // WebSockets, and two MediaRecorders. The second start would overwrite
  // the first pcmSink without destroying it, leaking the OPFS file handle
  // and leaving the old sink orphaned in the OPFS quota.
  // Set the in-flight flag synchronously BEFORE any await.
  if (isBusy || stopTransitionInFlight || startLiveInFlight) return;
  startLiveInFlight = true;
  // The request clock (§4.9). Set before anything can await, so it is
  // the moment the renderer received the toggle, not the moment the
  // microphone answered.
  startRequestedAt = Date.now();
  startT0 = performance.now();
  startTimings = [];
  startFirstFrameSeen = false;
  const startAttemptSeq = ++liveStartAttemptSeq;
  try {
  let sessionArchiveDir = "";
  try {
    sessionArchiveDir = await ensureRecordingsArchiveReady();
    markStartPhase("archiveReady");
  } catch (e) {
    const message = (e as Error).message || "Recordings archive is not ready yet.";
    publishRecordingOutput({
      recordingId: 0,
      pasteText: "",
      domText: message,
      kind: "error",
    });
    patchCurrentRecordingSummary({ status: message, tone: "error" });
    return;
  }
  liveStartAbortReason = "";
  const throwIfStartCancelled = (): void => {
    if (startAttemptSeq === liveStartAttemptSeq) return;
    throw new DOMException("Recording start was cancelled.", "AbortError");
  };
  const sessionUiToken = createClientSessionId();
  activeUiSessionToken = sessionUiToken;
  activeLiveSessionId = sessionUiToken;
  activeLiveArchiveDir = sessionArchiveDir;
  resetOutputs();
  const selectedProvider = readProviderSelection();
  const selectedEffectiveProvider = resolveEffectiveProvider(selectedProvider);
  const sessionLocalModels = resolveSessionLocalModels(selectedProvider);
  const selectedModel =
    !selectedEffectiveProvider
      ? ""
      : selectedEffectiveProvider === "local"
        ? sessionLocalModels.finalLocalModel
        : getRemoteModelValue(selectedEffectiveProvider);
  const selectedLanguage = (($("language") as HTMLSelectElement).value || "auto").trim();
  const sessionTitle = "Recording " + new Date().toLocaleString();
  activeLiveSessionSnapshot = {
    provider: selectedProvider,
    effectiveProvider: selectedEffectiveProvider,
    model: selectedModel,
    language: selectedLanguage,
    diarize: readDiarizeEnabled(),
    assistLocalModel: sessionLocalModels.assistLocalModel,
    finalLocalModel: sessionLocalModels.finalLocalModel,
  };
  setCurrentRecordingSummary({
    title: sessionTitle,
    status: "Preparing microphone capture and session buffers.",
    tone: "info",
  }, sessionUiToken);
  // Tear down any previous sink BEFORE allocating the new one. If
  // startLive was called twice without a clean stopLive in between
  // (e.g. after a start-path error), the old sink is destroyed here.
  if (pcmSink) {
    const prior = pcmSink;
    pcmSink = null;
    void prior.destroy();
  }
  // Await the sink so it is ready BEFORE the first audio frame. The
  // old fire-and-forget path dropped frames that arrived before the
  // async OPFS init resolved (~50 ms, but up to 500 ms on slow devices).
  pcmSink = await createPcmSink(sessionUiToken);
  markStartPhase("pcmSink");
  workletLastFrameAt = 0;
  captureLevel = createCaptureLevel();
  captureRmsEma = 0;
  // The resampler carries <1 output-sample of the PREVIOUS session's
  // audio; clear it so a new recording never starts with a stale frame.
  resetDownsampleState();

  wsPendingFrames = [];
  wsPendingFrameSamples = 0;
  wsFramesNeverSent = 0;
  wsFramesSent = 0;
  wsBytesSent = 0;
  resetLiveDraftState();
  clearLiveStreamState();
  liveWsMode = resolveLiveWsMode(activeLiveSessionSnapshot);
  const sessionWsMode = liveWsMode;
  liveTranscriptBuffers.set(sessionUiToken, createLiveTranscriptBuffer(sessionWsMode));
  setBusy(true, sessionUiToken);
  currentRecordingId = ++liveRecordingSeq;
  // Recording started — transcription happens on stop via single sync call.
  window.__transcriptorIsRecording = true;
  window.__transcriptorLastFrameAt = Date.now();
  // Atomically clear every main-process-observable global BEFORE setting
  // the new currentRecordingId, so Electron main can never observe
  // "new currentRecordingId + old paste-ready text" in a transient
  // race during startLive.
  clearRecordingFinalSignal();
  window.__transcriptorCurrentRecordingId = currentRecordingId;
  setRecordButton(true);
  setStatusScoped(sessionUiToken, "Starting");
  window.__transcriptorVuLevel = 0;
  window.__transcriptorRmsLevel = 0;
  window.__transcriptorLastFrameAt = 0;

  startAt = 0;
  persistLiveDraft(true);
  if (draftSaveTimer) {
    clearInterval(draftSaveTimer);
    draftSaveTimer = null;
  }
  draftSaveTimer = window.setInterval(() => persistLiveDraft(true), UI_TOKENS.draft.autosaveIntervalMs);
  timer = window.setInterval(() => {
    const durationSec = startAt > 0 ? (Date.now() - startAt) / 1000 : 0;
    if (isCurrentUiSession(sessionUiToken)) {
      liveTimerText = fmtTime(durationSec);
    }
    // Repaint the live pane each tick so the preview-off recording
    // status line ("● Recording 0:42 — …") tracks the same clock.
    // rAF-coalesced and diff-checked inside the render; with preview
    // on this is a no-op unless transcript state changed.
    syncLiveOutputFromState();
  }, UI_TOKENS.timer.tickMs);

  const enableVisibleLivePreview = sessionWsMode !== "none" && shouldLivePreview();
  if (sessionWsMode === "none") {
    patchCurrentRecordingSummary({
      status: "Recording audio only. No transcription provider is selected.",
      tone: "info",
    }, sessionUiToken);
  } else {
    const wsQuery = new URLSearchParams({
      provider: sessionWsMode === "deepgram-stream" ? "deepgram" : "local",
      language: activeLiveSessionSnapshot.language,
      session_id: activeLiveSessionId,
      archive_dir: activeLiveArchiveDir,
      recording_collection: RECORDING_COLLECTIONS.live,
      diarize: readDiarizeEnabled() ? "true" : "false",
    });
    if (sessionWsMode === "deepgram-stream") {
      wsQuery.set("model", activeLiveSessionSnapshot.model || getRemoteModelValue("deepgram"));
    } else {
      wsQuery.set("model", activeLiveSessionSnapshot.assistLocalModel);
    }
    const sessionSocket = new WebSocket(wsBase() + "/ws/transcribe?" + wsQuery.toString(), websocketAuthProtocols());
    markStartPhase("wsRequested");
    ws = sessionSocket;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      // Drain whatever was captured during the handshake. Without this
      // the flush depended on another frame arriving afterwards, so a
      // recording that ended inside the handshake window streamed a
      // transcript missing its opening words.
      //
      // Bound to ``sessionSocket`` rather than the module-level ``ws``:
      // a late ``open`` from a superseded socket must not push this
      // session's buffered audio into the socket of the next one.
      if (activeUiSessionToken === sessionUiToken) {
        flushPendingWsFrames(sessionSocket);
      }
      const statusMsg =
        sessionWsMode === "deepgram-stream"
          ? enableVisibleLivePreview
            ? "Recording. Deepgram live streaming is active."
            : "Recording. Deepgram live stream is committing segments in the background."
          : enableVisibleLivePreview
            ? selectedEffectiveProvider === "local"
              ? "Recording with live preview enabled."
              : "Recording with live preview enabled. Local assist is canonical for fast stop."
            : "Recording. Background local assist is active for fast stop finalization.";
      patchCurrentRecordingSummary({ status: statusMsg, tone: "info" }, sessionUiToken);
    };
    ws.onerror = (ev) => {
      // Scope the log to this session token so a stale socket from a
      // prior recording can't confuse the developer into thinking the
      // current session is broken. No state mutation — actual error
      // surfacing happens through the higher-level 'error' message
      // path from the backend or the onclose handler below.
      console.warn(`live ws transport error [session=${sessionUiToken.slice(0, 8)}]`, ev);
    };
    ws.onclose = (ev) => {
      // A clean close (1000/1005) after finalize is expected. An unclean
      // close before finalize means the stream died; release any pending
      // waiters for THIS session with a synthetic error envelope so
      // stopLive doesn't hang on waitForLiveFinalEnvelope.
      const slot = liveFinalSlots.get(sessionUiToken);
      if (!slot) return;
      if (slot.envelope) return;
      // No ``waiters.length === 0`` bail-out. stopLive now arms its
      // waiter lazily (see below), so at the moment of an unclean close
      // there is often nobody waiting yet — and dropping the synthetic
      // error envelope here meant the later waiter had nothing to
      // resolve against and burned its whole timeout. Recording the
      // envelope in the slot is safe either way: ``resolveLiveFinal``
      // is a no-op once ``slot.envelope`` is set, and the real ``final``
      // message always arrives before ``onclose``.
      console.log(`[trace ws-close] code=${ev.code} reason="${ev.reason || ""}" wasClean=${ev.wasClean} hadEnvelope=${!!slot.envelope} waiters=${slot.waiters.length}`);
      if (ev.wasClean && (ev.code === 1000 || ev.code === 1005)) return;
      console.warn(`live ws unexpectedly closed (code=${ev.code}, reason=${ev.reason || "?"})`);
      resolveLiveFinal(sessionUiToken, {
        text: "",
        segments: [],
        durationSec: 0,
        source: sessionWsMode,
        error: `live stream closed unexpectedly (code=${ev.code})`,
      });
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      const msg = parseLiveWsMessage(ev.data);
      if (!msg) return;
      const isActiveSession = activeUiSessionToken === sessionUiToken;
      const sessionBuffer = ensureLiveTranscriptBuffer(sessionUiToken, sessionWsMode);
      switch (msg.type) {
        case "error": {
          setLiveStreamError(sessionUiToken, msg.error);
          console.warn(`live ws error event (fatal=${msg.fatal}):`, msg.error);
          // Only surface truly fatal errors to the user. Non-fatal
          // stream drops (when we already have committed segments) are
          // logged to the console but invisible in the pill — the
          // recording keeps going, just not streaming to Deepgram
          // anymore. stopLive picks up the committed text as the
          // transcript so the user experience is seamless.
          if (isActiveSession && msg.fatal) {
            patchCurrentRecordingSummary(
              {
                status: `Live stream error: ${explainNetworkError(new Error(msg.error))}`,
                tone: "error",
              },
              sessionUiToken
            );
            // DO NOT pipe the error message through setLiveInterimText:
            // that path feeds into `sourceLiveText` at stopLive time,
            // which then becomes the saved transcript + the clipboard-
            // paste content. A user in a region that blocks Deepgram
            // would otherwise see a raw "[Deepgram connect failed: did
            // not receive a valid HTTP response]" pasted into Slack /
            // Telegram / wherever. The status pill carries the error;
            // transcript stays empty so the paste code path treats it
            // as "nothing to paste".
          }
          return;
        }
        case "segments": {
          const lastNew = msg.segments.length > 0 ? msg.segments[msg.segments.length - 1] : null;
          console.log(`[trace ws-segments] session=${sessionUiToken.slice(0, 8)} active=${isActiveSession} count=${msg.segments.length} ${lastNew ? `lastEnd=${lastNew.end.toFixed(2)} ${traceTextStats("lastText", lastNew.text)}` : "(empty)"}`);
          appendSegmentsToBuffer(sessionBuffer, msg.segments);
          if (isActiveSession) {
            // No draft write here. Deepgram commits segments several
            // times a second and this handler runs on the main thread —
            // the same thread the ScriptProcessor fallback captures on,
            // where a full text composition plus an IPC write per commit
            // is exactly what drops audio (BUGS_AUDIT_2026-09-03 §4.5).
            // The 1.2 s autosave interval started in startLive already
            // persists the same text from the same buffer.
            projectLiveTranscriptBufferToActiveState(sessionBuffer);
          }
          return;
        }
        case "finalizing": {
          // C3: resolves the per-session slot (value + waiters) so an
          // envelope wait already in progress can recompute its deadline
          // instead of only being readable by a wait that starts later.
          announceFinalizeBudget(sessionUiToken, {
            budgetMs: msg.budgetMs,
            expectsMore: msg.expectsMore,
          });
          console.log(
            `[trace stopLive] backend announced finalize budget=${msg.budgetMs}ms expectsMore=${msg.expectsMore ? 1 : 0}`,
          );
          return;
        }
        case "interim": {
          sessionBuffer.interimText = normalizeTranscriptWhitespace(msg.segment.text);
          sessionBuffer.interimSegment = msg.segment;
          if (isActiveSession) {
            projectLiveTranscriptBufferToActiveState(sessionBuffer);
          }
          return;
        }
        case "final": {
          const lastSeg = msg.segments.length > 0 ? msg.segments[msg.segments.length - 1] : null;
          console.log(`[trace ws-final] session=${sessionUiToken.slice(0, 8)} active=${isActiveSession} textLen=${msg.text.length} segCount=${msg.segments.length} ${lastSeg ? `lastEnd=${lastSeg.end.toFixed(2)} ${traceTextStats("lastText", lastSeg.text)}` : "(empty)"} durationSec=${msg.durationSec.toFixed(2)} error="${msg.error || ""}"`);
          appendSegmentsToBuffer(sessionBuffer, msg.segments);
          if (isActiveSession) {
            projectLiveTranscriptBufferToActiveState(sessionBuffer);
          }
          const envelope: LiveFinalEnvelope = {
            text: normalizeTranscriptWhitespace(msg.text),
            segments: msg.segments,
            durationSec: msg.durationSec,
            source: msg.source || sessionWsMode,
          };
          if (msg.error) envelope.error = msg.error;
          if (msg.coverage) envelope.coverage = msg.coverage;
          // BUG-20 / PROTOCOL CONTRACT C5. Carried onto the envelope as
          // diagnostics: the backend closes its own coverage gaps before
          // it sends (``stats.recovery``), so these numbers explain a
          // stop in the log rather than steering it. A renderer that
          // escalated on them would be re-decoding audio the envelope
          // already accounts for.
          if (typeof msg.uncoveredSpeechSec === "number" && msg.uncoveredSpeechSec > 0) {
            envelope.uncoveredSpeechSec = msg.uncoveredSpeechSec;
          }
          if (typeof msg.streamedSec === "number") envelope.streamedSec = msg.streamedSec;
          if (typeof msg.coveredEndSec === "number") envelope.coveredEndSec = msg.coveredEndSec;
          if (msg.stats) envelope.stats = msg.stats;
          resolveLiveFinal(sessionUiToken, envelope);
          return;
        }
      }
    };
  }

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone capture.");
    }
    const selectedDeviceId = (($("micSelect") as HTMLSelectElement).value || "").trim();
    // The graph the previous recording left running, if it is still the
    // right one (§4.7). Adopting it skips getUserMedia, the AudioContext
    // and the worklet module — the whole ~310 ms — and its ring has been
    // holding the last half-second of audio the entire time.
    const warm = takeWarmCapture(selectedDeviceId);
    sessionStartedWarm = !!warm;
    sessionPreRollMs = 0;
    if (warm) {
      ac = warm.ac;
      stream = warm.stream;
      src = warm.src;
      workletNode = warm.workletNode;
      markStartPhase("warmCapture");
    } else {
      // Do not force a preflight getUserMedia here. startLive is about
      // to request the actual recording stream below; opening a second
      // throwaway stream first causes duplicate macOS media permission /
      // activation events and can make every recording look like it is
      // asking for access twice.
      await loadMics(false);
      markStartPhase("loadMics");
      throwIfStartCancelled();
      // Re-read rather than reuse ``selectedDeviceId``: ``loadMics``
      // repopulates the picker and can change its value (a device that
      // disappeared, a default that resolved), and the request has to
      // carry what the picker says NOW. The warm check above necessarily
      // runs before that, on what the picker said before.
      const devId = (($("micSelect") as HTMLSelectElement).value || "").trim();
      // Bounded and retried — see acquireMicStream. The old code awaited a
      // bare getUserMedia, so a busy input device hung the start outright.
      stream = await acquireMicStream(devId);
      markStartPhase("getUserMedia");
      throwIfStartCancelled();
    }
    if (!stream || !stream.getAudioTracks().some((t) => t.readyState === "live")) {
      throw new Error("Microphone stream is not live");
    }
    // Permission is now granted and the real capture stream is live.
    // Refresh labels/device ids without another permission request.
    // Skipped on the warm path: the device list is already loaded, and
    // the point of that path is to touch no device APIs at all.
    if (!warm) void loadMics(false);
    // Reset the mic-health tracker for this session so the previous
    // session's terminal state does not leak into the new run.
    micHealth.reset();
    const initialTracks = stream.getAudioTracks();
    const initialDeviceId = initialTracks[0]?.getSettings?.()?.deviceId || "";
    micHealth.observe({ kind: "session-start", deviceId: initialDeviceId });
    if (initialTracks.some((t) => t.muted)) {
      micHealth.observe({ kind: "track-muted", muted: true });
    }
    // Device watchers — see ``attachMicTrackWatchers``. A warm start
    // finds them already installed on this stream and adds nothing.
    attachMicTrackWatchers(stream);
    if (!warm) {
      // Close whatever still occupies the slot before overwriting it.
      // Every teardown path is supposed to have emptied it already; this
      // is the structural guarantee that a path which did not cannot
      // strand a running AudioContext with no reference left to close it.
      await releaseOrphanedAudioContext("starting a new capture session");
      ac = new AudioContext();
    }
    // One non-null reference for the rest of the start path. The module
    // slot is reassigned by the teardown helpers, so narrowing it once
    // here is what lets every node below be built against a context that
    // provably exists.
    const sessionAc = ac;
    if (!sessionAc) throw new Error("Audio capture context is unavailable.");
    if (sessionAc.state !== "running") {
      try {
        await sessionAc.resume();
      } catch (e) {
        console.debug("AudioContext resume rejected (non-fatal)", e);
      }
    }
    markStartPhase("audioContext");
    throwIfStartCancelled();
    recordedWebmChunks = [];
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      // MediaRecorder emits one chunk per second (see ``start(1000)``
      // below). The same 2h recording-window limit applies: if a
      // session grows beyond that, rotate out the oldest chunks so
      // we never end up holding tens of thousands of Blob references.
      // One chunk per second (see ``start(1000)`` below), so the shared
      // window in seconds is a chunk count here.
      const WEBM_WINDOW_CHUNKS = UI_TOKENS.capture.fallbackWindowSec;
      let webmTruncationWarned = false;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordedWebmChunks.push(e.data);
          if (recordedWebmChunks.length > WEBM_WINDOW_CHUNKS) {
            recordedWebmChunks.splice(0, recordedWebmChunks.length - WEBM_WINDOW_CHUNKS);
            if (!webmTruncationWarned) {
              webmTruncationWarned = true;
              // Surface ONCE per session — subsequent truncations are
              // expected and don't need to spam the user. PCM canonical
              // audio (the OPFS spool) is unaffected; only the WebM
              // fallback container is rolling-windowed.
              showRecordSessionNotice(
                "Recording exceeds 2 hours — the WebM fallback keeps only the last 2 h. Canonical PCM audio is unaffected.",
                "warning",
                9000
              );
            }
          }
        }
      };
      mediaRecorder.start(1000);
      markStartPhase("mediaRecorder");
    } catch (e) {
      console.warn("MediaRecorder failed, falling back to WAV encoder", e);
      // If ``.start(1000)`` threw AFTER the constructor succeeded we
      // have a half-initialised MediaRecorder sitting on the module
      // global. Null it so stopMediaRecorderAndFlush doesn't try to
      // stop an object in a bad state (which would throw again and
      // leave the recorder's state machine corrupted). The WebM path
      // simply falls back to the PCM sink for canonical audio.
      if (mediaRecorder) {
        try {
          mediaRecorder.ondataavailable = null;
        } catch { /* property setter unavailable on a broken recorder */ }
        mediaRecorder = null;
      }
    }
    // The source node is part of the held graph and is NOT rebuilt on a
    // warm start: a second MediaStreamAudioSourceNode over the same
    // stream would be a second tap on the same device for no gain.
    if (!src) src = sessionAc.createMediaStreamSource(stream);
    const sessionSrc = src;
    analyser = sessionAc.createAnalyser();
    analyser.fftSize = 2048;
    sessionSrc.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    // Use setInterval instead of requestAnimationFrame.
    // rAF throttles to ~0 fps when the Electron window is hidden. setInterval
    // keeps firing reliably for the main-process recording monitor.
    // Promoted to module scope so stopLive can clear it deterministically.
    // Previously local → leaked after stopLive because analyser null-check
    // self-cleanup was best-effort and delayed by up to one tick.
    if (vuIntervalId) { clearInterval(vuIntervalId); vuIntervalId = null; }
    const tick = (): void => {
      if (!analyser) {
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const s = buf[i];
        sum += s * s;
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / buf.length);
      setVU(rms);
      // Single time-advance path for the health FSM: every sample carries
      // its own timestamp, so the dwell timers never double-count.
      micHealth.observe({ kind: "rms", rms, peak });
      // The failsafe below only exists to catch a session that never
      // reaches a verdict (no ticks at all, or a stuck probe). Once the
      // FSM has left "probing" it has decided, so disarm it.
      if (pipelineFailsafeId !== null && micHealth.get().state !== "probing") {
        clearTimeout(pipelineFailsafeId);
        pipelineFailsafeId = null;
      }
    };
    vuIntervalId = setInterval(tick, WAVE_METER_INTERVAL_MS);
    if (pipelineFailsafeId) { clearTimeout(pipelineFailsafeId); pipelineFailsafeId = null; }
    // Last-resort watchdog: fires only when the analyser loop never
    // produced a verdict at all (AudioContext never started, worklet
    // failed to load, interval starved). With a healthy loop the FSM
    // decides within PROBE_TIMEOUT_MS and this timer is disarmed above.
    // The status copy comes from the mic-health subscriber, so the
    // wording stays single-sourced.
    pipelineFailsafeId = setTimeout(() => {
      pipelineFailsafeId = null;
      if (!isRecording) return;
      if (micHealth.get().state !== "probing") return;
      patchCurrentRecordingSummary(
        { title: "Microphone is not delivering audio" },
        activeUiSessionToken,
      );
      micHealth.observe({ kind: "force-silent", reason: "pipeline-failsafe" });
    }, Math.max(2000, PIPELINE_FAILSAFE_MS));

    let workletCaptureStarted = false;
    if (workletNode) {
      // Warm start: this node has been connected to the source and
      // filling its pre-roll ring since the last Stop. Nothing is built
      // — the module is loaded, the node exists, the edge is live — so
      // the whole of the ~310 ms §4.7 measured is skipped. The ``start``
      // message hands the ring over (it arrives ahead of every live
      // frame, MessagePort order) and switches delivery back on.
      workletNode.port.onmessage = handleWorkletMessage;
      workletNode.port.postMessage({ type: "start" });
      markStartPhase("warmWorkletStart");
      workletCaptureStarted = true;
    } else if (sessionAc.audioWorklet && typeof AudioWorkletNode === "function") {
      try {
        await sessionAc.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url).href);
        markStartPhase("workletModule");
        throwIfStartCancelled();
        workletNode = new AudioWorkletNode(sessionAc, "pcm-capture-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        });
        // One handler for both paths (see ``handleWorkletMessage``): a
        // cold node delivers from construction and never sends a
        // pre-roll message, a warm one sends exactly one.
        workletNode.port.onmessage = handleWorkletMessage;
        sessionSrc.connect(workletNode);
        markStartPhase("captureConnected");
        workletCaptureStarted = true;
      } catch (e) {
        console.warn("AudioWorklet capture init failed; falling back to ScriptProcessor", e);
        detachWorkletCapture("AudioWorklet init failure");
      }
    }

    if (!workletCaptureStarted) {
      const fallbackStarted = startScriptProcessorCapture(
        sessionAc,
        sessionSrc,
        sessionAc.audioWorklet ? "AudioWorklet init failed" : "AudioWorklet API unavailable",
        false,
      );
      markStartPhase("scriptProcessorCapture");
      if (!fallbackStarted) {
        throw new Error("Microphone capture is unavailable in this browser runtime.");
      }
    } else if (UI_TOKENS.capture.preArmScriptProcessorFallback) {
      // The worklet is connected but has proved nothing yet. Connect the
      // fallback alongside it, held back: it captures from now — there
      // is no window in which nothing is capturing — and its own first
      // buffer decides which of the two is the capture path (§4.5).
      startScriptProcessorCapture(sessionAc, sessionSrc, "pre-armed alongside AudioWorklet", true);
      markStartPhase("scriptProcessorPreArmed");
    }

  } catch (e) {
    if (startAttemptSeq !== liveStartAttemptSeq) {
      await cleanupCancelledStartCaptureResources();
      return;
    }
    liveStartAbortReason = micErrorTag(e) || (e as Error).message || "Unable to start recording.";
    if (shouldLivePreview()) {
      setLiveDraftState("", liveStartAbortReason);
    }
    patchCurrentRecordingSummary({
      status: liveStartAbortReason,
      tone: "error",
    }, sessionUiToken);
    await stopLive(false);
  }
  } finally {
    startLiveInFlight = false;
  }
}

async function waitForCaptureDrain(
  framesAtStop: number,
  maxWaitMs = UI_TOKENS.drain.maxWaitMs,
): Promise<void> {
  const started = Date.now();
  // One buffer period is how long the capture node can be holding audio
  // it has not handed over yet; one delivered frame is the proof that
  // it has. Both are required: the frame alone could be one that was
  // already in flight when the track stopped, and the period alone
  // proves nothing about delivery.
  const periodEndsAt = started + Math.max(1, Math.ceil(captureBufferPeriodMs));
  while (Date.now() - started < maxWaitMs) {
    if (captureLevel.frames > framesAtStop && Date.now() >= periodEndsAt) return;
    await new Promise((r) => setTimeout(r, UI_TOKENS.drain.pollStepMs));
  }
}

async function stopLive(
  enhance: boolean,
  options: { discard?: boolean } = {},
): Promise<void> {
  // A press that lands within MIN_RECORDING_MS of the start is a
  // double-tap, not a recording. The teardown below still runs in full —
  // this only decides that nothing is produced from it.
  const discarding = !!options.discard;
  if (stopTransitionInFlight) return;
  if (!isRecording) {
    // A start that failed after ``new AudioContext()`` but before
    // ``setRecordButton(true)`` flipped ``isRecording`` still owns a
    // live AudioContext, MediaStream and (usually) an AudioWorklet.
    // ``startLive``'s catch funnels exactly that case through here, so
    // returning without releasing them leaked one AudioContext — and
    // with it a realtime AudioWorklet thread carrying its own V8
    // isolate — per failed attempt, for the rest of the app's life.
    // The helper is fully null-guarded, so the ordinary "stop pressed
    // while already idle" call stays a no-op.
    await cleanupCancelledStartCaptureResources();
    return;
  }
  liveStartAttemptSeq += 1;
  const stopTransitionToken = createClientSessionId();
  stopTransitionInFlight = true;
  stopTransitionOwnerToken = stopTransitionToken;
  // ``_wsToCloseAtEnd`` is hoisted to function scope so the outer
  // ``finally`` block can close the WS AFTER the entire transcribe
  // phase finishes (envelope wait, recovery race, save). The
  // teardown chain in the inner try-block assigns this variable
  // instead of calling ws.close() inline, which would race the
  // backend's post-CloseStream is_final emission and truncate the
  // tail.
  let _wsToCloseAtEnd: WebSocket | null = null;
  let tailHoldMs = 0;
  let stopTransitionReleased = false;
  let stoppedRecordingId = 0;
  let stoppedSessionToken = "";
  // Wrap the entire body in try/finally so the in-flight guard is ALWAYS
  // cleared, even if a pre-main-try await (flushWorkletPort / waitForWorklet
  // Drain / stopMediaRecorderAndFlush / pcmSink.finalize / selectCanonical
  // CapturedAudio) throws an uncaught exception before reaching the
  // existing try at the "Assemble the authoritative transcript" block.
  // Without this wrapper, any such throw would leave stopTransitionInFlight
  // = true forever, permanently blocking all future stopLive calls.
  try {
  const recordingId = currentRecordingId;
  stoppedRecordingId = recordingId;
  const liveSessionId = activeLiveSessionId;
  const sessionUiToken = liveSessionId;
  stoppedSessionToken = sessionUiToken;
  const releaseStopTransitionAfterCaptureDetach = (): void => {
    if (stopTransitionReleased) return;
    stopTransitionReleased = true;
    if (stopTransitionOwnerToken === stopTransitionToken) {
      stopTransitionInFlight = false;
      stopTransitionOwnerToken = "";
    }
  };
  /**
   * The one piece every "stop without a transcript" epilogue shares
   * (F/7): release the live draft, drop the busy flag, and let the next
   * capture start.
   *
   * F/7 found seven near-identical ~20-line epilogues below (discarded
   * take, aborted startup, silence, transcription skipped, no provider,
   * missing key, and the finalization-failed catch). This triplet —
   * ``clearLiveDraft``, ``setBusy(false)``, ``releaseStopTransition
   * AfterCaptureDetach`` — is the only part that is byte-for-byte
   * identical across all six of the early returns below (the seventh,
   * the finalization-failed catch, releases through the shared
   * ``finally`` it has with the success path instead, and is left
   * alone). Everything AROUND this triplet is not: whether
   * ``#progressRow`` is hidden, whether ``saveRecordingText`` runs first
   * or the summary patch does, and the exact status/tone text differ
   * per site in ways that are not safe to normalize without live-
   * recording verification this environment cannot perform — see the
   * backend-fix-journal "Швы" entry for the scoping decision. Extracting
   * only this order-independent, argument-independent triplet is a pure
   * mechanical de-duplication with no behaviour change.
   */
  const releaseStopEpilogueBookkeeping = (): void => {
    clearLiveDraft(sessionUiToken);
    setBusy(false, sessionUiToken);
    releaseStopTransitionAfterCaptureDetach();
  };
  // ── Trailing capture ────────────────────────────────────────────────
  // The microphone stays open a moment past the press so the last word
  // is complete in the audio. Everything below — the drain, the sink,
  // the finalize — then works on a recording that actually contains it.
  // Skipped for a discarded take: there is nothing to preserve.
  if (!discarding && stream) {
    const holdStarted = performance.now();
    await new Promise((resolve) => window.setTimeout(resolve, UI_TOKENS.capture.stopTailHoldMs));
    tailHoldMs = performance.now() - holdStarted;
  }
  const recordedMs = startAt > 0 ? Math.max(0, Date.now() - startAt) : 0;
  const recordedSec = recordedMs / 1000;
  // ── transcription-latency timer ───────────────────────────────────
  //
  // Captured at the TOP of stopLive — i.e. the moment after the user
  // pressed Stop / hotkey-toggle. This is the user-perceived
  // "transcription latency" surface in the Settings → Recordings
  // metric pane. Previously this timestamp was set far below (around
  // line 7122, inside the post-pipeline branch) AFTER the full stop
  // sequence had already run: stream.getTracks().stop, worklet drain,
  // MediaRecorder flush, OPFS finalize, ws.send(finalize),
  // waitForLiveFinalEnvelope Promise creation. On the FAST PATH where
  // streaming had already produced a full transcript, the only awaits
  // between that timestamp and the latency computation were
  // saveRecordingText (loopback, ms) — yielding metrics like
  // "TRANSCRIBE 3 ms" that meant "we did basically nothing here"
  // instead of the ~real round-trip (which is hundreds of ms to
  // multiple seconds depending on path).
  //
  // Moving the start to the top of stopLive fixes the metric for ALL
  // exit paths — fast (instant transcript), slow (envelope wait),
  // recovery (Deepgram REST fallback), local (Whisper full-audio
  // pass), and every short-circuit return below.
  const transcribeStartedAt = performance.now();
  let title = "Recording " + new Date().toLocaleString();
  const _smartTitle = (text: string): string => smartRecordingTitle(text, title);
  const currentProviderSelection = readProviderSelection();
  const currentSessionModels = resolveSessionLocalModels(currentProviderSelection);
  const currentEffectiveProvider = resolveEffectiveProvider(currentProviderSelection);
  const liveSnapshot = activeLiveSessionSnapshot || {
    provider: currentProviderSelection,
    effectiveProvider: currentEffectiveProvider,
    model: !currentEffectiveProvider
      ? ""
      : currentEffectiveProvider === "local"
        ? currentSessionModels.finalLocalModel
        : getRemoteModelValue(currentEffectiveProvider),
    language: (($("language") as HTMLSelectElement).value || "auto").trim(),
    diarize: readDiarizeEnabled(),
    assistLocalModel: currentSessionModels.assistLocalModel,
    finalLocalModel: currentSessionModels.finalLocalModel,
  };
  const providerValue = liveSnapshot.provider;
  const languageValue = liveSnapshot.language;
  // Snapshotted, never re-read: the recovery passes below must decode the
  // same recording with the same settings the live stream used.
  const diarizeValue = liveSnapshot.diarize;
  const effectiveProvider = liveSnapshot.effectiveProvider;
  const deepgramReachabilityHint = effectiveProvider === "deepgram";
  const modelValue = liveSnapshot.model;
  const sourceLiveText = getSessionCanonicalLiveSourceText(sessionUiToken);
  // The stop entry snapshot is intentionally not the SSOT: final/interim
  // events can still arrive while the socket drains and the audio is saved.
  let latestSourceLiveText = sourceLiveText;
  const latestSourceForSave = (): string => {
    const refreshed = getSessionCanonicalLiveSourceText(sessionUiToken);
    if (refreshed) {
      latestSourceLiveText = refreshed;
    }
    return latestSourceLiveText;
  };
  const latestSourceTitle = (): string => _smartTitle(latestSourceForSave());
  const captureSilenceSnapshot = (liveText: string): {
    hardSilence: boolean;
    likelySilenceWithoutPreview: boolean;
    silentCapture: boolean;
  } => {
    // Summarised only at decision time: stopLive drains the worklet
    // after entry, so an early snapshot can miss the final frames and
    // misclassify a short spoken clip as silence.
    //
    // Neither verdict compares against a fixed amplitude any more
    // (BUGS_AUDIT_2026-09-03 §4.3). ``hardSilence`` is digital silence —
    // a capture pipeline that delivered no signal at all, which is the
    // only thing a level cannot fake. ``likelySilenceWithoutPreview`` is
    // "nothing in this session ever rose above the room this session
    // recorded", which is what the old ``avgRms < 0.003`` was trying to
    // say and could not, because 0.003 is loud speech in one session and
    // below the noise floor in the next.
    const level = summarizeCaptureLevel(captureLevel);
    const noLiveText = !String(liveText || "").trim();
    const hardSilence = level.digitalSilence;
    const likelySilenceWithoutPreview = noLiveText && !level.carriedSpeech;
    const tooShortToTrust = recordedSec < UI_TOKENS.capture.silenceTrustMinSec;
    return {
      hardSilence,
      likelySilenceWithoutPreview,
      silentCapture:
        (tooShortToTrust && hardSilence) ||
        (tooShortToTrust && likelySilenceWithoutPreview),
    };
  };

  // Stop-time SSOT for "why is this session empty?". Combines the
  // capture-side RMS/peak snapshot with the mic-health tracker's
  // terminal state so the user sees the *root cause* (mic permission
  // reset, mic muted in OS, or simply quiet room) instead of a generic
  // "No speech captured" message.
  const finalMicHealth = micHealth.get();
  // Stop-time copy per terminal mic-health state. Deliberately worded
  // differently from the live-session copy in ``mic-health.ts``: the
  // recording is already saved by this point, so the actionable next
  // step is "fix the input, then re-record". Membership in this table is
  // also the single definition of "the capture hardware was at fault",
  // which the branches below read instead of re-listing the states.
  const STOP_COPY: Partial<
    Record<MicHealthState, { status: string; tone: UiTone; notice: boolean }>
  > = {
    silent: {
      status:
        "Recording saved, but the microphone delivered no audio. Open System Settings → Privacy & Security → Microphone, enable Transcriptor, then re-record.",
      tone: "error",
      notice: true,
    },
    muted: {
      status:
        "Recording saved, but the microphone was muted in the operating system. Unmute the input device and re-record.",
      tone: "warning",
      notice: true,
    },
    lost: {
      status: "Recording saved, but the microphone stream ended unexpectedly.",
      tone: "error",
      notice: false,
    },
  };
  const micHealthBad = !!STOP_COPY[finalMicHealth.state];
  const stopFailureReason = (liveText: string): {
    status: string;
    tone: UiTone;
    notice: string | null;
  } => {
    const health = STOP_COPY[finalMicHealth.state];
    if (health) {
      return {
        status: health.status,
        tone: health.tone,
        notice: health.notice ? health.status : null,
      };
    }
    const noLiveText = !String(liveText || "").trim();
    const silence = captureSilenceSnapshot(liveText);
    if (noLiveText && (silence.hardSilence || silence.likelySilenceWithoutPreview)) {
      return {
        status: "Recording completed, no speech detected.",
        tone: "info",
        notice: null,
      };
    }
    return { status: "", tone: "info", notice: null };
  };
  const provider = effectiveProvider;
  const metadataProvider = provider || (providerValue ? providerValue : "none");
  let remoteApiPromise: Promise<{ text: string; provider: string; model?: string }> | null = null;
  let savedAudioFile: File | null = null;
  let transcribeInputFile: File | null = null;
  const sessionArchiveDir = String(activeLiveArchiveDir || currentArchiveDirSnapshot()).trim();
  const startupAbortReason = liveStartAbortReason;
  liveStartAbortReason = "";

  // Timing instrumentation — each phase stamps a timestamp so we can
  // see exactly where stopLive spends its milliseconds. Inspect via
  // ``window.__transcriptorStopTimings`` in devtools after a stop.
  const stopTimings: Array<[string, number]> = [];
  const stopT0 = performance.now();
  const mark = (label: string): void => {
    stopTimings.push([label, performance.now() - stopT0]);
  };

  setCurrentRecordingSummary({
    title: _smartTitle(sourceLiveText),
    status: "Finalizing recording and assembling the canonical audio file.",
    tone: "info",
  }, sessionUiToken);

  // ── Tail-preserving stop sequence ───────────────────────────────────
  //
  // We want EVERY sample captured up to the instant the user pressed
  // Stop to land in both the canonical WAV and the Deepgram transcript.
  // Any reordering here directly translates into "last few seconds
  // chopped off" reports.
  //
  // The enforced ordering is:
  //
  //   1. Freeze the capture pipeline. Either the MediaStream tracks are
  //      stopped, or — when the graph is being kept warm for the next
  //      press — the worklet is armed, which flushes what it holds and
  //      then delivers nothing further. Both make the same guarantee:
  //      no frame captured after this point can reach ``pcmSink.append``
  //      or the live socket. The hold decision has to be taken HERE
  //      rather than in the teardown, because it asks whether the track
  //      is still ``live`` and stopping it answers that question for it.
  //
  //   2. flushWorkletPort + waitForCaptureDrain. The worklet has a
  //      MessagePort queue; anything posted BEFORE step 1 returned is
  //      still in flight. We barrier on it so every ``pushCapturedFrame``
  //      callback that the worklet already scheduled runs before we
  //      move on — this is the ONLY way to guarantee that the last
  //      PCM sample is handed to pcmSink.append AND to ws.send.
  //
  //   3. Stop MediaRecorder and flush WebM chunks. Runs after the
  //      mic is dead so we don't generate more audio while we're
  //      waiting on the stop event.
  //
  //   4. pcmSink.finalize. After step 2 we know every captured frame
  //      has been handed to sink.append — finalize just drains the
  //      already-queued chunks.
  //
  //   5. Send {type:"finalize"} to backend. At this point ws has no
  //      more PCM to send (mic is dead, worklet drained), so the
  //      backend receiver sees the finalize message AFTER every byte
  //      we intended to send. This is what tells Deepgram to close
  //      its stream and return the final envelope covering ALL
  //      audio — including the trailing clause the user was still
  //      speaking.
  //
  // The old order was: flush → drain →
  // stopMediaRecorderAndFlush (up to 3s!) → stream.stop() → finalize.
  // That left the mic live for up to 3 seconds while MediaRecorder was
  // being flushed, and those trailing frames could arrive at Deepgram
  // AFTER CloseStream and get dropped. Reordering the pipeline freeze to
  // step 1 fixes this at the root.
  const stopEntryBuffer = getLiveTranscriptBuffer(sessionUiToken);
  console.log(`[trace stopLive] enter recordedSec=${recordedSec.toFixed(2)} sessionToken=${sessionUiToken.slice(0, 8)} provider=${provider} wsState=${ws ? ws.readyState : "null"} wsPendingFrames=${wsPendingFrames.length} segmentCount=${stopEntryBuffer?.segments.length ?? liveTranscriptSegments.length} liveDraftLen=${stopEntryBuffer?.committedText.length ?? liveDraftText.length} liveInterimLen=${stopEntryBuffer?.interimText.length ?? liveInterimText.length}`);
  // §4.7: the graph outlives the recording when it may, and the question
  // "may it?" is asked while the track is still live. The ordering lives
  // in ./capture-warm with the rest of the warm-capture policy, so it is
  // a unit test rather than a claim about a 2000-line function.
  const warmHoldPlan = freezeCaptureForStop({
    planHold: planWarmCaptureHold,
    stopTracks: stopCaptureTracks,
  });
  console.log(
    `[trace stopLive] warm hold=${warmHoldPlan.hold ? 1 : 0} reason=${warmHoldPlan.reason} ` +
    `ttlMs=${UI_TOKENS.capture.warmHoldMs} device="${warmHoldPlan.deviceLabel}"`,
  );
  mark("captureFreeze");
  // The WebM container is an INDEPENDENT sink fed by the MediaStream,
  // not by the worklet, so arming the worklet does not stop it — only
  // ``recorder.stop()`` does. It is kicked off here, in the same breath
  // as the freeze above, so a warm hold (which deliberately leaves the
  // microphone open) cannot keep writing post-stop audio into the
  // container that ``selectCanonicalCapturedAudio`` later weighs.
  //
  // R3 (BUGS_AUDIT_2026-09-03 §2.4/§4.4): it is not AWAITED here. The
  // ordering invariant — every audio frame sent before the finalize
  // frame — is the worklet barrier below, not this flush, and blocking
  // on it added up to MEDIA_RECORDER_STOP_FALLBACK_MS of pure latency
  // before the backend even learned the recording had ended. It is
  // awaited only where its output (``recordedWebmChunks``) is read.
  const recorderFlushPromise = stopMediaRecorderAndFlush().then(() => {
    mark("stopMediaRecorderAndFlush");
  });

  const t0Drain = performance.now();
  // The ack IS the barrier. `waitForWorkletDrain` is the fallback for
  // when there isn't one.
  //
  // The drain waits for a 120 ms gap with no new frame, bounded at
  // 450 ms. But the microphone track is stopped in step 1 above while
  // the worklet node stays connected, so the audio thread keeps calling
  // `process()` and keeps handing over frames — of silence. The idle
  // condition can therefore never be satisfied, and the measured cost
  // was the ceiling, every time:
  //
  //   waitForWorkletDrain: 467ms   (ceiling 450ms + one poll step)
  //
  // Half a second added to every stop, waiting out a clock for an
  // event that had already happened. When the worklet acknowledges the
  // flush, every captured sample has provably been delivered — the
  // track was already stopped, so anything arriving afterwards is
  // post-stop silence and holds nothing back.
  //
  // The ScriptProcessor fallback has no port and no ack, so it still
  // drains — but on a real barrier, not on the absence of one. The
  // heuristic that used to stand here waited for a 120 ms gap with no
  // new frame, and the node it was waiting on keeps delivering frames
  // of silence after the track is stopped, so the condition could never
  // be satisfied and every stop paid the 450 ms ceiling. What actually
  // has to be true is that the node has handed over what it was holding
  // when the track stopped: one buffer period, and one frame delivered
  // after it (§4.5).
  const framesAtTrackStop = captureLevel.frames;
  const workletAcked = await flushWorkletPort();
  mark("flushWorkletPort");
  const flushDur = performance.now() - t0Drain;
  if (!workletAcked) {
    await waitForCaptureDrain(framesAtTrackStop);
  }
  mark("waitForCaptureDrain");
  const drainDur = performance.now() - t0Drain - flushDur;
  console.log(`[trace stopLive] drained ackBarrier=${workletAcked ? 1 : 0} flush=${flushDur.toFixed(0)}ms drain=${drainDur.toFixed(0)}ms wsPendingFrames=${wsPendingFrames.length} segmentCount=${getLiveTranscriptBuffer(sessionUiToken)?.segments.length ?? liveTranscriptSegments.length}`);

  // Tell the backend to finalize the upstream provider (Deepgram or local)
  // BEFORE we close the socket. The backend will send a {type:"final", ...}
  // envelope that we await below. This is what eliminates the double
  // re-upload path — no need to re-submit the full audio because Deepgram
  // has already finalized the stream. The awaited promise is keyed by
  // session token so that if the user starts a new recording before this
  // one finishes finalizing, we cannot accidentally read the new
  // session's envelope.
  //
  // We snapshot ``liveStreamError`` only — the committed segments
  // snapshot is NOT taken here. Instead we read the LIVE
  // ``liveTranscriptSegments`` after awaiting ``liveFinalPromise`` so
  // interim segments that arrive while the envelope is in flight
  // (very common: Deepgram streams one more ``is_final`` message
  // covering the tail of the utterance AFTER CloseStream) still make
  // it into the transcript. The old code snapshotted BEFORE the wait
  // and lost those trailing segments — that was the tail-cut bug.
  const liveStreamErrorAtStop = getLiveStreamError(sessionUiToken);

  // Lazily-armed envelope waiter.
  //
  // This used to be ``liveFinalPromise = waitForLiveFinalEnvelope(...)``
  // right here — which STARTED the 4 s timer at finalize-send time,
  // several seconds before anything actually awaits it. Between this
  // point and the first await sit ``pcmSink.finalize()``, an
  // ``<audio>`` duration probe worth up to 2.5 s, the whole Web Audio
  // teardown, and ``saveRecordingText`` uploading a multi-megabyte WAV
  // over the loopback. On a long recording the budget was fully spent
  // before the wait began, so the post-CloseStream ``is_final`` — the
  // trailing clause the user spoke just before Stop — was treated as
  // "never arrived" and either lost or re-fetched through the slow
  // recovery path.
  //
  // Arming lazily starts the 4 s from the moment we genuinely begin
  // waiting. Nothing is lost in the meantime: ``resolveLiveFinal``
  // stores the envelope on the slot whether or not a waiter exists,
  // and ``waitForLiveFinalEnvelope`` returns it immediately if already
  // present.
  let liveFinalWaiterArmed = false;
  let _liveFinalPromise: Promise<LiveFinalEnvelope | null> | null = null;
  const liveFinalPromise = (): Promise<LiveFinalEnvelope | null> => {
    if (!liveFinalWaiterArmed) return Promise.resolve(null);
    if (!_liveFinalPromise) {
      _liveFinalPromise = waitForLiveFinalEnvelope(sessionUiToken, UI_TOKENS.finalize.envelopeWaitMs);
    }
    return _liveFinalPromise;
  };
  if (ws) {
    // The round-trip budget after CloseStream is
    // ``UI_TOKENS.finalize.envelopeWaitMs``, where its size is argued
    // for alongside the other stop budgets.
    //
    // The FAST PATH in the Deepgram branch below still short-
    // circuits this ceiling when committed segments already cover
    // the recording tail, so the new ceiling only matters on the
    // genuinely-slow path it was always there for.
    liveFinalWaiterArmed = true;
    // Last chance to hand over audio buffered during the handshake. The
    // worklet is drained by now, so no further ``pushCapturedFrame``
    // will run to do it — anything still queued here would otherwise be
    // silently lost from the live transport, and the finalize below
    // would ask the backend to close over an incomplete stream.
    const strandedFrames = flushPendingWsFrames(ws);
    if (strandedFrames > 0) {
      wsFramesNeverSent += strandedFrames;
      wsPendingFrames = [];
  wsPendingFrameSamples = 0;
      console.warn(`[trace stopLive] ${strandedFrames} captured frames never reached the live transport`);
    }
    if (discarding) {
      // Nothing downstream will read the result, and Finalize is what
      // makes the provider decode (and bill for) the audio.
      console.log(`[trace stopLive] discard: finalize not sent`);
    } else if (ws.readyState === WebSocket.OPEN) {
      try {
        // PROTOCOL CONTRACT C1: framesSent/bytesSent are this session's
        // running totals, including the frames just flushed above from
        // the CONNECTING-time buffer (the "tail-hold" frames) — so the
        // backend can drain exactly the frames it is owed instead of a
        // fixed dwell time (BUGS_AUDIT_2026-09-03 §3.6).
        ws.send(JSON.stringify({ type: "finalize", framesSent: wsFramesSent, bytesSent: wsBytesSent }));
        // Phase marker, not a side effect: the interval between Stop and
        // this send is time Deepgram does not yet know the recording
        // ended, and it was invisible. Measured on one real stop: the
        // user pressed Stop at 05:32:22.691 and the backend logged
        // "finalize ENTER" at 05:32:24.089 — 1.4 s in which the local
        // canonical-audio work ran and the upstream flush had not begun.
        mark("wsFinalizeSent");
        console.log(`[trace stopLive] finalize sent to ws (state=OPEN, neverSent=${wsFramesNeverSent})`);
      } catch (e) {
        console.warn(`[trace stopLive] finalize send threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.log(`[trace stopLive] finalize NOT sent — ws.readyState=${ws.readyState} (0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED)`);
    }
  } else {
    console.log(`[trace stopLive] no ws — finalize skipped`);
  }

  // Drain the PCM sink. For OPFS-backed sinks this is ~O(disk IO
  // for the final small chunk) — the bulk of the audio is already
  // on disk. For memory-backed sinks it's O(n) but still fast
  // because Int16 is half the Float32 footprint the old path used.
  let pcmCanonicalFile: File | null = null;
  let pcmCanonicalSampleCount = 0;
  if (pcmSink) {
    try {
      pcmCanonicalSampleCount = pcmSink.totalSamples;
      pcmCanonicalFile = await pcmSink.finalize(LIVE_SAMPLE_RATE_HZ);
    } catch (e) {
      console.warn("pcmSink.finalize failed; canonical audio will come from WebM fallback", e);
    }
  }
  mark("pcmSink.finalize");
  // R3: this is the first point ``recordedWebmChunks`` is actually read
  // (as the WebM fallback inside selectCanonicalCapturedAudio), so it is
  // the first point the concurrent recorder flush needs to be awaited.
  // Everything above ran in parallel with it since the worklet barrier,
  // not this flush, is what proves every PCM sample reached the socket.
  await recorderFlushPromise;
  const canonicalCapture = await selectCanonicalCapturedAudio({
    pcmFile: pcmCanonicalFile,
    pcmSampleCount: pcmCanonicalSampleCount,
    pcmSampleRate: LIVE_SAMPLE_RATE_HZ,
    recordedChunks: recordedWebmChunks,
    expectedDurationSec: recordedSec,
  });
  mark("selectCanonicalCapturedAudio");
  if (canonicalCapture.file) {
    savedAudioFile = canonicalCapture.file;
    transcribeInputFile = canonicalCapture.file;
  }

  // OpenRouter has no streaming API, so it still needs a full-audio REST pass.
  // Start it only after the durable save path below has created/fetched the
  // canonical audio. Starting here with the OPFS-backed File can race with
  // deferredSinkDestroy and upload an empty/truncated body.

  // ── Cleanup (runs while provider is finalizing) ─────────────────────────
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (vuIntervalId) {
    clearInterval(vuIntervalId);
    vuIntervalId = null;
  }
  if (pipelineFailsafeId) {
    clearTimeout(pipelineFailsafeId);
    pipelineFailsafeId = null;
  }
  if (draftSaveTimer) {
    clearInterval(draftSaveTimer);
    draftSaveTimer = null;
  }
  persistLiveDraft(false);
  // Web Audio node teardown. These ``disconnect()`` / ``close()`` calls
  // throw InvalidStateError when a node was already disconnected in a
  // previous error path. That is the only exception class expected here
  // so silent catches are the correct semantics; anything else would be
  // a programmer bug we want surfaced via an uncaught rejection instead.
  const tearDown = (step: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      if (e instanceof DOMException) return;
      console.warn(`live teardown step failed: ${step}`, e);
    }
  };
  // §4.7: the handover of the graph decided at step 1 of the stop
  // sequence. This runs BEFORE the disconnect chain and, on a "yes",
  // empties every module slot it takes ownership of — so each step below
  // finds a null and does nothing, and the mic, context and armed
  // worklet stay alive for the next press. On a "no" nothing moves and
  // the teardown releases everything exactly as it always did.
  handOverHeldCapture({
    plan: warmHoldPlan,
    commit: commitWarmCaptureHold,
    // Planned but not taken: the microphone was never stopped at step 1
    // on the strength of that plan, so it has to be stopped here.
    stopTracks: stopCaptureTracks,
  });
  tearDown("workletNode.disconnect", () => {
    detachWorkletCapture("live teardown");
  });
  tearDown("scriptNode.input.disconnect", () => {
    if (src && scriptNode) src.disconnect(scriptNode);
  });
  tearDown("scriptNode.disconnect", () => {
    if (scriptNode) {
      scriptNode.disconnect();
      scriptNode.onaudioprocess = null;
    }
  });
  tearDown("scriptSinkGain.disconnect", () => {
    if (scriptSinkGain) scriptSinkGain.disconnect();
  });
  tearDown("analyser.disconnect", () => {
    if (analyser) analyser.disconnect();
  });
  tearDown("src.disconnect", () => {
    if (src) src.disconnect();
  });
  tearDown("stream.getTracks.stop", () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  });
  stream = null;
  // Same single close path as every other teardown. Awaiting it (rather
  // than firing close() and nulling the slot in the same tick) means the
  // slot is provably empty before the next start can claim it.
  await closeAudioContextSlot();
  workletNode = null;
  teardownScriptProcessorCapture();
  src = null;
  analyser = null;
  // ── 1.1.22: defer ws.close until envelope arrived ──
  //
  // The previous version closed the WebSocket and nulled its
  // handlers HERE in the teardown chain — i.e. only ~10 ms after
  // ``ws.send({type: "finalize"})`` was issued just above. That
  // race truncates the entire post-stop tail:
  //
  //   1. Frontend: send finalize → close WS in 10 ms.
  //   2. Backend's ``ws-dg-rx`` task receives finalize, drains
  //      250 ms, then calls ``session.finalize()`` which sends
  //      ``Finalize`` and ``CloseStream`` to Deepgram.
  //   3. Deepgram processes the trailing audio, emits the post-
  ///     CloseStream is_final at ~T+800 ms (timestamp 11:43:11.888
  //      in the user's main.log).
  //   4. Backend's forwarder task tries to send that segment to
  //      the frontend WS — but the WS was closed at step 1, the
  //      send fails silently. Same fate for the final envelope.
  //
  // Net result: the trailing is_final ``"восемь, девять, десять"``
  // existed at the backend (proven by the 1.1.21 log line
  // ``finalize EXIT … segments_final=9 (delta from ENTER)``) but
  // never reached the frontend. ``getCanonicalLiveSourceText``
  // committed text stopped at ``"семь"`` and recovery had to do
  // the work — costing ~3 s and sometimes producing a worse
  // result.
  //
  // Fix: just hold the reference. The WS stays open through the
  // transcribe-phase await chain (envelope wait, recovery race),
  // ``ws.onmessage`` continues to deliver post-CloseStream
  // segments and the final envelope, and the WS is closed once
  // at the very end of stopLive (outer finally). Nulling the
  // socket-level handlers happens at that same final close so
  // we still prevent leaked closures.
  _wsToCloseAtEnd = ws;
  ws = null;
  wsPendingFrames = [];
  wsPendingFrameSamples = 0;
  mediaRecorder = null;
  recordedWebmChunks = [];
  // Release the PCM sink reference after capture teardown, but DO NOT
  // destroy (delete the OPFS spool file) yet — the File blob from
  // finalize() may still reference it. Destruction is deferred to
  // after saveRecordingText serializes the blob into the FormData upload.
  const deferredSinkDestroy = pcmSink;
  pcmSink = null;
  activeLiveSessionId = "";
  activeLiveArchiveDir = "";
  activeLiveSessionSnapshot = null;
  // currentRecordingId / window.__transcriptorCurrentRecordingId are also
  // cleared in the outer finally below so they are guaranteed to reset on
  // every exit path — including uncaught throws before this point.
  currentRecordingId = 0;
  window.__transcriptorIsRecording = false;
  window.__transcriptorRmsLevel = 0;
  window.__transcriptorLastFrameAt = 0;
  window.__transcriptorCurrentRecordingId = 0;
  setRecordButton(false);
  resetVU();

  if (discarding) {
    // Everything is torn down; nothing is written. No transcript, no
    // history entry, no audio on disk, and no post-stop work for the
    // main process to wait behind — which is what made the NEXT press
    // land on a busy capsule and do nothing.
    console.log(
      `[trace stopLive] discarded ${recordedMs.toFixed(0)}ms recording ` +
      `(below the ${UI_TOKENS.capture.minRecordingMs}ms floor) rec=${recordingId}`,
    );
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: "",
      kind: "status",
      sessionToken: sessionUiToken,
    });
    if (liveSessionId) {
      void discardLiveRecovery(liveSessionId).catch((e) => {
        console.warn("discardLiveRecovery failed for a discarded recording", e);
      });
    }
    if (deferredSinkDestroy) {
      void deferredSinkDestroy.destroy();
    }
    releaseStopEpilogueBookkeeping();
    setStatusScoped(sessionUiToken, "Idle");
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    return;
  }

  if (savedAudioFile) {
    setCurrentRecordingAudio(savedAudioFile, "", sessionArchiveDir, sessionUiToken);
  }
  releaseStopTransitionAfterCaptureDetach();

  let persistedRecordingName = "";
  let persistedRecordingArchiveDir = "";
  const provisionalTitle = _smartTitle(sourceLiveText);
  if (savedAudioFile) {
    // Two-attempt save: first with the configured archive dir, then
    // with the DEFAULT dir. The most common cause of "initial save
    // failed" is a stale custom recordings_dir that became unwritable
    // (rename, permissions, external drive ejected). Retrying into the
    // default dir salvages the audio instead of silently losing it.
    let saveDone = false;
    // Build unique attempt list — if sessionArchiveDir is already ""
    // the fallback would be identical, so skip the duplicate.
    const saveDirs = sessionArchiveDir ? [sessionArchiveDir, ""] : [""];
    for (const tryArchiveDir of saveDirs) {
      if (saveDone) break;
      try {
        const persisted = await saveRecordingText({
          archiveDir: tryArchiveDir,
          title: provisionalTitle,
          sourceText: latestSourceForSave(),
          transcriptText: "",
          provider: metadataProvider,
          model: modelValue,
          language: languageValue,
          recordingCollection: RECORDING_COLLECTIONS.live,
          audioFile: savedAudioFile,
          liveSessionId: liveSessionId,
          refreshList: false,
        });
        persistedRecordingName = persisted.name;
        persistedRecordingArchiveDir = persisted.archiveDir;
        setCurrentRecordingAudio(savedAudioFile, persistedRecordingName, persistedRecordingArchiveDir, sessionUiToken);
        // 1.1.25: best-effort recovery discard. The save above ALREADY
        // succeeded; a 5xx from /api/live-recovery/discard does not
        // invalidate the persisted recording. Previous code let that
        // exception escape into the outer ``catch (e)`` at the bottom
        // of the for-loop, which then reported the recording as a save
        // failure and left the live-recovery snapshot for the next
        // boot to "recover" — producing a duplicate of a recording
        // that was already saved correctly.
        try {
          await discardLiveRecovery(liveSessionId);
        } catch (e) {
          console.warn("discardLiveRecovery failed (non-fatal); recovery will be re-promoted on next start", e);
        }
        const fallbackNote = tryArchiveDir !== sessionArchiveDir && sessionArchiveDir
          ? " (saved to default folder — configured archive was unavailable)"
          : "";
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: (enhance && transcribeInputFile ? "Audio saved locally. Starting final transcription." : "Audio saved locally.") + fallbackNote,
          tone: "success",
          savedName: persistedRecordingName,
        }, sessionUiToken);
        showRecordSessionNotice(
          "Recording audio is saved and available immediately.",
          "success",
          UI_TOKENS.notice.briefMs,
          sessionUiToken,
        );
        saveDone = true;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e || "");
        console.warn(`Audio persistence attempt failed (archiveDirSet=${String(tryArchiveDir || "").trim() ? "1" : "0"}, fileSize=${savedAudioFile?.size || 0}, fileNameLen=${String(savedAudioFile?.name || "").length})`, e);
        if (tryArchiveDir === "" || saveDirs.length === 1) {
          // Both attempts failed — truly broken. Surface the ACTUAL
          // backend error message instead of a generic "check folder
          // permissions" hint that masks the real cause. The previous
          // text said the same thing for a Windows path-too-long, an
          // antivirus block, a 413 oversize, a 5xx backend crash, or a
          // genuine permission denial — all five looked identical to
          // the user. Now we name the underlying error verbatim and
          // append the permission hint as a fallback when the message
          // is empty (rare; only fires on `String(e)` of a bare object).
          const detail = errMsg.trim()
            || "unknown error — check the Recordings folder permissions";
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: `Audio capture finished, but save failed: ${detail}`,
            tone: "error",
          }, sessionUiToken);
        }
      }
    }
  }
  // NOW safe to destroy the OPFS spool file — saveRecordingText above
  // has already serialized the File blob into the FormData upload.
  if (deferredSinkDestroy) {
    void deferredSinkDestroy.destroy();
  }

  if (startupAbortReason && !savedAudioFile && !transcribeInputFile && captureLevel.frames === 0) {
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: startupAbortReason,
      kind: "error",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    releaseStopEpilogueBookkeeping();
    setStatusScoped(sessionUiToken, "Error");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: startupAbortReason,
      tone: "error",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
    }, sessionUiToken);
    return;
  }

  const drainedSourceLiveText = latestSourceForSave();
  const drainedSilence = provider ? captureSilenceSnapshot(drainedSourceLiveText) : null;
  const drainedFailureReason = provider ? stopFailureReason(drainedSourceLiveText) : null;
  const drainedIsSilent = !!drainedSilence?.silentCapture || (!!provider && micHealthBad);
  if (drainedIsSilent) {
    const drainedDomText = micHealthBad ? "[ Mic not delivering audio ]" : "[ Silence ]";
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: drainedDomText,
      kind: micHealthBad ? "error" : "status",
      sessionToken: sessionUiToken,
    });
    setStatusScoped(sessionUiToken, "Done");
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
        transcriptText: drainedDomText,
        provider: metadataProvider,
        model: modelValue,
        language: languageValue,
        recordingCollection: RECORDING_COLLECTIONS.live,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: drainedFailureReason?.notice ||
            "Silence was detected, but the original archive changed before the session could be finalized. The entry was not recreated elsewhere.",
          tone: "warning",
        }, sessionUiToken);
      }
    }
    releaseStopEpilogueBookkeeping();
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: drainedFailureReason?.status || "Silence detected. Audio remains available for review.",
      tone: drainedFailureReason?.tone || "success",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
    }, sessionUiToken);
    return;
  }

  if (!enhance || !transcribeInputFile) {
    const skippedBySetting = !enhance;
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: skippedBySetting
        ? "Auto transcribe is off. Audio was saved locally and is ready to review."
        : "Audio was saved locally, but the canonical transcription input is unavailable for this session.",
      kind: skippedBySetting ? "status" : "error",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
        transcriptText: "",
        provider: metadataProvider,
        model: modelValue,
        language: languageValue,
        recordingCollection: RECORDING_COLLECTIONS.live,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "Audio is available, but the original archive changed before the session metadata could be finalized.",
          tone: "warning",
        }, sessionUiToken);
      }
    }
    releaseStopEpilogueBookkeeping();
    setStatusScoped(sessionUiToken, skippedBySetting ? "Idle" : "Error");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: skippedBySetting
        ? "Audio saved. Final transcription was skipped for this session."
        : "Audio saved, but the canonical transcription input is unavailable for this session.",
      tone: skippedBySetting ? "success" : "warning",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
    }, sessionUiToken);
    return;
  }

  if (!provider) {
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: "No transcription provider is selected. Audio was saved locally.",
      kind: "status",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
        transcriptText: "",
        provider: metadataProvider,
        model: modelValue,
        language: languageValue,
        recordingCollection: RECORDING_COLLECTIONS.live,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "No provider is selected, and the original archive changed before the session metadata could be finalized.",
          tone: "warning",
        }, sessionUiToken);
      }
    }
    releaseStopEpilogueBookkeeping();
    setStatusScoped(sessionUiToken, "Idle");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: "Audio saved. No transcription provider is selected.",
      tone: "warning",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
    }, sessionUiToken);
    return;
  }

  if (providerValue !== effectiveProvider) {
    setStatusScoped(sessionUiToken, "Processing (Local Fallback)");
  } else {
    setStatusScoped(sessionUiToken, "Processing");
  }
  if (provider !== "local" && !isProviderKeyConfigured(provider)) {
    const msg = providerKeyErrorMessage(provider);
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: msg,
      kind: "error",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    setStatusScoped(sessionUiToken, "Error");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: `${msg} Audio is still saved locally.`,
      tone: "error",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
    }, sessionUiToken);
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
        transcriptText: "",
        provider,
        model: modelValue,
        language: languageValue,
        recordingCollection: RECORDING_COLLECTIONS.live,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: `${msg} The original archive changed before the session metadata could be finalized.`,
          tone: "warning",
          transcribeLatencyMs: performance.now() - transcribeStartedAt,
        }, sessionUiToken);
      }
    }
    releaseStopEpilogueBookkeeping();
    return;
  }
  // (``transcribeStartedAt`` is captured at the top of ``stopLive``)
  if (isCurrentUiSession(sessionUiToken)) {
    $("progressRow").hidden = false;
  }
  patchCurrentRecordingSummary({
    title: provisionalTitle,
    status:
      providerValue !== effectiveProvider
        ? localFallbackReason(providerValue)
        : `Transcribing with ${providerLabel(provider)}.`,
    tone: "info",
  }, sessionUiToken);
  // Single-capsule invariant: keep the app busy until this stop/transcribe
  // pipeline reaches the outer finally. That keeps global hotkeys,
  // main-process stops, and the visible capsule behind the same source of truth.
  try {
    // ── Recovery-audio resolver ────────────────────────────────────
    //
    // Single source of truth for the audio bytes used by EVERY post-
    // stop recovery path (final-local-pass, REST recovery, empty-
    // result fallback, suspiciously-short re-transcribe).
    //
    // PREFERS the backend re-fetch over the in-memory ``transcribe
    // InputFile``. The in-memory file is the lazy ``Blob([header,
    // OPFS-spool])`` from ``OpfsPcmSink.finalize()``; once
    // ``deferredSinkDestroy.destroy()`` runs (which already happened
    // earlier in this function), the spool is gone
    // and the lazy blob reads as zero bytes — uploads succeed with a
    // 200 status but the backend gets an empty payload, ffmpeg
    // raises "invalid data", and BOTH provider paths fail
    // simultaneously. This is the same OPFS-dangling lifecycle bug
    // that broke playback on Windows (commit e2a39c8) and that the
    // 1.1.13 empty-fallback inadvertently re-introduced for the
    // upload path.
    //
    // The backend re-fetch hits ``/api/recordings/<name>/audio`` —
    // a loopback FileResponse over the durable on-disk file. It
    // returns honest ``Content-Type`` + ``Content-Disposition``
    // headers so we never lie about the container.
    //
    // Falls through to the in-memory file ONLY when the recording
    // was never persisted (extremely rare — stopLive's two-attempt
    // save with default-dir fallback covers nearly every failure).
    const fetchRecoveryAudioFile = async (): Promise<File | null> => {
      if (persistedRecordingName) {
        try {
          return await fetchSavedAudioFromBackend(
            persistedRecordingName,
            persistedRecordingArchiveDir,
          );
        } catch (e) {
          console.warn("Recovery audio backend fetch failed; trying in-memory file", e);
        }
      }
      return transcribeInputFile;
    };
    const runLocalFinalPass = async (): Promise<LocalTranscriptionResult> => {
      const audioFile = await fetchRecoveryAudioFile();
      if (!audioFile) {
        throw new Error("Canonical audio file is unavailable for final local transcription.");
      }
      return transcribeCanonicalAudioLocally(audioFile, languageValue, liveSnapshot.finalLocalModel);
    };
    // Unified empty-transcript recovery: tries Deepgram REST
    // (when a key is configured) THEN local Whisper, in that order,
    // against the durably-stored audio. Returns "" when nothing
    // recovered. All progress UI writes are session-gated so a
    // fresh recording started during recovery doesn't get clobbered.
    //
    // Replaces three previously-divergent fallback paths that each
    // did a different subset of the chain:
    //   - liveStreamErrorAtStop fast path: cached only, NO REST
    //     recovery (worst-case: lower-quality cache wins over the
    //     full Deepgram REST result).
    //   - envelope-error branch: REST → local. The reference impl.
    //   - 1.1.13 bottom safety net: local only, NO REST (worse than
    //     manual Re-transcribe which the user clearly preferred).
    // Centralizing them ensures every path tries the highest-
    // quality available transcription before giving up.
    // Deepgram REST against an already-saved recording — skips the
    // ``GET /api/recordings/<name>/audio`` + ``POST /api/remote/
    // transcribe-sync`` round-trip by hitting the in-place
    // ``transcribe-on-disk`` endpoint added in 1.1.18. Saves
    // 500 ms-1 s of loopback overhead on every recovery call when
    // the recording was successfully persisted (the common case).
    const deepgramRestOnDisk = async (signal?: AbortSignal): Promise<string | null> => {
      if (!persistedRecordingName) return null;
      const url = `/api/recordings/${encodeURIComponent(persistedRecordingName)}/transcribe-on-disk`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          provider: "deepgram",
          language: languageValue,
          diarize: diarizeValue,
          ...remoteModelJsonFields("deepgram", getRemoteModelValue("deepgram")),
          archive_dir: persistedRecordingArchiveDir || "",
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}${detail ? ": " + detail.slice(0, 200) : ""}`);
      }
      const data = await resp.json();
      return String(data?.result?.text || "").trim();
    };
    // Hard time-bound on recovery so a stalled provider doesn't block
    // stopLive indefinitely. Short live captures get a much tighter
    // budget: if a 12 s recording has no live text and Deepgram is
    // degraded/offline, waiting 20+ s is network stall, not useful
    // transcription work.
    const RECOVERY_HARD_TIMEOUT_MS =
      provider === "deepgram" && recordedSec > 0 && recordedSec <= 30
        ? LIVE_SHORT_EMPTY_RECOVERY_TIMEOUT_MS
        : LIVE_DEFAULT_EMPTY_RECOVERY_TIMEOUT_MS;
    const recoverFromEmptyTranscriptInner = async (reason: string, signal?: AbortSignal): Promise<string> => {
      console.log(`[trace recover] enter reason="${reason}" persistedRecordingName="${persistedRecordingName}" hasInMemoryFile=${!!transcribeInputFile}`);
      if (isProviderKeyConfigured("deepgram") && isRemoteProviderReachable("deepgram", deepgramReachabilityHint)) {
        if (isCurrentUiSession(sessionUiToken)) {
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: `${reason} Recovering via Deepgram REST.`,
            tone: "warning",
          }, sessionUiToken);
        }
        const tDg = performance.now();
        // FAST PATH: backend transcribes the on-disk file directly
        // (no upload). Falls through to upload-based path only when
        // the recording wasn't persisted (extremely rare — stopLive's
        // two-attempt save handles every common failure).
        try {
          const onDisk = await deepgramRestOnDisk(signal);
          if (onDisk !== null) {
            console.log(`[trace recover] deepgram REST on-disk durMs=${(performance.now() - tDg).toFixed(0)} textLen=${onDisk.length} wordCount=${onDisk.split(/\s+/).filter(Boolean).length}`);
            if (onDisk) return onDisk;
          } else {
            console.log(`[trace recover] no persistedRecordingName — falling back to upload-based REST`);
          }
        } catch (e) {
          console.log(`[trace recover] deepgram REST on-disk FAIL durMs=${(performance.now() - tDg).toFixed(0)} err="${e instanceof Error ? e.message : String(e)}" — falling back to upload-based REST`);
        }
        // SLOW PATH (kept as fallback when on-disk endpoint is
        // unavailable, e.g., older backend, or when the recording
        // wasn't persisted): fetch audio + upload via FormData.
        const audioFile = await fetchRecoveryAudioFile();
        if (audioFile) {
          const tDg2 = performance.now();
          try {
            const result = await remoteJobSync(audioFile, {
              provider: "deepgram",
              language: languageValue,
              diarize: diarizeValue,
              remoteModel: getRemoteModelValue("deepgram"),
              providerReachabilityHint: deepgramReachabilityHint,
              signal,
            });
            const text = String(result.text || "").trim();
            console.log(`[trace recover] deepgram REST upload durMs=${(performance.now() - tDg2).toFixed(0)} textLen=${text.length} wordCount=${text.split(/\s+/).filter(Boolean).length}`);
            if (text) return text;
          } catch (e) {
            console.log(`[trace recover] deepgram REST upload FAIL durMs=${(performance.now() - tDg2).toFixed(0)} err="${e instanceof Error ? e.message : String(e)}"`);
          }
        }
      } else {
        console.log(
          isProviderKeyConfigured("deepgram")
            ? `[trace recover] deepgram skipped — ${remoteProviderOfflineMessage("deepgram")}`
            : `[trace recover] deepgram skipped — no API key configured`,
        );
      }
      // Local Whisper — last resort. Always uses the in-memory /
      // backend-fetched file path (no in-place equivalent because
      // local pass already runs server-side and there's no upload
      // boundary worth saving).
      const audioFile = await fetchRecoveryAudioFile();
      if (!audioFile) {
        console.log(`[trace recover] no audio file for local whisper — abort`);
        return "";
      }
      if (isCurrentUiSession(sessionUiToken)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: `${reason} Recovering via local Whisper.`,
          tone: "warning",
        }, sessionUiToken);
      }
      const tLocal = performance.now();
      try {
        const local = await transcribeCanonicalAudioLocally(
          audioFile,
          languageValue,
          liveSnapshot.finalLocalModel,
          signal,
        );
        const text = String(local.text || "").trim();
        console.log(`[trace recover] local whisper OK durMs=${(performance.now() - tLocal).toFixed(0)} model="${liveSnapshot.finalLocalModel}" textLen=${text.length} wordCount=${text.split(/\s+/).filter(Boolean).length}`);
        return text;
      } catch (e) {
        console.log(`[trace recover] local whisper FAIL durMs=${(performance.now() - tLocal).toFixed(0)} err="${e instanceof Error ? e.message : String(e)}"`);
        return "";
      }
    };
    // Public helper: wraps the inner chain in a hard timeout so a
    // stalled provider can't hang the stopLive flow forever. The
    // inner chain races against a sentinel that resolves with "" at
    // the deadline. The inner work keeps running in the background
    // (its promises don't get cancelled — the caller just stops
    // waiting), so a delayed result still gets logged; we just don't
    // block the UI on it.
    const recoverFromEmptyTranscript = async (
      reason: string,
      budgetMs = RECOVERY_HARD_TIMEOUT_MS,
    ): Promise<string> => {
      const tStart = performance.now();
      const abortController = new AbortController();
      // ``timeoutHandle`` is captured so the inner-resolves-first path
      // can clearTimeout and avoid the misleading "HARD TIMEOUT" log
      // that would otherwise fire 20 s after the function already
      // returned (cosmetic noise the user noticed in main.log).
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const innerPromise = recoverFromEmptyTranscriptInner(reason, abortController.signal).finally(() => {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      });
      const timeoutPromise = new Promise<string>((resolve) => {
        timeoutHandle = setTimeout(() => {
          console.log(`[trace recover] HARD TIMEOUT after ${budgetMs}ms — abandoning recovery`);
          abortController.abort();
          resolve("");
        }, budgetMs);
      });
      const result = await Promise.race([innerPromise, timeoutPromise]);
      console.log(`[trace recover] outer durMs=${(performance.now() - tStart).toFixed(0)} resultLen=${result.length}`);
      return result;
    };
    let transcriptRaw = "";
    let transcriptForPaste = "";
    let finalSaveConflict = false;
    // Provenance of ``transcriptRaw`` for the ``[trace stopLive] FINAL``
    // line. On the Deepgram path there are exactly two possible values —
    // ``envelope`` or ``ondisk-fallback`` — and which one a stop printed
    // is the whole diagnosis of that stop. Defaults to "none"; every
    // site that sets ``transcriptRaw`` updates it alongside.
    let transcriptSource: StopTranscriptSource = "none";

    if (provider === "local") {
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "35%";
        $("progressText").textContent = "35%";
      }
      // The live assist already decoded this recording while it was
      // being spoken. When it used the SAME model the final pass would
      // use, and the backend certifies that every captured second
      // reached that model, re-transcribing the whole file from scratch
      // produces the same text for a cost that grows with recording
      // length — the "sometimes it takes twenty seconds" stop.
      //
      // Adopting the live transcript is gated on proof, never on
      // optimism: a missing coverage report, any dropped window, any
      // untranscribed tail, a different assist model, or an empty
      // transcript all fall through to the full pass. That keeps
      // "no words are lost" strictly stronger than "stop is fast".
      // Only wait for the envelope when one can still plausibly arrive.
      // A stream that already errored will never produce one, and
      // blocking on the waiter's full budget there would add seconds to
      // a path that has to run the full pass regardless.
      const liveEnvelope = liveStreamErrorAtStop ? null : await liveFinalPromise();
      const decision = decideLiveTranscriptAdoption({
        envelope: liveEnvelope,
        assistModel: liveSnapshot.assistLocalModel,
        finalModel: liveSnapshot.finalLocalModel,
        framesNeverSent: wsFramesNeverSent,
      });
      if (decision.adopt) {
        console.log(
          `[trace stopLive] adopting live-assist transcript ` +
          `(model=${liveSnapshot.assistLocalModel} covered=${decision.coverage.coveredSec.toFixed(2)}s ` +
          `of ${decision.coverage.totalSec.toFixed(2)}s) — skipping full re-transcription`,
        );
        transcriptRaw = normalizeTranscriptWhitespace(String(liveEnvelope?.text || "")).trim();
        transcriptSource = "envelope";
      } else {
        console.log(`[trace stopLive] full local pass (adoption rejected: ${decision.reason})`);
        const syncOut = await runLocalFinalPass();
        transcriptRaw = String(syncOut.text || "").trim();
        transcriptSource = "ondisk-fallback";
      }
    } else if (provider === "deepgram") {
      // ── The stop path: one linear sequence, no races ──────────────
      //
      // Everything above this point has already happened, in this
      // order: the microphone was stopped, the tail hold ran, the
      // worklet barrier proved every captured PCM sample was handed
      // over, and ``{type:"finalize", framesSent, bytesSent}`` was sent
      // (PROTOCOL CONTRACT C1). What is left is one wait and one
      // delivery.
      //
      // THE BACKEND ENVELOPE IS THE ONLY SOURCE OF THE DELIVERED
      // TRANSCRIPT. The backend makes the ``final`` envelope complete
      // by construction — Deepgram finals, its own word-level interim
      // splice, the dual-stream merge, and a REST re-decode of any span
      // it still cannot account for, all from its own audio spool and
      // all before the envelope is sent (``stats.recovery`` says what
      // it re-decoded, ``finalizing.budgetMs`` is the honest bound
      // until it arrives). So the renderer assembles nothing at stop:
      // it waits for the envelope and delivers ``envelope.text``
      // verbatim.
      //
      // What used to stand here, and why it is gone: an opportunistic
      // union of an already-resolved envelope with the live preview, a
      // tail-gap arithmetic that started a parallel REST recovery, a
      // race between that recovery and the envelope, a renderer-side
      // "recovered tail" grafted onto the end, and a
      // suspiciously-short-result re-transcribe on top of all of it.
      // Five mechanisms, each of which could overrule the others, all
      // trying to own the same string. Every duplication defect of
      // 2026-09-03/04 (sessions 8c12d76e, ed79f04a, 521f9788: a clean
      // 24-word transcript delivered as 36, a 73-word one as 189) and
      // the "трёх в" mis-placement of ``a9fd3fd9`` came out of two
      // owners disagreeing about the same speech. One owner cannot
      // disagree with itself.
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "85%";
        $("progressText").textContent = "85%";
      }
      setStatusScoped(sessionUiToken, "Finalizing");

      // Step 1 — wait for the envelope, on the deadline the backend
      // announced (C3). ``waitForLiveEnvelopeWithAnnouncedBudget``
      // starts at ``LIVE_ENVELOPE_CONFIRM_MS`` and re-arms when the
      // ``finalizing`` message lands mid-wait, up to
      // ``LIVE_ENVELOPE_MAX_WAIT_MS``; it returns immediately when the
      // envelope is already on the slot, which is the common case. No
      // socket at all means no envelope can ever arrive, so there is
      // nothing to wait for.
      const tEnv = performance.now();
      const envelope = liveFinalWaiterArmed
        ? await waitForLiveEnvelopeWithAnnouncedBudget(sessionUiToken)
        : null;
      const envelopeWaitMs = performance.now() - tEnv;

      // Step 2 — one predicate decides between the two possible
      // outcomes (``envelopeMissing`` in ./envelope-deadline): the
      // envelope, or the full-audio decode of the saved recording.
      // Nothing else.
      if (!envelopeMissing(envelope)) {
        transcriptRaw = envelopeTranscript(envelope);
        transcriptSource = "envelope";
        console.log(
          `[trace stopLive] envelope waitMs=${envelopeWaitMs.toFixed(0)} ` +
          `${traceTextStats("transcript", transcriptRaw)}`,
        );
      } else {
        // The ONLY fallback: no envelope reached us at all — the socket
        // closed or errored before or during the stop, or the deadline
        // expired with no ``final``. The backend produced no reading of
        // this recording, so the renderer decodes the audio it saved,
        // through the same ``transcribe-on-disk`` chain the manual
        // Re-transcribe button uses.
        //
        // An envelope with EMPTY text and no error is NOT missing: that
        // is the backend saying the recording holds no speech, and
        // re-decoding it would spend seconds to be told so again.
        const failure = envelope?.error || getLiveStreamError(sessionUiToken) || "no final envelope";
        console.log(`[trace stopLive] envelope missing waitMs=${envelopeWaitMs.toFixed(0)} reason="${failure}"`);
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "The live stream produced no final transcript — transcribing the saved audio…",
          tone: "warning",
        }, sessionUiToken);
        transcriptRaw = await recoverFromEmptyTranscript(
          `No final envelope (${failure}).`,
        );
        transcriptSource = transcriptRaw ? "ondisk-fallback" : "none";
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: transcriptRaw
            ? "Transcribed the saved audio after the live stream produced no final transcript."
            : "Neither the live stream nor the saved audio produced a transcript.",
          tone: transcriptRaw ? "success" : "warning",
        }, sessionUiToken);
      }

      // Nothing delivered: say WHY, from the capture evidence (a mic
      // that never delivered audio reads differently to the user than a
      // room that was quiet), instead of the generic "no speech
      // detected" the shared tail would print. ``stopFailureReason``
      // owns that judgement — mic health and the session's own measured
      // silence — and is not re-derived here. Status only: this branch
      // cannot change ``transcriptRaw``.
      if (!transcriptRaw) {
        const failureReason = stopFailureReason(getSessionCanonicalLiveSourceText(sessionUiToken));
        console.log(
          `[trace stopLive] empty transcript streamingActivity=` +
          `${hasStreamingActivity(getLiveTranscriptBuffer(sessionUiToken)) ? 1 : 0}`,
        );
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: failureReason.status || "Recording completed, no speech detected.",
          tone: failureReason.tone,
        }, sessionUiToken);
      }
    } else {
      // OpenRouter (or any future non-streaming remote): transcribe from the
      // durably saved recording first. This avoids the OPFS-spool lifetime bug
      // where a lazy in-memory File outlived its backing store.
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "50%";
        $("progressText").textContent = "50%";
      }
      const previewDraft =
        (getLiveTranscriptBuffer(sessionUiToken)?.committedDisplayText || "").trim()
        || latestSourceForSave();
      if (previewDraft) {
        setStatusScoped(sessionUiToken, "Transcribing");
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "Live preview stays visible while the full-audio transcript is being finalized.",
          tone: "info",
        }, sessionUiToken);
      }
      if (!remoteApiPromise && isProviderKeyConfigured(provider)) {
        const finalAudioFile = await fetchRecoveryAudioFile();
        if (finalAudioFile) {
          remoteApiPromise = remoteJobSync(finalAudioFile, {
            provider,
            language: languageValue,
            diarize: diarizeValue,
            remoteModel: modelValue,
          });
        }
      }
      if (remoteApiPromise) {
        try {
          const syncOut = await remoteApiPromise;
          transcriptRaw = String(syncOut.text || "").trim();
          transcriptSource = "remote";
        } catch (e) {
          console.warn("Remote final transcription failed, falling back to local full-audio pass:", e);
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: "Remote full-audio pass failed. Falling back to local transcription from the saved audio.",
            tone: "warning",
          }, sessionUiToken);
          const fallbackOut = await runLocalFinalPass();
          transcriptRaw = String(fallbackOut.text || "").trim();
          transcriptSource = "ondisk-fallback";
        }
      }
      if (!transcriptRaw && (previewDraft || latestSourceForSave())) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "Remote final transcript was empty. Falling back to local transcription from the saved audio.",
          tone: "warning",
        }, sessionUiToken);
        const fallbackOut = await runLocalFinalPass();
        transcriptRaw = String(fallbackOut.text || "").trim();
        transcriptSource = transcriptRaw ? "ondisk-fallback" : "none";
      }
    }

    // The one line that says what the user was handed and where it came
    // from. ``source`` is the stop's whole diagnosis on the Deepgram
    // path: ``envelope`` (the backend's own complete reading) or
    // ``ondisk-fallback`` (no envelope arrived at all).
    //
    // ``wsFramesNeverSent`` is captured audio the renderer never handed
    // over; ``dual`` says whether the backend decoded with two Nova-3
    // streams or one; ``recovery`` is what the backend re-decoded from
    // its own spool to make the envelope complete (``stats.recovery``)
    // — invisible in the transcript, and the largest single term in how
    // long this stop took. Non-Deepgram stops have no envelope and read
    // 0/n-a.
    const finalEnvelopeStats: LiveFinalStats | undefined =
      liveFinalSlots.get(sessionUiToken)?.envelope?.stats;
    console.log(
      `[trace stopLive] FINAL ${traceTextStats("transcript", transcriptRaw)} ` +
      `source=${transcriptSource} wsFramesNeverSent=${wsFramesNeverSent} ` +
      `${describeLiveFinalStats(finalEnvelopeStats)}`,
    );
    const transcriptReadyLatencyMs = performance.now() - transcribeStartedAt;
    const noSpeechFinalStatus = "Recording completed, no speech detected.";
    const finalUiText = transcriptRaw || noSpeechFinalStatus;
    patchCurrentRecordingSummary({
      title: transcriptRaw ? _smartTitle(transcriptRaw) : provisionalTitle,
      status: transcriptRaw
        ? "Final transcript is ready. Saving audio and transcript."
        : noSpeechFinalStatus,
      tone: transcriptRaw ? "success" : "info",
      transcribeLatencyMs: transcriptReadyLatencyMs,
    }, sessionUiToken);

    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: finalUiText,
      kind: "status",
      // The provisional publish §6.8 is about: this text is what the
      // recording has BEFORE the paste upscale runs, and it must never
      // be what gets pasted.
      phase: transcriptRaw ? "upscaling" : "no-speech",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressFill").style.width = "100%";
      $("progressText").textContent = "100%";
      $("progressRow").hidden = true;
    }
    let pasteReadyText = "";
    if (transcriptRaw) {
      transcriptForPaste = await runLivePasteUpscaleWithinSla(
        transcriptRaw,
        sessionUiToken,
        { setDoneStatus: false },
      );
      pasteReadyText = transcriptForPaste || transcriptRaw;
      publishRecordingFinalSignal({
        recordingId,
        signalText: pasteReadyText,
        domText: transcriptRaw,
        kind: "transcript",
        sessionToken: sessionUiToken,
      });
    }
    setStatusScoped(sessionUiToken, "Done");
    // saveRecordingText is non-blocking for recordings list reload.
    try {
      title = _smartTitle(transcriptRaw);
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title,
        sourceText: latestSourceForSave(),
        transcriptText: transcriptRaw,
        provider,
        model: modelValue,
        language: languageValue,
        recordingCollection: RECORDING_COLLECTIONS.live,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        finalSaveConflict = true;
        patchCurrentRecordingSummary({
          title,
          status: "Transcript finished, but the original archive changed before final save. The session was not recreated in a different archive.",
          tone: "warning",
        }, sessionUiToken);
      }
    }
    patchCurrentRecordingSummary({
      title,
      status: finalSaveConflict
        ? "Transcript is ready in memory, but the original archive changed before the final save completed."
        : transcriptRaw
          ? "Final transcript is ready. Audio and transcript are both available."
          : noSpeechFinalStatus,
      tone: finalSaveConflict ? "warning" : "success",
      transcribeLatencyMs: transcriptReadyLatencyMs,
      ...(persistedRecordingName && !finalSaveConflict ? { savedName: persistedRecordingName } : { savedName: "" }),
    }, sessionUiToken);
  } catch (e) {
    console.error("Live transcription finalization failed", e);
    const safeMessage = sanitizeUiErrorMessage(e, "Transcription failed. Audio is still saved.");
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: safeMessage,
      kind: "error",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    setStatusScoped(sessionUiToken, "Error");
    let fallbackSaveConflict = false;
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
        transcriptText: "",
        provider,
        model: modelValue,
        language: languageValue,
        recordingCollection: RECORDING_COLLECTIONS.live,
      });
    } catch (saveError) {
      if (isArchiveMutationConflict(saveError)) {
        fallbackSaveConflict = true;
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: `${safeMessage} The original archive changed before fallback save completed.`,
          tone: "warning",
          transcribeLatencyMs: performance.now() - transcribeStartedAt,
        }, sessionUiToken);
      }
    }
    const latencyMs = performance.now() - transcribeStartedAt;
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: fallbackSaveConflict
        ? `${safeMessage} The original archive changed before fallback save completed.`
        : `${safeMessage} Audio is still available.`,
      tone: fallbackSaveConflict ? "warning" : "error",
      transcribeLatencyMs: latencyMs,
      ...(persistedRecordingName && !fallbackSaveConflict ? { savedName: persistedRecordingName } : { savedName: "" }),
    }, sessionUiToken);
  } finally {
    clearLiveDraft(sessionUiToken);
    micHealth.observe({ kind: "session-stop" });
    releaseStopTransitionAfterCaptureDetach();
    mark("stopLive:done");
    // The hold runs before this timer starts, so it is added back: the
    // number that matters is the whole distance from the press.
    const totalMs = performance.now() - stopT0 + tailHoldMs;
    const labels = stopTimings
      .map(([label, t], i) => {
        const prev = i > 0 ? stopTimings[i - 1][1] : 0;
        return `${label}: ${(t - prev).toFixed(0)}ms`;
      })
      .join(" → ");
    console.log(
      `[trace stopLive] total=${totalMs.toFixed(0)}ms | ` +
      `tailHold: ${tailHoldMs.toFixed(0)}ms → ${labels}`,
    );
    (window as unknown as { __transcriptorStopTimings?: unknown }).__transcriptorStopTimings = {
      totalMs,
      phases: stopTimings,
    };
  }
  } finally {
    // Usually cleared earlier once capture globals have been detached.
    // Keep this final assignment as the crash-proof fallback for exceptions
    // before that release point; `isBusy` is released only after the full
    // stop/transcribe pipeline completes.
    if (stopTransitionOwnerToken === stopTransitionToken) {
      stopTransitionInFlight = false;
      stopTransitionOwnerToken = "";
    }
    // Guarantee id is 0 even if an uncaught throw happened before the
    // in-body reset above — a stale id would confuse the post-stop
    // post-stop task guard on the next recording start.
    if (stoppedRecordingId > 0 && currentRecordingId === stoppedRecordingId) {
      currentRecordingId = 0;
      window.__transcriptorCurrentRecordingId = 0;
      window.__transcriptorIsRecording = false;
      setRecordButton(false);
    }
    // ── 1.1.22: close the live WS here, AFTER the entire transcribe
    // phase finished. See comment at the deferred-close site for the
    // rationale (avoids truncating the post-CloseStream tail). Null
    // the socket-level handlers right before close() so any in-flight
    // event that lands during the close handshake doesn't reach into
    // freshly-cleaned state. ``_wsToCloseAtEnd`` survives the
    // try-block scope because it was declared on the function body.
    try {
      if (_wsToCloseAtEnd) {
        _wsToCloseAtEnd.onopen = null;
        _wsToCloseAtEnd.onclose = null;
        _wsToCloseAtEnd.onerror = null;
        _wsToCloseAtEnd.onmessage = null;
        try { _wsToCloseAtEnd.close(); } catch { /* already closed */ }
      }
    } catch { /* defensive */ }
    if (stoppedSessionToken) {
      const slot = liveFinalSlots.get(stoppedSessionToken);
      if (slot) {
        const waiters = slot.waiters.splice(0);
        for (const waiter of waiters) {
          try {
            waiter(null);
          } catch (e) {
            console.warn("live final waiter cleanup threw", e);
          }
        }
        liveFinalSlots.delete(stoppedSessionToken);
      }
      liveStreamErrors.delete(stoppedSessionToken);
      liveTranscriptBuffers.delete(stoppedSessionToken);
      // The announced deadline belongs to the stop that just finished;
      // keeping it would leave one entry per recording for the life of
      // the process and let a stale budget reach a later session (R5).
      // Any waiter still on it (a wait that gave up on its own timer
      // just before cleanup ran) gets nothing further — the session is
      // gone, so there is nothing left to recompute a deadline for.
      finalizeBudgetSlots.delete(stoppedSessionToken);
    }
    if (stoppedSessionToken) {
      setBusy(false, stoppedSessionToken);
    } else {
      setBusy(false);
    }
  }
}

// Recording is toggled in the main process. The global hotkey and the
// in-window button are two ways to ask for the same thing; both land on
// ``toggleRecordingFromShortcut`` there, which owns the microphone
// permission prompt, the frontmost-window capture that auto-paste needs,
// the recording capsule and the busy guard. Dispatching the renderer
// event directly from the button would skip all of that and create a
// second, weaker recording path.
document.getElementById("recordToggleBtn")?.addEventListener("click", () => {
  postTitleBridgeMessage(TITLE_BRIDGE_PREFIX.recordToggle, String(Date.now()));
});

window.addEventListener("transcriptor-hotkey-toggle", () => {
  if (isRecording) {
    void stopLive(shouldAutoTranscribe(), { discard: recordingIsTooShortToKeep() });
  } else {
    void startLive();
  }
});

// Dedicated stop event for main-process stops — avoids dual-path race.
window.addEventListener("transcriptor-hotkey-stop", (ev) => {
  const requestedRecordingId = Number((ev as CustomEvent<{ recordingId?: number }>).detail?.recordingId || 0);
  if (requestedRecordingId > 0 && currentRecordingId !== requestedRecordingId) return;
  if (isRecording) {
    void stopLive(shouldAutoTranscribe(), { discard: recordingIsTooShortToKeep() });
  }
});

// Graph is intentionally dormant. The sidebar/markup/styles are removed, and
// the implementation block is kept out of the active bundle so it cannot
// allocate canvas state, register listeners, or call graph APIs.

async function initRecordingsBootstrap(): Promise<void> {
  recordingsBootstrapReady = false;
  try {
    await loadRecordings(false);
  } catch (e) {
    console.warn("Initial recordings load failed", e);
  }
  try {
    await recoverBackendAudioSessions();
  } catch (e) {
    console.warn("Recovery import failed", e);
  }
  try {
    await recoverLiveDraftIfAny();
  } catch (e) {
    console.warn("Draft recovery failed", e);
  }
  recordingsBootstrapReady = !!currentArchiveDirSnapshot();
}

// Graph interactions are disabled with the Graph view. Restore together with
// Graph markup in index.html and Graph styles in styles.css.

// Stamp the version badge on boot. The HTML at #appVersionNumber
// holds a build-time placeholder that vite/index.html templating
// can't reach without a separate build step; updating it from JS
// lets us keep desktop/package.json as the single SSOT for the
// version string. The vite.config.ts ``define`` block injects
// ``__APP_VERSION__`` at compile time so this read is a string
// literal in the bundle, not a runtime fetch.
(() => {
  const badge = document.getElementById("appVersionNumber");
  if (badge && typeof __APP_VERSION__ === "string" && __APP_VERSION__) {
    badge.textContent = __APP_VERSION__;
  }
})();

// ── Update detection (detect-only; no download/install) ─────────────────
// Level 1 of the update story: answer "is there a newer GitHub release?"
// and link to it. Silent auto-install is blocked on Apple Developer ID
// signing and stays out of scope until that exists.
// Versioned like every other key the renderer owns
// (``transcriptor.<what>.v<n>``): the suffix is what lets a build that
// changes the payload's shape ignore the previous one instead of
// misreading it. This key alone carried no version.
const UPDATE_CHECK_CACHE_KEY = "transcriptor.updateCheck.lastCheckedAt.v1";
const updateStatusEl = document.getElementById("updateCheckStatus");
const updateBtnEl = document.getElementById("updateCheckBtn") as HTMLButtonElement | null;

function renderUpdateStatus(text: string, tone: "neutral" | "ok" | "new" | "error"): void {
  if (!updateStatusEl) return;
  // Every piece of this element's state is written here — including the
  // link class. It was added by the "update available" branch below and
  // never removed by anything, so the underline styling outlived the
  // link on the next check; ``textContent`` already drops the <a>, so
  // the class was describing a child that no longer existed.
  updateStatusEl.textContent = text;
  updateStatusEl.dataset.tone = tone;
  updateStatusEl.classList.remove("update-check-status-link");
}

async function runUpdateCheck(): Promise<void> {
  if (!updateBtnEl) return;
  updateBtnEl.disabled = true;
  renderUpdateStatus("Checking…", "neutral");
  const result = await checkForUpdate(__APP_UPDATE_META__, fetch);
  try {
    localStorage.setItem(UPDATE_CHECK_CACHE_KEY, String(Date.now()));
  } catch {
    /* quota/private-mode: the throttle just resets each launch */
  }
  switch (result.status) {
    case "update-available": {
      renderUpdateStatus(`New version ${result.latest.version} available — click to open the release page.`, "new");
      // The status span itself becomes the link: one click from
      // "there is an update" to its release page. setWindowOpenHandler
      // in desktop/main.js routes target=_blank to the OS browser.
      if (updateStatusEl) {
        updateStatusEl.classList.add("update-check-status-link");
        const link = document.createElement("a");
        link.href = result.latest.htmlUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `Open release ${result.latest.version}`;
        updateStatusEl.appendChild(document.createElement("br"));
        updateStatusEl.appendChild(link);
      }
      break;
    }
    case "up-to-date":
      renderUpdateStatus(`You're up to date (v${__APP_UPDATE_META__.version}).`, "ok");
      break;
    case "unknown":
      renderUpdateStatus(`Couldn't check for updates (${result.reason}).`, "error");
      break;
  }
  updateBtnEl.disabled = false;
}

if (updateBtnEl) {
  updateBtnEl.addEventListener("click", () => {
    void runUpdateCheck();
  });
}
// Passive boot check at most once per day — silent on failure so an
// offline start never nags.
(() => {
  let lastChecked = 0;
  try {
    lastChecked = Number(localStorage.getItem(UPDATE_CHECK_CACHE_KEY)) || 0;
  } catch {
    /* storage unavailable → treat as never checked */
  }
  if (!shouldAutoCheck(Date.now(), lastChecked)) return;
  window.setTimeout(() => {
    void runUpdateCheck();
  }, 4000);
})();

applyBackendBootstrap();
// Markup defaults for auto-stop-on-silence, from UI_TOKENS. Runs before
// loadCfg replaces them with the stored configuration, and after every
// module-level declaration — UI_TOKENS is a `const`, so this cannot sit
// beside installAppearanceStateClasses() without hitting its temporal
// dead zone.
applyAutoStopSilenceBounds();
// Copy that two surfaces show — the markup carries none of it. Runs
// after applyBackendBootstrap so the accepted-formats line is written
// from the extension list the backend actually enforces.
applyStaticCopyToMarkup();

void loadCfgOnce()
  .then(async () => {
    await loadMics(false);
    scheduleLocalWarmup();
  })
  .catch((e) => {
    console.warn("Startup configuration pipeline failed", e);
    const msg = sanitizeUiErrorMessage(e, "Startup setup failed.");
    setStatus(`Startup setup failed: ${msg}`, "warning");
    showRecordSessionNotice(`Startup setup failed: ${msg}`, "warning", UI_TOKENS.notice.longMs);
  });
renderTranscriptionSelectors();
syncAutoSendEnterLabel();
populateUpscaleModelOptions();
(document.getElementById("upscaleModelSelect") as HTMLSelectElement | null)?.addEventListener(
  "change",
  () => {
    queueUiPreferencesSave();
  }
);
// Sweep any orphan ``.pcm16`` spool files left from a crashed
// previous session. Fire-and-forget; failures are logged inside
// the helper and never block app startup.
void cleanupOrphanPcmSpool();
void refreshNetworkState();
// D-009: one query at boot, and one every time the window regains focus
// — the second is what notices a grant the user just fixed in System
// Settings and switched straight back from. Mirrors the main process's
// own re-probe cadence (boot + window focus; see
// desktop/main.js ensurePasteCapabilityFresh), so the renderer's badge
// is never more than one focus away from what main already knows.
void refreshPasteCapabilityNote();
window.addEventListener("focus", () => { void refreshPasteCapabilityNote(); });
document
  .getElementById("pasteCapabilityRepair")
  ?.addEventListener("click", () => { void repairPastePermissions(); });
// Network-state poll. The Online/Offline pill lives in the topbar, so
// this runs on every view — but not while the window is hidden: the
// /api/network probe plus the /api/health round-trip is wasted work
// when nobody can see the indicator, and the main window runs with
// `backgroundThrottling: false`, so nothing else would slow it down.
const _networkPoll = createGatedPoll({
  name: "network-state",
  intervalMs: UI_TOKENS.network.refreshIntervalMs,
  shouldRun: rendererIsVisible,
  tick: () => refreshNetworkState(),
});
gatedPolls.push(_networkPoll);
// Initial arm for every registered poll. The markup has already been
// laid out by this point, so `isViewVisible` reads the real starting
// pane rather than guessing — the app opens on Live, so the
// Settings-only polls correctly stay asleep until the user goes there.
syncGatedPolls();
// An OS-level connectivity change is news now, not in ten seconds.
window.addEventListener("online", () => _networkPoll.refreshNow());
window.addEventListener("offline", () => _networkPoll.refreshNow());
// Symmetric cleanup so dev hot-reloads / explicit teardown paths don't
// leave stale handles behind — for every registered poll, not for the
// two whose authors remembered to write it.
window.addEventListener("pagehide", stopGatedPolls, { once: true });
// Race bootstrap against a 15-second wall-clock timeout so a stalled
// network mount or slow FS does not hang the boot overlay forever — the
// promise must settle for any caller that `await recordingsBootstrapPromise`
// to resume. On timeout the recordings list stays empty; the user can still
// record and the list reloads on the next manual refresh.
let recordingsBootstrapTimeoutHandle = 0;
recordingsBootstrapPromise = Promise.race([
  initRecordingsBootstrap(),
  new Promise<void>((_, rej) => {
    recordingsBootstrapTimeoutHandle = window.setTimeout(
      () => rej(new Error(`recordings bootstrap timeout (${UI_TOKENS.recordings.bootstrapTimeoutMs} ms)`)),
      UI_TOKENS.recordings.bootstrapTimeoutMs,
    );
  }),
])
  .catch((e) => { console.warn("[bootstrap]", e?.message ?? e); })
  .finally(() => {
    // The loser of a race is not cancelled by winning it. Without this
    // the timer stayed armed for the full 15 s after a bootstrap that
    // finished in 40 ms, holding its closure and keeping the process
    // from going idle.
    window.clearTimeout(recordingsBootstrapTimeoutHandle);
    recordingsBootstrapPromise = null;
  });
// Platform marker on <body> so the stylesheet can gate macOS-specific
// chrome offsets (traffic-light padding under hiddenInset). Without
// this, Windows/Linux users see a 42px dead zone at the top of the
// sidebar reserved for a title-bar area their OS already renders.
try {
  const ua = String(navigator.userAgent || "").toLowerCase();
  const platform = ua.includes("mac os x") || ua.includes("macintosh")
    ? "darwin"
    : (ua.includes("windows") ? "win32" : "linux");
  document.body.classList.add(`platform-${platform}`);
} catch { /* non-browser contexts — harmless */ }
setStatus("Idle");
setRecordButton(false);
setCurrentRecordingSummary(null);
resetRecordingViewer();
updateRecordingCopyState();

// ── Backend boot status / error display ──
//
// The boot overlay (``#bootOverlay``) starts hidden because Electron
// waits for /api/health before loading the renderer. It is still the
// canonical surface for backend startup/runtime errors: main process
// replays ``__setBackendBootError`` after a failed boot, which unhides
// the overlay with a user-actionable diagnosis.

window.__setBackendBootStatus = (msg: string) => {
  if (!msg) {
    // Empty message = boot finished successfully: retire the transient
    // "Starting backend…" pill instead of leaving it stuck for the
    // whole session.
    setStatus("Ready", "info");
    return;
  }
  const statusEl = document.getElementById("bootOverlayStatus");
  if (statusEl) statusEl.textContent = msg;
  // Mirror into the topbar status pill as a secondary signal — some
  // users keep the app on a second monitor and miss the overlay.
  setStatus(msg);
};

/**
 * Map a raw backend-startup error string to a user-actionable message.
 *
 * The backend sends us ``uvicorn`` stderr tails verbatim via
 * ``__setBackendBootError`` — those can include absolute filesystem
 * paths, Python tracebacks, or obscure OS error codes (``EADDRINUSE``,
 * ``WinError 10013``). Rendering them raw is (a) scary to non-technical
 * users, (b) info-leaky to anyone who photographs the window. We
 * classify the known families into actionable copy and keep the raw
 * text behind a "Show details" disclosure for anyone debugging.
 */
function classifyBootError(raw: string): { headline: string; detail: string } {
  const low = (raw || "").toLowerCase();
  if (!low) {
    return {
      headline: "Backend failed to start.",
      detail: "Unknown startup failure — check the main.log in the data directory.",
    };
  }
  if (low.includes("address already in use") ||
      low.includes("eaddrinuse") ||
      low.includes("winerror 10048") ||
      low.includes("only one usage of each socket address")) {
    // Do NOT name a port here. The backend scans upward from
    // TRANSCRIPTOR_PORT (default 8321) through 24 candidates before
    // falling back to an OS-assigned port, so the number that actually
    // collided is rarely 8321. Telling the user to free 8321 when the
    // conflict was on 8327 sends them chasing the wrong process; the
    // real port is in the technical-details disclosure below.
    return {
      headline: "The backend port is already in use.",
      detail: "Another copy of Transcriptor is still running. Close it via the tray icon (or reboot if that doesn't work) and try again. The exact port is in the technical details below.",
    };
  }
  if (low.includes("permission denied") ||
      low.includes("eacces") ||
      low.includes("winerror 5")) {
    return {
      headline: "Transcriptor couldn't access its data directory.",
      detail: "Check that Transcriptor's data directory is writable by your user account. On Windows, verify no antivirus is blocking %APPDATA%\\Transcriptor.",
    };
  }
  if (low.includes("no module named") || low.includes("modulenotfounderror")) {
    return {
      headline: "A Python dependency is missing.",
      detail: "The bundled runtime is incomplete. Reinstall Transcriptor from the same installer (.exe / .dmg / .AppImage) to restore it.",
    };
  }
  if (low.includes("python 3 interpreter was not found") ||
      low.includes("python: not found") ||
      low.includes("python was not found")) {
    return {
      headline: "Python 3 is required.",
      detail: "Install Python 3.10+ from python.org, then reopen Transcriptor. Linux users: `sudo apt install python3 python3-venv python3-pip`.",
    };
  }
  // Unknown family — generic copy + let the user open the log.
  return {
    headline: "Backend failed to start.",
    detail: "Open the log file from the support section below and share the tail with support, or reinstall from the latest installer.",
  };
}

window.__setBackendBootError = (msg: string) => {
  const raw = String(msg || "").trim();
  const { headline, detail } = classifyBootError(raw);
  const overlay = document.getElementById("bootOverlay");
  if (overlay) {
    _bootOverlayHidden = false;
    overlay.dataset.state = "error";
    overlay.hidden = false;
  }
  const statusEl = document.getElementById("bootOverlayStatus");
  if (statusEl) statusEl.textContent = headline;
  const detailEl = document.getElementById("bootOverlayDetail");
  if (detailEl) {
    // Render the friendly detail as the primary message, and expose
    // the raw stderr via a click-to-expand disclosure so debuggers
    // still have full context without the scary default.
    detailEl.innerHTML = "";
    const friendly = document.createElement("div");
    friendly.textContent = detail;
    detailEl.appendChild(friendly);
    if (raw && raw !== detail) {
      const details = document.createElement("details");
      details.style.marginTop = "8px";
      details.style.fontSize = "12px";
      details.style.opacity = "0.75";
      const summary = document.createElement("summary");
      summary.textContent = "Show technical details";
      summary.style.cursor = "pointer";
      const pre = document.createElement("pre");
      pre.textContent = raw;
      pre.style.whiteSpace = "pre-wrap";
      pre.style.wordBreak = "break-word";
      pre.style.marginTop = "6px";
      details.appendChild(summary);
      details.appendChild(pre);
      detailEl.appendChild(details);
    }
    detailEl.hidden = false;
  }
  const retryBtn = document.getElementById("bootOverlayRetry") as HTMLButtonElement | null;
  if (retryBtn) retryBtn.hidden = false;
  setStatus("Backend Error", "error");
  // Replace liveOutput with the friendly headline only — the raw
  // detail already lives in the boot overlay's disclosure. Previously
  // we wrote the raw stderr tail into the live-transcript pane which
  // leaked paths into the paste/copy buffer on the first Cmd+V.
  $("liveOutput").textContent = headline;
};

// Retry: reload the renderer; Electron's main process keeps the
// backend running (parent-death watchdog already cleaned any previous
// zombie) and the fresh render cycle will wait on /api/health again.
const _bootRetry = document.getElementById("bootOverlayRetry");
if (_bootRetry) {
  _bootRetry.addEventListener("click", () => {
    const statusEl = document.getElementById("bootOverlayStatus");
    if (statusEl) statusEl.textContent = "Reloading…";
    const overlay = document.getElementById("bootOverlay");
    if (overlay) {
      _bootOverlayHidden = false;
      overlay.dataset.state = "loading";
    }
    window.location.reload();
  });
}

// ══════════════════════════════════════════════════════════════════════
// ██  Upload Tab — drag-and-drop + queued batch transcription      ██
// ══════════════════════════════════════════════════════════════════════
//
// SSOT for the upload pipeline. Reuses the existing transcription
// primitives (`localJobQueued`, `remoteJobQueued`, `saveRecordingText`)
// instead of forking a parallel implementation, so any backend-side
// behaviour change (provider, language, retention) flows through to
// the upload tab automatically.
//
// Flow per file:
//   1. enqueueUploadFile(file) — validate size + insert at the top +
//      kick the bounded parallel processor.
//   2. processUploadItem(item) — provider-aware transcribe call.
//      Auto-falls back to local when the chosen remote provider has
//      no key (rather than silently failing per-item).
//   3. saveRecordingText({audioFile | audioSourcePath, …}) — persist
//      into the same archive the History tab reads, so the recording
//      shows up in History without an extra round-trip.
//   4. renderUploadQueue() — re-render the right pane.
//
// Bounded processor pool — upload/transcribe work should not serialize
// behind one long video, but it also must not saturate every backend
// worker while the user is recording.

type UploadQueueStatus = "queued" | "transcribing" | "done" | "error" | "cancelled";

interface UploadQueueSnapshotItem {
  id: string;
  displayName: string;
  sizeBytes: number;
  sourcePath?: string;
  status: UploadQueueStatus;
  text?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  completedAt?: number;
  provider?: Provider;
  model?: string;
  language?: string;
  audioDurationSec?: number;
  requestedProvider?: Provider;
  requestedLanguage?: string;
  requestedModel?: string;
  requestedDiarize?: boolean;
  savedName?: string;
  savedArchiveDir?: string;
}

interface UploadQueueStoragePayload {
  /**
   * Schema version. ``number``, not the literal ``1``: the server owns
   * this value (``UPLOAD_QUEUE_STATE_VERSION``) and the renderer echoes
   * back whatever it reported, so a backend that bumps it does not need
   * a matching renderer edit to stop being contradicted.
   */
  version: number;
  hideFinished: boolean;
  items: UploadQueueSnapshotItem[];
}

interface UploadQueueItem {
  id: string;
  file?: File;
  displayName: string;
  sizeBytes: number;
  sourcePath?: string;
  // ``stage`` is a finer-grained signal than ``status`` — multiple
  // stages share the same outer ``status`` of "transcribing" but
  // surface different labels in the queue UI:
  //   queued   → Queued
  //   uploading → Uploading … (file body in flight to backend)
  //   processing → Processing … (backend is decoding video / running
  //                Deepgram REST / OpenRouter audio model)
  //   none      → status's own label (done/error/cancelled)
  status: UploadQueueStatus;
  stage?: "queued" | "uploading" | "processing" | "done";
  /**
   * 0..1 fraction of known upload progress. Browser fetch does not
   * expose request-body progress, so this remains undefined for the
   * job-based Upload flow and the UI uses stage labels instead.
   */
  uploadProgress?: number;
  text?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  completedAt?: number;
  provider?: Provider;
  /**
   * Why the provider that actually ran is not the one that was asked
   * for. The Live path has had a sentence for this since
   * ``localFallbackReason`` was written; the queue silently swapped the
   * provider and said nothing, on all twenty files of a batch.
   */
  providerFallbackNote?: string;
  model?: string;
  language?: string;
  audioDurationSec?: number;
  requestedProvider?: Provider;
  requestedLanguage?: string;
  requestedModel?: string;
  requestedDiarize?: boolean;
  savedName?: string;
  savedArchiveDir?: string;
  abortController?: AbortController;
  cancelRequested?: boolean;
}

// The currently-selected queue item id — drives which transcript is
// shown in the right-hand Result pane. Defaults to the most-recently
// completed item; user click overrides.
let uploadSelectedId: string | null = null;

const uploadQueue: UploadQueueItem[] = [];
let uploadActiveProcessors = 0;
let uploadProcessorPumpScheduled = false;
let uploadHideFinished = false;
let uploadQueueSnapshotLoaded = false;
let uploadQueueRestorePromise: Promise<void> | null = null;
let uploadQueueSaveTimer: number | null = null;
let uploadQueueSaveInFlight: Promise<void> = Promise.resolve();
let uploadQueueSavePending = false;
let uploadQueueLastSaveOk = false;
let uploadRevealReconcileInFlight: Promise<void> | null = null;
const UPLOAD_EMPTY_TRANSCRIPT_TEXT = "[No speech captured]";
// Per-file ceiling for the Upload tab. This must match MAX_FILE_BYTES,
// which mirrors backend MAX_UPLOAD_BYTES via /api/health. Even though
// the backend later demuxes audio out of video containers, it still has
// to receive and spool the original request body first; accepting a
// larger client-side cap would only defer failure to a backend 413.
function uploadFileSizeCap(): number {
  return MAX_FILE_BYTES;
}
// Hydrated from backend ALLOWED_AUDIO_EXTS through bootstrap/health.
// Drag-drop browsers don't enforce ``accept`` so we double-check at the
// JS level once the backend-owned set is known.
const UPLOAD_ALLOWED_EXTS = ACCEPTED_AUDIO_VIDEO_EXTS;

function uploadExtensionFromName(name: string): string {
  const leaf = String(name || "").split(/[\\/]/).filter(Boolean).pop() || "";
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0 || dot >= leaf.length - 1) return "";
  return leaf.slice(dot + 1).toLowerCase();
}

function uploadFileValidationError(file: File): string {
  const cap = uploadFileSizeCap();
  if (cap > 0 && file.size > cap) {
    return `File too large (${fmtBytes(file.size)} > ${fmtBytes(cap)} cap).`;
  }
  const ext = uploadExtensionFromName(file.name);
  if (!ext) {
    return "Unsupported file type. Drop an audio or video file with a supported extension.";
  }
  if (UPLOAD_ALLOWED_EXTS.size > 0 && !UPLOAD_ALLOWED_EXTS.has(ext)) {
    return `Unsupported file type ".${ext}". Drop an audio or video file.`;
  }
  return "";
}

function normalizeUploadSourcePath(rawPath: unknown): string {
  const path = String(rawPath || "").trim();
  if (!path) return "";
  // Keep this as a UI-side sanity filter only; backend remains the
  // trust boundary and revalidates absolute path, extension, size and
  // existence before touching the filesystem.
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path)) {
    return path;
  }
  return "";
}

function uploadSourcePathFromFile(file: File): string {
  try {
    const fromBridge = window.__transcriptorFilePathForFile?.(file);
    const normalized = normalizeUploadSourcePath(fromBridge);
    if (normalized) return normalized;
  } catch (e) {
    console.debug("Upload source path bridge failed", e);
  }
  // Development/older-Electron fallback. Browser File does not define
  // this field; Electron historically did on selected files.
  return normalizeUploadSourcePath((file as unknown as { path?: string }).path);
}

function uploadPathBasename(sourcePath: string): string {
  const leaf = String(sourcePath || "").split(/[\\/]/).filter(Boolean).pop() || "";
  return leaf.trim();
}

function uploadSourcePathValidationError(sourcePath: string, sizeBytes = 0): string {
  const path = normalizeUploadSourcePath(sourcePath);
  if (!path) return "Source file path is missing. Choose the file again.";
  const cap = uploadFileSizeCap();
  if (cap > 0 && sizeBytes > cap) {
    return `File too large (${fmtBytes(sizeBytes)} > ${fmtBytes(cap)} cap).`;
  }
  const ext = uploadExtensionFromName(uploadPathBasename(path));
  if (!ext) {
    return "Unsupported file type. Choose an audio or video file with a supported extension.";
  }
  if (UPLOAD_ALLOWED_EXTS.size > 0 && !UPLOAD_ALLOWED_EXTS.has(ext)) {
    return `Unsupported file type ".${ext}". Drop an audio or video file.`;
  }
  return "";
}

function uploadItemName(item: UploadQueueItem): string {
  return String(item.displayName || item.file?.name || uploadPathBasename(item.sourcePath || "") || "Uploaded file");
}

function uploadItemSize(item: UploadQueueItem): number {
  const size = Number(item.sizeBytes || item.file?.size || 0);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function normalizeUploadProvider(value: unknown): Provider {
  const provider = String(value || "").trim();
  return provider === "local" || provider === "openrouter" || provider === "deepgram"
    ? provider
    : UI_TOKENS.upload.defaultProvider;
}

function currentUploadTranscriptionOptions(): {
  provider: Provider;
  language: string;
  diarize: boolean;
} {
  const languageSel = document.getElementById("uploadLanguage") as HTMLSelectElement | null;
  return {
    // Upload shares the unified transcription selection (SSOT) — same
    // provider+model as the Transcribe toolbar, no separate source.
    provider: readProviderSelection(),
    language: (languageSel?.value || "auto").trim() || "auto",
    diarize: !!(document.getElementById("uploadDiarize") as HTMLInputElement | null)?.checked,
  };
}

function uploadItemResultText(item: UploadQueueItem): string {
  return String(item.text || "").trim() || UPLOAD_EMPTY_TRANSCRIPT_TEXT;
}

function normalizeUploadTranscriptIdentity(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function uploadDisplayPreviewFromText(text: string, maxWords = 8): string {
  const cleaned = String(text || "").replace(/\[.*?\]/g, "").trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  let preview = words.slice(0, maxWords).join(" ");
  if (words.length > maxWords) preview += "...";
  if (preview.length > 80) preview = preview.slice(0, 77) + "...";
  return preview;
}

function extractRecordingTranscriptForUploadMatch(content: string, displayText = ""): string {
  const raw = String(content || "").trim();
  const display = String(displayText || "").trim();
  const trans = raw.match(/(?:^|\n)Transcription:\s*([\s\S]*)$/i);
  if (trans && trans[1].trim()) return trans[1].trim();
  const orig = raw.match(/(?:^|\n)Original:\s*([\s\S]*?)(?:\n\s*Transcription:|$)/i);
  if (orig && orig[1].trim()) return orig[1].trim();
  return display || raw;
}

type UploadRevealTarget = { name: string; archiveDir: string };

function normalizeTranscriptRecordingName(name: string): string {
  const raw = String(name || "").trim();
  if (!raw || raw.includes("..") || /[\\/]/.test(raw) || !raw.toLowerCase().endsWith(".txt")) return "";
  return raw;
}

/**
 * Whether the shell can actually reveal a file in the OS file manager.
 *
 * NOT ``typeof window.__transcriptorRevealRecording === "function"``:
 * the renderer installs that itself, unconditionally, at module scope,
 * so the check was always true and the "Reveal in folder" button showed
 * in a plain browser preview and silently did nothing. The preload
 * script is what proves a host is there.
 */
function hostCanRevealFiles(): boolean {
  return typeof window.__transcriptorFilePathForFile === "function";
}

function installRevealRecordingBridge(): void {
  window.__transcriptorRevealRecording = (name: string, archiveDir: string) => {
    const safe = normalizeTranscriptRecordingName(name);
    if (!safe) return;
    const payload = encodeURIComponent(
      JSON.stringify({ name: safe, archiveDir: String(archiveDir || "") }),
    );
    postTitleBridgeMessage(TITLE_BRIDGE_PREFIX.revealRecording, payload);
  };
}

function uploadRevealTarget(item: UploadQueueItem | null | undefined): UploadRevealTarget | null {
  const name = normalizeTranscriptRecordingName(String(item?.savedName || ""));
  if (!name) return null;
  return {
    name,
    archiveDir: String(item?.savedArchiveDir || currentArchiveDirSnapshot() || "").trim(),
  };
}

function revealUploadItem(item: UploadQueueItem | null | undefined): boolean {
  const target = uploadRevealTarget(item);
  const reveal = window.__transcriptorRevealRecording;
  if (!target || !reveal || !hostCanRevealFiles()) return false;
  reveal(target.name, target.archiveDir);
  return true;
}

function createUploadRevealButton(item: UploadQueueItem): HTMLButtonElement | null {
  if (!uploadRevealTarget(item) || !hostCanRevealFiles()) return null;
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost upload-queue-item-action upload-queue-item-reveal";
  btn.type = "button";
  btn.textContent = "Reveal in folder";
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    revealUploadItem(item);
  });
  return btn;
}

async function reconcileUploadQueueRevealTargetsFromArchive(): Promise<void> {
  if (uploadRevealReconcileInFlight) return uploadRevealReconcileInFlight;
  const legacyItems = uploadQueue.filter((item) =>
    item.status === "done" &&
    !uploadRevealTarget(item) &&
    !!normalizeUploadTranscriptIdentity(item.text || "")
  );
  if (!legacyItems.length) return;

  uploadRevealReconcileInFlight = (async () => {
    try {
      await ensureRecordingsArchiveReady();
      if (!currentArchiveDirSnapshot() || !recordingItems.length) return;

      const previews = new Set(
        legacyItems
          .map((item) => uploadDisplayPreviewFromText(item.text || ""))
          .filter(Boolean),
      );
      if (!previews.size) return;

      const candidateRecordings = Array.from(new Map<string, UploadRevealTarget>(
        recordingItems
          .filter((recording) => previews.has(String(recording.display_name || "")))
          .map((recording): [string, UploadRevealTarget] => [
            recordingItemKey(recording),
            { name: recording.name, archiveDir: recordingArchiveDir(recording) },
          ]),
      ).values());
      if (!candidateRecordings.length) return;

      const matchesByText = new Map<string, UploadRevealTarget[]>();
      for (const recording of candidateRecordings) {
        try {
          const params = new URLSearchParams();
          if (recording.archiveDir) params.set("archive_dir", recording.archiveDir);
          const suffix = params.toString() ? `?${params.toString()}` : "";
          const payload = await apiGet<{ content?: string; display_text?: string }>(
            "/api/recordings/" + encodeURIComponent(recording.name) + suffix,
          );
          const identity = normalizeUploadTranscriptIdentity(
            extractRecordingTranscriptForUploadMatch(
              String(payload.content || ""),
              String(payload.display_text || ""),
            ),
          );
          if (!identity) continue;
          const matches = matchesByText.get(identity) || [];
          matches.push(recording);
          matchesByText.set(identity, matches);
        } catch (e) {
          console.warn("Upload queue reveal target reconcile skipped recording", recording.name, e);
        }
      }

      let changed = false;
      for (const item of legacyItems) {
        const identity = normalizeUploadTranscriptIdentity(item.text || "");
        const matches = matchesByText.get(identity) || [];
        if (matches.length !== 1) continue;
        item.savedName = matches[0].name;
        item.savedArchiveDir = matches[0].archiveDir;
        changed = true;
      }
      if (changed) {
        saveUploadQueueSnapshot();
        renderUploadQueue();
      }
    } finally {
      uploadRevealReconcileInFlight = null;
    }
  })();
  return uploadRevealReconcileInFlight;
}

function isUploadTerminalStatus(status: UploadQueueStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isUploadPastItem(item: UploadQueueItem): boolean {
  return isUploadTerminalStatus(item.status);
}

function isUploadVisibleUnderCurrentFilter(item: UploadQueueItem): boolean {
  return !uploadHideFinished || !isUploadPastItem(item);
}

function uploadQueueSnapshotItem(item: UploadQueueItem): UploadQueueSnapshotItem {
  return {
    id: item.id,
    displayName: uploadItemName(item),
    sizeBytes: uploadItemSize(item),
    sourcePath: normalizeUploadSourcePath(item.sourcePath || ""),
    status: item.status,
    text: item.text || "",
    error: item.error || "",
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    completedAt: item.completedAt,
    provider: item.provider || "",
    model: item.model || "",
    language: item.language || "",
    audioDurationSec: Math.max(0, Number(item.audioDurationSec || 0) || 0),
    requestedProvider: item.requestedProvider || "",
    requestedModel: item.requestedModel || "",
    requestedLanguage: item.requestedLanguage || "",
    requestedDiarize: item.requestedDiarize === true,
    savedName: item.savedName || "",
    savedArchiveDir: item.savedArchiveDir || "",
  };
}

function uploadQueueSnapshotPayload(): UploadQueueStoragePayload {
  return {
    // The server's own version, remembered by ``applyUploadQueueSnapshot``
    // — the same SSOT the legacy-snapshot gate compares against. Sending a
    // duplicated literal was a second source of the same truth that only
    // stayed harmless because ``_normalize_upload_queue_state`` overwrites
    // the field on the way in.
    version: uploadQueueServerVersion,
    hideFinished: uploadHideFinished,
    items: uploadQueue
      .slice(0, uploadQueueMaxPersistedItems)
      .map(uploadQueueSnapshotItem),
  };
}

function applyUploadQueueSnapshot(payload: Partial<UploadQueueStoragePayload>): void {
  // The backend owns the queue schema version (UPLOAD_QUEUE_STATE_VERSION);
  // remember what it reported so the legacy-localStorage gate below
  // compares against the server's truth instead of a duplicated constant.
  if (typeof payload.version === "number" && payload.version > 0) {
    uploadQueueServerVersion = payload.version;
  }
  uploadHideFinished = payload.hideFinished === true;
  const restored = Array.isArray(payload.items) ? payload.items : [];
  uploadQueue.splice(0, uploadQueue.length);
  for (const src of restored.slice(0, uploadQueueMaxPersistedItems)) {
    const displayName = String(src.displayName || "").trim();
    if (!displayName) continue;
    const status = String(src.status || "error") as UploadQueueStatus;
    const interrupted = status === "queued" || status === "transcribing";
    const restoredError = interrupted
      ? "Interrupted by app restart before this file finished."
      : String(src.error || "");
    const sourcePath = normalizeUploadSourcePath(src.sourcePath || "");
    uploadQueue.push({
      id: String(src.id || createClientSessionId()),
      displayName,
      sizeBytes: Number(src.sizeBytes || 0),
      sourcePath,
      status: interrupted ? "error" : (isUploadTerminalStatus(status) ? status : "error"),
      text: String(src.text || ""),
      error: restoredError,
      startedAt: typeof src.startedAt === "number" ? src.startedAt : undefined,
      endedAt: typeof src.endedAt === "number" ? src.endedAt : undefined,
      completedAt: typeof src.completedAt === "number"
        ? src.completedAt
        : (interrupted ? Date.now() : undefined),
      // A restored snapshot is untrusted input: normalize it through the
      // same predicate as the requested provider rather than asserting
      // the type is whatever the file said.
      provider: normalizeProviderSelection(src.provider, ""),
      model: String(src.model || ""),
      language: String(src.language || ""),
      audioDurationSec: Math.max(0, Number(src.audioDurationSec || 0) || 0),
      requestedProvider: normalizeUploadProvider(src.requestedProvider || src.provider),
      requestedModel: String(src.requestedModel || ""),
      requestedLanguage: String(src.requestedLanguage || src.language || "auto"),
      requestedDiarize: src.requestedDiarize === true,
      savedName: String(src.savedName || ""),
      savedArchiveDir: String(src.savedArchiveDir || ""),
    });
  }
}

/**
 * Write the queue snapshot now.
 *
 * ``unloading`` marks the call made from ``pagehide``/``beforeunload``:
 * the browser cancels an ordinary request when the document goes away,
 * and terminal statuses are set precisely as the user closes the
 * window, so the last debounce window's changes were the ones most
 * likely to be lost. ``keepalive`` is the one flag that lets the
 * request outlive the document.
 */
async function flushUploadQueueSnapshotNow(unloading = false): Promise<void> {
  if (!uploadQueueSnapshotLoaded) return;
  if (uploadQueueSaveTimer !== null) {
    window.clearTimeout(uploadQueueSaveTimer);
    uploadQueueSaveTimer = null;
  }
  const payload = uploadQueueSnapshotPayload();
  uploadQueueSavePending = false;
  uploadQueueSaveInFlight = uploadQueueSaveInFlight
    .catch(() => undefined)
    .then(async () => {
      await apiPut<UploadQueueStoragePayload & { ok?: boolean }>(
        "/api/ui/upload-queue",
        payload,
        { keepalive: unloading },
      );
      uploadQueueLastSaveOk = true;
    })
    .catch((e) => {
      uploadQueueLastSaveOk = false;
      console.warn("Upload queue backend snapshot save failed", e);
    });
  await uploadQueueSaveInFlight;
  if (uploadQueueSavePending) {
    uploadQueueSavePending = false;
    await flushUploadQueueSnapshotNow(unloading);
  }
}

function saveUploadQueueSnapshot(): void {
  if (!uploadQueueSnapshotLoaded) return;
  uploadQueueSavePending = true;
  if (uploadQueueSaveTimer !== null) return;
  uploadQueueSaveTimer = window.setTimeout(() => {
    uploadQueueSaveTimer = null;
    void flushUploadQueueSnapshotNow();
  }, UI_TOKENS.upload.queueSaveDebounceMs);
}

function readLegacyUploadQueueSnapshot(): Partial<UploadQueueStoragePayload> | null {
  let raw = "";
  try {
    raw = localStorage.getItem(LEGACY_UPLOAD_QUEUE_STORAGE_KEY) || "";
  } catch (e) {
    console.warn("Legacy upload queue snapshot read failed", e);
    return null;
  }
  if (!raw) return null;
  let parsed: Partial<UploadQueueStoragePayload>;
  try {
    parsed = JSON.parse(raw) as Partial<UploadQueueStoragePayload>;
  } catch (e) {
    console.warn("Legacy upload queue snapshot parse failed", e);
    quarantineCorruptSnapshot(LEGACY_UPLOAD_QUEUE_CORRUPT_STORAGE_PREFIX, raw);
    return null;
  }
  // Schema gate (BUG-73): a snapshot from a NEWER schema must take the
  // corrupt-quarantine path, not flow through the old parser.
  const storedVersion = typeof parsed?.version === "number" ? parsed.version : 1;
  if (storedVersion > uploadQueueServerVersion) {
    console.warn(
      `Legacy upload queue snapshot version ${storedVersion} > supported ${uploadQueueServerVersion}, quarantining`,
    );
    quarantineCorruptSnapshot(LEGACY_UPLOAD_QUEUE_CORRUPT_STORAGE_PREFIX, raw);
    return null;
  }
  return parsed;
}

async function restoreUploadQueueSnapshot(): Promise<void> {
  let serverReadOk = false;
  try {
    const payload = await apiGet<UploadQueueStoragePayload>("/api/ui/upload-queue");
    applyUploadQueueSnapshot(payload);
    serverReadOk = true;
  } catch (e) {
    console.warn("Upload queue backend snapshot restore failed", e);
  }

  const legacy = uploadQueue.length === 0 ? readLegacyUploadQueueSnapshot() : null;
  const decision = decideUploadQueueRestore({
    serverReadOk,
    queueEmptyAfterServer: uploadQueue.length === 0,
    legacyAvailable: !!legacy,
  });
  console.log(
    `[trace uploadQueue] restore reason=${decision.reason} ` +
    `persist=${decision.persist ? 1 : 0} items=${uploadQueue.length}`,
  );

  if (!decision.markLoaded) {
    // The queue on disk is unknown, so it stays untouched: the backend
    // replaces the file wholesale on PUT and an empty write would destroy
    // every completed upload's transcript. Leaving the latch down also keeps
    // ``beginUploadQueueSnapshotRestore`` free to retry once the backend is up.
    uploadQueue.splice(0, uploadQueue.length);
    setStatus(UPLOAD_QUEUE_RESTORE_FAILED_STATUS, "warning");
    return;
  }

  if (decision.adoptLegacy && legacy) {
    applyUploadQueueSnapshot(legacy);
  }

  uploadQueueSnapshotLoaded = true;
  if (decision.persist) {
    await flushUploadQueueSnapshotNow();
  }
  if (shouldDropLegacyUploadQueueSnapshot({
    persisted: decision.persist,
    saveOk: uploadQueueLastSaveOk,
  })) {
    try {
      localStorage.removeItem(LEGACY_UPLOAD_QUEUE_STORAGE_KEY);
    } catch (e) {
      console.warn("Legacy upload queue snapshot cleanup failed", e);
    }
  }
}

function beginUploadQueueSnapshotRestore(): Promise<void> {
  if (uploadQueueSnapshotLoaded) return Promise.resolve();
  if (!uploadQueueRestorePromise) {
    uploadQueueRestorePromise = restoreUploadQueueSnapshot()
      .finally(() => {
        uploadQueueRestorePromise = null;
        renderUploadQueue();
        void reconcileUploadQueueRevealTargetsFromArchive();
      });
  }
  return uploadQueueRestorePromise;
}

function afterUploadQueueSnapshotLoaded(action: () => void): void {
  if (uploadQueueSnapshotLoaded) {
    action();
    return;
  }
  void beginUploadQueueSnapshotRestore().then(action);
}

function flushUploadQueueSnapshotBestEffort(): void {
  void flushUploadQueueSnapshotNow(true);
}

window.addEventListener("pagehide", flushUploadQueueSnapshotBestEffort, { capture: true });
window.addEventListener("beforeunload", flushUploadQueueSnapshotBestEffort, { capture: true });

function addUploadQueueItem(item: UploadQueueItem): void {
  uploadQueue.unshift(item);
  saveUploadQueueSnapshot();
}

function enqueueUploadFiles(files: File[]): void {
  if (!files.length) return;
  afterUploadQueueSnapshotLoaded(() => {
    files.forEach(enqueueUploadFile);
  });
}

/**
 * Stop the window from navigating away when a file is dropped OUTSIDE
 * the drop zone — browsers open a dropped file by default, on every
 * view, which would discard an unsaved recording.
 *
 * Installed here rather than inside ``setupUploadView`` because it is
 * process-wide and deliberately permanent: registered from inside a
 * setup function it read as a listener somebody had forgotten to
 * remove, and a second call would have installed it twice.
 */
["dragover", "drop"].forEach((ev) => {
  window.addEventListener(ev, (e) => {
    // Inside the drop zone the per-element listeners already handle it.
    if ((e.target as HTMLElement)?.closest("#uploadLargeDrop")) return;
    e.preventDefault();
    e.stopPropagation();
  });
});

function setupUploadView(): void {
  const dropZone = document.getElementById("uploadLargeDrop");
  const fileInput = document.getElementById("uploadLargeFileInput") as HTMLInputElement | null;
  // Before the element is read: the markup ships it empty, so its options
  // come from ``#language`` — one list, one place.
  fillUploadLanguageOptions();
  const language = document.getElementById("uploadLanguage") as HTMLSelectElement | null;
  const diarize = document.getElementById("uploadDiarize") as HTMLInputElement | null;
  if (!dropZone || !fileInput || !language) return;
  void beginUploadQueueSnapshotRestore();
  // Persist Upload-tab state across launches. Without this every
  // app start reset the provider to the HTML default ("Deepgram")
  // even when the user routinely worked with Local Whisper or
  // OpenRouter — silent UX regression. The autosave debouncer +
  // queueUiPreferencesSave write to /api/config in the same
  // ``preferences.ui`` payload as Live-tab settings.
  for (const mirrorId of ["uploadProviderMirror", "uploadModelMirror"]) {
    document.getElementById(mirrorId)?.addEventListener("change", () => {
      const el = document.getElementById(mirrorId) as HTMLSelectElement | null;
      setTranscriptionSelection(
        mirrorId === "uploadProviderMirror"
          ? ((el?.value || "local-whisper") as TranscriptionGroupId | "")
          : readProviderGroup(),
        mirrorId === "uploadModelMirror" ? el?.value || undefined : undefined,
      );
      updateUploadProviderHint();
    });
  }
  language.addEventListener("change", () => queueUiPreferencesSave());
  if (diarize) {
    diarize.addEventListener("change", () => queueUiPreferencesSave());
  }
  // Click anywhere on the drop zone (except interactive children) opens
  // the native file picker.
  dropZone.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a") || target.closest("input")) return;
    fileInput.click();
  });
  // Keyboard activation: drop zone has tabindex=0 + role=button.
  dropZone.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    // Allow the user to pick the SAME file twice — clearing the
    // input value re-triggers `change` on the next pick. Without
    // this, dragging the same file twice silently no-ops.
    fileInput.value = "";
    enqueueUploadFiles(files);
  });
  // Drag visual states. We want the highlight on EITHER `dragenter`
  // (first time the dragged item enters us) OR `dragover` (continuous
  // while inside) — they fire enough to keep the class set. We also
  // need `preventDefault()` on `dragover` for the browser to allow
  // the eventual `drop`.
  ["dragenter", "dragover"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("drag");
    });
  });
  dropZone.addEventListener("drop", (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    enqueueUploadFiles(Array.from(dt.files));
  });
  const clearBtn = document.getElementById("uploadQueueClearBtn") as HTMLButtonElement | null;
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      afterUploadQueueSnapshotLoaded(() => {
        // Drop only finished items so an in-flight transcription is
        // never aborted by an accidental Clear click.
        for (let i = uploadQueue.length - 1; i >= 0; i--) {
          if (isUploadTerminalStatus(uploadQueue[i].status)) {
            uploadQueue.splice(i, 1);
          }
        }
        saveUploadQueueSnapshot();
        renderUploadQueue();
      });
    });
  }
  const hideBtn = document.getElementById("uploadQueueHideBtn") as HTMLButtonElement | null;
  if (hideBtn) {
    hideBtn.addEventListener("click", () => {
      afterUploadQueueSnapshotLoaded(() => {
        uploadHideFinished = !uploadHideFinished;
        saveUploadQueueSnapshot();
        renderUploadQueue();
      });
    });
  }
  // Browse button in pane header — alternative to clicking the
  // drop zone, useful when the queue is full and the drop zone
  // has scrolled below the fold.
  const browseBtn = document.getElementById("uploadBrowseBtn");
  if (browseBtn) {
    browseBtn.addEventListener("click", () => fileInput.click());
  }
  // (The earlier ``provider.addEventListener("change", ...)`` block
  // already wires both queueUiPreferencesSave AND
  // updateUploadProviderHint. A duplicate listener here attached ANOTHER hint
  // refresh on every change, which leaked one stale-DOM-read closure
  // into the listener list per renderer reload. Removed.)
  // Provider is restored from /api/config in loadCfg(), after provider-key
  // state is known. Do not pick a "smart" startup default here: doing so
  // races the config fetch and can route the first upload through Local
  // even when the user's saved/default provider is Deepgram.
  // Mirror language preference from the global #language so users who
  // already pinned RU/EN don't have to re-pick it on every tab.
  // Offered by ``#language`` itself, not by a literal list: the codes
  // were written out a third time here, so adding a language meant
  // remembering this line. Optional chaining already covers the missing
  // element, so the try/catch that used to wrap this — with no reason
  // comment, against the policy in eslint.config.js — was guarding
  // against nothing.
  const globalLangSelect = document.getElementById("language") as HTMLSelectElement | null;
  const globalLang = (globalLangSelect?.value || "").trim();
  if (globalLang && Array.from(language.options).some((o) => o.value === globalLang)) {
    language.value = globalLang;
  }
  updateUploadProviderHint();
  renderUploadQueue();
}

function updateUploadProviderHint(): void {
  const provider = readProviderSelection();
  const group = readProviderGroup();
  const hintEl = document.getElementById("uploadProviderHint");
  if (!hintEl) return;
  if (provider === "deepgram") {
    hintEl.textContent = isProviderKeyConfigured("deepgram")
      ? "Cloud transcription via Deepgram — fastest, multi-language."
      : "Add a Deepgram key in Settings, or switch to Local for offline transcription.";
  } else if (provider === "openrouter") {
    hintEl.textContent = isProviderKeyConfigured("openrouter")
      ? "Audio transcription via OpenRouter."
      : "Add an OpenRouter key in Settings, or switch to Local for offline transcription.";
  } else if (group === "gigaam") {
    hintEl.textContent = LOCAL_ENGINE_AVAILABILITY.gigaam === true
      ? "Offline Russian transcription via GigaAM v3. No API key required."
      : "GigaAM engine is not installed — install it in Settings → Local models.";
  } else {
    hintEl.textContent = "Offline transcription via Whisper. Slower than cloud, no API key required.";
  }
}

function enqueueUploadFile(file: File): void {
  // Validation mirrors backend acceptance before we spend time
  // uploading. Retry uses the same helper so it cannot bypass the
  // first-enqueue gate.
  const sourcePath = uploadSourcePathFromFile(file);
  const uploadOptions = currentUploadTranscriptionOptions();
  const validationError = uploadFileValidationError(file);
  if (validationError) {
    addUploadQueueItem({
      id: createClientSessionId(),
      file,
      displayName: file.name,
      sizeBytes: file.size,
      sourcePath,
      status: "error",
      error: validationError,
    });
    renderUploadQueue();
    return;
  }
  addUploadQueueItem({
    id: createClientSessionId(),
    file,
    displayName: file.name,
    sizeBytes: file.size,
      sourcePath,
      status: "queued",
      requestedProvider: uploadOptions.provider,
      requestedLanguage: uploadOptions.language,
      // Snapshot at ENQUEUE time (BUG-57): the queue can sit for minutes;
      // processing-time reads would silently follow later select changes.
      requestedModel: selectedLocalModel(),
      requestedDiarize: uploadOptions.diarize,
    });
  renderUploadQueue();
  void runUploadProcessor();
}

function runUploadProcessor(): void {
  if (uploadProcessorPumpScheduled) return;
  uploadProcessorPumpScheduled = true;
  queueMicrotask(() => {
    uploadProcessorPumpScheduled = false;
    while (uploadActiveProcessors < uploadQueueMaxParallel) {
      const next = uploadQueue.find((it) => it.status === "queued");
      if (!next) break;
      uploadActiveProcessors += 1;
      void processUploadItem(next).finally(() => {
        uploadActiveProcessors = Math.max(0, uploadActiveProcessors - 1);
        saveUploadQueueSnapshot();
        runUploadProcessor();
      });
    }
  });
}

async function processUploadItem(item: UploadQueueItem): Promise<void> {
  // Cancellation guard: if the user hit Cancel before this item
  // reached the head of the queue, it's already in cancelled
  // state — don't transition it back to transcribing.
  if (item.status === "cancelled") return;
  const sourceFile = item.file || null;
  let sourcePath = normalizeUploadSourcePath(item.sourcePath || "");
  if (!sourcePath && sourceFile) {
    sourcePath = uploadSourcePathFromFile(sourceFile);
    item.sourcePath = sourcePath;
  }
  const pathValidationError = sourcePath
    ? uploadSourcePathValidationError(sourcePath, uploadItemSize(item))
    : "";
  const useSourcePath = !!sourcePath && !pathValidationError;
  if (!sourceFile && !useSourcePath) {
    item.status = "error";
    item.error = pathValidationError || "Source file is no longer available. Choose the file again to retry.";
    item.endedAt = performance.now();
    item.completedAt = Date.now();
    saveUploadQueueSnapshot();
    renderUploadQueue();
    return;
  }
  item.status = "transcribing";
  item.stage = useSourcePath ? "processing" : "uploading";
  item.cancelRequested = false;
  item.startedAt = performance.now();
  // Per-item AbortController. Threaded through every fetch so
  // the user's Stop button can yank the in-flight request even
  // if the network is mid-stream. We attach it to the item so
  // `cancelUploadItem` can find and call abort().
  item.abortController = new AbortController();
  saveUploadQueueSnapshot();
  renderUploadQueue();
  // Heuristic stage transition: ``fetch`` doesn't expose a clean
  // "request body fully sent" event in the browser, so we mark the
  // crossover from "uploading" to "processing" after a small delay
  // proportional to the file size — at typical broadband speeds,
  // 1 MB ≈ 100ms, so a 50 MB video is ~5 s of uploading. Capped at
  // 8 s so a slow link doesn't pin "uploading" forever, and the
  // backend's actual response time then takes over the "processing"
  // perception. The crossover is replaced by the real transition
  // when the response arrives below.
  const _stageCrossoverDelay = sourceFile ? Math.min(8000, Math.max(800, sourceFile.size / 10000)) : 0;
  const _stageTimer = sourceFile && !useSourcePath
    ? window.setTimeout(() => {
      if (item.status === "transcribing" && item.stage === "uploading") {
        item.stage = "processing";
        renderUploadQueue();
      }
    }, _stageCrossoverDelay)
    : 0;
  const selectedProvider = normalizeUploadProvider(item.requestedProvider || item.provider);
  // Upload is a batch workflow: if the selected remote provider is
  // unavailable or has no key, keep the file moving through Local
  // Whisper instead of failing every queued item.
  const provider = resolveEffectiveProvider(selectedProvider);
  const language = String(item.requestedLanguage || item.language || "auto").trim() || "auto";
  const diarize = item.requestedDiarize === true;
  item.provider = provider;
  // Say so. ``resolveEffectiveProvider`` routes to local when the remote
  // provider has no key or the network is down, and the Live path has
  // had a sentence for exactly this since ``localFallbackReason`` was
  // written — the queue said nothing, so a twenty-file batch swapped
  // provider twenty times in silence.
  //
  // The key check that used to stand here was unreachable: the line
  // above has already returned "local" when the key is missing, and
  // there is no await between them. Throwing for a missing key would
  // also have contradicted the batch contract stated just above it.
  item.providerFallbackNote = provider !== selectedProvider
    ? localFallbackReason(selectedProvider)
    : "";
  try {
    let text = "";
    let modelLabel = "";
    let saveAudioSourcePath = useSourcePath ? sourcePath : "";
    let consumeSaveAudioSourcePath = false;
    if (provider === "local") {
      // The user's model choice governs uploads too (BUG-29): the
      // hardcoded default silently downgraded large-v3/gigaam picks.
      // Honor the enqueue-time snapshot (BUG-57); if the requested
      // model is not usable on this machine (uninstalled engine, wiped
      // cache), fall back to a downloaded default instead of failing the
      // whole batch item — the queue's contract is to keep files moving.
      {
        const requested = String(item.requestedModel || "").trim();
        const usable = requested && LOCAL_TRANSCRIPTION_MODELS.includes(requested)
          && LOCAL_ENGINE_AVAILABILITY[(requested.startsWith("gigaam-") ? "gigaam" : "whisper")] !== false
          && (requested.startsWith("gigaam-") || isLocalModelReady(requested));
        modelLabel = usable ? requested : selectedLocalModel();
      }
      const localOpts = {
        language: resolveFastLocalLanguage(language),
        model: modelLabel,
        splitStereo: true,
        wordTimestamps: false,
        signal: item.abortController.signal,
      };
      const out = useSourcePath
        ? await localJobQueuedFromPath(sourcePath, localOpts)
        : await localJobQueued(sourceFile as File, localOpts);
      text = String(out.text || "").trim();
      item.audioDurationSec = Math.max(0, Number(out.durationSec || 0) || 0);
      if (useSourcePath && out.audioSourcePath) {
        saveAudioSourcePath = out.audioSourcePath;
        consumeSaveAudioSourcePath = true;
      }
    } else {
      modelLabel = getRemoteModelValue(provider) || "";
      const remoteOpts = {
        provider,
        language,
        diarize,
        remoteModel: modelLabel,
        signal: item.abortController.signal,
        // Upload-tab remote jobs must not hold one browser XHR open
        // for upload + ffmpeg + provider processing. Large videos can
        // legitimately run past the old 5-minute XHR ceiling; the
        // backend job owns the long work and this renderer only polls.
        onProcessingProgress: () => {
          if (item.status !== "transcribing") return;
          item.stage = "processing";
          item.uploadProgress = undefined;
          renderUploadQueue();
        },
      };
      const out = useSourcePath
        ? await remoteJobQueuedFromPath(sourcePath, remoteOpts)
        : await remoteJobQueued(sourceFile as File, remoteOpts);
      text = String(out.text || "").trim();
      item.audioDurationSec = Math.max(0, Number(out.durationSec || 0) || 0);
      if (useSourcePath && out.audioSourcePath) {
        saveAudioSourcePath = out.audioSourcePath;
        consumeSaveAudioSourcePath = true;
      }
    }
    item.model = modelLabel;
    item.language = language;
    if (item.cancelRequested) {
      item.status = "cancelled";
      item.stage = undefined;
      item.endedAt = performance.now();
      item.completedAt = Date.now();
      return;
    }
    // Persist to the History tab's archive. We pass the original
    // file so the audio is saved alongside the transcript and is
    // playable from the History row. `refreshList: true` triggers a
    // single archive reload at the end of each successful save.
    const sourceName = sourceFile?.name || uploadPathBasename(sourcePath) || uploadItemName(item);
    let saveOut: SavedRecordingRef;
    try {
      saveOut = await saveRecordingText({
        title: (sourceName.replace(/\.[^.]+$/, "") || "Uploaded file").slice(0, 80),
        sourceText: text,
        transcriptText: text,
        provider,
        model: modelLabel,
        language,
        recordingCollection: RECORDING_COLLECTIONS.uploads,
        audioFile: useSourcePath ? null : sourceFile,
        audioSourcePath: useSourcePath ? saveAudioSourcePath : "",
        consumeAudioSourcePath: useSourcePath ? consumeSaveAudioSourcePath : false,
        refreshList: true,
      });
    } catch (saveErr) {
      console.warn("Upload: saveRecordingText failed", saveErr);
      item.text = text;
      item.status = "error";
      item.stage = undefined;
      item.error = `Transcript finished, but History save failed: ${sanitizeUiErrorMessage(
        saveErr,
        "Could not save this upload to History.",
      )}`;
      item.endedAt = performance.now();
      item.completedAt = Date.now();
      return;
    }
    item.text = text;
    item.status = "done";
    item.stage = "done";
    item.endedAt = performance.now();
    item.completedAt = Date.now();
    item.savedName = String(saveOut.name || "");
    item.savedArchiveDir = String(saveOut.archiveDir || "");
    // Auto-select the just-completed item in the result pane unless
    // the user has already clicked another item — gives a clear
    // visual confirmation of "this is your transcript" without
    // them having to hunt for it.
    if (uploadSelectedId === null) {
      uploadSelectedId = item.id;
    }
  } catch (e) {
    // Distinguish user-cancelled from genuine error so the queue UI
    // shows "Cancelled" instead of "Failed" — and so the user
    // doesn't have to read a "AbortError: ..." message that's
    // basically meaningless to them.
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    if (isAbort || item.cancelRequested) {
      item.status = "cancelled";
      item.stage = undefined;
    } else {
      item.status = "error";
      item.stage = undefined;
      item.error = sanitizeUiErrorMessage(e, "Transcription failed.");
    }
    item.endedAt = performance.now();
    item.completedAt = Date.now();
  } finally {
    clearTimeout(_stageTimer);
    item.abortController = undefined;
    item.cancelRequested = false;
    renderUploadQueue();
  }
}

function uploadStatusLabel(item: UploadQueueItem): string {
  switch (item.status) {
    case "queued":
      return "Queued";
    case "transcribing":
      if (item.cancelRequested) return "Cancelling…";
      // Three labelled phases inside the outer "transcribing" status:
      //   uploading  → request body is being handed to the backend.
      //                fetch does not expose browser upload progress,
      //                so this is a stage label unless a future transport
      //                supplies a determinate fraction.
      //   processing → backend is decoding video / running provider
      //                ("Processing…" — better than a stuck percentage).
      //   none       → fallback when neither stage was set (transient
      //                window between latch and first progress event).
      if (item.stage === "uploading") {
        const pct = typeof item.uploadProgress === "number"
          ? Math.round(item.uploadProgress * 100)
          : null;
        return pct !== null ? `Uploading · ${pct}%` : "Uploading…";
      }
      if (item.stage === "processing") return "Processing…";
      return "Transcribing…";
    case "done": {
      const ms = item.endedAt && item.startedAt ? item.endedAt - item.startedAt : 0;
      return `Done · ${(ms / 1000).toFixed(1)}s`;
    }
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function formatUploadFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function removeUploadItem(id: string): void {
  const idx = uploadQueue.findIndex((it) => it.id === id);
  if (idx === -1) return;
  const item = uploadQueue[idx];
  // Don't yank an item out from under the active processor —
  // user must Cancel first, then remove. (Cancel is a separate
  // button on `transcribing` items via `cancelUploadItem`.)
  if (item.status === "transcribing") return;
  uploadQueue.splice(idx, 1);
  saveUploadQueueSnapshot();
  renderUploadQueue();
}

function cancelUploadItem(id: string): void {
  const item = uploadQueue.find((it) => it.id === id);
  if (!item) return;
  if (item.status === "queued") {
    // Not started yet — just drop it.
    item.status = "cancelled";
    item.endedAt = performance.now();
    item.completedAt = Date.now();
    saveUploadQueueSnapshot();
    renderUploadQueue();
    return;
  }
  if (item.status === "transcribing") {
    if (item.cancelRequested) return;
    item.cancelRequested = true;
    // Abort the in-flight fetch. The processor's catch will
    // see DOMException name === "AbortError" and mark it
    // cancelled (NOT error) so the queue UI distinguishes
    // user-cancelled from transcription failures.
    try { item.abortController?.abort(); } catch { /* idempotent */ }
    saveUploadQueueSnapshot();
    renderUploadQueue();
  }
}

function pickUploadRetryFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = UI_COPY.upload.fileAccept;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "0";
    input.style.opacity = "0";
    let settled = false;
    const finish = (file: File | null): void => {
      if (settled) return;
      settled = true;
      window.setTimeout(() => input.remove(), 0);
      resolve(file);
    };
    input.addEventListener("change", () => {
      finish(input.files?.[0] || null);
    }, { once: true });
    // "The user closed the dialog without choosing" used to be inferred
    // from a window ``focus`` plus a 250 ms wait — a guess that also
    // left a ``{once:true}`` listener and its closure alive until some
    // arbitrary later focus. The file input answers the question
    // itself; ``cancel`` has been in Chromium since 113 and this app
    // ships Chromium (see ``cssTarget`` in vite.config.ts).
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

function assignUploadRetryFile(item: UploadQueueItem, file: File): void {
  item.file = file;
  item.displayName = file.name;
  item.sizeBytes = file.size;
  item.sourcePath = uploadSourcePathFromFile(file);
}

async function retryUploadItem(id: string): Promise<void> {
  const item = uploadQueue.find((it) => it.id === id);
  if (!item || item.status !== "error") return;
  if (!item.file && !normalizeUploadSourcePath(item.sourcePath || "")) {
    const file = await pickUploadRetryFile();
    if (!file) return;
    assignUploadRetryFile(item, file);
  }
  const sourcePath = normalizeUploadSourcePath(item.sourcePath || "");
  const validationError = item.file
    ? uploadFileValidationError(item.file)
    : uploadSourcePathValidationError(sourcePath, uploadItemSize(item));
  if (validationError) {
    item.error = validationError;
    item.completedAt = Date.now();
    saveUploadQueueSnapshot();
    renderUploadQueue();
    return;
  }
  const uploadOptions = currentUploadTranscriptionOptions();
  item.status = "queued";
  item.stage = "queued";
  item.uploadProgress = undefined;
  item.text = "";
  item.error = "";
  item.startedAt = undefined;
  item.endedAt = undefined;
  item.completedAt = undefined;
  item.provider = undefined;
  item.model = "";
  item.language = "";
  item.audioDurationSec = 0;
  item.requestedProvider = uploadOptions.provider;
  item.requestedLanguage = uploadOptions.language;
  item.requestedModel = selectedLocalModel();
  item.requestedDiarize = uploadOptions.diarize;
  item.savedName = "";
  item.savedArchiveDir = "";
  try { item.abortController?.abort(); } catch { /* idempotent */ }
  item.abortController = undefined;
  uploadSelectedId = item.id;
  saveUploadQueueSnapshot();
  renderUploadQueue();
  renderUploadResultPane();
  runUploadProcessor();
}

/**
 * Say when the queue is longer than what will survive a restart.
 *
 * The snapshot is silently cut to ``uploadQueueMaxPersistedItems`` on
 * the way out, so items past that point — transcripts included —
 * disappear at the next launch with no warning. History states exactly
 * this kind of fact rather than hiding it (``windowStatusText``: "a
 * silently truncated list reads as data loss").
 */
function renderUploadPersistenceNote(): void {
  const pane = document.getElementById("uploadQueuePane");
  if (!pane) return;
  const limit = uploadQueueMaxPersistedItems;
  const total = uploadQueue.length;
  let node = pane.querySelector<HTMLElement>(".upload-queue-persistence");
  if (!Number.isFinite(limit) || total <= limit) {
    node?.remove();
    return;
  }
  const text = `Only the newest ${limit} of ${total} are saved for the next launch.`;
  if (!node) {
    node = document.createElement("div");
    node.className = "upload-queue-persistence hint";
    node.setAttribute("role", "status");
    pane.insertBefore(node, pane.querySelector(".upload-queue-list"));
  }
  if (node.textContent !== text) node.textContent = text;
}

function renderUploadQueue(): void {
  const list = document.getElementById("uploadQueueList") as HTMLUListElement | null;
  const empty = document.getElementById("uploadEmptyState");
  const clearBtn = document.getElementById("uploadQueueClearBtn") as HTMLButtonElement | null;
  const hideBtn = document.getElementById("uploadQueueHideBtn") as HTMLButtonElement | null;
  const titleEl = document.getElementById("uploadQueueTitle");
  if (!list || !empty || !clearBtn) return;
  const visibleItems = uploadHideFinished
    ? uploadQueue.filter((it) => !isUploadPastItem(it))
    : uploadQueue;
  renderUploadPersistenceNote();
  if (uploadQueue.length === 0) {
    // The result pane is rendered at the END of this function, and this
    // branch returns before it — so after "Clear done" emptied the queue
    // the pane kept showing the removed item's transcript and a live
    // "Reveal in folder" button still bound to it.
    uploadSelectedId = null;
    list.innerHTML = "";
    // The empty state's own copy is written once, at boot, by
    // applyStaticUiCopy — this branch only shows it. It used to
    // re-assign the title and an innerHTML sub-line on every render,
    // which was the second copy of both strings.
    empty.hidden = false;
    // Restore the default copy: the "Past queues hidden" branch below
    // writes over these same two nodes.
    applyStaticUiCopy(document);
    clearBtn.hidden = true;
    if (hideBtn) hideBtn.hidden = true;
    if (titleEl) titleEl.textContent = "Queue";
    renderUploadResultPane();
    return;
  }
  const finished = uploadQueue.filter((it) => isUploadTerminalStatus(it.status)).length;
  clearBtn.hidden = finished === 0;
  if (hideBtn) {
    hideBtn.hidden = finished === 0;
    hideBtn.textContent = uploadHideFinished ? "Show past" : "Hide past";
    hideBtn.setAttribute("aria-pressed", uploadHideFinished ? "true" : "false");
  }
  if (titleEl) {
    const total = uploadQueue.length;
    titleEl.textContent = `Queue · ${finished}/${total} done`;
  }
  empty.hidden = visibleItems.length > 0;
  if (visibleItems.length === 0) {
    const emptyTitle = empty.querySelector(".upload-empty-state-title");
    const emptySub = empty.querySelector(".upload-empty-state-sub");
    if (emptyTitle) emptyTitle.textContent = UI_COPY.upload.hiddenPastTitle;
    if (emptySub) emptySub.textContent = UI_COPY.upload.hiddenPastSub;
  }
  renderUploadPersistenceNote();
  // Clear + rebuild. Queue length is bounded by user clicks (rarely
  // > 50); full re-render is fine and avoids stale-DOM state issues
  // (per-item refs, status class drift across status transitions).
  list.innerHTML = "";
  for (const item of visibleItems) {
    const li = document.createElement("li");
    li.className = `upload-queue-item upload-queue-item--${item.status}`;
    if (item.id === uploadSelectedId) li.classList.add("is-selected");
    // Click anywhere on the item swaps the result-pane to it. The
    // per-item Stop / × button stops propagation so they don't double-
    // trigger the selection.
    li.addEventListener("click", () => {
      uploadSelectedId = item.id;
      renderUploadQueue();
      renderUploadResultPane();
    });

    const header = document.createElement("div");
    header.className = "upload-queue-item-header";

    const dot = document.createElement("span");
    const dotKind = item.status === "cancelled" ? "error" : item.status;
    dot.className = `upload-queue-status-dot upload-queue-status-dot--${dotKind}`;
    dot.setAttribute("aria-hidden", "true");
    header.appendChild(dot);

    const meta = document.createElement("div");
    meta.className = "upload-queue-item-meta";
    const name = document.createElement("span");
    name.className = "upload-queue-item-name";
    name.textContent = uploadItemName(item);
    name.title = uploadItemName(item);
    meta.appendChild(name);
    const sizeStr = formatUploadFileSize(uploadItemSize(item));
    if (sizeStr) {
      const size = document.createElement("span");
      size.className = "upload-queue-item-size";
      size.textContent = sizeStr;
      meta.appendChild(size);
    }
    header.appendChild(meta);

    const tail = document.createElement("div");
    tail.className = "upload-queue-item-tail";
    const status = document.createElement("span");
    status.className = "upload-queue-item-status";
    status.textContent = uploadStatusLabel(item);
    tail.appendChild(status);
    // Per-item action button. While transcribing → Stop (aborts
    // in-flight fetch via the item's AbortController). Otherwise →
    // Remove (drops the item from the queue, no abort needed
    // since it's already settled).
    if (item.status === "transcribing") {
      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "upload-queue-item-stop";
      stopBtn.setAttribute("aria-label", "Stop transcription");
      stopBtn.title = "Stop transcription";
      stopBtn.disabled = item.cancelRequested === true;
      stopBtn.textContent = item.cancelRequested ? "Stopping" : "Stop";
      stopBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        cancelUploadItem(item.id);
      });
      tail.appendChild(stopBtn);
    } else {
      if (item.status === "error") {
        const retrySourcePath = normalizeUploadSourcePath(item.sourcePath || "");
        const retryBlockReason = item.file
          ? uploadFileValidationError(item.file)
          : (retrySourcePath ? uploadSourcePathValidationError(retrySourcePath, uploadItemSize(item)) : "");
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "upload-queue-item-retry";
        retryBtn.textContent = "Retry";
        retryBtn.setAttribute("aria-label", "Retry transcription");
        retryBtn.title = retrySourcePath
          ? `Retry transcription from saved file path: ${retrySourcePath}`
          : (retryBlockReason || "Choose source file and retry");
        retryBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void retryUploadItem(item.id);
        });
        tail.appendChild(retryBtn);
      }
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "upload-queue-item-remove";
      removeBtn.setAttribute("aria-label", "Remove from queue");
      removeBtn.title = "Remove from queue";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeUploadItem(item.id);
      });
      tail.appendChild(removeBtn);
    }
    header.appendChild(tail);
    li.appendChild(header);

    if (item.status === "transcribing") {
      // Determinate bar only when a transport supplied a real fraction;
      // otherwise use the indeterminate animation for both upload and
      // processing so the UI does not invent progress.
      const progress = document.createElement("div");
      progress.className = "upload-queue-item-progress";
      const bar = document.createElement("div");
      const hasPct = item.stage === "uploading"
        && typeof item.uploadProgress === "number";
      if (hasPct) {
        bar.className = "upload-queue-item-progress-bar is-determinate";
        bar.style.width = `${Math.max(2, Math.round((item.uploadProgress || 0) * 100))}%`;
      } else {
        bar.className = "upload-queue-item-progress-bar";
      }
      progress.appendChild(bar);
      li.appendChild(progress);
    }

    if (item.status === "done") {
      if (item.providerFallbackNote) {
        const note = document.createElement("div");
        note.className = "upload-queue-item-note";
        note.textContent = item.providerFallbackNote;
        li.appendChild(note);
      }
      const body = document.createElement("div");
      body.className = "upload-queue-item-body";
      body.textContent = uploadItemResultText(item);
      li.appendChild(body);
      const actions = document.createElement("div");
      actions.className = "upload-queue-item-actions";
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-ghost upload-queue-item-action";
      copyBtn.type = "button";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void (async () => {
          const ok = await writeTextToClipboard(uploadItemResultText(item));
          flashButtonFeedback(copyBtn, ok ? "Copied" : "Copy failed", "Copy transcript", {
            durationMs: UI_TOKENS.feedback.flashMs,
            swapLabel: true,
          });
        })();
      });
      actions.appendChild(copyBtn);
      const revealItemBtn = createUploadRevealButton(item);
      if (revealItemBtn) actions.appendChild(revealItemBtn);
      li.appendChild(actions);
    } else if (item.status === "error" && item.error) {
      const err = document.createElement("div");
      err.className = "upload-queue-item-error";
      err.textContent = item.error;
      li.appendChild(err);
    }
    list.appendChild(li);
  }
  renderUploadResultPane();
}

// ── Upload result pane (right column) ──────────────────────────────
//
// Renders the currently-selected queue item's transcript + metadata
// + a "Reveal in folder" button that asks the Electron main process
// to open the saved transcript file in the OS file manager. Falls back
// gracefully on platforms without ``shell.showItemInFolder`` IPC.
function renderUploadResultPane(): void {
  const textEl = document.getElementById("uploadResultText");
  const metaEl = document.getElementById("uploadResultMeta");
  const titleEl = document.getElementById("uploadResultTitle");
  const copyBtn = document.getElementById("uploadResultCopyBtn") as HTMLButtonElement | null;
  const revealBtn = document.getElementById("uploadResultRevealBtn") as HTMLButtonElement | null;
  if (!textEl || !metaEl) return;
  // Resolve which item to show: explicit user selection wins; else
  // the most-recently-completed item; else nothing.
  let item: UploadQueueItem | undefined;
  if (uploadSelectedId) {
    item = uploadQueue.find((it) => it.id === uploadSelectedId);
    if (item && !isUploadVisibleUnderCurrentFilter(item)) {
      item = undefined;
    }
  }
  if (!item) {
    // Most recent done — sorted by wall-clock completion first so
    // restored queue snapshots and fresh completions share one order.
    const dones = uploadQueue.filter((it) =>
      it.status === "done" &&
      isUploadVisibleUnderCurrentFilter(it)
    );
    dones.sort((a, b) => (b.completedAt || b.endedAt || 0) - (a.completedAt || a.endedAt || 0));
    item = dones[0];
  }
  if (!item) {
    textEl.textContent = "";
    metaEl.hidden = true;
    if (titleEl) titleEl.textContent = UI_COPY.upload.resultTitleEmpty;
    if (copyBtn) copyBtn.hidden = true;
    if (revealBtn) revealBtn.hidden = true;
    return;
  }
  if (titleEl) {
    titleEl.textContent = resultPaneTitle(uploadItemName(item), UI_TOKENS.upload.resultTitleMaxChars);
  }
  if (item.status === "done") {
    const resultText = uploadItemResultText(item);
    textEl.textContent = resultText;
    metaEl.hidden = false;
    metaEl.innerHTML = "";
    const append = (k: string, v: string) => {
      if (!v) return;
      const span = document.createElement("span");
      const key = document.createElement("span");
      key.className = "upload-result-meta-key";
      key.textContent = k;
      span.appendChild(key);
      span.appendChild(document.createTextNode(v));
      metaEl.appendChild(span);
    };
    append("provider", item.provider || "");
    append("model", item.model || "");
    append("language", item.language || "");
    const audioDuration = Math.max(0, Number(item.audioDurationSec || 0) || 0);
    append("audio", audioDuration > 0 ? fmtDur(audioDuration) : "");
    const elapsed = item.endedAt && item.startedAt ? `${((item.endedAt - item.startedAt) / 1000).toFixed(1)}s` : "";
    append("elapsed", elapsed);
    append("size", formatUploadFileSize(uploadItemSize(item)));
    append("words", String(((item.text || "").match(/\S+/g) || []).length));
    if (copyBtn) {
      copyBtn.hidden = false;
      copyBtn.onclick = () => {
        void (async () => {
          const ok = await writeTextToClipboard(uploadItemResultText(item!));
          flashButtonFeedback(copyBtn, ok ? "Copied" : "Copy failed", "Copy transcript", {
            durationMs: UI_TOKENS.feedback.flashMs,
          });
        })();
      };
    }
    if (revealBtn) {
      const target = uploadRevealTarget(item);
      revealBtn.hidden = !target || !hostCanRevealFiles();
      revealBtn.onclick = () => {
        revealUploadItem(item);
      };
    }
  } else if (item.status === "error" && item.error) {
    textEl.textContent = item.error;
    metaEl.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
    if (revealBtn) revealBtn.hidden = true;
  } else {
    // queued / transcribing / cancelled — show stage label as the
    // body so the right pane mirrors the queue's per-item state.
    textEl.textContent = uploadStatusLabel(item);
    metaEl.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
    if (revealBtn) revealBtn.hidden = true;
  }
}

// Renderer-side bridge must be installed before setupUploadView(), because
// setupUploadView() immediately restores and renders persisted queue items.
installRevealRecordingBridge();
setupUploadView();

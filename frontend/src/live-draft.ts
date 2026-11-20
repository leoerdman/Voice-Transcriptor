/**
 * The crash-safety draft of a live recording: its wire shape, how a
 * stored one is read back, and the queue that writes it.
 *
 * The draft is the only thing that brings a dictation back after the
 * app dies mid-recording, so the queue's failures are not "debug":
 *
 *   • a failed CLEAR left the finished dictation's draft on disk, and the
 *     next start recovered it as a second "(Recovered)" recording of text
 *     already delivered. A clear is retried on a bounded ladder and
 *     reported when it is abandoned.
 *   • a failed PUT meant the autosave had silently stopped protecting
 *     the recording. The first failure of a streak is reported (the
 *     caller tells the user once); a later put supersedes it anyway.
 *   • a PUT whose content equals the last one that reached the backend
 *     (the 1.2 s autosave during a pause, where only the clock moved) is
 *     not sent: it used to rewrite the whole growing text on disk every
 *     tick, the backend's most frequent request.
 */

/** Bump on any breaking change to PersistedLiveDraft. */
export const LIVE_DRAFT_SCHEMA_VERSION = 2;

export interface PersistedLiveDraft {
  /**
   * Payload schema version (BUG-12). Bump on any breaking field change
   * and branch the reader on it instead of minting another LEGACY_*
   * storage key. The backend keeps the number through its round trip
   * (FG-04), so the gate in `parsePersistedLiveDraftPayload` bites for
   * backend drafts as well as for the legacy localStorage copy.
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
  model?: string;
  language?: string;
  archive_dir?: string;
  recording_collection?: string;
  updated_at?: number;
}

/**
 * Read a stored draft (backend state or the legacy localStorage blob).
 *
 * The provider is resolved HERE, once: a draft written before the field
 * existed was a local recording. It used to travel as a reader-derived
 * `provider_present` flag inside the persisted type, and the legacy
 * draft migrated to the backend lost it — the backend always echoes a
 * `provider` key — so a migrated draft whose first recovery failed was
 * recovered as provider "none" on the next start.
 */
export function parsePersistedLiveDraftPayload(
  parsed: unknown,
  warn: (message: string) => void = () => {},
): PersistedLiveDraft | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  // Schema gate (BUG-73): a payload written by a NEWER schema version
  // must not be fed through the old reader — structural coercion would
  // silently misread fields instead of taking the corrupt-quarantine
  // path. Missing version = pre-versioning legacy, accepted as v1.
  const obj = parsed as Record<string, unknown>;
  const rawVersion = obj.schema_version;
  const storedVersion = typeof rawVersion === "number" ? rawVersion : 1;
  if (!Number.isFinite(storedVersion) || storedVersion > LIVE_DRAFT_SCHEMA_VERSION) {
    warn(`live draft: schema_version ${storedVersion} > supported ${LIVE_DRAFT_SCHEMA_VERSION}, discarding`);
    return null;
  }
  // Structural type guard: every field that we use is coerced to its
  // expected type; anything unparseable degrades to empty string /
  // zero, so downstream code never sees null / arrays / wrong types in
  // fields we promise are strings.
  const pickString = (key: string): string => {
    const v = obj[key];
    return typeof v === "string" ? v : "";
  };
  const pickNumber = (key: string): number => {
    const v = obj[key];
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const providerKnown = Object.prototype.hasOwnProperty.call(obj, "provider");
  return {
    schema_version: LIVE_DRAFT_SCHEMA_VERSION,
    session_id: pickString("session_id"),
    started_at: pickNumber("started_at"),
    recording: obj.recording === true,
    timer: pickString("timer"),
    title: pickString("title"),
    source_text: pickString("source_text"),
    transcript_text: pickString("transcript_text"),
    provider: providerKnown ? pickString("provider") : "local",
    model: pickString("model"),
    language: pickString("language"),
    archive_dir: pickString("archive_dir"),
    recording_collection: pickString("recording_collection"),
    updated_at: pickNumber("updated_at"),
  };
}

/** The provider a recovered draft is saved under. */
export function recoveredDraftProvider(draft: PersistedLiveDraft): string {
  return String(draft.provider || "").trim() || "none";
}

/**
 * FG-08: may the recovery clear the draft slot after saving a recovered
 * draft?
 *
 * The slot holds ONE draft and every put replaces it wholesale. An owned
 * draft is cleared by owner (the backend refuses a clear for another
 * owner), so that is always safe. An owner-less clear is unconditional:
 * once a session of THIS run has written the slot, the slot holds that
 * session's draft, not the stale one, and an owner-less clear would wipe
 * it. Before any write, the clear is what stops the same stale draft
 * being offered at every start.
 */
export function mayClearRecoveredDraft(ownerSessionId: string, slotWrittenThisRun: boolean): boolean {
  return !!String(ownerSessionId || "").trim() || !slotWrittenThisRun;
}

/**
 * What a put changes on the backend. The clock fields move every tick
 * and are not content: the recovery reads neither the timer nor a
 * fresher `updated_at` than the last change of the text.
 */
export function liveDraftContentKey(payload: PersistedLiveDraft): string {
  const { updated_at: _updatedAt, timer: _timer, ...content } = payload;
  void _updatedAt;
  void _timer;
  return JSON.stringify(content);
}

export type LiveDraftOperation =
  | { kind: "put"; payload: PersistedLiveDraft }
  | { kind: "clear"; sessionToken: string };

export interface LiveDraftQueueDeps {
  put(payload: PersistedLiveDraft): Promise<unknown>;
  clear(sessionToken: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  /** Waits before each retry of a failed clear; its length is the retry count. */
  clearRetryDelaysMs: readonly number[];
  /** First put failure of a streak (the autosave stopped protecting the recording). */
  onPutUnavailable(error: unknown): void;
  /** A clear that failed every retry — the next start will offer this draft again. */
  onClearAbandoned(error: unknown): void;
}

export class LiveDraftOperationQueue {
  private readonly deps: LiveDraftQueueDeps;
  private readonly queue: LiveDraftOperation[] = [];
  private runner: Promise<void> | null = null;
  private lastPersistedKey: string | null = null;
  private putFailing = false;

  constructor(deps: LiveDraftQueueDeps) {
    this.deps = deps;
  }

  /**
   * Queue an operation; resolves when the queue has drained. Consecutive
   * puts collapse into the newest; a clear keeps its place, so
   * put → clear order is preserved.
   */
  enqueue(op: LiveDraftOperation): Promise<void> {
    const lastIndex = this.queue.length - 1;
    const last = lastIndex >= 0 ? this.queue[lastIndex] : null;
    if (op.kind === "put" && last?.kind === "put") {
      this.queue[lastIndex] = op;
    } else {
      this.queue.push(op);
    }
    return this.start();
  }

  get pending(): number {
    return this.queue.length;
  }

  private start(): Promise<void> {
    if (!this.runner) this.runner = this.drain();
    return this.runner;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length) {
        const op = this.queue[0];
        if (op.kind === "put") await this.runPut(op.payload);
        else await this.runClear(op.sessionToken);
      }
    } finally {
      this.runner = null;
      if (this.queue.length) void this.start();
    }
  }

  private async runPut(payload: PersistedLiveDraft): Promise<void> {
    const key = liveDraftContentKey(payload);
    if (key === this.lastPersistedKey) {
      this.queue.shift();
      return;
    }
    try {
      await this.deps.put(payload);
      this.lastPersistedKey = key;
      this.putFailing = false;
    } catch (e) {
      // Not retried: the next autosave tick carries newer content.
      if (!this.putFailing) {
        this.putFailing = true;
        this.deps.onPutUnavailable(e);
      }
    }
    this.queue.shift();
  }

  private async runClear(sessionToken: string): Promise<void> {
    const delays = this.deps.clearRetryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.deps.clear(sessionToken);
        // The backend slot is empty now: the next put must go out even
        // if it carries the same content as the last one.
        this.lastPersistedKey = null;
        break;
      } catch (e) {
        if (attempt >= delays.length) {
          this.deps.onClearAbandoned(e);
          break;
        }
        await this.deps.sleep(delays[attempt]);
      }
    }
    this.queue.shift();
  }
}

/**
 * ── Saving a take's audio off the path to the paste (``startAudioPersistence``) ──
 *
 * A live take's WAV used to be uploaded (``/api/recordings/save-with-audio``)
 * BEFORE the stop waited for the transcript and handed the FINAL signal to
 * the main process. The transcript was ready ~0.5 s after the release;
 * the paste waited another ~1–1.5 s for an upload whose only output the
 * paste does not need (OPTIMIZATION.md §3.1). The save now runs beside the
 * transcript wait, and only the steps that consume what it produces —
 * the recording's archive name for the History metadata write, the
 * recovery decode of the saved file, the archived screenshot paths of a
 * screen take — wait for it.
 *
 * What did not change, and is owned here so it cannot drift per caller:
 *
 *  - Two attempts: the configured archive folder first, then the default
 *    one. A stale custom recordings folder (renamed, permissions, drive
 *    ejected) is the common cause of a failed first save; the second
 *    attempt salvages the audio instead of losing it.
 *  - The capture spool (the OPFS file the in-memory WAV ``File`` lazily
 *    reads) is released only once the audio is durably saved. A take
 *    whose save failed keeps its spool until the stop is completely over
 *    (``releaseSpoolWhenDone``), because the stop's last-resort recovery
 *    reads that in-memory file when there is no saved one — releasing it
 *    earlier makes that file read as zero bytes.
 *  - The outcome never rejects: the caller states success or failure to
 *    the user from the outcome, it cannot be dropped as an unhandled
 *    rejection.
 */

/** What a successful save hands back; the archive names the take. */
export interface PersistedAudioRef {
  name: string;
  archiveDir: string;
}

export type AudioPersistenceOutcome<T extends PersistedAudioRef> =
  /** ``usedFallbackDir``: the configured folder failed, the default took it. */
  | { kind: "saved"; persisted: T; usedFallbackDir: boolean }
  | { kind: "failed"; message: string }
  /** No audio to save (the take captured nothing). */
  | { kind: "skipped" };

export interface AudioPersistenceDeps<T extends PersistedAudioRef> {
  /** The archive folder the session was recorded into ("" = default). */
  archiveDir: string;
  /** One upload into ``archiveDir`` ("" = the default folder). */
  save(archiveDir: string): Promise<T>;
  /** Told about each failed attempt (logging only). */
  onAttemptFailed?(archiveDir: string, error: unknown): void;
  /** Releases the capture spool. Called at most once. */
  releaseSpool(): void | Promise<void>;
}

export interface AudioPersistence<T extends PersistedAudioRef> {
  /** Settles once every attempt has run; never rejects. */
  readonly settled: Promise<AudioPersistenceOutcome<T>>;
  /**
   * The stop is over: release the spool once the save has settled, saved
   * or not. Idempotent; the spool is released once in total.
   */
  releaseSpoolWhenDone(): void;
}

/** The folders a save tries, in order: configured, then default — once each. */
export function audioSaveDirs(archiveDir: string): string[] {
  const configured = String(archiveDir || "");
  return configured ? [configured, ""] : [""];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "");
}

function onceOnly(fn: () => void | Promise<void>): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      void Promise.resolve(fn()).catch((e) => {
        console.warn("[audio-persistence] spool release failed", e);
      });
    } catch (e) {
      console.warn("[audio-persistence] spool release failed", e);
    }
  };
}

export function startAudioPersistence<T extends PersistedAudioRef>(
  deps: AudioPersistenceDeps<T>,
): AudioPersistence<T> {
  const releaseSpool = onceOnly(deps.releaseSpool);
  const run = async (): Promise<AudioPersistenceOutcome<T>> => {
    const dirs = audioSaveDirs(deps.archiveDir);
    let lastMessage = "";
    for (const dir of dirs) {
      try {
        const persisted = await deps.save(dir);
        // The upload has read the spool into the archive: it is no
        // longer the only copy of this audio.
        releaseSpool();
        return { kind: "saved", persisted, usedFallbackDir: dir !== dirs[0] };
      } catch (error) {
        lastMessage = errorMessage(error);
        try {
          deps.onAttemptFailed?.(dir, error);
        } catch (e) {
          console.warn("[audio-persistence] attempt-failure observer threw", e);
        }
      }
    }
    return { kind: "failed", message: lastMessage.trim() };
  };
  const settled = run();
  return {
    settled,
    releaseSpoolWhenDone: () => {
      void settled.then(releaseSpool, releaseSpool);
    },
  };
}

/**
 * A take with no audio file to save: nothing reads its spool (if it has
 * one), so it is released at once.
 */
export function skippedAudioPersistence<T extends PersistedAudioRef>(
  releaseSpool: () => void | Promise<void>,
): AudioPersistence<T> {
  onceOnly(releaseSpool)();
  return {
    settled: Promise.resolve({ kind: "skipped" }),
    releaseSpoolWhenDone: () => {},
  };
}

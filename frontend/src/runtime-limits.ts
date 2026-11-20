/**
 * The backend's `runtime_limits` block (bootstrap and /api/health).
 *
 * The backend owns these numbers. The renderer used to re-validate them
 * against ceilings of its own (parallel uploads ≤ 8, persisted items ≤
 * 1000) and silently keep its default for anything outside — so raising
 * a limit on the backend would have been ignored here without a word.
 * A value is accepted when it is a positive integer; anything else is
 * reported back so the caller can log it.
 */

export interface RuntimeLimits {
  uploadQueueMaxParallel?: number;
  uploadQueueMaxPersistedItems?: number;
  /** Most custom upscale presets the backend accepts (FU-13a). */
  upscaleCustomPresetLimit?: number;
  /** A Deepgram REST body at most this large is a "small" one (FU-13b). */
  deepgramSmallAudioBytes?: number;
  /** The backend's read timeout for such a body (FU-13b / FG-10). */
  deepgramSmallAudioReadTimeoutMs?: number;
  /** Keys present with a value that is not a positive integer. */
  rejected: string[];
}

function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.trunc(n);
}

export function parseRuntimeLimits(limits: unknown): RuntimeLimits {
  const out: RuntimeLimits = { rejected: [] };
  if (!limits || typeof limits !== "object") return out;
  const root = limits as Record<string, unknown>;
  const take = (key: string): number | undefined => {
    if (!(key in root)) return undefined;
    const n = positiveInteger(root[key]);
    if (n === null) {
      out.rejected.push(`${key}=${JSON.stringify(root[key])}`);
      return undefined;
    }
    return n;
  };
  const parallel = take("upload_queue_max_parallel");
  if (parallel !== undefined) out.uploadQueueMaxParallel = parallel;
  const persisted = take("upload_queue_max_persisted_items");
  if (persisted !== undefined) out.uploadQueueMaxPersistedItems = persisted;
  const presetLimit = take("upscale_custom_preset_limit");
  if (presetLimit !== undefined) out.upscaleCustomPresetLimit = presetLimit;
  const smallBytes = take("deepgram_small_audio_bytes");
  if (smallBytes !== undefined) out.deepgramSmallAudioBytes = smallBytes;
  const smallRead = take("deepgram_small_audio_read_timeout_ms");
  if (smallRead !== undefined) out.deepgramSmallAudioReadTimeoutMs = smallRead;
  return out;
}

/**
 * Is the add-preset control closed? Only on the backend's own limit: with
 * no limit known yet the control stays open and the create route remains
 * the judge (it refuses past the limit with a 400).
 */
export function customPresetLimitReached(customCount: number, limit: number | undefined): boolean {
  return limit !== undefined && customCount >= limit;
}

/**
 * How long the UI waits for a Deepgram REST request on a small body
 * before giving up: the backend's read timeout for it plus `marginMs`, so
 * the backend's own timeout — and its error text — arrives first. `null`
 * (no UI deadline of its own) for any other request, and while the
 * backend's numbers are not known.
 */
export function smallAudioUiTimeoutMs(
  provider: string,
  sizeBytes: number,
  limits: Pick<RuntimeLimits, "deepgramSmallAudioBytes" | "deepgramSmallAudioReadTimeoutMs">,
  marginMs: number,
): number | null {
  const { deepgramSmallAudioBytes: maxBytes, deepgramSmallAudioReadTimeoutMs: readMs } = limits;
  if (provider !== "deepgram" || maxBytes === undefined || readMs === undefined) return null;
  if (!(sizeBytes > 0) || sizeBytes > maxBytes) return null;
  return readMs + marginMs;
}

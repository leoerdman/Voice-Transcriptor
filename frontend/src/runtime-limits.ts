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
  return out;
}

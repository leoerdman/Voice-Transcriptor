/**
 * Decoding a recording that is already saved: the one chain (FL-08).
 *
 * Two features decode a saved recording again — the manual Re-transcribe
 * button, and stopLive when the live stream delivered no final envelope.
 * They were two implementations of the same chain (Deepgram REST, then
 * local Whisper) that had drifted: only the stop path used the in-place
 * `transcribe-on-disk` route and honoured the network probe; only
 * Re-transcribe reported which providers it tried and why they failed;
 * and a comment in stopLive claimed they were the same chain. This module
 * is the chain; the callers keep only what is genuinely theirs — the
 * stop path's latency budget, Re-transcribe's status and error copy.
 *
 * The order:
 *   1. Deepgram, when a key is configured. When the network probe says
 *      it is unreachable the step is recorded as skipped with the reason
 *      (Re-transcribe names it in its error) and no request is made.
 *      A persisted recording is decoded in place (`transcribe-on-disk`,
 *      no upload); when that fails or hears nothing — or the recording
 *      was never persisted — the audio is fetched and uploaded.
 *   2. Local Whisper on the fetched audio, unless Deepgram produced text.
 *
 * The chain never throws: every failure is an attempt with its error, so
 * a caller that has stopped waiting (the stop path's budget) cannot get an
 * unhandled rejection, and a caller that reports failures has all of them.
 * An aborted signal ends the chain before the next step.
 */

export type SavedDecodeProvider = "deepgram" | "local";
export type SavedDecodeRoute = "on-disk" | "upload" | "local" | "fetch-audio";

export interface SavedDecodeAttempt {
  provider: SavedDecodeProvider;
  route: SavedDecodeRoute;
  model: string;
  /** The text this step produced ("" = it heard nothing). Absent on failure. */
  text?: string;
  error?: unknown;
  /** Not attempted (Deepgram unreachable); `error` carries the reason. */
  skipped?: boolean;
  durMs: number;
}

export interface SavedDecodeResult {
  text: string;
  /** Who produced `text`; "" when nothing did. */
  provider: SavedDecodeProvider | "";
  /** The model of the step that produced `text`; "" when nothing did. */
  model: string;
  attempts: SavedDecodeAttempt[];
}

export interface SavedDecodePlan {
  /** The recording exists in the archive (the on-disk route applies). */
  persisted: boolean;
  /** null = no Deepgram key: the step is not part of the chain at all. */
  deepgram: { model: string; unavailableReason: string } | null;
  localModel: string;
}

export interface SavedDecodeStep {
  provider: SavedDecodeProvider;
  model: string;
  /** An earlier step failed (or was skipped) — "Deepgram failed — trying local". */
  afterFailure: boolean;
}

export interface SavedDecodeDeps<A> {
  deepgramOnDisk(signal: AbortSignal | undefined): Promise<string>;
  /** The saved audio; null when there is none to read. May throw. */
  fetchAudio(): Promise<A | null>;
  deepgramUpload(audio: A, signal: AbortSignal | undefined): Promise<string>;
  localDecode(audio: A, signal: AbortSignal | undefined): Promise<string>;
  now(): number;
  /** A provider step is about to run (status line). */
  onStep?(step: SavedDecodeStep): void;
  /** A step finished (trace log). */
  onAttempt?(attempt: SavedDecodeAttempt): void;
}

export async function runSavedRecordingDecode<A>(
  plan: SavedDecodePlan,
  deps: SavedDecodeDeps<A>,
  signal?: AbortSignal,
): Promise<SavedDecodeResult> {
  const attempts: SavedDecodeAttempt[] = [];
  const record = (a: SavedDecodeAttempt): SavedDecodeAttempt => {
    attempts.push(a);
    deps.onAttempt?.(a);
    return a;
  };
  const done = (text: string, provider: SavedDecodeProvider | "", model: string): SavedDecodeResult => ({
    text, provider, model, attempts,
  });
  const failedSoFar = () => attempts.some((a) => a.error !== undefined);

  // The audio is read at most once, and only by a step that needs it.
  let audio: Promise<A | null> | null = null;
  const readAudio = async (): Promise<A | null> => {
    if (!audio) {
      const t0 = deps.now();
      audio = deps.fetchAudio().catch((error: unknown) => {
        record({ provider: "local", route: "fetch-audio", model: "", error, durMs: deps.now() - t0 });
        return null;
      });
    }
    return audio;
  };

  const run = async (
    provider: SavedDecodeProvider,
    route: SavedDecodeRoute,
    model: string,
    work: () => Promise<string>,
  ): Promise<string> => {
    const t0 = deps.now();
    try {
      const text = String((await work()) || "").trim();
      record({ provider, route, model, text, durMs: deps.now() - t0 });
      return text;
    } catch (error) {
      record({ provider, route, model, error, durMs: deps.now() - t0 });
      return "";
    }
  };

  if (plan.deepgram) {
    const { model, unavailableReason } = plan.deepgram;
    if (unavailableReason) {
      record({ provider: "deepgram", route: plan.persisted ? "on-disk" : "upload", model, error: new Error(unavailableReason), skipped: true, durMs: 0 });
    } else {
      deps.onStep?.({ provider: "deepgram", model, afterFailure: false });
      if (plan.persisted) {
        const text = await run("deepgram", "on-disk", model, () => deps.deepgramOnDisk(signal));
        if (text) return done(text, "deepgram", model);
      }
      if (signal?.aborted) return done("", "", "");
      const file = await readAudio();
      if (file !== null) {
        const text = await run("deepgram", "upload", model, () => deps.deepgramUpload(file, signal));
        if (text) return done(text, "deepgram", model);
      }
    }
  }

  if (signal?.aborted) return done("", "", "");
  const file = await readAudio();
  if (file === null) return done("", "", "");
  if (signal?.aborted) return done("", "", "");
  deps.onStep?.({ provider: "local", model: plan.localModel, afterFailure: failedSoFar() });
  const text = await run("local", "local", plan.localModel, () => deps.localDecode(file, signal));
  return text ? done(text, "local", plan.localModel) : done("", "", "");
}

/** "Deepgram nova-3", "local Whisper large-v3" — the names Re-transcribe reports. */
export function savedDecodeAttemptLabel(a: SavedDecodeAttempt): string {
  return a.provider === "deepgram" ? `Deepgram ${a.model}` : `local Whisper ${a.model}`;
}

export type SavedDecodeFailureView =
  | { kind: "decoded" }
  | { kind: "empty"; tried: string[] }
  | {
    kind: "error";
    error: unknown;
    tried: string[];
    /** Deepgram's error when local ran after it — shown as "First: …". */
    firstError: unknown;
    localTried: boolean;
  };

/**
 * What a decode that produced no text tells the user (Re-transcribe).
 *
 * "error" when the chain ENDED in a failure: the audio could not be read,
 * or local Whisper — the last resort — failed. The message carries that
 * error, the providers tried, and Deepgram's error when both were tried
 * (otherwise a packaged-build user sees only local's failure). A Deepgram
 * failure followed by a local run that heard nothing is "empty": the
 * last step answered. `tried` names each provider once, in order.
 */
export function savedDecodeFailureView(result: SavedDecodeResult): SavedDecodeFailureView {
  if (result.text) return { kind: "decoded" };
  const tried: string[] = [];
  for (const a of result.attempts) {
    if (a.route === "fetch-audio") continue;
    const label = savedDecodeAttemptLabel(a);
    if (!tried.includes(label)) tried.push(label);
  }
  const last = result.attempts[result.attempts.length - 1];
  const endedInFailure = !!last && last.error !== undefined && (last.route === "local" || last.route === "fetch-audio");
  if (!endedInFailure) return { kind: "empty", tried };
  const deepgramErrors = result.attempts.filter((a) => a.provider === "deepgram" && a.error !== undefined);
  return {
    kind: "error",
    error: last.error,
    tried,
    firstError: tried.length > 1 && deepgramErrors.length ? deepgramErrors[deepgramErrors.length - 1].error : undefined,
    localTried: result.attempts.some((a) => a.route === "local"),
  };
}

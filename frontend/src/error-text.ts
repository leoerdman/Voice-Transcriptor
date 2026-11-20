/**
 * Readable text for a thrown value (SSOT).
 *
 * The renderer reports failures as `console.warn("context", err)`. That
 * is idiomatic and correct — except that what reaches the support log is
 * the *formatted* string, and the browser formats a caught error as
 * `[object DOMException]` or `[object Object]`. The context survives;
 * the reason does not.
 *
 * A concrete cost: every recording this app made fell back from
 * AudioWorklet to the deprecated ScriptProcessor capture path, and the
 * only evidence was
 *
 *     [renderer WARN] AudioWorklet capture init failed;
 *                     falling back to ScriptProcessor [object DOMException]
 *
 * The fallback was visible; the cause (a CSP refusing a `data:` script)
 * was not, and finding it took reading the build output rather than the
 * log that was supposed to say so.
 *
 * Fixing this at ~25 call sites would fix the 25 that exist today.
 * `installErrorAwareConsole` fixes the formatting once, for every site
 * present and future, which is the only version of this that stays
 * fixed.
 */

/** Longest rendered error text. Bounds a pathological `message`. */
export const MAX_ERROR_TEXT = 400;

/**
 * Render any thrown value as diagnostic text.
 *
 * `DOMException` and `Error` both carry `name` and `message`, and both
 * stringify uselessly through object formatting — the name is what
 * distinguishes `NotAllowedError` (permission) from `AbortError`
 * (cancelled) from `NotSupportedError` (CSP refused the module), so it
 * leads. Non-errors fall through to their own string form, which is
 * already meaningful for strings and numbers.
 */
export function describeError(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  let text: string;
  if (value instanceof Error || (typeof DOMException !== "undefined" && value instanceof DOMException)) {
    const name = String(value.name || "Error");
    const message = String(value.message || "").trim();
    text = message ? `${name}: ${message}` : name;
  } else if (typeof value === "object") {
    // A plain object formats as "[object Object]" too. Prefer its own
    // name/message pair when it has one (thrown DTOs, structured-clone
    // copies of errors across a worker boundary), else JSON.
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const message = typeof record.message === "string" ? record.message : "";
    if (name || message) {
      text = message ? `${name || "Error"}: ${message}` : name;
    } else {
      try {
        text = JSON.stringify(value) ?? String(value);
      } catch {
        text = String(value); // circular / unserialisable
      }
    }
  } else {
    text = String(value);
  }
  return text.length > MAX_ERROR_TEXT
    ? `${text.slice(0, MAX_ERROR_TEXT)}…(+${text.length - MAX_ERROR_TEXT} chars)`
    : text;
}

/** True for values the browser would render as "[object …]". */
export function needsErrorText(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Error) return true;
  if (typeof DOMException !== "undefined" && value instanceof DOMException) return true;
  return typeof value === "object";
}

type ConsoleMethod = (...args: unknown[]) => void;

export interface ConsoleLike {
  warn: ConsoleMethod;
  error: ConsoleMethod;
}

/**
 * Make `console.warn` / `console.error` render errors readably.
 *
 * Only the two levels that carry failures are wrapped, and only
 * error-shaped arguments are rewritten — strings, numbers and the
 * leading context message pass through untouched, so existing call
 * sites read exactly as before with the reason appended instead of
 * `[object DOMException]`.
 *
 * Idempotent: re-installing over an already-wrapped console is a no-op,
 * so a hot reload cannot stack wrappers and double-render.
 */
export function installErrorAwareConsole(target: ConsoleLike): void {
  const marked = target as ConsoleLike & { __transcriptorErrorAware?: boolean };
  if (marked.__transcriptorErrorAware) return;
  for (const level of ["warn", "error"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      original(...args.map((a) => (needsErrorText(a) ? describeError(a) : a)));
    };
  }
  marked.__transcriptorErrorAware = true;
}

/**
 * "Is this the browser's generic 'the request did not happen' error?"
 *
 * One question, and it was being answered in three places with three
 * different lists that had already drifted: `sanitizeUiErrorMessage`
 * matched `"networkerror when attempting to fetch resource."` as a whole
 * string, `explainNetworkError` matched `"networkerror"` as a substring
 * and additionally knew `"typeerror: load failed"`, and the upscale
 * error branch knew a third, shorter set. A comment on the second one
 * asked for it to be kept "in lockstep" with the first, which is the
 * request this function makes unnecessary.
 *
 * Two rules are load-bearing and easy to get wrong, so they are stated
 * once here:
 *
 *   * "Load failed" — WebKit's generic message — matches only as a
 *     WHOLE message. As a substring it catches real backend errors like
 *     `failed to load model 'large-v3': file not found` and answers them
 *     with advice to try a VPN.
 *   * The `ERR_*` codes are Chromium's, and are matched as substrings
 *     because they arrive embedded in longer messages.
 *
 * @param raw the message, in any case; it is lowercased here
 */
export function isGenericFetchFailure(raw: string): boolean {
  const low = String(raw || "").trim().toLowerCase();
  if (!low) return false;
  const wholeMessage = [
    "failed to fetch",
    "load failed",
    "typeerror: failed to fetch",
    "typeerror: load failed",
    "networkerror when attempting to fetch resource.",
  ];
  if (wholeMessage.includes(low)) return true;
  const embedded = [
    "typeerror: failed to fetch",
    "err_internet_disconnected",
    "err_name_not_resolved",
    "err_connection_refused",
    "err_connection_reset",
  ];
  return embedded.some((needle) => low.includes(needle));
}

/**
 * Turn a thrown value into advice the user can act on.
 *
 * Lived in ``main.tsx``, where its copy rules — which of eight Deepgram
 * failure shapes gets which sentence, and when suggesting the local
 * fallback still helps — could not be tested, and where the one caller
 * that needed a different ending edited the finished sentence with two
 * regular expressions instead.
 *
 * @param options.suggestLocalFallback whether "or switch Provider to
 *   local" is still useful advice. Re-transcribe passes false once it
 *   has ALREADY fallen back to local and local is what failed — it used
 *   to strip that clause back out with two regular expressions over the
 *   finished sentence, which is editing another function's prose from
 *   the outside and breaks the moment the prose changes.
 */
export function explainNetworkError(
  err: unknown,
  context = "",
  options: { suggestLocalFallback?: boolean } = {},
): string {
  const raw = String((err as Error)?.message || err || "").trim();
  const low = raw.toLowerCase();
  const suggestLocal = options.suggestLocalFallback !== false;
  /** ", or switch Provider to …" — omitted when local is not an option any more. */
  const orLocal = (clause: string): string => (suggestLocal ? clause : "");
  // Provider-specific branches before the generic fetch-fail catch.
  // Catch ANY message whose payload starts with "Deepgram " — the
  // backend emits ~8 different RemoteError shapes from
  // remote_deepgram_live.py and remote_deepgram.py, not just the
  // three from the pass-13 fix. Branch on HTTP sub-status first
  // so each failure mode gets its most actionable message; fall
  // through to the generic region-block hint for everything else.
  if (low.startsWith("deepgram ")) {
    const base = context ? `${context}: ` : "";
    // Missing API key takes precedence over all HTTP / network
    // branches. Backend emits "Deepgram API key is not configured"
    // (from remote_deepgram.py + main.py) or "Deepgram API key is
    // required" (from remote_deepgram_live.py). These are
    // configuration problems, not network/region problems — a VPN
    // would NOT help. The user needs to open Settings → API Keys.
    if (low.includes("api key is not configured") ||
        low.includes("api key is required") ||
        low.includes("api key is missing")) {
      return `${base}Deepgram API key is not configured. Open Settings → API Keys → Deepgram and paste your key${orLocal(', or switch Provider to "local" in Settings')}.`;
    }
    if (/\bhttp\s*40[12]\b/.test(low) || low.includes("rejected the api key")) {
      return `${base}Deepgram rejected the API key. Open Settings → API Keys → Deepgram and verify your key.`;
    }
    if (/\bhttp\s*429\b/.test(low) || low.includes("rate limit")) {
      return `${base}Deepgram rate limit exceeded. Wait a moment and try again${orLocal(', or switch Provider to "local"')}.`;
    }
    if (/\bhttp\s*402\b/.test(low) || low.includes("insufficient credits") || low.includes("out of credits")) {
      return `${base}Deepgram account is out of credits. Top up${orLocal(', or switch Provider to "local"')}.`;
    }
    if (/\bhttp\s*5\d{2}\b/.test(low)) {
      return `${base}Deepgram is temporarily unavailable (provider-side error). Try again in a minute${orLocal(', or switch Provider to "local"')}.`;
    }
    // Generic: unreachable / timeout / handshake / upstream-closed —
    // most likely a regional block. Point to VPN or local fallback.
    return `${base}Deepgram is unreachable. It may be blocked in your region — try a VPN${orLocal(', or switch Provider to "local" in Settings')}.`;
  }
  if (!isGenericFetchFailure(low)) return raw;
  const online = typeof navigator !== "undefined" ? navigator.onLine : true;
  if (!online) {
    return context
      ? `${context}: the computer appears to be offline. Check your internet connection and try again.`
      : "The computer appears to be offline. Check your internet connection and try again.";
  }
  // Online but request failed — could be our backend, or the provider
  // (Deepgram/OpenRouter). Give the user the most likely fix.
  const tail = `it may be unreachable from your region — try a VPN${orLocal(', or switch Provider to "local" in Settings')}.`;
  return context
    ? `${context}: the network request failed. If this is a remote provider (Deepgram/OpenRouter), ${tail}`
    : `Network request failed. If this is a remote provider, ${tail}`;
}

/**
 * The `detail` of a backend error body, as one readable line.
 *
 * FastAPI answers a validation failure (422) with `detail` as an ARRAY
 * of `{loc, msg, type}`; `parseError` printed the whole body as JSON
 * (`HTTP 422: {"detail":[{"loc":["body","model"],…}]}`) into the UI.
 * A string detail is used as is; the array becomes `model: field
 * required; …`; anything else stays JSON, because that is still the
 * most faithful rendering of a shape nobody planned for.
 */
export function formatErrorDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    const parts = detail.map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const { loc, msg } = item as { loc?: unknown; msg?: unknown };
      const where = Array.isArray(loc)
        ? loc.filter((p) => p !== "body" && p !== "query" && p !== "path").join(".")
        : "";
      const what = typeof msg === "string" ? msg : JSON.stringify(item);
      return where ? `${where}: ${what}` : what;
    });
    return parts.join("; ");
  }
  return JSON.stringify(detail);
}

/**
 * A refusal of a media permission — retrying will not turn it into a yes,
 * and each retry may prompt the user again.
 *
 * Decided by the DOMException NAME, which the spec fixes
 * (`NotAllowedError`; `SecurityError` for a context that may never ask).
 * The microphone path used to decide by sniffing the MESSAGE for
 * "notallowed" / "permission denied" — browser text that differs for
 * "Permission dismissed", a localized message or Electron's own wording,
 * all of which were retried three times. The message check remains only
 * for errors that are not DOMExceptions (a wrapped refusal).
 */
export function isPermissionRefusal(err: unknown): boolean {
  const name = String((err as { name?: unknown })?.name || "");
  if (name === "NotAllowedError" || name === "SecurityError") return true;
  const msg = String((err as Error)?.message || err || "").toLowerCase();
  return msg.includes("notallowed") || msg.includes("permission denied");
}

/**
 * The transcription providers this build has, declared once.
 *
 * The set was restated six times in the renderer — a label switch, a
 * display-order list (whose own comment called it "the third copy"), a
 * normaliser, the remote predicate, the key-error messages — as string
 * comparisons TypeScript could not hold together. `PROVIDERS` is keyed by
 * the wire type from ./transcription-catalog, so a provider added there
 * does not compile until it has an entry here, and everything else is
 * derived from the table.
 */
import type { WireProvider } from "./transcription-catalog";

export type ProviderId = WireProvider;
export type RemoteProviderId = Exclude<ProviderId, "local">;

interface ProviderInfo {
  label: string;
  /** Not on this machine: needs an API key and the internet. */
  remote: boolean;
}

/** Insertion order is the display order. */
const PROVIDERS: Readonly<Record<ProviderId, ProviderInfo>> = {
  local: { label: "Local", remote: false },
  openrouter: { label: "OpenRouter", remote: true },
  deepgram: { label: "Deepgram", remote: true },
};

/** Typed as strings: it orders names read from the archive, which may be anything. */
export const PROVIDER_DISPLAY_ORDER: readonly string[] = Object.keys(PROVIDERS);

export function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/**
 * A provider name for display — including the names the archive records
 * that are not providers of this build ("none", "unknown", retired ones).
 */
export function providerLabel(provider: string): string {
  const value = String(provider || "").trim().toLowerCase();
  if (!value || value === "unknown") return "Unknown";
  if (value === "none") return "None";
  return isProviderId(value) ? PROVIDERS[value].label : provider;
}

export function isRemoteProvider(provider: WireProvider): provider is RemoteProviderId {
  return PROVIDERS[provider].remote;
}

/**
 * A stored selection read back: a provider of this build, or the fallback.
 *
 * FU-15 (user decision 2026-11-20: remove None). The Live toolbar used to
 * offer "None" and persisted it as ``provider: ""``; it is gone, so a
 * stored "" — from a build that still had it, or anything unrecognised —
 * migrates to the fallback (the default provider) here, at the one place
 * a stored provider is read. The next autosave writes the migrated value.
 */
export function normalizeProviderSelection(value: unknown, fallback: WireProvider = "local"): WireProvider {
  const provider = String(value ?? "").trim();
  return isProviderId(provider) ? provider : fallback;
}

export function providerKeyErrorMessage(provider: WireProvider): string {
  if (!isRemoteProvider(provider)) return "Provider API key is not configured.";
  return `${PROVIDERS[provider].label} API key is not configured. Add it in Settings -> API Keys.`;
}

/**
 * The provider a remote request is billed to. Three request builders used
 * `provider || "openrouter"`: a selection that was not remote was
 * silently sent to a paid provider. Anything that is not a remote
 * provider is refused.
 */
export function requireRemoteProvider(provider: WireProvider): RemoteProviderId {
  if (!isRemoteProvider(provider)) {
    throw new Error(`A remote transcription needs a remote provider, got "${provider}".`);
  }
  return provider;
}

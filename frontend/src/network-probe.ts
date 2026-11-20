/**
 * What the 10 s connectivity probe concludes.
 *
 * The probe asks two different questions of two same-origin endpoints:
 * `/api/health` — "is the app's own backend answering?" — and
 * `/api/network` — "can the backend reach the internet?". Every failure
 * of either used to land in one `catch` that declared the INTERNET
 * offline: a backend restart turned the pill to "Offline / Internet
 * unavailable" (the user hunted for a network problem) and flipped
 * provider routing to local, all without a log line.
 *
 * Only `/api/network` answering `online: false` means offline now. A
 * backend that does not answer is its own state and leaves the last
 * known internet state alone; a failure after the backend did answer is
 * logged and changes nothing.
 */

export type NetworkProbeOutcome =
  | { kind: "health-failed" }
  | { kind: "network-failed" }
  | { kind: "network-not-ok" }
  | { kind: "network"; online: unknown; latencyMs: number | null };

export interface NetworkVerdict {
  backendReachable: boolean;
  /** `null` = no new information: keep the last known internet state. */
  internetOnline: boolean | null;
  latencyMs: number | null;
}

export function networkVerdict(outcome: NetworkProbeOutcome): NetworkVerdict {
  switch (outcome.kind) {
    case "health-failed":
      return { backendReachable: false, internetOnline: null, latencyMs: null };
    case "network-failed":
      return { backendReachable: true, internetOnline: null, latencyMs: null };
    case "network-not-ok":
      // The backend answered but declined the probe (rate limit): it is
      // up, and an unanswered probe is not evidence of being offline.
      return { backendReachable: true, internetOnline: true, latencyMs: null };
    case "network":
      return { backendReachable: true, internetOnline: outcome.online !== false, latencyMs: outcome.latencyMs };
  }
}

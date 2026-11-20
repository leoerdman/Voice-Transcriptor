/**
 * The one notice that reports a startup recovery of interrupted live
 * recordings (`recoverBackendAudioSessions`).
 *
 * Failures used to be reported only when NOTHING succeeded
 * (`failed > 0 && succeeded === 0`): with two recovered and one failed
 * the user read "Recovered 2…" and the failure lived in the console,
 * while the spool that could not be promoted stays on disk and is tried
 * again at every start. Both counts are reported now, in one sentence,
 * and the tab is called by its name (History, not "Recordings").
 */

export interface RecoverySummary {
  text: string;
  tone: "success" | "warning";
}

const recordings = (n: number): string => `${n} interrupted recording${n === 1 ? "" : "s"}`;

export function recoverySummary(succeeded: number, failed: number): RecoverySummary | null {
  const ok = Math.max(0, Math.trunc(Number(succeeded) || 0));
  const bad = Math.max(0, Math.trunc(Number(failed) || 0));
  if (!ok && !bad) return null;
  const retry = `${bad === 1 ? "It stays" : "They stay"} on disk and will be tried again at the next start.`;
  if (!bad) return { text: `Recovered ${recordings(ok)} into History.`, tone: "success" };
  if (!ok) return { text: `Could not recover ${recordings(bad)}. ${retry}`, tone: "warning" };
  return {
    text: `Recovered ${recordings(ok)} into History; ${bad} could not be recovered. ${retry}`,
    tone: "warning",
  };
}

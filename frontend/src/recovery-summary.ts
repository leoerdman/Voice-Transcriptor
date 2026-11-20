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

/**
 * @param withoutScreens  recovered screen takes whose screenshots could not
 *   be attached (the promotion's `screens_error`, M3) — recovered, but not
 *   whole, so the summary says so instead of reporting a plain success.
 */
export function recoverySummary(succeeded: number, failed: number, withoutScreens = 0): RecoverySummary | null {
  const ok = Math.max(0, Math.trunc(Number(succeeded) || 0));
  const bad = Math.max(0, Math.trunc(Number(failed) || 0));
  const noScreens = Math.min(ok, Math.max(0, Math.trunc(Number(withoutScreens) || 0)));
  if (!ok && !bad) return null;
  const retry = `${bad === 1 ? "It stays" : "They stay"} on disk and will be tried again at the next start.`;
  const screens = !noScreens
    ? ""
    : noScreens === ok
      ? ` ${ok === 1 ? "Its" : "Their"} screenshots could not be attached.`
      : ` The screenshots of ${noScreens} of them could not be attached.`;
  if (!bad) {
    return { text: `Recovered ${recordings(ok)} into History.${screens}`, tone: noScreens ? "warning" : "success" };
  }
  if (!ok) return { text: `Could not recover ${recordings(bad)}. ${retry}`, tone: "warning" };
  return {
    text: `Recovered ${recordings(ok)} into History; ${bad} could not be recovered. ${retry}${screens}`,
    tone: "warning",
  };
}

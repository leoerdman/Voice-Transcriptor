/**
 * The start-path trace: one line per recording, press → first captured
 * audio frame, that says what the user actually waited for.
 *
 * The start no longer runs as one chain. Three branches begin at the
 * press and run side by side (./live-start):
 *
 *   mic     — open the input device, verify it against a fresh device
 *             list, reopen it if the list named another one;
 *   graph   — the AudioContext and the capture worklet module;
 *   session — the archive folder, the socket, the session state.
 *
 * The capture connects when the LAST of them is done, and the frames
 * follow (the ``capture`` branch). Anything else the start sets going —
 * the capture storage, the previous draft's read, the device list when
 * it answered before the microphone — is ``side``: nothing waits for it.
 *
 * "Time since the previous mark" across interleaved branches says
 * nothing (a storage open finishing during the microphone open used to
 * appear as a 111 ms step of its own, with the microphone credited only
 * the remainder). So the line is built from the one chain that set the
 * total — the branch that finished last, then the capture — and lists
 * the rest separately:
 *
 *   [trace startLive] total=Nms to first audio frame warm=W preRollMs=P
 *     | <critical chain: label: Nms → …>
 *     || branches: mic=Nms graph=Nms session=Nms critical=<branch>
 *     | off-path: label@Nms …
 *
 * The chain's steps are deltas and add up to ``total``; ``branches``
 * gives each branch's finish time measured from the press; ``off-path``
 * gives every other mark's time from the press. Only the chain uses the
 * ``label: Nms`` form, so a reader that sums ``(\w+): (\d+)ms`` after
 * the first ``|`` gets the critical path and nothing else.
 */

export type StartBranch = "mic" | "graph" | "session" | "capture" | "side";

/** The branches the capture connect waits for, in the order they are printed. */
export const JOINED_START_BRANCHES = ["mic", "graph", "session"] as const;
type JoinedBranch = typeof JOINED_START_BRANCHES[number];

export interface StartMark {
  label: string;
  branch: StartBranch;
  /** Milliseconds since the press. */
  atMs: number;
}

export interface StartTraceSummary {
  totalMs: number;
  /** The branch that finished last before the capture connected. */
  critical: JoinedBranch | null;
  /** The steps the total is made of, as ``[label, deltaMs]``. */
  chain: Array<[string, number]>;
  /** Finish time of each joined branch that ran, from the press. */
  branches: Partial<Record<JoinedBranch, number>>;
  /** Every mark not on the chain, in time order. */
  offPath: StartMark[];
  /** Everything after the first ``|`` of the trace line. */
  detail: string;
}

const ms = (v: number): string => `${Math.max(0, v).toFixed(0)}ms`;

/**
 * Build the summary for a start whose first frame arrived ``totalMs``
 * after the press. ``marks`` are in the order they were recorded and
 * must include the ``first-frame`` mark of the ``capture`` branch.
 */
export function summarizeStartTrace(marks: readonly StartMark[], totalMs: number): StartTraceSummary {
  const branches: Partial<Record<JoinedBranch, number>> = {};
  for (const m of marks) {
    if ((JOINED_START_BRANCHES as readonly string[]).includes(m.branch)) {
      const b = m.branch as JoinedBranch;
      branches[b] = Math.max(branches[b] ?? 0, m.atMs);
    }
  }
  let critical: JoinedBranch | null = null;
  for (const b of JOINED_START_BRANCHES) {
    const end = branches[b];
    if (end === undefined) continue;
    if (critical === null || end > (branches[critical] ?? 0)) critical = b;
  }
  const onChain = (m: StartMark): boolean => m.branch === "capture" || m.branch === critical;
  const chainMarks = marks.filter(onChain).slice().sort((a, b) => a.atMs - b.atMs);
  const chain: Array<[string, number]> = [];
  let prev = 0;
  for (const m of chainMarks) {
    chain.push([m.label, m.atMs - prev]);
    prev = m.atMs;
  }
  const offPath = marks.filter((m) => !onChain(m)).slice().sort((a, b) => a.atMs - b.atMs);
  const parts = [chain.map(([label, d]) => `${label}: ${ms(d)}`).join(" → ")];
  const branchText = JOINED_START_BRANCHES
    .filter((b) => branches[b] !== undefined)
    .map((b) => `${b}=${ms(branches[b] ?? 0)}`);
  if (branchText.length) parts.push(`|| branches: ${branchText.join(" ")} critical=${critical ?? "none"}`);
  if (offPath.length) parts.push(`| off-path: ${offPath.map((m) => `${m.label}@${ms(m.atMs)}`).join(" ")}`);
  return { totalMs, critical, chain, branches, offPath, detail: parts.join(" ") };
}

/**
 * The order of a recording's start: what runs beside what between the
 * press and the first captured frame.
 *
 * Measured over 1 175 cold starts in the support logs, the press waited
 * on a chain: the archive folder, the session set-up and the socket, the
 * device list, the microphone, then the AudioContext and the capture
 * worklet — each awaited after the one before (TASKS_2026-11-23 P2-4).
 * Only one link of it is physical: the microphone has to be open before
 * there is a frame. So the start is three branches that begin at the
 * press (see ./start-trace for how the trace line reports them):
 *
 *   mic     — open the device chosen from the list known at the press,
 *             and re-enumerate beside it; if the fresh list chooses
 *             another device, open that one instead;
 *   graph   — the AudioContext and the worklet module, which need no
 *             stream.
 *
 * Both run ahead of a fresh device list only when ``planColdCapture``
 * says nothing Bluetooth can be on the path; otherwise the list is read
 * first, then the device opened, then the graph built — the old order.
 * The third branch always runs beside them:
 *
 *   session — everything the frames need a home for: the archive folder,
 *             the socket, the capture storage, the session state.
 *
 * The capture connects once all three are done. A frame that arrives
 * before the socket or the storage is ready is already held by their own
 * buffers (./pending-ws-frames, ./deferred-pcm-sink), which is what lets
 * the session branch run beside the microphone at all.
 *
 * Pure orchestration: the resources are ``main.tsx``'s, handed in as
 * functions, so the order is tested without a microphone
 * (tests/live-start.test.ts).
 */

import {
  isBluetoothInputLabel,
  opensSystemDefault,
  systemDefaultInput,
  type InputDeviceInfo,
} from "./capture-warm";
import type { StartBranch } from "./start-trace";

/**
 * Record a start phase. ``at`` (on the caller's clock, see
 * ``ColdCaptureDeps.now``) is for a mark set after the moment it records.
 */
export type StartMarker = (label: string, branch: StartBranch, at?: number) => void;

export interface LiveStartSteps<Capture, Session> {
  /**
   * Set the capture going. Called first, at the press, and must not
   * wait for anything: what it starts runs while the session is set up.
   */
  beginCapture(): Capture;
  /**
   * Everything the frames need a home for. ``null`` ends the start here
   * (the step has already said why).
   */
  prepareSession(): Promise<Session | null>;
  /** Join the two and connect the capture. Owns the capture from here. */
  connect(session: Session, capture: Capture): Promise<void>;
  /** The capture will never be connected: release what it opened. */
  abandonCapture(capture: Capture): void;
}

export async function runLiveStart<Capture, Session>(steps: LiveStartSteps<Capture, Session>): Promise<void> {
  const capture = steps.beginCapture();
  let session: Session | null;
  try {
    session = await steps.prepareSession();
  } catch (e) {
    steps.abandonCapture(capture);
    throw e;
  }
  if (session === null) {
    steps.abandonCapture(capture);
    return;
  }
  await steps.connect(session, capture);
}

/** What a cold start records from. ``deviceId`` is what is opened. */
export interface MicChoiceLike {
  deviceId: string;
}

/**
 * How a cold start opens the microphone.
 *
 *   parallel   — open the device the known list chose at once, read the
 *                list again beside the open, and build the graph beside
 *                both;
 *   sequential — read the list first, open the device it chooses, then
 *                build the graph: the order every start had before the
 *                branches.
 */
export type ColdCaptureMode = "parallel" | "sequential";

export type ColdCapturePlanReason =
  | "known-list"
  | "list-not-current"
  | "list-unnamed"
  | "choice-not-listed"
  | "bluetooth-choice"
  | "bluetooth-default";

export interface ColdCapturePlan {
  mode: ColdCaptureMode;
  /** Support-log reason code: printed as the start line's ``open=``. */
  reason: ColdCapturePlanReason;
}

export interface ColdCapturePlanInput {
  /** No ``devicechange`` has arrived since the known list was enumerated. */
  listCurrent: boolean;
  /** The known ``audioinput`` list. */
  devices: readonly InputDeviceInfo[];
  /**
   * What the known list chose to open: a device id, or "" / an alias for
   * the system default (./capture-warm ``opensSystemDefault``).
   */
  choiceDeviceId: string;
}

/**
 * The one rule that decides whether a cold start may run ahead of a
 * fresh device list.
 *
 * Opening before the list is read means opening by the list known at the
 * press, and the device that open lands on is only as right as that list.
 * For a built-in or USB input a wrong first open costs a second open. For
 * a Bluetooth headset it costs the headset: opening its microphone
 * switches it from high-quality playback (A2DP) to the call profile (HFP)
 * — the very thing "Bluetooth → built-in mic" exists to avoid. So the
 * branches run ahead only when the device the open lands on is known and
 * is not Bluetooth:
 *
 *  - the list is current — enumerated after the last ``devicechange``;
 *  - it is named — before microphone permission the labels are empty and
 *    nothing can be judged by them;
 *  - a choice of the system default ("" or an alias) lands on whatever the
 *    OS names at the moment of the open — on a current list, the list's
 *    default entry — so that entry must not be Bluetooth;
 *  - a choice of a device is asked for ``exact`` (main.tsx
 *    ``micCaptureConstraints``), so it lands on that device or fails: it
 *    must be in the list (one that is not would only fail) and must not be
 *    Bluetooth — an unnamed one counts as Bluetooth, as it does for the
 *    warm hold (./capture-warm). The system default plays no part here:
 *    the one way such an open reaches it is the last resort of a failed
 *    open, and ``beginColdCapture`` holds that back until the fresh list
 *    has confirmed the choice — where the sequential order takes it too.
 *
 * The graph branch opens only the output. An AudioContext playing to a
 * headset in A2DP leaves it in A2DP — HFP is switched on by opening the
 * headset's microphone — so the graph needs no condition of its own.
 *
 * Anything else takes the sequential order, which reads the list first
 * and opens only what it chooses.
 */
export function planColdCapture(input: ColdCapturePlanInput): ColdCapturePlan {
  if (!input.listCurrent) return { mode: "sequential", reason: "list-not-current" };
  if (!input.devices.some((d) => d.label.trim())) return { mode: "sequential", reason: "list-unnamed" };
  if (opensSystemDefault(input.choiceDeviceId)) {
    if (isBluetoothInputLabel(systemDefaultInput(input.devices, input.choiceDeviceId)?.label ?? "")) {
      return { mode: "sequential", reason: "bluetooth-default" };
    }
    return { mode: "parallel", reason: "known-list" };
  }
  const chosen = input.devices.find((d) => d.deviceId === input.choiceDeviceId.trim());
  if (!chosen) return { mode: "sequential", reason: "choice-not-listed" };
  if (isBluetoothInputLabel(chosen.label)) return { mode: "sequential", reason: "bluetooth-choice" };
  return { mode: "parallel", reason: "known-list" };
}

export interface ColdCaptureDeps<Stream, Graph, Choice extends MicChoiceLike> {
  /** The choice made against the device list known at the press. */
  initialChoice: Choice;
  /** ``planColdCapture``'s verdict for this start. */
  mode: ColdCaptureMode;
  /**
   * Enumerate the inputs again and choose on the fresh list. A rejection
   * keeps the initial choice.
   */
  refreshChoice(): Promise<Choice>;
  /**
   * Open the microphone (bounded and retried by the caller). The caller's
   * last resort, once the asked device has failed, is the system default:
   * it is tried only after ``fallbackToDefault`` resolves, and only if it
   * resolves true.
   */
  acquireMic(deviceId: string, fallbackToDefault: Promise<boolean>): Promise<Stream>;
  releaseMic(stream: Stream): void;
  /** The AudioContext and the worklet module — nothing that needs the stream. */
  prepareGraph(mark: (label: string) => void): Promise<Graph>;
  releaseGraph(graph: Graph): void;
  /** The clock the marks are on, for a mark set after the moment it records. */
  now(): number;
  mark: StartMarker;
}

export interface ColdCaptureOpen<Stream, Graph, Choice> {
  stream: Stream;
  /** The choice the stream was opened for — verified on the fresh list. */
  choice: Choice;
  /** The fresh list chose another device, so the microphone was opened again. */
  reopened: boolean;
  /** ``null`` when preparing it failed; the caller builds one itself. */
  graph: Graph | null;
  graphError: unknown;
}

export interface ColdCaptureHandle<Stream, Graph, Choice> {
  /**
   * The microphone open on the verified device, with the graph branch
   * settled. Rejects only when the microphone cannot be opened. On
   * resolution the stream and the graph belong to the caller.
   */
  ready: Promise<ColdCaptureOpen<Stream, Graph, Choice>>;
  /**
   * Nobody will take the capture: release what is open and whatever
   * opens later. Idempotent; a no-op once ``ready`` has handed over.
   */
  abandon(): void;
}

export class CaptureAbandonedError extends Error {
  constructor() {
    super("Recording start was abandoned before the capture connected.");
    this.name = "AbortError";
  }
}

/** Open the microphone and prepare the graph in the order ``deps.mode`` names. */
export function beginColdCapture<Stream, Graph, Choice extends MicChoiceLike>(
  deps: ColdCaptureDeps<Stream, Graph, Choice>,
): ColdCaptureHandle<Stream, Graph, Choice> {
  let abandoned = false;
  let handedOver = false;
  // Everything this handle opened and has not handed over or released.
  const heldStreams = new Set<Stream>();
  let heldGraph: Graph | null = null;

  const releaseStream = (s: Stream): void => {
    heldStreams.delete(s);
    try { deps.releaseMic(s); } catch { /* already released */ }
  };
  const releaseGraph = (g: Graph): void => {
    if (heldGraph === g) heldGraph = null;
    try { deps.releaseGraph(g); } catch { /* already released */ }
  };
  const abandon = (): void => {
    if (abandoned || handedOver) return;
    abandoned = true;
    for (const s of Array.from(heldStreams)) releaseStream(s);
    if (heldGraph !== null) releaseGraph(heldGraph);
  };
  // A stream or graph that lands after the start was abandoned is
  // released on arrival, so a late open can never leave the device on.
  const acquire = (deviceId: string, fallbackToDefault: Promise<boolean>): Promise<Stream> =>
    deps.acquireMic(deviceId, fallbackToDefault).then((s) => {
      if (abandoned) {
        try { deps.releaseMic(s); } catch { /* already released */ }
        throw new CaptureAbandonedError();
      }
      heldStreams.add(s);
      return s;
    });
  const parallel = deps.mode === "parallel";
  // In the sequential order the graph is a step of the microphone's chain.
  const graphBranch: StartBranch = parallel ? "graph" : "mic";
  let graphOutcome: Promise<{ graph: Graph | null; error: unknown }> | null = null;
  const settleGraph = (): Promise<{ graph: Graph | null; error: unknown }> => {
    graphOutcome ??= deps.prepareGraph((label) => deps.mark(label, graphBranch)).then((g) => {
      if (abandoned) {
        try { deps.releaseGraph(g); } catch { /* already released */ }
        throw new CaptureAbandonedError();
      }
      heldGraph = g;
      return g;
    }).then(
      (graph) => ({ graph, error: null }),
      (error) => ({ graph: null, error }),
    );
    return graphOutcome;
  };
  /**
   * The device list, read again, with the choice made on it.
   *
   * The contract is that this NEVER rejects: ``deps.refreshChoice`` may
   * (enumeration failed), and the answer to that is the choice already
   * made — not an error. That is what lets the early open wait on the
   * list beside it without a gate that could hang, and why its caller has
   * no catch of its own. Pinned by "a list that cannot be read keeps the
   * known choice" in ./tests/live-start.test.ts.
   */
  const freshChoice = (): Promise<Choice> =>
    deps.refreshChoice().then((c) => c, () => deps.initialChoice);

  const mic = parallel ? openAhead() : openInOrder();
  if (parallel) void settleGraph();

  // The list first, then the one device it chooses. That choice is made
  // on the fresh list, so its open may fall back to the default as it
  // always has.
  async function openInOrder(): Promise<{ stream: Stream; choice: Choice; reopened: boolean }> {
    const choice = await freshChoice();
    deps.mark("loadMics", "mic");
    if (abandoned) throw new CaptureAbandonedError();
    const stream = await acquire(choice.deviceId, Promise.resolve(true));
    deps.mark("getUserMedia", "mic");
    return { stream, choice, reopened: false };
  }

  // The device the known list chose, opened at once; the fresh list,
  // read beside it, confirms it or names the one to open instead. Which
  // of the two was on the path is known only once both have answered, so
  // their marks are set then, at the moments they record.
  async function openAhead(): Promise<{ stream: Stream; choice: Choice; reopened: boolean }> {
    const initialId = deps.initialChoice.deviceId;
    let firstOpenAt: number | null = null;
    // The plan vouched for the device the known list chose, not for the
    // system default: should that device fail, the open falls back to the
    // default only once the fresh list has confirmed the same choice — the
    // moment the sequential order would have reached it.
    let confirmChoice!: (same: boolean) => void;
    const confirmed = new Promise<boolean>((resolve) => { confirmChoice = resolve; });
    const firstOpen = acquire(initialId, confirmed);
    void firstOpen.then(() => { firstOpenAt = deps.now(); }, () => { /* reported below */ });
    // Cannot reject (see ``freshChoice``), so the gate below always gets
    // its answer and an early open can never hang on it.
    const choice = await freshChoice();
    const listAt = deps.now();
    confirmChoice(!abandoned && choice.deviceId === initialId);
    if (choice.deviceId === initialId) {
      deps.mark("loadMics", "side", listAt);
      const stream = await firstOpen;
      const openedAt = firstOpenAt ?? deps.now();
      deps.mark("getUserMedia", "mic", openedAt);
      // The device was open before the list confirmed it: that wait was on the path.
      if (listAt > openedAt) deps.mark("deviceCheck", "mic", listAt);
      return { stream, choice, reopened: false };
    }
    // The fresh list names another device: the first open is not this
    // take's microphone, whether it has answered yet or not, and the
    // second open began when the list answered.
    deps.mark("loadMics", "mic", listAt);
    void firstOpen.then((s) => {
      deps.mark("getUserMedia.discarded", "side", firstOpenAt ?? deps.now());
      releaseStream(s);
    }, () => { /* nothing to release */ });
    if (abandoned) throw new CaptureAbandonedError();
    const stream = await acquire(choice.deviceId, Promise.resolve(true));
    deps.mark("micReopen", "mic");
    return { stream, choice, reopened: true };
  }

  const ready = (async (): Promise<ColdCaptureOpen<Stream, Graph, Choice>> => {
    let opened: { stream: Stream; choice: Choice; reopened: boolean };
    try {
      opened = await mic;
    } catch (e) {
      // No microphone, no recording: the graph has nobody to serve.
      abandon();
      throw e;
    }
    const { graph, error } = await settleGraph();
    if (abandoned) {
      releaseStream(opened.stream);
      if (graph !== null) releaseGraph(graph);
      throw new CaptureAbandonedError();
    }
    handedOver = true;
    heldStreams.delete(opened.stream);
    heldGraph = null;
    return { ...opened, graph, graphError: error };
  })();
  // ``ready`` may be abandoned unread (the session failed first).
  ready.catch(() => { /* the caller that awaits it sees the rejection */ });

  return { ready, abandon };
}

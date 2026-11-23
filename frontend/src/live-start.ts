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
 *             stream; for a Bluetooth input they wait for the microphone
 *             (``graphAfterMic``, see ``beginColdCapture``);
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

import type { StartBranch } from "./start-trace";

export type StartMarker = (label: string, branch: StartBranch) => void;

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

export interface ColdCaptureDeps<Stream, Graph, Choice extends MicChoiceLike> {
  /** The choice made against the device list known at the press. */
  initialChoice: Choice;
  /**
   * Enumerate the inputs again and choose on the fresh list: the known
   * one can be stale (a device that left or came back under a new id).
   * A rejection keeps the initial choice.
   */
  refreshChoice(): Promise<Choice>;
  /** Open the microphone (bounded and retried by the caller). */
  acquireMic(deviceId: string): Promise<Stream>;
  releaseMic(stream: Stream): void;
  /** The AudioContext and the worklet module — nothing that needs the stream. */
  prepareGraph(mark: (label: string) => void): Promise<Graph>;
  releaseGraph(graph: Graph): void;
  /**
   * Build the graph only once the microphone is open. For a Bluetooth
   * input: an AudioContext opened first would start its output in the
   * headset's playback profile, and the microphone opening a moment
   * later switches the headset to the call profile underneath it. Built
   * after, the context opens on the profile the take records in — the
   * order every start had before the branches.
   */
  graphAfterMic: boolean;
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

/**
 * Open the microphone and prepare the graph beside each other, from the
 * moment of the call.
 */
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
  const acquire = (deviceId: string): Promise<Stream> =>
    deps.acquireMic(deviceId).then((s) => {
      if (abandoned) {
        try { deps.releaseMic(s); } catch { /* already released */ }
        throw new CaptureAbandonedError();
      }
      heldStreams.add(s);
      return s;
    });
  const graphBranch: StartBranch = deps.graphAfterMic ? "mic" : "graph";
  const startGraph = (): Promise<Graph | null> =>
    deps.prepareGraph((label) => deps.mark(label, graphBranch)).then((g) => {
      if (abandoned) {
        try { deps.releaseGraph(g); } catch { /* already released */ }
        throw new CaptureAbandonedError();
      }
      heldGraph = g;
      return g;
    });

  // Both start now: the device open is the one physical wait, and the
  // list that verifies its choice is read beside it.
  const initialId = deps.initialChoice.deviceId;
  let listedChoice: Choice | null = null;
  let firstOpenDone = false;
  const firstOpen = acquire(initialId);
  const listed = deps.refreshChoice().then(
    (c) => c,
    () => deps.initialChoice,
  ).then((c) => {
    listedChoice = c;
    // The list is on the path only when it decided a second open.
    deps.mark("loadMics", c.deviceId !== initialId ? "mic" : "side");
    return c;
  });
  void firstOpen.then(() => {
    firstOpenDone = true;
    const discarded = listedChoice !== null && listedChoice.deviceId !== initialId;
    deps.mark(discarded ? "getUserMedia.discarded" : "getUserMedia", discarded ? "side" : "mic");
  }, () => { /* reported through the mic branch */ });

  let graphOutcome: Promise<{ graph: Graph | null; error: unknown }> | null = null;
  const settleGraph = (): Promise<{ graph: Graph | null; error: unknown }> => {
    graphOutcome ??= startGraph().then(
      (graph) => ({ graph, error: null }),
      (error) => ({ graph: null, error }),
    );
    return graphOutcome;
  };
  if (!deps.graphAfterMic) void settleGraph();

  const mic = (async (): Promise<{ stream: Stream; choice: Choice; reopened: boolean }> => {
    const choice = await listed;
    if (choice.deviceId === initialId) {
      const listWasLast = firstOpenDone;
      const stream = await firstOpen;
      // Waited on the list after the device was already open.
      if (listWasLast) deps.mark("deviceCheck", "mic");
      return { stream, choice, reopened: false };
    }
    // The fresh list names another device: the first open is not this
    // take's microphone, whether it has answered yet or not.
    void firstOpen.then(releaseStream, () => { /* nothing to release */ });
    if (abandoned) throw new CaptureAbandonedError();
    const stream = await acquire(choice.deviceId);
    deps.mark("micReopen", "mic");
    return { stream, choice, reopened: true };
  })();

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

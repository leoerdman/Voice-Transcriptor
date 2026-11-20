// The press classifier of screen mode's mouse helper — pure, no CGEvent.
//
// One rule decides what every left-button press is:
//
//   * it starts on one of our own controls (capsule, palette, a stroke's
//     number) → TAP: the
//     press and its release are swallowed and reported as a tap at the
//     press point; the app clicks the control inside its own page. The
//     window server never delivers a click to our windows, so macOS never
//     activates Transcriptor and never raises its main window — which a
//     click it delivers to ANY window of an inactive app does, panel or
//     not (measured 2026-11-20: `type: "panel"` did not prevent it);
//   * it ends before moving `dragThreshold` points → CLICK: the held press
//     and the release are replayed, so the app underneath gets an ordinary
//     click (its click count travels with the held event untouched);
//   * it moves `dragThreshold` points while held → STROKE: everything is
//     swallowed and reported for the overlay to draw;
//   * a drag arrives with no press this tap held → STROKE all the same.
//     A drag means the button is down, whatever produced the press: a
//     trackpad's double-tap-and-drag, drag lock or three-finger drag can
//     start the movement without a press this tap saw as its own. Its
//     release is swallowed AND passed on (`strokeEndPassingUp`): an app
//     that saw a press must see it end, and one that did not ignores a
//     stray release.
//
// A click this helper replays is the app's, and stays the app's when it
// comes back. The helper marks what it posts (`eventSourceUserData`), but
// another app's event tap can take the replayed events and post them
// again with its own user data in the marker's place; they then arrive as
// a press nobody made, and replaying THAT feeds a loop — thousands of
// "clicks" a second, the cursor warped back to the press point each
// round, a double-tap-and-drag torn into one-point strokes (the user's
// take of 2026-11-20 14:55, with BetterTouchTool's left-button session
// tap on the machine). Every replayed event's timestamp is remembered,
// and an event carrying one passes untouched and is counted (`echoes`).
//
// A press another app POSTED (BetterTouchTool's double-tap-and-drag, which
// emulates the gesture with its own event tap while the system tap-drag is
// off) changes no button state in the window server — this helper holds
// that press back, so the window server never learns the button went
// down, and the finger's movement keeps arriving as plain `mouseMoved`.
// Waiting for `leftMouseDragged` there waits for an event that never
// comes: the user's take of 2026-11-20 15:36 logged four such presses as
// `click drags=0`, and nothing was drawn. So while a press is held (or
// drawing, or on a control) a `moved` event is the press moving and is
// classified as a drag. Everywhere else it is hover and passes. The
// helper passes every `moved` event on whatever the decision — it is
// cursor motion, and the app underneath never saw the held press, so it
// reads it as hover, not as a drag.
//
// The numbers beside the strokes on the screen (discs) are our controls
// too: a press on one is a tap — the shell deletes that stroke — never a
// click for the app underneath and never the start of a stroke, even if
// it then moves (a press that wanders off a disc taps nothing, as on the
// palette). The shell also shows a cross on the number under the
// pointer, so while no press is in progress, cursor motion on a disc is
// reported as HOVER — and once more on leaving it, so the cross goes —
// and passes on like any other motion. Motion away from every disc is
// not reported: the shell hears about the pointer only near a number.
//
// The click count plays no part in the decision, so a double-tap-and-drag
// whose second press this tap does see is a press that moves: a stroke.
//
// macOS switches an event tap off when a callback runs late or Secure
// Input toggles (`tapDisabledByTimeout` / `tapDisabledByUserInput`).
// Whatever happened to the press while the tap was off never reached this
// rule, so the press it was in the middle of is abandoned (`interrupt`):
// an open stroke is ended, a held press is handed to the app it was meant
// for, and the next press starts from a clean state instead of inheriting
// a phase whose events went past the tap.
//
// Compiled into the helper (main.swift) and, on its own, into the test
// binary desktop/screen-input.test.js builds.

import CoreGraphics

struct PressClassifier {
  enum Kind { case down, dragged, moved, up }

  enum Decision: Equatable {
    /// Let the event through unchanged.
    case pass
    /// Swallow the event (held press, or a drag under the threshold).
    case hold
    /// Swallow and replay the held press, then this release, as a click.
    case replayClick
    /// Swallow; a stroke began at `from` and continues to the point.
    case strokeStart(from: CGPoint)
    /// Swallow; the stroke continues to the event's point.
    case strokeMove
    /// Swallow; the stroke ends at the event's point.
    case strokeEnd
    /// The stroke ends at the event's point; the release is passed on.
    case strokeEndPassingUp
    /// Swallow; one of our controls was tapped at `at`.
    case tap(at: CGPoint)
    /// Let the cursor motion through, and report its point: it is on a
    /// disc, or has just left one.
    case hover
  }

  /// A round control: a stroke's number, centre and radius in global points.
  struct Disc: Equatable {
    let center: CGPoint
    let radius: Double

    func contains(_ p: CGPoint) -> Bool {
      let dx = p.x - center.x
      let dy = p.y - center.y
      return (dx * dx + dy * dy).squareRoot() <= radius
    }
  }

  /// What the last finished press was, for the helper's one log line.
  /// `handedOver`: a press the tap was switched off in the middle of,
  /// replayed to the app and passed through to its release.
  enum Outcome: String { case click, stroke, tap, controlDrag, orphanStroke, handedOver }

  /// What `interrupt` found in progress when the tap was switched off.
  enum Abandoned: Equatable {
    /// No press in progress.
    case none
    /// A stroke was being drawn; it ends at `at`, its last point.
    case stroke(at: CGPoint)
    /// A press was held (not yet a click or a stroke). The caller replays
    /// it to the app. With the button still down the rest of the press is
    /// passed through; with the button already up its release went past
    /// the tap, so the caller completes the click.
    case heldPress(buttonDown: Bool)
    /// A press on one of our controls; it taps nothing.
    case controlPress

    /// The name the helper's log line uses.
    var name: String {
      switch self {
      case .none: return "none"
      case .stroke: return "stroke"
      case .heldPress: return "held"
      case .controlPress: return "control"
      }
    }
  }

  let dragThreshold: Double
  var controls: [CGRect] = []
  var discs: [Disc] = []
  /// The last hover reported was on a disc: the next motion off every
  /// disc is reported once, so the shell takes the cross away.
  private var hovering = false

  private enum Phase { case idle, held, drawing, onControl, orphanDrawing, handedOver }
  private var phase: Phase = .idle
  private var downPoint = CGPoint.zero
  private var downStamp: UInt64 = 0
  /// The timestamps of the events this helper handed back to the app
  /// (`replayClick`, a press handed over by `interrupt`), newest last.
  /// Bounded: an echo comes back within the same burst of events, so
  /// only the last few replays can still return.
  private var replayed: [UInt64] = []
  private static let replayedKept = 8
  /// Replayed events that came back re-posted since `takeEchoes` was last
  /// called — the helper reports them on its next press line.
  private var echoes = 0

  mutating func takeEchoes() -> Int {
    defer { echoes = 0 }
    return echoes
  }
  private var lastPoint = CGPoint.zero
  private var controlMoved = false
  private(set) var lastOutcome: Outcome? = nil
  private(set) var drags = 0

  init(dragThreshold: Double) {
    self.dragThreshold = dragThreshold
  }

  private func farFromDown(_ p: CGPoint) -> Bool {
    let dx = p.x - downPoint.x
    let dy = p.y - downPoint.y
    return (dx * dx + dy * dy).squareRoot() >= dragThreshold
  }

  private func onControl(_ p: CGPoint) -> Bool {
    controls.contains(where: { $0.contains(p) }) || discs.contains(where: { $0.contains(p) })
  }

  /// Whether the pointer at `p` is reported as hover: it is on a disc, or
  /// the last report was. Asked on every motion with no press in
  /// progress, and by the helper when the discs change under a still
  /// pointer. During a press nothing is reported.
  mutating func hover(at p: CGPoint) -> Bool {
    guard phase == .idle else { return false }
    let over = discs.contains(where: { $0.contains(p) })
    defer { hovering = over }
    return over || hovering
  }

  private mutating func remember(_ stamps: UInt64...) {
    replayed.append(contentsOf: stamps.filter { $0 != 0 })
    if replayed.count > Self.replayedKept { replayed.removeFirst(replayed.count - Self.replayedKept) }
  }

  /// The tap was switched off and is back on: abandon the press in
  /// progress and say what it was. `buttonDown` is the left button's state
  /// now. Afterwards the classifier is idle — or, for a held press whose
  /// button is still down, passes the rest of that press through to the
  /// app the caller replays it to.
  mutating func interrupt(buttonDown: Bool) -> Abandoned {
    let was = phase
    phase = .idle
    controlMoved = false
    switch was {
    case .idle, .handedOver:
      return .none
    case .drawing, .orphanDrawing:
      return .stroke(at: lastPoint)
    case .held:
      if buttonDown { phase = .handedOver }
      remember(downStamp)
      return .heldPress(buttonDown: buttonDown)
    case .onControl:
      return .controlPress
    }
  }

  mutating func classify(_ event: Kind, at p: CGPoint, stamp: UInt64) -> Decision {
    var kind = event
    if kind == .moved {
      // Movement with no button the window server knows of: only a press
      // this classifier is holding makes it a drag.
      switch phase {
      case .held, .drawing, .onControl: kind = .dragged
      case .idle: return hover(at: p) ? .hover : .pass
      case .orphanDrawing, .handedOver: return .pass
      }
    }
    if kind != .dragged, stamp != 0, replayed.contains(stamp) {
      // An event this helper already handed to the app, back again
      // without its marker: another tap re-posted it. It is the app's;
      // the press in progress, if any, is not touched by it.
      lastOutcome = nil
      echoes += 1
      return .pass
    }
    lastPoint = p
    switch kind {
    case .down:
      downPoint = p
      downStamp = stamp
      drags = 0
      controlMoved = false
      lastOutcome = nil
      phase = onControl(p) ? .onControl : .held
      return .hold
    case .dragged:
      drags += 1
      switch phase {
      case .onControl:
        if farFromDown(p) { controlMoved = true }
        return .hold
      case .held:
        if !farFromDown(p) { return .hold }
        phase = .drawing
        return .strokeStart(from: downPoint)
      case .drawing, .orphanDrawing:
        return .strokeMove
      case .handedOver:
        return .pass
      case .idle:
        phase = .orphanDrawing
        return .strokeStart(from: p)
      }
    case .moved:
      return .pass  // mapped to .dragged above, or already passed
    case .up:
      let was = phase
      phase = .idle
      switch was {
      case .onControl:
        // A press that wandered off a control is not a tap on it.
        lastOutcome = controlMoved ? .controlDrag : .tap
        return controlMoved ? .hold : .tap(at: downPoint)
      case .held:
        lastOutcome = .click
        remember(downStamp, stamp)
        return .replayClick
      case .drawing:
        lastOutcome = .stroke
        return .strokeEnd
      case .orphanDrawing:
        lastOutcome = .orphanStroke
        return .strokeEndPassingUp
      case .handedOver:
        lastOutcome = .handedOver
        return .pass
      case .idle:
        // A release that ends no press (another app posting mouse-ups, a
        // release whose press went past the tap) has no outcome. Leaving
        // the previous press's outcome here made the helper report it once
        // per stray release — 13 identical "press" lines in a millisecond.
        lastOutcome = nil
        return .pass
      }
    }
  }
}

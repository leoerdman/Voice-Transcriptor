// screen-input — the mouse half of screen mode.
//
// Screen mode turns the whole screen into a drawing surface WITHOUT taking
// the screen away from the user: a plain click must still reach whatever
// app is under the cursor, scrolling and hovering must keep working, and
// only a press-and-drag draws. A transparent Electron window cannot make
// that distinction — it either receives the mouse (and blocks every click,
// scroll and hover underneath) or ignores it (and can never see a drag).
//
// This helper sits in front of the window server with a CGEventTap and
// decides, per press, between a click (replayed to the app underneath), a
// stroke (drawn), and a tap on one of our own controls (delivered to the
// app in-process, never through the window server). The rule is
// PressClassifier (PressClassifier.swift); this file is the event tap and
// the protocol around it.
//
// Protocol — one JSON object per line.
//   stdin : {"cmd":"controls","rects":[[x,y,w,h],...]}  our controls, global points
//           {"cmd":"quit"}
//   stdout: {"t":"ready"}
//           {"t":"start","x":..,"y":..} {"t":"move","x":..,"y":..} {"t":"end","x":..,"y":..}
//           {"t":"tap","x":..,"y":..}                  a press-and-release on a control
//           {"t":"press","outcome":"click|stroke|tap|controlDrag|orphanStroke|handedOver",
//            "clicks":n,"drags":n}                     one line per finished press
//           {"t":"tap-disabled","reason":"timeout|user-input",
//            "abandoned":"none|stroke|held|control"}   macOS switched the tap
//                                                      off; it is back on and
//                                                      the press it cut is
//                                                      abandoned (see below)
//           {"t":"error","code":"tap-unavailable"}            then exit 2
//
// Output is written from a serial queue, never from the tap callback
// itself: a callback that waits on a pipe gets the tap disabled by macOS
// for being slow, and events then flow past undrawn.
//
// Coordinates are CGEvent global points: top-left origin of the main
// display, the same space Electron's `screen` module uses on macOS.

import CoreGraphics
import Foundation

// What counts as a stroke is decided here and only here
// (PressClassifier.swift): a press that moves this far.
let dragThreshold: Double = 5.0
// Marks the events this helper re-posts so its own tap lets them through.
let syntheticMarker: Int64 = 0x5652_5343  // "VRSC"

final class State {
  let lock = NSLock()
  var classifier = PressClassifier(dragThreshold: dragThreshold)
  var heldDown: CGEvent? = nil
  var tap: CFMachPort? = nil
}

let state = State()
let outputQueue = DispatchQueue(label: "screen-input.output")

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  let bytes = Data(line.utf8)
  outputQueue.async { FileHandle.standardOutput.write(bytes) }
}

func emitPoint(_ kind: String, _ p: CGPoint) {
  emit(["t": kind, "x": (p.x * 10).rounded() / 10, "y": (p.y * 10).rounded() / 10])
}

func repost(_ event: CGEvent) {
  event.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
  event.post(tap: .cgSessionEventTap)
}

// macOS switched the tap off (a late callback, Secure Input) and it is back
// on. Every event while it was off went past the classifier, so the press
// it was in the middle of cannot continue: it is abandoned the one way the
// rule names (PressClassifier.interrupt) and the outcome is reported, so a
// gesture that did not draw is explained in the app's log.
func recoverFromTapDisable(reason: String) {
  if let tap = state.tap { CGEvent.tapEnable(tap: tap, enable: true) }
  let buttonDown = CGEventSource.buttonState(.combinedSessionState, button: .left)
  state.lock.lock()
  let abandoned = state.classifier.interrupt(buttonDown: buttonDown)
  state.lock.unlock()
  let held = state.heldDown
  state.heldDown = nil
  emit(["t": "tap-disabled", "reason": reason, "abandoned": abandoned.name])
  switch abandoned {
  case .none, .controlPress:
    break
  case .stroke(let at):
    emitPoint("end", at)
  case .heldPress(let down):
    // The app never got this press: hand it over. With the button still
    // down the rest of the press passes through to it; with the button up
    // its release already went past the tap, so complete the click.
    guard let held = held else { break }
    repost(held)
    if !down, let up = CGEvent(
      mouseEventSource: nil, mouseType: .leftMouseUp,
      mouseCursorPosition: held.location, mouseButton: .left
    ) {
      up.setIntegerValueField(.mouseEventClickState, value: held.getIntegerValueField(.mouseEventClickState))
      repost(up)
    }
  }
}

let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    recoverFromTapDisable(reason: type == .tapDisabledByTimeout ? "timeout" : "user-input")
    return Unmanaged.passUnretained(event)
  }
  if event.getIntegerValueField(.eventSourceUserData) == syntheticMarker {
    return Unmanaged.passUnretained(event)
  }
  let kind: PressClassifier.Kind
  switch type {
  case .leftMouseDown: kind = .down
  case .leftMouseDragged: kind = .dragged
  case .leftMouseUp: kind = .up
  default: return Unmanaged.passUnretained(event)
  }
  let p = event.location
  let clicks = event.getIntegerValueField(.mouseEventClickState)
  state.lock.lock()
  let decision = state.classifier.classify(kind, at: p)
  let outcome = kind == .up ? state.classifier.lastOutcome : nil
  let drags = state.classifier.drags
  state.lock.unlock()
  if let outcome = outcome {
    emit(["t": "press", "outcome": outcome.rawValue, "clicks": clicks, "drags": drags])
  }
  switch decision {
  case .pass:
    return Unmanaged.passUnretained(event)
  case .hold:
    if kind == .down { state.heldDown = event.copy() }
    if kind == .up { state.heldDown = nil }  // a drag that wandered off a control
    return nil
  case .replayClick:
    // A click: hand the app underneath the press it never saw, then the
    // release, in order, both marked so this tap lets them through.
    if let held = state.heldDown { repost(held) }
    state.heldDown = nil
    if let up = event.copy() { repost(up) }
    return nil
  case .strokeStart(let from):
    state.heldDown = nil
    emitPoint("start", from)
    emitPoint("move", p)
    return nil
  case .strokeMove:
    emitPoint("move", p)
    return nil
  case .strokeEnd:
    emitPoint("end", p)
    return nil
  case .strokeEndPassingUp:
    emitPoint("end", p)
    return Unmanaged.passUnretained(event)
  case .tap(let at):
    state.heldDown = nil
    emitPoint("tap", at)
    return nil
  }
}

let mask: CGEventMask =
  (1 << CGEventType.leftMouseDown.rawValue) |
  (1 << CGEventType.leftMouseDragged.rawValue) |
  (1 << CGEventType.leftMouseUp.rawValue)

guard let tap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .defaultTap,
  eventsOfInterest: mask,
  callback: callback,
  userInfo: nil
) else {
  emit(["t": "error", "code": "tap-unavailable"])
  exit(2)
}
state.tap = tap

// stdin reader: our controls' rectangles and quit. EOF (the app died or
// closed the pipe) is a quit too — the tap must never outlive its owner,
// or the user's mouse would stay captured.
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = obj["cmd"] as? String else { continue }
    if cmd == "quit" { break }
    if cmd == "controls", let rects = obj["rects"] as? [[Double]] {
      let parsed = rects.compactMap { r -> CGRect? in
        r.count == 4 ? CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) : nil
      }
      state.lock.lock()
      state.classifier.controls = parsed
      state.lock.unlock()
    }
  }
  CGEvent.tapEnable(tap: tap, enable: false)
  exit(0)
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit(["t": "ready"])
CFRunLoopRun()

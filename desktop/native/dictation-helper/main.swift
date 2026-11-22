// dictation-helper — the desktop shell's fast path to the rest of macOS,
// alive for as long as the app is.
//
// A dictation ends in a paste, and every paste used to start two external
// processes (a JXA modifier poll, an osascript ⌘V) and two `lsappinfo`
// lookups — ~400 ms of process launches on the path the user is waiting
// on. This helper is started once with the app and does that work
// in-process: the clipboard (snapshot, write, restore by change count —
// ClipboardLedger.swift), the frontmost app, the modifier wait and ⌘V
// through CGEventPost (Paste.swift).
//
// It is a second target of the native package beside screen-input, not a
// mode of it: screen mode's mouse tap swallows clicks and must die with
// screen mode, while this one lives for the whole session — one process
// per lifetime, shared code in ../shared.
//
// Protocol — one JSON object per line (../shared/LineProtocol.swift).
// Every request carries an "id" that its answer repeats.
//   stdin : {"cmd":"permissions","id":n}
//           {"cmd":"front-app","id":n}
//           {"cmd":"clipboard-prepare","id":n}       snapshot the clipboard now
//                                                    (the recording's start)
//           {"cmd":"paste","id":n,"text":"..","pid":n,"verify":bool,
//            "releaseDeadlineMs":n,"pollMs":n,"settleMs":n,"gapMs":n}
//           {"cmd":"clipboard-restore","id":n,"changeCount":n}
//           {"cmd":"clipboard-keep","id":n}          a failed paste: keep the transcript
//           {"cmd":"quit"}
//   stdout: {"t":"ready","pid":n,"accessibility":b,"postEvents":b,"listenEvents":b}
//           {"t":"permissions","id":n,"accessibility":b,"postEvents":b,"listenEvents":b}
//           {"t":"front-app","id":n,"pid":n,"bundleId":"..","name":".."}   no pid: none
//           {"t":"clipboard-prepare","id":n,"changeCount":n,"ms":x}
//           {"t":"paste","id":n,"ok":b,"sent":b,"reason":"..","reverted":b,"changeCount":n,
//            "source":"prepared|carried|fresh","front":{..},"modifiers":{"cleared":b,"flags":n,"waitedMs":n},
//            "verification":"verified|unverified|unreadable|skipped","ms":{..}}
//           {"t":"clipboard-restore","id":n,"result":"restored|user-changed|superseded|nothing"}
//           {"t":"clipboard-keep","id":n}
//
// Paste failure reasons: empty-text, not-trusted, front-mismatch,
// clipboard-write-failed, post-failed. A paste that does not post leaves
// the user's clipboard in place — its own write, or an earlier paste's
// still waiting for its restore, is put back first ("reverted": true) —
// so the shell's fallback snapshots what the user had.

import AppKit
import CoreGraphics
import Foundation

// The paste path and the hotkey tap are latency-critical: App Nap must
// never throttle this process while the app is idle in the background.
let activity = ProcessInfo.processInfo.beginActivity(
  options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical],
  reason: "Transcriptor paste and hotkey helper"
)

// Touched only from the command thread, one request at a time.
var ledger = ClipboardLedger()

func elapsedMs(_ since: UInt64) -> Int {
  Int(((DispatchTime.now().uptimeNanoseconds - since) + 500_000) / 1_000_000)
}

func intField(_ obj: [String: Any], _ key: String, _ fallback: Int) -> Int {
  (obj[key] as? NSNumber)?.intValue ?? fallback
}

/// Puts the user's clipboard back after OUR write, before anyone else's.
func revertWrite(_ written: Int) -> Bool {
  let verdict = ledger.restore(expected: written, current: systemPasteboard.changeCount)
  if case .restore(let snapshot) = verdict { return systemPasteboard.write(snapshot) }
  return false
}

/// A paste that will not post hands over to the shell's fallback with the
/// user's clipboard in place: an earlier paste of ours whose restore is
/// still pending is restored now, so the fallback's own snapshot is the
/// user's content and never our transcript.
func handOver() -> Bool {
  guard let ours = ledger.ourWrite else { return false }
  return revertWrite(ours)
}

func handlePaste(_ obj: [String: Any], id: Int) {
  let started = DispatchTime.now().uptimeNanoseconds
  var ms: [String: Int] = [:]
  var answer: [String: Any] = ["t": "paste", "id": id, "ok": false, "sent": false, "reverted": false]
  func finish(_ reason: String) {
    ms["total"] = elapsedMs(started)
    answer["reason"] = reason
    answer["ms"] = ms
    emit(answer)
  }
  let text = obj["text"] as? String ?? ""
  if text.isEmpty { return finish("empty-text") }
  let expectedPid = Int32(truncatingIfNeeded: intField(obj, "pid", 0))
  let verify = (obj["verify"] as? Bool) ?? false

  guard Permissions.canPost else {
    answer["reverted"] = handOver()
    return finish("not-trusted")
  }
  var step = DispatchTime.now().uptimeNanoseconds
  let front = FrontApp.current()
  ms["front"] = elapsedMs(step)
  if let front = front { answer["front"] = front.json }
  if expectedPid > 0 && front?.pid != expectedPid {
    answer["reverted"] = handOver()
    return finish("front-mismatch")
  }

  step = DispatchTime.now().uptimeNanoseconds
  let source = ledger.beginWrite(currentCount: systemPasteboard.changeCount, capture: systemPasteboard.snapshot)
  answer["source"] = source.rawValue
  ms["snapshot"] = elapsedMs(step)
  step = DispatchTime.now().uptimeNanoseconds
  guard let written = systemPasteboard.writeText(text) else {
    ledger.keep()
    return finish("clipboard-write-failed")
  }
  ledger.didWrite(count: written)
  answer["changeCount"] = written
  ms["write"] = elapsedMs(step)

  step = DispatchTime.now().uptimeNanoseconds
  let mods = awaitModifierRelease(
    deadlineMs: max(0, intField(obj, "releaseDeadlineMs", 0)),
    pollMs: intField(obj, "pollMs", 10)
  )
  ms["modifiers"] = elapsedMs(step)
  answer["modifiers"] = ["cleared": mods.cleared, "flags": mods.flags, "waitedMs": mods.waitedMs]
  if mods.waitedMs > 0 && expectedPid > 0 && FrontApp.current()?.pid != expectedPid {
    answer["reverted"] = revertWrite(written)
    return finish("front-mismatch")
  }

  step = DispatchTime.now().uptimeNanoseconds
  let before = verify ? focusedTextLength() : nil
  if verify { ms["verifyBefore"] = elapsedMs(step) }

  step = DispatchTime.now().uptimeNanoseconds
  guard postCommandV(gapMs: max(0, intField(obj, "gapMs", 15))) else {
    answer["reverted"] = revertWrite(written)
    return finish("post-failed")
  }
  answer["sent"] = true
  ms["post"] = elapsedMs(step)

  step = DispatchTime.now().uptimeNanoseconds
  let settleMs = max(0, intField(obj, "settleMs", 100))
  if settleMs > 0 { usleep(UInt32(settleMs) * 1000) }
  ms["settle"] = elapsedMs(step)

  if !verify {
    answer["verification"] = "skipped"
  } else if let before = before {
    step = DispatchTime.now().uptimeNanoseconds
    let growth = awaitPasteGrowth(before: before, expected: (text as NSString).length, pollMs: 25, polls: 8)
    answer["verification"] = growth.verdict
    ms["verifyAfter"] = elapsedMs(step)
  } else {
    answer["verification"] = "unreadable"
  }
  answer["ok"] = true
  finish("sent")
}

func handle(_ obj: [String: Any], cmd: String) {
  let id = intField(obj, "id", 0)
  switch cmd {
  case "permissions":
    var answer = Permissions.refresh()
    answer["t"] = "permissions"
    answer["id"] = id
    emit(answer)
  case "front-app":
    var answer: [String: Any] = ["t": "front-app", "id": id]
    if let front = FrontApp.current() { answer.merge(front.json) { $1 } }
    emit(answer)
  case "clipboard-prepare":
    let started = DispatchTime.now().uptimeNanoseconds
    let snapshot = systemPasteboard.snapshot()
    ledger.prepare(snapshot)
    emit(["t": "clipboard-prepare", "id": id, "changeCount": snapshot.changeCount, "ms": elapsedMs(started)])
  case "paste":
    handlePaste(obj, id: id)
  case "clipboard-restore":
    let expected = intField(obj, "changeCount", -1)
    let verdict = ledger.restore(expected: expected, current: systemPasteboard.changeCount)
    if case .restore(let snapshot) = verdict { systemPasteboard.write(snapshot) }
    emit(["t": "clipboard-restore", "id": id, "result": verdict.name])
  case "clipboard-keep":
    ledger.keep()
    emit(["t": "clipboard-keep", "id": id])
  default:
    break
  }
}

var ready = Permissions.refresh()
ready["t"] = "ready"
ready["pid"] = Int(getpid())
emit(ready)
// stdin: requests, one at a time, in order. EOF (the app died or closed
// the pipe) is a quit — the keyboard tap must never outlive its owner.
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = obj["cmd"] as? String else { continue }
    if cmd == "quit" { break }
    handle(obj, cmd: cmd)
  }
  outputQueue.sync {}
  exit(0)
}

// The main run loop keeps NSWorkspace's frontmost app current.
withExtendedLifetime(activity) { CFRunLoopRun() }

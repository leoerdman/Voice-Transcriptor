// Drives ClipboardLedger through the paste sequences the shell produces.
// Built and run by desktop/dictation-helper.test.js; prints one
// "ok <name>" per case and exits non-zero on the first failure.

import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("FAIL \(message)\n".data(using: .utf8)!)
  exit(1)
}

func expect(_ condition: Bool, _ name: String, _ what: String) {
  if !condition { fail("\(name): \(what)") }
}

/// A pasteboard as the ledger sees it: a change count and its content.
final class Board {
  var count = 10
  var text = "user's own"
  var captures = 0
  func snapshot() -> PasteboardSnapshot {
    captures += 1
    return PasteboardSnapshot(
      items: [.init(entries: [.init(type: "public.utf8-plain-text", data: Data(text.utf8))])],
      changeCount: count
    )
  }
  func write(_ value: String) -> Int {
    text = value
    count += 1
    return count
  }
}

func restoredText(_ verdict: ClipboardLedger.RestoreVerdict) -> String? {
  guard case .restore(let snap) = verdict, let entry = snap.items.first?.entries.first else { return nil }
  return String(data: entry.data, encoding: .utf8)
}

func run(_ name: String, _ body: (String) -> Void) {
  body(name)
  print("ok \(name)")
}

run("a prepared snapshot is used while the clipboard has not changed") { name in
  let board = Board()
  var ledger = ClipboardLedger()
  ledger.prepare(board.snapshot())
  let source = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  expect(source == .prepared, name, "source \(source)")
  expect(board.captures == 1, name, "the paste read the pasteboard again")
}

run("a prepared snapshot older than the clipboard is read again") { name in
  let board = Board()
  var ledger = ClipboardLedger()
  ledger.prepare(board.snapshot())
  _ = board.write("copied during the recording")
  let source = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  let written = board.write("transcript")
  ledger.didWrite(count: written)
  expect(source == .fresh, name, "source \(source)")
  let verdict = ledger.restore(expected: written, current: board.count)
  expect(restoredText(verdict) == "copied during the recording", name, "restored \(verdict)")
}

run("a restore after our write puts the original back, once") { name in
  let board = Board()
  var ledger = ClipboardLedger()
  _ = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  let written = board.write("transcript")
  ledger.didWrite(count: written)
  expect(restoredText(ledger.restore(expected: written, current: board.count)) == "user's own", name, "first restore")
  expect(ledger.restore(expected: written, current: board.count) == .nothing, name, "second restore")
}

run("a user copy after our write is never overwritten") { name in
  let board = Board()
  var ledger = ClipboardLedger()
  _ = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  let written = board.write("transcript")
  ledger.didWrite(count: written)
  _ = board.write("transcript")  // the user copies the same words again: still a change
  expect(ledger.restore(expected: written, current: board.count) == .userChanged, name, "verdict")
  expect(ledger.original == nil, name, "the original was kept after the user moved on")
}

run("a second paste carries the first original over") { name in
  let board = Board()
  var ledger = ClipboardLedger()
  _ = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  let first = board.write("transcript one")
  ledger.didWrite(count: first)
  let source = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  expect(source == .carried, name, "source \(source)")
  let second = board.write("transcript two")
  ledger.didWrite(count: second)
  expect(restoredText(ledger.restore(expected: second, current: board.count)) == "user's own", name, "restore")
}

run("the first paste's restore is superseded by the second's write") { name in
  let board = Board()
  var ledger = ClipboardLedger()
  _ = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  let first = board.write("transcript one")
  ledger.didWrite(count: first)
  _ = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  let second = board.write("transcript two")
  ledger.didWrite(count: second)
  expect(ledger.restore(expected: first, current: board.count) == .superseded, name, "first restore")
  expect(restoredText(ledger.restore(expected: second, current: board.count)) == "user's own", name, "second restore")
}

run("a failed paste keeps the transcript") { name in
  let board = Board()
  var ledger = ClipboardLedger()
  _ = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  let written = board.write("transcript")
  ledger.didWrite(count: written)
  ledger.keep()
  expect(ledger.restore(expected: written, current: board.count) == .nothing, name, "restored after keep")
  // The transcript left there is simply the clipboard now: the next
  // paste reads it as the user's content.
  let source = ledger.beginWrite(currentCount: board.count, capture: board.snapshot)
  expect(source == .fresh, name, "source \(source)")
}

run("a restore with nothing saved does nothing") { name in
  var ledger = ClipboardLedger()
  expect(ledger.restore(expected: 3, current: 3) == .nothing, name, "verdict")
}

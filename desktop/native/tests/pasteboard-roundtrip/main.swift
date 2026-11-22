// A paste's clipboard round trip on a PRIVATE named pasteboard — never the
// user's: snapshot every item and type, write the transcript, put the
// snapshot back, and get exactly what was there. Built and run by
// desktop/dictation-helper.test.js; prints one "ok <name>" per case.

import AppKit
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("FAIL \(message)\n".data(using: .utf8)!)
  exit(1)
}

let board = NSPasteboard(name: NSPasteboard.Name("transcriptor-test-\(getpid())"))
defer { board.releaseGlobally() }
let io = PasteboardIO(board: board)

func run(_ name: String, _ body: () -> Void) {
  body()
  print("ok \(name)")
}

run("every item and every type comes back, not only the text") {
  board.clearContents()
  let first = NSPasteboardItem()
  first.setString("plain words", forType: .string)
  first.setData(Data("{\\rtf1 rich}".utf8), forType: .rtf)
  first.setData(Data([0, 1, 2, 255]), forType: NSPasteboard.PasteboardType("com.example.private"))
  let second = NSPasteboardItem()
  second.setString("file:///tmp/a.txt", forType: .fileURL)
  guard board.writeObjects([first, second]) else { fail("could not seed the pasteboard") }
  let before = io.snapshot()
  guard let written = io.writeText("the transcript") else { fail("writeText failed") }
  if written == before.changeCount { fail("a write did not change the count") }
  if board.string(forType: .string) != "the transcript" { fail("transcript not on the pasteboard") }
  guard io.write(before) else { fail("restore write failed") }
  let after = io.snapshot()
  if after.items != before.items { fail("restored items differ: \(after.items.map { $0.entries.map { $0.type } })") }
}

run("an empty clipboard comes back empty") {
  board.clearContents()
  let before = io.snapshot()
  if !before.items.isEmpty { fail("not empty") }
  _ = io.writeText("the transcript")
  io.write(before)
  if !(board.pasteboardItems ?? []).isEmpty { fail("the transcript stayed") }
}

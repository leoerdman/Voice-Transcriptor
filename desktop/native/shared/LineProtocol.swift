// What every native helper of the desktop shell shares: the line protocol
// it speaks to main.js and the mark it puts on the events it posts.
//
// Both helpers (screen-input: screen mode's mouse tap; dictation-helper:
// paste, clipboard and hotkeys) talk JSON, one object per line, over
// stdin/stdout. Output is written from one serial queue, never from an
// event-tap callback itself: a callback that waits on a pipe gets its tap
// disabled by macOS for being slow.

import Foundation

// Marks the events a helper posts or re-posts, so every tap of ours lets
// them through instead of classifying them again ("VRSC").
let syntheticMarker: Int64 = 0x5652_5343

let outputQueue = DispatchQueue(label: "native-helper.output")

private func encodeLine(_ object: [String: Any]) -> Data? {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        var line = String(data: data, encoding: .utf8) else { return nil }
  line += "\n"
  return Data(line.utf8)
}

func emit(_ object: [String: Any]) {
  guard let bytes = encodeLine(object) else { return }
  outputQueue.async { FileHandle.standardOutput.write(bytes) }
}

/// For an event-tap callback: even the JSON is built on the output queue,
/// so the callback itself only hands over a closure.
func emitDeferred(_ build: @escaping () -> [String: Any]) {
  outputQueue.async {
    guard let bytes = encodeLine(build()) else { return }
    FileHandle.standardOutput.write(bytes)
  }
}

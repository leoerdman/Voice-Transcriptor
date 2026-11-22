// The user's clipboard across our pastes: which snapshot is "theirs", and
// whether a restore may put it back.
//
// A paste writes the transcript to the general pasteboard and posts ⌘V;
// the user's own content must come back afterwards (Hex, src/paste.rs).
// The pasteboard's change count is what makes that safe: every write bumps
// it, so "the count is still the one our write produced" means nobody —
// not the user's ⌘C, not a clipboard manager, not another paste of ours —
// has written since, and the restore cannot clobber anything.
//
// Three rules, all here and nowhere else:
//   * The original is taken BEFORE the transcript is written. A snapshot
//     prepared at the start of the recording is used when the count says
//     the clipboard has not changed since (no pasteboard read on the paste
//     path); otherwise the clipboard is read now.
//   * A second paste while the clipboard still holds our first transcript
//     carries the first original over: the transcript is never mistaken
//     for the user's content.
//   * A restore puts the original back only while the count is our latest
//     write's. A count from an earlier write of ours (a later paste came
//     in between) is superseded and leaves the original for that paste's
//     restore; any other count means the user's content moved on and the
//     original is dropped.
//
// Pure value logic: the pasteboard is reached through the closures the
// caller hands in. Tested by desktop/native/tests/clipboard-ledger.

import Foundation

/// Every item on the pasteboard, every type of each, as raw bytes — all of
/// it comes back, not only the text (files, images, rich text, app-private
/// types alike).
struct PasteboardSnapshot: Equatable {
  struct Item: Equatable {
    var entries: [Entry]
  }
  struct Entry: Equatable {
    var type: String
    var data: Data
  }
  var items: [Item]
  var changeCount: Int
}

struct ClipboardLedger {
  enum Source: String {
    /// The snapshot taken when the recording started; the clipboard has
    /// not changed since.
    case prepared
    /// The clipboard still holds our previous transcript; that paste's
    /// original is the user's content.
    case carried
    /// Read now.
    case fresh
  }

  enum RestoreVerdict: Equatable {
    case restore(PasteboardSnapshot)
    case userChanged
    case superseded
    case nothing

    var name: String {
      switch self {
      case .restore: return "restored"
      case .userChanged: return "user-changed"
      case .superseded: return "superseded"
      case .nothing: return "nothing"
      }
    }
  }

  private(set) var prepared: PasteboardSnapshot? = nil
  private(set) var original: PasteboardSnapshot? = nil
  private(set) var ourWrite: Int? = nil

  /// A snapshot taken ahead of the paste (the recording's start). A newer
  /// one replaces it; it is used only while the count still matches.
  mutating func prepare(_ snapshot: PasteboardSnapshot) {
    prepared = snapshot
  }

  /// Settle which snapshot is the user's before the transcript is written.
  mutating func beginWrite(currentCount: Int, capture: () -> PasteboardSnapshot) -> Source {
    defer { prepared = nil }
    if let ours = ourWrite, ours == currentCount, original != nil {
      return .carried
    }
    if let ready = prepared, ready.changeCount == currentCount {
      original = ready
      ourWrite = nil
      return .prepared
    }
    original = capture()
    ourWrite = nil
    return .fresh
  }

  /// The transcript is on the pasteboard; `count` is what that write made.
  mutating func didWrite(count: Int) {
    ourWrite = count
  }

  /// May the paste that wrote `expected` put the original back, given the
  /// pasteboard's count is `current` now?
  mutating func restore(expected: Int, current: Int) -> RestoreVerdict {
    guard let saved = original, let ours = ourWrite else { return .nothing }
    if current == ours && expected == ours {
      original = nil
      ourWrite = nil
      return .restore(saved)
    }
    if current == ours {
      return .superseded
    }
    original = nil
    ourWrite = nil
    return .userChanged
  }

  /// The paste failed: the transcript stays on the clipboard on purpose and
  /// nothing will be restored over it.
  mutating func keep() {
    original = nil
    ourWrite = nil
  }
}

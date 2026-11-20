import { describe, expect, it } from "vitest";
import { keyEventToAccelerator, type ShortcutKeyEvent } from "../src/shortcut-capture";

function press(key: string, code: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { key, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods };
}

describe("keyEventToAccelerator (FU-22, FU-26)", () => {
  it("waits while only a modifier is held", () => {
    expect(keyEventToAccelerator(press("Shift", "ShiftLeft", { shiftKey: true }))).toBeNull();
  });

  it("refuses a bare letter (it would steal typing) and accepts it with a modifier", () => {
    expect(keyEventToAccelerator(press("v", "KeyV"))).toBeNull();
    expect(keyEventToAccelerator(press("v", "KeyV", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+V");
  });

  it("uses the physical key for letters, so a Cyrillic layout binds the same shortcut", () => {
    expect(keyEventToAccelerator(press("м", "KeyV", { altKey: true }))).toBe("Alt+V");
  });

  it("keeps Command and Control apart unless both are held", () => {
    expect(keyEventToAccelerator(press("k", "KeyK", { metaKey: true }))).toBe("Command+K");
    expect(keyEventToAccelerator(press("k", "KeyK", { ctrlKey: true }))).toBe("Control+K");
    expect(keyEventToAccelerator(press("k", "KeyK", { ctrlKey: true, metaKey: true }))).toBe("CommandOrControl+K");
  });

  it("binds navigation keys and F1–F24 without a modifier", () => {
    expect(keyEventToAccelerator(press("ArrowLeft", "ArrowLeft"))).toBe("Left");
    expect(keyEventToAccelerator(press("PageDown", "PageDown"))).toBe("PageDown");
    expect(keyEventToAccelerator(press("F9", "F9"))).toBe("F9");
    expect(keyEventToAccelerator(press("F24", "F24"))).toBe("F24");
    expect(keyEventToAccelerator(press("ArrowDown", "ArrowDown", { altKey: true }))).toBe("Alt+Down");
  });

  it("refuses function keys Electron cannot register", () => {
    expect(keyEventToAccelerator(press("F25", "F25"))).toBeNull();
    expect(keyEventToAccelerator(press("F99", "F99", { altKey: true }))).toBeNull();
  });

  it("maps space, enter, numpad and punctuation", () => {
    expect(keyEventToAccelerator(press(" ", "Space", { ctrlKey: true }))).toBe("Control+Space");
    expect(keyEventToAccelerator(press("Enter", "NumpadEnter", { ctrlKey: true }))).toBe("Control+Enter");
    expect(keyEventToAccelerator(press("1", "Numpad1", { altKey: true }))).toBe("Alt+num1");
    expect(keyEventToAccelerator(press("+", "NumpadAdd", { altKey: true }))).toBe("Alt+numadd");
    expect(keyEventToAccelerator(press("/", "Slash", { altKey: true }))).toBe("Alt+/");
    // A layout that emits a non-ASCII symbol on the physical "." key.
    expect(keyEventToAccelerator(press("ю", "Period", { altKey: true }))).toBe("Alt+.");
  });

  it("returns null for a key it cannot name", () => {
    expect(keyEventToAccelerator(press("Unidentified", "", { altKey: true }))).toBeNull();
  });
});

import { describe, it, expect } from "vitest";

import { normalizeAcceleratorForDisplay, acceleratorToDisplayTokens, shortcutBadge } from "../src/shortcut-display";

describe("shortcutBadge (FU-26: the conflict rule had no test)", () => {
  it("flags a registration the OS refused, with its reason", () => {
    expect(shortcutBadge({ desired: "Alt+Left", error: "taken" }, false)).toEqual({
      conflict: true,
      title: "Not registered: taken",
    });
  });

  it("treats an inactive screenshot key at rest as normal, but its error as a conflict", () => {
    expect(shortcutBadge({ desired: "Alt+Down" }, false).conflict).toBe(false);
    expect(shortcutBadge({ desired: "Alt+Down", error: "x" }, false).conflict).toBe(true);
  });

  it("S-09: decides every slot by one rule — an error main reported — so it needs no slot id", () => {
    // An optional slot the user left empty registers nothing and is not
    // refused; the old rule (`!!active` for every slot but the
    // screenshot key) badged it "Not registered: unknown reason".
    expect(shortcutBadge({ desired: "", active: "", error: "" }, false).conflict).toBe(false);
    expect(shortcutBadge({ desired: "Alt+Left", active: "Alt+Left" }, false).conflict).toBe(false);
  });

  it("flags F1–F12 only when macOS treats them as media keys", () => {
    expect(shortcutBadge({ active: "F9", desired: "F9" }, true).conflict).toBe(true);
    expect(shortcutBadge({ active: "F9", desired: "F9" }, false)).toEqual({ conflict: false, title: "" });
    expect(shortcutBadge({ active: "F13", desired: "F13" }, true).conflict).toBe(false);
  });
});

describe("normalizeAcceleratorForDisplay", () => {
  it("leaves non-modifier tokens untouched", () => {
    expect(normalizeAcceleratorForDisplay("A+B", true)).toBe("A+B");
    expect(normalizeAcceleratorForDisplay("F1+Shift", true)).toBe("F1+Shift");
  });

  describe("Mac platform (isMac=true)", () => {
    it("CommandOrControl/CmdOrCtrl -> Command", () => {
      expect(normalizeAcceleratorForDisplay("CommandOrControl+S", true)).toBe("Command+S");
      expect(normalizeAcceleratorForDisplay("CmdOrCtrl+S", true)).toBe("Command+S");
    });
    it("Meta -> Command", () => {
      expect(normalizeAcceleratorForDisplay("Meta+S", true)).toBe("Command+S");
    });
    it("Command/Cmd -> Command (already canonical)", () => {
      expect(normalizeAcceleratorForDisplay("Command+S", true)).toBe("Command+S");
      expect(normalizeAcceleratorForDisplay("Cmd+S", true)).toBe("Cmd+S");
    });
  });

  describe("Non-Mac platform (isMac=false)", () => {
    it("Command/Cmd/Meta -> Super", () => {
      expect(normalizeAcceleratorForDisplay("Command+S", false)).toBe("Super+S");
      expect(normalizeAcceleratorForDisplay("Cmd+S", false)).toBe("Super+S");
      expect(normalizeAcceleratorForDisplay("Meta+S", false)).toBe("Super+S");
    });
    it("CommandOrControl/CmdOrCtrl -> Control", () => {
      expect(normalizeAcceleratorForDisplay("CommandOrControl+S", false)).toBe("Control+S");
      expect(normalizeAcceleratorForDisplay("CmdOrCtrl+S", false)).toBe("Control+S");
    });
    it("Control/Ctrl -> Control (already canonical)", () => {
      expect(normalizeAcceleratorForDisplay("Control+S", false)).toBe("Control+S");
      expect(normalizeAcceleratorForDisplay("Ctrl+S", false)).toBe("Ctrl+S");
    });
  });
});

describe("acceleratorToDisplayTokens", () => {
  const mac = true;
  const linux = false;

  it("empty string returns placeholder", () => {
    expect(acceleratorToDisplayTokens("", mac)).toEqual(["—"]);
  });

  it("basic modifier tokens on Mac", () => {
    expect(acceleratorToDisplayTokens("Command+S", mac)).toEqual(["Command", "S"]);
    expect(acceleratorToDisplayTokens("Control+S", mac)).toEqual(["Control", "S"]);
    expect(acceleratorToDisplayTokens("Option+S", mac)).toEqual(["Option", "S"]);
    expect(acceleratorToDisplayTokens("Alt+S", mac)).toEqual(["Option", "S"]);
    expect(acceleratorToDisplayTokens("Shift+S", mac)).toEqual(["Shift", "S"]);
  });

  it("basic modifier tokens on Linux/Windows", () => {
    expect(acceleratorToDisplayTokens("Super+S", linux)).toEqual(["Super", "S"]);
    expect(acceleratorToDisplayTokens("Control+S", linux)).toEqual(["Control", "S"]);
    expect(acceleratorToDisplayTokens("Alt+S", linux)).toEqual(["Alt", "S"]);
    expect(acceleratorToDisplayTokens("Shift+S", linux)).toEqual(["Shift", "S"]);
  });

  it("canonical CommandOrControl variants on Mac", () => {
    expect(acceleratorToDisplayTokens("CommandOrControl+S", mac)).toEqual(["Command", "S"]);
    expect(acceleratorToDisplayTokens("CmdOrCtrl+S", mac)).toEqual(["Command", "S"]);
  });

  it("canonical CommandOrControl variants on Linux/Windows", () => {
    expect(acceleratorToDisplayTokens("CommandOrControl+S", linux)).toEqual(["Control", "S"]);
    expect(acceleratorToDisplayTokens("CmdOrCtrl+S", linux)).toEqual(["Control", "S"]);
  });

  it("special keys render as Unicode symbols", () => {
    expect(acceleratorToDisplayTokens("ArrowUp", mac)).toEqual(["↑"]);
    expect(acceleratorToDisplayTokens("ArrowDown", mac)).toEqual(["↓"]);
    expect(acceleratorToDisplayTokens("ArrowLeft", mac)).toEqual(["←"]);
    expect(acceleratorToDisplayTokens("ArrowRight", mac)).toEqual(["→"]);
    expect(acceleratorToDisplayTokens("Enter", mac)).toEqual(["Return"]);
    expect(acceleratorToDisplayTokens("Return", mac)).toEqual(["Return"]);
    expect(acceleratorToDisplayTokens("Escape", mac)).toEqual(["Esc"]);
    expect(acceleratorToDisplayTokens("Tab", mac)).toEqual(["Tab"]);
    expect(acceleratorToDisplayTokens("Space", mac)).toEqual(["Space"]);
    expect(acceleratorToDisplayTokens("Backspace", mac)).toEqual(["Delete"]);
  });

  it("function keys pass through unchanged", () => {
    expect(acceleratorToDisplayTokens("F9", mac)).toEqual(["F9"]);
    expect(acceleratorToDisplayTokens("F12", mac)).toEqual(["F12"]);
  });

  it("complex combinations parse correctly", () => {
    expect(acceleratorToDisplayTokens("Control+Shift+ArrowLeft", mac)).toEqual(["Control", "Shift", "←"]);
    expect(acceleratorToDisplayTokens("Super+Alt+F9", linux)).toEqual(["Super", "Alt", "F9"]);
    expect(acceleratorToDisplayTokens("Meta+Control+Shift+ArrowRight", mac)).toEqual(["Command", "Control", "Shift", "→"]);
  });
});
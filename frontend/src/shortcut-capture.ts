/**
 * A key press in Settings → Shortcuts → the Electron accelerator it binds.
 *
 * It lived inside the 15 k-line renderer with no test; this is the same
 * rule, testable, with three defects of the old copy removed:
 *
 *   • function keys were accepted as `/^F\d{1,2}$/` — F13…F99 — while
 *     Electron accelerators stop at F24, so "F25" was saved and then
 *     failed to register. The range is Electron's now.
 *   • an `Escape` mapping that could never run: the capture handler
 *     consumes Escape as "cancel" before it calls this.
 *   • every navigation key was compared twice, once by `key` and once by
 *     `code`, in two hand-kept lists (the gate and the mapping).
 */

/** The fields of a KeyboardEvent this decision reads. */
export interface ShortcutKeyEvent {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

/** F1–F24: the function keys an Electron accelerator can name. */
const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

/**
 * Keys safe to bind without a modifier: they never produce text, so a
 * bare binding cannot steal the user's typing. Value = accelerator name.
 */
const STANDALONE_KEYS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
};

/** Keys that need a modifier, by `key` or `code`. */
const MODIFIED_KEYS: Record<string, string> = {
  " ": "Space",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
};

const NUMPAD_CODES: Record<string, string> = {
  NumpadDecimal: "numdec",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
};

/** Punctuation by physical key, when the layout emits no ASCII symbol. */
const PUNCTUATION_CODES: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

const ASCII_PUNCTUATION = /^[!@#$%^&*()_+\-=\]{}\\|;:'",.<>/?`~]$/;

function functionKeyName(key: string, code: string): string | null {
  if (FUNCTION_KEY.test(key)) return key;
  if (FUNCTION_KEY.test(code)) return code;
  return null;
}

function standaloneName(key: string, code: string): string | null {
  return STANDALONE_KEYS[key] ?? STANDALONE_KEYS[code] ?? functionKeyName(key, code);
}

/**
 * The key part of the accelerator. Layout-stable `code` first for letters
 * and digits (a shortcut survives a Cyrillic layout); the emitted ASCII
 * symbol first for punctuation, because Electron names punctuation by
 * symbol, with the physical key as the fallback.
 */
function mainKeyName(key: string, code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (NUMPAD_CODES[code]) return NUMPAD_CODES[code];
  const standalone = standaloneName(key, code);
  if (standalone) return standalone;
  const modified = MODIFIED_KEYS[key] ?? MODIFIED_KEYS[code];
  if (modified) return modified;
  if (key.length === 1 && ASCII_PUNCTUATION.test(key)) return key;
  return PUNCTUATION_CODES[code] ?? null;
}

/**
 * @param options.typingKeysAllowed  the slot is bound only while screen
 *   mode runs (the screenshot key), so a bare key that types — the
 *   default ` under Escape — cannot steal typing outside that mode and is
 *   accepted. Every always-bound slot still needs a modifier for those.
 */
export function keyEventToAccelerator(
  e: ShortcutKeyEvent,
  options: { typingKeysAllowed?: boolean } = {},
): string | null {
  const key = e.key === " " ? " " : String(e.key || "").trim();
  const code = String(e.code || "").trim();
  // A modifier on its own is still being held: not a binding yet.
  if (MODIFIER_KEYS.has(key)) return null;
  const hasModifier = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
  if (!hasModifier && !options.typingKeysAllowed && !standaloneName(key, code)) return null;

  const parts: string[] = [];
  // Control and Command stay separate unless both are held: collapsing
  // either into CommandOrControl hijacked Cmd+X for a user who meant
  // Ctrl+X on macOS, and vice versa.
  if (e.ctrlKey && e.metaKey) parts.push("CommandOrControl");
  else if (e.metaKey) parts.push("Command");
  else if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  const main = mainKeyName(key, code);
  if (!main) return null;
  parts.push(main);
  return parts.join("+");
}

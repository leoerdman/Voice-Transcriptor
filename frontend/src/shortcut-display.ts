/**
 * Cross-platform Electron accelerator → Settings keycap label tokens.
 *
 * Electron sends a platform-aware accelerator string back to the renderer
 * ("CommandOrControl+LShift+F9"), but ``acceleratorToDisplayTokens`` is the
 * one place the Settings UI renders it back into user-readable chips. The
 * previous implementation assumed Mac everywhere and printed "Cmd" on
 * Linux/Windows; the canonical normalization step here turns every variant
 * of "CommandOrControl"/"Cmd"/"Meta"/"Super" into the user's actual
 * platform-specific word, while leaving letters/function keys untouched.
 *
 * Pure: no DOM, no globals — directly unit-testable.
 */

export function normalizeAcceleratorForDisplay(acc: string, isMac: boolean): string {
  if (!acc) return acc;
  return acc
    .split("+")
    .map((tok) => {
      const lc = tok.trim().toLowerCase();
      if (isMac) {
        if (lc === "commandorcontrol" || lc === "cmdorctrl") return "Command";
        if (lc === "meta") return "Command";
        return tok.trim();
      }
      if (lc === "command" || lc === "cmd" || lc === "meta") return "Super";
      if (lc === "commandorcontrol" || lc === "cmdorctrl") return "Control";
      return tok.trim();
    })
    .join("+");
}

export function acceleratorToDisplayTokens(acc: string, isMac: boolean): string[] {
  if (!acc) return ["—"];
  const normalized = normalizeAcceleratorForDisplay(acc, isMac);
  const parts = normalized.split("+");
  const labels: string[] = [];
  for (const p of parts) {
    const lc = p.trim().toLowerCase();
    if (isMac && (lc === "command" || lc === "cmd")) { labels.push("Command"); continue; }
    if (!isMac && lc === "super") { labels.push("Super"); continue; }
    // CommandOrControl never reaches this loop: the normalisation above
    // already turned it into the platform's word. Restating that mapping
    // here was a second place to change it.
    if (lc === "control" || lc === "ctrl") { labels.push("Control"); continue; }
    if (lc === "alt" || lc === "option") { labels.push(isMac ? "Option" : "Alt"); continue; }
    if (lc === "shift") { labels.push("Shift"); continue; }
    if (lc === "tab") { labels.push("Tab"); continue; }
    if (lc === "enter" || lc === "return") { labels.push("Return"); continue; }
    if (lc === "esc" || lc === "escape") { labels.push("Esc"); continue; }
    if (lc === "space" || lc === "spacebar") { labels.push("Space"); continue; }
    if (lc === "backspace" || lc === "delete") { labels.push("Delete"); continue; }
    if (lc === "up" || lc === "arrowup") { labels.push("↑"); continue; }
    if (lc === "down" || lc === "arrowdown") { labels.push("↓"); continue; }
    if (lc === "left" || lc === "arrowleft") { labels.push("←"); continue; }
    if (lc === "right" || lc === "arrowright") { labels.push("→"); continue; }
    labels.push(p.trim());
  }
  return labels;
}

/** What the desktop shell reports for one slot after registering it. */
export interface ShortcutSlotStatus {
  active?: string;
  desired?: string;
  error?: string;
}

export interface ShortcutBadge {
  conflict: boolean;
  title: string;
}

/** F1–F12: the keys macOS treats as media keys when Fn mode is off. */
const MAC_MEDIA_FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

/**
 * The conflict badge of one shortcut button in Settings.
 *
 * Two ways a shortcut that looks saved does nothing: the OS refused the
 * registration (another app owns it), or macOS with "F-keys as media
 * keys" swallows an F1–F12 press before the app sees it — registration
 * succeeds and the handler never fires. The screenshot key is bound
 * only while screen mode runs, so "not active" is its normal state at
 * rest; only an error is a conflict for it.
 */
export function shortcutBadge(
  slotId: string,
  status: ShortcutSlotStatus,
  macFnCollision: boolean,
): ShortcutBadge {
  const active = slotId === "screenShot" ? !status.error : !!status.active;
  const desired = status.desired || "";
  if (!active) {
    return { conflict: true, title: `Not registered: ${status.error || "unknown reason"}` };
  }
  if (macFnCollision && MAC_MEDIA_FUNCTION_KEY.test(desired)) {
    return {
      conflict: true,
      title:
        `macOS is intercepting ${desired} as a media key. `
        + `Either enable System Settings → Keyboard → Keyboard Shortcuts → Function Keys → "Use F1, F2 as standard function keys", `
        + `or hold Fn while pressing ${desired}, `
        + `or pick a non-F-key accelerator here.`,
    };
  }
  return { conflict: false, title: "" };
}

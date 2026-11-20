"use strict";

// The Windows PowerShell paste fallback's script (Ultra-Audit 2026-11-20
// DM-04).
//
// It runs after the VBS attempt failed, and its job is the same: bring
// the captured target to the front, then send Ctrl+V. The copy that lived
// inline in main.js discarded SetForegroundWindow's result (``| Out-Null``
// inside ``try { … } catch {}``) and sent the keystroke regardless — so
// when activation failed, which is what a plain SetForegroundWindow from
// an unrelated PowerShell child usually does, the transcript was typed
// into whatever was foreground, often Transcriptor itself. The VBS rung
// and the three activate* helpers were fixed for exactly this (D-006);
// this fourth copy was not.
//
// The rule now: no window handle, or an activation the OS refused, ends
// the script with ``ERR:activate`` and exit 2 BEFORE any keystroke. A
// target with neither an hwnd nor a pid has nothing this script could
// activate, so there is no script at all.
//
// Pure: returns a string; desktop/windows-paste-fallback.test.js.

const { PASTE_ERR_ACTIVATE: ERR_ACTIVATE, PWSH_PASTE_OK: OK_PWSH_PASTE } = require("./paste-protocol");

/**
 * @param {{hwndHex?: string, pid?: number}} target
 *   ``hwndHex`` — the window handle as hex digits (no 0x); ``pid`` — a
 *   positive integer. The hwnd wins when both are present.
 * @returns {string} the PowerShell command, or "" when there is no window
 *   to activate.
 */
function buildPwshPasteFallbackScript({ hwndHex = "", pid = 0 } = {}) {
  const hex = /^[0-9a-fA-F]{1,16}$/.test(String(hwndHex || "")) ? String(hwndHex) : "";
  const safePid = Number.isSafeInteger(pid) && pid > 0 && pid < 2 ** 31 ? pid : 0;
  if (!hex && !safePid) return "";
  const resolveHandle = hex
    ? `try { $h = [IntPtr]::new([Int64]::Parse('${hex}', [System.Globalization.NumberStyles]::AllowHexSpecifier)) } catch { };`
    : `try { $h = (Get-Process -Id ${safePid} -ErrorAction Stop).MainWindowHandle } catch { };`;
  const refuse = `{ Write-Output "${ERR_ACTIVATE}"; exit 2 }`;
  return (
    `Add-Type @"\n` +
    `using System;\n` +
    `using System.Runtime.InteropServices;\n` +
    `public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd); }\n` +
    `"@;\n` +
    `$h = [IntPtr]::Zero;\n` +
    `${resolveHandle}\n` +
    `if ($h -eq [IntPtr]::Zero) ${refuse};\n` +
    (hex ? `[W]::ShowWindowAsync($h, 5) | Out-Null;\n` : "") +
    `if (-not [W]::SetForegroundWindow($h)) ${refuse};\n` +
    `Start-Sleep -Milliseconds 120;\n` +
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^{v}"); Write-Output "${OK_PWSH_PASTE}"`
  );
}

module.exports = { ERR_ACTIVATE, OK_PWSH_PASTE, buildPwshPasteFallbackScript };

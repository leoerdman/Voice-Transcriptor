/**
 * Map a raw backend-startup error string to a user-actionable message.
 *
 * The main process replays ``uvicorn`` stderr tails verbatim through
 * ``__setBackendBootError`` — absolute paths, Python tracebacks, OS error
 * codes (``EADDRINUSE``, ``WinError 10013``). Rendering them raw is (a)
 * scary to non-technical users, (b) info-leaky to anyone who photographs
 * the window. The known families get actionable copy; the raw text stays
 * behind a "Show technical details" disclosure.
 *
 * FQ-14 (the parts that are the renderer's): ``winerror 5`` was a
 * substring test, so WinError 50 / 53 / 54… read as "data directory not
 * writable"; WinError 10013 — named in this very header — matched nothing;
 * and the Python copy said "3.10+" although no 3.10 minimum exists
 * anywhere (``.python-version`` is the SSOT, and the bundled runtime is
 * what normally runs). Matching on English prose from another process
 * stays until the main process sends a code (cross-domain).
 */

export interface BootErrorCopy {
  headline: string;
  detail: string;
}

const winError = (low: string, code: number): boolean => new RegExp(`\\bwinerror ${code}\\b`).test(low);

export function classifyBootError(raw: string): BootErrorCopy {
  const low = (raw || "").toLowerCase();
  if (!low) {
    return {
      headline: "Backend failed to start.",
      detail: "Unknown startup failure — check the main.log in the data directory.",
    };
  }
  if (low.includes("address already in use") ||
      low.includes("eaddrinuse") ||
      winError(low, 10048) ||
      low.includes("only one usage of each socket address")) {
    // Do NOT name a port here. The backend scans upward from
    // TRANSCRIPTOR_PORT (default 8321) through 24 candidates before
    // falling back to an OS-assigned port, so the number that actually
    // collided is rarely 8321; the real port is in the technical details.
    return {
      headline: "The backend port is already in use.",
      detail: "Another copy of Transcriptor is still running. Close it via the tray icon (or reboot if that doesn't work) and try again. The exact port is in the technical details below.",
    };
  }
  if (winError(low, 10013) || low.includes("forbidden by its access permissions")) {
    return {
      headline: "Windows blocked the backend port.",
      detail: "The port is reserved by Windows or blocked by a firewall or antivirus. Allow Transcriptor through the firewall, or restart the computer, and try again. The exact port is in the technical details below.",
    };
  }
  if (low.includes("permission denied") ||
      low.includes("eacces") ||
      winError(low, 5)) {
    return {
      headline: "Transcriptor couldn't access its data directory.",
      detail: "Check that Transcriptor's data directory is writable by your user account. On Windows, verify no antivirus is blocking %APPDATA%\\Transcriptor.",
    };
  }
  if (low.includes("no module named") || low.includes("modulenotfounderror")) {
    return {
      headline: "A Python dependency is missing.",
      detail: "The bundled runtime is incomplete. Reinstall Transcriptor from the same installer (.exe / .dmg / .AppImage) to restore it.",
    };
  }
  if (low.includes("python 3 interpreter was not found") ||
      low.includes("python: not found") ||
      low.includes("python was not found")) {
    return {
      headline: "Python 3 is required.",
      detail: "Install Python 3 from python.org, then reopen Transcriptor. Linux users: `sudo apt install python3 python3-venv python3-pip`.",
    };
  }
  // Unknown family — generic copy + let the user open the log.
  return {
    headline: "Backend failed to start.",
    detail: "Open the log file from the support section below and share the tail with support, or reinstall from the latest installer.",
  };
}

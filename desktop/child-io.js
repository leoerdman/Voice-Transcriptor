"use strict";

// SSOT for "how does a child process's text output get decoded".
//
// `runCommand` used to decode every child stream as UTF-8 unconditionally
// while separately teaching PowerShell to *emit* UTF-8. The two halves of
// that decision lived apart, and a third invocation broke the rule
// silently: `cscript //U <script>.vbs` — `//U` means "use Unicode for
// redirected I/O", i.e. cscript writes UTF-16LE. Decoded as UTF-8 the
// receipt `OK:vbs-paste` arrives as `O\0K\0:\0v\0…`, so
// `isVbsPasteSuccess` returned false for every SUCCESSFUL Windows paste
// and the ladder fell through to the PowerShell fallback, which sent a
// second Ctrl+V. The user got the transcript twice — the duplication that
// was previously blamed on double queueing and "fixed" with a
// recordingId dedupe that could not possibly catch it, because both
// pastes happen inside one task.
//
// The encoding is therefore derived from the command line itself, in one
// place, so it cannot drift from the flag that causes it.

/** `powershell`/`pwsh` are made to emit UTF-8 with this prelude. */
const POWERSHELL_UTF8_PRELUDE =
  "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";

/**
 * The encoding a child's stdout/stderr will actually be written in.
 *
 * @returns {"utf8"|"utf16le"}
 */
function childStreamEncoding(cmd, args = []) {
  const base = String(cmd || "").toLowerCase().replace(/\.exe$/, "");
  if (base === "cscript" || base === "wscript") {
    // //U is cscript's own declaration that redirected I/O is Unicode
    // (UTF-16LE). Honour what the command line says rather than assuming.
    const unicode = (args || []).some((a) => String(a || "").toLowerCase() === "//u");
    if (unicode) return "utf16le";
  }
  return "utf8";
}

/**
 * cscript //U prefixes redirected output with a UTF-16LE BOM, which
 * survives decoding as U+FEFF and would sit in front of the first
 * protocol marker. Strip it once, where the decoding happens.
 */
function stripBom(text) {
  const s = String(text == null ? "" : text);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * PowerShell writes stdout in the system OEM code page (CP866 / CP1251 /
 * CP932 / …) unless told otherwise, which turns Cyrillic and CJK window
 * titles into mojibake. Returns args with the UTF-8 prelude prepended to
 * the `-Command` script; any other command line is returned untouched
 * (same array identity, so callers can tell nothing changed).
 */
function withUtf8OutputPrelude(cmd, args = []) {
  const base = String(cmd || "").toLowerCase().replace(/\.exe$/, "");
  if (base !== "powershell" && base !== "pwsh") return args;
  const cmdIdx = args.findIndex((a) => String(a || "").toLowerCase() === "-command");
  if (cmdIdx < 0 || cmdIdx + 1 >= args.length) return args;
  const script = args[cmdIdx + 1];
  if (typeof script !== "string" || script.startsWith(POWERSHELL_UTF8_PRELUDE)) return args;
  const next = args.slice();
  next[cmdIdx + 1] = POWERSHELL_UTF8_PRELUDE + script;
  return next;
}

/**
 * A child's stdout/stderr arrives in pipe-sized chunks, not lines. A
 * chunk can hold several records, or end in the middle of one.
 *
 * The backend's stderr used to be logged one chunk per main.log line,
 * whitespace collapsed: two records written in the same millisecond
 * (the `[multi]` and `[ru]` readings, say) came out glued into one
 * line, a record split across two chunks came out as two half-lines,
 * and a burst over the length cap lost its tail. Splitting on the
 * record separator, here, gives every record its own timestamped line.
 *
 * `push` takes decoded text (`stream.setEncoding` keeps multi-byte
 * characters whole across chunks); `flush` emits a final record that
 * had no trailing newline — call it on the stream's `end`. A line
 * longer than `maxLineChars` without a newline is emitted rather than
 * buffered without bound.
 *
 * @param {(line: string) => void} onLine  receives each non-blank line,
 *   trailing whitespace (`\r` included) removed, indentation kept
 * @param {{maxLineChars?: number}} [options]
 */
function createLineSplitter(onLine, { maxLineChars = 64 * 1024 } = {}) {
  let buffer = "";
  const emit = (line) => {
    const text = line.replace(/\s+$/, "");
    if (text.trim()) onLine(text);
  };
  return {
    push(chunk) {
      buffer += String(chunk == null ? "" : chunk);
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
      if (buffer.length > maxLineChars) {
        emit(buffer);
        buffer = "";
      }
    },
    flush() {
      const rest = buffer;
      buffer = "";
      emit(rest);
    },
  };
}

module.exports = {
  POWERSHELL_UTF8_PRELUDE,
  childStreamEncoding,
  createLineSplitter,
  stripBom,
  withUtf8OutputPrelude,
};

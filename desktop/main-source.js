"use strict";

// Test helper: read desktop/main.js and cut out one top-level function.
//
// main.js cannot be required outside Electron, so the suites that check
// how it is WIRED (which module decides, which function writes the
// clipboard) read its source. Top-level declarations in main.js start at
// column 0, so a function's text runs from its declaration to the next
// column-0 declaration. Not shipped (absent from build.files).

const fs = require("node:fs");
const path = require("node:path");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

function topLevelFunctionSource(name, source = mainSource) {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, "m");
  const m = re.exec(source);
  if (!m) return "";
  const rest = source.slice(m.index + m[0].length);
  const next = /^(?:async function |function |const |let |app\.|ipcMain\.|\/\/ ──)/m.exec(rest);
  return source.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length));
}

module.exports = { mainSource, topLevelFunctionSource };

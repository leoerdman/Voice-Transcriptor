"use strict";

// Every AppleScript in main.js must actually compile.
//
// ── Why this file exists ──────────────────────────────────────────────
//
// The paste script is ~110 lines of AppleScript living inside a
// JavaScript template literal. A comment written in the house style —
// double backticks around an identifier, used ~200 times elsewhere in
// main.js — put a backtick inside that template. The literal ended
// there, and what followed parsed as a tagged template: valid
// JavaScript, so `node --check` passed, and the file only failed when a
// user pressed Stop and the transcript went nowhere:
//
//   [post-stop-queue] task-error rec=1
//     err="escapedApppidescapedWindowTitle is not a function"
//
// Nothing in the suite executed that code, because building the script
// needs Electron. Nothing needs to: the scripts are text, and macOS
// ships a compiler for them. `osacompile` parses without running, so a
// truncated template (unbalanced `tell`/`try`) fails here in
// milliseconds instead of in production.
//
// This also covers the AppleScript itself — a mistyped `end if`, a
// stray keyword — which no amount of JavaScript checking would see.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Every file that builds AppleScript out of template literals. The paste
// script moved into its own module (desktop/paste-script.js) so that its
// two real shapes can be compiled by desktop/paste-script.test.js; this
// scan still covers it, because a stray backtick truncates a template
// wherever it lives.
const APPLESCRIPT_SOURCES = ["main.js", "paste-script.js"].map((f) => path.join(__dirname, f));

/**
 * Every template literal in `source`, as {value, line} — `value` being
 * the raw text with `${...}` substitutions left in place.
 *
 * A real scanner rather than a regex because the file contains
 * apostrophes in comments, `//` inside strings, and nested `${}`
 * expressions that themselves contain templates. Getting any of those
 * wrong would mean silently scanning nothing, which is the one outcome
 * a guard must not have — `templatesAreFound` below asserts against it.
 */
function templateLiterals(source) {
  const found = [];
  let i = 0;
  let line = 1;
  const stack = []; // template nesting: each entry collects its text

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "\n") line += 1;

    if (stack.length > 0 && stack[stack.length - 1].inTemplate) {
      const top = stack[stack.length - 1];
      if (c === "\\") {
        top.text += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        found.push({ value: top.text, line: top.line });
        i += 1;
        continue;
      }
      if (c === "$" && next === "{") {
        top.text += "${";
        stack.push({ inTemplate: false, braces: 1, owner: top });
        i += 2;
        continue;
      }
      top.text += c;
      i += 1;
      continue;
    }

    // Expression context (inside `${ ... }`) or top level.
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i + 1 < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      // A quoted string ends at its quote OR at the end of its line: a
      // JavaScript string literal cannot span an unescaped newline, so
      // stopping there makes the scan RESYNCHRONISE once per line. That
      // matters because this scanner does not track regular-expression
      // literals, and a regex containing a quote — `.replace(/"/g, …)` —
      // otherwise opens a "string" that swallows the rest of the file,
      // including every template it was supposed to find. (Measured: it
      // silently found 0 templates in paste-script.js.)
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote && source[i] !== "\n") {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      if (source[i] === quote) i += 1;
      continue;
    }
    if (c === "`") {
      stack.push({ inTemplate: true, text: "", line });
      i += 1;
      continue;
    }
    if (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (c === "{") top.braces += 1;
      if (c === "}") {
        top.braces -= 1;
        if (top.braces === 0) {
          stack.pop();
          stack[stack.length - 1].text += "}";
          i += 1;
          continue;
        }
      }
      top.owner.text += c;
    }
    i += 1;
  }
  return found;
}

/** Templates that are AppleScript source rather than HTML/JS/SQL. */
function appleScriptTemplates(source) {
  return templateLiterals(source).filter((t) => {
    const text = t.value;
    return (
      /\btell application\b/.test(text) ||
      /\btell process\b/.test(text) ||
      /^\s*set \w+ to /m.test(text)
    );
  });
}

/**
 * Replace `${expr}` with a literal a compiler will accept in every
 * position the real code interpolates into: a bare number, and the body
 * of a quoted string.
 */
function withPlaceholders(text) {
  return text.replace(/\$\{[^}]*\}/g, "0");
}

const scripts = APPLESCRIPT_SOURCES.flatMap((file) =>
  appleScriptTemplates(fs.readFileSync(file, "utf8")).map((script) => ({
    ...script,
    file: path.basename(file),
  })),
);

test("the scanner finds the AppleScript sources it is meant to guard", () => {
  // A scanner that silently matches nothing would make every test below
  // pass while checking nothing at all.
  assert.ok(
    scripts.length >= 4,
    `expected at least 4 AppleScript templates, found ${scripts.length}`,
  );
  const joined = scripts.map((s) => s.value).join("\n");
  assert.match(joined, /menu item "Paste"/, "the paste script must be among them");
  // The key code is a parameter now (KeyLayout.swift reads the layout);
  // the anchor is the statement, not a position, so this still proves the
  // Cmd+V fallback was found without restating a number the script no
  // longer owns.
  assert.match(joined, /key code \$\{safeKey\} using \{command down\}/, "the Cmd+V fallback must be among them");
});

test("no AppleScript template is cut short by a stray backtick", () => {
  // The failure this file was written for. A backtick inside the
  // template ends it early, so the tail of the script — every `end
  // tell` — lands outside the string. Cheap structural check, run even
  // where osacompile does not exist.
  for (const script of scripts) {
    // Only the BLOCK form needs an "end tell". The one-line form —
    // `tell application "X" to activate` — is complete on its own, so a
    // count that included it would report a phantom imbalance.
    const opens = (script.value.match(/^\s*tell\b(?!.*\bto\b).*$/gm) || []).length;
    const closes = (script.value.match(/^\s*end tell\b/gm) || []).length;
    assert.equal(
      opens,
      closes,
      `template at ${script.file}:${script.line} has ${opens} "tell" and ${closes} "end tell"`,
    );
  }
});

test("every AppleScript in main.js compiles", { skip: process.platform !== "darwin" }, () => {
  const probe = spawnSync("osacompile", ["-h"], { encoding: "utf8" });
  if (probe.error) {
    // osacompile ships with macOS; if it is genuinely missing the
    // structural test above is what remains.
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcriptor-applescript-"));
  try {
    scripts.forEach((script, index) => {
      const out = path.join(dir, `script-${index}.scpt`);
      const res = spawnSync("osacompile", ["-o", out], {
        input: withPlaceholders(script.value),
        encoding: "utf8",
      });
      assert.equal(
        res.status,
        0,
        `AppleScript at ${script.file}:${script.line} does not compile:\n${(res.stderr || "").trim()}`,
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

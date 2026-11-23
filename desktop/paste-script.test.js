"use strict";

// Executable specification for the macOS paste script.
//
// desktop/applescript.test.js compiles the template literals it finds in
// the source with every `${...}` replaced by a bare 0 — it can prove the
// text around the interpolations is well formed, but it never sees the
// script that actually runs. This file does: paste-script.js is pure, so
// the real source of BOTH shapes (verifying and not) can be built here
// and handed to osacompile.
//
// The properties that matter:
//   1. Both shapes compile.
//   2. verify:false emits NO accessibility read — that is the whole
//      point of the flag (BUGS_AUDIT §6.6 / hotfix A3: two AX reads were
//      burned on every paste into an app that can never be verified).
//   3. verify:false returns the plain "OK:menu-paste-primary" form,
//      which paste-result.js reads as an unverified success.
//   4. Interpolated target text cannot escape its string literal.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  AX_READ_TIMEOUT_SEC,
  AX_VERIFY_POLLS,
  AX_VERIFY_POLL_INTERVAL_SEC,
  AX_TRACE_PREFIX,
  PASTE_SENT_PREFIX,
  QWERTY_V_KEY_CODE,
  escapeAppleScriptString,
  pasteKeyFromAnswer,
  robustPasteScript,
  menuPasteFallbackScript,
} = require("./paste-script");

const TARGET = Object.freeze({
  appName: "Claude",
  windowTitle: "Claude",
  pid: 4242,
  pastedTextLen: 17,
});

/** Every accessibility read the script could possibly perform. */
const AX_READ_TOKENS = ["AXFocusedUIElement", "AXValue", "AXNumberOfCharacters"];

/**
 * The executable half of the script. Comments explain which reads the
 * script deliberately avoids, so they name the very attributes the
 * assertions below forbid — what matters is that nothing RUNS them.
 */
function statementsOf(script) {
  return String(script)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

test("verify:false emits no accessibility read at all", () => {
  const script = statementsOf(robustPasteScript({ ...TARGET, verify: false }));
  for (const token of AX_READ_TOKENS) {
    assert.ok(
      !script.includes(token),
      `a non-verifying paste script must not mention ${token}`,
    );
  }
  assert.ok(!script.includes("with timeout"), "no read means no read bound to spend");
  assert.ok(!script.includes(AX_TRACE_PREFIX), "no read means no read timing markers");
});

test("verify:false returns the plain OK:menu-paste-primary form", () => {
  const script = robustPasteScript({ ...TARGET, verify: false });
  assert.match(script, /return "OK:menu-paste-primary" & activationTag & ""/);
  assert.match(script, /return "OK:robust-paste" & activationTag & ""/);
  assert.ok(!script.includes(":verified"), "nothing can append a verification suffix");
});

test("verify:true emits both reads, each bounded OUTSIDE its tell block", () => {
  const script = robustPasteScript({ ...TARGET, verify: true });
  for (const token of AX_READ_TOKENS) {
    assert.ok(script.includes(token), `a verifying paste script must read ${token}`);
  }
  assert.match(script, /set beforeLen to my axFocusedValueLength\(p, "before"\)/);
  assert.match(script, /if beforeLen is not -1 then set afterLen to my axAwaitPasteGrowth\(p, beforeLen, pastedTextLen\)/);
  // The bound only works when the timeout statement wraps the tell —
  // measured on macOS 27: inside the block it bounds nothing at all.
  const bounded = new RegExp(
    `with timeout of ${AX_READ_TIMEOUT_SEC} second\\s*\\n\\s*tell application "System Events"`,
    "g",
  );
  const wrapped = script.match(bounded) || [];
  assert.equal(wrapped.length, 3, "each of the three reads carries its own wrapping bound");
  // ...and never the other way round.
  assert.ok(
    !/tell application "System Events"\s*\n\s*with timeout/.test(script),
    "a timeout inside a tell block bounds nothing",
  );
});

test("verify:true skips the after-read when the before-read failed", () => {
  // The verdict is a comparison of the two reads, so an unusable
  // "before" makes "after" pure cost against an app that may be the very
  // one whose reads hang.
  const script = robustPasteScript({ ...TARGET, verify: true });
  const afterReads = script.match(/my axAwaitPasteGrowth\(p, beforeLen, pastedTextLen\)/g) || [];
  const guards = script.match(/if beforeLen is not -1 then set afterLen to/g) || [];
  assert.equal(afterReads.length, 2, "one after-read per return path");
  assert.equal(guards.length, 2, "each of them is guarded");
});

test("the after-read waits for the paste instead of reading before it lands", () => {
  // `key code` and `click` post an event and return; the target applies
  // it on its own run loop. Reading the length on the next line measured
  // the element BEFORE the paste, so afterLen - beforeLen was 0 and
  // EVERY paste came back ":unverified" — which made the verification
  // policy switch verification off for each app after two pastes, and
  // meant the user's previous clipboard was never restored, because that
  // gate only opens for a verified paste.
  const script = statementsOf(robustPasteScript({ ...TARGET, verify: true }));
  assert.match(
    script,
    new RegExp(`repeat ${AX_VERIFY_POLLS} times\\s*\\n\\s*delay ${AX_VERIFY_POLL_INTERVAL_SEC}`),
    "the after-read polls, it does not read once and guess",
  );
  assert.match(script, /if \(axLen - beforeLen\) is equal to expectedLen then exit repeat/,
    "polling stops the moment the paste is visible, so the common case pays one interval");
  assert.ok(
    AX_VERIFY_POLLS * AX_VERIFY_POLL_INTERVAL_SEC <= 0.25,
    "the poll loop's own sleeping must stay small against the verification allowance",
  );
});

test("an element's value is evaluated before it is counted", () => {
  // Measured against a scratch TextEdit document holding "abcde":
  //   count of (value of attribute "AXValue" of axElem)  -> 1
  //   set v to (value of ...) : count of v               -> 5
  // Inside a `tell application "System Events"` block the inline form
  // counts the ELEMENTS of an object specifier, not the characters of
  // the string. It returned 1 for every readable value, so beforeLen and
  // afterLen were both 1 and no paste could ever verify — and
  // AXNumberOfCharacters, which reports the right number, was
  // unreachable because it is only consulted when the first read
  // returns -1.
  const script = statementsOf(robustPasteScript({ ...TARGET, verify: true }));
  assert.ok(
    !/count of \(value of attribute/.test(script),
    "counting an attribute specifier inline counts elements, not characters",
  );
  assert.match(script, /set axValue to \(value of attribute "AXValue" of axElem\)/);
  assert.match(script, /set axLen to \(count of \(axValue as text\)\)/);
});

test("the paste is receipted the instant it is out, before anything that can block", () => {
  // A wall-clock kill after the keystroke but before the return is
  // indistinguishable from a kill before the keystroke unless the script
  // says so — and retrying a paste that already landed puts the
  // transcript into the target twice.
  for (const verify of [false, true]) {
    const script = statementsOf(robustPasteScript({ ...TARGET, verify }));
    assert.ok(script.includes(`log "${PASTE_SENT_PREFIX}menu-paste-primary"`), `verify:${verify}`);
    assert.ok(script.includes(`log "${PASTE_SENT_PREFIX}robust-paste"`), `verify:${verify}`);
    // Emitted AFTER the injection...
    assert.ok(
      script.indexOf("click pasteMenuItem") < script.indexOf(`log "${PASTE_SENT_PREFIX}menu-paste-primary"`),
      `verify:${verify}: a receipt before the click would be a lie`,
    );
    assert.ok(
      script.indexOf("key code 9") < script.indexOf(`log "${PASTE_SENT_PREFIX}robust-paste"`),
      `verify:${verify}: a receipt before the keycode would be a lie`,
    );
  }
  // ...and BEFORE the read that can burn the rest of the budget.
  const verifying = statementsOf(robustPasteScript({ ...TARGET, verify: true }));
  assert.ok(
    verifying.indexOf(`log "${PASTE_SENT_PREFIX}menu-paste-primary"`) <
    verifying.indexOf("my axAwaitPasteGrowth(p, beforeLen, pastedTextLen)"),
    "a receipt after the verification read could not survive a kill during it",
  );
});

test("the pasted length is interpolated as a number, never as text", () => {
  const script = robustPasteScript({ ...TARGET, pastedTextLen: 17, verify: true });
  assert.match(script, /set pastedTextLen to 17\n/);
  const injected = robustPasteScript({ ...TARGET, pastedTextLen: '9" & (do shell script "x")', verify: true });
  assert.match(injected, /set pastedTextLen to 9\n/);
  assert.match(robustPasteScript({ ...TARGET, pid: -5 }), /set targetPid to 0\n/);
});

test("the pressed key code is the caller's, not a fixed QWERTY position", () => {
  // A virtual key code names a POSITION: code 9 is V on QWERTY and K on
  // Dvorak, whose ⌘V is code 47. KeyLayout.swift is the one place that
  // reads the layout; the AppleScript receives its answer as a parameter.
  const pressed = (source) => {
    const m = /key code (\d+) using \{command down\}/.exec(source);
    return m ? Number(m[1]) : null;
  };
  assert.equal(pressed(robustPasteScript({ ...TARGET, vKeyCode: 47, verify: false })), 47);
  assert.equal(pressed(robustPasteScript({ ...TARGET, vKeyCode: 47, verify: true })), 47);
  // Nothing answered: the QWERTY last resort, the same one the native
  // path uses when a layout gives no "v".
  assert.equal(pressed(robustPasteScript({ ...TARGET })), QWERTY_V_KEY_CODE);
  // A value that is not a key position never reaches the script.
  for (const bad of ["not-a-number", 128, -1, 9.5]) {
    assert.equal(pressed(robustPasteScript({ ...TARGET, vKeyCode: bad })), QWERTY_V_KEY_CODE, String(bad));
  }
});

test("the paste key is KeyLayout.swift's answer, with one documented last resort", () => {
  assert.deepEqual(
    pasteKeyFromAnswer({ t: "paste-key", code: 47, layout: "com.apple.keylayout.Dvorak" }),
    { code: 47, layout: "com.apple.keylayout.Dvorak", source: "helper" },
  );
  for (const answer of [null, undefined, { t: "lost" }, { t: "paste-key" }, { t: "paste-key", code: "47" }, { t: "paste-key", code: 128 }]) {
    assert.deepEqual(
      pasteKeyFromAnswer(answer),
      { code: QWERTY_V_KEY_CODE, layout: "", source: "fallback" },
      JSON.stringify(answer),
    );
  }
  // The number is written twice — once for each language — because the
  // Swift binary cannot read this file. This is what keeps them equal.
  const swift = fs.readFileSync(path.join(__dirname, "native", "dictation-helper", "KeyLayout.swift"), "utf8");
  const declared = /let qwertyVKeyCode: CGKeyCode = (\d+)/.exec(swift);
  assert.ok(declared, "KeyLayout.swift declares qwertyVKeyCode");
  assert.equal(Number(declared[1]), QWERTY_V_KEY_CODE, "qwertyVKeyCode and QWERTY_V_KEY_CODE drifted");
});

test("main.js takes the key from the helper, not from a literal", () => {
  const { mainSource, topLevelFunctionSource } = require("./main-source");
  assert.match(mainSource, /dictationHelper\.request\("paste-key"/, "the helper owns the layout read");
  assert.match(
    topLevelFunctionSource("pasteFromClipboard"),
    /vKeyCode: pasteKey\.code/,
    "the AppleScript receives that answer instead of a fixed position",
  );
});

test("target text cannot break out of its AppleScript string literal", () => {
  const script = robustPasteScript({
    appName: 'Ev"il\nApp',
    windowTitle: 'a\\b"c',
    pid: 1,
    pastedTextLen: 1,
    verify: false,
  });
  assert.match(script, /set targetApp to "Ev\\"ilApp"\n/);
  assert.match(script, /set targetWindowTitle to "a\\\\b\\"c"\n/);
  assert.equal(escapeAppleScriptString("a\u0000b"), "ab");
});

test("every shape the product runs compiles", { skip: process.platform !== "darwin" }, () => {
  const probe = spawnSync("osacompile", ["-h"], { encoding: "utf8" });
  if (probe.error) return; // osacompile ships with macOS; nothing to do without it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcriptor-paste-script-"));
  try {
    // Both verification shapes on the QWERTY position, and both on a
    // Dvorak key code the helper really answers with.
    for (const [verify, vKeyCode] of [[false, QWERTY_V_KEY_CODE], [true, QWERTY_V_KEY_CODE], [false, 47], [true, 47]]) {
      const out = path.join(dir, `paste-verify-${verify}-key-${vKeyCode}.scpt`);
      const res = spawnSync("osacompile", ["-o", out], {
        input: robustPasteScript({ ...TARGET, verify, vKeyCode }),
        encoding: "utf8",
      });
      assert.equal(
        res.status,
        0,
        `robustPasteScript({verify:${verify}, vKeyCode:${vKeyCode}}) does not compile:\n${(res.stderr || "").trim()}`,
      );
    }
    // The secondary fallback too. It used to be a hand-written template in
    // main.js, so nothing compiled it: applescript.test.js scans template
    // LITERALS, and that one was interpolated at three places with values
    // main.js escaped itself.
    const fallbackOut = path.join(dir, "menu-paste-fallback.scpt");
    const fallback = spawnSync("osacompile", ["-o", fallbackOut], {
      input: menuPasteFallbackScript({ appName: TARGET.appName, pid: TARGET.pid }),
      encoding: "utf8",
    });
    assert.equal(
      fallback.status,
      0,
      `menuPasteFallbackScript() does not compile:\n${(fallback.stderr || "").trim()}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the fallback escapes its interpolations with this module's helpers", () => {
  // In main.js it interpolated `escapedApp` (escaped there) and
  // `Math.trunc(pid)` — a second escaping ladder for the same protocol.
  const script = menuPasteFallbackScript({ appName: 'Ev"il\\App', pid: "417notanumber" });
  assert.match(script, /set targetApp to "Ev\\"il\\\\App"/);
  assert.match(script, /set targetPid to 417\n/);
  // A pid that is not a number at all becomes 0 (safeInt), not NaN.
  assert.match(menuPasteFallbackScript({ appName: "A", pid: "abc" }), /set targetPid to 0\n/);
  // It performs no accessibility read: the whole point of the last rung is
  // that it costs nothing beyond the click.
  assert.ok(!script.includes(AX_TRACE_PREFIX), "the fallback must not carry AX trace reads");
});

test("the fallback and the primary script speak the same ERR vocabulary", () => {
  const fallback = menuPasteFallbackScript({ appName: "A", pid: 1 });
  const primary = robustPasteScript({ ...TARGET, verify: true });
  for (const marker of ["ERR:no-accessibility", "ERR:no-process"]) {
    assert.ok(fallback.includes(marker), `fallback is missing ${marker}`);
    assert.ok(primary.includes(marker), `primary is missing ${marker}`);
  }
});

"use strict";

// Executable specification for desktop/paste-result.js — the SSOT
// "did this paste actually succeed, and can the clipboard be trusted"
// decision every method branch in tryPasteToFocusedField (desktop/main.js)
// goes through. Run: node --test desktop/  (or npm test in desktop/).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StringDecoder } = require("node:string_decoder");

const { childStreamEncoding, stripBom } = require("./child-io");
const {
  MAC_VERIFICATION,
  macVerificationOf,
  lastLineOf,
  pasteSentReceipt,
  isVbsPasteSuccess,
  parseVbsPasteOutcome,
  isPwshPasteFallbackSuccess,
  isLinuxPasteSuccess,
  parseMacPasteOutcome,
  evaluatePasteOutcome,
} = require("./paste-result");

test("vbs: requires BOTH a zero exit code AND the OK:vbs-paste marker", () => {
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "OK:vbs-paste" }), true);
  // The exact regression from BUGS_AUDIT §6.1: cscript exits 0 but the
  // script never got to the SendKeys line (e.g. AppActivate failed
  // before the fix that makes it Quit 2).
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "" }), false);
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "ERR:activate" }), false);
  // Marker present but the process itself reported failure (non-zero exit).
  assert.equal(isVbsPasteSuccess({ ok: false, stdout: "OK:vbs-paste" }), false);
});

test("vbs: tolerates surrounding whitespace/newlines from cscript", () => {
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "\r\nOK:vbs-paste\r\n" }), true);
});

test("vbs: fed the bytes cscript //U actually writes, decoded the way runCommand decodes them", () => {
  // This test used to hand the detector a hand-typed UTF-8 "OK:vbs-paste"
  // — a shape the pipeline could not produce. cscript is launched with
  // //U, so it writes UTF-16LE with a BOM; runCommand decoded every child
  // stream as UTF-8, and the receipt arrived as "O\0K\0:\0v\0…". The
  // detector said false for every SUCCESSFUL paste, the ladder fell
  // through to the PowerShell fallback and sent a second Ctrl+V. Going
  // through the real encoding decision is what keeps this test honest.
  const wire = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("OK:vbs-paste\r\n", "utf16le"),
  ]);
  const encoding = childStreamEncoding("cscript", ["//Nologo", "//B", "//U", "paste.vbs"]);
  const stdout = stripBom(new StringDecoder(encoding).end(wire));

  assert.equal(isVbsPasteSuccess({ ok: true, stdout }), true);
  assert.equal(evaluatePasteOutcome({ method: "vbs_paste", ok: true, stdout }).success, true);

  // And the failure marker survives the same round trip.
  const errWire = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("ERR:activate\r\n", "utf16le"),
  ]);
  const errOut = stripBom(new StringDecoder(encoding).end(errWire));
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: errOut }), false);
});

test("pwsh fallback: ok + any OK: marker succeeds", () => {
  assert.equal(isPwshPasteFallbackSuccess({ ok: true, stdout: "OK:pwsh-paste" }), true);
  assert.equal(isPwshPasteFallbackSuccess({ ok: true, stdout: "" }), false);
  assert.equal(isPwshPasteFallbackSuccess({ ok: false, stdout: "OK:pwsh-paste" }), false);
});

test("windows: the verdict is the last line, as on macOS — a marker inside other text is not an OK", () => {
  // An error text that happens to contain "OK:" is not the script's
  // success line; the macOS parser never accepted it and neither may
  // the Windows ones.
  assert.equal(isPwshPasteFallbackSuccess({ ok: true, stdout: "SendKeys failed: NOT OK: target gone" }), false);
  assert.equal(isPwshPasteFallbackSuccess({ ok: true, stdout: "OK:pwsh-paste\r\nERR:activate" }), false);
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "OK:vbs-paste\r\nERR:activate" }), false);
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "SENT:vbs-paste\r\nOK:vbs-paste\r\n" }), true);
});

test("linux: exit code is the only signal (no protocol string)", () => {
  assert.equal(isLinuxPasteSuccess({ ok: true }), true);
  assert.equal(isLinuxPasteSuccess({ ok: false }), false);
});

test("mac: !ok with no receipt is a failure regardless of stdout content", () => {
  const r = parseMacPasteOutcome({ ok: false, stdout: "OK:menu-paste-primary:verified" });
  assert.equal(r.success, false);
  assert.equal(r.verified, false);
  assert.equal(r.sent, false);
});

test("mac: a SENT receipt after a wall-clock kill counts as pasted-but-unverified", () => {
  // The per-attempt bound killed osascript while the AX verification
  // read was still running — AFTER the keystroke was delivered. Retrying
  // here would paste the transcript a second time.
  const r = parseMacPasteOutcome({
    ok: false,
    stdout: "",
    stderr: "SENT:robust-paste\nTimed out",
  });
  assert.equal(r.success, true, "the paste did land; the ladder must stop");
  assert.equal(r.verified, false, "nothing verified it, so the clipboard keeps the transcript");
  assert.equal(r.sent, true);
  assert.equal(r.reason, "SENT:robust-paste");
});

test("mac: a receipt does NOT override the script's own ERR verdict", () => {
  const r = parseMacPasteOutcome({
    ok: true,
    stdout: "ERR:no-focus",
    stderr: "SENT:robust-paste",
  });
  assert.equal(r.success, false);
  assert.equal(r.sent, false);
});

test("mac: the receipt on stderr does not shadow a complete OK result", () => {
  const r = parseMacPasteOutcome({
    ok: true,
    stdout: "OK:robust-paste:verified",
    stderr: "SENT:robust-paste",
  });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
  assert.equal(r.sent, true);
});

test("mac: the verdict is the LAST line, so a receipt printed to stdout cannot hide it", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "SENT:robust-paste\nOK:robust-paste:verified" });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
});

test("pasteSentReceipt only matches a marker at the start of a line", () => {
  assert.equal(pasteSentReceipt({ stderr: "SENT:menu-paste-primary\n" }), "SENT:menu-paste-primary");
  assert.equal(pasteSentReceipt({ stdout: "line\nSENT:robust-paste" }), "SENT:robust-paste");
  // A target app's own error text mentioning the word must not be read
  // as our receipt.
  assert.equal(pasteSentReceipt({ stderr: 'error: nothing was SENT:anything' }), "");
  assert.equal(pasteSentReceipt({}), "");
});

test("lastLineOf ignores blank lines and trailing newlines", () => {
  assert.equal(lastLineOf("a\n\nb\n\n"), "b");
  assert.equal(lastLineOf(""), "");
  assert.equal(lastLineOf(null), "");
});

test("mac: OK: prefix required for success", () => {
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "ERR:no-process" }).success, false);
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "" }).success, false);
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "OK:robust-paste" }).success, true);
});

test("mac: :verified suffix sets verified=true", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "OK:menu-paste-primary:verified" });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
});

test("mac: :unverified suffix sets verified=false without failing", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "OK:menu-paste-primary:unverified" });
  assert.equal(r.success, true);
  assert.equal(r.verified, false);
});

test("mac: :unverified must not be matched by a naive endsWith('verified') check", () => {
  // Regression guard: "unverified" ends with the substring "verified",
  // so a careless `out.endsWith("verified")` check would call this
  // verified. The real rule requires the colon immediately before it.
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "OK:robust-paste:unverified" }).verified, false);
});

test("mac: activation tag before the verification suffix is handled", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "OK:robust-paste+activated:verified" });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
});

test("mac: bare OK with no suffix at all (secondary menu-paste fallback) is success, unverified", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "OK:menu-paste" });
  assert.equal(r.success, true);
  assert.equal(r.verified, false);
});

test("mac: a paste run with verification switched off is a success, unverified", () => {
  // Hotfix A3: when desktop/paste-verification-policy.js has switched an
  // app off, desktop/paste-script.js emits a script with no accessibility
  // read in it, so the primary path returns the SUFFIX-LESS form. The
  // parser must read that exactly as it reads the secondary fallback: the
  // paste happened, nothing verified it, so the clipboard keeps the
  // transcript.
  for (const stdout of ["OK:menu-paste-primary", "OK:menu-paste-primary+activated", "OK:robust-paste+activated"]) {
    const r = parseMacPasteOutcome({ ok: true, stdout });
    assert.equal(r.success, true, `${stdout} is a successful paste`);
    assert.equal(r.verified, false, `${stdout} verifies nothing`);
    assert.equal(r.reason, stdout);
  }
  const dispatched = evaluatePasteOutcome({ method: "robust_paste", ok: true, stdout: "OK:menu-paste-primary\n" });
  assert.equal(dispatched.success, true);
  assert.equal(dispatched.verified, false);
});

test("mac: every ERR: the scripts emit is a failure, not a crash", () => {
  // The markers listed here are the ones desktop/paste-script.js actually
  // prints. The example used to be "ERR:secure-field", which no script has
  // ever emitted — a test can only describe the protocol if it quotes the
  // protocol.
  for (const marker of ["ERR:no-accessibility", "ERR:no-process", "ERR:no-focus", "ERR:menu-paste:boom"]) {
    assert.equal(parseMacPasteOutcome({ ok: true, stdout: marker }).success, false, marker);
  }
  // ...and an unknown ERR: is still a failure rather than a parse crash.
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "ERR:something-new" }).success, false);
});

test("evaluatePasteOutcome dispatches vbs_paste like isVbsPasteSuccess", () => {
  const r = evaluatePasteOutcome({ method: "vbs_paste", ok: true, stdout: "OK:vbs-paste" });
  assert.equal(r.success, true);
  assert.equal(r.verified, false);
  const fail = evaluatePasteOutcome({ method: "vbs_paste", ok: true, stdout: "ERR:activate" });
  assert.equal(fail.success, false);
});

test("evaluatePasteOutcome dispatches pwsh_paste_fallback", () => {
  assert.equal(evaluatePasteOutcome({ method: "pwsh_paste_fallback", ok: true, stdout: "OK:pwsh-paste" }).success, true);
});

test("evaluatePasteOutcome dispatches each linux method by ok alone", () => {
  for (const method of ["wtype", "xdotool", "ydotool"]) {
    assert.equal(evaluatePasteOutcome({ method, ok: true, stdout: "" }).success, true);
    assert.equal(evaluatePasteOutcome({ method, ok: false, stdout: "" }).success, false);
  }
});

test("evaluatePasteOutcome dispatches mac methods through parseMacPasteOutcome", () => {
  const r = evaluatePasteOutcome({ method: "robust_paste", ok: true, stdout: "OK:robust-paste:verified" });
  assert.deepEqual(r, {
    success: true,
    verified: true,
    verification: MAC_VERIFICATION.VERIFIED,
    sent: false,
    reason: "OK:robust-paste:verified",
  });
  const r2 = evaluatePasteOutcome({ method: "menu-paste-primary", ok: true, stdout: "OK:menu-paste-primary:unverified" });
  assert.equal(r2.success, true);
  assert.equal(r2.verified, false);
  const r3 = evaluatePasteOutcome({ method: "menu-paste", ok: true, stdout: "OK:menu-paste" });
  assert.equal(r3.success, true);
  assert.equal(r3.verified, false);
});

test("mac: :unreadable and :unverified are different facts, not one", () => {
  // ":unreadable" — a read returned nothing at all — says this target
  // exposes no inspectable value, and is what may switch verification
  // off for it. ":unverified" — the reads landed, the growth did not
  // match — is inconclusive. Collapsing the two is what let a merely
  // slow target be treated like a mute one, which (while the after-read
  // was taken before the paste landed) meant EVERY app.
  const unreadable = parseMacPasteOutcome({ ok: true, stdout: "OK:robust-paste:unreadable" });
  assert.equal(unreadable.success, true, "an unverifiable paste is not a failed one");
  assert.equal(unreadable.verified, false);
  assert.equal(unreadable.verification, MAC_VERIFICATION.UNREADABLE);

  const inconclusive = parseMacPasteOutcome({ ok: true, stdout: "OK:robust-paste:unverified" });
  assert.equal(inconclusive.success, true);
  assert.equal(inconclusive.verified, false);
  assert.equal(inconclusive.verification, MAC_VERIFICATION.UNVERIFIED);

  // A script that carried no reads at all reports neither.
  assert.equal(
    parseMacPasteOutcome({ ok: true, stdout: "OK:robust-paste+activated" }).verification,
    MAC_VERIFICATION.NONE,
  );
  assert.equal(macVerificationOf("OK:robust-paste+activated:verified"), MAC_VERIFICATION.VERIFIED);
  assert.equal(macVerificationOf(""), MAC_VERIFICATION.NONE);
});

test("evaluatePasteOutcome falls back to ok-only for an unknown method", () => {
  assert.equal(evaluatePasteOutcome({ method: "something-new", ok: true, stdout: "garbage" }).success, true);
  assert.equal(evaluatePasteOutcome({ method: "something-new", ok: false, stdout: "" }).success, false);
});

test("vbs: a receipt after a wall-clock kill counts as pasted-but-unverified", () => {
  // cscript's launch can spend 1-3 s in Defender's real-time scan, so the
  // per-attempt bound can kill the process between SendKeys and the final
  // Echo. `sent` used to be hardcoded false for this method and stderr was
  // never even passed in, so that kill looked like a kill before the
  // keystroke — the ladder retried and the target got the transcript twice.
  const r = parseVbsPasteOutcome({
    ok: false,
    stdout: "SENT:vbs-paste",
    stderr: "\nTimed out",
  });
  assert.equal(r.success, true, "retrying here would paste a second time");
  assert.equal(r.sent, true);
  assert.equal(r.verified, false, "nothing verified it — the clipboard must not be restored");
  assert.equal(r.reason, "SENT:vbs-paste");
});

test("vbs: a completed paste reports the receipt it saw and the OK verdict", () => {
  const r = parseVbsPasteOutcome({
    ok: true,
    stdout: "SENT:vbs-paste\r\nOK:vbs-paste\r\n",
    stderr: "",
  });
  assert.equal(r.success, true);
  assert.equal(r.sent, true);
  assert.equal(r.reason, "OK:vbs-paste", "the verdict is the last line, not the receipt");
  assert.deepEqual(
    evaluatePasteOutcome({ method: "vbs_paste", ok: true, stdout: "SENT:vbs-paste\r\nOK:vbs-paste", stderr: "" }),
    r,
  );
});

test("vbs: no receipt and no OK is still a plain failure", () => {
  const r = parseVbsPasteOutcome({ ok: true, stdout: "ERR:activate", stderr: "" });
  assert.equal(r.success, false);
  assert.equal(r.sent, false);
  assert.equal(r.reason, "ERR:activate");
});

test("the paste protocol markers are defined once and shared by every reader", () => {
  // Renaming a marker in the script used to leave every test green while
  // the production parse went blind.
  const protocol = require("./paste-protocol");
  const script = require("./paste-script");
  assert.equal(script.PASTE_SENT_PREFIX, protocol.PASTE_SENT_PREFIX);
  assert.equal(script.AX_TRACE_PREFIX, protocol.AX_TRACE_PREFIX);

  const fs = require("node:fs");
  const path = require("node:path");
  // Comments may name a marker; code may not re-declare one.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of ["main.js", "paste-result.js", "paste-script.js", "paste-verification-policy.js"]) {
    const source = stripComments(fs.readFileSync(path.join(__dirname, file), "utf8"));
    const literals = source.match(/["'`]AXT:|["'`]SENT:/g) || [];
    assert.deepEqual(
      literals,
      [],
      `${file} must take the markers from ./paste-protocol, not retype them`,
    );
  }
});

// DX-26: the Windows scripts print their markers from ./paste-protocol,
// the same constants this parser reads — renaming a method there moves
// the printer and the reader together.
test("the markers the Windows scripts print are the ones the parser accepts", () => {
  const { VBS_PASTE_SENT, VBS_PASTE_OK, PWSH_PASTE_OK } = require("./paste-protocol");
  const { buildPwshPasteFallbackScript } = require("./windows-paste-fallback");
  // The VBS echoes the receipt, then the verdict (main.js tryPasteToFocusedField).
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: `${VBS_PASTE_SENT}\r\n${VBS_PASTE_OK}\r\n` }), true);
  assert.equal(pasteSentReceipt({ stdout: `${VBS_PASTE_SENT}\r\n` }), VBS_PASTE_SENT);
  const pwsh = buildPwshPasteFallbackScript({ hwndHex: "1A2B" });
  const printed = /Write-Output "(OK:[^"]+)"/.exec(pwsh)?.[1];
  assert.equal(printed, PWSH_PASTE_OK);
  assert.equal(isPwshPasteFallbackSuccess({ ok: true, stdout: `${printed}\r\n` }), true);
  const mainSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.js"), "utf8");
  assert.doesNotMatch(mainSource, /"OK:(vbs|pwsh)-paste"|"ERR:activate"/, "main.js types no marker literal");
});

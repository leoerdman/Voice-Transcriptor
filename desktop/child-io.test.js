"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StringDecoder } = require("node:string_decoder");

const {
  POWERSHELL_UTF8_PRELUDE,
  childStreamEncoding,
  createLineSplitter,
  stripBom,
  withUtf8OutputPrelude,
} = require("./child-io");
const { isVbsPasteSuccess } = require("./paste-result");

test("cscript //U declares UTF-16LE output and is read as such", () => {
  assert.equal(childStreamEncoding("cscript", ["//Nologo", "//B", "//U", "x.vbs"]), "utf16le");
  assert.equal(childStreamEncoding("cscript.exe", ["//U", "x.vbs"]), "utf16le");
  assert.equal(childStreamEncoding("CScript", ["//u", "x.vbs"]), "utf16le");
  assert.equal(childStreamEncoding("wscript", ["//U", "x.vbs"]), "utf16le");
});

test("everything else stays UTF-8", () => {
  assert.equal(childStreamEncoding("cscript", ["//Nologo", "//B", "x.vbs"]), "utf8");
  assert.equal(childStreamEncoding("powershell", ["-NoProfile", "-Command", "echo hi"]), "utf8");
  assert.equal(childStreamEncoding("osascript", ["-e", "x"]), "utf8");
  assert.equal(childStreamEncoding(undefined, undefined), "utf8");
});

test("the real cscript //U byte stream yields a receipt the detector matches", () => {
  // This is the shape the pipeline actually produces: what `cscript //U`
  // writes, decoded the way runCommand decodes it. Decoded as UTF-8 —
  // what the code did before — every successful paste read as a failure
  // and the ladder pasted the transcript a second time.
  const wireBytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),                        // UTF-16LE BOM
    Buffer.from("OK:vbs-paste\r\n", "utf16le"),
  ]);

  const asUtf8 = stripBom(wireBytes.toString("utf8"));
  assert.equal(
    isVbsPasteSuccess({ ok: true, stdout: asUtf8 }),
    false,
    "the old UTF-8 decode is exactly why the receipt never matched",
  );

  const asDeclared = stripBom(
    new StringDecoder(childStreamEncoding("cscript", ["//U", "x.vbs"])).end(wireBytes),
  );
  assert.equal(asDeclared, "OK:vbs-paste\r\n");
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: asDeclared }), true);
});

test("a UTF-16LE code unit split across chunks still decodes", () => {
  // runCommand sets the encoding on the stream, so Node's StringDecoder
  // carries the odd byte over. Asserted here because a naive
  // buf.toString("utf16le") per chunk would not.
  const bytes = Buffer.from("OK:vbs-paste\r\n", "utf16le");
  const decoder = new StringDecoder("utf16le");
  const out = decoder.write(bytes.subarray(0, 7)) + decoder.write(bytes.subarray(7)) + decoder.end();
  assert.equal(out, "OK:vbs-paste\r\n");
});

test("stripBom removes a leading U+FEFF once, and nothing else", () => {
  assert.equal(stripBom("﻿OK:vbs-paste"), "OK:vbs-paste");
  assert.equal(stripBom("OK:vbs-paste"), "OK:vbs-paste");
  assert.equal(stripBom("OK:﻿vbs"), "OK:﻿vbs");
  assert.equal(stripBom(""), "");
  assert.equal(stripBom(null), "");
});

test("PowerShell is made to emit UTF-8, once, and only PowerShell", () => {
  const args = ["-NoProfile", "-Command", "Write-Output 'Телеграм'"];
  const out = withUtf8OutputPrelude("powershell", args);
  assert.equal(out[2], `${POWERSHELL_UTF8_PRELUDE}Write-Output 'Телеграм'`);
  assert.notEqual(out, args, "the caller's array is not mutated");

  assert.equal(withUtf8OutputPrelude("powershell", out), out, "prelude is not applied twice");
  assert.equal(withUtf8OutputPrelude("cscript", args), args, "untouched command lines keep identity");

  const noCommand = ["-NoProfile"];
  assert.equal(
    withUtf8OutputPrelude("powershell", noCommand),
    noCommand,
    "a PowerShell call with no -Command script has nothing to prepend to",
  );
});

test("pwsh gets the same treatment as powershell", () => {
  const out = withUtf8OutputPrelude("pwsh.exe", ["-NoProfile", "-Command", "echo hi"]);
  assert.equal(out[2], `${POWERSHELL_UTF8_PRELUDE}echo hi`);
});

test("line splitter: one record per line, however the pipe chunks them", () => {
  const out = [];
  const split = createLineSplitter((line) => out.push(line));
  // Two records in one chunk — the [multi]/[ru] readings logging in the
  // same millisecond used to land glued on a single main.log line.
  split.push("backend.x: [multi] params=#1\nbackend.x: [ru] params=#2\nbackend.x: half");
  assert.deepEqual(out, ["backend.x: [multi] params=#1", "backend.x: [ru] params=#2"]);
  // ...and a record split across chunks comes out whole, not as two halves.
  split.push(" of a record\r\n\n   \n  indented continuation\n");
  assert.deepEqual(out.slice(2), ["backend.x: half of a record", "  indented continuation"]);
  split.push("no trailing newline");
  assert.equal(out.length, 4, "an unterminated record waits for its newline");
  split.flush();
  assert.equal(out[4], "no trailing newline");
  split.flush();
  assert.equal(out.length, 5, "flush on an empty buffer emits nothing");
});

test("line splitter: an endless line is emitted at the cap, not buffered without bound", () => {
  const out = [];
  const split = createLineSplitter((line) => out.push(line), { maxLineChars: 10 });
  split.push("x".repeat(25));
  assert.deepEqual(out, ["x".repeat(25)]);
  split.push("tail\n");
  assert.deepEqual(out, ["x".repeat(25), "tail"]);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPrivateAppender } = require("./private-log");

const posix = process.platform !== "win32";
const modeOf = (p) => fs.statSync(p).mode & 0o777;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vt-private-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a log the appender creates is readable by its owner only", { skip: !posix }, (t) => {
  const file = path.join(tempDir(t), "main.log");
  const append = createPrivateAppender();
  append(file, "one\n");
  append(file, "two\n");
  assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n");
  assert.equal(modeOf(file), 0o600);
});

test("a log left world-readable by an older version is tightened on first append", { skip: !posix }, (t) => {
  const file = path.join(tempDir(t), "main.log");
  fs.writeFileSync(file, "old\n", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  createPrivateAppender()(file, "new\n");
  assert.equal(modeOf(file), 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), "old\nnew\n");
});

test("the file a rotation starts afresh is created private too", { skip: !posix }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "main.log");
  const append = createPrivateAppender();
  append(file, "before\n");
  fs.renameSync(file, path.join(dir, "main.log.1"));
  append(file, "after\n");
  assert.equal(modeOf(file), 0o600);
});

test("a filesystem that refuses chmod does not lose the line", () => {
  const writes = [];
  const fakeFs = {
    appendFileSync: (p, text, opts) => writes.push({ p, text, mode: opts.mode }),
    chmodSync: () => { throw new Error("EPERM"); },
  };
  const append = createPrivateAppender(fakeFs);
  append("/x/main.log", "line\n");
  assert.deepEqual(writes, [{ p: "/x/main.log", text: "line\n", mode: 0o600 }]);
});

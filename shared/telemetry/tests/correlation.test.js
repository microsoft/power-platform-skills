"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const corr = require("../lib/correlation");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-corr-"));
}

test("write then read returns the same correlation_id and start_ts", () => {
  const tmp = mkTmp();
  const written = corr.write({
    skillName: "create-site",
    tmpDir: tmp,
  });
  assert.equal(typeof written.correlation_id, "string");
  assert.ok(written.correlation_id.length >= 32);
  assert.equal(typeof written.start_ts, "number");

  const read = corr.read({ skillName: "create-site", tmpDir: tmp });
  assert.equal(read.correlation_id, written.correlation_id);
  assert.equal(read.start_ts, written.start_ts);
});

test("read returns null when file missing", () => {
  const tmp = mkTmp();
  const read = corr.read({ skillName: "does-not-exist", tmpDir: tmp });
  assert.equal(read, null);
});

test("read returns null when file malformed", () => {
  const tmp = mkTmp();
  fs.writeFileSync(
    path.join(tmp, "ppskills-corr-x.json"),
    "not json"
  );
  const read = corr.read({ skillName: "x", tmpDir: tmp });
  assert.equal(read, null);
});

test("clear removes the correlation file", () => {
  const tmp = mkTmp();
  corr.write({ skillName: "x", tmpDir: tmp });
  corr.clear({ skillName: "x", tmpDir: tmp });
  assert.equal(corr.read({ skillName: "x", tmpDir: tmp }), null);
});

test("clear on missing file does not throw", () => {
  const tmp = mkTmp();
  corr.clear({ skillName: "never-written", tmpDir: tmp });
});

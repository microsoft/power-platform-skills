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

test("write unlinks ppskills-corr-*.json files older than 1 hour before writing", () => {
  const tmp = mkTmp();
  const oldFile = path.join(tmp, "ppskills-corr-stale.json");
  fs.writeFileSync(oldFile, JSON.stringify({ correlation_id: "old", start_ts: 1 }));
  const twoHoursAgo = Date.now() / 1000 - 7200;
  fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

  corr.write({ skillName: "fresh", tmpDir: tmp });

  assert.equal(fs.existsSync(oldFile), false, "stale correlation file should be unlinked");
  assert.equal(
    fs.existsSync(path.join(tmp, "ppskills-corr-fresh.json")),
    true,
    "new correlation file should exist"
  );
});

test("write preserves ppskills-corr-*.json files newer than 1 hour", () => {
  const tmp = mkTmp();
  const recentFile = path.join(tmp, "ppskills-corr-recent.json");
  fs.writeFileSync(recentFile, JSON.stringify({ correlation_id: "recent", start_ts: 1 }));
  const tenMinAgo = Date.now() / 1000 - 600;
  fs.utimesSync(recentFile, tenMinAgo, tenMinAgo);

  corr.write({ skillName: "another", tmpDir: tmp });

  assert.equal(fs.existsSync(recentFile), true, "recent correlation file should survive");
});

test("write does not touch unrelated files in tmpDir", () => {
  const tmp = mkTmp();
  const unrelated = path.join(tmp, "unrelated.json");
  fs.writeFileSync(unrelated, "{}");
  const twoHoursAgo = Date.now() / 1000 - 7200;
  fs.utimesSync(unrelated, twoHoursAgo, twoHoursAgo);

  corr.write({ skillName: "x", tmpDir: tmp });

  assert.equal(fs.existsSync(unrelated), true, "non-prefixed files should survive sweep");
});

test("write swallows readdir failures when tmpDir does not exist", () => {
  const tmp = path.join(os.tmpdir(), "ppskills-nonexistent-" + Date.now());
  assert.doesNotThrow(() => corr.write({ skillName: "x", tmpDir: tmp }));
  // write also swallows writeFileSync failure per existing semantics; no file produced
  assert.equal(fs.existsSync(path.join(tmp, "ppskills-corr-x.json")), false);
});

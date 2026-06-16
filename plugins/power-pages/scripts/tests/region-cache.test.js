"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { read, write, TTL_MS } = require("../lib/telemetry/region/region-cache");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-rc-"));
}

// Path of an org's per-org cache file under a config dir.
function entryPath(tmp, orgId) {
  return path.join(tmp, "region-cache", `${orgId}.json`);
}

// Write a raw entry file directly (for malformed/expired fixtures).
function writeRaw(tmp, orgId, contents) {
  fs.mkdirSync(path.join(tmp, "region-cache"), { recursive: true });
  fs.writeFileSync(entryPath(tmp, orgId), contents);
}

const orgIdA = "11111111-1111-1111-1111-111111111111";
const orgIdB = "22222222-2222-2222-2222-222222222222";
const entryUS = { region: "us" };
const entryEU = { region: "eu" };

test("read returns null when file does not exist", () => {
  const tmp = mkTmp();
  assert.equal(read(orgIdA, tmp), null);
});

test("write then read returns the region for the same orgId", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  assert.equal(read(orgIdA, tmp).region, "us");
});

test("cache stores only the region (no iKey/collectorUrl)", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  const onDisk = JSON.parse(fs.readFileSync(entryPath(tmp, orgIdA), "utf8"));
  assert.deepEqual(Object.keys(onDisk).sort(), ["expiresAt", "region"]);
});

test("read returns null for an orgId that was never written", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  assert.equal(read(orgIdB, tmp), null);
});

test("multiple orgIds coexist as separate files", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  write(orgIdB, entryEU, tmp);
  assert.equal(read(orgIdA, tmp).region, "us");
  assert.equal(read(orgIdB, tmp).region, "eu");
  assert.ok(fs.existsSync(entryPath(tmp, orgIdA)));
  assert.ok(fs.existsSync(entryPath(tmp, orgIdB)));
});

test("read returns null when entry is expired", () => {
  const tmp = mkTmp();
  writeRaw(
    tmp,
    orgIdA,
    JSON.stringify({ region: "us", expiresAt: Date.now() - 1000 })
  );
  assert.equal(read(orgIdA, tmp), null);
});

test("read returns null when JSON is malformed", () => {
  const tmp = mkTmp();
  writeRaw(tmp, orgIdA, "not json {");
  assert.equal(read(orgIdA, tmp), null);
});

test("write swallows disk errors (target dir unwritable)", () => {
  const notADir = path.join(os.tmpdir(), "ppskills-not-a-dir-" + Date.now());
  fs.writeFileSync(notADir, "");
  assert.doesNotThrow(() => write(orgIdA, entryUS, notADir));
});

test("write is atomic: leaves no temp files and produces complete per-org files", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  write(orgIdB, entryEU, tmp);
  const leftover = fs
    .readdirSync(path.join(tmp, "region-cache"))
    .filter((f) => f.includes(".tmp."));
  assert.deepEqual(leftover, [], "atomic write must not leave .tmp files behind");
  assert.equal(
    JSON.parse(fs.readFileSync(entryPath(tmp, orgIdA), "utf8")).region,
    "us"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(entryPath(tmp, orgIdB), "utf8")).region,
    "eu"
  );
});

test("read returns null when orgId is falsy", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  assert.equal(read("", tmp), null);
  assert.equal(read(null, tmp), null);
  assert.equal(read(undefined, tmp), null);
});

test("non-GUID orgId is rejected (no read, no write, no path traversal)", () => {
  const tmp = mkTmp();
  // Write attempt with a traversal-style id must be a no-op.
  assert.doesNotThrow(() => write("../evil", entryUS, tmp));
  assert.equal(read("../evil", tmp), null);
  // Nothing should have been created outside the (uncreated) cache dir.
  assert.equal(fs.existsSync(path.join(tmp, "region-cache")), false);
});

test("write is a silent no-op when orgId or entry is falsy", () => {
  const tmp = mkTmp();
  assert.doesNotThrow(() => write("", entryUS, tmp));
  assert.doesNotThrow(() => write(orgIdA, null, tmp));
  assert.doesNotThrow(() => write(orgIdA, undefined, tmp));
  assert.doesNotThrow(() => write(orgIdA, {}, tmp)); // entry with no region
  // No cache dir/file should exist after no-op writes.
  assert.equal(fs.existsSync(path.join(tmp, "region-cache")), false);
});

test("TTL_MS is exported as 24 hours", () => {
  assert.equal(TTL_MS, 24 * 60 * 60 * 1000);
});

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

const orgIdA = "11111111-1111-1111-1111-111111111111";
const orgIdB = "22222222-2222-2222-2222-222222222222";
const entryUS = { region: "us", iKey: "ikey-us", collectorUrl: "https://us/" };
const entryEU = { region: "eu", iKey: "ikey-eu", collectorUrl: "https://eu/" };

test("read returns null when file does not exist", () => {
  const tmp = mkTmp();
  assert.equal(read(orgIdA, tmp), null);
});

test("write then read returns the entry for the same orgId", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  const got = read(orgIdA, tmp);
  assert.equal(got.region, "us");
  assert.equal(got.iKey, "ikey-us");
  assert.equal(got.collectorUrl, "https://us/");
});

test("read returns null for an orgId that was never written", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  assert.equal(read(orgIdB, tmp), null);
});

test("multiple orgIds coexist in the same cache file", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  write(orgIdB, entryEU, tmp);
  assert.equal(read(orgIdA, tmp).region, "us");
  assert.equal(read(orgIdB, tmp).region, "eu");
});

test("read returns null when entry is expired", () => {
  const tmp = mkTmp();
  const file = path.join(tmp, "region-cache.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      [orgIdA]: {
        ...entryUS,
        expiresAt: Date.now() - 1000, // already expired
      },
    })
  );
  assert.equal(read(orgIdA, tmp), null);
});

test("read returns null when JSON is malformed", () => {
  const tmp = mkTmp();
  fs.writeFileSync(path.join(tmp, "region-cache.json"), "not json {");
  assert.equal(read(orgIdA, tmp), null);
});

test("write swallows disk errors (target dir unwritable)", () => {
  const notADir = path.join(os.tmpdir(), "ppskills-not-a-dir-" + Date.now());
  fs.writeFileSync(notADir, "");
  assert.doesNotThrow(() => write(orgIdA, entryUS, notADir));
});

test("TTL_MS is exported as 24 hours", () => {
  assert.equal(TTL_MS, 24 * 60 * 60 * 1000);
});

test("read returns null when orgId is falsy", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  assert.equal(read("", tmp), null);
  assert.equal(read(null, tmp), null);
  assert.equal(read(undefined, tmp), null);
});

test("write is a silent no-op when orgId or entry is falsy", () => {
  const tmp = mkTmp();
  const file = path.join(tmp, "region-cache.json");
  assert.doesNotThrow(() => write("", entryUS, tmp));
  assert.doesNotThrow(() => write(orgIdA, null, tmp));
  assert.doesNotThrow(() => write(orgIdA, undefined, tmp));
  // Cache file should not exist after no-op writes
  assert.equal(fs.existsSync(file), false);
});

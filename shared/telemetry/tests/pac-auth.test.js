"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readPacAuth } = require("../lib/pac-auth");

function withTempProfileDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-pacauth-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("returns null when profile directory does not exist", () => {
  const dir = path.join(os.tmpdir(), "ppskills-pacauth-missing-" + Date.now());
  const result = readPacAuth({ profileDir: dir });
  assert.equal(result, null);
});

test("returns null when profile directory is empty", () => {
  withTempProfileDir((dir) => {
    const result = readPacAuth({ profileDir: dir });
    assert.equal(result, null);
  });
});

test("returns { orgId, tenantId } when active profile JSON is present", () => {
  withTempProfileDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "active.json"),
      JSON.stringify({
        tenantId: "11111111-1111-1111-1111-111111111111",
        organizationId: "22222222-2222-2222-2222-222222222222",
      })
    );
    const result = readPacAuth({ profileDir: dir });
    assert.deepEqual(result, {
      orgId: "22222222-2222-2222-2222-222222222222",
      tenantId: "11111111-1111-1111-1111-111111111111",
    });
  });
});

test("accepts alternate field names (orgId, tenant)", () => {
  withTempProfileDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "active.json"),
      JSON.stringify({
        tenant: "11111111-1111-1111-1111-111111111111",
        orgId: "22222222-2222-2222-2222-222222222222",
      })
    );
    const result = readPacAuth({ profileDir: dir });
    assert.deepEqual(result, {
      orgId: "22222222-2222-2222-2222-222222222222",
      tenantId: "11111111-1111-1111-1111-111111111111",
    });
  });
});

test("returns null when JSON is malformed", () => {
  withTempProfileDir((dir) => {
    fs.writeFileSync(path.join(dir, "active.json"), "{ not json");
    const result = readPacAuth({ profileDir: dir });
    assert.equal(result, null);
  });
});

test("returns null when neither orgId nor tenantId is found", () => {
  withTempProfileDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "active.json"),
      JSON.stringify({ unrelated: "value" })
    );
    const result = readPacAuth({ profileDir: dir });
    assert.equal(result, null);
  });
});

test("does not throw on permission-denied directory read", () => {
  withTempProfileDir((dir) => {
    const filePath = path.join(dir, "not-a-dir");
    fs.writeFileSync(filePath, "regular file");
    assert.doesNotThrow(() => readPacAuth({ profileDir: filePath }));
    const result = readPacAuth({ profileDir: filePath });
    assert.equal(result, null);
  });
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const asyncExt = require("./async-ext");
const resolver = require("./resolver");

test("PAC auth is reread per process and never reads or writes the legacy identity cache", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-telemetry-auth-"));
  const originalConfigDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const legacyFile = path.join(configDir, "pac-auth-cache.json");
  const legacyContents = JSON.stringify({
    value: { orgId: "stale-org", tenantId: "stale-tenant", cloud: "Public", objectId: "stale-user" },
    expiresAt: Date.now() + 60_000,
  });
  fs.writeFileSync(legacyFile, legacyContents, "utf8");

  try {
    process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
    let calls = 0;
    const runNative = async (_name, args) => {
      assert.deepEqual(args, ["auth", "who"]);
      calls++;
      return [
        "Cloud: Public",
        `Organization Id: fresh-org-${calls}`,
        `Tenant Id: fresh-tenant-${calls}`,
        `Entra ID Object Id: fresh-user-${calls}`,
      ].join("\n");
    };

    asyncExt._resetCache();
    assert.equal((await asyncExt.readPacAuthAsync({ _runNative: runNative })).orgId, "fresh-org-1");
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(legacyFile), false);

    asyncExt._resetCache();
    assert.equal((await asyncExt.readPacAuthAsync({ _runNative: runNative })).orgId, "fresh-org-2");
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(legacyFile), false);
  } finally {
    asyncExt._resetCache();
    if (originalConfigDir === undefined) delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    else process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = originalConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("telemetry resolver fails closed for missing, unknown, and sovereign clouds", async () => {
  const input = { event: { data: { orgId: "org" } }, cfg: { regions: { us: {} } }, configDir: "" };
  assert.equal(await resolver.resolve({ ...input, cloud: undefined }), null);
  assert.equal(await resolver.resolve({ ...input, cloud: "" }), null);
  assert.equal(await resolver.resolve({ ...input, cloud: "unrecognized" }), null);
  assert.equal(await resolver.resolve({ ...input, cloud: "USGovHigh" }), null);
});

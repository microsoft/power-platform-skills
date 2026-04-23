"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function mkTargetPlugin() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-sync-"));
  fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "references"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "test-plugin", version: "0.0.1" })
  );
  return tmp;
}

const syncScript = path.resolve(__dirname, "../sync-to-plugin.js");

test("sync copies lib/ and ikey.json into <plugin>/scripts/lib/telemetry/", () => {
  const target = mkTargetPlugin();
  const { status, stderr } = spawnSync(
    process.execPath,
    [syncScript, "--target", target],
    { encoding: "utf8" }
  );
  assert.equal(status, 0, stderr);
  const synced = path.join(target, "scripts", "lib", "telemetry");
  assert.ok(fs.existsSync(path.join(synced, "ikey.json")));
  assert.ok(fs.existsSync(path.join(synced, "lib", "emit-dispatcher.js")));
  assert.ok(fs.existsSync(path.join(synced, "lib", "emit-spawn.js")));
  assert.ok(fs.existsSync(path.join(synced, "lib", "check-consent.js")));
  assert.ok(fs.existsSync(path.join(synced, "lib", "prompt-detector.js")));
  assert.ok(fs.existsSync(path.join(synced, "lib", "emit-from-prompt.js")));
  assert.ok(!fs.existsSync(path.join(synced, "package.json")), "no package.json should be synced");
});

test("sync copies references/telemetry-consent-reference.md into <plugin>/references/", () => {
  // Prepare a fake ref doc in shared/telemetry/references/
  const refPath = path.resolve(
    __dirname,
    "../references/telemetry-consent-reference.md"
  );
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  if (!fs.existsSync(refPath)) fs.writeFileSync(refPath, "# ref");

  const target = mkTargetPlugin();
  const { status } = spawnSync(
    process.execPath,
    [syncScript, "--target", target],
    { encoding: "utf8" }
  );
  assert.equal(status, 0);
  assert.ok(
    fs.existsSync(
      path.join(target, "references", "telemetry-consent-reference.md")
    )
  );
});

test("sync is idempotent", () => {
  const target = mkTargetPlugin();
  spawnSync(process.execPath, [syncScript, "--target", target]);
  spawnSync(process.execPath, [syncScript, "--target", target]);
  const p = path.join(target, "scripts", "lib", "telemetry", "lib", "emit-dispatcher.js");
  assert.ok(fs.existsSync(p));
});

test("sync exits non-zero on missing --target", () => {
  const { status } = spawnSync(process.execPath, [syncScript], { encoding: "utf8" });
  assert.notEqual(status, 0);
});

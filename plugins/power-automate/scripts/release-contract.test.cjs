"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const root = path.resolve(__dirname, "..");

test("debug workflows allow bounded action content and describe the public repetition contract", () => {
  for (const name of ["debug-flow", "diagnose-flow"]) {
    const skill = fs.readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8");
    const allowed = skill.match(/^allowed-tools:\s*(.+)$/m)?.[1].split(/,\s*/);
    assert.ok(allowed?.includes("mcp__flowagent__get_run_action_content"));
    assert.ok(skill.includes('which: "inputs"'));
    assert.ok(skill.includes("{ action, count, truncated, repetitions }"));
  }
});

test("the telemetry guide is portable in a plugin-only installation", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.ok(readme.includes("(references/telemetry.md)"));
  const guide = fs.readFileSync(path.join(root, "references", "telemetry.md"), "utf8");
  assert.ok(guide.includes("eventInfo.aadObjectId"));
  assert.ok(guide.includes("no automatic retention policy"));
  assert.ok(guide.includes("POWER_PLATFORM_SKILLS_TELEMETRY_POWER_AUTOMATE_OPTOUT"));
  assert.ok(fs.existsSync(path.join(root, "skills", "telemetry", "SKILL.md")));
});

test("the shipped detached dispatcher aborts stalled fetches without making a network request", () => {
  const dispatcher = pathToFileURL(path.join(root, "server", "emit-dispatcher.mjs")).href;
  const script = `
    const assert = require("node:assert/strict");
    const timer = global.setTimeout;
    let fetched = false;
    let aborted = false;
    global.setTimeout = (fn, ms) => {
      assert.equal(ms, 5000);
      return timer(fn, 0);
    };
    global.fetch = (_url, options) => {
      fetched = true;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("test abort"));
        }, { once: true });
      });
    };
    process.on("beforeExit", () => {
      assert.equal(fetched, true);
      assert.equal(aborted, true);
    });
    import(${JSON.stringify(dispatcher)});
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      FLOWAGENT_TELEMETRY_PAYLOAD: Buffer.from(JSON.stringify({
        eventName: "tool_completed", toolName: "get_flow",
      })).toString("base64"),
      FLOWAGENT_TELEMETRY_IKEY: "test-key",
      FLOWAGENT_TELEMETRY_COLLECTOR: "https://collector.invalid/OneCollector/1.0/",
    },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

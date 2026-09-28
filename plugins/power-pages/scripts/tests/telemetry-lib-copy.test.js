"use strict";

// Guards the plugin's BUNDLED copy of the shared telemetry library.
//
// `plugins/power-pages/scripts/lib/telemetry/lib` is a physical copy of
// `shared/telemetry/lib` (not a symlink — some Windows checkouts and plugin
// hosts materialize symlinks as plain link files, which breaks hook-time
// require()). Nothing else in CI compares the two: `shared/telemetry/tests` has
// no workflow, and validate-legacy-compatibility.js only mirrors the marketplace
// manifests. So an author who edits the shared source and forgets to refresh the
// copy gets a green build while the plugin ships stale code.
//
// This suite runs in power-pages-script-tests.yml, so it turns that silent drift
// into a CI failure — and additionally exercises the copy's behavior directly,
// since the shared suite that normally covers it never runs in CI.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const PLUGIN_LIB = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry", "lib");
// Repo root is three levels above the plugin (plugins/power-pages -> plugins -> repo).
const SHARED_LIB = path.resolve(PLUGIN_ROOT, "..", "..", "shared", "telemetry", "lib");

test("bundled telemetry lib is byte-identical to shared/telemetry/lib", (t) => {
  // A marketplace install copies only the plugin directory, so `shared/` is
  // absent there. Skip rather than fail — the check is meaningful only in a
  // full repo checkout, which is what CI runs.
  if (!fs.existsSync(SHARED_LIB)) {
    t.skip("shared/telemetry/lib not present (installed plugin, not a repo checkout)");
    return;
  }

  const sharedFiles = fs.readdirSync(SHARED_LIB).filter((f) => f.endsWith(".js")).sort();
  const pluginFiles = fs.readdirSync(PLUGIN_LIB).filter((f) => f.endsWith(".js")).sort();
  assert.deepEqual(
    pluginFiles,
    sharedFiles,
    "plugin copy and shared source must contain the same modules — refresh the copy"
  );

  const drifted = sharedFiles.filter(
    (f) =>
      fs.readFileSync(path.join(SHARED_LIB, f), "utf8") !==
      fs.readFileSync(path.join(PLUGIN_LIB, f), "utf8")
  );
  assert.deepEqual(
    drifted,
    [],
    "bundled copy has drifted from shared/telemetry/lib — re-copy these files"
  );
});

test("bundled telemetry CLI discloses the Power Pages framework field", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-disclosure-"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(PLUGIN_LIB, "telemetry-config.js"),
      "--action",
      "status",
      "--plugin",
      "power-pages",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
      },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /eventInfo\.framework/);
  assert.match(result.stdout, /react, vue, angular, or astro/);
  assert.match(result.stdout, /never a site name or path/);
});

// --- Behavior of the bundled copy -------------------------------------------
// The hook tests cover the happy path end-to-end; these pin the defensive
// branches of the caller-supplied `eventInfo` seam, which otherwise live only in
// the never-run shared suite.

const { emitSkillStartedFromPrompt } = require(path.join(PLUGIN_LIB, "emit-from-prompt"));

// Minimal provisioned telemetry dir: ikey.json plus the resolver.js sibling the
// generic isProvisioned gate discovers by convention.
function mkTelemetryDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-copy-"));
  fs.writeFileSync(
    path.join(tmp, "ikey.json"),
    JSON.stringify({
      event_stream_name: "PagesAIPluginEvent",
      disabled: false,
      default_region: "us",
      regions: {
        us: {
          instrumentation_key: "test-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
          collector_url: "https://example.invalid/OneCollector/1.0/",
        },
      },
    })
  );
  fs.writeFileSync(
    path.join(tmp, "resolver.js"),
    "module.exports = {" +
      "async resolve() { return null; }," +
      "isProvisioned(cfg) {" +
      "  const e = cfg && cfg.regions && cfg.regions[(cfg && cfg.default_region) || 'us'];" +
      "  return !!(e && e.instrumentation_key);" +
      "} };"
  );
  return tmp;
}

function emit({ eventInfo, objectId }) {
  const captured = {};
  const result = emitSkillStartedFromPrompt("/power-pages:add-seo", {
    pluginName: "power-pages",
    pluginVersion: "1.2.3",
    trackedSkills: { "add-seo": {} },
    telemetryDir: mkTelemetryDir(),
    eventInfo,
    _emit: (event) => {
      captured.event = event;
    },
    _readPacAuth: () => (objectId ? { objectId } : null),
    _readAgentInfo: () => ({}),
  });
  return { result, data: captured.event && captured.event.data };
}

test("bundled copy keeps caller eventInfo when no Entra objectId is present", () => {
  // Regression guard: building eventInfo inside the objectId guard would drop
  // `framework` on every unauthenticated run.
  const { data } = emit({ eventInfo: { framework: "react" } });
  assert.deepEqual(data.eventInfo, { framework: "react" });
});

test("bundled copy merges caller eventInfo with aadObjectId", () => {
  const { data } = emit({
    eventInfo: { framework: "vue" },
    objectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });
  assert.deepEqual(data.eventInfo, {
    framework: "vue",
    aadObjectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });
});

test("bundled copy drops a throwing eventInfo thunk without losing the event", () => {
  const { result, data } = emit({
    eventInfo: () => {
      throw new Error("boom");
    },
    objectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });
  assert.equal(result.emitted, true);
  assert.deepEqual(data.eventInfo, { aadObjectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
});

test("bundled copy ignores non-object eventInfo values", () => {
  for (const bad of ["react", 42, true, ["react"]]) {
    const { data } = emit({ eventInfo: bad });
    assert.equal(
      data.eventInfo,
      undefined,
      `non-object eventInfo (${JSON.stringify(bad)}) must be dropped`
    );
  }
});

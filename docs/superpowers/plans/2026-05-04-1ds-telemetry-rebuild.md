# 1DS Telemetry Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current `VscodeEvent`/stringified-`eventInfo` shape with a per-plugin envelope (`PowerPagesPluginEvent`) carrying first-class top-level Kusto columns; add best-effort PAC auth enrichment (`OrgId`, `TenantId`); make envelope name plugin-specific config carried in `ikey.json`.

**Architecture:** Shared library at `shared/telemetry/` stays plugin-agnostic; each plugin owns its `event_stream_name` in its synced `ikey.json`. Builders take envelope name as their first argument. Hooks read `event_stream_name` and `pac-auth` profile, populate top-level fields, and call the simplified builder. The dispatcher's envelope-shape code is already correct (just `{ver, name, time, iKey, data}` with trailing newline) — no change there. Re-sync to plugin propagates everything.

**Tech Stack:** Node 22 built-ins only (`node:fs`, `node:path`, `node:os`, `node:crypto`, `node:test`). Zero npm dependencies. Test runner: `node --test <file>`.

**Spec:** `docs/superpowers/specs/2026-05-04-1ds-telemetry-rebuild-design.md`

**Branch:** `users/amitjosh/1ds-infra`

**Test runner pattern:** every test file is run with `node --test <path>`. Multiple files: `node --test shared/telemetry/tests/*.test.js`.

---

## File Structure

**Modified files (canonical, under `shared/telemetry/`):**
- `shared/telemetry/ikey.json` — adds `event_stream_name` field (placeholder).
- `shared/telemetry/lib/events.js` — full rewrite: builders take `envelopeName` first arg, return `{name: envelopeName, data: {eventName, eventType, severity, ...top-level allowlisted fields}}`.
- `shared/telemetry/lib/with-telemetry.js` — accepts `envelopeName` in opts; passes it to builders.
- `shared/telemetry/lib/emit-from-prompt.js` — reads `event_stream_name` from `ikey.json`, reads PAC auth, populates new common fields.
- All test files in `shared/telemetry/tests/` get assertion updates for the new shape.

**New files (canonical, under `shared/telemetry/`):**
- `shared/telemetry/lib/pac-auth.js` — pure-ish helper that reads PAC profile file and returns `{orgId, tenantId} | null`.
- `shared/telemetry/tests/pac-auth.test.js` — unit tests with fixtures.

**Modified files (under `plugins/power-pages/`):**
- `plugins/power-pages/hooks/run-skill-pretool-telemetry.js` — reads `event_stream_name` + PAC auth; populates `osName`/`osVersion`/`nodeVersion` (camelCase); passes envelope name to builder.
- `plugins/power-pages/hooks/run-skill-posttool-validation.js` — same updates plus severity-mapping for failure outcome.
- `plugins/power-pages/hooks/run-user-prompt-telemetry.js` — orchestrator already does the right shape after Milestone 1 changes; only the integration test needs assertion updates.
- `plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js` — assertion updates for the new wire shape (top-level fields, envelope name from `ikey.json`).

**Modified via sync (do NOT hand-edit):**
- `plugins/power-pages/scripts/lib/telemetry/lib/*` — synced from `shared/telemetry/lib/*`.
- `plugins/power-pages/scripts/lib/telemetry/ikey.json` — synced; can also be hand-edited for the per-plugin envelope name (since each plugin sets its own).

**New files (handoff artifact):**
- `docs/superpowers/handoff/PowerPagesPluginEvent-annotation.xml` — copy-paste-ready annotation for the tenant team.

---

## Milestone 1 — Shared Library

### Task 1: Add `event_stream_name` to `ikey.json`

**Files:**
- Modify: `shared/telemetry/ikey.json`

- [ ] **Step 1: Update `shared/telemetry/ikey.json`**

Replace the file content with:

```json
{
  "ikey": "ffdb4c99ca3a4ad5b8e9ffb08bf7da0d-65357ff3-efcd-47fc-b2fd-ad95a52373f4-7402",
  "collector_url": "https://self.pipe.aria.int.microsoft.com/OneCollector/1.0/",
  "event_stream_name": "PluginEventStreamPlaceholder"
}
```

The placeholder for `event_stream_name` is intentional — this dev-time `ikey.json` is not what users run; the synced plugin copy carries the real per-plugin value.

- [ ] **Step 2: Run the sync test to confirm nothing broke**

Run: `node --test shared/telemetry/tests/sync-to-plugin.test.js`
Expected: all tests pass (the sync script copies `ikey.json` byte-for-byte; adding a field doesn't change the test).

- [ ] **Step 3: Commit**

```bash
git add shared/telemetry/ikey.json
git commit -m "feat(telemetry): add event_stream_name field to ikey.json"
```

---

### Task 2: Add `pac-auth.js` and tests

**Files:**
- Create: `shared/telemetry/lib/pac-auth.js`
- Create: `shared/telemetry/tests/pac-auth.test.js`

- [ ] **Step 1: Write the failing tests**

Create `shared/telemetry/tests/pac-auth.test.js`:

```js
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
  // Pass a path that is a file instead of a directory (causes ENOTDIR).
  withTempProfileDir((dir) => {
    const filePath = path.join(dir, "not-a-dir");
    fs.writeFileSync(filePath, "regular file");
    assert.doesNotThrow(() => readPacAuth({ profileDir: filePath }));
    const result = readPacAuth({ profileDir: filePath });
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test shared/telemetry/tests/pac-auth.test.js`
Expected: FAIL with `Cannot find module '../lib/pac-auth'`.

- [ ] **Step 3: Implement `pac-auth.js`**

Create `shared/telemetry/lib/pac-auth.js`:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Field-name candidates per concept. PAC profile JSON shape isn't strictly
// versioned; accept the common variants and pick the first match.
const TENANT_KEYS = ["tenantId", "tenantID", "tenant"];
const ORG_KEYS = ["organizationId", "orgId", "OrgId", "organizationID"];

function defaultProfileDirs() {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), "AppData", "Local");
    return [path.join(localAppData, "Microsoft", "PowerAppsCLI", "auth")];
  }
  // Linux / macOS
  return [
    path.join(os.homedir(), ".local", "share", "Microsoft", "PowerAppsCLI", "auth"),
    path.join(os.homedir(), ".config", "Microsoft", "PowerAppsCLI", "auth"),
  ];
}

function pickKey(obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] === "string" && obj[k]) return obj[k];
  }
  return null;
}

function readProfile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listProfileFiles(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

function readPacAuth(opts = {}) {
  const dirs = opts.profileDir ? [opts.profileDir] : defaultProfileDirs();
  for (const dir of dirs) {
    const files = listProfileFiles(dir);
    for (const file of files) {
      const parsed = readProfile(file);
      if (!parsed || typeof parsed !== "object") continue;
      const tenantId = pickKey(parsed, TENANT_KEYS);
      const orgId = pickKey(parsed, ORG_KEYS);
      if (tenantId || orgId) {
        return {
          orgId: orgId || "",
          tenantId: tenantId || "",
        };
      }
    }
  }
  return null;
}

module.exports = { readPacAuth };
```

Note on PAC field names: the implementation accepts both `tenantId`/`tenant` and `organizationId`/`orgId` because PAC profile shape isn't strictly versioned. After implementation, run `pac auth create` against a test environment, inspect the actual JSON structure, and adjust the key candidates list if the real format differs. The current candidate set is permissive and covers what historical PAC versions have used.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test shared/telemetry/tests/pac-auth.test.js`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/pac-auth.js shared/telemetry/tests/pac-auth.test.js
git commit -m "feat(telemetry): add pac-auth helper for OrgId/TenantId enrichment"
```

---

### Task 3: Rewrite `events.js`

**Files:**
- Modify: `shared/telemetry/lib/events.js` (full rewrite)
- Modify: `shared/telemetry/tests/events.test.js` (full rewrite)

- [ ] **Step 1: Write the failing tests**

Replace `shared/telemetry/tests/events.test.js` with:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSkillStarted,
  buildSkillCompleted,
  buildScriptStarted,
  buildScriptCompleted,
} = require("../lib/events");

const ENVELOPE = "PowerPagesPluginEvent";

const common = {
  pluginName: "power-pages",
  pluginVersion: "1.2.2",
  sessionId: "sess-uuid",
  correlationId: "corr-1",
  osName: "Windows",
  osVersion: "10.0.26200",
  nodeVersion: "v22",
};

test("buildSkillStarted returns top-level fields with envelope name", () => {
  const ev = buildSkillStarted(ENVELOPE, { ...common, skillName: "add-seo" });
  assert.equal(ev.name, ENVELOPE);
  assert.equal(ev.data.eventName, "skill_started");
  assert.equal(ev.data.eventType, "Trace");
  assert.equal(ev.data.severity, "Info");
  assert.equal(ev.data.pluginName, "power-pages");
  assert.equal(ev.data.skillName, "add-seo");
  assert.equal(ev.data.osName, "Windows");
  assert.equal(ev.data.osVersion, "10.0.26200");
  assert.equal(ev.data.nodeVersion, "v22");
});

test("buildSkillCompleted with success outcome → severity Info", () => {
  const ev = buildSkillCompleted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    outcome: "success",
    durationMs: 1234,
    errorClass: "",
  });
  assert.equal(ev.data.eventName, "skill_completed");
  assert.equal(ev.data.severity, "Info");
  assert.equal(ev.data.outcome, "success");
  assert.equal(ev.data.durationMs, 1234);
  assert.equal(ev.data.errorClass, "");
});

test("buildSkillCompleted with failure outcome → severity Error", () => {
  const ev = buildSkillCompleted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    outcome: "failure",
    durationMs: 50,
    errorClass: "TypeError",
  });
  assert.equal(ev.data.severity, "Error");
  assert.equal(ev.data.outcome, "failure");
  assert.equal(ev.data.errorClass, "TypeError");
});

test("buildSkillStarted drops fields not in allowlist", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    tenantId: "11111111-1111-1111-1111-111111111111",
    orgId: "22222222-2222-2222-2222-222222222222",
    leaked_field: "SHOULD_NOT_APPEAR",
    file_path: "/etc/passwd",
    error_message: "secret",
  });
  // Allowed: tenantId, orgId
  assert.equal(ev.data.tenantId, "11111111-1111-1111-1111-111111111111");
  assert.equal(ev.data.orgId, "22222222-2222-2222-2222-222222222222");
  // Dropped: anything else
  assert.equal(ev.data.leaked_field, undefined);
  assert.equal(ev.data.file_path, undefined);
  assert.equal(ev.data.error_message, undefined);
});

test("buildScriptStarted top-level shape", () => {
  const ev = buildScriptStarted(ENVELOPE, {
    ...common,
    scriptName: "deploy-site",
  });
  assert.equal(ev.name, ENVELOPE);
  assert.equal(ev.data.eventName, "script_started");
  assert.equal(ev.data.scriptName, "deploy-site");
});

test("buildScriptCompleted clamps negative durationMs to 0", () => {
  const ev = buildScriptCompleted(ENVELOPE, {
    ...common,
    scriptName: "deploy-site",
    outcome: "failure",
    durationMs: -5,
    errorClass: "Error",
  });
  assert.equal(ev.data.durationMs, 0);
  assert.equal(ev.data.severity, "Error");
});

test("buildScriptCompleted clamps non-finite durationMs to 0", () => {
  const ev = buildScriptCompleted(ENVELOPE, {
    ...common,
    scriptName: "deploy-site",
    outcome: "success",
    durationMs: Number.NaN,
    errorClass: "",
  });
  assert.equal(ev.data.durationMs, 0);
});

test("orgId/tenantId omitted when input is missing", () => {
  const ev = buildSkillStarted(ENVELOPE, { ...common, skillName: "add-seo" });
  assert.equal(ev.data.orgId, undefined);
  assert.equal(ev.data.tenantId, undefined);
});

test("severity is Info for *_started events even when outcome=failure is supplied (started has no outcome)", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    outcome: "failure", // started events ignore outcome
  });
  assert.equal(ev.data.severity, "Info");
  assert.equal(ev.data.outcome, undefined);
});

test("envelope name flows through unchanged", () => {
  const ev = buildSkillStarted("CustomPluginEvent", {
    ...common,
    skillName: "x",
  });
  assert.equal(ev.name, "CustomPluginEvent");
});

test("data has stable key set across calls (no key drift)", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "x",
    orgId: "o",
    tenantId: "t",
  });
  const expectedKeys = [
    "correlationId", "eventName", "eventType",
    "nodeVersion", "orgId", "osName", "osVersion",
    "pluginName", "pluginVersion", "sessionId", "severity",
    "skillName", "tenantId",
  ];
  assert.deepEqual(Object.keys(ev.data).sort(), expectedKeys);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test shared/telemetry/tests/events.test.js`
Expected: most tests FAIL because the current `events.js` builders don't take envelope name as the first argument and use `eventInfo` stringification.

- [ ] **Step 3: Rewrite `events.js`**

Replace `shared/telemetry/lib/events.js` with:

```js
"use strict";

const COMMON_FIELDS = [
  "pluginName",
  "pluginVersion",
  "sessionId",
  "correlationId",
  "osName",
  "osVersion",
  "nodeVersion",
  "orgId",
  "tenantId",
];

const SKILL_FIELDS = ["skillName"];
const SCRIPT_FIELDS = ["scriptName"];
const COMPLETED_FIELDS = ["outcome", "durationMs", "errorClass"];

function pick(input, keys) {
  const out = {};
  if (!input) return out;
  for (const k of keys) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  return out;
}

function clampDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function buildEvent(envelopeName, eventName, info, severity) {
  if (info.durationMs !== undefined) {
    info.durationMs = clampDuration(info.durationMs);
  }
  return {
    name: envelopeName,
    data: { eventName, eventType: "Trace", severity, ...info },
  };
}

function buildSkillStarted(envelopeName, input) {
  return buildEvent(
    envelopeName,
    "skill_started",
    pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS]),
    "Info"
  );
}

function buildSkillCompleted(envelopeName, input) {
  const severity = input && input.outcome === "failure" ? "Error" : "Info";
  return buildEvent(
    envelopeName,
    "skill_completed",
    pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS, ...COMPLETED_FIELDS]),
    severity
  );
}

function buildScriptStarted(envelopeName, input) {
  return buildEvent(
    envelopeName,
    "script_started",
    pick(input, [...COMMON_FIELDS, ...SCRIPT_FIELDS]),
    "Info"
  );
}

function buildScriptCompleted(envelopeName, input) {
  const severity = input && input.outcome === "failure" ? "Error" : "Info";
  return buildEvent(
    envelopeName,
    "script_completed",
    pick(input, [...COMMON_FIELDS, ...SCRIPT_FIELDS, ...COMPLETED_FIELDS]),
    severity
  );
}

module.exports = {
  buildSkillStarted,
  buildSkillCompleted,
  buildScriptStarted,
  buildScriptCompleted,
};
```

The `COLLECTOR_EVENT_NAME` export is intentionally removed — envelope name is now per-call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test shared/telemetry/tests/events.test.js`
Expected: all 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/events.js shared/telemetry/tests/events.test.js
git commit -m "feat(telemetry): rewrite events.js with envelope-name parameter and top-level fields"
```

---

## Milestone 2 — Library Consumers

### Task 4: Update `with-telemetry.js`

**Files:**
- Modify: `shared/telemetry/lib/with-telemetry.js`
- Modify: `shared/telemetry/tests/with-telemetry.test.js`

- [ ] **Step 1: Update `with-telemetry.test.js`**

Replace `shared/telemetry/tests/with-telemetry.test.js` with:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { withTelemetry } = require("../lib/with-telemetry");

const ENVELOPE = "PowerPagesPluginEvent";

function recorder() {
  const events = [];
  return {
    events,
    emit: (e) => events.push(e),
  };
}

test("success path emits started + completed with envelope name", async () => {
  const rec = recorder();
  const result = await withTelemetry(
    "deploy-site",
    async () => 42,
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.equal(result, 42);
  assert.equal(rec.events.length, 2);
  assert.equal(rec.events[0].name, ENVELOPE);
  assert.equal(rec.events[0].data.eventName, "script_started");
  assert.equal(rec.events[0].data.scriptName, "deploy-site");
  assert.equal(rec.events[1].name, ENVELOPE);
  assert.equal(rec.events[1].data.eventName, "script_completed");
  assert.equal(rec.events[1].data.outcome, "success");
  assert.equal(rec.events[1].data.errorClass, "");
});

test("failure path emits completed with outcome=failure and severity=Error", async () => {
  const rec = recorder();
  await assert.rejects(
    withTelemetry(
      "deploy-site",
      async () => {
        throw new TypeError("boom");
      },
      {
        emitter: rec.emit,
        envelopeName: ENVELOPE,
        pluginName: "power-pages",
        pluginVersion: "1.2.2",
      }
    ),
    TypeError
  );
  assert.equal(rec.events.length, 2);
  assert.equal(rec.events[1].data.outcome, "failure");
  assert.equal(rec.events[1].data.errorClass, "TypeError");
  assert.equal(rec.events[1].data.severity, "Error");
});

test("started and completed share the same correlationId", async () => {
  const rec = recorder();
  await withTelemetry(
    "deploy-site",
    async () => null,
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.equal(rec.events[0].data.correlationId, rec.events[1].data.correlationId);
  assert.ok(rec.events[0].data.correlationId.length >= 32);
});

test("emit is called synchronously before asyncFn starts", async () => {
  const rec = recorder();
  let asyncFnSeenEventsAtStart = -1;
  await withTelemetry(
    "deploy-site",
    async () => {
      asyncFnSeenEventsAtStart = rec.events.length;
      return null;
    },
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.equal(asyncFnSeenEventsAtStart, 1);
});

test("throwing emitter does not break the wrapper", async () => {
  const result = await withTelemetry(
    "deploy-site",
    async () => 99,
    {
      emitter: () => {
        throw new Error("emit blew up");
      },
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.equal(result, 99);
});

test("durationMs is non-negative integer on success", async () => {
  const rec = recorder();
  await withTelemetry(
    "deploy-site",
    async () => null,
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.ok(Number.isInteger(rec.events[1].data.durationMs));
  assert.ok(rec.events[1].data.durationMs >= 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test shared/telemetry/tests/with-telemetry.test.js`
Expected: tests FAIL because `with-telemetry.js` doesn't yet accept `envelopeName` and uses snake_case fields.

- [ ] **Step 3: Rewrite `with-telemetry.js`**

Replace `shared/telemetry/lib/with-telemetry.js` with:

```js
"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const { getSessionId } = require("./session");
const { buildScriptStarted, buildScriptCompleted } = require("./events");
const { fireAndForget } = require("./emit-spawn");

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function commonFields({ pluginName, pluginVersion }) {
  return {
    pluginName,
    pluginVersion,
    sessionId: getSessionId(),
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: "v" + String(process.versions.node).split(".")[0],
  };
}

function defaultEmitter(event, spawnOpts) {
  fireAndForget(event, spawnOpts);
}

async function withTelemetry(scriptName, asyncFn, opts = {}) {
  const envelopeName = opts.envelopeName || "";
  const pluginName = opts.pluginName;
  const pluginVersion = opts.pluginVersion;
  const emitter = opts.emitter || defaultEmitter;
  const spawnOpts = opts.spawnOpts || {};
  const correlationId = crypto.randomUUID();
  const startTs = Date.now();

  try {
    emitter(
      buildScriptStarted(envelopeName, {
        ...commonFields({ pluginName, pluginVersion }),
        scriptName,
        correlationId,
      }),
      spawnOpts
    );
  } catch {
    // fail closed
  }

  let outcome = "success";
  let errorClass = "";
  let caught;
  try {
    return await asyncFn();
  } catch (err) {
    outcome = "failure";
    errorClass = err && err.constructor ? err.constructor.name : "Error";
    caught = err;
  } finally {
    const durationMs = Date.now() - startTs;
    try {
      emitter(
        buildScriptCompleted(envelopeName, {
          ...commonFields({ pluginName, pluginVersion }),
          scriptName,
          correlationId,
          outcome,
          durationMs,
          errorClass,
        }),
        spawnOpts
      );
    } catch {
      // fail closed
    }
    if (caught) throw caught;
  }
}

module.exports = { withTelemetry };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test shared/telemetry/tests/with-telemetry.test.js`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/with-telemetry.js shared/telemetry/tests/with-telemetry.test.js
git commit -m "feat(telemetry): with-telemetry takes envelopeName + populates camelCase common fields"
```

---

### Task 5: Update `emit-from-prompt.js`

**Files:**
- Modify: `shared/telemetry/lib/emit-from-prompt.js`
- Modify: `shared/telemetry/tests/emit-from-prompt.test.js`

- [ ] **Step 1: Update `emit-from-prompt.test.js`**

Replace `shared/telemetry/tests/emit-from-prompt.test.js` with:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { emitSkillStartedFromPrompt } = require("../lib/emit-from-prompt");

function mkTelemetryDir({ ikey, collectorUrl, eventStreamName }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-"));
  fs.writeFileSync(
    path.join(tmp, "ikey.json"),
    JSON.stringify({
      ikey,
      collector_url: collectorUrl,
      event_stream_name: eventStreamName,
    })
  );
  return tmp;
}

const TRACKED = { "add-seo": {}, "create-site": {} };

function callWithStub({ promptText, telemetryDir, captured, pacAuth }) {
  return emitSkillStartedFromPrompt(promptText, {
    pluginName: "power-pages",
    pluginVersion: "1.2.3",
    trackedSkills: TRACKED,
    telemetryDir,
    _emit: (event, spawnOpts) => {
      captured.event = event;
      captured.spawnOpts = spawnOpts;
    },
    _readPacAuth: pacAuth === undefined ? () => null : () => pacAuth,
  });
}

test("returns { emitted: false } when detection returns null", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  const result = callWithStub({
    promptText: "not a slash command",
    telemetryDir,
    captured,
  });
  assert.deepEqual(result, { emitted: false, skillName: null });
  assert.equal(captured.event, undefined);
});

test("emits skill_started with envelope name from ikey.json", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  const result = callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
  });
  assert.equal(result.emitted, true);
  assert.equal(result.skillName, "add-seo");
  assert.equal(captured.event.name, "PowerPagesPluginEvent");
  assert.equal(captured.event.data.eventName, "skill_started");
  assert.equal(captured.event.data.eventType, "Trace");
  assert.equal(captured.event.data.severity, "Info");
  assert.equal(captured.event.data.pluginName, "power-pages");
  assert.equal(captured.event.data.pluginVersion, "1.2.3");
  assert.equal(captured.event.data.skillName, "add-seo");
  assert.equal(typeof captured.event.data.sessionId, "string");
  assert.equal(typeof captured.event.data.correlationId, "string");
  assert.equal(typeof captured.event.data.osName, "string");
  assert.equal(typeof captured.event.data.osVersion, "string");
  assert.match(captured.event.data.nodeVersion, /^v\d+$/);
});

test("populates orgId/tenantId when PAC auth is present", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
    pacAuth: {
      orgId: "22222222-2222-2222-2222-222222222222",
      tenantId: "11111111-1111-1111-1111-111111111111",
    },
  });
  assert.equal(captured.event.data.orgId, "22222222-2222-2222-2222-222222222222");
  assert.equal(captured.event.data.tenantId, "11111111-1111-1111-1111-111111111111");
});

test("omits orgId/tenantId when PAC auth is absent", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
    pacAuth: null,
  });
  assert.equal(captured.event.data.orgId, undefined);
  assert.equal(captured.event.data.tenantId, undefined);
});

test("forwards POWER_PLATFORM_SKILLS_CONFIG_DIR and FAKE_HTTPS into spawn opts", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const prevCfg = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const prevProbe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS;
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = "/tmp/fake-config";
  process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS = "/tmp/fake-probe.json";
  const captured = {};
  try {
    callWithStub({
      promptText: "/power-pages:add-seo",
      telemetryDir,
      captured,
    });
  } finally {
    if (prevCfg === undefined) delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    else process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = prevCfg;
    if (prevProbe === undefined) delete process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS;
    else process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS = prevProbe;
  }
  assert.equal(captured.spawnOpts.configDir, "/tmp/fake-config");
  assert.equal(captured.spawnOpts.fakeProbe, "/tmp/fake-probe.json");
});

test("does not throw when ikey.json is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-noikey-"));
  const captured = {};
  assert.doesNotThrow(() =>
    emitSkillStartedFromPrompt("/power-pages:add-seo", {
      pluginName: "power-pages",
      pluginVersion: "1.2.3",
      trackedSkills: TRACKED,
      telemetryDir: tmp,
      _emit: (e, o) => {
        captured.event = e;
        captured.spawnOpts = o;
      },
      _readPacAuth: () => null,
    })
  );
});

test("does not throw when _emit throws", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  assert.doesNotThrow(() =>
    emitSkillStartedFromPrompt("/power-pages:add-seo", {
      pluginName: "power-pages",
      pluginVersion: "1.2.3",
      trackedSkills: TRACKED,
      telemetryDir,
      _emit: () => {
        throw new Error("boom");
      },
      _readPacAuth: () => null,
    })
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test shared/telemetry/tests/emit-from-prompt.test.js`
Expected: tests FAIL because the orchestrator doesn't yet read `event_stream_name` or accept `_readPacAuth`.

- [ ] **Step 3: Rewrite `emit-from-prompt.js`**

Replace `shared/telemetry/lib/emit-from-prompt.js` with:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { detectSlashCommand } = require("./prompt-detector");
const { buildSkillStarted } = require("./events");
const { getSessionId } = require("./session");
const { fireAndForget } = require("./emit-spawn");
const { readPacAuth } = require("./pac-auth");

function readIkey(telemetryDir) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(telemetryDir, "ikey.json"), "utf8")
    );
    return {
      ikey: cfg.ikey || "",
      collectorUrl: cfg.collector_url || "",
      eventStreamName: cfg.event_stream_name || "",
    };
  } catch {
    return { ikey: "", collectorUrl: "", eventStreamName: "" };
  }
}

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function emitSkillStartedFromPrompt(promptText, opts = {}) {
  const {
    pluginName,
    pluginVersion,
    trackedSkills,
    telemetryDir,
    _emit, // test seam; defaults to fireAndForget
    _readPacAuth, // test seam; defaults to lib/pac-auth
  } = opts;

  const skillName = detectSlashCommand(promptText, { pluginName, trackedSkills });
  if (!skillName) return { emitted: false, skillName: null };

  const { ikey, collectorUrl, eventStreamName } = readIkey(telemetryDir);

  const pacReader = typeof _readPacAuth === "function" ? _readPacAuth : readPacAuth;
  let pacAuth = null;
  try {
    pacAuth = pacReader();
  } catch {
    pacAuth = null;
  }

  const fields = {
    pluginName,
    pluginVersion: pluginVersion || "unknown",
    sessionId: getSessionId(),
    correlationId: crypto.randomUUID(),
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: "v" + String(process.versions.node).split(".")[0],
    skillName,
  };
  if (pacAuth && pacAuth.orgId) fields.orgId = pacAuth.orgId;
  if (pacAuth && pacAuth.tenantId) fields.tenantId = pacAuth.tenantId;

  const event = buildSkillStarted(eventStreamName, fields);

  const emit = typeof _emit === "function" ? _emit : fireAndForget;
  try {
    emit(event, {
      iKey: ikey,
      collectorUrl,
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "",
      fakeProbe: process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "",
    });
  } catch {
    // fail closed — telemetry never propagates errors
  }

  return { emitted: true, skillName };
}

module.exports = { emitSkillStartedFromPrompt };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test shared/telemetry/tests/emit-from-prompt.test.js`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/emit-from-prompt.js shared/telemetry/tests/emit-from-prompt.test.js
git commit -m "feat(telemetry): emit-from-prompt reads event_stream_name + PAC auth + camelCase fields"
```

---

### Task 6: Update `emit-dispatcher.test.js` and `emit-spawn.test.js` for new shape

**Files:**
- Modify: `shared/telemetry/tests/emit-dispatcher.test.js`
- Modify: `shared/telemetry/tests/emit-spawn.test.js`

The dispatcher and spawn helpers are unchanged in behavior; only the test fixtures need updating because they hardcode the old envelope shape.

- [ ] **Step 1: Update the `fakeEvent` constant in `emit-dispatcher.test.js`**

Open `shared/telemetry/tests/emit-dispatcher.test.js`. Replace the `fakeEvent` declaration with:

```js
const fakeEvent = {
  name: "PowerPagesPluginEvent",
  data: {
    eventName: "skill_started",
    eventType: "Trace",
    severity: "Info",
    pluginName: "power-pages",
    skillName: "add-seo",
  },
};
```

- [ ] **Step 2: Update probe-body assertions in the same file**

In the test `"dispatcher writes a probe file when fake-https points to one (happy path)"`, replace the body-assertion block with:

```js
const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
assert.equal(probe.headers["x-apikey"], "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa");
assert.equal(probe.headers["Content-Type"], "application/x-json-stream; charset=utf-8");
assert.ok(probe.body.endsWith("\n"), "body must be newline-terminated for x-json-stream");
const body = JSON.parse(probe.body);
assert.deepEqual(Object.keys(body).sort(), ["data", "iKey", "name", "time", "ver"]);
assert.equal(body.ver, "4.0");
assert.equal(body.name, "PowerPagesPluginEvent");
assert.equal(body.iKey, "o:real");
assert.match(body.time, /^\d{4}-\d{2}-\d{2}T/);
assert.deepEqual(body.data, fakeEvent.data);
```

- [ ] **Step 3: Update local-log assertion in the same file**

In the test `"dispatcher appends to events.jsonl when iKey is placeholder + consent enabled"`, replace the parsed-line assertion with:

```js
const parsed = JSON.parse(lines[0]);
assert.equal(parsed.name, "PowerPagesPluginEvent");
assert.equal(parsed.data.eventName, "skill_started");
```

- [ ] **Step 4: Update `sampleEvent` in `emit-spawn.test.js`**

Open `shared/telemetry/tests/emit-spawn.test.js`. Replace the `sampleEvent` declaration with:

```js
const sampleEvent = {
  name: "PowerPagesPluginEvent",
  data: {
    eventName: "skill_started",
    eventType: "Trace",
    severity: "Info",
    skillName: "hello",
  },
};
```

- [ ] **Step 5: Update probe-body assertions in `emit-spawn.test.js`**

In the test `"dispatcher child receives the event and writes the probe"`, replace the body-assertion block with:

```js
assert.ok(fs.existsSync(probe), "probe file was not written");
const contents = JSON.parse(fs.readFileSync(probe, "utf8"));
assert.ok(contents.body.endsWith("\n"), "body must be newline-terminated");
const body = JSON.parse(contents.body);
assert.deepEqual(Object.keys(body).sort(), ["data", "iKey", "name", "time", "ver"]);
assert.equal(body.name, "PowerPagesPluginEvent");
assert.equal(body.data.eventName, "skill_started");
assert.equal(body.data.skillName, "hello");
```

- [ ] **Step 6: Run both updated test files**

Run: `node --test shared/telemetry/tests/emit-dispatcher.test.js shared/telemetry/tests/emit-spawn.test.js`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add shared/telemetry/tests/emit-dispatcher.test.js shared/telemetry/tests/emit-spawn.test.js
git commit -m "test(telemetry): update dispatcher/spawn fixtures for PowerPagesPluginEvent shape"
```

---

### Task 7: Run the full shared-telemetry suite

**Files:** none.

- [ ] **Step 1: Run every shared test**

Run: `node --test shared/telemetry/tests/*.test.js`
Expected: all tests across all files PASS. If anything fails, the failing file likely has another stale `eventInfo` / `COLLECTOR_EVENT_NAME` reference — fix inline and re-run.

- [ ] **Step 2: No commit if no changes** — this is a verification gate.

---

## Milestone 3 — Power Pages Hooks

### Task 8: Update `run-skill-pretool-telemetry.js`

**Files:**
- Modify: `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`

This hook fires on programmatic `Skill` tool invocations. Update it to read `event_stream_name`, populate camelCase fields, and read PAC auth.

- [ ] **Step 1: Replace the file content**

Replace `plugins/power-pages/hooks/run-skill-pretool-telemetry.js` with:

```js
#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

let emitSpawn, eventsLib, correlationLib, sessionLib, pacAuthLib;
try {
  emitSpawn = require(path.join(TELEMETRY_DIR, "lib", "emit-spawn"));
  eventsLib = require(path.join(TELEMETRY_DIR, "lib", "events"));
  correlationLib = require(path.join(TELEMETRY_DIR, "lib", "correlation"));
  sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
  pacAuthLib = require(path.join(TELEMETRY_DIR, "lib", "pac-auth"));
} catch {
  process.exit(0);
}

let hookUtils;
try {
  hookUtils = require(path.join(PLUGIN_ROOT, "scripts", "lib", "powerpages-hook-utils"));
} catch {
  process.exit(0);
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    );
    return manifest.version || "unknown";
  } catch {
    return "unknown";
  }
}

function readIkey() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(TELEMETRY_DIR, "ikey.json"), "utf8")
    );
    return {
      ikey: cfg.ikey || "",
      collectorUrl: cfg.collector_url || "",
      eventStreamName: cfg.event_stream_name || "",
    };
  } catch {
    return { ikey: "", collectorUrl: "", eventStreamName: "" };
  }
}

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

(async () => {
  const raw = await readStdin();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const skillName = hookUtils.getTrackedSkillFromToolInput(parsed.tool_input);
  if (!skillName) process.exit(0);

  const { correlation_id } = correlationLib.write({ skillName });

  const { ikey, collectorUrl, eventStreamName } = readIkey();
  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";
  const fakeProbe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";

  let pacAuth = null;
  try {
    pacAuth = pacAuthLib.readPacAuth();
  } catch {
    pacAuth = null;
  }

  const fields = {
    pluginName: "power-pages",
    pluginVersion: readPluginVersion(),
    sessionId: sessionLib.getSessionId(),
    correlationId: correlation_id,
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: "v" + String(process.versions.node).split(".")[0],
    skillName,
  };
  if (pacAuth && pacAuth.orgId) fields.orgId = pacAuth.orgId;
  if (pacAuth && pacAuth.tenantId) fields.tenantId = pacAuth.tenantId;

  try {
    emitSpawn.fireAndForget(
      eventsLib.buildSkillStarted(eventStreamName, fields),
      { iKey: ikey, collectorUrl, configDir, fakeProbe }
    );
  } catch {
    // fail closed
  }

  process.exit(0);
})().catch(() => process.exit(0));
```

- [ ] **Step 2: Validate JS syntax**

Run: `node --check plugins/power-pages/hooks/run-skill-pretool-telemetry.js`
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add plugins/power-pages/hooks/run-skill-pretool-telemetry.js
git commit -m "feat(power-pages): pretool hook reads event_stream_name + PAC auth, camelCase fields"
```

---

### Task 9: Update `run-skill-posttool-validation.js`

**Files:**
- Modify: `plugins/power-pages/hooks/run-skill-posttool-validation.js`

This hook fires after the `Skill` tool returns. It runs the existing validator script (unchanged) and emits `skill_completed` with outcome+duration.

- [ ] **Step 1: Replace the file content**

Replace `plugins/power-pages/hooks/run-skill-posttool-validation.js` with:

```js
#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const {
  getTrackedSkillFromToolInput,
  getValidatorScript,
} = require('../scripts/lib/powerpages-hook-utils');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'telemetry');
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function debug(msg) {
  if (DEBUG) process.stderr.write(msg);
}

function osFriendlyName(platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'Mac';
  if (platform === 'linux') return 'Linux';
  return platform;
}

debug('[power-pages hook] run-skill-posttool-validation.js started\n');

let inputData = '';

process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', async () => {
  debug(`[power-pages hook] stdin closed, received ${inputData.length} bytes\n`);

  const startTs = Date.now();
  let validatorStatus = 0;
  let skillName = null;
  let validatorRan = false;

  try {
    const input = JSON.parse(inputData);
    skillName = getTrackedSkillFromToolInput(input.tool_input);
    if (!skillName) {
      debug('[power-pages hook] No tracked skill detected — skipping validation\n');
      process.exit(0);
    }

    const validatorScript = getValidatorScript(skillName);
    if (validatorScript) {
      validatorRan = true;
      const validatorPath = path.join(__dirname, '..', validatorScript);
      const result = spawnSync(process.execPath, [validatorPath], {
        input: inputData,
        encoding: 'utf8',
        cwd: input.cwd || process.cwd(),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      validatorStatus = result.status ?? 0;
      debug(`[power-pages hook] Validator exited with code ${validatorStatus}\n`);
    }
  } catch (err) {
    process.stderr.write(`[power-pages hook] Unexpected error: ${err.message}\n`);
    validatorStatus = 0;
  }

  // Telemetry emission: fail-closed, never changes exit code.
  try {
    const emitSpawn = require(path.join(TELEMETRY_DIR, 'lib', 'emit-spawn'));
    const eventsLib = require(path.join(TELEMETRY_DIR, 'lib', 'events'));
    const correlationLib = require(path.join(TELEMETRY_DIR, 'lib', 'correlation'));
    const sessionLib = require(path.join(TELEMETRY_DIR, 'lib', 'session'));
    const pacAuthLib = require(path.join(TELEMETRY_DIR, 'lib', 'pac-auth'));

    const ikeyCfg = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(TELEMETRY_DIR, 'ikey.json'), 'utf8')
        );
      } catch {
        return { ikey: '', collector_url: '', event_stream_name: '' };
      }
    })();

    const pluginVersion = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
        ).version || 'unknown';
      } catch {
        return 'unknown';
      }
    })();

    const corr = correlationLib.read({ skillName }) || {
      correlation_id: require('crypto').randomUUID(),
      start_ts: startTs,
    };

    const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || '';
    const fakeProbe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || '';
    const outcome =
      !validatorRan || validatorStatus === 0 ? 'success' : 'failure';

    let pacAuth = null;
    try {
      pacAuth = pacAuthLib.readPacAuth();
    } catch {
      pacAuth = null;
    }

    const fields = {
      pluginName: 'power-pages',
      pluginVersion,
      sessionId: sessionLib.getSessionId(),
      correlationId: corr.correlation_id,
      osName: osFriendlyName(process.platform),
      osVersion: os.release(),
      nodeVersion: 'v' + String(process.versions.node).split('.')[0],
      skillName,
      outcome,
      durationMs: Date.now() - (corr.start_ts || startTs),
      errorClass: '',
    };
    if (pacAuth && pacAuth.orgId) fields.orgId = pacAuth.orgId;
    if (pacAuth && pacAuth.tenantId) fields.tenantId = pacAuth.tenantId;

    emitSpawn.fireAndForget(
      eventsLib.buildSkillCompleted(
        ikeyCfg.event_stream_name || '',
        fields
      ),
      {
        iKey: ikeyCfg.ikey || '',
        collectorUrl: ikeyCfg.collector_url || '',
        configDir,
        fakeProbe,
      }
    );

    correlationLib.clear({ skillName });
  } catch {
    // fail closed: telemetry never affects skill outcome
  }

  process.exit(validatorStatus);
});
```

- [ ] **Step 2: Validate JS syntax**

Run: `node --check plugins/power-pages/hooks/run-skill-posttool-validation.js`
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add plugins/power-pages/hooks/run-skill-posttool-validation.js
git commit -m "feat(power-pages): posttool hook emits new shape with PAC auth + severity mapping"
```

---

### Task 10: Update `run-user-prompt-telemetry.js` integration test

**Files:**
- Modify: `plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js`

The hook script itself doesn't change in this task — it already calls the orchestrator, which we updated in Task 5. The integration test needs to write `event_stream_name` into `ikey.json` and assert the new wire shape.

- [ ] **Step 1: Replace the integration test**

Replace `plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js` with:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "run-user-prompt-telemetry.js");

function mkConfigDir(enabled = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-upt-"));
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({
      version: 1,
      enabled,
      recorded_at: new Date().toISOString(),
    })
  );
  return tmp;
}

function runHook({ prompt, configDir, fakeProbe }) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt }),
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe || "",
    },
    timeout: 10_000,
  });
}

test("hook emits PowerPagesPluginEvent with top-level fields for tracked slash command", () => {
  const configDir = mkConfigDir(true);
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = path.join(
    PLUGIN_ROOT,
    "scripts",
    "lib",
    "telemetry",
    "ikey.json"
  );
  const original = fs.readFileSync(ikeyPath, "utf8");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      ikey: "test-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collector_url: "https://example.invalid/OneCollector/1.0/",
      event_stream_name: "PowerPagesPluginEvent",
    })
  );

  try {
    const { status } = runHook({
      prompt: "/power-pages:add-seo",
      configDir,
      fakeProbe: probePath,
    });
    assert.equal(status, 0);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(probePath) && Date.now() < deadline) {
      // busy-wait
    }
    assert.ok(fs.existsSync(probePath), "dispatcher should have written probe");
    const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
    assert.ok(probe.body.endsWith("\n"), "body must be newline-terminated");
    const body = JSON.parse(probe.body);
    assert.deepEqual(Object.keys(body).sort(), ["data", "iKey", "name", "time", "ver"]);
    assert.equal(body.name, "PowerPagesPluginEvent");
    assert.equal(body.ver, "4.0");
    assert.match(body.iKey, /^o:/);
    assert.equal(body.data.eventName, "skill_started");
    assert.equal(body.data.eventType, "Trace");
    assert.equal(body.data.severity, "Info");
    assert.equal(body.data.pluginName, "power-pages");
    assert.equal(body.data.skillName, "add-seo");
    assert.equal(typeof body.data.sessionId, "string");
    assert.equal(typeof body.data.correlationId, "string");
    assert.equal(typeof body.data.osName, "string");
    assert.equal(typeof body.data.osVersion, "string");
    assert.match(body.data.nodeVersion, /^v\d+$/);
  } finally {
    fs.writeFileSync(ikeyPath, original);
  }
});

test("hook exits 0 and emits nothing for an unrelated prompt", () => {
  const configDir = mkConfigDir(true);
  const probePath = path.join(configDir, "probe.json");
  const { status } = runHook({
    prompt: "just some user text",
    configDir,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  const deadline = Date.now() + 500;
  while (!fs.existsSync(probePath) && Date.now() < deadline) {
    // spin
  }
  assert.ok(!fs.existsSync(probePath), "unrelated prompt must not emit");
});

test("hook exits 0 on malformed stdin", () => {
  const configDir = mkConfigDir(true);
  const { status } = spawnSync(process.execPath, [HOOK], {
    input: "not json",
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    },
    timeout: 10_000,
  });
  assert.equal(status, 0);
});

test("hook exits 0 on empty stdin", () => {
  const configDir = mkConfigDir(true);
  const { status } = spawnSync(process.execPath, [HOOK], {
    input: "",
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    },
    timeout: 10_000,
  });
  assert.equal(status, 0);
});
```

- [ ] **Step 2: This test will fail until Task 11 syncs the new shared library files into the plugin.** That's expected. Commit the test now.

Run: `node --test plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js`
Expected: tests fail (because the synced plugin telemetry library is still on the old shape). That's OK — Task 11 fixes it.

- [ ] **Step 3: Commit**

```bash
git add plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js
git commit -m "test(power-pages): integration test asserts PowerPagesPluginEvent shape"
```

---

### Task 11: Sync to plugin and verify integration

**Files:** propagated by sync.

- [ ] **Step 1: Run the sync script**

Run: `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages`
Expected: prints `Synced shared/telemetry → plugins\power-pages\scripts\lib\telemetry`.

- [ ] **Step 2: Verify the new pac-auth.js landed**

Run: `ls plugins/power-pages/scripts/lib/telemetry/lib/pac-auth.js`
Expected: file exists.

- [ ] **Step 3: Set the plugin's `event_stream_name` to the real value**

The sync script just copied the dev-time placeholder. The plugin's synced `ikey.json` should carry the real per-plugin envelope name.

Edit `plugins/power-pages/scripts/lib/telemetry/ikey.json` to:

```json
{
  "ikey": "ffdb4c99ca3a4ad5b8e9ffb08bf7da0d-65357ff3-efcd-47fc-b2fd-ad95a52373f4-7402",
  "collector_url": "https://self.pipe.aria.int.microsoft.com/OneCollector/1.0/",
  "event_stream_name": "PowerPagesPluginEvent"
}
```

- [ ] **Step 4: Run the plugin integration test**

Run: `node --test plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js`
Expected: all 4 tests PASS.

- [ ] **Step 5: Run the full shared suite once more**

Run: `node --test shared/telemetry/tests/*.test.js`
Expected: all tests PASS.

- [ ] **Step 6: Commit synced files + plugin envelope name**

```bash
git add plugins/power-pages/scripts/lib/telemetry/
git commit -m "chore(power-pages): sync rebuild of shared telemetry + set PowerPagesPluginEvent stream name"
```

---

### Task 12: Save the EventStreamingAnnotation handoff file

**Files:**
- Create: `docs/superpowers/handoff/PowerPagesPluginEvent-annotation.xml`

- [ ] **Step 1: Create the directory if it does not exist**

Run: `mkdir -p docs/superpowers/handoff`

- [ ] **Step 2: Create the annotation file**

Create `docs/superpowers/handoff/PowerPagesPluginEvent-annotation.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<EventStreamingAnnotation name="^PowerPagesPluginEvent$">
  <Indexing>
    <Content><![CDATA[
    {
      "Interchange": {
        "CollectorEventMappingList": ["ffdb4c99ca3a4ad5b8e9ffb08bf7da0d:PowerPagesPluginEvent"],
        "FieldNameMappings": [
          "data_eventName:EventName",
          "data_eventType:EventType",
          "data_severity:Severity",
          "data_pluginName:PluginName",
          "data_pluginVersion:PluginVersion",
          "data_sessionId:SessionId",
          "data_correlationId:CorrelationId",
          "data_osName:OsName",
          "data_osVersion:OsVersion",
          "data_nodeVersion:NodeVersion",
          "data_skillName:SkillName",
          "data_scriptName:ScriptName",
          "data_outcome:Outcome",
          "data_durationMs:DurationMs",
          "data_errorClass:ErrorClass",
          "data_orgId:OrgId",
          "data_tenantId:TenantId",
          "iKey:iKey",
          "ver:Ver"
        ],
        "IncludeFields": [
          "EventName", "EventType", "Severity",
          "PluginName", "PluginVersion",
          "SessionId", "CorrelationId",
          "OsName", "OsVersion", "NodeVersion",
          "SkillName", "ScriptName",
          "Outcome", "DurationMs", "ErrorClass",
          "OrgId", "TenantId",
          "iKey", "Ver"
        ],
        "EnableOriginalMessage": false
      }
    }
    ]]></Content>
  </Indexing>
</EventStreamingAnnotation>
```

The 32-hex prefix in `CollectorEventMappingList` (`ffdb4c99ca3a4ad5b8e9ffb08bf7da0d`) is the first segment of the iKey before any dash. The tenant team copies this XML into the Geneva/Aria provisioning repo to register `(iKey, "PowerPagesPluginEvent")` against the new `PowerPagesPluginEvent` Kusto table.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/handoff/PowerPagesPluginEvent-annotation.xml
git commit -m "docs(telemetry): add PowerPagesPluginEvent annotation file for tenant handoff"
```

---

### Task 13: Local end-to-end verification

**Files:** none.

- [ ] **Step 1: Confirm consent state and current `events.jsonl` line count**

Run (bash):

```bash
node plugins/power-pages/scripts/lib/telemetry/lib/check-consent.js
wc -l "$USERPROFILE/.power-platform-skills/events.jsonl" 2>/dev/null || echo "0 (file not found)"
```

Expected: first command prints `ENABLED`. Second prints the current line count (or `0`). Record this number.

- [ ] **Step 2: Fire the hook with the real ikey and verify the wire envelope**

Run (bash):

```bash
PROBE=$(mktemp --tmpdir ppskills-e2e.XXX.json)
echo '{"prompt":"/power-pages:add-seo"}' \
  | POWER_PLATFORM_SKILLS_FAKE_HTTPS="$PROBE" \
    node plugins/power-pages/hooks/run-user-prompt-telemetry.js
sleep 2
cat "$PROBE"
echo
rm -f "$PROBE"
```

Expected: probe JSON contains a body with `name: "PowerPagesPluginEvent"`, `data.eventName: "skill_started"`, top-level `data.pluginName: "power-pages"`, `data.skillName: "add-seo"`, etc. Body ends with `\n`.

- [ ] **Step 3: Fire one real event to 1DS (no FAKE_HTTPS)**

Run: `echo '{"prompt":"/power-pages:add-seo"}' | node plugins/power-pages/hooks/run-user-prompt-telemetry.js`
Expected: hook exits 0; detached dispatcher POSTs to the real collector. Wait 5–10 minutes for ingestion.

- [ ] **Step 4: Query Kusto for the event**

In the test cluster (`https://powerportalstest.kusto.windows.net`, database `PowerPortalsAnalytics`), once the `PowerPagesPluginEvent` table is provisioned by the tenant team, run:

```kql
PowerPagesPluginEvent
| where iKey == "o:ffdb4c99ca3a4ad5b8e9ffb08bf7da0d"
| where ext_ingest_time > ago(30m)
| project ext_ingest_time, EventName, PluginName, SkillName, OsName, NodeVersion
| take 5
```

Expected: at least one row with `EventName == "skill_started"`, `PluginName == "power-pages"`, `SkillName == "add-seo"`. If the table doesn't exist yet, the query errors with "table not found" — that's expected before tenant-side provisioning lands. Re-run after the annotation is provisioned.

- [ ] **Step 5: No commit** — pure verification.

---

## Self-Review Checklist (for the implementer)

Before claiming complete:

- [ ] `node --test shared/telemetry/tests/*.test.js` passes (every file).
- [ ] `node --test plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js` passes.
- [ ] No `eventInfo`, `COLLECTOR_EVENT_NAME`, `VscodeEvent`, `PagesPowerPlatformExtEvent`, or `baseType` references remain in `shared/telemetry/lib/`, `shared/telemetry/tests/`, or `plugins/power-pages/scripts/lib/telemetry/lib/`.
- [ ] `plugins/power-pages/scripts/lib/telemetry/ikey.json` has `event_stream_name: "PowerPagesPluginEvent"`.
- [ ] FAKE_HTTPS probe shows the new envelope shape byte-for-byte.
- [ ] No new npm dependencies introduced.
- [ ] No PII or stack traces leak — spot-check a real event from `events.jsonl` (when iKey is placeholder) or the FAKE_HTTPS probe (when iKey is real).
- [ ] Annotation handoff file exists at `docs/superpowers/handoff/PowerPagesPluginEvent-annotation.xml`.

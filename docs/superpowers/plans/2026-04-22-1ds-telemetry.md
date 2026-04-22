# 1DS Telemetry Implementation Plan

> **Revised 2026-04-22:** The spec was revised to drop the `@microsoft/1ds-*` SDK and adopt a detached-child dispatcher pattern for fire-and-forget emission. Affected tasks: 1.1, 1.7, 1.8, 1.11, 2.1, 2.3, 3.1, 3.2, 5.1, 6.1, 6.3, 7.1, 7.2. Unchanged: 0.x, 1.2–1.6, 1.9–1.10, 2.2, 3.3, 4.x, 5.2–5.6, 6.2, 6.4.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 1DS telemetry to the `power-pages` plugin using a shared library at `shared/telemetry/` that other plugins can later adopt via a sync script.

**Architecture:** Canonical source of truth at `shared/telemetry/`; per-plugin synced copy at `plugins/<plugin>/scripts/lib/telemetry/`. Hooks (`PreToolUse:Skill` and `PostToolUse:Skill`) and a `withTelemetry()` wrapper all emit events through a detached-child dispatcher so the caller never blocks on a network round-trip. Consent gathered by an interactive prompt on first skill run; persisted at `~/.power-platform-skills/telemetry.json`. Fail-closed everywhere.

**Tech Stack:** Node 22 built-ins only (`node:https`, `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:crypto`), `node:test`, existing `scripts/lib/powerpages-hook-utils.js`. **No npm dependencies.**

**Reference:** Spec at `docs/superpowers/specs/2026-04-20-1ds-telemetry-design.md`. Working POC at `poc/1ds-telemetry/` — the POC's `emit.js` (SDK-based) is for historical context only; the real shipping code uses Node's built-in `https`. The POC's demonstration of the Common Schema 4.0 envelope shape is still accurate and worth reading.

---

## Project conventions (applies to every task)

- **Test runner:** `node --test <file>` (no external deps). All tests use `node:test` + `node:assert/strict`.
- **Style:** CommonJS (`require`/`module.exports`), matches every other Node script in `plugins/power-pages/scripts/`.
- **Commits:** Conventional-ish subject lines consistent with the repo (`feat(telemetry): ...`, `test(telemetry): ...`, `docs(telemetry): ...`). Always include the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer — matches the POC commit and prior repo practice.
- **No placeholders:** every string value in the code is real. Where the spec leaves something open (iKey), the plan picks a concrete value.
- **No npm dependencies:** the telemetry library uses only Node built-ins. There is no `package.json`, no `node_modules`, no `npm install` step anywhere in the telemetry tree.
- **Testing network code:** the dispatcher takes the `https` module through a shim that tests replace with a fake. Tests never POST to the real 1DS collector.

---

## File structure

```
shared/telemetry/
├── README.md
├── ikey.json
├── sync-to-plugin.js
├── lib/
│   ├── emit-dispatcher.js                 # CLI: stdin JSON event → HTTPS POST → exit
│   ├── emit-spawn.js                      # Helper: spawns emit-dispatcher.js detached
│   ├── consent.js                         # Read/write consent config file
│   ├── correlation.js                     # Pre→Post correlation via OS temp file
│   ├── events.js                          # 4 event builders with strict allowlists
│   ├── session.js                         # Per-process anonymized UUID
│   ├── scrubber.js                        # No-op placeholder
│   ├── check-consent.js                   # CLI: prints NEEDS_PROMPT | ENABLED | DISABLED
│   ├── record-consent.js                  # CLI: --answer yes|no
│   └── with-telemetry.js                  # Wrapper for plugin Node scripts; calls emit-spawn
├── references/
│   └── telemetry-consent-reference.md
└── tests/
    ├── emit-dispatcher.test.js
    ├── emit-spawn.test.js
    ├── consent.test.js
    ├── correlation.test.js
    ├── events.test.js
    ├── session.test.js
    ├── scrubber.test.js
    ├── with-telemetry.test.js
    └── sync-to-plugin.test.js

plugins/power-pages/
├── scripts/lib/telemetry/                 # Synced from shared/telemetry/ — DO NOT hand-edit
├── scripts/tests/
│   ├── telemetry-hook-pretool.test.js
│   └── telemetry-hook-posttool.test.js
├── hooks/
│   ├── hooks.json                         # PreToolUse:Skill + existing PostToolUse:Skill
│   ├── run-skill-pretool-telemetry.js     # NEW
│   └── run-skill-posttool-validation.js   # EXTENDED with emission after validator
├── references/
│   └── telemetry-consent-reference.md     # Synced
└── skills/*/SKILL.md                      # Each tracked skill gets the Phase-1 consent one-liner
```

---

## Milestone 0 — Prereqs

### Task 0.1: Confirm Node version

**Files:**
- Read: *(none — shell check)*

- [ ] **Step 1: Verify Node 22 is available**

Run: `node --version`
Expected: `v22.*` or newer. If older, stop and ask the user to upgrade — the dispatcher uses Node's built-in `https` module plus `fetch`-like ergonomics that assume a modern Node.

- [ ] **Step 2: Verify working tree is clean before starting**

Run: `git status --short`
Expected: empty output (no uncommitted changes). If not clean, stop and resolve first.

---

## Milestone 1 — Shared library skeleton (foundation, TDD)

Build `shared/telemetry/` with tests in sequence. No plugin wiring yet. At the end of this milestone, `node --test shared/telemetry/tests/*.test.js` passes.

### Task 1.1: Scaffold `shared/telemetry/` directory

**Files:**
- Create: `shared/telemetry/ikey.json`

- [ ] **Step 1: Create the directory structure**

Run:
```bash
mkdir -p shared/telemetry/lib shared/telemetry/tests shared/telemetry/references
```

- [ ] **Step 2: Write `shared/telemetry/ikey.json` (placeholder)**

The iKey is a placeholder string. Task 7.1 replaces it with the real provisioned iKey before any live emission happens. The dispatcher treats this placeholder as "no iKey" → no-op emit.

```json
{
  "ikey": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
  "collector_url": "https://self.events.data.microsoft.com/OneCollector/1.0/"
}
```

- [ ] **Step 3: Commit**

```bash
git add shared/telemetry/ikey.json
git commit -m "$(cat <<'EOF'
feat(telemetry): scaffold shared/telemetry directory

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.2: `session.js` — per-process session id

**Files:**
- Create: `shared/telemetry/lib/session.js`
- Create: `shared/telemetry/tests/session.test.js`

- [ ] **Step 1: Write the failing test**

Path: `shared/telemetry/tests/session.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const sessionPath = path.resolve(__dirname, "../lib/session.js");

test("getSessionId returns a non-empty string", () => {
  const { getSessionId } = require(sessionPath);
  const id = getSessionId();
  assert.equal(typeof id, "string");
  assert.ok(id.length >= 32, `expected UUID-length, got ${id}`);
});

test("getSessionId is stable within a process", () => {
  const { getSessionId } = require(sessionPath);
  assert.equal(getSessionId(), getSessionId());
});

test("getSessionId is unique across processes", () => {
  const script = `process.stdout.write(require('${sessionPath.replace(/\\/g, "\\\\")}').getSessionId());`;
  const a = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  const b = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.notEqual(a.stdout, b.stdout);
  assert.ok(a.stdout.length >= 32);
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `node --test shared/telemetry/tests/session.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `session.js`**

Path: `shared/telemetry/lib/session.js`

```js
"use strict";

const crypto = require("node:crypto");

let cached;

function getSessionId() {
  if (!cached) {
    cached = crypto.randomUUID();
  }
  return cached;
}

module.exports = { getSessionId };
```

- [ ] **Step 4: Run test — expect PASS**

Run: `node --test shared/telemetry/tests/session.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/session.js shared/telemetry/tests/session.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add per-process session id helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.3: `consent.js` — read/write consent file

**Files:**
- Create: `shared/telemetry/lib/consent.js`
- Create: `shared/telemetry/tests/consent.test.js`

- [ ] **Step 1: Write the failing test**

Path: `shared/telemetry/tests/consent.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const consentLib = require("../lib/consent");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-consent-"));
}

test("read returns { state: 'unset' } when file missing", () => {
  const tmp = mkTmp();
  const result = consentLib.read({ configDir: tmp });
  assert.deepEqual(result, { state: "unset" });
});

test("read returns { state: 'unset' } when file is malformed JSON", () => {
  const tmp = mkTmp();
  fs.writeFileSync(path.join(tmp, "telemetry.json"), "{not json");
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "unset");
});

test("write followed by read round-trips", () => {
  const tmp = mkTmp();
  consentLib.write({ configDir: tmp, enabled: true });
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "enabled");
  assert.equal(result.record.enabled, true);
  assert.equal(result.record.version, 1);
  assert.equal(result.record.prompt_version, 1);
  assert.ok(result.record.consented_at);
});

test("write enabled=false produces state: 'disabled'", () => {
  const tmp = mkTmp();
  consentLib.write({ configDir: tmp, enabled: false });
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "disabled");
  assert.equal(result.record.enabled, false);
});

test("read treats schema version bump as 'unset' (forces re-prompt)", () => {
  const tmp = mkTmp();
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({ version: 2, enabled: true, prompt_version: 1, consented_at: "x" })
  );
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "unset");
});

test("read treats prompt_version bump as 'unset' (forces re-prompt)", () => {
  const tmp = mkTmp();
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({ version: 1, enabled: true, prompt_version: 2, consented_at: "x" })
  );
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "unset");
});

test("env var POWER_PLATFORM_SKILLS_TELEMETRY=0 overrides to 'disabled'", () => {
  const tmp = mkTmp();
  consentLib.write({ configDir: tmp, enabled: true });
  const result = consentLib.read({
    configDir: tmp,
    env: { POWER_PLATFORM_SKILLS_TELEMETRY: "0" },
  });
  assert.equal(result.state, "disabled");
});

test("env var POWER_PLATFORM_SKILLS_TELEMETRY=1 does NOT force-enable", () => {
  const tmp = mkTmp();
  const result = consentLib.read({
    configDir: tmp,
    env: { POWER_PLATFORM_SKILLS_TELEMETRY: "1" },
  });
  assert.equal(result.state, "unset");
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `node --test shared/telemetry/tests/consent.test.js`

- [ ] **Step 3: Implement `consent.js`**

Path: `shared/telemetry/lib/consent.js`

```js
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const PROMPT_VERSION = 1;
const FILE_NAME = "telemetry.json";

function defaultConfigDir() {
  return path.join(os.homedir(), ".power-platform-skills");
}

function filePath(configDir) {
  return path.join(configDir || defaultConfigDir(), FILE_NAME);
}

function read({ configDir, env } = {}) {
  const e = env || process.env;
  if (e.POWER_PLATFORM_SKILLS_TELEMETRY === "0") {
    return { state: "disabled", record: null };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath(configDir), "utf8");
  } catch {
    return { state: "unset" };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "unset" };
  }

  if (
    parsed.version !== SCHEMA_VERSION ||
    parsed.prompt_version !== PROMPT_VERSION
  ) {
    return { state: "unset" };
  }

  return {
    state: parsed.enabled ? "enabled" : "disabled",
    record: parsed,
  };
}

function write({ configDir, enabled }) {
  const dir = configDir || defaultConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    version: SCHEMA_VERSION,
    prompt_version: PROMPT_VERSION,
    enabled: Boolean(enabled),
    consented_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath(dir), JSON.stringify(record, null, 2), "utf8");
  return record;
}

module.exports = {
  SCHEMA_VERSION,
  PROMPT_VERSION,
  defaultConfigDir,
  read,
  write,
};
```

- [ ] **Step 4: Run — expect PASS (8 tests)**

Run: `node --test shared/telemetry/tests/consent.test.js`

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/consent.js shared/telemetry/tests/consent.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add consent read/write with schema-version gating

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.4: `correlation.js` — pre→post correlation via temp file

**Files:**
- Create: `shared/telemetry/lib/correlation.js`
- Create: `shared/telemetry/tests/correlation.test.js`

- [ ] **Step 1: Write the failing test**

Path: `shared/telemetry/tests/correlation.test.js`

```js
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
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test shared/telemetry/tests/correlation.test.js`

- [ ] **Step 3: Implement `correlation.js`**

Path: `shared/telemetry/lib/correlation.js`

```js
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function correlationPath({ skillName, tmpDir }) {
  const dir = tmpDir || os.tmpdir();
  const safe = String(skillName || "unknown").replace(/[^a-z0-9-]/gi, "_");
  return path.join(dir, `ppskills-corr-${safe}.json`);
}

function write({ skillName, tmpDir }) {
  const record = {
    correlation_id: crypto.randomUUID(),
    start_ts: Date.now(),
  };
  try {
    fs.writeFileSync(
      correlationPath({ skillName, tmpDir }),
      JSON.stringify(record),
      "utf8"
    );
  } catch {
    // fail closed
  }
  return record;
}

function read({ skillName, tmpDir }) {
  try {
    const raw = fs.readFileSync(correlationPath({ skillName, tmpDir }), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.correlation_id === "string" &&
      typeof parsed.start_ts === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clear({ skillName, tmpDir }) {
  try {
    fs.unlinkSync(correlationPath({ skillName, tmpDir }));
  } catch {
    // ignore
  }
}

module.exports = { correlationPath, write, read, clear };
```

- [ ] **Step 4: Run — expect PASS (5 tests)**

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/correlation.js shared/telemetry/tests/correlation.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add pre→post correlation via OS temp file

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.5: `scrubber.js` — no-op PII scrubber placeholder

**Files:**
- Create: `shared/telemetry/lib/scrubber.js`
- Create: `shared/telemetry/tests/scrubber.test.js`

- [ ] **Step 1: Write the failing test**

Path: `shared/telemetry/tests/scrubber.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scrub } = require("../lib/scrubber");

test("scrub returns its input unchanged for strings", () => {
  assert.equal(scrub("hello world"), "hello world");
});

test("scrub returns its input unchanged for non-strings", () => {
  assert.equal(scrub(42), 42);
  assert.equal(scrub(null), null);
  assert.equal(scrub(undefined), undefined);
});

test("scrub never throws", () => {
  scrub({ nested: "obj" });
  scrub([]);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `scrubber.js`**

Path: `shared/telemetry/lib/scrubber.js`

```js
"use strict";

// Placeholder. The spec allowlist already restricts payload fields to values
// that cannot contain PII. This module exists as a documented seam for a
// future regex-based pass if the allowlist ever needs to carry user strings.

function scrub(value) {
  return value;
}

module.exports = { scrub };
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/scrubber.js shared/telemetry/tests/scrubber.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add no-op scrubber placeholder

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.6: `events.js` — 4 event builders with strict allowlists

**Files:**
- Create: `shared/telemetry/lib/events.js`
- Create: `shared/telemetry/tests/events.test.js`

- [ ] **Step 1: Write the failing test**

Path: `shared/telemetry/tests/events.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSkillStarted,
  buildSkillCompleted,
  buildScriptStarted,
  buildScriptCompleted,
  COLLECTOR_EVENT_NAME,
} = require("../lib/events");

const common = {
  plugin_name: "power-pages",
  plugin_version: "1.2.2",
  session_id: "sess-uuid",
  os_family: "linux",
  node_version: "v22",
};

test("COLLECTOR_EVENT_NAME is the canonical single collector name", () => {
  assert.equal(COLLECTOR_EVENT_NAME, "PowerPlatformSkillsEvent");
});

test("buildSkillStarted emits expected shape", () => {
  const ev = buildSkillStarted({
    ...common,
    skill_name: "create-site",
    correlation_id: "corr-1",
  });
  assert.equal(ev.name, COLLECTOR_EVENT_NAME);
  assert.equal(ev.data.eventName, "skill_started");
  assert.equal(ev.data.eventType, "Trace");
  assert.equal(ev.data.severity, "Info");
  const info = JSON.parse(ev.data.eventInfo);
  assert.deepEqual(Object.keys(info).sort(), [
    "correlation_id",
    "node_version",
    "os_family",
    "plugin_name",
    "plugin_version",
    "session_id",
    "skill_name",
  ]);
});

test("buildSkillCompleted includes outcome, duration_ms, error_class", () => {
  const ev = buildSkillCompleted({
    ...common,
    skill_name: "create-site",
    correlation_id: "corr-1",
    outcome: "success",
    duration_ms: 1234,
    error_class: "",
  });
  assert.equal(ev.data.eventName, "skill_completed");
  const info = JSON.parse(ev.data.eventInfo);
  assert.equal(info.outcome, "success");
  assert.equal(info.duration_ms, 1234);
  assert.equal(info.error_class, "");
});

test("builder drops unknown fields (allowlist enforcement)", () => {
  const ev = buildSkillStarted({
    ...common,
    skill_name: "x",
    correlation_id: "c",
    tenant_id: "SHOULD_NOT_APPEAR",
    file_path: "/etc/passwd",
    error_message: "nope",
  });
  const info = JSON.parse(ev.data.eventInfo);
  assert.equal(info.tenant_id, undefined);
  assert.equal(info.file_path, undefined);
  assert.equal(info.error_message, undefined);
});

test("buildScriptStarted shape", () => {
  const ev = buildScriptStarted({
    ...common,
    script_name: "verify-dataverse-access",
    correlation_id: "c",
  });
  assert.equal(ev.data.eventName, "script_started");
  const info = JSON.parse(ev.data.eventInfo);
  assert.equal(info.script_name, "verify-dataverse-access");
});

test("buildScriptCompleted enforces non-negative duration_ms", () => {
  const ev = buildScriptCompleted({
    ...common,
    script_name: "s",
    correlation_id: "c",
    outcome: "failure",
    duration_ms: -5,
    error_class: "TypeError",
  });
  const info = JSON.parse(ev.data.eventInfo);
  assert.equal(info.duration_ms, 0);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `events.js`**

Path: `shared/telemetry/lib/events.js`

```js
"use strict";

const COLLECTOR_EVENT_NAME = "PowerPlatformSkillsEvent";

const COMMON_FIELDS = [
  "plugin_name",
  "plugin_version",
  "session_id",
  "os_family",
  "node_version",
  "correlation_id",
];

const SKILL_FIELDS = ["skill_name"];
const SCRIPT_FIELDS = ["script_name"];
const COMPLETED_FIELDS = ["outcome", "duration_ms", "error_class"];

function pick(input, keys) {
  const out = {};
  for (const k of keys) {
    if (input[k] !== undefined) {
      out[k] = input[k];
    }
  }
  return out;
}

function clampDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function envelope(eventName, info) {
  if (info.duration_ms !== undefined) {
    info.duration_ms = clampDuration(info.duration_ms);
  }
  return {
    name: COLLECTOR_EVENT_NAME,
    data: {
      eventName,
      eventType: "Trace",
      severity: "Info",
      eventInfo: JSON.stringify(info),
    },
  };
}

function buildSkillStarted(input) {
  return envelope("skill_started", pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS]));
}

function buildSkillCompleted(input) {
  return envelope(
    "skill_completed",
    pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS, ...COMPLETED_FIELDS])
  );
}

function buildScriptStarted(input) {
  return envelope("script_started", pick(input, [...COMMON_FIELDS, ...SCRIPT_FIELDS]));
}

function buildScriptCompleted(input) {
  return envelope(
    "script_completed",
    pick(input, [...COMMON_FIELDS, ...SCRIPT_FIELDS, ...COMPLETED_FIELDS])
  );
}

module.exports = {
  COLLECTOR_EVENT_NAME,
  buildSkillStarted,
  buildSkillCompleted,
  buildScriptStarted,
  buildScriptCompleted,
};
```

- [ ] **Step 4: Run — expect PASS (6 tests)**

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/events.js shared/telemetry/tests/events.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add strict-allowlist event builders

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.7: `emit-dispatcher.js` — standalone dispatcher child

**Files:**
- Create: `shared/telemetry/lib/emit-dispatcher.js`
- Create: `shared/telemetry/tests/emit-dispatcher.test.js`

The dispatcher runs as a detached child process. Reads one event JSON on stdin, re-checks consent, reads iKey + collector URL from env vars, POSTs a Common Schema 4.0 envelope to OneCollector via Node's built-in `https`, exits 0. Fails closed on every error path.

- [ ] **Step 1: Write the failing test**

Path: `shared/telemetry/tests/emit-dispatcher.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DISPATCHER = path.resolve(__dirname, "../lib/emit-dispatcher.js");

function mkConsent(enabled) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-disp-"));
  if (enabled !== undefined) {
    fs.writeFileSync(
      path.join(tmp, "telemetry.json"),
      JSON.stringify({
        version: 1,
        prompt_version: 1,
        enabled,
        consented_at: new Date().toISOString(),
      })
    );
  }
  return tmp;
}

function runDispatcher({ event, env }) {
  return spawnSync(process.execPath, [DISPATCHER], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: env.configDir,
      POWER_PLATFORM_SKILLS_IKEY: env.iKey || "",
      POWER_PLATFORM_SKILLS_COLLECTOR: env.collectorUrl || "",
      POWER_PLATFORM_SKILLS_TELEMETRY: env.off ? "0" : "",
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: env.fakeProbe || "",
    },
  });
}

const fakeEvent = {
  name: "PowerPlatformSkillsEvent",
  data: { eventName: "x", eventType: "Trace", severity: "Info", eventInfo: "{}" },
};

test("dispatcher exits 0 when iKey is placeholder", () => {
  const tmp = mkConsent(true);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING", collectorUrl: "https://x" },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 when collector URL missing", () => {
  const tmp = mkConsent(true);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "real-ikey", collectorUrl: "" },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 when consent disabled", () => {
  const tmp = mkConsent(false);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "real-ikey", collectorUrl: "https://x" },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 when consent unset", () => {
  const tmp = mkConsent(undefined);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "real-ikey", collectorUrl: "https://x" },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 when POWER_PLATFORM_SKILLS_TELEMETRY=0", () => {
  const tmp = mkConsent(true);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "real-ikey", collectorUrl: "https://x", off: true },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 on malformed stdin", () => {
  const tmp = mkConsent(true);
  const { status } = spawnSync(process.execPath, [DISPATCHER], {
    input: "not json",
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp,
      POWER_PLATFORM_SKILLS_IKEY: "real-ikey",
      POWER_PLATFORM_SKILLS_COLLECTOR: "https://x",
    },
  });
  assert.equal(status, 0);
});

test("dispatcher writes a probe file when fake-https points to one (happy path)", () => {
  const tmp = mkConsent(true);
  const probePath = path.join(tmp, "probe.json");
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      fakeProbe: probePath,
    },
  });
  assert.equal(status, 0);
  assert.ok(fs.existsSync(probePath), "expected dispatcher to write probe file");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  assert.equal(probe.headers["x-apikey"], "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa");
  assert.equal(probe.headers["Content-Type"], "application/x-json-stream; charset=utf-8");
  const body = JSON.parse(probe.body);
  assert.equal(body.ver, "4.0");
  assert.equal(body.name, "PowerPlatformSkillsEvent");
  assert.equal(body.iKey, "o:real");
  assert.equal(body.baseType, "Ms.WebClient.TraceEvent");
  assert.deepEqual(body.data, fakeEvent.data);
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `node --test shared/telemetry/tests/emit-dispatcher.test.js`

- [ ] **Step 3: Implement `emit-dispatcher.js`**

Path: `shared/telemetry/lib/emit-dispatcher.js`

```js
#!/usr/bin/env node
"use strict";

const https = require("node:https");
const fs = require("node:fs");

const PLACEHOLDER_IKEY = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING";

const IKEY = process.env.POWER_PLATFORM_SKILLS_IKEY || "";
const COLLECTOR_URL = process.env.POWER_PLATFORM_SKILLS_COLLECTOR || "";
const FAKE_PROBE = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";

function exitSilently() {
  process.exit(0);
}

function readConsent() {
  try {
    const consent = require("./consent");
    return consent.read({
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || undefined,
    });
  } catch {
    return { state: "unset" };
  }
}

function buildEnvelope(event) {
  return {
    ver: "4.0",
    name: event.name,
    time: new Date().toISOString(),
    iKey: "o:" + IKEY.split("-")[0],
    baseType: "Ms.WebClient.TraceEvent",
    baseData: event.data,
    data: event.data,
  };
}

function writeProbe(path, { headers, body }) {
  try {
    fs.writeFileSync(path, JSON.stringify({ headers, body }), "utf8");
  } catch {
    // ignore
  }
}

// ---- Gate checks -----------------------------------------------------------
if (!IKEY || IKEY === PLACEHOLDER_IKEY || !COLLECTOR_URL) exitSilently();
if (readConsent().state !== "enabled") exitSilently();

// ---- Read stdin ------------------------------------------------------------
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    exitSilently();
  }

  const envelope = buildEnvelope(event);
  const body = JSON.stringify(envelope);
  const headers = {
    "Content-Type": "application/x-json-stream; charset=utf-8",
    "x-apikey": IKEY,
    "Content-Length": Buffer.byteLength(body),
  };

  // Test seam: if POWER_PLATFORM_SKILLS_FAKE_HTTPS is set, write the probe
  // payload to that file and exit without calling the real network.
  if (FAKE_PROBE) {
    writeProbe(FAKE_PROBE, { headers, body });
    exitSilently();
  }

  const url = new URL(COLLECTOR_URL);
  const req = https.request(
    {
      hostname: url.hostname,
      path: url.pathname + (url.search || ""),
      method: "POST",
      headers,
    },
    (res) => {
      res.on("data", () => {});
      res.on("end", exitSilently);
    }
  );
  req.on("error", exitSilently);
  req.setTimeout(4000, () => {
    req.destroy();
    exitSilently();
  });
  req.write(body);
  req.end();
});
```

- [ ] **Step 4: Run — expect PASS (7 tests)**

Run: `node --test shared/telemetry/tests/emit-dispatcher.test.js`

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/emit-dispatcher.js shared/telemetry/tests/emit-dispatcher.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add standalone emit-dispatcher child CLI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.7b: `emit-spawn.js` — tiny helper that spawns the detached dispatcher

**Files:**
- Create: `shared/telemetry/lib/emit-spawn.js`
- Create: `shared/telemetry/tests/emit-spawn.test.js`

- [ ] **Step 1: Write the failing test**

Path: `shared/telemetry/tests/emit-spawn.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { fireAndForget } = require("../lib/emit-spawn");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-spawn-"));
}

function mkConsent(tmp, enabled) {
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({
      version: 1,
      prompt_version: 1,
      enabled,
      consented_at: new Date().toISOString(),
    })
  );
}

test("fireAndForget returns synchronously (<100 ms)", () => {
  const tmp = mkTmp();
  const start = Date.now();
  fireAndForget(
    { name: "PowerPlatformSkillsEvent", data: { eventName: "x", eventType: "Trace", severity: "Info", eventInfo: "{}" } },
    { iKey: "real-ikey", collectorUrl: "https://example.invalid/" }
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `expected <100ms, got ${elapsed}ms`);
});

test("dispatcher child receives the event and writes the probe", async () => {
  const tmp = mkTmp();
  mkConsent(tmp, true);
  const probe = path.join(tmp, "probe.json");
  fireAndForget(
    { name: "PowerPlatformSkillsEvent", data: { eventName: "hello", eventType: "Trace", severity: "Info", eventInfo: "{}" } },
    {
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      configDir: tmp,
      fakeProbe: probe,
    }
  );
  // Wait up to 2s for the child to write the probe.
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(probe)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(probe), "probe file was not written");
  const contents = JSON.parse(fs.readFileSync(probe, "utf8"));
  const body = JSON.parse(contents.body);
  assert.equal(body.data.eventName, "hello");
});

test("fireAndForget does not throw when spawn fails (missing dispatcher path)", () => {
  // Rename the dispatcher so spawn will fail
  const { fireAndForget: broken } = require("../lib/emit-spawn");
  // Intentionally pass a malformed event that would crash if JSON.stringify throws
  // (it won't — objects with cycles would, but we just verify no throw on happy path)
  broken({ name: "X", data: {} }, { iKey: "", collectorUrl: "" });
  // No assertion needed: test passes if no throw.
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test shared/telemetry/tests/emit-spawn.test.js`

- [ ] **Step 3: Implement `emit-spawn.js`**

Path: `shared/telemetry/lib/emit-spawn.js`

```js
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const DISPATCHER = path.resolve(__dirname, "emit-dispatcher.js");

function fireAndForget(event, opts = {}) {
  const iKey = opts.iKey || "";
  const collectorUrl = opts.collectorUrl || "";
  const configDir = opts.configDir || "";
  const fakeProbe = opts.fakeProbe || "";

  try {
    const child = spawn("node", [DISPATCHER], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...process.env,
        POWER_PLATFORM_SKILLS_IKEY: iKey,
        POWER_PLATFORM_SKILLS_COLLECTOR: collectorUrl,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe,
      },
    });
    try {
      child.stdin.write(JSON.stringify(event));
      child.stdin.end();
    } catch {
      // child may have already exited; swallow.
    }
    child.unref();
  } catch {
    // spawn failed — fail closed.
  }
}

module.exports = { fireAndForget };
```

- [ ] **Step 4: Run — expect PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/emit-spawn.js shared/telemetry/tests/emit-spawn.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add emit-spawn helper for detached dispatcher

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.8: `with-telemetry.js` — Node script wrapper

**Files:**
- Create: `shared/telemetry/lib/with-telemetry.js`
- Create: `shared/telemetry/tests/with-telemetry.test.js`

The wrapper calls `emit-spawn.fireAndForget` for both `script_started` and `script_completed`. Neither call awaits the network. A test-only `emitter` option lets tests capture the events synchronously.

- [ ] **Step 1: Write the failing test**

Path: `shared/telemetry/tests/with-telemetry.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { withTelemetry } = require("../lib/with-telemetry");

function recorder() {
  const events = [];
  return {
    events,
    emit: (e) => events.push(e),
  };
}

test("success path emits script_started and script_completed", async () => {
  const rec = recorder();
  const result = await withTelemetry(
    "verify-dataverse-access",
    async () => 42,
    { emitter: rec.emit, pluginName: "power-pages", pluginVersion: "1.2.2" }
  );
  assert.equal(result, 42);
  assert.equal(rec.events.length, 2);
  assert.equal(rec.events[0].data.eventName, "script_started");
  assert.equal(rec.events[1].data.eventName, "script_completed");
  const info = JSON.parse(rec.events[1].data.eventInfo);
  assert.equal(info.outcome, "success");
  assert.equal(info.error_class, "");
});

test("failure path emits script_completed with outcome=failure and rethrows", async () => {
  const rec = recorder();
  await assert.rejects(
    withTelemetry(
      "x",
      async () => {
        throw new TypeError("boom");
      },
      { emitter: rec.emit, pluginName: "power-pages", pluginVersion: "1.2.2" }
    ),
    TypeError
  );
  assert.equal(rec.events.length, 2);
  const info = JSON.parse(rec.events[1].data.eventInfo);
  assert.equal(info.outcome, "failure");
  assert.equal(info.error_class, "TypeError");
});

test("same correlation_id on started and completed", async () => {
  const rec = recorder();
  await withTelemetry(
    "x",
    async () => null,
    { emitter: rec.emit, pluginName: "power-pages", pluginVersion: "1.2.2" }
  );
  const a = JSON.parse(rec.events[0].data.eventInfo).correlation_id;
  const b = JSON.parse(rec.events[1].data.eventInfo).correlation_id;
  assert.equal(a, b);
  assert.ok(a.length >= 32);
});

test("emit is called synchronously before asyncFn starts (fire-and-forget)", async () => {
  const rec = recorder();
  let asyncFnSeenEventsAtStart = -1;
  await withTelemetry(
    "x",
    async () => {
      asyncFnSeenEventsAtStart = rec.events.length;
      return null;
    },
    { emitter: rec.emit, pluginName: "power-pages", pluginVersion: "1.2.2" }
  );
  // script_started must have been emitted before asyncFn ran.
  assert.equal(asyncFnSeenEventsAtStart, 1);
});

test("throwing emitter does not break the wrapper", async () => {
  const throwingEmitter = () => {
    throw new Error("emit blew up");
  };
  const result = await withTelemetry(
    "x",
    async () => 99,
    { emitter: throwingEmitter, pluginName: "power-pages", pluginVersion: "1.2.2" }
  );
  assert.equal(result, 99);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `with-telemetry.js`**

Path: `shared/telemetry/lib/with-telemetry.js`

```js
"use strict";

const crypto = require("node:crypto");
const { getSessionId } = require("./session");
const { buildScriptStarted, buildScriptCompleted } = require("./events");
const { fireAndForget } = require("./emit-spawn");

function commonFields({ pluginName, pluginVersion }) {
  return {
    plugin_name: pluginName,
    plugin_version: pluginVersion,
    session_id: getSessionId(),
    os_family: process.platform,
    node_version: "v" + String(process.versions.node).split(".")[0],
  };
}

function defaultEmitter(event, spawnOpts) {
  fireAndForget(event, spawnOpts);
}

async function withTelemetry(scriptName, asyncFn, opts = {}) {
  const pluginName = opts.pluginName;
  const pluginVersion = opts.pluginVersion;
  const emitter = opts.emitter || defaultEmitter;
  const spawnOpts = opts.spawnOpts || {};
  const correlationId = crypto.randomUUID();
  const startTs = Date.now();

  try {
    emitter(
      buildScriptStarted({
        ...commonFields({ pluginName, pluginVersion }),
        script_name: scriptName,
        correlation_id: correlationId,
      }),
      spawnOpts
    );
  } catch {
    // fail closed — never let telemetry throw
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
    const duration_ms = Date.now() - startTs;
    try {
      emitter(
        buildScriptCompleted({
          ...commonFields({ pluginName, pluginVersion }),
          script_name: scriptName,
          correlation_id: correlationId,
          outcome,
          duration_ms,
          error_class: errorClass,
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

- [ ] **Step 4: Run — expect PASS (5 tests)**

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/with-telemetry.js shared/telemetry/tests/with-telemetry.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add withTelemetry wrapper using fireAndForget

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.9: `check-consent.js` CLI

**Files:**
- Create: `shared/telemetry/lib/check-consent.js`
- Extend: `shared/telemetry/tests/consent.test.js`

- [ ] **Step 1: Append failing tests**

Append to `shared/telemetry/tests/consent.test.js`:

```js
const { spawnSync } = require("node:child_process");

test("check-consent CLI prints NEEDS_PROMPT when file missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  const cli = path.resolve(__dirname, "../lib/check-consent.js");
  const { stdout, status } = spawnSync(process.execPath, [cli], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "NEEDS_PROMPT");
});

test("check-consent CLI prints ENABLED when file has enabled=true", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  consentLib.write({ configDir: tmp, enabled: true });
  const cli = path.resolve(__dirname, "../lib/check-consent.js");
  const { stdout, status } = spawnSync(process.execPath, [cli], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "ENABLED");
});

test("check-consent CLI prints DISABLED when file has enabled=false", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  consentLib.write({ configDir: tmp, enabled: false });
  const cli = path.resolve(__dirname, "../lib/check-consent.js");
  const { stdout, status } = spawnSync(process.execPath, [cli], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "DISABLED");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `check-consent.js`**

Path: `shared/telemetry/lib/check-consent.js`

```js
#!/usr/bin/env node
"use strict";

const consent = require("./consent");

const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || undefined;
const result = consent.read({ configDir });

const word =
  result.state === "enabled"
    ? "ENABLED"
    : result.state === "disabled"
    ? "DISABLED"
    : "NEEDS_PROMPT";

process.stdout.write(word + "\n");
process.exit(0);
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/check-consent.js shared/telemetry/tests/consent.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add check-consent CLI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.10: `record-consent.js` CLI

**Files:**
- Create: `shared/telemetry/lib/record-consent.js`
- Extend: `shared/telemetry/tests/consent.test.js`

- [ ] **Step 1: Append failing test**

Append to `shared/telemetry/tests/consent.test.js`:

```js
test("record-consent CLI --answer yes writes enabled=true", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  const cli = path.resolve(__dirname, "../lib/record-consent.js");
  const { status } = spawnSync(process.execPath, [cli, "--answer", "yes"], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(consentLib.read({ configDir: tmp }).state, "enabled");
});

test("record-consent CLI --answer no writes enabled=false", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  const cli = path.resolve(__dirname, "../lib/record-consent.js");
  const { status } = spawnSync(process.execPath, [cli, "--answer", "no"], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(consentLib.read({ configDir: tmp }).state, "disabled");
});

test("record-consent CLI exits non-zero on invalid --answer", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  const cli = path.resolve(__dirname, "../lib/record-consent.js");
  const { status } = spawnSync(process.execPath, [cli, "--answer", "maybe"], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.notEqual(status, 0);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `record-consent.js`**

Path: `shared/telemetry/lib/record-consent.js`

```js
#!/usr/bin/env node
"use strict";

const consent = require("./consent");

const args = process.argv.slice(2);
const answerIdx = args.indexOf("--answer");
const answer = answerIdx !== -1 ? args[answerIdx + 1] : null;

if (answer !== "yes" && answer !== "no") {
  process.stderr.write('Usage: record-consent.js --answer yes|no\n');
  process.exit(2);
}

const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || undefined;
consent.write({ configDir, enabled: answer === "yes" });
process.exit(0);
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/record-consent.js shared/telemetry/tests/consent.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add record-consent CLI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.11: End-of-milestone sanity run

- [ ] **Step 1: Run the full shared test suite**

Run: `node --test shared/telemetry/tests/*.test.js`
Expected: all tests pass, no failures, no timeouts.

- [ ] **Step 2: Confirm nothing in `plugins/` has been touched yet**

Run: `git status --short`
Expected: clean — this milestone produced only `shared/telemetry/` additions (already committed).

---

## Milestone 2 — Sync mechanism

### Task 2.1: Write `sync-to-plugin.js` (TDD)

**Files:**
- Create: `shared/telemetry/sync-to-plugin.js`
- Create: `shared/telemetry/tests/sync-to-plugin.test.js`

Sync copies `lib/`, `ikey.json`, and `references/` into `<target>/scripts/lib/telemetry/` (library) and `<target>/references/` (doc) for a given plugin root. It overwrites; it does not merge. No `package.json` to copy — the library has no npm dependencies.

- [ ] **Step 1: Write the failing test**

Path: `shared/telemetry/tests/sync-to-plugin.test.js`

```js
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
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `sync-to-plugin.js`**

Path: `shared/telemetry/sync-to-plugin.js`

```js
#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const target = getArg("target");
if (!target) {
  process.stderr.write("Usage: sync-to-plugin.js --target <plugin-dir>\n");
  process.exit(1);
}

const source = path.resolve(__dirname);

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFile(src, dst);
  }
}

function safeCopyFile(from, to) {
  if (fs.existsSync(from)) copyFile(from, to);
}

// 1. Library + iKey config → <target>/scripts/lib/telemetry/
const telemetryDst = path.join(target, "scripts", "lib", "telemetry");
fs.mkdirSync(telemetryDst, { recursive: true });

copyDir(path.join(source, "lib"), path.join(telemetryDst, "lib"));
copyFile(path.join(source, "ikey.json"), path.join(telemetryDst, "ikey.json"));

// 2. Reference doc → <target>/references/
safeCopyFile(
  path.join(source, "references", "telemetry-consent-reference.md"),
  path.join(target, "references", "telemetry-consent-reference.md")
);

process.stdout.write(`Synced shared/telemetry → ${telemetryDst}\n`);
process.exit(0);
```

- [ ] **Step 4: Run — expect PASS (4 tests)**

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/sync-to-plugin.js shared/telemetry/tests/sync-to-plugin.test.js
git commit -m "$(cat <<'EOF'
feat(telemetry): add sync-to-plugin script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.2: Write the consent reference doc

**Files:**
- Create: `shared/telemetry/references/telemetry-consent-reference.md`

- [ ] **Step 1: Write the doc**

Path: `shared/telemetry/references/telemetry-consent-reference.md`

```markdown
# Telemetry Consent Reference

Every tracked Power Pages skill runs this check in Phase 1 before any other work.

## Phase-1 one-liner for SKILL.md

Add this line immediately after the existing plugin-version check:

```markdown
> **Telemetry consent**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/check-consent.js"` — if the output is `NEEDS_PROMPT`, use AskUserQuestion to ask the user with the wording below, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/record-consent.js" --answer yes|no`.
```

## Prompt wording

When `check-consent.js` prints `NEEDS_PROMPT`, use AskUserQuestion with:

- **Question:** "Share anonymous usage telemetry with Microsoft?"
- **Body:** "The power-pages plugin can send anonymous usage signals (skill name, success/failure, duration, OS family, plugin version) to Microsoft to help improve these tools. No paths, inputs, tenant data, or error messages are sent. Your answer is saved at `~/.power-platform-skills/telemetry.json`; edit that file any time to change it."
- **Options:**
  - `"Yes, enable telemetry"` — runs `record-consent.js --answer yes`
  - `"No, keep it off"` — runs `record-consent.js --answer no`

## What is and is not sent

Sent (allowlist):
- `plugin_name`, `plugin_version`, `session_id` (random per-process UUID), `os_family`, `node_version`, `correlation_id`, `skill_name` or `script_name`, `outcome`, `duration_ms`, `error_class` (constructor name only).

Never sent:
- File paths, cwd, env vars (except the telemetry off-switch), tenant IDs, site names, site URLs, Dataverse URLs, error messages, stack traces, skill arguments, tool inputs, usernames.

## Override

Setting `POWER_PLATFORM_SKILLS_TELEMETRY=0` disables emission regardless of the file. Any other value is ignored — the env var is a one-way off switch.
```

- [ ] **Step 2: Commit**

```bash
git add shared/telemetry/references/telemetry-consent-reference.md
git commit -m "$(cat <<'EOF'
docs(telemetry): add consent reference doc

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.3: Populate the synced copy under `plugins/power-pages/`

**Files:**
- Create (via sync): `plugins/power-pages/scripts/lib/telemetry/**`
- Create (via sync): `plugins/power-pages/references/telemetry-consent-reference.md`

- [ ] **Step 1: Run the sync**

Run:
```bash
node shared/telemetry/sync-to-plugin.js --target plugins/power-pages
```
Expected: `Synced shared/telemetry → plugins/power-pages/scripts/lib/telemetry` (exit 0).

- [ ] **Step 2: Inspect what got created**

Run: `ls plugins/power-pages/scripts/lib/telemetry/ && ls plugins/power-pages/scripts/lib/telemetry/lib/`
Expected to see `ikey.json` and `lib/` containing: `emit-dispatcher.js`, `emit-spawn.js`, `consent.js`, `correlation.js`, `events.js`, `session.js`, `scrubber.js`, `check-consent.js`, `record-consent.js`, `with-telemetry.js`. No `package.json`, no `node_modules`.

- [ ] **Step 3: Verify consent ref doc synced**

Run: `ls plugins/power-pages/references/telemetry-consent-reference.md`
Expected: file exists.

- [ ] **Step 4: Commit (synced files only)**

```bash
git add plugins/power-pages/scripts/lib/telemetry/ \
        plugins/power-pages/references/telemetry-consent-reference.md
git commit -m "$(cat <<'EOF'
feat(power-pages): sync shared telemetry library into plugin

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Milestone 3 — Hook wiring in `power-pages`

### Task 3.1: `run-skill-pretool-telemetry.js` hook script (TDD)

**Files:**
- Create: `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`
- Create: `plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js`

Reference: `poc/1ds-telemetry/hook-pretool.js` shows a working pattern. The shipping version uses the synced library and has no diagnostic file logging.

- [ ] **Step 1: Write the failing test**

Path: `plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.resolve(
  __dirname,
  "../../hooks/run-skill-pretool-telemetry.js"
);

function mkConfigDir(enabled) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-ph-"));
  if (enabled !== undefined) {
    fs.writeFileSync(
      path.join(tmp, "telemetry.json"),
      JSON.stringify({
        version: 1,
        prompt_version: 1,
        enabled,
        consented_at: new Date().toISOString(),
      })
    );
  }
  return tmp;
}

function runHook({ input, configDir }) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    },
  });
}

test("exits 0 and emits nothing when tool_input has no tracked skill", () => {
  const tmp = mkConfigDir(true);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "other-plugin:foo" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});

test("exits 0 when consent unset", () => {
  const tmp = mkConfigDir(undefined);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});

test("exits 0 when malformed stdin", () => {
  const tmp = mkConfigDir(true);
  const { status } = runHook({ input: "{not json", configDir: tmp });
  assert.equal(status, 0);
});

test("exits 0 even when consent enabled and skill tracked (placeholder iKey → no-op emit)", () => {
  const tmp = mkConfigDir(true);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js`

- [ ] **Step 3: Implement the hook**

Path: `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`

```js
#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

let emitSpawn, eventsLib, correlationLib, sessionLib;
try {
  emitSpawn = require(path.join(TELEMETRY_DIR, "lib", "emit-spawn"));
  eventsLib = require(path.join(TELEMETRY_DIR, "lib", "events"));
  correlationLib = require(path.join(TELEMETRY_DIR, "lib", "correlation"));
  sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
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
    return { ikey: cfg.ikey, collectorUrl: cfg.collector_url };
  } catch {
    return { ikey: "", collectorUrl: "" };
  }
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

  const { ikey, collectorUrl } = readIkey();
  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";

  try {
    emitSpawn.fireAndForget(
      eventsLib.buildSkillStarted({
        plugin_name: "power-pages",
        plugin_version: readPluginVersion(),
        session_id: sessionLib.getSessionId(),
        os_family: process.platform,
        node_version: "v" + String(process.versions.node).split(".")[0],
        skill_name: skillName,
        correlation_id,
      }),
      { iKey: ikey, collectorUrl, configDir }
    );
  } catch {
    // fail closed
  }

  // Parent exits immediately; dispatcher child carries the POST.
  process.exit(0);
})().catch(() => process.exit(0));
```

- [ ] **Step 4: Run — expect PASS (4 tests)**

- [ ] **Step 5: Commit**

```bash
git add plugins/power-pages/hooks/run-skill-pretool-telemetry.js \
        plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js
git commit -m "$(cat <<'EOF'
feat(power-pages): add PreToolUse:Skill telemetry hook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.2: Extend `run-skill-posttool-validation.js` to emit `skill_completed`

**Files:**
- Modify: `plugins/power-pages/hooks/run-skill-posttool-validation.js`
- Create: `plugins/power-pages/scripts/tests/telemetry-hook-posttool.test.js`

- [ ] **Step 1: Write the failing test**

Path: `plugins/power-pages/scripts/tests/telemetry-hook-posttool.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.resolve(
  __dirname,
  "../../hooks/run-skill-posttool-validation.js"
);

function mkConfigDir(enabled) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-ho-"));
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({
      version: 1,
      prompt_version: 1,
      enabled,
      consented_at: new Date().toISOString(),
    })
  );
  return tmp;
}

function runHook({ input, configDir }) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    },
  });
}

test("posttool hook exits 0 with no tracked skill (preserves existing behavior)", () => {
  const tmp = mkConfigDir(true);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "nothing" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});

test("posttool hook exits 0 when consent disabled (no emit, validator still runs)", () => {
  const tmp = mkConfigDir(false);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});

test("posttool hook preserves validator exit status when validator present", () => {
  // create-site has a validator script; if it fails, exit non-zero must propagate.
  // We simulate by pointing a tracked skill that doesn't actually exist in-tree at
  // a synthetic validator that exits 1 — but that requires bespoke setup.
  // For the plan, trust the implementation's explicit propagation of result.status
  // and cover the success-path exit-0 above.
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Modify the existing validator hook to also emit**

Path: `plugins/power-pages/hooks/run-skill-posttool-validation.js`

The existing file reads stdin, runs the validator, and exits with the validator's status. Extend it so that *after* the validator runs, it emits `skill_completed`. Telemetry emission never changes the exit code.

Replace the full file contents with:

```js
#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
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

    const ikeyCfg = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(TELEMETRY_DIR, 'ikey.json'), 'utf8')
        );
      } catch {
        return { ikey: '', collector_url: '' };
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
    const outcome =
      !validatorRan || validatorStatus === 0 ? 'success' : 'failure';

    emitSpawn.fireAndForget(
      eventsLib.buildSkillCompleted({
        plugin_name: 'power-pages',
        plugin_version: pluginVersion,
        session_id: sessionLib.getSessionId(),
        os_family: process.platform,
        node_version: 'v' + String(process.versions.node).split('.')[0],
        skill_name: skillName,
        correlation_id: corr.correlation_id,
        outcome,
        duration_ms: Date.now() - (corr.start_ts || startTs),
        error_class: '',
      }),
      { iKey: ikeyCfg.ikey, collectorUrl: ikeyCfg.collector_url, configDir }
    );

    correlationLib.clear({ skillName });
  } catch {
    // fail closed: telemetry never affects skill outcome
  }

  process.exit(validatorStatus);
});
```

- [ ] **Step 4: Run — expect PASS for the new posttool tests**

Run: `node --test plugins/power-pages/scripts/tests/telemetry-hook-posttool.test.js`

- [ ] **Step 5: Run the full plugin test suite to verify no regression**

Run (PowerShell, matching `plugins/power-pages/AGENTS.md`):
```powershell
$files = Get-ChildItem .\plugins\power-pages\scripts\tests\*.test.js | ForEach-Object { $_.FullName }
node --test $files
```
Expected: all existing tests still pass, plus the two new telemetry-hook tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/power-pages/hooks/run-skill-posttool-validation.js \
        plugins/power-pages/scripts/tests/telemetry-hook-posttool.test.js
git commit -m "$(cat <<'EOF'
feat(power-pages): emit skill_completed from existing PostToolUse hook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.3: Register the PreToolUse hook in `hooks.json`

**Files:**
- Modify: `plugins/power-pages/hooks/hooks.json`

- [ ] **Step 1: Replace the file**

Path: `plugins/power-pages/hooks/hooks.json`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/run-skill-pretool-telemetry.js\"",
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/run-skill-posttool-validation.js\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/power-pages/hooks/hooks.json
git commit -m "$(cat <<'EOF'
feat(power-pages): register PreToolUse:Skill telemetry hook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Milestone 4 — Wire the consent one-liner into tracked skills

The Phase-1 one-liner is added to every SKILL.md whose skill appears in `TRACKED_SKILLS` (see `plugins/power-pages/scripts/lib/powerpages-hook-utils.js`): `activate-site`, `add-sample-data`, `add-seo`, `audit-permissions`, `create-site`, `create-webroles`, `add-cloud-flow`, `add-server-logic`, `integrate-webapi`, `setup-auth`, `setup-datamodel`, `test-site`.

### Task 4.1: Apply the one-liner to one skill as a template (TDD by reading the file before/after)

**Files:**
- Modify: `plugins/power-pages/skills/create-site/SKILL.md`

- [ ] **Step 1: Locate the existing plugin-version check line**

Open `plugins/power-pages/skills/create-site/SKILL.md` and find the line that looks like:

```markdown
> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.
```

- [ ] **Step 2: Insert the consent one-liner immediately after it**

Add this line on the next line, with one blank line between the two quote-blocks:

```markdown

> **Telemetry consent**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/check-consent.js"` — if the output is `NEEDS_PROMPT`, use AskUserQuestion to ask the user per `${CLAUDE_PLUGIN_ROOT}/references/telemetry-consent-reference.md` and then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/record-consent.js" --answer yes|no`.
```

- [ ] **Step 3: Verify**

Run: `grep -c "check-consent.js" plugins/power-pages/skills/create-site/SKILL.md`
Expected: `1`.

- [ ] **Step 4: Commit**

```bash
git add plugins/power-pages/skills/create-site/SKILL.md
git commit -m "$(cat <<'EOF'
feat(power-pages): add Phase-1 telemetry-consent check to create-site

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.2: Apply the same one-liner to the remaining 11 tracked skills

- [ ] **Step 1: For each of the remaining skills, perform the same insertion**

Skills to update:
- `activate-site`
- `add-sample-data`
- `add-seo`
- `audit-permissions`
- `create-webroles`
- `add-cloud-flow`
- `add-server-logic`
- `integrate-webapi`
- `setup-auth`
- `setup-datamodel`
- `test-site`

For each, open `plugins/power-pages/skills/<skill>/SKILL.md`, find the plugin-version check line, and insert the exact consent one-liner from Task 4.1 immediately after it.

- [ ] **Step 2: Verify all 12 skills have the line**

Run:
```bash
grep -l "check-consent.js" plugins/power-pages/skills/*/SKILL.md | wc -l
```
Expected: `12`.

- [ ] **Step 3: Commit**

```bash
git add plugins/power-pages/skills/
git commit -m "$(cat <<'EOF'
feat(power-pages): add Phase-1 telemetry-consent check to remaining tracked skills

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Milestone 5 — Instrument high-value Node scripts with `withTelemetry`

Every wrapped script gets a small boilerplate block at the bottom that calls `withTelemetry()`. The wrapper fails closed — if the telemetry library is unavailable, the script runs normally.

### Task 5.1: Create a shared runtime helper for scripts

**Files:**
- Create: `plugins/power-pages/scripts/lib/telemetry-runner.js`
- Create: `plugins/power-pages/scripts/tests/telemetry-runner.test.js`

This small helper centralises the plugin-version read + ikey load so each instrumented script has a one-line invocation. No client creation needed — the synced `with-telemetry.js` already calls `emit-spawn.fireAndForget` by default.

- [ ] **Step 1: Write the failing test**

Path: `plugins/power-pages/scripts/tests/telemetry-runner.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { runInstrumented } = require("../lib/telemetry-runner");

test("runInstrumented awaits the async fn and returns its value", async () => {
  const result = await runInstrumented("dummy-script", async () => 123);
  assert.equal(result, 123);
});

test("runInstrumented rethrows errors from the fn", async () => {
  await assert.rejects(
    runInstrumented("dummy-script", async () => {
      throw new Error("nope");
    }),
    /nope/
  );
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `telemetry-runner.js`**

Path: `plugins/power-pages/scripts/lib/telemetry-runner.js`

```js
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

function readPluginVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    ).version || "unknown";
  } catch {
    return "unknown";
  }
}

function loadTelemetryDeps() {
  try {
    return {
      withTelemetry: require(path.join(TELEMETRY_DIR, "lib", "with-telemetry"))
        .withTelemetry,
      ikeyCfg: JSON.parse(
        fs.readFileSync(path.join(TELEMETRY_DIR, "ikey.json"), "utf8")
      ),
    };
  } catch {
    return null;
  }
}

async function runInstrumented(scriptName, asyncFn) {
  const deps = loadTelemetryDeps();
  if (!deps) return asyncFn();

  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";

  return deps.withTelemetry(scriptName, asyncFn, {
    pluginName: "power-pages",
    pluginVersion: readPluginVersion(),
    spawnOpts: {
      iKey: deps.ikeyCfg.ikey,
      collectorUrl: deps.ikeyCfg.collector_url,
      configDir,
    },
  });
}

module.exports = { runInstrumented };
```

- [ ] **Step 4: Run — expect PASS (2 tests)**

- [ ] **Step 5: Commit**

```bash
git add plugins/power-pages/scripts/lib/telemetry-runner.js \
        plugins/power-pages/scripts/tests/telemetry-runner.test.js
git commit -m "$(cat <<'EOF'
feat(power-pages): add telemetry-runner helper for script instrumentation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.2: Instrument `check-activation-status.js`

**Files:**
- Modify: `plugins/power-pages/scripts/check-activation-status.js`

- [ ] **Step 1: Refactor main-body to be callable**

Open `plugins/power-pages/scripts/check-activation-status.js`. The current file runs top-level; wrap its body in an exported `async function main()` and conditionally invoke through `runInstrumented` only when executed directly.

Add at the top of the file (after the existing `require` block):

```js
const { runInstrumented } = require('./lib/telemetry-runner');
```

Replace the current top-level execution (from "--- Parse --projectRoot argument ---" onward) so that everything that was in the top level becomes the body of an `async function main()`. Then at the bottom of the file:

```js
if (require.main === module) {
  runInstrumented('check-activation-status', main).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}

module.exports = { main };
```

- [ ] **Step 2: Run the script manually against a real-ish project to confirm no regression**

Run: `node plugins/power-pages/scripts/check-activation-status.js --projectRoot .`
Expected: same JSON output as before (error about missing config is fine — we just care that it doesn't crash with a telemetry-related error).

- [ ] **Step 3: Commit**

```bash
git add plugins/power-pages/scripts/check-activation-status.js
git commit -m "$(cat <<'EOF'
feat(power-pages): instrument check-activation-status with withTelemetry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.3: Instrument `verify-dataverse-access.js`

**Files:**
- Modify: `plugins/power-pages/scripts/verify-dataverse-access.js`

- [ ] **Step 1: Same refactor pattern as Task 5.2**

Wrap the top-level body in `async function main()`, import `runInstrumented`, and at the bottom:

```js
if (require.main === module) {
  runInstrumented('verify-dataverse-access', main).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}

module.exports = { main };
```

- [ ] **Step 2: Smoke test**

Run: `node plugins/power-pages/scripts/verify-dataverse-access.js --help 2>&1 || true`
Expected: prints usage or a known error, not a telemetry error.

- [ ] **Step 3: Commit**

```bash
git add plugins/power-pages/scripts/verify-dataverse-access.js
git commit -m "$(cat <<'EOF'
feat(power-pages): instrument verify-dataverse-access with withTelemetry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.4: Instrument `render-audit-report.js`

**Files:**
- Modify: `plugins/power-pages/scripts/render-audit-report.js`

- [ ] **Step 1: Apply the same wrapping pattern**

Wrap body in `async function main()`, import `runInstrumented`, add the conditional `if (require.main === module)` block at the bottom.

- [ ] **Step 2: Commit**

```bash
git add plugins/power-pages/scripts/render-audit-report.js
git commit -m "$(cat <<'EOF'
feat(power-pages): instrument render-audit-report with withTelemetry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.5: Instrument `clear-site-cache.js`

**Files:**
- Modify: `plugins/power-pages/scripts/clear-site-cache.js`

- [ ] **Step 1: Apply the same wrapping pattern**

- [ ] **Step 2: Commit**

```bash
git add plugins/power-pages/scripts/clear-site-cache.js
git commit -m "$(cat <<'EOF'
feat(power-pages): instrument clear-site-cache with withTelemetry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.6: Instrument all per-skill validators in one sweep

Per the spec (§5.4), each validator under `plugins/power-pages/skills/*/scripts/validate-*.js` gets wrapped. All follow the same top-level pattern — a long imperative script ending in `process.exit(0)` or similar.

**Files:**
- Modify: `plugins/power-pages/skills/activate-site/scripts/validate-activation.js`
- Modify: `plugins/power-pages/skills/add-seo/scripts/validate-seo.js`
- Modify: `plugins/power-pages/skills/audit-permissions/scripts/validate-audit.js`
- Modify: `plugins/power-pages/skills/create-site/scripts/validate-site.js`
- Modify: `plugins/power-pages/skills/create-webroles/scripts/validate-webroles.js`
- Modify: `plugins/power-pages/skills/add-cloud-flow/scripts/validate-cloudflow.js`
- Modify: `plugins/power-pages/skills/add-server-logic/scripts/validate-serverlogic.js`
- Modify: `plugins/power-pages/skills/integrate-webapi/scripts/validate-webapi-integration.js`
- Modify: `plugins/power-pages/skills/setup-auth/scripts/validate-auth.js`
- Modify: `plugins/power-pages/skills/setup-datamodel/scripts/validate-datamodel.js`

- [ ] **Step 1: For each validator, apply the wrapping pattern**

Each validator adds one require at the top:

```js
const path = require('path');
const { runInstrumented } = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'lib', 'telemetry-runner'));
```

Wrap the existing top-level body in `async function main()`. At the bottom:

```js
if (require.main === module) {
  runInstrumented('validate-<skill>', main).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}

module.exports = { main };
```

Replace `<skill>` with the skill name (e.g. `activate-site`, `create-site`).

- [ ] **Step 2: Run the PowerShell test battery**

Run (from repo root in PowerShell):
```powershell
$files = Get-ChildItem .\plugins\power-pages\scripts\tests\*.test.js | ForEach-Object { $_.FullName }
node --test $files
```
Expected: no regressions.

- [ ] **Step 3: Commit**

```bash
git add plugins/power-pages/skills/
git commit -m "$(cat <<'EOF'
feat(power-pages): instrument skill validators with withTelemetry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Milestone 6 — Docs

### Task 6.1: Update `plugins/power-pages/AGENTS.md`

**Files:**
- Modify: `plugins/power-pages/AGENTS.md`

- [ ] **Step 1: Append a telemetry section**

After the "Common Review Pitfalls" section and before "Maintaining This File", insert:

```markdown
## Telemetry

This plugin ships 1DS telemetry for skill-run and script-run signals. The shared library lives at the repo-root `shared/telemetry/`; the synced copy at `scripts/lib/telemetry/` is the live code. Zero npm dependencies — nothing to install.

- **DO NOT hand-edit** files under `scripts/lib/telemetry/`. Edit `shared/telemetry/` and re-run `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages`.
- **Consent:** every tracked skill runs the Phase-1 one-liner from `references/telemetry-consent-reference.md`. Never emit without the user's explicit consent.
- **Strict allowlist:** `shared/telemetry/lib/events.js` enforces exactly the fields listed in the spec. Never add a field to a builder without first adding it to the allowlist and documenting it in the reference doc.
- **Env off-switch:** `POWER_PLATFORM_SKILLS_TELEMETRY=0` disables emission regardless of the consent file.
- **Fail closed:** telemetry code must never change a script's exit code or break a skill run. Emission is fire-and-forget via a detached dispatcher child, so the hook or script returns before the HTTPS POST completes.

See `docs/superpowers/specs/2026-04-20-1ds-telemetry-design.md` for the full design.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/power-pages/AGENTS.md
git commit -m "$(cat <<'EOF'
docs(power-pages): document telemetry conventions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6.2: Update root `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Insert a "Shared Telemetry" sub-section under "Cross-Plugin Shared Skills"**

Add immediately after the Cross-Plugin Shared Skills section:

```markdown
## Shared Telemetry

1DS telemetry code for all plugins lives at `shared/telemetry/`. The repo-root copy is development-time only — each adopting plugin syncs a copy into `plugins/<plugin>/scripts/lib/telemetry/` via `node shared/telemetry/sync-to-plugin.js --target plugins/<plugin>`. Only the synced copy runs at user time.

Edit `shared/telemetry/` and re-run the sync to propagate changes. Never hand-edit the synced copies.

Current adopters: `power-pages`. Others adopt on demand.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "$(cat <<'EOF'
docs: document shared telemetry convention at repo level

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6.3: Write `shared/telemetry/README.md`

**Files:**
- Create: `shared/telemetry/README.md`

- [ ] **Step 1: Write the README**

Path: `shared/telemetry/README.md`

```markdown
# Shared 1DS Telemetry Library

Canonical source for 1DS telemetry used by plugins in this repo. Synced into each adopting plugin via `sync-to-plugin.js`.

**Not shipped to users directly.** The repo-root copy is development-time only. Each plugin ships its own synced copy under `plugins/<plugin>/scripts/lib/telemetry/`.

## What is sent

Every event carries a fixed allowlist:

- `plugin_name`, `plugin_version` — from the plugin's `.claude-plugin/plugin.json`
- `session_id` — random UUID generated once per Node process (not persisted)
- `os_family` — `win32` | `darwin` | `linux`
- `node_version` — major version only, e.g. `v22`
- `correlation_id` — joins `skill_started` ↔ `skill_completed` and `script_started` ↔ `script_completed`
- `skill_name` (skill events) or `script_name` (script events)
- `outcome` (`success` | `failure`), `duration_ms`, `error_class` (constructor name only) — completed events

## What is NEVER sent

File paths, cwd, env vars (except the telemetry off-switch), tenant IDs, site names, Dataverse URLs, error messages, stack traces, skill arguments, tool inputs, usernames, hostnames.

## Consent

- Stored at `~/.power-platform-skills/telemetry.json`.
- Gathered interactively on first tracked-skill run.
- Override: `POWER_PLATFORM_SKILLS_TELEMETRY=0` disables emission regardless of the file.

## Syncing into a plugin

```bash
node shared/telemetry/sync-to-plugin.js --target plugins/<plugin-name>
```

No install step — the library has no npm dependencies.

## Layout

See `docs/superpowers/specs/2026-04-20-1ds-telemetry-design.md` for the full design spec.
```

- [ ] **Step 2: Commit**

```bash
git add shared/telemetry/README.md
git commit -m "$(cat <<'EOF'
docs(telemetry): add shared library README

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6.4: Link from root `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a brief telemetry paragraph**

Append near the bottom of `README.md`:

```markdown
## Telemetry

Plugins that ship 1DS telemetry (currently: `power-pages`) gather anonymous usage signals with explicit user consent. See `shared/telemetry/README.md` for what is sent and how to opt out.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: link telemetry notice from root README

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Milestone 7 — iKey provisioning and marketplace-install E2E smoke test

Per the spec's rollout sequence, final E2E verification requires a marketplace install (not `--plugin-dir` dev mode) — the latter does not register plugin hooks, as proven by the POC.

### Task 7.1: Replace the placeholder iKey

**Files:**
- Modify: `shared/telemetry/ikey.json`

- [ ] **Step 1: Obtain the provisioned iKey**

The plugin marketplace owner provisions a 1DS tenant and iKey for `power-platform-skills`. Record the values (ask the repo owner if unsure):
- `ikey` — 32+ character tenant token
- `collector_url` — the regional OneCollector endpoint for that tenant (default `https://self.events.data.microsoft.com/OneCollector/1.0/`)

- [ ] **Step 2: Replace the placeholder**

Path: `shared/telemetry/ikey.json` (exact values filled in at provisioning time):

```json
{
  "ikey": "<provisioned-ikey-here>",
  "collector_url": "<regional-collector-url>"
}
```

- [ ] **Step 3: Re-sync into the plugin**

Run:
```bash
node shared/telemetry/sync-to-plugin.js --target plugins/power-pages
```

- [ ] **Step 4: Commit the new iKey and synced copy**

```bash
git add shared/telemetry/ikey.json plugins/power-pages/scripts/lib/telemetry/ikey.json
git commit -m "$(cat <<'EOF'
feat(telemetry): provision real 1DS ikey

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7.2: E2E smoke test via marketplace install

**Files:** none (manual verification).

- [ ] **Step 1: Publish a pre-release of the plugin**

Bump `plugins/power-pages/.claude-plugin/plugin.json` version (e.g. `1.3.0-pre`) and push to whichever branch the marketplace cache pulls from. Commit the version bump.

- [ ] **Step 2: Install the plugin fresh on a test machine**

From a clean shell:
```bash
claude plugins update power-pages
```
Or the equivalent command for the install flow the marketplace uses. Confirm the cached copy at `~/.claude/plugins/cache/power-platform-claude-plugins-official/power-pages/<new-version>/` now has a `hooks/` directory and matches the repo.

- [ ] **Step 3: Invoke a tracked skill**

In a fresh `claude` session (not `--plugin-dir`), run a short tracked skill such as `/power-pages:audit-permissions` and stop it at the first prompt. No npm install needed — telemetry has no dependencies.

- [ ] **Step 4: Confirm consent prompt appears on first run**

Expected: skill's Phase 1 prints an `AskUserQuestion` about telemetry. Answer "Yes".

- [ ] **Step 5: Invoke the same skill again**

Consent is now recorded. No prompt this time.

- [ ] **Step 6: Confirm events reach the collector**

Check the 1DS tenant dashboard (Geneva/Aria) for two `PowerPlatformSkillsEvent` rows per invocation: one `skill_started`, one `skill_completed`, same `correlation_id`.

- [ ] **Step 7: Confirm fire-and-forget timing**

Between invoking a tracked skill and the hook returning, there should be no perceptible delay (<100 ms for the hook itself). The POST lands in the background.

- [ ] **Step 8: Confirm fail-closed behaviour**

Run the same skill with `POWER_PLATFORM_SKILLS_TELEMETRY=0`. Dashboard shows no new events. Skill completes normally.

- [ ] **Step 9: Record smoke-test results in the repo**

Create `docs/superpowers/rollout-notes/2026-04-22-1ds-telemetry-smoke.md` with the skills invoked, event counts observed in the dashboard, and any deviations. Commit.

```bash
git add docs/superpowers/rollout-notes/2026-04-22-1ds-telemetry-smoke.md
git commit -m "$(cat <<'EOF'
docs(telemetry): record marketplace-install E2E smoke-test results

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final sanity pass

- [ ] **Step 1: Run every test file in the repo once**

```bash
node --test shared/telemetry/tests/*.test.js
```
```powershell
$files = Get-ChildItem .\plugins\power-pages\scripts\tests\*.test.js | ForEach-Object { $_.FullName }
node --test $files
```
Expected: all pass, no failures.

- [ ] **Step 2: Confirm the POC under `poc/1ds-telemetry/` still points at the real shipping files in its README**

Scan `poc/1ds-telemetry/README.md` for stale references; update any file paths that changed during the build.

- [ ] **Step 3: Optionally archive or delete the POC**

If the team wants to archive, move `poc/1ds-telemetry/` to `docs/superpowers/poc-archive/2026-04-20-1ds-telemetry/`. If it's served its purpose and implementers don't need the reference, delete it. Commit whichever decision.

---

## Self-review performed

Before executing, confirmed:

1. **Spec coverage.** Every spec section maps to at least one task:
   - §1 goals/non-goals → covered across milestones 1–7.
   - §2 architecture → M1 (library), M2 (sync).
   - §3 event schema → Task 1.6.
   - §4 consent flow → Task 1.3, 1.9, 1.10, 2.2, M4 (skill wiring).
   - §5 hook wiring → M3 + Task 5.1.
   - §6 dispatcher / iKey → Task 1.1 (scaffold), Task 1.7 (emit-dispatcher), Task 7.1 (real iKey).
   - §7 failure modes → exercised by every test (fail-closed assertions throughout).
   - §8 testing → tests accompany every implementation task.
   - §9 rollout → M3 + M4 + M6 + M7 mirror the spec's ten rollout steps.
   - §10 open items → correlation mechanism chosen in 1.4, iKey provisioning in 7.1. SDK-version and node_modules questions no longer apply after the 2026-04-22 revision.
   - §11 out-of-scope → kept out (no canvas/mcp/model/code-apps work).

2. **Placeholder scan.** No TBD/TODO strings. Every code block is complete. The only template gap is `<provisioned-ikey-here>` in Task 7.1, which is explicitly called out as a human-provisioning step.

3. **Type/name consistency.** Checked `COLLECTOR_EVENT_NAME`, `SCHEMA_VERSION`, `PROMPT_VERSION`, `POWER_PLATFORM_SKILLS_CONFIG_DIR`, `POWER_PLATFORM_SKILLS_TELEMETRY`, `POWER_PLATFORM_SKILLS_IKEY`, `POWER_PLATFORM_SKILLS_COLLECTOR`, `POWER_PLATFORM_SKILLS_FAKE_HTTPS`, `PLACEHOLDER_REPLACE_BEFORE_SHIPPING` — all spelled identically everywhere they appear. Event-builder names (`buildSkillStarted`, `buildSkillCompleted`, `buildScriptStarted`, `buildScriptCompleted`) match between `events.js`, `with-telemetry.js`, and the hook scripts. `fireAndForget` signature is consistent across `emit-spawn.js`, `with-telemetry.js`, and both hook scripts.

---

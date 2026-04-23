# Slash-Command Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit `skill_started` telemetry when a tracked Power Pages skill is invoked via a slash command (e.g., `/power-pages:add-seo`), closing the gap where `PreToolUse:Skill` never fires because Claude Code inlines `SKILL.md` into the user prompt instead of calling the `Skill` tool.

**Architecture:** Add two helpers in `shared/telemetry/lib/` — a pure strict-match detector (`prompt-detector.js`) and a small orchestrator (`emit-from-prompt.js`) — then wire a new `UserPromptSubmit` hook in the Power Pages plugin that calls the orchestrator. The existing dispatcher, consent gate, and event allowlist are reused unchanged. The new helpers travel to the plugin on the next `sync-to-plugin.js` run.

**Tech Stack:** Node 22 built-ins only (`node:fs`, `node:path`, `node:crypto`, `node:child_process`), `node:test` + `node:assert/strict` for tests. No npm dependencies. No changes to `events.js`, `emit-spawn.js`, or `emit-dispatcher.js`.

**Spec:** `docs/superpowers/specs/2026-04-23-slash-command-telemetry-design.md`

**Test runner:** `node --test <file>` — same convention used throughout `shared/telemetry/tests/`.

---

## File Structure

**New files (canonical, under `shared/telemetry/`):**
- `shared/telemetry/lib/prompt-detector.js` — pure function, zero I/O. Strict regex match at prompt start. Returns skill name or `null`.
- `shared/telemetry/lib/emit-from-prompt.js` — orchestrator. Detects → reads `ikey.json` → builds `skill_started` → fires via `emit-spawn`.
- `shared/telemetry/tests/prompt-detector.test.js` — unit tests for the detector's strict-match rules.
- `shared/telemetry/tests/emit-from-prompt.test.js` — unit tests that stub the emitter and assert event shape + pass-through.

**New files (under `plugins/power-pages/`):**
- `plugins/power-pages/hooks/run-user-prompt-telemetry.js` — thin hook wrapper, ~50 lines, structurally parallel to `run-skill-pretool-telemetry.js`.
- `plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js` — integration test that spawns the hook with a fake stdin payload and a `POWER_PLATFORM_SKILLS_FAKE_HTTPS` probe.

**Modified files:**
- `shared/telemetry/tests/sync-to-plugin.test.js` — extend existing assertion to include the two new library files in the synced copy.
- `plugins/power-pages/hooks/hooks.json` — add the `UserPromptSubmit` entry.

**Files that travel automatically via sync (no direct edits):**
- `plugins/power-pages/scripts/lib/telemetry/lib/prompt-detector.js` — synced copy of the new library file.
- `plugins/power-pages/scripts/lib/telemetry/lib/emit-from-prompt.js` — synced copy of the new library file.

---

## Milestone 1 — Shared Library Additions

Build both helpers with tests, and update the sync test. At the end of this milestone, `node --test shared/telemetry/tests/*.test.js` passes and the sync script (unchanged) would carry the new files on its next run.

### Task 1: `prompt-detector.js` — strict slash-command detector

**Files:**
- Create: `shared/telemetry/tests/prompt-detector.test.js`
- Create: `shared/telemetry/lib/prompt-detector.js`

- [ ] **Step 1: Write the failing tests**

Create `shared/telemetry/tests/prompt-detector.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectSlashCommand } = require("../lib/prompt-detector");

const TRACKED = { "add-seo": {}, "create-site": {}, "test-site": {} };
const OPTS = { pluginName: "power-pages", trackedSkills: TRACKED };

test("matches a bare slash command at start of prompt", () => {
  assert.equal(detectSlashCommand("/power-pages:add-seo", OPTS), "add-seo");
});

test("matches when followed by args", () => {
  assert.equal(
    detectSlashCommand("/power-pages:add-seo --foo bar", OPTS),
    "add-seo"
  );
});

test("matches when preceded by leading whitespace", () => {
  assert.equal(detectSlashCommand("  \n/power-pages:create-site", OPTS), "create-site");
});

test("matches when followed by newline", () => {
  assert.equal(detectSlashCommand("/power-pages:test-site\nmore text", OPTS), "test-site");
});

test("returns null for casual mid-sentence mention", () => {
  assert.equal(
    detectSlashCommand("I was thinking about /power-pages:add-seo earlier", OPTS),
    null
  );
});

test("returns null for unknown skill", () => {
  assert.equal(detectSlashCommand("/power-pages:not-a-real-skill", OPTS), null);
});

test("returns null for different plugin", () => {
  assert.equal(detectSlashCommand("/other-plugin:add-seo", OPTS), null);
});

test("returns null for substring skill name (add-seo-extra must not match add-seo)", () => {
  assert.equal(detectSlashCommand("/power-pages:add-seo-extra", OPTS), null);
});

test("returns null for empty string", () => {
  assert.equal(detectSlashCommand("", OPTS), null);
});

test("returns null for non-string prompt", () => {
  assert.equal(detectSlashCommand(null, OPTS), null);
  assert.equal(detectSlashCommand(undefined, OPTS), null);
  assert.equal(detectSlashCommand(42, OPTS), null);
});

test("case-sensitive: uppercase variants do not match", () => {
  assert.equal(detectSlashCommand("/Power-Pages:Add-SEO", OPTS), null);
});

test("respects trackedSkills parameter — 'add-seo' not tracked returns null", () => {
  const opts = { pluginName: "power-pages", trackedSkills: { "create-site": {} } };
  assert.equal(detectSlashCommand("/power-pages:add-seo", opts), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test shared/telemetry/tests/prompt-detector.test.js`
Expected: FAIL with `Cannot find module '../lib/prompt-detector'`.

- [ ] **Step 3: Implement the detector**

Create `shared/telemetry/lib/prompt-detector.js`:

```js
"use strict";

function detectSlashCommand(promptText, { pluginName, trackedSkills } = {}) {
  if (typeof promptText !== "string" || !promptText) return null;
  if (!pluginName || !trackedSkills) return null;

  const escapedPlugin = pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    String.raw`^\s*\/` + escapedPlugin + String.raw`:([a-z0-9-]+)(?=\s|$|\r|\n)`
  );
  const match = promptText.match(re);
  if (!match) return null;

  const skillName = match[1];
  return Object.prototype.hasOwnProperty.call(trackedSkills, skillName)
    ? skillName
    : null;
}

module.exports = { detectSlashCommand };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test shared/telemetry/tests/prompt-detector.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/prompt-detector.js shared/telemetry/tests/prompt-detector.test.js
git commit -m "feat(telemetry): add prompt-detector for slash-command skill detection"
```

---

### Task 2: `emit-from-prompt.js` — orchestrator

**Files:**
- Create: `shared/telemetry/tests/emit-from-prompt.test.js`
- Create: `shared/telemetry/lib/emit-from-prompt.js`

- [ ] **Step 1: Write the failing tests**

Create `shared/telemetry/tests/emit-from-prompt.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { emitSkillStartedFromPrompt } = require("../lib/emit-from-prompt");

function mkTelemetryDir(ikeyJson) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-"));
  fs.writeFileSync(path.join(tmp, "ikey.json"), JSON.stringify(ikeyJson));
  return tmp;
}

const TRACKED = { "add-seo": {}, "create-site": {} };

function callWithStub({ promptText, telemetryDir, captured }) {
  return emitSkillStartedFromPrompt(promptText, {
    pluginName: "power-pages",
    pluginVersion: "1.2.3",
    trackedSkills: TRACKED,
    telemetryDir,
    _emit: (event, spawnOpts) => {
      captured.event = event;
      captured.spawnOpts = spawnOpts;
    },
  });
}

test("returns { emitted: false } when detection returns null", () => {
  const telemetryDir = mkTelemetryDir({ ikey: "whatever", collector_url: "https://x" });
  const captured = {};
  const result = callWithStub({
    promptText: "not a slash command",
    telemetryDir,
    captured,
  });
  assert.deepEqual(result, { emitted: false, skillName: null });
  assert.equal(captured.event, undefined);
});

test("emits skill_started envelope with expected shape on match", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
    collector_url: "https://x",
  });
  const captured = {};
  const result = callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
  });
  assert.equal(result.emitted, true);
  assert.equal(result.skillName, "add-seo");
  assert.equal(captured.event.name, "PowerPlatformSkillsEvent");
  assert.equal(captured.event.data.eventName, "skill_started");
  const info = JSON.parse(captured.event.data.eventInfo);
  assert.equal(info.plugin_name, "power-pages");
  assert.equal(info.plugin_version, "1.2.3");
  assert.equal(info.skill_name, "add-seo");
  assert.equal(typeof info.correlation_id, "string");
  assert.ok(info.correlation_id.length > 0);
  assert.equal(typeof info.session_id, "string");
  assert.equal(typeof info.os_family, "string");
  assert.match(info.node_version, /^v\d+$/);
});

test("passes iKey and collectorUrl from ikey.json into spawn opts", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "real-ikey-value",
    collector_url: "https://collector.example/",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:create-site",
    telemetryDir,
    captured,
  });
  assert.equal(captured.spawnOpts.iKey, "real-ikey-value");
  assert.equal(captured.spawnOpts.collectorUrl, "https://collector.example/");
});

test("tolerates missing ikey.json — falls through to empty ikey/collector", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-noikey-"));
  const captured = {};
  const result = emitSkillStartedFromPrompt("/power-pages:add-seo", {
    pluginName: "power-pages",
    pluginVersion: "1.2.3",
    trackedSkills: TRACKED,
    telemetryDir: tmp,
    _emit: (event, spawnOpts) => {
      captured.event = event;
      captured.spawnOpts = spawnOpts;
    },
  });
  assert.equal(result.emitted, true);
  assert.equal(captured.spawnOpts.iKey, "");
  assert.equal(captured.spawnOpts.collectorUrl, "");
});

test("does not throw when _emit throws internally (fail-closed)", () => {
  const telemetryDir = mkTelemetryDir({ ikey: "x", collector_url: "https://x" });
  assert.doesNotThrow(() =>
    emitSkillStartedFromPrompt("/power-pages:add-seo", {
      pluginName: "power-pages",
      pluginVersion: "1.2.3",
      trackedSkills: TRACKED,
      telemetryDir,
      _emit: () => {
        throw new Error("boom");
      },
    })
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test shared/telemetry/tests/emit-from-prompt.test.js`
Expected: FAIL with `Cannot find module '../lib/emit-from-prompt'`.

- [ ] **Step 3: Implement the orchestrator**

Create `shared/telemetry/lib/emit-from-prompt.js`:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { detectSlashCommand } = require("./prompt-detector");
const { buildSkillStarted } = require("./events");
const { getSessionId } = require("./session");
const { fireAndForget } = require("./emit-spawn");

function readIkey(telemetryDir) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(telemetryDir, "ikey.json"), "utf8")
    );
    return { ikey: cfg.ikey || "", collectorUrl: cfg.collector_url || "" };
  } catch {
    return { ikey: "", collectorUrl: "" };
  }
}

function emitSkillStartedFromPrompt(promptText, opts = {}) {
  const {
    pluginName,
    pluginVersion,
    trackedSkills,
    telemetryDir,
    _emit, // test seam; defaults to fireAndForget
  } = opts;

  const skillName = detectSlashCommand(promptText, { pluginName, trackedSkills });
  if (!skillName) return { emitted: false, skillName: null };

  const { ikey, collectorUrl } = readIkey(telemetryDir);

  const event = buildSkillStarted({
    plugin_name: pluginName,
    plugin_version: pluginVersion || "unknown",
    session_id: getSessionId(),
    os_family: process.platform,
    node_version: "v" + String(process.versions.node).split(".")[0],
    skill_name: skillName,
    correlation_id: crypto.randomUUID(),
  });

  const emit = typeof _emit === "function" ? _emit : fireAndForget;
  try {
    emit(event, { iKey: ikey, collectorUrl });
  } catch {
    // fail closed — telemetry never propagates errors
  }

  return { emitted: true, skillName };
}

module.exports = { emitSkillStartedFromPrompt };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test shared/telemetry/tests/emit-from-prompt.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/emit-from-prompt.js shared/telemetry/tests/emit-from-prompt.test.js
git commit -m "feat(telemetry): add emit-from-prompt orchestrator for slash-command path"
```

---

### Task 3: Update sync test to assert new files travel

**Files:**
- Modify: `shared/telemetry/tests/sync-to-plugin.test.js`

- [ ] **Step 1: Add two new assertions to the existing sync test**

Edit `shared/telemetry/tests/sync-to-plugin.test.js`. Inside the existing `test("sync copies lib/ and ikey.json into <plugin>/scripts/lib/telemetry/", ...)` block, immediately after the line:

```js
assert.ok(fs.existsSync(path.join(synced, "lib", "check-consent.js")));
```

add:

```js
assert.ok(fs.existsSync(path.join(synced, "lib", "prompt-detector.js")));
assert.ok(fs.existsSync(path.join(synced, "lib", "emit-from-prompt.js")));
```

- [ ] **Step 2: Run the sync test to verify it passes**

Run: `node --test shared/telemetry/tests/sync-to-plugin.test.js`
Expected: all tests PASS. (The sync script already copies the whole `lib/` directory via `copyDir`, so the new files are picked up without a script change.)

- [ ] **Step 3: Commit**

```bash
git add shared/telemetry/tests/sync-to-plugin.test.js
git commit -m "test(telemetry): assert prompt-detector and emit-from-prompt are synced"
```

---

## Milestone 2 — Power Pages Hook Wiring

Wire the new `UserPromptSubmit` hook in the Power Pages plugin. Write the integration test first, implement the hook, register it in `hooks.json`.

### Task 4: Integration test for `run-user-prompt-telemetry.js`

**Files:**
- Create: `plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js`

Note: the hook under test requires the synced telemetry library at `plugins/power-pages/scripts/lib/telemetry/lib/*`. That copy already exists from prior telemetry work, but it does **not** yet contain `prompt-detector.js` or `emit-from-prompt.js` — those arrive in Task 7 via `sync-to-plugin.js`. The integration test runs after sync (Task 7), so the test is written now but validated then. To keep the TDD rhythm, we still author + commit the test here; it will be run to red now (expected: require-error), and to green after Task 7.

- [ ] **Step 1: Write the failing integration test**

Create `plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js`:

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
      prompt_version: 1,
      enabled,
      consented_at: new Date().toISOString(),
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

test("hook exits 0 and emits skill_started for a tracked slash command", () => {
  const configDir = mkConfigDir(true);
  const probePath = path.join(configDir, "probe.json");

  // Force the dispatcher onto the HTTPS path with a throwaway non-placeholder
  // ikey so that FAKE_HTTPS captures the probe. We rewrite the synced
  // ikey.json for this test run, then restore it.
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
    })
  );

  try {
    const { status } = runHook({
      prompt: "/power-pages:add-seo",
      configDir,
      fakeProbe: probePath,
    });
    assert.equal(status, 0);
    // Hook is fire-and-forget via a detached child. Wait briefly for the
    // dispatcher to write its probe.
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(probePath) && Date.now() < deadline) {
      // busy-wait tight enough for CI; no sleep helper available cross-platform
    }
    assert.ok(fs.existsSync(probePath), "dispatcher should have written probe");
    const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
    const body = JSON.parse(probe.body);
    assert.equal(body.data.eventName, "skill_started");
    const info = JSON.parse(body.data.eventInfo);
    assert.equal(info.plugin_name, "power-pages");
    assert.equal(info.skill_name, "add-seo");
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
  // Give any stray dispatcher a brief window; still expect no probe file.
  const deadline = Date.now() + 500;
  while (!fs.existsSync(probePath) && Date.now() < deadline) {
    /* spin */
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

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js`
Expected: FAIL — the hook script does not exist yet; `spawnSync` should return a non-zero status because `HOOK` path cannot be loaded. (The test file itself should parse cleanly.)

- [ ] **Step 3: Commit (the failing test)**

```bash
git add plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js
git commit -m "test(power-pages): add integration test for user-prompt telemetry hook"
```

---

### Task 5: Implement the `run-user-prompt-telemetry.js` hook

**Files:**
- Create: `plugins/power-pages/hooks/run-user-prompt-telemetry.js`

- [ ] **Step 1: Create the hook file**

Create `plugins/power-pages/hooks/run-user-prompt-telemetry.js`:

```js
#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

let emitFromPrompt, hookUtils;
try {
  emitFromPrompt = require(path.join(
    TELEMETRY_DIR,
    "lib",
    "emit-from-prompt"
  ));
  hookUtils = require(path.join(
    PLUGIN_ROOT,
    "scripts",
    "lib",
    "powerpages-hook-utils"
  ));
} catch {
  process.exit(0);
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"),
        "utf8"
      )
    );
    return manifest.version || "unknown";
  } catch {
    return "unknown";
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
  if (!raw) process.exit(0);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
  if (!prompt) process.exit(0);

  try {
    emitFromPrompt.emitSkillStartedFromPrompt(prompt, {
      pluginName: "power-pages",
      pluginVersion: readPluginVersion(),
      trackedSkills: hookUtils.TRACKED_SKILLS,
      telemetryDir: TELEMETRY_DIR,
    });
  } catch {
    // fail closed — telemetry never blocks the user's prompt
  }

  process.exit(0);
})().catch(() => process.exit(0));
```

- [ ] **Step 2: Commit the hook (test still failing until Task 7 sync)**

```bash
git add plugins/power-pages/hooks/run-user-prompt-telemetry.js
git commit -m "feat(power-pages): add UserPromptSubmit telemetry hook for slash commands"
```

The integration test will still fail until Task 7 runs the sync script and lands `emit-from-prompt.js` in the synced copy. That is expected — the hook file is complete; it just can't `require` the new library until the sync runs.

---

### Task 6: Register the hook in `hooks.json`

**Files:**
- Modify: `plugins/power-pages/hooks/hooks.json`

- [ ] **Step 1: Add the `UserPromptSubmit` entry**

Replace the contents of `plugins/power-pages/hooks/hooks.json` with:

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
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/run-user-prompt-telemetry.js\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

(The diff: add the `UserPromptSubmit` array at the end. `UserPromptSubmit` takes no `matcher` field.)

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('plugins/power-pages/hooks/hooks.json','utf8')); console.log('ok')"`
Expected output: `ok`

- [ ] **Step 3: Commit**

```bash
git add plugins/power-pages/hooks/hooks.json
git commit -m "feat(power-pages): register UserPromptSubmit telemetry hook"
```

---

## Milestone 3 — Sync + Local Verification

Propagate the new shared library files into the synced plugin copy, then run the full test suite and a real invocation.

### Task 7: Sync shared telemetry into the Power Pages plugin

**Files:**
- Modifies (via sync script, not direct edit): `plugins/power-pages/scripts/lib/telemetry/lib/prompt-detector.js`, `plugins/power-pages/scripts/lib/telemetry/lib/emit-from-prompt.js`

- [ ] **Step 1: Run the sync script**

Run: `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages`
Expected: exits 0; no error output.

- [ ] **Step 2: Verify the new files landed**

Run: `ls plugins/power-pages/scripts/lib/telemetry/lib/prompt-detector.js plugins/power-pages/scripts/lib/telemetry/lib/emit-from-prompt.js`
Expected: both files listed, no "No such file" error.

- [ ] **Step 3: Run the integration test (now expected to pass)**

Run: `node --test plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js`
Expected: all four tests PASS.

- [ ] **Step 4: Run the full shared-telemetry test suite**

Run (PowerShell or bash):

```bash
node --test shared/telemetry/tests/consent.test.js shared/telemetry/tests/correlation.test.js shared/telemetry/tests/emit-dispatcher.test.js shared/telemetry/tests/emit-from-prompt.test.js shared/telemetry/tests/emit-spawn.test.js shared/telemetry/tests/events.test.js shared/telemetry/tests/local-log.test.js shared/telemetry/tests/prompt-detector.test.js shared/telemetry/tests/scrubber.test.js shared/telemetry/tests/session.test.js shared/telemetry/tests/sync-to-plugin.test.js shared/telemetry/tests/with-telemetry.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the synced files**

```bash
git add plugins/power-pages/scripts/lib/telemetry/lib/prompt-detector.js plugins/power-pages/scripts/lib/telemetry/lib/emit-from-prompt.js
git commit -m "chore(power-pages): sync slash-command telemetry helpers from shared"
```

---

### Task 8: Local end-to-end verification

**Files:** none.

- [ ] **Step 1: Confirm consent is enabled**

Run: `node plugins/power-pages/scripts/lib/telemetry/lib/check-consent.js`
Expected output: `ENABLED`.

If not `ENABLED`, stop and run the consent prompt flow per `plugins/power-pages/references/telemetry-consent-reference.md` before continuing.

- [ ] **Step 2: Capture existing events.jsonl line count (for comparison)**

Run (bash): `wc -l "$USERPROFILE/.power-platform-skills/events.jsonl" 2>/dev/null || echo "0 (file not found)"`

Record the current count.

- [ ] **Step 3: Simulate a UserPromptSubmit event for the hook**

Run:

```bash
echo '{"prompt":"/power-pages:add-seo"}' | node plugins/power-pages/hooks/run-user-prompt-telemetry.js
```

Expected: exits 0 with no stdout/stderr. The detached dispatcher writes asynchronously.

- [ ] **Step 4: Wait briefly, then verify a new line appeared in events.jsonl**

Run (bash):

```bash
sleep 1
wc -l "$USERPROFILE/.power-platform-skills/events.jsonl"
tail -1 "$USERPROFILE/.power-platform-skills/events.jsonl"
```

Expected: line count increased by 1 from Step 2. The last line contains a `PowerPlatformSkillsEvent` envelope whose `eventInfo` (when parsed) has `skill_name: "add-seo"` and `plugin_name: "power-pages"`.

- [ ] **Step 5: Confirm no local log is written for an unrelated prompt**

Run:

```bash
wc -l "$USERPROFILE/.power-platform-skills/events.jsonl"  # capture count
echo '{"prompt":"hello world"}' | node plugins/power-pages/hooks/run-user-prompt-telemetry.js
sleep 1
wc -l "$USERPROFILE/.power-platform-skills/events.jsonl"  # should be unchanged
```

Expected: line count is the same before and after.

- [ ] **Step 6: No commit needed — this task is pure verification**

---

## Self-Review Checklist (for the implementer)

Before declaring the feature complete:

- [ ] `node --test shared/telemetry/tests/*.test.js` passes.
- [ ] `node --test plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js` passes.
- [ ] `events.jsonl` grows by exactly one line per `/power-pages:<tracked-skill>` invocation.
- [ ] `events.jsonl` does **not** grow when a non-tracked prompt is submitted.
- [ ] The Power Pages `hooks.json` still parses as valid JSON and includes all three hook types (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`).
- [ ] No changes to `events.js`, `emit-spawn.js`, or `emit-dispatcher.js` were made.
- [ ] No new npm dependencies were introduced.
- [ ] No PII or file paths leak into the event payload — spot-check by parsing a real event from `events.jsonl`.

# Telemetry Skill-Only Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the telemetry event vocabulary to `skill_started` + `skill_completed` only, add a TTL sweep + host-agnostic session resolver, and remove all script-tracking code paths from the shared library and the Power Pages plugin.

**Architecture:** Pure subtraction + two small library additions. Delete `with-telemetry.js`, `telemetry-runner.js`, and `script_*` builders; unwrap 14 callers from `runInstrumented`. Add a `resolveHostSessionId(payload)` helper to `session.js` (precedence: `session_id` > `sessionId` > `""`) so hooks transparently work for Claude Code and GitHub Copilot CLI. Add a 1-hour TTL sweep to `correlation.write()` so abandoned correlation files don't leak.

**Tech Stack:** Node.js stdlib (`node:fs`, `node:os`, `node:path`, `node:crypto`), `node:test`, no external deps.

**Spec reference:** `docs/superpowers/specs/2026-05-28-session-correlation-cleanup-design.md`

**Branch:** `users/amitjosh/1ds-feature` (stay on the existing branch — preceding commits ratify the prior session.js fix this plan extends)

**File structure:**

| File | Status | Responsibility |
|---|---|---|
| `shared/telemetry/lib/events.js` | modify | Drop `buildScriptStarted` / `buildScriptCompleted` exports + `scriptName` from `FIELD_TYPES` |
| `shared/telemetry/tests/events.test.js` | modify | Drop script-builder tests |
| `shared/telemetry/lib/correlation.js` | modify | Add TTL sweep in `write()` |
| `shared/telemetry/tests/correlation.test.js` | modify | Add TTL sweep tests |
| `shared/telemetry/lib/session.js` | modify | Add `resolveHostSessionId(payload)` helper |
| `shared/telemetry/tests/session.test.js` | modify | Add `resolveHostSessionId` tests |
| `shared/telemetry/lib/with-telemetry.js` | **delete** | Script wrapper no longer needed |
| `shared/telemetry/tests/with-telemetry.test.js` | **delete** | Tests for deleted module |
| `plugins/power-pages/scripts/lib/telemetry-runner.js` | **delete** | Plugin-side wrapper |
| `plugins/power-pages/scripts/tests/telemetry-runner.test.js` | **delete** | Tests for deleted module |
| `plugins/power-pages/skills/*/scripts/validate-*.js` (10 files) | modify | Unwrap `runInstrumented` |
| `plugins/power-pages/scripts/{clear-site-cache,render-audit-report,check-activation-status,verify-dataverse-access}.js` | modify | Unwrap `runInstrumented` |
| `plugins/power-pages/hooks/run-skill-pretool-telemetry.js` | modify | Use `resolveHostSessionId(parsed)` |
| `plugins/power-pages/hooks/run-skill-posttool-validation.js` | modify | Use `resolveHostSessionId(input)` |
| `plugins/power-pages/hooks/run-user-prompt-telemetry.js` | modify | Use `resolveHostSessionId(parsed)` |
| `shared/telemetry/README.md` | modify | Drop "Wrap scripts with runInstrumented" section + lib/ layout |
| `plugins/power-pages/scripts/lib/telemetry/lib/*` | synced | Re-synced from `shared/telemetry/lib/` |

---

## Task 1: Add `resolveHostSessionId` helper to `session.js`

**Files:**
- Modify: `shared/telemetry/lib/session.js`
- Test: `shared/telemetry/tests/session.test.js`

- [ ] **Step 1: Append the failing tests**

Append to `shared/telemetry/tests/session.test.js`:

```js
const { resolveHostSessionId } = require(sessionPath);

test("resolveHostSessionId returns payload.session_id when present (Claude Code shape)", () => {
  assert.equal(
    resolveHostSessionId({ session_id: "claude-snake-case-id" }),
    "claude-snake-case-id"
  );
});

test("resolveHostSessionId returns payload.sessionId when only camelCase is present", () => {
  assert.equal(
    resolveHostSessionId({ sessionId: "camel-case-id" }),
    "camel-case-id"
  );
});

test("resolveHostSessionId prefers session_id over sessionId when both present", () => {
  assert.equal(
    resolveHostSessionId({ session_id: "snake-wins", sessionId: "camel-loses" }),
    "snake-wins"
  );
});

test("resolveHostSessionId returns empty string for null payload", () => {
  assert.equal(resolveHostSessionId(null), "");
});

test("resolveHostSessionId returns empty string for undefined payload", () => {
  assert.equal(resolveHostSessionId(undefined), "");
});

test("resolveHostSessionId returns empty string for non-object payload", () => {
  assert.equal(resolveHostSessionId("not an object"), "");
  assert.equal(resolveHostSessionId(42), "");
  assert.equal(resolveHostSessionId(true), "");
});

test("resolveHostSessionId returns empty string for object without known fields", () => {
  assert.equal(resolveHostSessionId({ foo: "bar", other: "value" }), "");
});

test("resolveHostSessionId returns empty string for empty-string field values", () => {
  assert.equal(resolveHostSessionId({ session_id: "", sessionId: "" }), "");
});

test("resolveHostSessionId returns empty string for non-string field values", () => {
  assert.equal(resolveHostSessionId({ session_id: 123, sessionId: { x: 1 } }), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test shared/telemetry/tests/session.test.js`
Expected: 9 new tests FAIL with `TypeError: resolveHostSessionId is not a function` (the helper does not exist yet).

- [ ] **Step 3: Implement the helper**

Edit `shared/telemetry/lib/session.js`. Add the function and export it:

```js
"use strict";

const crypto = require("node:crypto");

// Hooks run as fresh Node processes, so a module-level UUID would be unique
// per hook invocation — every event in a Claude Code session would carry a
// different sessionId, breaking session-scoped analysis. Each hook reads
// Claude Code's session_id from the stdin payload and primes this cache
// with it so all events emitted from that hook (and within that process)
// share a single sessionId.
let cached;

function getSessionId(override) {
  if (typeof override === "string" && override) {
    cached = override;
    return cached;
  }
  if (!cached) cached = crypto.randomUUID();
  return cached;
}

// Multi-host session-id resolver. Both Claude Code and GitHub Copilot CLI
// surface their session id through the hook stdin payload. Field-name
// convention may vary by host; check known variants in precedence order.
// Returns "" when no usable id is present so the caller's subsequent
// getSessionId("") falls back to a per-process UUID.
function resolveHostSessionId(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.session_id === "string" && payload.session_id) {
    return payload.session_id;
  }
  if (typeof payload.sessionId === "string" && payload.sessionId) {
    return payload.sessionId;
  }
  return "";
}

// Test seam.
function _resetCache() {
  cached = undefined;
}

module.exports = { getSessionId, resolveHostSessionId, _resetCache };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test shared/telemetry/tests/session.test.js`
Expected: All tests PASS (existing + 9 new).

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/session.js shared/telemetry/tests/session.test.js
git commit -m "feat(telemetry): add resolveHostSessionId helper for multi-host session sourcing"
```

---

## Task 2: Add TTL sweep to `correlation.write()`

**Files:**
- Modify: `shared/telemetry/lib/correlation.js`
- Test: `shared/telemetry/tests/correlation.test.js`

- [ ] **Step 1: Append the failing tests**

Append to `shared/telemetry/tests/correlation.test.js`:

```js
test("write unlinks ppskills-corr-*.json files older than 1 hour before writing", () => {
  const tmp = mkTmp();
  const oldFile = path.join(tmp, "ppskills-corr-stale.json");
  fs.writeFileSync(oldFile, JSON.stringify({ correlation_id: "old", start_ts: 1 }));
  const twoHoursAgo = Date.now() / 1000 - 7200;
  fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

  corr.write({ skillName: "fresh", tmpDir: tmp });

  assert.equal(fs.existsSync(oldFile), false, "stale correlation file should be unlinked");
  assert.equal(
    fs.existsSync(path.join(tmp, "ppskills-corr-fresh.json")),
    true,
    "new correlation file should exist"
  );
});

test("write preserves ppskills-corr-*.json files newer than 1 hour", () => {
  const tmp = mkTmp();
  const recentFile = path.join(tmp, "ppskills-corr-recent.json");
  fs.writeFileSync(recentFile, JSON.stringify({ correlation_id: "recent", start_ts: 1 }));
  const tenMinAgo = Date.now() / 1000 - 600;
  fs.utimesSync(recentFile, tenMinAgo, tenMinAgo);

  corr.write({ skillName: "another", tmpDir: tmp });

  assert.equal(fs.existsSync(recentFile), true, "recent correlation file should survive");
});

test("write does not touch unrelated files in tmpDir", () => {
  const tmp = mkTmp();
  const unrelated = path.join(tmp, "unrelated.json");
  fs.writeFileSync(unrelated, "{}");
  const twoHoursAgo = Date.now() / 1000 - 7200;
  fs.utimesSync(unrelated, twoHoursAgo, twoHoursAgo);

  corr.write({ skillName: "x", tmpDir: tmp });

  assert.equal(fs.existsSync(unrelated), true, "non-prefixed files should survive sweep");
});

test("write swallows readdir failures when tmpDir does not exist", () => {
  const tmp = path.join(os.tmpdir(), "ppskills-nonexistent-" + Date.now());
  assert.doesNotThrow(() => corr.write({ skillName: "x", tmpDir: tmp }));
  // write also swallows writeFileSync failure per existing semantics; no file produced
  assert.equal(fs.existsSync(path.join(tmp, "ppskills-corr-x.json")), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test shared/telemetry/tests/correlation.test.js`
Expected: At least the first 3 of the 4 new tests FAIL (the stale file is not unlinked; `write` has no sweep yet). The readdir-failure test may already pass since `write` already swallows write errors.

- [ ] **Step 3: Implement TTL sweep in `write()`**

Edit `shared/telemetry/lib/correlation.js`. Add a sweep helper and call it at the top of `write()`:

```js
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// TTL for stale correlation files. PostToolUse normally clears the file
// immediately. If it never fires (Claude Code killed, skill timeout, etc.),
// the next PreToolUse sweep unlinks anything older than this.
const STALE_TTL_MS = 60 * 60 * 1000;

// Concurrent-same-skill race: if two invocations of the same skill overlap
// (extremely rare in single-agent Claude Code usage), the second write
// clobbers the first. Both posttool reads return the second's UUID.
// Documented, not structurally fixed.

function correlationPath({ skillName, tmpDir }) {
  const dir = tmpDir || os.tmpdir();
  const safe = String(skillName || "unknown").replace(/[^a-z0-9-]/gi, "_");
  return path.join(dir, `ppskills-corr-${safe}.json`);
}

function sweepStale(tmpDir) {
  const dir = tmpDir || os.tmpdir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TTL_MS;
  for (const name of entries) {
    if (!name.startsWith("ppskills-corr-") || !name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
      }
    } catch {
      // ignore: best-effort sweep
    }
  }
}

function write({ skillName, tmpDir }) {
  sweepStale(tmpDir);
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

module.exports = { correlationPath, write, read, clear, STALE_TTL_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test shared/telemetry/tests/correlation.test.js`
Expected: All tests PASS (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/correlation.js shared/telemetry/tests/correlation.test.js
git commit -m "feat(telemetry): TTL-sweep stale correlation files in correlation.write"
```

---

## Task 3: Drop `buildScript*` builders + `scriptName` from `events.js`

**Files:**
- Modify: `shared/telemetry/lib/events.js`
- Modify: `shared/telemetry/tests/events.test.js`

- [ ] **Step 1: Inspect the existing tests to know what to delete**

Run: `node --test shared/telemetry/tests/events.test.js 2>&1 | tail -10`
Note: capture the test count before changes.

- [ ] **Step 2: Remove script-builder usages from the test file**

In `shared/telemetry/tests/events.test.js`, delete every `test(...)` block whose body references `buildScriptStarted` or `buildScriptCompleted`. Also delete any import line that destructures those names from `"../lib/events"`.

Search for the pattern to find them quickly:

```bash
grep -n "buildScriptStarted\|buildScriptCompleted" shared/telemetry/tests/events.test.js
```

Delete each matching test block in its entirety (start of `test(...)` through the closing `});`). Keep all `buildSkillStarted` / `buildSkillCompleted` tests intact.

- [ ] **Step 3: Remove script builders + `scriptName` field from `events.js`**

Edit `shared/telemetry/lib/events.js`:

1. Remove the `scriptName: "string"` entry from `FIELD_TYPES`.
2. Remove the `const SCRIPT_FIELDS = ["scriptName"];` line.
3. Remove the `buildScriptStarted` function definition.
4. Remove the `buildScriptCompleted` function definition.
5. Remove `buildScriptStarted` and `buildScriptCompleted` from the `module.exports` object.

The exports block becomes:

```js
module.exports = {
  buildSkillStarted,
  buildSkillCompleted,
  FIELD_TYPES,
  pick,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test shared/telemetry/tests/events.test.js`
Expected: All remaining tests PASS. The deleted tests are gone; no test references the removed exports.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/events.js shared/telemetry/tests/events.test.js
git commit -m "feat(telemetry): drop buildScript builders + scriptName field"
```

---

## Task 4: Delete `with-telemetry.js` and its test

**Files:**
- Delete: `shared/telemetry/lib/with-telemetry.js`
- Delete: `shared/telemetry/tests/with-telemetry.test.js`

- [ ] **Step 1: Confirm no remaining importers in the shared library**

Run:

```bash
grep -rn "with-telemetry" shared/telemetry/lib shared/telemetry/tests
```

Expected: only `shared/telemetry/lib/with-telemetry.js` and `shared/telemetry/tests/with-telemetry.test.js` show in the output. No other shared file imports it.

- [ ] **Step 2: Delete the files**

```bash
git rm shared/telemetry/lib/with-telemetry.js shared/telemetry/tests/with-telemetry.test.js
```

- [ ] **Step 3: Run the shared suite to verify nothing references the deleted module**

Run: `node --test shared/telemetry/tests/*.test.js`
Expected: All remaining tests PASS. No `Cannot find module` errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(telemetry): delete with-telemetry script wrapper"
```

---

## Task 5: Delete `plugins/power-pages/scripts/lib/telemetry-runner.js` and its test

**Files:**
- Delete: `plugins/power-pages/scripts/lib/telemetry-runner.js`
- Delete: `plugins/power-pages/scripts/tests/telemetry-runner.test.js`

Note: This task creates a temporary broken state — the validators and standalone scripts still import `telemetry-runner` until Task 6 + Task 7 unwrap them. Do not run the plugin script suite between this task and Task 7. The shared suite is unaffected.

- [ ] **Step 1: Delete the files**

```bash
git rm plugins/power-pages/scripts/lib/telemetry-runner.js plugins/power-pages/scripts/tests/telemetry-runner.test.js
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(power-pages): delete telemetry-runner plugin wrapper"
```

---

## Task 6: Unwrap `runInstrumented` from all 10 validators

**Files (modify each — same edit pattern):**

| File | runInstrumented call site (line) |
|---|---|
| `plugins/power-pages/skills/activate-site/scripts/validate-activation.js` | line 47 |
| `plugins/power-pages/skills/add-cloud-flow/scripts/validate-cloudflow.js` | line 128 |
| `plugins/power-pages/skills/add-seo/scripts/validate-seo.js` | line 90 |
| `plugins/power-pages/skills/add-server-logic/scripts/validate-serverlogic.js` | line 235 (top-level) and line 343 (fallback block) |
| `plugins/power-pages/skills/audit-permissions/scripts/validate-audit.js` | line 38 |
| `plugins/power-pages/skills/create-site/scripts/validate-site.js` | line 110 |
| `plugins/power-pages/skills/create-webroles/scripts/validate-webroles.js` | line 33 |
| `plugins/power-pages/skills/integrate-webapi/scripts/validate-webapi-integration.js` | line 62 (top-level) and line 135 (fallback block) |
| `plugins/power-pages/skills/setup-auth/scripts/validate-auth.js` | line 133 |
| `plugins/power-pages/skills/setup-datamodel/scripts/validate-datamodel.js` | line 54 (top-level) and line 94 (fallback block) |

**Edit pattern — apply to every file above:**

- [ ] **Step 1: Remove the import**

Find and delete the line near the top:

```js
const { runInstrumented } = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'lib', 'telemetry-runner'));
```

(Some files may import via direct relative path or with slight formatting; remove whichever variant is present.)

- [ ] **Step 2: Replace each `runInstrumented(...)` call with a direct `main()` call**

Find every line matching:

```js
runInstrumented('<some-name>', main).catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});
```

Replace with:

```js
main().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});
```

The name string (`'validate-add-seo'`, etc.) is dropped — `main()` is invoked directly.

**Important:** four files have TWO matches (`validate-datamodel.js`, `validate-serverlogic.js`, `validate-integrate-webapi.js`). Replace BOTH occurrences in each of those files. The second occurrence in each is inside a conditional fallback block — its surrounding logic is unchanged; only the `runInstrumented(...)` call inside it is rewritten.

- [ ] **Step 3: Verify no validator still imports `runInstrumented`**

Run:

```bash
grep -rn "runInstrumented\|telemetry-runner" plugins/power-pages/skills
```

Expected: NO matches.

- [ ] **Step 4: Smoke-test one validator runs without `telemetry-runner` available**

Run:

```bash
node plugins/power-pages/skills/add-seo/scripts/validate-seo.js 2>&1 | head -5
```

Expected: Exits with the validator's own exit code (usually 0 with "approved" or non-zero with errors). NOT `Cannot find module 'telemetry-runner'`.

- [ ] **Step 5: Commit**

```bash
git add plugins/power-pages/skills
git commit -m "feat(power-pages): unwrap runInstrumented from validators"
```

---

## Task 7: Unwrap `runInstrumented` from 4 standalone scripts

**Files:**
- `plugins/power-pages/scripts/check-activation-status.js` (line 141)
- `plugins/power-pages/scripts/clear-site-cache.js` (line 126)
- `plugins/power-pages/scripts/render-audit-report.js` (line 35)
- `plugins/power-pages/scripts/verify-dataverse-access.js` (line 60)

- [ ] **Step 1: For each file, remove the import line near the top**

Find and delete:

```js
const { runInstrumented } = require('./lib/telemetry-runner');
```

- [ ] **Step 2: For each file, replace the `runInstrumented(...)` call**

Find:

```js
runInstrumented('<script-name>', main).catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});
```

Replace with:

```js
main().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});
```

- [ ] **Step 3: Verify no scripts still reference `runInstrumented` or `telemetry-runner`**

Run:

```bash
grep -rn "runInstrumented\|telemetry-runner" plugins/power-pages/scripts
```

Expected: NO matches (the lib/ copy was deleted in Task 5).

- [ ] **Step 4: Smoke-test one script**

Run:

```bash
node plugins/power-pages/scripts/check-activation-status.js 2>&1 | head -5
```

Expected: Script's normal output (or its own usage error). NOT `Cannot find module 'telemetry-runner'`.

- [ ] **Step 5: Commit**

```bash
git add plugins/power-pages/scripts
git commit -m "feat(power-pages): unwrap runInstrumented from standalone scripts"
```

---

## Task 8: Switch all 3 plugin hooks to `resolveHostSessionId`

**Files:**
- Modify: `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`
- Modify: `plugins/power-pages/hooks/run-skill-posttool-validation.js`
- Modify: `plugins/power-pages/hooks/run-user-prompt-telemetry.js`

- [ ] **Step 1: Pretool hook — replace the inline session_id extraction**

In `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`, find:

```js
    sessionId: sessionLib.getSessionId(parsed && parsed.session_id),
```

Replace with:

```js
    sessionId: sessionLib.getSessionId(sessionLib.resolveHostSessionId(parsed)),
```

- [ ] **Step 2: Posttool hook — replace the inline session_id extraction**

In `plugins/power-pages/hooks/run-skill-posttool-validation.js`, find:

```js
      sessionId: sessionLib.getSessionId(input && input.session_id),
```

Replace with:

```js
      sessionId: sessionLib.getSessionId(sessionLib.resolveHostSessionId(input)),
```

- [ ] **Step 3: User-prompt hook — replace and add the sessionLib import**

In `plugins/power-pages/hooks/run-user-prompt-telemetry.js`, the file currently does NOT import `sessionLib`. Add the import alongside the existing requires:

```js
const sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
```

Place it right after the existing `emitFromPrompt`/`hookUtils` requires.

Then find:

```js
      sessionId: parsed.session_id,
```

Replace with:

```js
      sessionId: sessionLib.resolveHostSessionId(parsed),
```

- [ ] **Step 4: Run the plugin hook test suite to verify nothing regressed**

Run:

```bash
node --test plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js plugins/power-pages/scripts/tests/telemetry-hook-posttool.test.js plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js
```

Expected: All tests PASS.

Note: the synced library still has the OLD `session.js` (no `resolveHostSessionId` export) at this point. The hook tests may fail with `sessionLib.resolveHostSessionId is not a function`. That's expected and will be fixed by Task 9 (sync). Proceed.

- [ ] **Step 5: Commit**

```bash
git add plugins/power-pages/hooks
git commit -m "feat(power-pages): hooks use resolveHostSessionId for multi-host session sourcing"
```

---

## Task 9: Sync shared → plugin and verify both suites

**Files:**
- Run: `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages`
- Restore: `plugins/power-pages/scripts/lib/telemetry/ikey.json`
- Verify: full shared + plugin test suites pass

- [ ] **Step 1: Run the sync**

```bash
node shared/telemetry/sync-to-plugin.js --target plugins/power-pages
```

Expected: `Synced shared/telemetry → plugins\power-pages\scripts\lib\telemetry`

- [ ] **Step 2: Verify the synced lib/ no longer contains `with-telemetry.js`**

```bash
ls plugins/power-pages/scripts/lib/telemetry/lib/
```

Expected: directory listing does NOT include `with-telemetry.js`. The deleted source file is now gone from the synced target.

- [ ] **Step 3: Restore the plugin's `ikey.json` (sync overwrites it with the shared placeholder template)**

```bash
git checkout plugins/power-pages/scripts/lib/telemetry/ikey.json
```

- [ ] **Step 4: Run the full shared test suite**

```bash
node --test shared/telemetry/tests/*.test.js
```

Expected: All tests PASS.

- [ ] **Step 5: Run the full plugin script test suite**

```bash
node --test plugins/power-pages/scripts/tests/*.test.js
```

Expected: All tests PASS.

- [ ] **Step 6: Commit the synced lib changes**

```bash
git add plugins/power-pages/scripts/lib/telemetry/lib/
git commit -m "chore(power-pages): sync session/correlation cleanup into plugin copy"
```

---

## Task 10: Update `shared/telemetry/README.md`

**Files:**
- Modify: `shared/telemetry/README.md`

- [ ] **Step 1: Drop the "Wrap scripts with runInstrumented" step from the adoption guide**

Open `shared/telemetry/README.md`. Find the section starting with `### 4. (Optional) Wrap scripts with \`runInstrumented\`` and delete the entire section through (but not including) the next `### 5. Verify locally` heading.

Then renumber the remaining adoption steps: `### 5. Verify locally` becomes `### 4. Verify locally`.

- [ ] **Step 2: Update the Layout tree to remove `with-telemetry.js`**

Find the `## Layout` section's tree block. Delete the line:

```
│  ├─ with-telemetry.js      # script wrapper — emits script_started / script_completed around an async fn
```

- [ ] **Step 3: Update the "What is sent" per-event section to drop script references**

Find the "Per-event:" block under "What is sent". Change the existing bullet:

```
- `skillName` (skill events) or `scriptName` (script events)
```

to:

```
- `skillName` (on every event)
```

- [ ] **Step 4: Update "Test seams" section to drop `with-telemetry.js` line**

Find the bullet for `with-telemetry.js` test seams and delete it. Specifically remove the line:

```
- `with-telemetry.js` — `opts.emitter`, `opts._readAgentInfo`
```

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/README.md
git commit -m "docs(telemetry): drop script-wrapper section from README; align with skill-only events"
```

---

## Task 11: Manual end-to-end verification

**Files:** (none modified)

This is a one-time human check that the full chain still works after all subtractions.

- [ ] **Step 1: Flip the kill switch off and point at a real iKey**

Edit `plugins/power-pages/scripts/lib/telemetry/ikey.json` (DO NOT commit):

```json
{
  "instrumentationKey": "197418c5cb8c4426b201f9db2e87b914-87887378-2790-49b0-9295-51f43b6204b1-7172",
  "collector_url": "https://us-mobile.events.data.microsoft.com/OneCollector/1.0/",
  "event_stream_name": "PagesPluginEventTest",
  "disabled": false
}
```

- [ ] **Step 2: Restart Claude Code**

Hooks pick up the new ikey.json only on a fresh Claude Code session.

- [ ] **Step 3: Invoke a tracked skill**

Type a tracked slash command, e.g. `/power-pages:add-seo`.

- [ ] **Step 4: Verify in Kusto (or local trace) that only skill events appear**

Wait ~60s for ingestion. Query Kusto:

```kusto
PagesPluginEventTest
| where TimeGenerated > ago(5m)
| extend msg = parse_json(original_message)
| project TimeGenerated,
    EventName    = tostring(msg.data.eventName),
    SessionId    = tostring(msg.data.sessionId),
    CorrelationId = tostring(msg.data.correlationId)
| order by TimeGenerated desc
```

Expected: Only `skill_started` / `skill_completed` rows. NO `script_started` / `script_completed` rows. Multiple rows from this session share the same `SessionId`.

If no `skill_completed` row appears, that is Finding E in the spec — record it for the separate follow-up; do not block this PR on it.

- [ ] **Step 5: Revert the test config**

```bash
git checkout plugins/power-pages/scripts/lib/telemetry/ikey.json
```

Confirm with `git status`: no working-tree changes remain.

- [ ] **Step 6: (No commit)** — this task makes no file changes that ship.

---

## Task 12: Push the branch

**Files:** (none)

- [ ] **Step 1: Confirm the local log shows all commits in order**

```bash
git log --oneline origin/users/amitjosh/1ds-feature..HEAD
```

Expected: All commits from Tasks 1–10 listed, no others. Working tree clean.

- [ ] **Step 2: Push**

```bash
git push origin users/amitjosh/1ds-feature
```

Expected: `Writing objects ... users/amitjosh/1ds-feature -> users/amitjosh/1ds-feature`.

- [ ] **Step 3: Verify push**

```bash
git rev-parse HEAD
git rev-parse origin/users/amitjosh/1ds-feature
```

Expected: Both SHAs identical.

---

## Self-review checklist

- [x] Spec §1 Problem and goals — Tasks 1 (session helper), 2 (TTL sweep), 3+4+5+6+7 (script tracking removal) together address the two stated problems and all goals.
- [x] Spec §3.1 Deleted modules — Task 4 (with-telemetry.js + test), Task 5 (telemetry-runner.js + test).
- [x] Spec §3.2 `events.js` — Task 3.
- [x] Spec §3.2 `correlation.js` TTL sweep + race comment — Task 2 (sweep + STALE_TTL_MS comment + race comment in the implementation block).
- [x] Spec §3.2 `session.js` `resolveHostSessionId` — Task 1.
- [x] Spec §3.2 `emit-from-prompt.js` no code changes — confirmed; not listed in any task.
- [x] Spec §3.2 `prompt-detector.js` no code changes — confirmed; not listed.
- [x] Spec §3.3 Validators unwrap (10 files) — Task 6.
- [x] Spec §3.3 Standalone scripts unwrap (4 files) — Task 7.
- [x] Spec §3.3 Three hooks switch to `resolveHostSessionId` — Task 8.
- [x] Spec §3.4 Plugin synced copies — Task 9.
- [x] Spec §3.5 README — Task 10.
- [x] Spec §3.5 AGENTS.md no changes needed — confirmed; not listed.
- [x] Spec §4 Data flow — preserved (no event semantics changed beyond removals).
- [x] Spec §5 Privacy invariants — preserved (no allowlist relaxation; sanitizeData unchanged).
- [x] Spec §6 Testing plan — Tasks 1, 2 (test additions), Tasks 3, 4, 5 (test deletions). Manual verification = Task 11.
- [x] Spec §7 Migration — Task 10 (README update).
- [x] Spec §8 Out of scope (Finding E, eventName disambiguation, concurrent race) — noted in Task 11 step 4; not blocked on.
- [x] Spec §9 Implementation order — matches Tasks 1-10 order.

No placeholders. No "similar to task N". Every step shows the exact code or command. Type/name consistency: `resolveHostSessionId(payload)`, `getSessionId(override)`, `STALE_TTL_MS`, `sweepStale(tmpDir)` used consistently.

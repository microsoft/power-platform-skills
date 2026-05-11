# Slash-Command Telemetry for `skill_started`

**Status:** Draft
**Date:** 2026-04-23
**Owner:** Amit Joshi (amitjoshi@microsoft.com)
**Related:** [2026-04-20 1DS Telemetry Design](./2026-04-20-1ds-telemetry-design.md)

## Problem

The current 1DS telemetry pipeline wires two hooks:

- `PreToolUse:Skill` → emits `skill_started`
- `PostToolUse:Skill` → emits `skill_completed`

Both only fire when the assistant invokes the `Skill` tool programmatically. When a user invokes a skill via a slash command (e.g., `/power-pages:add-seo`), Claude Code inlines the skill's `SKILL.md` content directly into the user's prompt — the `Skill` tool is never called. As a result, neither hook fires and the invocation is invisible to telemetry.

This is the common case. In practice, most skill invocations in the Power Pages plugin happen via slash commands, so the current telemetry substantially undercounts usage.

## Goal

Emit `skill_started` whenever a tracked skill is invoked via a slash command, so slash-invoked skill runs appear in telemetry at the same level of fidelity as programmatic `Skill`-tool invocations.

## Non-Goals

1. **No `skill_completed` for slash-invoked skills.** See *Why we deliberately skip completion* below.
2. **No new event type or new allowlisted field for MVP.** Reuse the existing `skill_started` shape.
3. **No change to the existing `PreToolUse:Skill` / `PostToolUse:Skill` hooks.** They remain the authoritative path for programmatic `Skill`-tool invocations.
4. **No cross-plugin rollout in this PR.** Power Pages is currently the only telemetry adopter; the design is shaped so future adopters get slash-command telemetry via the normal shared-library sync, but no other plugin is changed here.

## Why we deliberately skip completion

A `Stop` hook is the only plausible proxy for "slash-invoked skill finished," and it does not line up with skill completion. Emitting `skill_completed` from a `Stop` hook would produce demonstrably wrong data in at least six ways:

1. **Multiple fires per skill run.** Multi-phase skills (e.g., `add-seo` has seven phases with `AskUserQuestion` pauses between them) cause `Stop` to fire every time the assistant finishes a turn. One skill run → N completion events.
2. **No "final Stop" signal.** The `Stop` payload contains no indicator that this is the last stop for a given skill. The session can continue indefinitely after any phase.
3. **Session-scoped, not skill-scoped.** If two slash commands run in one session, `Stop` has no way to attribute each fire to the right in-flight skill without brittle transcript parsing.
4. **Duration becomes meaningless.** `stop_ts - start_ts` for a slash-invoked skill includes human think-time between phases — potentially hours. The existing `skill_completed` duration distribution measures seconds of assistant work. Mixing these distributions poisons the metric.
5. **Outcome inference is wrong by default.** `Stop` carries no exit code or exception context. Defaulting every fire to "success" breaks the success-rate metric.
6. **Correlation-file lifecycle breaks.** `correlation.js` assumes one matching completion per start. N fires per skill either all share the start correlation or the later fires emit without correlation — neither is correct.

Net: a `Stop`-based `skill_completed` looks like one line of wiring but lies in multiple ways at once. No completion telemetry for slash invocations is better than wrong completion telemetry.

Analytics that need to distinguish "skill was invoked and finished" from "skill was invoked but may still be running" can infer it from the existing data: for slash-invoked `skill_started`, no matching `skill_completed` will ever arrive in the same session.

## Architecture

Add one new hook per adopting plugin, plus two helpers in the shared telemetry library. The new hook fires on `UserPromptSubmit`, detects a slash-command invocation of a tracked skill, and emits `skill_started` through the existing dispatcher.

```
UserPromptSubmit hook (per plugin, ~15 lines)
        │ stdin: { prompt, ... }
        ▼
shared/telemetry/lib/prompt-detector.js
    detectSlashCommand(prompt, { pluginName, trackedSkills })
    → returns skillName | null (strict match at prompt start)
        │
        ▼
shared/telemetry/lib/emit-from-prompt.js
    emitSkillStartedFromPrompt(prompt, {
        pluginName, pluginVersion, trackedSkills, telemetryDir
    })
    1. detectSlashCommand(...)
    2. read ikey.json from telemetryDir
    3. buildSkillStarted(...)  // existing allowlist, no new fields
    4. fireAndForget(event, { iKey, collectorUrl })
        │
        ▼
existing dispatcher (unchanged)
    → consent-gated → local JSONL (placeholder ikey) or HTTPS POST (real ikey)
```

## Components

### `shared/telemetry/lib/prompt-detector.js` (new)

Pure function, zero I/O.

```js
// exact signature
detectSlashCommand(promptText, { pluginName, trackedSkills }) → string | null
```

Strict matching rule:

```
^\s*/<pluginName>:([a-z0-9-]+)(?=\s|$|\r|\n)
```

- Must be at the **start** of the prompt (after optional leading whitespace).
- The captured skill name must be a member of `trackedSkills`.
- Skill name is bounded by whitespace, end-of-string, or newline — substring matches like `/power-pages:add-seo-extra` do not match `add-seo`.
- Mentions mid-sentence ("I was thinking about `/power-pages:add-seo` earlier…") never match.

Returns the matched skill name, or `null`.

### `shared/telemetry/lib/emit-from-prompt.js` (new)

Orchestrator. Accepts everything it needs by parameter to keep it testable.

```js
emitSkillStartedFromPrompt(promptText, {
  pluginName,       // e.g., "power-pages"
  pluginVersion,    // e.g., "1.4.2"
  trackedSkills,    // Set or object with skill names as keys
  telemetryDir,     // absolute path to the plugin's synced telemetry dir
}) → { emitted: boolean, skillName: string | null }
```

Flow:

1. Calls `detectSlashCommand`. If `null`, returns `{ emitted: false, skillName: null }`.
2. Reads `ikey.json` from `telemetryDir` (placeholder tolerant — empty or placeholder just falls through the existing dispatcher local-log path).
3. Generates a fresh `correlation_id` for event-shape consistency. Does **not** write a correlation file — no matching `skill_completed` event will ever join.
4. Builds the event with `buildSkillStarted(...)` using the existing allowlist: `plugin_name`, `plugin_version`, `session_id`, `os_family`, `node_version`, `skill_name`, `correlation_id`.
5. Calls `fireAndForget(event, { iKey, collectorUrl })`. Returns `{ emitted: true, skillName }`.

All try/catch blocks exit gracefully — telemetry failures never propagate.

### `plugins/power-pages/hooks/run-user-prompt-telemetry.js` (new)

Thin wrapper. Reads stdin, calls the shared helper, exits 0.

```js
#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

let emitFromPrompt, hookUtils;
try {
  emitFromPrompt = require(path.join(TELEMETRY_DIR, "lib", "emit-from-prompt"));
  hookUtils = require(path.join(PLUGIN_ROOT, "scripts", "lib", "powerpages-hook-utils"));
} catch {
  process.exit(0);
}

function readPluginVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    ).version || "unknown";
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
  let parsed;
  try { parsed = JSON.parse(raw); } catch { process.exit(0); }

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
    // fail closed
  }

  process.exit(0);
})().catch(() => process.exit(0));
```

### `plugins/power-pages/hooks/hooks.json` (modified)

Add:

```json
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
```

`UserPromptSubmit` takes no `matcher` field.

### `shared/telemetry/sync-to-plugin.js` (unchanged)

Already copies all of `lib/` into adopting plugins via `copyDir`. The two new helpers land in `plugins/<plugin>/scripts/lib/telemetry/lib/` automatically on the next sync run. No changes needed to the sync script itself.

### `shared/telemetry/tests/sync-to-plugin.test.js` (modified)

Extend the existing file-list assertion to include `lib/prompt-detector.js` and `lib/emit-from-prompt.js` in the synced copy.

## Data Flow — the Failure Case We're Fixing

1. User types `/power-pages:add-seo`.
2. Claude Code fires `UserPromptSubmit` with payload `{ prompt: "/power-pages:add-seo", ... }`.
3. The new hook reads stdin, calls `emitSkillStartedFromPrompt`.
4. `detectSlashCommand` matches `add-seo`, a tracked skill → returns `"add-seo"`.
5. The helper reads `plugins/power-pages/scripts/lib/telemetry/ikey.json` (currently placeholder), builds `skill_started`, calls `fireAndForget`.
6. Dispatcher receives the event → consent check passes → `keyMissing === true` → `writeLocalLog` → appends to `~/.power-platform-skills/events.jsonl`.
7. Hook exits 0. Claude Code proceeds to inline `SKILL.md` into the prompt for the assistant.

When the real iKey is provisioned and synced, step 6 switches to the HTTPS POST path — no code change required.

## Consent, Failure, Event-Shape Invariants

- **Consent gate:** unchanged. The dispatcher re-reads consent on every run; a slash-command invocation on `disabled` consent state writes nothing, same as every other emission path.
- **Env off-switch:** `POWER_PLATFORM_SKILLS_TELEMETRY=0` continues to disable emission regardless of consent.
- **Fail closed:** every try block in the new code exits 0 on error. No hook failure can block the user's prompt from reaching the model. Hook timeout is 30 s, matching the existing hooks.
- **Allowlist:** the new helper uses `buildSkillStarted` without any new fields. No changes to `events.js`, the allowlist, or allowlist tests.
- **No new PII surface:** the new code only extracts the skill name from the slash command marker. No prompt body, no user text, no file paths reach the dispatcher.

## Testing

- **Unit — `shared/telemetry/tests/prompt-detector.test.js` (new).**
  - Strict match at prompt start with and without leading whitespace.
  - Casual mid-sentence mentions return `null`.
  - Unknown skill names (not in `trackedSkills`) return `null`.
  - Substring skills (`add-seo-extra` does not match `add-seo`).
  - Arg suffixes tolerated (`/power-pages:add-seo --foo`).
  - Case sensitivity — plugin and skill names are lowercase; a prompt `/Power-Pages:Add-SEO` does not match (matches the existing lower-case convention in `detectTrackedSkill`).
- **Unit — `shared/telemetry/tests/emit-from-prompt.test.js` (new).**
  - Stubbed `fireAndForget` captures the event; assert event shape matches `buildSkillStarted` output.
  - Verify `iKey` / `collectorUrl` from `ikey.json` are passed through.
  - Verify no emit when detection returns `null`.
- **Integration — `plugins/power-pages/hooks/tests/run-user-prompt-telemetry.test.js` (new).**
  - Spawn the hook script with a fake stdin payload and `POWER_PLATFORM_SKILLS_FAKE_HTTPS` probe.
  - Assert the probe file is written with a well-formed envelope.
  - Mirrors the existing pretool hook integration test.
- **Updated — `shared/telemetry/tests/sync-to-plugin.test.js`.**
  - Extend the file-presence assertion to include the two new library files.

## Rollout

1. Land the shared-library additions (`prompt-detector.js`, `emit-from-prompt.js`, tests).
2. Land the new hook file and hooks-json entry for Power Pages.
3. Run `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages` to propagate.
4. Verify locally by invoking `/power-pages:add-seo` and confirming a new line appears in `~/.power-platform-skills/events.jsonl`.

## Known Issue — `skill_completed` on the Programmatic Path Has a Semantic Gap

Not introduced by this spec, but worth flagging here so downstream readers interpret the data correctly.

`PostToolUse:Skill` fires when the `Skill` tool *returns its result to the assistant* — i.e., when `SKILL.md` finishes loading into context. The skill's phases, `AskUserQuestion` pauses, and validator-relevant state mutations all happen in the assistant's subsequent turns, after `PostToolUse` has already fired.

Consequently, for programmatically invoked skills:

- **`duration_ms`** measures the time to read `SKILL.md`, not the runtime of the workflow. In practice, near-zero on every run.
- **`outcome`** is the validator's verdict at the moment the skill was *loaded* — before any of its phases have executed. Validators like `validate-seo.js` / `validate-activation.js` are designed to check post-workflow artifacts, so running them pre-workflow most often produces vacuous "success" regardless of what the skill actually did.
- **`error_class`** is always `""` because errors raised during the workflow occur after `PostToolUse` has already emitted.
- **Correlation cleanup is unreliable in practice.** Stale `ppskills-corr-<skill>.json` files were observed in `/tmp` from prior sessions, suggesting the `PostToolUse` hook doesn't always fire (or crashes before `correlationLib.clear`), which in turn means some `skill_started` events never get a matching `skill_completed`.

This spec does not fix that. It ships slash-command `skill_started` telemetry on the narrower scope originally requested, matching the shape of the existing programmatic `skill_started` emission. A future spec should decide whether to:

1. Remove `skill_completed` from both paths — because no hook point in Claude Code reliably corresponds to "skill workflow finished."
2. Keep `skill_completed` but rename the event and the `duration_ms` / `outcome` fields to reflect what they actually measure (skill load time, validator-on-load verdict).
3. Introduce a new Claude Code hook (upstream change) that fires on skill-lifecycle end rather than tool-lifecycle end.

Until one of those lands, `skill_completed.duration_ms` and `skill_completed.outcome` should be treated as diagnostic-only, not as usage metrics.

## Future Work (out of scope for this PR)

- **`invocation_source` field on `skill_started`.** Promote the distinction between `"slash"` and `"skill_tool"` from an inference to a first-class event field. Requires adding the field to the allowlist in `events.js`, updating the builder, extending the telemetry spec, and reissuing consent review if analytics treat the new field as PII-adjacent (it is not, but the review is the process).
- **Completion signal for slash-invoked skills.** If a reliable signal emerges (e.g., a Claude Code hook that fires on skill-lifecycle end, not session-lifecycle end), revisit emitting `skill_completed` for this path.
- **Fix `skill_completed` on the programmatic path.** Address the semantic gap documented in *Known Issue* above. Likely a separate spec — the right solution probably requires either removing the event or a Claude Code upstream change.
- **Generalize to other adopting plugins.** When a second plugin adopts telemetry, the per-plugin `run-user-prompt-telemetry.js` wrapper can be templatized or factored further. For one adopter, the current shape is the right amount of abstraction.

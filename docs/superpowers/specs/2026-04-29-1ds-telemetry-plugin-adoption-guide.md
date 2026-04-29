# 1DS Telemetry — A Walkthrough for Plugin Owners

**Date:** 2026-04-29 · **Author:** Amit Joshi
**For:** Folks owning `canvas-apps`, `code-apps`, `mcp-apps`, `model-apps`
**Status:** Work in progress. The cluster currently wired up is a **testing-only** iKey we used to validate the pipeline end-to-end. The plan is for **each plugin to configure its own cluster** before any real adoption.
**Hope:** Share what we built for `power-pages`, hear what you'd want different, and make adoption easy if you're up for it.
**Engineering critique companion:** `2026-04-27-1ds-telemetry-team-presentation.md`

---

## Agenda

| § | Topic | Time |
|---|---|---|
| 1 | What we built | 2 min |
| 2 | A few decisions worth flagging | 5 min |
| 3 | What's shared vs what would live in your plugin | 2 min |
| 4 | If you'd like to adopt — a suggested path | 4 min |
| 5 | How we've been verifying things land | 1 min |
| 6 | Open questions and likely concerns | 1 min |

---

## 1. What we built

- A **shared, Node-only** telemetry library at `shared/telemetry/`.
- **Zero npm dependencies** — built on `https`, `child_process`, `fs`, `crypto`. We wanted to avoid adding an install step to any plugin.
- Four lifecycle events to **Microsoft 1DS / OneCollector**:
  - `skill_started` / `skill_completed`
  - `script_started` / `script_completed`
- Today, events land in Kusto table **`PowerPlatformExtensionEvent`** via a **testing-only iKey** (routing tuple: `iKey` + `envelope.name="VscodeEvent"`). Per-plugin clusters are the next step — the test cluster was just to prove the pipeline works.
- **Default-on with opt-out.** No first-run prompt — happy to revisit if any of you feel differently.
- **Fail-closed.** A detached child owns the POST so the parent never blocks.
- First adopter is **`power-pages`**, and Kusto landing is verified end-to-end.

> The hope is that you mostly **inherit configuration knobs**, not code.

---

## 2. A few decisions worth flagging

These are choices we landed on for `power-pages`. Each comes with a tradeoff. If any of them feel wrong for your plugin, that's exactly the kind of feedback we'd love before you adopt.

### 2.1 Raw `node:https` instead of the `@microsoft/1ds-*` SDK

- **Reasoning.** We wanted to keep marketplace plugins free of `npm install`. A POC showed identical Kusto landing either way.
- **Tradeoff.** When 1DS evolves the wire format, we'll own the migration ourselves. The surface is small — one envelope builder.

### 2.2 Detached child dispatcher instead of an inline POST

- **Reasoning.** Hooks have a 30 s timeout and sit on the user's critical path. Detached spawn returns in **~50 ms** regardless of network conditions, which felt important for UX.
- **Tradeoff.** If a process supervisor or antivirus kills the child early, the event is silently dropped. We chose simplicity over a retry queue, but we're open to revisiting if your environment makes drops more common.

### 2.3 Strict allowlist instead of a runtime PII scrubber

- **Reasoning.** Allowlists fail safe — a forgotten field doesn't ship. Scrubber regexes can fail open. The allowlist sits in one place (`lib/events.js`) and CI asserts the keyset.
- **Tradeoff.** Adding a new field means editing the builder *and* updating the privacy reference doc. We've found this friction useful, but we'd love to know if it gets in your way.

### 2.4 Default-on with opt-out, not an interactive prompt

- **Reasoning.** An earlier iteration prompted on first run. It cost the very first invocation per machine and added friction users didn't ask for. Given the allowlist already prevents PII, we felt default-on was defensible.
- **What this means for you.** You wouldn't need to add a Phase-1 consent block to your skills. If your plugin's audience expects an opt-in posture, please flag it — we can talk through it.

### 2.5 Sync script instead of git submodule or npm package

- **Reasoning.** Submodules can break for users who clone non-recursively, and a private npm package would force an install step. The sync script is ~30 lines and produces a self-contained plugin.
- **Tradeoff.** Drift if someone hand-edits the synced copy. Convention so far: edit `shared/`, re-run sync, never touch the synced files directly.

---

## 3. What's shared vs what would live in your plugin

### 3.1 Shared (we'd ask you not to edit these in your plugin)

| Thing | Where |
|---|---|
| Library (13 files) | `shared/telemetry/lib/` |
| Privacy / opt-out doc | `shared/telemetry/references/telemetry-consent-reference.md` |
| Sync tool | `shared/telemetry/sync-to-plugin.js` |
| Opt-out env var name | `POWER_PLATFORM_SKILLS_TELEMETRY` |
| Consent file path | `~/.power-platform-skills/telemetry.json` |

### 3.2 Yours to configure

| Thing | What you'd provide |
|---|---|
| iKey + collector URL | Your own — provisioned per plugin, dropped into the synced `scripts/lib/telemetry/ikey.json` |
| Plugin name | A string literal in your hooks + telemetry-runner |
| Plugin version | Already in `.claude-plugin/plugin.json` — hooks just read it |
| Tracked skills | A `{ skill-name: { validatorScript } }` map |
| Hook entry points | Three thin wrappers (~80 lines each) |
| `withTelemetry` adoption | Wrap whichever Node scripts you want instrumented |

> **iKey ownership.** The current `shared/telemetry/ikey.json` carries our **testing iKey** — handy for proving the pipeline lands data in Kusto, but not what anyone should ship with. Before you adopt for real, we'd suggest provisioning your own iKey + Kusto stream so your data and dashboards stay yours. We can help walk through the tenant-side setup if it's new ground.

---

## 4. If you'd like to adopt — a suggested path

We've ballparked this at ~30 minutes for a plugin that already has hooks. Happy to pair on the first one with whoever wants to try.

### Step 1 — Sync the library

```bash
node shared/telemetry/sync-to-plugin.js --target plugins/<your-plugin>
```

You'll get:

```
plugins/<your-plugin>/
├── scripts/lib/telemetry/
│   ├── ikey.json
│   └── lib/                       # 13 files
└── references/telemetry-consent-reference.md
```

Worth noting in your CLAUDE.md / AGENTS.md: the synced copy is generated — edits should go in `shared/`, then a re-sync.

> **Heads-up on `ikey.json`.** The synced file initially carries our testing iKey. Before you ship anything, replace it with the iKey + collector URL for the cluster your team owns. (We'll likely add a `--ikey` flag to the sync script to make this less manual — happy to take input on the shape.)

### Step 2 — Define your tracked skills

Somewhere like `scripts/lib/<your-plugin>-hook-utils.js`:

```js
const TRACKED_SKILLS = {
  "create-something": { validatorScript: "scripts/validators/create-something.js" },
  "deploy-something": { validatorScript: "scripts/validators/deploy-something.js" },
};

function getTrackedSkillFromToolInput(toolInput) {
  // see plugins/power-pages/scripts/lib/powerpages-hook-utils.js for a reference
}

module.exports = { TRACKED_SKILLS, getTrackedSkillFromToolInput };
```

> **A small gotcha we hit:** keys are skill names **without** the plugin prefix — `create-site`, not `power-pages:create-site`. The slash-command detector adds the prefix at match time.

### Step 3 — Wire the three hooks

Easiest start is to copy from `plugins/power-pages/hooks/` and adjust two things per file:

| File | Change 1 | Change 2 |
|---|---|---|
| `hooks.json` | (no change needed) | (no change needed) |
| `run-skill-pretool-telemetry.js` | `plugin_name: "<your-plugin>"` | swap the hook-utils require |
| `run-skill-posttool-validation.js` | same | same |
| `run-user-prompt-telemetry.js` | `pluginName: "<your-plugin>"` | swap the hook-utils require |

### Step 4 — Optional: instrument scripts with `withTelemetry`

If there are Node scripts in your plugin you'd like signal on, copy `plugins/power-pages/scripts/lib/telemetry-runner.js` (changing the plugin name string), and then:

```js
const { runInstrumented } = require("./lib/telemetry-runner");

(async () => {
  await runInstrumented("deploy-something", async () => {
    // your existing script body
  });
})();
```

`outcome` is derived from whether the function throws, and the original error is rethrown unchanged.

### Step 5 — Mention the opt-out in your README

Something like:

```
Anonymous telemetry is enabled by default. See
references/telemetry-consent-reference.md for details and opt-out instructions.
```

Linking the synced doc keeps you in sync with future updates without you having to track them.

---

## 5. How we've been verifying things land

Two stages — local first, Kusto second.

### Local — placeholder iKey

If you sync without provisioning a real iKey, the dispatcher writes events to `~/.power-platform-skills/events.jsonl`. Run a tracked skill, then:

```bash
tail -n 5 ~/.power-platform-skills/events.jsonl | jq .
```

You should see your `plugin_name` and the right `skill_name`.

### Kusto — real iKey

The query below is what we ran against the testing cluster (table `PowerPlatformExtensionEvent`). Once you're on your own cluster, swap in your table name — the `EventInfo` shape stays the same.

```kusto
PowerPlatformExtensionEvent       // ← your table name once you're on your own cluster
| where TimeGenerated > ago(15m)
| extend info = parse_json(EventInfo)
| where tostring(info.plugin_name) == "<your-plugin>"
| project TimeGenerated, EventName,
          plugin = tostring(info.plugin_name),
          skill = tostring(info.skill_name),
          outcome = tostring(info.outcome)
| order by TimeGenerated desc
```

A couple of things to look for:

1. `EventName` matches one of the four event types.
2. `correlation_id` matches between `_started` and `_completed`.

> **Something we learned the hard way:** `acc:1` from OneCollector is wire-layer ack only — it doesn't mean ingestion succeeded. The Kusto query above is the real check.

---

## 6. Open questions and likely concerns

We'd genuinely like input on these.

**Could I add a custom field?**
Definitely possible — the path is `shared/telemetry/lib/events.js` (allowlist) + the privacy doc + a CI test asserting the new keyset. We've kept the surface small on purpose; if you have fields in mind, let's talk through them and add together.

**My plugin would prefer its own Kusto stream / dashboard owner.**
That's exactly the direction we're heading. The current shared iKey is just a testing setup we used to validate the pipeline; **per-plugin clusters are the planned default**. Practically that means each plugin provisions its own iKey + tenant annotation and drops the values into the synced `ikey.json`. Happy to walk through the tenant-side bits with anyone for whom this is new.

**Will this affect my existing PostToolUse validator?**
It shouldn't. In `power-pages`, telemetry was folded around the existing validator, and the validator's exit code is preserved. If your validator setup looks different, happy to walk through it together.

**What about `--plugin-dir` dev mode?**
Worth flagging: hooks don't register under `--plugin-dir` (Claude Code limitation). The slash-command path covers user-typed `/plugin:skill` invocations, but auto-invoked skills in dev mode aren't captured. End-to-end verification needs a marketplace install.

**Why one consent file across all plugins, not per-plugin?**
Our intuition was that users think of this as "Power Platform Skills telemetry" rather than per-plugin telemetry, so a single opt-out covers everything. If your audience would expect per-plugin consent, we'd love to hear that — it's not a hard call to revisit.

---

## 7. References

| Doc | What it's for |
|---|---|
| `2026-04-20-1ds-telemetry-design.md` | Full internal design spec |
| `2026-04-27-1ds-telemetry-team-presentation.md` | Engineering critique companion |
| `shared/telemetry/README.md` | Field reference + sync command |
| `shared/telemetry/references/telemetry-consent-reference.md` | What's sent, what isn't, how to opt out |
| `plugins/power-pages/hooks/` | Reference impl: all three hooks |
| `plugins/power-pages/scripts/lib/telemetry-runner.js` | Reference impl: `withTelemetry` shim |

> If anything here contradicts the code, the code is the source of truth — please flag it and we'll update the doc.

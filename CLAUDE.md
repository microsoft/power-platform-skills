# Power Platform Skills - Development Guidelines

This file provides guidance to AI Agents when working with code in this repository.

## What This Repo Is

A **plugin marketplace** for Power Platform development by Microsoft. The Open Plugins marketplace manifest (`marketplace.json`) references individual plugins in `plugins/`. Each plugin has its own `AGENTS.md` with plugin-specific guidance.

## Repository Structure

```
power-platform-skills/
├── marketplace.json          # Open Plugins marketplace manifest (lists all available plugins)
├── .claude-plugin/           # Legacy manifest mirrors for existing subscriptions
│   └── marketplace.json
├── plugins/                  # Directory containing individual plugins
│   └── <plugin-name>/        # Individual plugin (e.g., power-pages)
│       ├── .plugin/
│       │   └── plugin.json   # Plugin manifest
│       ├── .claude-plugin/
│       │   └── plugin.json   # Legacy manifest mirror
│       ├── AGENTS.md         # Plugin-specific development guidelines
│       ├── agents/           # Agent persona files
│       ├── commands/         # Command entry points
│       ├── shared/           # Shared resources and documentation
│       └── skills/           # Skill workflows (SKILL.md in subdirectories)
├── shared/                   # Cross-plugin shared resources
│   └── skills/               # Shared skill definitions
│       └── <skill-name>/     # SKILL.template.md + workflow .md files
├── AGENTS.md                 # Generic development guidelines (this file)
└── README.md                 # Repository overview
```

## Local Development

Test a plugin locally by launching your AI agent with the plugin path:

```bash
claude --plugin-dir /path/to/plugins/<plugin-name>
```

No root-level build, lint, or test commands exist. Build/test tooling lives inside each plugin.

## Plugin Conventions

Each plugin follows this structure:

- `.plugin/plugin.json` — Open Plugins metadata (name, version, keywords)
- `.claude-plugin/plugin.json` — legacy mirror of `.plugin/plugin.json` kept for existing subscriptions
- `.mcp.json` — MCP server configuration (optional)
- `agents/` — Agent definitions (`.md` files with YAML frontmatter)
- `skills/` — Skill definitions, each in its own subdirectory with a `SKILL.md`
- `scripts/` — Shared utility scripts referenced by skills and agents
- `references/` — Shared reference documents used by multiple skills

Skills are defined in `SKILL.md` files with YAML frontmatter (name, description, allowed-tools, model, hooks). The `allowed-tools` field must use a **comma-separated list** (e.g., `allowed-tools: Read, Write, Edit, Bash, Glob, Grep`) — not JSON array syntax (`["Read", "Write"]`) or YAML list syntax. Each skill may include validation scripts in a `scripts/` subdirectory, run as Stop hooks when the skill session ends.

## Cross-Plugin Shared Skills

Skills that apply to all plugins live in `shared/skills/<skill-name>/`. The workflow logic is written once in a shared `.md` file, and each plugin has a thin `skills/<skill-name>/SKILL.md` that contains only the YAML frontmatter and a reference to the workflow path bundled inside that plugin at install time.

**Pattern:**
- `shared/skills/<skill-name>/<workflow>.md` — Full workflow (phases, instructions, field definitions)
- `shared/skills/<skill-name>/SKILL.template.md` — Template SKILL.md (frontmatter + reference to workflow); supports `{{PLUGIN_NAME}}` placeholder
- `plugins/<plugin>/skills/<skill-name>/SKILL.md` — Per-plugin wrapper generated from the template above
- `plugins/<plugin>/skills/<skill-name>/<workflow>.md` — Symlink to the shared workflow when the plugin must work after installing only its own plugin directory

This keeps the skill discoverable in each plugin while preserving install-time portability. Marketplace installs copy only the plugin directory, so per-plugin wrappers must not reference repo-root `shared/` paths at runtime. Instead, point the wrapper at `${PLUGIN_ROOT}/skills/<skill-name>/<workflow>.md` and keep a symlink from that per-plugin path to the repo-root shared workflow; marketplace installers dereference same-marketplace symlinks into the installed plugin cache. When updating a shared skill, edit the workflow file and/or `SKILL.template.md` in `shared/`, then update the per-plugin wrappers (frontmatter + bundled workflow reference, with `{{PLUGIN_NAME}}` substituted) and ensure any per-plugin symlinks still resolve under `plugins/<plugin>/skills/<skill-name>/`. Commit the shared source and per-plugin symlinks together.

## Shared Telemetry

1DS telemetry code for all plugins lives at `shared/telemetry/`. Each adopting plugin **symlinks** the library into its own tree — `plugins/<plugin>/scripts/lib/telemetry/lib` is a symlink to `shared/telemetry/lib`. The marketplace installer dereferences that symlink into the installed plugin at install time, so the shared code ships without copying it into each plugin. Each plugin keeps its own real `ikey.json` next to the symlink.

Edit `shared/telemetry/` directly — the symlink makes changes live for every adopting plugin immediately; there is nothing to re-sync.

Per-plugin iKey/collector routing is pluggable via a `resolver.js` placed next to the plugin's `ikey.json` (implementing the `resolve`/`isProvisioned` contract); the shared library ships only that contract plus a static-key fallback, not any routing logic. A per-plugin opt-out env var `POWER_PLATFORM_SKILLS_TELEMETRY_<PLUGIN>_OPTOUT` (derived as the uppercased plugin name with non-alphanumerics collapsed to `_`, suffixed `_OPTOUT`) disables transmission for automation when set to `1`/`true` (dotnet `*_TELEMETRY_OPTOUT` convention); it has the **highest precedence**, overriding both the persisted `config.json` choice and `/<plugin>:telemetry on`.

### CI must opt out of telemetry transmission

An adopting plugin's committed `ikey.json` ships **enabled** (`disabled: false`) with a real production instrumentation key, so any process that runs a telemetry-emitting hook or script **without isolating emission** will POST a real (but fake-in-content) event to the production collector. CI runs are not real usage, and such events pollute the production telemetry stream.

**Therefore: every GitHub Actions job that runs the test suite — or any step that could execute a telemetry-emitting hook/script for an adopting plugin — MUST set the plugin's opt-out env var at the job (or workflow) level.** For `power-pages`:

```yaml
jobs:
    <job-name>:
        runs-on: <runner>
        env:
            POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "1"
        steps: ...
```

This opt-out suppresses **transmission only** (the local diagnostic mirror is still written), so it is safe and has no effect on what the job actually tests. Tests that need to assert that emission *happens* clear the var in their own spawned-process env and route the event to a local `POWER_PLATFORM_SKILLS_FAKE_HTTPS` probe instead of the real collector — so the job-level opt-out never breaks them. Existing reference: `.github/workflows/power-pages-script-tests.yml`. When you add a new such workflow (or a new emitting step to an existing one), add this env var in the same change; treat a CI job that runs the tests without it as a production-telemetry leak.

Current adopters: `power-pages`. Others adopt on demand.

## Legacy Marketplace Compatibility

Keep the root `.claude-plugin/marketplace.json` and each plugin's
`.claude-plugin/plugin.json` as JSON mirrors of their Open Plugins counterparts.
The shared root marketplace must stay dual-compatible: use repository-root-relative
plugin `source` paths and preserve legacy `category`/`tags` fields alongside Open
Plugins metadata. Existing marketplace subscriptions may still resolve the legacy
paths during auto-update, so removing or drifting these files can force users to
reinstall. Because mirrors are committed files (not symlinks), update both source
and legacy copies together, then run
`node scripts/validate-legacy-compatibility.js` after metadata changes.

## Code Conventions

**DRY (Don't Repeat Yourself):** Never duplicate logic across files. Each plugin has shared utilities (e.g., `scripts/lib/`) and shared reference docs (e.g., `references/`). Always check for and reuse existing helpers before writing new code. When adding shared logic, put it in the plugin's shared modules — not in individual skill directories.

### Code comments

Most code in this repo is Node.js scripts and hooks that shell out to `pac`/`az`, call the Dataverse and Power Platform APIs, and parse loosely structured CLI output. The reasoning behind a line is rarely obvious from the line alone, so comments matter.

* Err on the side of over-commenting code when the reasoning is not obvious. Comments should explain **WHY** code is written a particular way; the **WHY** is the most important part.
* Do comment non-obvious implementation details: concurrency hazards, lifecycle constraints, compatibility requirements, platform quirks, upstream PAC CLI / Dataverse workarounds, and intentional deviations from the obvious helper or API.
* When parsing strings, logs, CLI output, OData payloads, or other loosely structured data, include a comment with an example of the raw format being parsed. Show edge cases, escaping rules, delimiters, optional fields, or malformed-but-observed inputs when they affect the parser.
* When code follows an external standard, protocol, or Power Platform convention (Dataverse status codes, OData error shapes, telemetry field contracts), include valid links to the relevant Microsoft Learn or specification source so future readers can verify the rule and understand why the code follows it.
* When code touches telemetry, auth tokens, or anything privacy/security-sensitive, explain the scope, the opt-in/fail-closed behavior, and **why** — not just what it does.
* Do not add comments that simply narrate clear code, such as "set the interval" immediately before assigning an interval.
* Keep workaround comments close to the workaround. Include an issue link when the workaround is tied to an upstream bug, and describe the condition for removing it when that is known.

Good comments explain the constraint or tradeoff:

```javascript
// `pac auth who` cold-starts the .NET runtime (~4s on Windows), so cache the parsed
// result per process — repeated hook invocations must only fork the CLI once.
let cachedAuth;
```

```javascript
// Refresh the bearer token roughly every 60s instead of on every poll. A long solution
// export outlives the token's lifetime, but refreshing each 5s cycle would hammer the
// az CLI for no benefit.
const tokenRefreshEvery = Math.max(1, Math.floor(60000 / intervalMs));
```

```javascript
// Telemetry must never break the hook it runs inside, so this is fail-closed: a missing
// executable, a timeout, or an unparseable banner all resolve to null rather than throw.
return null;
```

```javascript
// Allowlist-only scrubbing: the event spec already restricts payload fields to values
// that cannot carry PII, so this is a documented seam for a future regex pass — not a
// no-op left unfinished by mistake.
function scrub(value) {
  return value;
}
```

Code that follows an external standard or convention should link the source:

```javascript
// Dataverse asyncoperations terminal states: statecode 3 (Completed) with statuscode 30
// (Succeeded) means done; 31 (Failed) and 32 (Canceled) are the failure terminals.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/asyncoperation
if (statecode === 3 && statuscode === 30) {
  return { status: 'Succeeded' };
}
```

Keep workaround comments next to the workaround and link the tracking issue:

```javascript
// Workaround: `pac solution export` can exit 0 while the Dataverse async job is still
// running, so ignore the exit code and poll asyncoperations to a terminal state instead.
// Remove once the CLI blocks on the job result.
// Tracking: https://github.com/microsoft/power-platform-skills/issues/1234 (use the real issue)
const status = await pollAsyncOperation(asyncJobId, envUrl, token);
```

Parsing comments should show the raw shape and important edge cases:

```javascript
// Parse the `pac auth who` banner, a label/value block, e.g.:
//   Authority:    https://login.microsoftonline.com/<tenant>
//   Tenant ID:    00000000-0000-0000-0000-000000000000
//   User:         user@contoso.com
// Values can themselves contain ':' (URLs), so match only up to the first colon after
// the label, then trim. The JSON profile files are intentionally NOT parsed — that
// format is internal and varies across PAC CLI versions.
// `label` is a fixed, code-controlled string (e.g. 'Tenant ID'), so it is safe to
// interpolate into the pattern. If a label ever comes from untrusted input, escape it
// first to avoid regex injection.
const re = new RegExp('^\\s*' + label + '\\s*:\\s*(\\S.*?)\\s*$', 'im');
```

```javascript
// Dataverse OData errors arrive as:
//   { "error": { "code": "0x80040217", "message": "..." } }
// but some PAC surfaces capitalize the envelope as "Error", so check both before
// falling back to plain-text pattern matching.
const odataError = parsed.error || parsed.Error;
```

Avoid comments that restate the code:

```javascript
// Set the interval to five seconds.
const intervalMs = 5000;

// Loop over the findings.
for (const finding of findings) {
  report(finding);
}
```

## Maintaining This File

When you add new plugins or change the repository-level structure, update this file. For plugin-specific changes, update the plugin's own `AGENTS.md` (e.g., `plugins/power-pages/AGENTS.md`).

## External Documentation

- <a href="https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites">Power Pages Code Sites</a>
- <a href="https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages">PAC CLI Reference</a>
- <a href="https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites/create-website">Create Website API</a>

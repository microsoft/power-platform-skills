# Phase 1 of 10 — Intake

**Steps:** 0–2d. **Previous:** Start. **Next:** [2 — Planning](phase-02-planning.md).
[Phase index](../SKILL.md#load-only-the-active-phase). Advance only after this phase's exit condition passes.

Read only for a new invocation or confirmed intake resume. This phase collects facts without
writing an app plan or changing the supplied template before the Step 2c approval.
Load [CLI guidance](${PLUGIN_ROOT}/shared/shared-instructions-cli.md) for CLI/auth work.

### Step 0 — Resume check + fresh-template gate

**Telemetry checkpoint: `validate_fresh_template`**

Resolve `working_dir` from arguments or the user's named folder. If `memory-bank.md` exists,
read it and offer resume from the first incomplete step using its stored facts. Confirm before
resuming; a corrupt bank requires a user choice to repair or replace, not silent overwrite.
The bank is the only resume mechanism; package files/dependencies alone do not prove prior progress.
On confirmed resume, verify relevant artifacts and approvals; a populated draft is not approval.

Without a confirmed resume, require all of `package.json`, `app.config.js`, `auth.config.json`,
`tamagui.config.ts`, and `node_modules/expo`. Reject existing `memory-bank.md`,
`native-app-plan.md`, `.datamodel-manifest.json`, or `src/generated/services/*.ts`.

| Failure | Action |
|---|---|
| Missing template files / already-created app | STOP: materialize `microsoft/power-platform-skills/plugins/mobile-apps/template#main` with `degit` into a new folder, install dependencies, rerun |
| Missing `node_modules/expo` | STOP: user runs `npm install` in that template folder |

Do not materialize templates, provision npm/ADO feed tokens, change registries, repair/adopt an
existing app or erase creation markers. Step 5 removes only an empty config placeholder.

### Step 1 — Prerequisites

**Telemetry checkpoint: `validate_development_toolchain`**

Read [version-check.md](${PLUGIN_ROOT}/shared/version-check.md), Always required tier only.
Check Node 22+, npm 10+, Azure CLI login (for Dataverse helpers); git is optional.
Do not probe Xcode, Java, Android Studio or CocoaPods. Native builds/deploy are separate.
Npm feed access, Azure login and standalone Power Apps CLI authentication are separate accounts.
Required global installs still need confirmation; this skill never installs baseline dependencies.

Capture intended environment ID from populated `power.config.json`, then memory bank on resume,
then user input. Confirm any requested switch. **Do not call the environment resolver yet**:
it can persist an auth cache. Resolve only after Step 2c proceeds.

### Step 1.7 — Detect publisher prefix (deferred)

Execute only after Step 2c proceeds and mode is `required`:

```bash
node "${PLUGIN_ROOT}/scripts/detect-publisher-prefix.js" "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID"
```

Use the detected Default-solution prefix literally in proposed names. A null/nonzero result is
a concern, not an invented prefix: use `cr` as an explicitly provisional placeholder and require
actual prefix reconciliation/reapproval before executable mutation. Preserve verified existing
table prefixes; never sweep names belonging to standard/managed/other-publisher tables.
For `connector-only`, set the detected prefix to empty and make no Dataverse prefix query.

### Step 2 — Gather requirements

**Telemetry checkpoint: `gather_app_requirements`**

Reuse answered arguments. If no description exists, ask what users need to accomplish and who
uses the app. Collect display name, target platforms (default iOS + Android), and intended
environment ID with the foreground question interface. Preserve supplied aesthetic/brand
constraints, but defer brand/style choices to `/design-system`.
Derive a kebab-case ASCII slug; show it at Step 2c for correction rather than asking separately.

### Step 2b — Requirements discovery

Use the existing four richness signals only to reduce redundant discovery questions:
description ≥60 words; ≥5 distinct domain nouns; ≥3 workflow verbs (log, track, submit, assign,
notify, scan, upload, approve, verify, complete, capture, override, dispatch, review, sign);
known industry/domain phrase from
[universal-patterns.md](${PLUGIN_ROOT}/shared/references/universal-patterns.md).
These are not table/screen counts or execution targets.

| Score | Tier | Action |
|---|---|---|
| 4/4 | `auto-plan` | Extract brief in memory and show it transparently; no placeholder file |
| 3/4 | `one-tap` | Show extracted brief; ask only consequential unresolved facts |
| ≤2/4 | `walk-through` | Read [requirements-discovery.md](requirements-discovery.md), use its smallest focused questions, then summarize |

`--full-discovery` forces walk-through; `--no-discovery` skips only discovery questions, not
preview or later approvals. Preserve actors, primary jobs and intended outcomes, workflow,
data/write targets, integrations, native/artifact needs and explicit constraints in the existing
brief **before data planning**; do not introduce another requirements contract.
Capture known domain rules that distinguish business states and authorize consequential
transitions. Clarify only unknowns that would change the outcome; do not infer business policy
from status labels, colors, or an industry name.
Forward the confirmed brief verbatim;
do not expand it into a noun inventory masquerading as a screen plan.
After proceed, Step 3 turns it into a separate Experience outline and Information needs before
data proposals. Preserve supplied facts; classify inferred presentation, sample values and
proposed business scope rather than treating a short prompt as permission for a thin app.
On adjustment, revise with the user's answers; on start over, return to the description.
Do not force a generic feature picker or reconfirm an already approved brief. Step 2c captures
the final proceed/edit/abort decision, including the summarized brief.

Classify `<dataverse_planning_mode>`:

- `connector-only` only if **every record source/write target** is an explicit non-Dataverse
  system and there are no app-owned rows, Dataverse offline data, retained File/Image artifacts,
  existing Dataverse tables, or Dataverse-backed native capabilities.
- `required` otherwise, including ambiguity. A named connector alone proves nothing.

Keep exact-target needs (reuse/extend, existing/managed targets, collision, computed-column,
relationship or customizability facts) explicit. Required planning never degrades to unverified
executable schema when evidence fails.
Set `visual_companion: yes`, `design_vibe_opt_in: deferred`; `--no-design` instead sets
`visual_companion: no`, `design_vibe_opt_in: skip`. Do not write these to disk yet.

### Step 2c — Plan preview (always shown, before writes)

Show a compact factual preview from the brief already in memory:

- Display name, derived slug, platforms and intended environment ID.
- Primary users/journeys and known data systems/integrations, distinguishing facts from assumptions.
- Dataverse mode and unresolved decisions; actual table/screen counts are **not yet known**.
- Approval sequence: data model → native capabilities + connectors → screen graph → screen specs;
  brand/visual review follows scaffold. Rejected sections are revised, not the whole plan.
- Work remaining: evidence + proposals, prepare/init, data/native/connector work, screen build,
  TypeScript/route/quality gates. No promised duration or minimum spending budget.

Ask **proceed / edit brief / abort** through the foreground host's permitted question tool.
Explicit proceed is required; empty/cancel does not proceed. `--no-discovery` and `--no-design`
do not skip this preview. Do not interpret prompt richness as consent.

`edit` returns to discovery and a fresh preview. `abort` stops with no plan/app files created.
Until proceed, no plan placeholder, `.resolved-environment.json`, `.tmp` planning artifacts,
agent dispatch, install or init. Checkpoint bookkeeping is not app mutation consent.

### Step 2d — Resolve approved context; template-only mode

After proceed, resolve the chosen environment and preserve the returned non-secret context:

```bash
ENV_JSON=$(node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ACTIVE_ENV_ID")
```

Require resolved environment ID/URL/tenant; stash them as `ACTIVE_ENV_ID`, `ACTIVE_ENV_URL`,
`ACTIVE_TENANT_ID`, `ACTIVE_ENV_NAME`, and write `.resolved-environment.json` now, not earlier.
Failure: use the shared auth policy; never infer an empty inventory or initialize here.
If needed, run `az login --tenant <env-tenant>` in foreground; do not conflate CLI accounts.
Execute deferred prefix detection only for required mode.

Check app-name collision with `npx power-apps list-codeapps --environment-id <id> --json` if
that command is supported. Parse a successful response; command failure is not "no collision".
On collision ask for a different name or user-managed removal in Maker portal, then recheck.
Do not delete the existing app. Unsupported discovery can be reported as unavailable.
Changes to brief/environment return through the relevant preview/approval.

No background scaffold pipeline: the template is already installed. Continue to Step 3.

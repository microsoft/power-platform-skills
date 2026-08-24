---
name: sync-from-plan
description: Use when an existing Power Apps mobile app must be updated from native-app-plan.md after a plan edit, schema or connector change, design refresh, or prototype-to-real conversion, while preserving current navigation and screen quality gates.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, Skill
model: opus
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** - read first.

# Sync From Plan

Update an existing mobile app from its approved `native-app-plan.md`. This is
the common final screen-sync stage for both mock-backed prototypes and real
Dataverse apps. It does not scaffold, provision tables/connectors, install
native modules, or deploy.

## Inputs

- `--working-dir <path>` - default current directory.
- `--changed-screens <comma-list>` - rebuild only named screens after all
  shared gates pass.
- `--force` - rebuild every build screen.
- `--no-preview` - skip static preview.
- `--target-data-mode dataverse` - conversion-only. Require lifecycle mode
  `transitioning` with `transition.to: dataverse`; use Dataverse gates and
  commit the target mode only after every final gate passes.
- `--pending-plan-change <path>` - internal `/edit-app --apply-plan` handoff.
  The record must match the current plan/state and must already have passed
  edit-app's hash checks. Do not accept an unrelated path.

## Non-Negotiables

- Read lifecycle state from `.mobile-app/state.json` using
  [`lifecycle-state.md`](../../shared/references/lifecycle-state.md). Migrate a
  compatible legacy `.code-apps-native/state.json` only as documented there.
- In `prototype` mode, use only generated local services and never call a real
  data source.
- In `dataverse` mode, `.datamodel-manifest.json` (or the documented
  `docs/plan-artifacts/` fallback) is the field-binding source of truth.
- `transitioning` is accepted only with
  `--target-data-mode dataverse` and a matching lifecycle transition. Treat
  its effective mode as Dataverse, but leave state transitioning on failure.
- A Dataverse sync must stop if any seed file, in-memory service, or connector
  throw-stub remains.
- Preserve user-authored screen behavior that does not conflict with the
  approved plan. Do targeted updates unless `--force` was requested.
- Use the current `/create-mobile-app` navigation, shared-code, skeleton,
  builder-wave, and quality contracts. Do not maintain a forked route model.

## Progress Contract

```text
-> [sync 1/8] Reading lifecycle state and approved plan...
-> [sync 2/8] Validating data and screen contracts...
-> [sync 3/8] Reconciling generated services and navigation...
-> [sync 4/8] Updating shared code and typed skeletons...
-> [sync 5/8] Rebuilding changed screens...
-> [sync 6/8] Running route, quality, contrast, and TypeScript gates...
-> [sync 7/8] Rendering static preview...
-> [sync 8/8] Recording sync hashes and memory...
```

## Workflow

### Step 1 - Verify Project And State

Require:

```bash
test -f "$PROJECT_DIR/package.json"
test -f "$PROJECT_DIR/app.config.js"
test -f "$PROJECT_DIR/native-app-plan.md"
test -d "$PROJECT_DIR/app"
```

Read:

- `native-app-plan.md`
- `.mobile-app/state.json` or the documented legacy state
- `.datamodel-manifest.json` and
  `docs/plan-artifacts/.datamodel-manifest.json`
- `src/generated/.prototype-manifest.json`
- `power.config.json` and `.resolved-environment.json`
- `brand/design-system.md` and `brand/tokens.ts`
- `memory-bank.md`
- `.mobile-app/plan-change.json` when present

If state is absent, infer it conservatively per `lifecycle-state.md` and ask
when ambiguous. Never infer `dataverse` merely from a zero-GUID prototype
`power.config.json`.

If `.mobile-app/plan-change.json` has
`status: "approved-pending-apply"` and no matching
`--pending-plan-change <PROJECT_DIR>/.mobile-app/plan-change.json` was supplied
by `/edit-app`, STOP:

```text
BLOCKED: An approved plan-only change still needs mode-specific specialists.
Run /edit-app --apply-plan; direct sync could build screens against stale data,
connector, native, or design artifacts.
```

When the internal flag is present, independently verify current plan hash,
record data mode, and structured contract hash before continuing. Sync never
archives or deletes the pending record; edit-app does that only after this
workflow returns success.

Set `EFFECTIVE_DATA_MODE` to the current `dataMode`, except when all three
conversion conditions hold: `dataMode === "transitioning"`,
`transition.to === "dataverse"`, and `--target-data-mode dataverse` was passed.
Then set it to `dataverse`. Any other transitioning invocation is blocked and
must return to `/prototype-to-real-app`.

Capture current SHA-256 hashes for the plan and real manifest. Compare them
with `lastSyncedPlanHash` and `lastDataverseManifestHash` to determine whether
the sync is structural, data-binding-only, or already current.

### Step 2 - Validate Mode-Specific Data Contract

Run the plan contract validator first:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-contracts.js" \
  "$PROJECT_DIR/native-app-plan.md"
```

If it fails, stop and repair/re-plan the contract before writing routes or
screens.

#### Prototype Mode (`EFFECTIVE_DATA_MODE=prototype`)

Require `src/generated/.prototype-manifest.json`, at least one generated table
service when the Data Model is non-empty, and no `.datamodel-manifest.json`.
Allow mock field names and connector throw-stubs, but not direct seed imports
from app code:

```bash
grep -R "\.seed\.json" "$PROJECT_DIR/app" "$PROJECT_DIR/src" \
  --include='*.ts' --include='*.tsx' && exit 1 || true
```

#### Dataverse Mode (`EFFECTIVE_DATA_MODE=dataverse`)

Resolve `MANIFEST_PATH` from the root first, then
`docs/plan-artifacts/.datamodel-manifest.json`. Require it to contain tables
when the approved Data Model is non-empty.

Run the read-only prototype cleanup gate:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/cleanup-prototype-artifacts.js" \
  "$PROJECT_DIR" --check
```

Any non-zero result is blocking. Do not let screen-builders route around mocks.
Real `/add-dataverse` or connector provisioning must replace them first.

Treat a missing/different `lastDataverseManifestHash` as a data rebind even
when screen names did not change. Inventory every data-bound screen and every
non-generated `src/hooks`, `src/services`, `src/utils`, and shared component
that constructs a `select`, `filter`, create/update payload, choice map, or
generated-service adapter. Inspect their contracts for:

- exact read/write logical names from the manifest;
- lookup read annotations and exact `<schemaName>@odata.bind` writes;
- target entity-set names;
- choice integer/label pairs;
- file/image logical names;
- the approved formatted-lookup or bounded chained-fetch strategy.

When bindings are absent or stale, invoke `mobile-app:screen-planner` in edit
mode with the current plan and manifest. Replace only affected per-screen
contracts. Present semantic changes for approval. Do not guess a lookup schema
name or choice value inline. Shared data helpers are first-class rebind targets:
repair them before screen builders run, and include every consuming screen in
the target set when the helper's behavior changes.

### Step 3 - Reconcile Services And Navigation

Refresh the `## Generated Services (snapshot at <ISO timestamp>)` section using
the exact service files and exported methods on disk. In Dataverse mode this
snapshot must contain no mock marker; in prototype mode it must agree with
`src/generated/.prototype-manifest.json`.

Read the approved Screen Map and run `/create-mobile-app` Step 10b's current
navigation algorithm:

- normalize every route and reject duplicates;
- build outer entries from top-level files/folder roots;
- require a folder `index.tsx` when it has children;
- create/update owning inner layouts before parallel builders;
- preserve the existing auth/data-mode guard and provider logic above the
  layout return block;
- delete routes only when plan approval explicitly removed them.

Run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "$PROJECT_DIR" \
  --output ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-build-pack.js" \
  --project-root "$PROJECT_DIR" \
  --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/materialize-experience-view-model.js" \
  --project-root "$PROJECT_DIR"
npm --prefix "$PROJECT_DIR" run type-check
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
```

Do not advance from a broken route shell.

### Step 4 - Shared Code And Typed Skeletons

Reuse `/create-mobile-app` Step 10.8:

- restore missing shared scaffold files without overwriting existing ones;
- add focused shared components/hooks/utils when two or more affected screens
  share a row, status map, cursor/list hook, save helper, or formatter;
- write typed skeletons only for new/missing screens;
- patch imports/hooks surgically for existing screens;
- preserve route params and generated service contracts.
- preserve the pack-selected `ScreenShell` header mode and the generated
  `toExperienceRecord` / `getExperienceAsset` boundary; do not restore direct
  `SafeAreaView` wrappers or per-screen presentation arrays.
- rebind every shared data helper identified in Step 2 using exact manifest and
  generated-model names; lookup reads use `_<lookup>_value`, never the lookup
  navigation property in `select`;
- preserve optional/null semantics and workflow helpers shared by multiple
  screens rather than reintroducing per-screen predicates.

Skeletons contain imports, params, hooks, and `return null`; they do not anchor
builders to generic placeholder UI.

When `brand/tokens.ts` exists, reapply
`${CLAUDE_SKILL_DIR}/../design-system/references/tamagui-integration.md` before builders. Verify
that `tamagui.config.ts` merges brand `space`, `size`, and `radius` tokens and
semantic colors, and that app-owned gradients/semantic token helpers derive
from the brand palette rather than an unrelated hard-coded palette. Typography
roles that cannot be represented as root Tamagui tokens must still be consumed
by shared branded primitives; do not claim automatic integration while they
remain unused.

Run the TypeScript gate and the changed-file dispatcher for repaired shared
files before builders.

### Step 5 - Determine And Rebuild Targets

Select targets in this order:

| Condition | Target set |
|---|---|
| `--force` | Every build screen |
| `--changed-screens` | Named screens plus required navigation parents |
| Missing route file | Missing screen |
| Screen spec hash changed | Changed screen |
| Prototype to Dataverse transition or manifest hash changed | Every data-bound screen or shared data helper whose imports/field bindings changed, plus screens consuming changed helpers |
| Only lifecycle hashes are missing | Run gates first; rebuild only failures |

Spawn `mobile-app:screen-builder` in waves of at most five. Prompts include the
existing file, approved per-screen spec, current generated-service snapshot,
data mode, exact target path, matching build-pack entry, literal header mode,
and stable-ID view model. In Dataverse mode include the manifest facts for that
screen.

Parse each first-line status using the plugin protocol. Retry
`NEEDS_CONTEXT` once with concrete service/manifest context. Stop on
`BLOCKED`. After each wave, run `npm --prefix "$PROJECT_DIR" run type-check`;
group errors by root cause and cap repair attempts at two per screen.

### Step 6 - Final Gates

Run in this order:

```bash
cd "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-contracts.js" \
  "$PROJECT_DIR/native-app-plan.md"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-build-pack.js" \
  --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-shells.js" \
  --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-media.js" \
  --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report app
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report app
```

In Dataverse mode, then run:

```bash
npm --prefix "$PROJECT_DIR" run generate-schemas
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-files.js" \
  --project-root "$PROJECT_DIR" --all-source
```

Finally, in both modes:

```bash
npm --prefix "$PROJECT_DIR" run type-check
```

Repair one stage at a time and rerun that stage before advancing. Route,
contract, auto-fixable quality/contrast, and TypeScript failures are hard
blocks. Judgement-call visual findings may become `DONE_WITH_CONCERNS` after
two repair attempts, but TypeScript must remain clean.

Run the mandatory changed-file validator with every file this sync wrote or
its builders edited. The Dataverse `--all-source` pass is additional: it catches
stale bindings in unchanged shared helpers and screens before lifecycle state
can be committed.

### Step 6.5 - Automated Design Refinement (LLM Polish)

After the script-based stylistic sweep, apply the final layer of context-aware design polish to the updated screens.

**Print before starting:**
> "-> [sync 6.5/8] Running automated design refinement pass to polish UI, typography, RTL layouts, and accessibility..."

Invoke the design skill:
```text
/design-react-native-app
```
Instruct the skill to review the generated screens in `<PROJECT_DIR>/app/(app)/` against the design system at `<PROJECT_DIR>/brand/tokens.ts`. 

Wait for it to complete. If it modifies any UI files, you MUST run a final TypeScript gate:
```bash
npm --prefix "$PROJECT_DIR" run type-check
```

### Step 7 - Preview

Unless `--no-preview`, invoke:

```text
/preview-screens --working-dir <PROJECT_DIR>
```

Preview is a review artifact; it never replaces static gates and must not add a
React Native Web target or runtime route crawl.

### Step 8 - Record State

Only after all hard gates pass, update `.mobile-app/state.json`:

- preserve `dataMode` for ordinary syncs;
- for an approved transitioning sync, set `dataMode: "dataverse"` and
  `transition: null`;
- `lastSyncedPlanHash`: current plan SHA-256;
- `lastDataverseManifestHash`: current manifest SHA-256 in Dataverse mode,
  otherwise `null`;
- `lastSyncAt`: current ISO timestamp.

Append a memory-bank entry with data mode, target screens, service/manifest
changes, validation result, concerns, and preview path.

## Summary Output

```text
DONE

Synced from native-app-plan.md.
Data mode: <prototype|dataverse>
Screens rebuilt: <count/list>
Validation: PASS
Preview: <path or skipped>
State: .mobile-app/state.json updated
```

Use `DONE_WITH_CONCERNS: <visual concerns>` only when every hard gate passed.
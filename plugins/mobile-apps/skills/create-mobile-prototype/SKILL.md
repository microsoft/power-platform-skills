---
name: create-mobile-prototype
description: Use when the user wants a quick Expo/React Native Power Apps mobile prototype backed by deterministic local mock data instead of Dataverse, with an approved data model and a supported path to convert the same screens to a real app later.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, Skill, EnterPlanMode, ExitPlanMode
model: opus
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** - read first.

# Create Mobile Prototype

Build a high-fidelity Power Apps mobile experience in a fresh installed Expo
template without selecting a Power Platform environment. The app uses typed,
in-memory CRUD services seeded from bundled JSON. It retains the normal
`native-app-plan.md`, design system, navigation, native wrapper, screen-builder,
and validation contracts so `/prototype-to-real-app` can later replace only the
data/auth integration layer.

## Choose The Right Creation Path

| Goal | Skill |
|---|---|
| Real environment, Dataverse, connectors, auth, deployment | `/create-mobile-app` |
| Local UX prototype with mock business data | `/create-mobile-prototype` |
| Turn an existing prototype into a real app | `/prototype-to-real-app` |

## Non-Negotiables

- Start in a fresh, already-installed `expo-app-standalone` template directory,
  exactly like `/create-mobile-app`. Do not copy the plugin's bundled template
  over the working directory.
- Do not run `npx power-apps`, `pac`, `az`, Dataverse HTTP calls, connection
  creation, app registration, or offline-profile mutation in this workflow.
- Use `mobile-app:native-app-planner` with `Dataverse planning mode: prototype`.
  The normalized schema contract is mandatory; do not derive executable mock
  schema from free-form Markdown when the sidecar exists.
- The prototype schema contract is not approved target-environment evidence.
  It must contain `planningMode: "prototype"` and
  `executionEligible: false`.
- Generate table mocks only under `src/generated/`. Screen code imports from
  `@/generated/services`; it must not import seed JSON directly or call raw
  HTTP APIs.
- Planned external connectors receive explicit throw-stubs. Their screens may
  render, but an attempted connector operation must fail clearly until
  graduation.
- Preserve the full real-app screen quality bar. Prototype means local data,
  not placeholder UI.
- Do not create an offline profile. Record offline intent in the plan and offer
  `/setup-offline-profile` only after graduation creates real tables.

## Inputs

- `--working-dir <path>` - fresh installed template directory; default current
  directory.
- `--from-plan <path>` - optional approved `native-app-plan.md`. Preserve
  approved sections; fill only missing prototype requirements.
- `--from-design-intake <path>` - optional visual requirements from
  `/design-to-app`.
- `--no-design` - skip the interactive picker only. App-specific semantic
  tokens are still mandatory.

Do not accept an environment argument. A request to choose an environment
belongs to `/create-mobile-app` or `/prototype-to-real-app`.

## Progress Contract

Print one line before every long phase:

```text
-> [prototype 1/10] Checking the fresh mobile template...
-> [prototype 2/10] Capturing the prototype brief...
-> [prototype 3/10] Planning data, integrations, and screens...
-> [prototype 4/10] Preparing the installed template...
-> [prototype 5/10] Generating typed mock services and seed data...
-> [prototype 6/10] Applying native capabilities and design tokens...
-> [prototype 7/10] Building navigation and typed screen skeletons...
-> [prototype 8/10] Building polished prototype screens...
-> [prototype 9/10] Running route, quality, contrast, and TypeScript gates...
-> [prototype 10/10] Recording state and starting Metro...
```

## Workflow

### Step 1 - Verify Fresh Template

Resolve `PROJECT_DIR` from `--working-dir` or the current directory. Require:

```bash
test -f "$PROJECT_DIR/package.json"
test -f "$PROJECT_DIR/app.config.js"
test -f "$PROJECT_DIR/auth.config.json"
test -f "$PROJECT_DIR/tamagui.config.ts"
test -d "$PROJECT_DIR/node_modules/expo"
```

Classify the directory using the same markers as
[`/create-mobile-app`](../create-mobile-app/SKILL.md#fresh-template-working-directory-mode):

| State | Action |
|---|---|
| Fresh installed template | Continue. |
| Template files exist but `node_modules/expo` is absent | STOP and ask the user to run `npm install`. Do not provision npm credentials. |
| `memory-bank.md`, `native-app-plan.md`, `.datamodel-manifest.json`, `src/generated/services/*.ts`, or `.mobile-app/state.json` exists | STOP unless this is an explicitly confirmed resume of the same prototype run. |
| Required template files are missing | STOP and point to the README `degit` setup. |

Require Node 22+ and npm 10+. Do not probe Power Platform or native build
toolchains.

### Step 2 - Capture Brief And Impact Preview

Read supplied arguments and any `--from-plan` / `--from-design-intake` artifact.
Ask one broad question only when the request does not already describe the app:

```text
What mobile prototype should I build? Include its users, core workflow,
important records, native device features, external integrations, and visual
direction.
```

Write `<PROJECT_DIR>/brief.md`. Mark `Mode: prototype` and preserve the source
paths of approved design/plan inputs. Show a compact impact preview containing
the expected entities, native capabilities, connectors, screens, design work,
and validation stages. Ask Proceed / Revise / Cancel before planning.

### Step 3 - Plan In Prototype Mode

Spawn `mobile-app:native-app-planner` with:

```text
Requirements: <brief verbatim>
Working directory: <absolute PROJECT_DIR>
Plugin root: <absolute plugin root>
Dataverse planning mode: prototype
Target environment: NOT SUPPLIED
Publisher prefix: cr (prototype placeholder only)
Normalized Dataverse foreground planning snapshot: NOT SUPPLIED
Dataverse planning evidence: NOT SUPPLIED
Structured schema contract output: <PROJECT_DIR>/.tmp/dataverse-schema-contract.json
Design vibe opt-in: deferred (or skip when --no-design)

This is a mock-backed prototype. Run the normal approval gates and write the
same native-app-plan.md used by real apps, but perform no environment or
Dataverse discovery. The schema sidecar must be complete enough for typed local
mocks and must be marked planningMode=prototype, executionEligible=false.
External connector rows remain requirements; prototype generation will create
throw-stubs at their expected service paths.
```

Parse the agent's literal first line using the status protocol in
`AGENTS.md`. Retry `NEEDS_CONTEXT` at most twice, surface
`DONE_WITH_CONCERNS`, and stop on `BLOCKED` or a malformed status.

Before continuing, require all of:

```bash
test -f "$PROJECT_DIR/native-app-plan.md"
test -f "$PROJECT_DIR/.tmp/dataverse-schema-contract.json"
test -f "$PROJECT_DIR/.tmp/mobile-plan-status.json"
node -e "const c=require(process.argv[1]); if(c.planningMode!=='prototype'||c.executionEligible!==false||!Array.isArray(c.tables)) process.exit(1)" "$PROJECT_DIR/.tmp/dataverse-schema-contract.json"
```

When `--from-plan` was supplied, do not silently replace approved Data Model,
Native Capabilities, Connectors, Design Direction, Screen Map, Navigation
Contracts, or screen specs. The planner may normalize missing machine contract
details, but any semantic change returns to the relevant approval gate.

### Step 4 - Prepare The Existing Template

The optimized deterministic runner owns template preparation. Run it once;
do not repeat the inherited manual Step 5 edits afterward:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/prepare-mobile-template.js" \
  --project-root "$PROJECT_DIR" \
  --display-name "<approved display name>" \
  --slug "<approved slug>" \
  --mode prototype
test -f "$PROJECT_DIR/.tmp/template-prep-receipt.json"
```

The legacy preparation bullets below are repair guidance only when this script
fails on an unsupported template shape. Do not execute both paths.

Read and apply `/create-mobile-app` Step 5's current template preparation
contract, with these prototype-specific overrides:

1. Update app identity and package slug using targeted structured edits.
2. Remove stale example generated files/hooks from older template snapshots.
3. Create the shared component/hook/util/token/native directories and copy only
   missing shared samples.
4. Merge the current `@/components`, `@/hooks`, `@/utils`, `@/tokens`,
   `@/generated`, and `@/native` aliases without deleting template aliases.
5. Preserve the root `PowerAppsProvider`, SafeAreaProvider ordering,
   `tamaguiConfig`, and the `@ts-ignore` import boundaries.
6. Do not run `npx power-apps init` and do not configure app registration.

Copy the memory-bank template to `<PROJECT_DIR>/memory-bank.md` only when it is
missing. Record `data_mode: prototype`, no environment, and the approved plan
path.

Choose `PROTOTYPE_ENTRY_ROUTE` from the approved Screen Map: use the explicit
initial/home route, otherwise the first tab/root route. Normalize the plan's
`app/(app)/...tsx` file to an Expo href such as `/(app)/home`.

Then enable the reversible local runtime:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/configure-prototype-runtime.js" \
  "$PROJECT_DIR" prototype "$PROTOTYPE_ENTRY_ROUTE"
```

This intentionally:

- bypasses route-level auth only while `dataMode === 'prototype'`;
- keeps `PowerAppsProvider` mounted for the same Tamagui/native host surface;
- writes a zero-environment `power.config.json` with empty references;
- writes a prototype-only empty `connectorSchemas.ts` so Metro resolves the
  root import;
- replaces `predev` with a local-mock message and records the original command
  in `.mobile-app/runtime-backup.json` for graduation.

Write `.mobile-app/state.json` per
[`lifecycle-state.md`](../../shared/references/lifecycle-state.md) with
`dataMode: "prototype"`, null environment/transition/hashes, and schema version
1.

Run the scaffold gate:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/run-tsc-gate.js" \
  --project-root "$PROJECT_DIR" --gate scaffold
```

### Step 5 - Generate Typed Mocks

Run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/gen-mock-services.js" "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/run-tsc-gate.js" \
  --project-root "$PROJECT_DIR" --gate generated-services
```

The generator reads `.tmp/dataverse-schema-contract.json` and writes:

- one in-memory CRUD service and deterministic seed file per service-required
  table;
- one prototype schema per table;
- connector throw-stubs from `## Connectors`;
- `src/generated/services/index.ts`, `src/generated/index.ts`, and registries;
- `src/generated/.prototype-manifest.json`, the exact cleanup inventory.

Inspect seed density before screen construction. Require related parent IDs,
multiple workflow/choice states, past and future dates where relevant, edge
states, and domain-readable labels. Generic numbered rows are a blocker for a
recognized field-service, inventory, CRM, grocery/retail, or healthcare brief.

Do not hand-edit a generated service to hide a contract mismatch. Repair the
approved structured contract or generator, regenerate, and rerun type-check.

### Step 6 - Apply Native Capabilities And Design

Use the planner-owned `.tmp/native-capabilities-contract.json`. Run
`plan-native-batches.js <PROJECT_DIR> plan`, then dispatch one
`mobile-app:native-batch-builder` per row in `.tmp/native-batches.json` in one
parallel Task call (cap four). Each batch owns disjoint wrapper files; related
camera/image/scanner work stays inside one batch and is not duplicated. After
all statuses pass, run `plan-native-batches.js <PROJECT_DIR> verify` as the one
mandatory join gate. A missing wrapper or unshipped package is a blocker.

Always run `/design-system` in orchestrator mode. Pass `--working-dir` and
`--from-design-intake` when supplied. With `--no-design`, pass
`--apply-recommendation`: this skips optional brand/style exploration but still
reuses the planner recommendation, writes all design artifacts, runs the common
confirmation/persistence ending, and never leaves the raw Tamagui starter
palette as the product design.

Before integrating tokens or generating navigation/skeletons, require and
verify the canonical decision:

```bash
test -f "$PROJECT_DIR/brand/design-decision.json"
node "${CLAUDE_SKILL_DIR}/../design-system/scripts/finalize-design-decision.js" \
  "$PROJECT_DIR" check
```

A missing or stale decision is a blocker. Screen builders consume the final
brand artifacts; they never choose or reclassify a design direction.

Apply `brand/tokens.ts` to `tamagui.config.ts` using the current
`/create-mobile-app` brand-token integration contract, then run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/run-tsc-gate.js" \
  --project-root "$PROJECT_DIR" --gate design-integration
```

### Step 7 - Navigation, Shared Code, And Skeletons

The structured screen contract owns this phase. Do not reinterpret Markdown or
run the manual Step 10b/10.7/10.8 implementation in the normal path:

Require `.tmp/screen-contract.json`; never reconstruct it from Markdown.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/build-screen-artifacts.js" \
  "$PROJECT_DIR" generate
node "${CLAUDE_SKILL_DIR}/../../scripts/run-tsc-gate.js" \
  --project-root "$PROJECT_DIR" --gate navigation-skeleton
node "${CLAUDE_SKILL_DIR}/../../scripts/build-builder-context.js" \
  "$PROJECT_DIR" build
node "${CLAUDE_SKILL_DIR}/../../scripts/pack-screen-waves.js" \
  "$PROJECT_DIR" --max-concurrency 5
```

Require `.tmp/service-inventory.json`, `.tmp/navigation-contract.json`,
`.tmp/screen-artifacts-receipt.json`, `.tmp/builder-context/index.json`, and
`.tmp/screen-waves.json`. The inherited implementation notes below are repair
guidance only if deterministic generation reports an unsupported contract.

Reuse the current owning implementation in `/create-mobile-app`, in this order:

1. Step 10.7 generated-service snapshot, using the prototype services now on
   disk.
2. Step 10b navigation layout from the approved Screen Map.
3. Step 10.8 app-specific shared code and typed skeletons.

Prototype-specific rules:

- Keep the `dataMode !== 'prototype'` auth guard in
  `app/(app)/_layout.tsx` when Step 10b rewrites only the return block.
- Never let a screen-builder edit layout files, generated mocks, seed JSON,
  package files, lifecycle state, or the plan.
- Skeleton service imports come from `@/generated/services` and use only the
  generated methods/types on disk.

The `navigation-skeleton` gate above must pass before builders.

### Step 8 - Build Screens

Read waves from `.tmp/screen-waves.json`; they are complexity-balanced and each
contains at most five screens. Spawn `mobile-app:screen-builder` for one wave in
one Task call. The first real wave is also the availability check; there is no
separate no-op probe. Each prompt must include:

```text
Data mode: prototype.
builder_context_path: <PROJECT_DIR>/.tmp/builder-context/<screen-id>.json
Use only the typed services exported from @/generated/services. They are
in-memory implementations with deterministic seed data and the same app-facing
CRUD contract that graduation will preserve through adapters when necessary.
Do not import *.seed.json, call Dataverse, call connectors directly, or weaken
the approved domain-specific first viewport.
```

Run `run-tsc-gate.js --project-root "$PROJECT_DIR" --gate
wave-<wave-number>` after every wave. Group failures by root cause and cap
retries at two per screen. Do not launch the next complexity-packed wave until
the gate passes.

### Step 9 - Final Validation

Run final read-only gates concurrently, while preserving canonical repair order
in the receipt:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/run-final-checks.js" \
  --project-root "$PROJECT_DIR" --all-source
```

Stop at the first failing stage, repair that stage, and rerun it before moving
on. Do not run real schema generation in prototype mode.

Require `.tmp/final-checks-receipt.json`, `.tmp/validation-receipt.json`, and
`.tmp/final-validation.md`. Repair failures in the receipt order and rerun the
same command. The final TypeScript gate is always `--clean`; incremental state
accelerates earlier gates but never skips compilation.

`run-final-checks.js` invokes `run-validation-batch.js` internally for the full
source surface; do not run the legacy serial changed-file dispatcher afterward.

Run the mandatory changed-file dispatcher against every file written by this
workflow or its agents. Pass explicit files, not directories:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-files.js" \
  --project-root "$PROJECT_DIR" \
  --file <changed-file> [--file <changed-file> ...]
```

### Step 9.6 - Automated Design Refinement (LLM Polish)

After the script-based stylistic sweep, apply the final layer of context-aware design polish to the generated prototype screens.

**Print before starting:**
> "-> [prototype 9.6/10] Running automated design refinement pass to polish UI, typography, RTL layouts, and accessibility..."

Invoke the design skill:
```text
/design-react-native-app
```
Instruct the skill to review the generated screens in `<PROJECT_DIR>/app/(app)/` against the design system at `<PROJECT_DIR>/brand/tokens.ts`. 

Wait for it to complete. If it modifies UI files, rebuild builder contexts and
rerun `run-final-checks.js`; polish may not leave stale hashes or validation
receipts.

After polish, begin a hash lock with `preview-lock.js "$PROJECT_DIR" begin
preview.html`. Unless the user opted out, invoke `/preview-screens` and
`run-final-checks.js` in the same parallel tool message because both are
read-only over frozen sources. Then run `preview-lock.js "$PROJECT_DIR"
finalize preview.html`. If any source changed, the command deletes the stale
preview and blocks until regeneration. If preview is skipped, delete any old
`preview.html` and `.tmp/preview-lock.json` so stale output cannot be reported.
Hard rule: delete stale preview output before reporting completion.

### Step 10 - Record State And Start Metro

Update `.mobile-app/state.json`:

- `dataMode: "prototype"`
- `environment: null`
- `transition: null`
- `lastSyncedPlanHash`: SHA-256 of `native-app-plan.md`
- `lastDataverseManifestHash: null`
- `optimizationReceipts`: SHA-256 (or null when intentionally absent) for
  template prep, screen contract, service inventory, design decision, native
  join, screen waves, TypeScript cache manifest, validation receipt, final
  checks receipt, and preview lock per
  `shared/references/optimized-generation-pipeline.md`
- `lastSyncAt`: current ISO timestamp

Append a memory-bank entry with generated tables, planned connector stubs,
native capabilities, screens, validation result, and preview path.

Record lifecycle and optimization hashes atomically:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/record-optimization-state.js" \
  "$PROJECT_DIR" --data-mode prototype
```

Do not hand-compute or partially append receipt hashes.

Start Metro with `npx expo start` from `PROJECT_DIR`. Do not use a web runtime
or crawl routes in a browser. Return the Metro URL/QR handoff to the user.

## Graduation Contract

The prototype is ready for `/prototype-to-real-app` only when:

- lifecycle state says `prototype`;
- the approved plan and prototype schema contract exist;
- `src/generated/.prototype-manifest.json` exists;
- `.tmp/final-validation.md` records all final gates as passing;
- screens import generated services through the barrel rather than seed JSON.

Graduation may rename or reuse real Dataverse tables. It must preserve the
screen-facing service contract through explicit adapters when real generated
filenames or method shapes differ. "Same import paths" is a goal, not an
assumption that bypasses compilation and field-binding validation.

## Summary Output

```text
DONE

Mobile prototype created.
Data mode: prototype (local in-memory services)
Tables: <list>
Connector stubs: <list or none>
Native capabilities: <list or none>
Screens: <count/list>
Validation: PASS
Preview: <path>
Next: iterate with /edit-app, or run /prototype-to-real-app when the data model is ready for a real environment.
```

Use `DONE_WITH_CONCERNS: <concerns>` when a non-blocking connector stub or
visual review concern remains. Never use `DONE` when a route, contract,
quality, contrast, changed-file, or TypeScript gate failed.
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
npm --prefix "$PROJECT_DIR" run type-check
```

### Step 5 - Generate Typed Mocks

Run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/gen-mock-services.js" "$PROJECT_DIR"
npm --prefix "$PROJECT_DIR" run type-check
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

For every approved `## Native Capabilities` row, execute `/add-native`
sequentially from `PROJECT_DIR`. The template allowlist and runtime bans remain
unchanged. A capability absent from the bundled template is a blocker; do not
install native code or fake a wrapper.

Run `/design-system` in orchestrator mode unless `--no-design`. Pass
`--working-dir` and `--from-design-intake` when supplied. Even with
`--no-design`, require app-specific semantic aliases/tokens; never leave the raw
Tamagui starter palette as the product design.

Apply `brand/tokens.ts` to `tamagui.config.ts` using the current
`/create-mobile-app` brand-token integration contract, then type-check.

### Step 7 - Navigation, Shared Code, And Skeletons

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

Run `npm --prefix "$PROJECT_DIR" run type-check` before builders.

### Step 8 - Build Screens

Spawn `mobile-app:screen-builder` in the same bounded waves and with the same
status/retry protocol as `/create-mobile-app` Step 11. Each prompt must include:

```text
Data mode: prototype.
Use only the typed services exported from @/generated/services. They are
in-memory implementations with deterministic seed data and the same app-facing
CRUD contract that graduation will preserve through adapters when necessary.
Do not import *.seed.json, call Dataverse, call connectors directly, or weaken
the approved domain-specific first viewport.
```

Run the screen-wave TypeScript gate after every wave. Group failures by root
cause and cap retries at two per screen.

### Step 9 - Final Validation

Run in this order from `PROJECT_DIR`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-contracts.js" "$PROJECT_DIR/native-app-plan.md"
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report app
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report app
npm --prefix "$PROJECT_DIR" run type-check
```

Stop at the first failing stage, repair that stage, and rerun it before moving
on. Do not run real schema generation in prototype mode.

Record every command, pass/fail result, issue count, and accepted concern in
`.tmp/final-validation.md`. The file must name all five commands before the
prototype can be reported complete or converted.

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

Write the exact allowed files to
`<PROJECT_DIR>/.tmp/design-refinement-scope.json` and capture a baseline:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/audit-ui-only-refinement.js" \
  --project-root "$PROJECT_DIR" \
  --scope-file "$PROJECT_DIR/.tmp/design-refinement-scope.json" \
  --snapshot "$PROJECT_DIR/.tmp/design-refinement-before.json" \
  --capture
```

Invoke the design skill:
```text
/design-react-native-app

Arguments:
  --orchestrated
  --working-dir <PROJECT_DIR>
  --plan <PROJECT_DIR>/native-app-plan.md
  --brand <PROJECT_DIR>/brand/design-system.md
  --tokens <PROJECT_DIR>/brand/tokens.ts
  --scope <exact generated screen files plus exact app-owned visual components>
  --ui-only
  --no-questions
```
Instruct the skill to refine only the supplied files against the approved plan,
design intake when present, and complete brand design system. Preserve mock
service behavior, routes, form/data contracts, plan/brand artifacts, and
`experience-*` testIDs. Do not install dependencies or add unapproved media.

Apply the plugin first-line status switch. A scope escape or behavior change is
`BLOCKED`. Verify the filesystem delta before trusting that status:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/audit-ui-only-refinement.js" \
  --project-root "$PROJECT_DIR" \
  --snapshot "$PROJECT_DIR/.tmp/design-refinement-before.json" \
  --verify
```

Exit `2` is `BLOCKED`. Use the auditor's `changed` list as authoritative. When
it is non-empty, rerun the changed-file dispatcher and all five Step 9 gates,
including quality and contrast, then run composition as an additional
structural gate:

```bash
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-composition.js" \
  --project-root "$PROJECT_DIR" --report <changed-screen-or-component-files>
npm --prefix "$PROJECT_DIR" run type-check
```

Append these post-refinement results to `.tmp/final-validation.md`. Do not claim
WCAG or RTL verification from source inspection; native evidence remains a
separate concern.

After validation and design polish, invoke `/preview-screens --working-dir
<PROJECT_DIR>` only when the original request includes `--preview` or the user
explicitly asked for a shareable static approximation. Otherwise proceed to
Metro; the native app is the default review surface.

### Step 10 - Record State And Start Metro

Update `.mobile-app/state.json`:

- `dataMode: "prototype"`
- `environment: null`
- `transition: null`
- `lastSyncedPlanHash`: SHA-256 of `native-app-plan.md`
- `lastDataverseManifestHash: null`
- `lastSyncAt`: current ISO timestamp

Append a memory-bank entry with generated tables, planned connector stubs,
native capabilities, screens, validation result, and preview path.

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
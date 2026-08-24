---
name: create-mobile-prototype
description: Use when the user wants a quick Expo/React Native Power Apps mobile prototype backed by deterministic local mock data instead of Dataverse, with an approved data model and a supported path to convert the same screens to a real app later.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, Skill
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

## Resolve The Local Plugin Once

At skill load, the host supplies the absolute **Base directory for this
skill**. Record that value as `SKILL_DIR` and derive `PLUGIN_ROOT` as its
`../..` ancestor. Reuse those resolved absolute paths for the entire run.

Every `${CLAUDE_SKILL_DIR}` occurrence below is documentation shorthand for
the resolved `SKILL_DIR`; it is not evidence that an environment variable is
available. Substitute the absolute resolved path in each shell command. Never
search the home directory, installed packages, GitHub, or the internet to
rediscover this plugin or one of its scripts. If the host did not provide a
base directory, stop with `BLOCKED: local skill base directory unavailable.`

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

Additional reference-fidelity inputs:

- --from-screenshot <path[,path...]> - one or more local visual references.
- --design-intake <path> - preferred spelling for a structured design intake;
  --from-design-intake remains a compatibility alias.
- --reference-fidelity <directional|high|strict-structural> - defaults to
  strict-structural when the user says to match a supplied screen, otherwise
  high for an explicit reference.

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
If no app brief was supplied, return `NEEDS_CONTEXT: provide a one-line mobile
app brief.` Otherwise write `<PROJECT_DIR>/brief.md`, mark `Mode: prototype`,
and preserve the source paths of approved design/plan inputs. Print a compact
impact preview containing expected entities, native capabilities, connectors,
screens, design work, and validation stages; do not require a Proceed / Revise /
Cancel approval for a local prototype.

Before the impact preview, derive and validate the shared product experience
contract. This is mandatory for a one-line or few-line brief and does not require a screenshot, HTML page, or design intake:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/experience-patterns.js" \
  --brief-file "$PROJECT_DIR/brief.md" \
  --output "$PROJECT_DIR/.tmp/experience-contract.json"
```

When the approved prototype brief explicitly requests cache-backed CDN media,
append `--media-policy remote-cdn-cached`. The generated fixture then owns the
URL, alt text, cache key, and fallback asset identity; screen code must not
embed a URL. Do not infer this policy from an industry label alone.

Read the resulting audience, primary job, interaction mode, entry mode,
first-viewport focal point/regions/action, motifs, forbidden defaults, and
confidence into the impact preview. For `confidence: low`, ask one ordinary
textual clarification about the first user outcome, revise `brief.md`, and
regenerate the contract. Otherwise record assumptions and continue. Never ask
the user to select an industry or upload a visual input to obtain a product
experience.

When a screenshot or design intake is supplied, materialize and validate
PROJECT_DIR/design-intake.md before the impact preview. Read
skills/design-system/references/reference-intake.md and
shared/references/reference-fidelity.md. Record the stable source paths,
fidelity, ordered hierarchy, measured geometry, navigation silhouette,
required motifs, forbidden drift, originality/asset policy, and Runtime
Markers. For high or strict-structural fidelity, do not continue with a vague
style summary or silently fall back to generic retail, dashboard, or catalog
patterns.

Add a Visual Reference section to brief.md with Sources, Fidelity, Design
intake path, and the intent to preserve the approved hierarchy, navigation
silhouette, required motifs, and forbidden drift using original assets and
copy. Ask the user to correct the intake before planning if a requested visual
match is ambiguous.

When reference fidelity is directional, high, or strict-structural, annotate
the experience contract with the intake's fidelity and preservation intent
before Step 3. High and strict references override generated composition
details where they conflict; normal briefs keep the contract source as `brief`.

Create the foreground execution preflight before invoking the planner:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/prepare-mobile-plan-execution-contract.js" \
  --project-root "$PROJECT_DIR" \
  --brief "brief.md" \
  --output ".tmp/mobile-plan-execution-preflight.json"
```

Exit code `3` means a required native capability is absent from the selected
template. Return `NEEDS_CONTEXT` with the reported supported alternatives
before any local checkpoint. The same preflight blocks unresolved connector
hints. Resolve those from read-only metadata into
`.tmp/connector-operation-metadata.json`, then rerun with
`--connector-metadata ".tmp/connector-operation-metadata.json"`. Do not create a
connection in prototype mode and do not let the planner invent a method. Do not
approve a capability or connector operation that must fail later.

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
Product experience contract: <PROJECT_DIR>/.tmp/experience-contract.json
Mobile plan execution preflight: <PROJECT_DIR>/.tmp/mobile-plan-execution-preflight.json
Design vibe opt-in: deferred (or skip when --no-design)
Visual reference:
- Sources: <validated local screenshot paths, or NOT SUPPLIED>
- Requested reference fidelity: <directional|high|strict-structural|none>
- Design intake: <PROJECT_DIR/design-intake.md, or NOT SUPPLIED>
- Reference intent: preserve approved hierarchy, normalized geometry,
  navigation silhouette, required motifs, and forbidden drift; use original
  copy and licensed local assets.

This is a mock-backed prototype. Return one complete
`mobile-plan-artifact-bundle`; do not write project files, invoke nested
approval gates, use host approval UI, or make external mutations. Perform no
environment or Dataverse discovery. The outer workflow records four ordinary
textual local checkpoints before building screens. The schema sidecar must be
complete enough for typed local mocks and must be marked
planningMode: "prototype", executionEligible: false. External connector rows remain
requirements; prototype generation will create throw-stubs at their expected
service paths.
Read and mirror the Product Experience Contract under `## Design` before
planning the data model or screen graph. Screen planning returns the screen and
foundation contracts and may not default Home to a dashboard or force a
List/Detail/Form flow unless the contract requires those shells.
```

Parse the agent's literal first line using the status protocol in `AGENTS.md`.
Retry `NEEDS_CONTEXT` at most once only for the low-confidence first-outcome
clarification. In prototype mode, expect `NEEDS_USER_APPROVAL` followed by one
blank line and exactly one fenced JSON `mobile-plan-artifact-bundle`. Its
status JSON names only the four sections, a concise summary, and
`mayAuthorizeExternalMutations: false`; it must not name output paths or an
approval ID. Stop on `BLOCKED` or malformed status/bundle.

The foreground workflow alone persists planning artifacts:

1. Write the returned JSON block verbatim to
   `$PROJECT_DIR/.tmp/planner-artifact-bundle.json`.
2. Validate the staged bundle before any plan artifact changes:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/validate-plan-artifact-bundle.js" \
     --project-root "$PROJECT_DIR" \
     --bundle "$PROJECT_DIR/.tmp/planner-artifact-bundle.json"
   ```

3. Persist the approved bundle through the fixed-target foreground writer:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/write-plan-artifact-bundle.js" \
     --project-root "$PROJECT_DIR" \
     --bundle "$PROJECT_DIR/.tmp/planner-artifact-bundle.json"
   ```

   The writer atomically manages only `native-app-plan.md`,
   `.tmp/dataverse-schema-contract.json`,
   `.tmp/experience-screen-contract.json`, and
  `.tmp/experience-foundation-contract.json`, and
  `.tmp/mobile-plan-execution-contract.json`. No nested planner, architect,
   or screen planner writes those paths, scratch sections, or previews.

4. Run the existing plan-time contract validators, then create the local draft
   checkpoint state:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-contract.js" \
     --project-root "$PROJECT_DIR" --phase plan
   node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-contracts.js" \
     "$PROJECT_DIR/native-app-plan.md" --project-root "$PROJECT_DIR" --phase plan
   node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-plan-execution-contract.js" \
     --project-root "$PROJECT_DIR"
   node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-files.js" \
     --project-root "$PROJECT_DIR" \
     --file "$PROJECT_DIR/native-app-plan.md" \
     --file "$PROJECT_DIR/.tmp/dataverse-schema-contract.json" \
     --file "$PROJECT_DIR/.tmp/experience-screen-contract.json" \
    --file "$PROJECT_DIR/.tmp/experience-foundation-contract.json" \
    --file "$PROJECT_DIR/.tmp/mobile-plan-execution-contract.json"
   node "${CLAUDE_SKILL_DIR}/../../scripts/plan-checkpoints.js" \
     --project-root "$PROJECT_DIR" \
     --action draft \
     --workflow create-mobile-prototype
   ```

Do not probe named host tools, invoke `EnterPlanMode`, call
`AskUserQuestion`, or require a named host approval UI. The bundle handoff is
the normal host-neutral path, not a fallback.

### Step 3a - Four textual prototype checkpoints

All local prototypes require these four ordinary chat checkpoints before screen
build. They are host-neutral review records, not external mutation approvals:

```text
1. Data Model
2. Native Capabilities
3. Connectors
4. Screen Plan
```

For each checkpoint, show the corresponding concise plan section and accept a
normal reply of `approve` or requested edits. On `approve`, persist the section
approval with:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/plan-checkpoints.js" \
  --project-root "$PROJECT_DIR" \
  --action approve \
  --workflow create-mobile-prototype \
  --section "<data-model|native-capabilities|connectors|screen-plan>" \
  --response approve
```

On requested edits, return to Step 3, request a revised return-only bundle,
then stage, validate, write, and draft it again before restarting that
checkpoint and every later checkpoint. Do not call Dataverse, provision a
connector, configure auth, request device permissions, or make another
external mutation during any checkpoint.

After the fourth approval, require:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/plan-checkpoints.js" \
  --project-root "$PROJECT_DIR" \
  --action status \
  --workflow create-mobile-prototype
```

Only an `approved` result lets the workflow continue to local template
preparation, mock generation, and screen build. Its status artifact records
`mayAuthorizeExternalMutations: false`; it must never be passed to a Dataverse
or connector mutation command.

Before continuing, require all of:

```bash
test -f "$PROJECT_DIR/native-app-plan.md"
test -f "$PROJECT_DIR/.tmp/dataverse-schema-contract.json"
test -f "$PROJECT_DIR/.tmp/experience-contract.json"
test -f "$PROJECT_DIR/.tmp/experience-screen-contract.json"
test -f "$PROJECT_DIR/.tmp/experience-foundation-contract.json"
test -f "$PROJECT_DIR/.tmp/mobile-plan-execution-preflight.json"
test -f "$PROJECT_DIR/.tmp/mobile-plan-execution-contract.json"
test -f "$PROJECT_DIR/.tmp/mobile-plan-status.json"
node -e "const c=require(process.argv[1]); if(c.schemaVersion!==3||!Array.isArray(c.screens)) process.exit(1)" "$PROJECT_DIR/.tmp/experience-screen-contract.json"
node -e "const c=require(process.argv[1]); if(c.planningMode!=='prototype'||c.executionEligible!==false||!Array.isArray(c.tables)) process.exit(1)" "$PROJECT_DIR/.tmp/dataverse-schema-contract.json"
```

When `--from-plan` was supplied, do not silently replace approved Data Model,
Native Capabilities, Connectors, Product Experience Contract / Design, Screen Map, Navigation
Contracts, or screen specs. The planner may normalize missing machine contract
details, but any semantic change regenerates the affected local draft artifacts.

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
- `assets/experience/manifest.json`, containing local illustration recipes and
  entity fallbacks;
- `src/generated/experience-view-model.ts`, the single stable-ID presentation
  adapter shared by list, detail, and cart/save screens;
- `src/generated/.prototype-manifest.json`, the exact cleanup inventory.

It also reads `.tmp/experience-contract.json` first. Audience, primary job,
interaction/entry mode, and content model select semantic seed copy; legacy domain keyword packs are used only when no experience contract exists. Do not
accept warehouse, field-service, CRM, or generic numbered seed copy that
contradicts the contract primary experience.

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
`--working-dir` and `--design-intake` when supplied; the older
`--from-design-intake` spelling is accepted only as a compatibility alias. Even with
`--no-design`, require app-specific semantic aliases/tokens; never leave the raw
Tamagui starter palette as the product design.

Require `/design-system` to read `$PROJECT_DIR/.tmp/experience-contract.json`
before choosing tokens. Its automatic direction comes from visual character,
audience, interaction/entry mode, focal point, motifs, and density; it must
write `## Product Experience Primitives` in `brand/design-system.md` and must
not fall back to an inspection or industry preset.

Apply `brand/tokens.ts` to `tamagui.config.ts` using the current
`/create-mobile-app` brand-token integration contract, then type-check.

Before compiling the build pack, read
`.tmp/mobile-plan-execution-contract.json → javascriptDependencies[]` and apply
the Installation Contract in
[`javascript-dependency-planning.md`](../../shared/references/javascript-dependency-planning.md).
Install each exact package/version sequentially, verify module resolution, and
run `validate-mobile-files.js` on `package.json`. An empty array is a no-op. Do
not recover dependencies from Markdown or a later compiler error.

When design-intake.md exists, run design-system in reference-contract mode.
Pass the intake path and require it to read the approved native-app-plan.md.
For high and strict-structural references, preserve the intake hierarchy and
motifs; do not start a new generic style picker, replace the composition with
an industry preset, or substitute remote imagery for an offline-required
asset. The design-system output must name the Reference Contract, required
motifs, forbidden drift, and signature components before builders run.

Compile and validate the compact builder assembly sheet after design and mock
intent are both available:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "$PROJECT_DIR" \
  --output ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-build-pack.js" \
  --project-root "$PROJECT_DIR" \
  --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-design-runtime.js" \
  --project-root "$PROJECT_DIR" \
  --pack ".tmp/screen-build-pack.json"
```

Do not launch skeleton or builder work when the pack is missing or stale.
Re-run `gen-mock-services.js` once after this compile so the final deterministic
seed manifest records the pack revision and uses its fixture/experience intent;
then rerun `npm --prefix "$PROJECT_DIR" run type-check`.

### Step 7 - Navigation, Shared Code, And Skeletons

Reuse the current owning implementation in `/create-mobile-app`, in this order:

1. Step 10.7 generated-service snapshot, using the prototype services now on
   disk.
2. Step 10b navigation layout from the approved Screen Map.
3. Step 10.8 app-specific shared code, contract-selected foundation primitives,
  pack-derived screen dependencies/build order, and typed skeletons.

Prototype-specific rules:

- Keep the `dataMode !== 'prototype'` auth guard in
  `app/(app)/_layout.tsx` when Step 10b rewrites only the return block.
- Never let a screen-builder edit layout files, generated mocks, seed JSON,
  package files, lifecycle state, or the plan.
- Skeleton service imports come from `@/generated/services` and use only the
  generated methods/types on disk.
- Read `.tmp/experience-foundation-contract.json` before skeleton generation.
  Create each selected component under `src/components/experience/`, export it
  from the shared barrel, retain its exact motif testID, and use local/bundled
  media fallback when `assetPolicy.media` is `local-first`. The prototype must
  not substitute a remote placeholder or generic card for a required motif.
- Keep the copied shared-barrel `EntityImage` as the sole implementation; do
  not replace the barrel or create `src/components/EntityImage.tsx`. For
  `remote-cdn-cached`, foundation and screen code pass
  `media={resolveExperienceMedia(record)}` so Expo Image loads the HTTPS source
  with disk caching and switches to its Metro-bundled `fallbackSource` after a
  remote error or offline cache miss.
- Read `.tmp/screen-build-pack.json` before skeleton generation. Require its
  schema-v3 screen contract and use its complete per-screen work orders, exact
  operations, approved dependencies/connector methods, design recipe,
  dependencies, fixture adapter, foundation primitives, and `builderWaves` as
  the execution source. `native-app-plan.md` is the human review surface, not a
  second builder input. Each skeleton imports `ScreenShell`, `toExperienceRecord`, and
  `getExperienceAsset`; route branches use the pack's literal `headerMode` and
  never introduce a second `SafeAreaView` or index-keyed presentation copy.
- Preserve the pack's explicit first-viewport budget. Skeletons for
  `media.sizing: responsive-clamped` expose the contracted `aspectRatio` and a
  viewport-derived maximum height/share; they never reserve a fixed tall media
  block that can hide `firstViewport.visiblePrimaryAction`.
- The shared `ScreenShell` must make scroll ownership explicit and default to
  non-scrolling content. It exposes `scroll?: boolean`; a screen with
  `primaryAction.placement: sticky-bottom` uses `scroll={false}`, owns its
  `ScrollView`/list, and renders `BottomActionBar` as a sibling outside that
  scroll container. Do not generate a shell that silently wraps every child,
  including a sticky action, in one `ScrollView`.

Run `npm --prefix "$PROJECT_DIR" run type-check` before builders.

### Step 8 - Build Screens

Read `builderWaves` from the validated pack. Do not recompute waves from a flat
Screen Map or `buildOrder`, and do not dispatch one screen at a time.

The required sequence is:

1. Complete the `foundation` wave sequentially and pass TypeScript.
2. Dispatch every target in the `vertical-slice` wave in **one Task batch**.
   The primary screen and independently buildable critical-flow screens run
   concurrently; route navigation is not a build dependency.
3. Run the wave TypeScript gate, start Metro early, and complete the pack's
   `native-visual-review` gate for the primary and critical flow at normal and
   large text.
4. Only after that native gate passes, dispatch each remaining screen wave as
   one bounded parallel Task batch (`maxConcurrency <= 5`), with TypeScript
   after every wave.

Dataverse and connector mutations remain sequential in the real-app workflow;
never generalize screen concurrency to generated-data or connector writes.

Each builder receives only its matching pack work order, pack revision, typed
skeleton, its foreground-captured skeleton SHA-256, and service surface. Screen
builders are return-only: they compose exact complete TSX but never write the
workspace. Do not make every builder reread
`native-app-plan.md`, the three experience sidecars, `brand/design-system.md`,
or broad plugin reference Markdown. A reference-intake artifact is loaded only
when `design.recipe` binds it for high/strict fidelity. Each prompt must
include:

```text
Data mode: prototype.
screen_build_pack_path: PROJECT_DIR/.tmp/screen-build-pack.json
screen_id: <exact builderWaves target>
screen_build_pack_revision: <pack revision>
target_file: <absolute PROJECT_DIR>/<work-order file> (read-only skeleton)
input_file_sha256: <SHA-256 of that skeleton immediately before dispatch>
artifact_protocol: return-only mobile-screen-artifact v1
Use only screens[screen_id] as the product/layout work order. Treat
design.recipe and the work order's presentation, regions, firstViewport,
header, primaryAction, media, states, qualityCriteria, testIds, data,
dependencies, and forbiddenDefaults as binding.
Use only the typed services exported from @/generated/services. They are
in-memory implementations with deterministic seed data and the same app-facing
CRUD contract that graduation will preserve through adapters when necessary.
Do not import *.seed.json, call Dataverse, call connectors directly, or weaken
the contracted first viewport. Materialize the work order's exact runtime
anchors and import its named foundation components instead of recreating them.
Convert service rows through
`toExperienceRecord`; use its ID for detail/cart identity and pass its local
asset recipe to `EntityImage`. A missing/stale pack or work order is BLOCKED;
there is no legacy plan fallback in this workflow.
Do not write or patch target_file. Return the exact complete one-screen TSX in
the schema-bound artifact required by screen-builder.md. Echo only the pack's
relative file and the supplied input_file_sha256; do not propose another path.
```

When design-intake.md exists, also include this Reference Contract in every
screen-builder prompt:

~~~text
Reference fidelity: <value embedded in the pack work order>.
Materialize every required motif with its Runtime Marker testID.
Preserve region order, media prominence, navigation silhouette, and forbidden
drift. Do not add a generic search field, product grid, ratings, discount
badges, payment, sign-in, or other unapproved UI merely because the domain is
retail.
~~~

#### Return-only screen artifact handoff

Before each Task batch, the foreground computes a SHA-256 for every typed
skeleton with the same fixed-target validator and passes that digest as
`input_file_sha256`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-artifact.js" \
  --project-root "$PROJECT_DIR" \
  --pack ".tmp/screen-build-pack.json" \
  --screen-id "<exact builderWaves target>" \
  --print-input-sha256
```

A successful builder
return is not considered persisted `DONE` until all of these foreground steps
pass:

1. Require literal `DONE` or `DONE_WITH_CONCERNS: ...`, one blank line, and
   exactly one fenced `mobile-screen-artifact` JSON object with no surrounding
   prose. `NEEDS_CONTEXT` and `BLOCKED` carry no artifact.
2. Extract the JSON block verbatim to a foreground-owned numeric staging path,
   `.tmp/screen-builder-artifacts/wave-<number>/result-<number>.json`. Never use
   an agent-supplied path for staging or persistence.
3. Validate **every** returned artifact in the wave before writing any screen:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-artifact.js" \
     --project-root "$PROJECT_DIR" \
     --pack ".tmp/screen-build-pack.json" \
     --screen-id "<foreground expected builderWaves target>" \
     --artifact "<foreground numeric staging path>"
   ```

4. After the whole wave validates, persist each artifact sequentially through
   the fixed-target writer:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/write-screen-artifact.js" \
     --project-root "$PROJECT_DIR" \
     --pack ".tmp/screen-build-pack.json" \
     --screen-id "<foreground expected builderWaves target>" \
     --artifact "<validated foreground staging path>"
   ```

The writer revalidates the foreground-authorized screen ID, pack revision,
route, relative file assertion, current skeleton hash, source shape, and
non-symlink target. It
derives the only writable target from `screens[screenId].file` and atomically
replaces that file. The foreground must not copy `source` into a path itself,
apply a returned diff, or honor an output path from agent prose. Malformed JSON,
unknown keys, target substitution, a changed skeleton hash, or a stale pack is
`BLOCKED` for that screen and is retried through the builder (maximum two), not
repaired by bypassing the writer.

After each changed screen wave is persisted, run the runtime composition gate
before TypeScript. It checks the same work-order placement/viewport contract on
the files now on disk, so foreground repairs and later edits cannot bypass the
artifact check:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-composition.js" \
  --project-root "$PROJECT_DIR" \
  --pack ".tmp/screen-build-pack.json"
```

Run the screen-wave TypeScript gate after every changed wave. Group failures by
root cause and cap retries at two per screen. Before a duplicate final type
check, compare the relevant-file fingerprint with the last successful wave
check. Skip only when unchanged and record the successful check reused; never
skip after any relevant file changed.

Start Metro after the vertical-slice TypeScript gate using the Step 10 launch
contract and retain its terminal ID for reuse. Capture the primary and
critical-flow routes, run `validate-experience-visual-evidence.js`, and repair
and recapture at most twice. Missing capture, unresolved findings, placeholder
critical media, clipping/overlap, an invisible primary action, or a failed
evidence validator is `BLOCKED: vertical-slice native review incomplete`.
Static HTML/browser previews and a `DONE_WITH_CONCERNS` marker do not open the
remaining-screen waves or qualify the prototype as visually complete.

### Step 9 - Final Validation

Run in this order from `PROJECT_DIR`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-contracts.js" "$PROJECT_DIR/native-app-plan.md" --project-root "$PROJECT_DIR" --phase build
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-contract.js" --project-root "$PROJECT_DIR" --phase build
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-plan-execution-contract.js" --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-build-pack.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-composition.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-shells.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-media.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-design-runtime.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report app
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report app
npm --prefix "$PROJECT_DIR" run type-check
```

When design-intake.md declares high or strict-structural fidelity, record the
native-evidence command below as pending in final-validation.md. Do not run it
until real native screenshots exist, and do not call a static HTML preview a
visual pass:

~~~bash
node "$CLAUDE_SKILL_DIR/../../scripts/validate-visual-qa-evidence.js" --project-root "$PROJECT_DIR" --manifest "$PROJECT_DIR/.tmp/visual-qa/<session>/manifest.json" --fidelity "<reference-fidelity>"
~~~

Stop at the first failing stage, repair that stage, and rerun it before moving
on. Do not run real schema generation in prototype mode.

Record every command, pass/fail result, issue count, and accepted concern in
`.tmp/final-validation.md`. The file must name every static command and any
required native-evidence command before the prototype can be reported complete
or converted.

For high and strict-structural reference work, the evidence command and its
result must also be recorded. Missing required native coverage blocks quality
completion; it is not a passing visual match.

For every prototype, once a real device/capture environment is available,
capture the primary screen and sidecar-declared `keyFlow` at normal and large
text. The generic manifest must include both routes, screenshot paths or
non-testID capture IDs, iOS/Android platform/device metadata, and evidence-backed checks for hierarchy/focal point,
task fit, realistic content, primary action, motifs, forbidden drift, contrast,
touch targets, safe areas, keyboard behavior (or reasoned N/A), offline state,
screen-reader order, responsive/compact layout, and localized/long content.
Each check names the reviewed capture IDs:

~~~bash
node "$CLAUDE_SKILL_DIR/../../scripts/validate-experience-visual-evidence.js" --project-root "$PROJECT_DIR" --manifest "$PROJECT_DIR/.tmp/experience-visual-review.json"
~~~

When the manifest or real native capture is unavailable, record
`BLOCKED: native experience visual evidence is required for quality completion`
in `.tmp/final-validation.md`. Do not claim visual completion, dispatch
remaining-screen waves, or graduate the prototype. Static HTML/browser previews
do not satisfy the native visual review.

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
Instruct the skill to review generated screens against the validated v2
`.tmp/screen-build-pack.json`, including its revision, per-screen work orders,
and `design.recipe`. Do not make the refiner reread broad plan, sidecar,
design-system, or plugin-reference Markdown in the normal path. It may repair
hierarchy, density, focal-point clarity, accessibility, and signature motifs,
but must not replace presentation, region order, primary action, media
requirements, or forbidden defaults.
It must preserve runtime placement: `sticky-bottom` remains in
`BottomActionBar` outside scroll content under `ScreenShell scroll={false}`.
It also preserves first-viewport region markers and responsive media sizing;
do not add `minH`/`minHeight` to a media region that shares that viewport.

Wait for it to complete. If it modifies any UI/shared/design file, rerun the
entire Step 9 validation sequence in order, recapture affected native routes,
and invoke `validate-mobile-files.js` with **every file changed by builders or
the refiner**. A TypeScript-only recheck is insufficient because refinement can
break route, shell, media, contrast, accessibility, pack, or visual contracts.
Never reuse a pre-refinement validation result after content changed.

For high or strict-structural fidelity, also provide only the reference-intake
artifact bound by `design.recipe`.
Refinement may improve spacing, accessibility, and interaction states, but it
must not redesign the approved Home composition or introduce a Forbidden Drift
pattern. Re-run all static, changed-file, and affected native-evidence gates
after refinement.

After validation and design polish, invoke `/preview-screens` only when the user
explicitly requested a static visual companion. It is never the default review
or a substitute for native evidence.

### Step 10 - Record State And Start Metro

Update `.mobile-app/state.json`:

- `dataMode: "prototype"`
- `environment: null`
- `transition: null`
- `lastSyncedPlanHash`: SHA-256 of `native-app-plan.md`
- `lastSyncedScreenContractHash`: SHA-256 of `.tmp/experience-screen-contract.json`
- `lastSyncedExecutionContractHash`: SHA-256 of `.tmp/mobile-plan-execution-contract.json`
- `lastDataverseManifestHash: null`
- `lastSyncAt`: current ISO timestamp

Append a memory-bank entry with generated tables, planned connector stubs,
native capabilities, screens, validation result, and preview path.

Reuse the Metro process started by the vertical-slice gate. Start
`npx expo start` only when no healthy recorded process exists. Do not use a web
runtime or crawl routes in a browser. Return the Metro URL/QR handoff and
instruct the user to scan it with the Power Apps Developer app or a compatible
custom development client that includes the native host; Expo Go is
unsupported.

### Step 10.5 - Native Reference Evidence

For every prototype, native capture additionally validates the generic
experience contract. Ensure `$PROJECT_DIR/.tmp/experience-visual-review.json`
names `keyFlowRoute`, captures both primary and key-flow routes at normal and
large text, and scopes every evidence-backed check to `primary` and `key-flow`.
Run:

~~~bash
node "$CLAUDE_SKILL_DIR/../../scripts/validate-experience-visual-evidence.js" --project-root "$PROJECT_DIR" --manifest "$PROJECT_DIR/.tmp/experience-visual-review.json"
~~~

If native capture is unavailable, report
`BLOCKED: native experience visual evidence is required for quality completion`.
Do not return a completed prototype or dispatch later builder waves. This
generic receipt does not replace stricter reference-fidelity evidence below.

For high or strict-structural fidelity, after Metro is running in a real Expo
native client, capture and retain:

1. Home at default text size on iOS.
2. Home at default text size on Android.
3. Home at large system text on either platform.

Write PROJECT_DIR/.tmp/visual-qa/<session>/manifest.json with:

~~~json
{
  "schemaVersion": 1,
  "referenceFidelity": "high or strict-structural",
  "captureMatrix": [
    {
      "screen": "Home",
      "platform": "ios or android",
      "dynamicType": "default or large",
      "result": "pass or fail",
      "path": "project-local screenshot path when available",
      "captureId": "native automation capture ID when a local path is unavailable"
    }
  ],
  "referenceChecks": [
    {
      "requirement": "hierarchy, each motif, and each forbidden-drift item",
      "result": "pass or fail"
    }
  ],
  "findings": [],
  "missingCoverage": []
}
~~~

Run:

~~~bash
node "$CLAUDE_SKILL_DIR/../../scripts/validate-visual-qa-evidence.js" --project-root "$PROJECT_DIR" --manifest "$PROJECT_DIR/.tmp/visual-qa/<session>/manifest.json" --fidelity "<reference-fidelity>"
~~~

Static preview output is not a substitute. If a required native device,
capture, or platform coverage is missing, return `BLOCKED` and name the missing
evidence. Never return `DONE` claiming a match until the evidence validator
passes.

## Graduation Contract

The prototype is ready for `/prototype-to-real-app` only when:

- lifecycle state says `prototype`;
- the approved plan and prototype schema contract exist;
- the approved execution contract exists and validates against the current
  brief, template package, schema-v3 screen operations, and data contract;
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
Visual reference: <not requested | native evidence passed | native evidence pending/concerns>
Preview: <path>
Next: iterate with /edit-app, or run /prototype-to-real-app when the data model is ready for a real environment.
```

Use `DONE_WITH_CONCERNS: <concerns>` when a non-blocking connector stub or
visual review concern remains. Never use `DONE` when a route, contract,
quality, contrast, changed-file, or TypeScript gate failed.

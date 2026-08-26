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
confidence into the impact preview. For `confidence: low`, ask one focused
question about the first user outcome, revise `brief.md`, and regenerate the
contract. Never ask the user to select an industry or upload a visual input to
obtain a product experience.

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

### Step 3 - Plan In Prototype Mode

Read `shared/references/host-capability-adapter.md`. If nested `Task` dispatch
is unavailable, or the planner returns
`NEEDS_CONTEXT: host-capability-handoff:<capabilities>`, continue in the
foreground from the same brief and artifacts. Read the planner and architect
instructions directly, produce the same files, and run the same validators.
Do not classify the host limitation as a project filesystem failure.

When plan mode is unavailable, show the same single consolidated prototype
review in ordinary chat and require an explicit `approve` response. When the
structured question tool is unavailable, ask the one allowed focused question
in ordinary chat. A read-only specialist returns proposed content for the
foreground to write. Lack of background tasks makes builder waves sequential;
it does not change their pack entries, artifact shape, or quality gates.

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
Product experience contract: <PROJECT_DIR>/.tmp/experience-contract.json
Design vibe opt-in: deferred (or skip when --no-design)
Visual reference:
- Sources: <validated local screenshot paths, or NOT SUPPLIED>
- Requested reference fidelity: <directional|high|strict-structural|none>
- Design intake: <PROJECT_DIR/design-intake.md, or NOT SUPPLIED>
- Reference intent: preserve approved hierarchy, normalized geometry,
  navigation silhouette, required motifs, and forbidden drift; use original
  copy and licensed local assets.

This is a mock-backed prototype. Write the same complete editable
native-app-plan.md used by real apps, but perform no environment or Dataverse
discovery. Ask for one consolidated final review covering product/screens,
logical data, native capabilities, and future connector intent. Do not pause at
the real-app section gates. Prototype approval never authorizes external
mutation. The schema sidecar must be complete enough for typed local mocks and
must be marked planningMode=prototype, executionEligible=false.
External connector rows remain requirements; prototype generation will create
throw-stubs at their expected service paths.
Read and mirror the Product Experience Contract under `## Design` before
planning the data model or screen graph. Screen planning must write
`.tmp/experience-screen-contract.json` and may not default Home to a dashboard
or force a List/Detail/Form flow unless the contract requires those shells.
```

Parse the agent's literal first line using the status protocol in
`AGENTS.md`. Handle `NEEDS_CONTEXT: host-capability-handoff:` immediately in
the foreground without counting it as a retry. Retry other `NEEDS_CONTEXT`
returns at most twice, surface `DONE_WITH_CONCERNS`, and stop on a genuine
`BLOCKED` or malformed status.

Before continuing, require all of:

```bash
test -f "$PROJECT_DIR/native-app-plan.md"
test -f "$PROJECT_DIR/.tmp/dataverse-schema-contract.json"
test -f "$PROJECT_DIR/.tmp/experience-contract.json"
test -f "$PROJECT_DIR/.tmp/experience-screen-contract.json"
test -f "$PROJECT_DIR/.tmp/experience-foundation-contract.json"
test -f "$PROJECT_DIR/.tmp/mobile-plan-status.json"
node -e "const c=require(process.argv[1]); if(c.planningMode!=='prototype'||c.executionEligible!==false||!Array.isArray(c.tables)) process.exit(1)" "$PROJECT_DIR/.tmp/dataverse-schema-contract.json"
```

Render the local maker control surface after approval:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/render-prototype-workspace.js" \
  --project-root "$PROJECT_DIR"
```

Open `_prototype_workspace.html` once and report its path. It is derived from
the existing plan and sidecars, never a planning authority or native UX
evidence. Editable fields export `prototype-review.json`; apply requested
changes through the existing plan/edit workflow, then rerender. Refresh this
same file after screen-build-pack compilation, every builder wave, final
validation, and each Metro ready/failed state transition.

When `--from-plan` was supplied, do not silently replace approved Data Model,
Native Capabilities, Connectors, Product Experience Contract / Design, Screen Map, Navigation
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

### Steps 5-6a - Generate Runtime Data And Design Foundations

The approved `.tmp/dataverse-schema-contract.json`, representative content,
media needs, screen graph, and state expectations must exist before either
lane starts. Design never starts from the brief alone.

When the host supports independent tasks, run these two disjoint lanes in
parallel:

- **Data lane:** Step 5 generates only `src/generated/` and
  `assets/experience/`.
- **Design lane:** Step 6a generates only `brand/`, an optional
  `_design_preview.html`, and `.tmp/design-execution-evidence.json`.

Neither lane may edit navigation, plan, lifecycle state, or the other lane's
files. If background tasks are unavailable, run data then design in the
foreground with the same inputs and outputs. Sequential fallback changes only
scheduling, not artifacts or validation.

Join only after both lanes succeed. Require the prototype manifest, experience
asset manifest, design spec, tokens, and design execution evidence. Then apply
tokens, native wrappers, and run the shared TypeScript gate. Do not run a
project-wide typecheck while either lane is still writing.

#### Step 5 - Generate Typed Mocks

Run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/gen-mock-services.js" "$PROJECT_DIR"
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

#### Non-blocking internal repair boundary

Do not ask the maker to resolve harmless bookkeeping. The existing generator
may normalize only an unambiguous affected field: casing, surrounding
whitespace, omitted optional arrays, conventional prototype primary IDs,
display-name fallbacks, and a unique case-insensitive lookup target. Record
every normalization in `.tmp/prototype-seed-regeneration.json`, surface its
count as a warning, and continue without regenerating the plan.

Keep a visible warning and continue when a non-critical ambiguity leaves the
approved requirements, routes, relationships, and source compilable. Return to
the owning plan section only for a semantic change. Block when continuing
would cause an unauthorized external mutation, lose an explicit requirement,
leave a lookup/relationship unresolved, require an unsupported mandatory
native capability with no accepted fallback, or leave source uncompilable
after the bounded local repair pass. Never repair those cases by dropping a
screen, operation, capability, media requirement, or product job.

#### Step 6a - Generate Automatic Design

Run `/design-system` in its lane as described below. It consumes the approved
logical data/content intent, not generated repository source.

### Step 6 - Join Lanes, Apply Native Capabilities And Design

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
not fall back to an inspection or industry preset. Normal prompt-only mode
must record `.tmp/design-execution-evidence.json` with `mode: automatic`, its
exact reference files/bytes, and the actual design model-call count. Reject an
automatic manifest that includes an input extractor, reference-intake, style
picker, brand example, or named vibe direction.

Apply `brand/tokens.ts` to `tamagui.config.ts` using the current
`/create-mobile-app` brand-token integration contract after both lanes join,
then type-check once.

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
- Read `.tmp/screen-build-pack.json` before skeleton generation. Use its
  `screens`, dependencies, fixture adapter, foundation primitives, and build
  order as the execution source; Markdown remains for detailed service clauses.
  Each skeleton imports `ScreenShell`, `toExperienceRecord`, and
  `getExperienceAsset`; route branches use the pack's literal `headerMode` and
  never introduce a second `SafeAreaView` or index-keyed presentation copy.

Run `npm --prefix "$PROJECT_DIR" run type-check` before builders.

### Step 8 - Build Screens

Read `.tmp/screen-build-pack.json → execution`. Build the `canary` first:
permanent Home followed by every ordered screen required to complete the
sidecar-selected key flow. A one-screen flow still produces a two-screen
canary; a multi-step receiving, inspection, booking, checkout, or onboarding
flow includes all required steps through completion. Use the same screen work
order and artifact envelope for canary and supporting screens.

Probe `Task` once before dispatch. When `mobile-app:screen-builder` is
available, spawn only the canary builders in the first wave. If the host cannot
dispatch the configured builder, use the foreground fallback: process one
canary screen at a time from the same pack entry, fill only that screen's
existing typed skeleton, and run the identical validators. Never invent a
different inline screen contract or skip a required canary screen.

Every builder or foreground work order must include:

```text
Data mode: prototype.
screen_build_pack_path: PROJECT_DIR/.tmp/screen-build-pack.json
Use only the typed services exported from @/generated/services. They are
in-memory implementations with deterministic seed data and the same app-facing
CRUD contract that graduation will preserve through adapters when necessary.
Do not import *.seed.json, call Dataverse, call connectors directly, or weaken
the approved domain-specific first viewport.
Read PROJECT_DIR/.tmp/experience-contract.json and
PROJECT_DIR/.tmp/experience-screen-contract.json before writing. For the
primary screen, materialize the exact ordered `experience-region-*` anchors,
`experience-primary-action`, and `experience-motif-*` anchors; do not replace
the entry mode with a dashboard, generic List, or CRUD trio.
Read PROJECT_DIR/.tmp/experience-foundation-contract.json and import the exact
selected primitives from `@/components/experience/<component>` rather than
recreating their motifs inside the screen.
Read PROJECT_DIR/.tmp/screen-build-pack.json, validate it, and use the matching
screen entry/revision for purpose, first viewport, states, dependencies, test
IDs, headerMode, and stable-ID view model. Convert service rows through
`toExperienceRecord`; use its ID for detail/cart identity and pass its local
asset recipe to `EntityImage`. Only an explicitly logged compatibility fallback
may proceed without a pack.
```

When design-intake.md exists, also include this Reference Contract in every
screen-builder prompt:

~~~text
Reference fidelity: <value from design-intake.md>.
Read PROJECT_DIR/design-intake.md and the plan Reference Contract before
editing. Materialize every required motif with its Runtime Marker testID.
Preserve region order, media prominence, navigation silhouette, and forbidden
drift. Do not add a generic search field, product grid, ratings, discount
badges, payment, sign-in, or other unapproved UI merely because the domain is
retail.
~~~

Run the screen-wave TypeScript gate after every wave. Group failures by root
cause and cap retries at two per screen.

After the canary wave, run these focused gates before Metro:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-contract.js" --project-root "$PROJECT_DIR" --phase build
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-build-pack.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-shells.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
npm --prefix "$PROJECT_DIR" run type-check
```

Do not start Metro unless Home and every declared key-flow screen are real TSX
and every canary gate passes. Immediately before launch or reuse, prepare the
local session:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/manage-prototype-metro.js" \
  --project-root "$PROJECT_DIR" \
  --action prepare
```

For `action: verify-reuse`, read the recorded terminal once. Reuse it only when
its current output still contains a compatible `Metro waiting on` or `Logs for
your project` banner with no later fatal error. Otherwise rerun `prepare` with
`--ignore-existing` and start its exact `command` asynchronously from
`PROJECT_DIR`.

After a new terminal reports the ready banner, record its terminal ID, port,
and native URL with `--action ready`. Metadata is not health evidence by
itself; the foreground banner check is mandatory and direct HTTP probes are
forbidden. If launch exits or never reports readiness, call `--action failed`,
preserve the project, and report the helper's exact `manualCommand`. Do not
rerun planning or design.

Once the canary is Metro-ready, build `execution.supportingWaves` in order.
Screens within one wave may run in parallel; waves run sequentially and each
must pass TypeScript before the next begins. This includes Profile, which must
be complete and reachable before final completion. Rerender
`_prototype_workspace.html` after each wave so screen build status remains
current.

### Step 9 - Final Validation

Run in this order from `PROJECT_DIR`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-contracts.js" "$PROJECT_DIR/native-app-plan.md" --project-root "$PROJECT_DIR" --phase build
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-contract.js" --project-root "$PROJECT_DIR" --phase build
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-build-pack.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-shells.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-media.js" --project-root "$PROJECT_DIR" --pack ".tmp/screen-build-pack.json"
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
result must also be recorded. Missing native coverage is a concern, not a
passing visual match.

For every prototype, once a real device/capture environment is available,
capture the primary screen and every sidecar-declared key-flow route at normal
and large text. The generic manifest must include all routes, screenshot paths or
non-testID capture IDs, iOS/Android platform/device metadata, and evidence-backed checks for hierarchy/focal point,
task fit, realistic content, primary action, motifs, forbidden drift, contrast,
touch targets, safe areas, keyboard behavior (or reasoned N/A), offline state,
screen-reader order, responsive/compact layout, and localized/long content.
Each check names the reviewed capture IDs:

~~~bash
node "$CLAUDE_SKILL_DIR/../../scripts/validate-experience-visual-evidence.js" --project-root "$PROJECT_DIR" --manifest "$PROJECT_DIR/.tmp/experience-visual-review.json"
~~~

When the manifest or real native capture is unavailable, record
`DONE_WITH_CONCERNS: native experience visual capture unavailable` in
`.tmp/final-validation.md`; continue only after all static experience, route,
quality, contrast, and TypeScript gates pass. Static HTML/browser previews do
not satisfy the native visual review.

Run the mandatory changed-file dispatcher against every file written by this
workflow or its agents. Pass explicit files, not directories:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-files.js" \
  --project-root "$PROJECT_DIR" \
  --phase final \
  --manifest ".tmp/mobile-validation-manifest.json" \
  --skip-unchanged \
  --file <changed-file> [--file <changed-file> ...]
```

The dispatcher may skip this duplicate final pass only when the `final`
fingerprint matches a previous passing entry. The fingerprint includes exact
file bytes, validator identities, and approved JavaScript dependencies. Any
relevant change forces the validators to run again; never generalize this into
skipping validation after edits.

### Step 9.6 - Automated Design Refinement (LLM Polish)

After the script-based stylistic sweep, apply the final layer of context-aware design polish to the generated prototype screens.

**Print before starting:**
> "-> [prototype 9.6/10] Running automated design refinement pass to polish UI, typography, RTL layouts, and accessibility..."

Invoke the design skill:
```text
/design-react-native-app
```
Instruct the skill to review the generated screens in `<PROJECT_DIR>/app/(app)/` against the design system at `<PROJECT_DIR>/brand/tokens.ts`. 

Always provide native-app-plan.md, `.tmp/experience-contract.json`,
`.tmp/experience-screen-contract.json`, `.tmp/experience-foundation-contract.json`, `.tmp/screen-build-pack.json`, and brand/design-system.md. The
refiner may repair hierarchy, density, focal point clarity, and signature
motifs, but must not replace entry mode, region order, primary action, or
forbidden defaults with a dashboard or generic CRUD composition.

Wait for it to complete. If it modifies any UI files, run:
```bash
npm --prefix "$PROJECT_DIR" run type-check
```
to guarantee it didn't break TS typing.

For high or strict-structural fidelity, the design-refinement prompt must also
provide native-app-plan.md, design-intake.md, and brand/design-system.md.
Refinement may improve spacing, accessibility, and interaction states, but it
must not redesign the approved Home composition or introduce a Forbidden Drift
pattern. Re-run the relevant static gates after refinement.

After validation and design polish, invoke `/preview-screens --working-dir <PROJECT_DIR>` unless
the user opted out of visual companion output.

### Step 10 - Record State And Report Metro

Update `.mobile-app/state.json`:

- `dataMode: "prototype"`
- `environment: null`
- `transition: null`
- `lastSyncedPlanHash`: SHA-256 of `native-app-plan.md`
- `lastDataverseManifestHash: null`
- `lastSyncAt`: current ISO timestamp

Append a memory-bank entry with generated tables, planned connector stubs,
native capabilities, screens, validation result, maker workspace path, and
preview path.

development client that includes the native host; Expo Go is unsupported.
Reuse the healthy Metro terminal started after the canary. Do not start a
second process or re-probe the port. Return the terminal ID, port, native
URL/QR handoff, exact launch command, and
`.mobile-app/metro-session.json` status. Instruct the user to scan it with the
Power Apps Developer app or a compatible custom development client that
includes the native host; Expo Go is unsupported.

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
`DONE_WITH_CONCERNS: native experience visual capture unavailable` rather than
a visual-complete result. This generic receipt does not replace the stricter
reference-fidelity evidence below.

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

Static preview output is not a substitute. If a native device, capture, or
platform coverage is missing, return DONE_WITH_CONCERNS and name the missing
evidence. Never return DONE claiming a high or strict reference match until
the evidence validator passes.

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
Visual reference: <not requested | native evidence passed | native evidence pending/concerns>
Preview: <path>
Next: iterate with /edit-app, or run /prototype-to-real-app when the data model is ready for a real environment.
```

Use `DONE_WITH_CONCERNS: <concerns>` when a non-blocking connector stub or
visual review concern remains. Never use `DONE` when a route, contract,
quality, contrast, changed-file, or TypeScript gate failed.

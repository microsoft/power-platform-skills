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
template without selecting a Power Platform environment. The app uses a typed
neutral domain model, repository interfaces, query hooks, and realistic local
fixtures. It retains the normal
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
  Keep its Markdown plan and normal section approval gates. Do not replace it
  with a compact JSON-only planner or reconstruct the plan from a model
  response.
- The existing data-model architect also writes
  `.tmp/prototype-domain-model.json`. That neutral sidecar is the executable
  source for local entities, relationships, operations, repositories, hooks,
  fixtures, and scenarios; the Dataverse schema sidecar remains a
  non-executable persistence proposal.
- The prototype schema contract is not approved target-environment evidence.
  It must contain `planningMode: "prototype"` and
  `executionEligible: false`.
- Generate prototype data only under `src/data/`. Screen code imports hooks
  and domain types only from `@/data`; it must not import fixtures,
  repositories, generated services, connector clients, or call raw HTTP APIs.
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
and validation stages. For a clear brief continue automatically; ask only the
single focused first-outcome clarification allowed for low confidence. This
preview is not a separate approval gate.

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

Resolve the evidence-bounded prototype context and workflow journey before
planning. These sidecars constrain fixture realism, staged actions, resume
behavior, capability placement, and UX continuity; they do not replace the
human-readable plan:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-context-enrichment.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-context-enrichment.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-workflow-journey.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-workflow-journey.js" \
  --project-root "$PROJECT_DIR"
```

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
Neutral prototype domain output: <PROJECT_DIR>/.tmp/prototype-domain-model.json
Product experience contract: <PROJECT_DIR>/.tmp/experience-contract.json
Context enrichment contract: <PROJECT_DIR>/.tmp/context-enrichment-contract.json
Workflow journey contract: <PROJECT_DIR>/.tmp/workflow-journey-contract.json
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
discovery. Do not pause at real-app section gates and do not mint an approval
receipt. The foreground will resolve Navigation and run one consolidated local
review for product/screens, logical data, native capabilities, connector
intent, design direction, assumptions, and build order. The schema sidecar
must be complete enough for typed local mocks and must be marked
planningMode=prototype, executionEligible=false.
The data-model architect must additionally write and validate the neutral
prototype domain model. It names the stable repository interfaces and hooks
that screens use in both prototype and Dataverse modes.
External connector rows remain requirements; prototype generation will create
throw-stubs at their expected service paths.
Read and mirror the Product Experience Contract under `## Design` before
planning the data model or screen graph. Screen planning must write
`.tmp/experience-screen-contract.json` and may not default Home to a dashboard
or force a List/Detail/Form flow unless the contract requires those shells.
```

Parse the agent's literal first line using the status protocol in
`AGENTS.md`. Retry `NEEDS_CONTEXT` at most twice, surface
`DONE_WITH_CONCERNS`, and stop on `BLOCKED` or a malformed status.

Before continuing, require all of:

```bash
test -f "$PROJECT_DIR/native-app-plan.md"
test -f "$PROJECT_DIR/.tmp/dataverse-schema-contract.json"
test -f "$PROJECT_DIR/.tmp/prototype-domain-model.json"
test -f "$PROJECT_DIR/.tmp/experience-contract.json"
test -f "$PROJECT_DIR/.tmp/context-enrichment-contract.json"
test -f "$PROJECT_DIR/.tmp/workflow-journey-contract.json"
test -f "$PROJECT_DIR/.tmp/experience-screen-contract.json"
test -f "$PROJECT_DIR/.tmp/experience-foundation-contract.json"
node -e "const c=require(process.argv[1]); if(c.planningMode!=='prototype'||c.executionEligible!==false||!Array.isArray(c.tables)) process.exit(1)" "$PROJECT_DIR/.tmp/dataverse-schema-contract.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-prototype-domain-model.js" \
  --project-root "$PROJECT_DIR"
```

Finalize and validate the executable graph before approval. The resolver
normalizes planner schema v1 to v2, preserves optional product-role/parent
hints, rebinds pre-screen Journey stages/actions to actual screen IDs,
synthesizes a missing critical flow, and then resolves durable destinations,
nested ownership, Profile access, and launch/resume policy. These are
deterministic compatibility operations; do not re-dispatch the planner for
missing optional bookkeeping.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-navigation-contract.js" --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-contract.js" --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/prototype-plan-review.js" \
  --project-root "$PROJECT_DIR" --action draft
```

Present exactly one editable review from `native-app-plan.md` and the existing
sidecars. Include product/audience/primary job, assumptions/confidence, journey
and outcomes, Home/launch/resume/key flow, screen graph and five-way roles,
navigation, compact logical data/fixture summary, capability placement and
fallbacks, future connector proposals, design direction/signature components,
build order, and preview status. Ask `Approve`, `Revise`, or `Cancel` once.

On `Revise`, edit only the named section, rerun dependent planning validation,
resolve Navigation again when screen/jobs changed, and present the same
consolidated review. On explicit approval run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/prototype-plan-review.js" \
  --project-root "$PROJECT_DIR" --action approve --response approve
node "${CLAUDE_SKILL_DIR}/../../scripts/prototype-plan-review.js" \
  --project-root "$PROJECT_DIR" --action status
test -f "$PROJECT_DIR/.tmp/mobile-plan-status.json"
```

The receipt must report `mayAuthorizeExternalMutations: false`. Do not start
template, data, design, native, or screen writes before this status passes.

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
`app/(app)/...tsx` file to an Expo href such as `/(app)/home`. Runtime
configuration is deferred until Step 5 creates the repository provider.

### Steps 5-6a - Generate Runtime Data, Then Design

Run these steps strictly in order. Do not run data generation and design in
parallel: automatic design requires the validated representative content that
Step 5 materializes. The approved neutral Domain, Screen, Journey, and
Navigation contracts remain immutable inputs throughout both steps.

#### Step 5 - Generate The Typed Domain Layer

Run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/migrate-legacy-prototype.js" "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/scripts/gen-data-layer.js" "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/scripts/configure-prototype-runtime.js" \
  "$PROJECT_DIR" prototype "$PROTOTYPE_ENTRY_ROUTE"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope domain
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-design-content-projection.js" \
  --project-root "$PROJECT_DIR"
```

The generator reads `.tmp/prototype-domain-model.json` and writes:

- neutral TypeScript models and repository contracts;
- realistic fixtures and fixture-state scenarios;
- in-memory repository implementations;
- TanStack Query hooks for approved operations;
- a `PrototypeDataProvider` mounted inside the existing
  `PowerAppsProvider`;
- fail-closed Dataverse and connector adapter placeholders;
- local/cache-backed media resolution and an exact generated-file manifest.

After domain validation, `compile-design-content-projection.js` writes the
bounded `.tmp/design-content-projection.json` consumed by automatic design. It
contains up to three real representative records per entity, actual field
combinations, choice/status vocabulary, longest strings, and non-offline
fixture scenarios. It is deterministic compiler output, not planner-authored
JSON. Do not invoke design when this projection is missing or stale.

The migrator is a no-op for a fresh project. On an explicitly resumed legacy
prototype, it transactionally preserves edited fixtures and restores the old
tree if domain validation fails.

Do not hand-edit generated domain files to hide a contract mismatch. Repair
the approved neutral domain model, regenerate, and rerun validation.

The runtime configuration intentionally bypasses route-level auth only while
`dataMode === 'prototype'`, keeps `PowerAppsProvider` as the host and Query
Client owner, mounts the repository provider beneath it, writes local
configuration, and records the original package command for graduation.

Write `.mobile-app/state.json` per
[`lifecycle-state.md`](../../shared/references/lifecycle-state.md) with
`dataMode: "prototype"`, null environment/transition/hashes, the current
domain/repository/fixture revisions, and the current lifecycle schema version.

#### Step 6a - Generate Automatic Or Optional Design

Require `.tmp/design-content-projection.json` before invoking `/design-system`.
The automatic path must read it before choosing tokens, component anatomy,
density, or spacing. Optional reference modes also receive it as product
content context; visual references may refine appearance but do not replace
the validated domain examples.

Run `/design-system` in orchestrator mode unless `--no-design`. Pass
`--working-dir` and `--design-intake` when supplied; the older
`--from-design-intake` spelling is accepted only as a compatibility alias. Even
with `--no-design`, require app-specific semantic aliases/tokens; never leave
the raw Tamagui starter palette as the product design.

Normal prompt-only prototypes must select `automatic-native.md`, ask no brand,
cost, style, HTML, or screenshot question, write 2-5 Product Experience
Primitives, and record the bounded context/model-call evidence. Explicit visual
inputs route to `optional-modes.md`.

For automatic-native mode, validate the exact context receipt before applying
tokens:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-design-context-evidence.js" \
  --project-root "$PROJECT_DIR"
```

Missing projection evidence, stale bytes, a stale content projection, more than
one design model call, or optional-mode reference loading is a design-step
failure. Repair design context/evidence only; never regenerate the planner.

### Step 6 - Apply Design And Native Capabilities

Do not continue until domain validation passes and
`.tmp/design-content-projection.json`, `brand/design-system.md`,
`brand/tokens.ts`, and `.tmp/design-context-evidence.json` exist. Validate that
the design context evidence includes the projection, then validate data/design
compatibility against media intent, state expectations, signature components,
and Screen/Navigation contracts.

For every approved `## Native Capabilities` row, execute `/add-native`
sequentially from `PROJECT_DIR`. The template allowlist and runtime bans remain
unchanged. A capability absent from the bundled template is a blocker; do not
install native code or fake a wrapper.

Require `/design-system` to read `$PROJECT_DIR/.tmp/experience-contract.json`
and `$PROJECT_DIR/.tmp/design-content-projection.json` before choosing tokens.
Its automatic direction comes from visual character, audience,
interaction/entry mode, focal point, motifs, density, and representative
content; it must write `## Product Experience Primitives` in
`brand/design-system.md` and must not fall back to an inspection or industry
preset.

Apply `brand/tokens.ts` to `tamagui.config.ts` using the current
`/create-mobile-app` brand-token integration contract, then type-check.

When design-intake.md exists, run design-system in reference-contract mode.
Pass the intake path and require it to read the approved native-app-plan.md.
For high and strict-structural references, preserve the intake hierarchy and
motifs; do not start a new generic style picker, replace the composition with
an industry preset, or substitute remote imagery for an offline-required
asset. The design-system output must name the Reference Contract, required
motifs, forbidden drift, and signature components before builders run.

Validate the approved Navigation Contract, then compile the compact builder
assembly sheet after runtime data and design outputs join:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-contract.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "$PROJECT_DIR" \
  --output ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-build-pack.js" \
  --project-root "$PROJECT_DIR" \
  --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/route-manifest.js" \
  --project-root "$PROJECT_DIR" --action validate
```

Do not launch skeleton or builder work when the pack is missing or stale.
The resolver may normalize the existing screen sidecar, but it must not alter
the approved Markdown plan or invent destinations. Re-run
`npm --prefix "$PROJECT_DIR" run type-check`.

### Step 7 - Shared Code And Typed Skeletons

Reuse the current owning implementation in `/create-mobile-app` for shared
code, contract-selected foundation primitives, pack-derived dependencies, and
typed skeletons. Do not apply the navigation shell yet; the foreground applies
it after the native canary screens are real TSX and before Metro starts.

Prototype-specific rules:

- Keep the `dataMode !== 'prototype'` auth guard in
  `app/(app)/_layout.tsx`; the shell applicator preserves it.
- Never let a screen-builder edit layout files, generated domain files,
  fixtures,
  package files, lifecycle state, or the plan.
- Skeleton data imports come only from `@/data` and use the exact hooks and
  domain types named by the build pack.
- Read `.tmp/experience-foundation-contract.json` before skeleton generation.
  Create each selected component under `src/components/experience/`, export it
  from the shared barrel, retain its exact motif testID, and use local/bundled
  media fallback when `assetPolicy.media` is `local-first`. The prototype must
  not substitute a remote placeholder or generic card for a required motif.
- Read `.tmp/screen-build-pack.json` before skeleton generation. Use its
  `screens`, dependencies, fixture adapter, foundation primitives, and build
  order as the execution source; Markdown remains for detailed service clauses.
  Each skeleton imports `ScreenShell` plus its approved `@/data` hooks; route
  branches use the pack's literal `headerMode` and never introduce a second
  `SafeAreaView`, fixture import, or index-keyed presentation copy.

Run `npm --prefix "$PROJECT_DIR" run type-check` before builders.

### Step 8 - Build Screens

Read `.tmp/screen-build-pack.json → builderWaves`. Require `foundations`,
`native-canary`, and bounded `supporting-*` waves. The `native-canary` targets
must equal Home plus the complete critical/key-flow sequence; do not replace
them with empty skeletons or a readiness hash.

Build only `native-canary` first. Mark those routes `building`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/route-manifest.js" \
  --project-root "$PROJECT_DIR" --action update \
  --screen <canary-screen-id> [--screen <canary-screen-id> ...] \
  --status building
```

Spawn `mobile-app:screen-builder` for each canary screen using the same screen
work order and artifact envelope as later screens. Persist every returned
artifact only through `write-screen-artifact.js`. Use the foreground fallback
from the host-capability contract when nested builders are unavailable; it must
consume the same pack entries and validators. Each prompt must include:

```text
Data mode: prototype.
screen_build_pack_path: PROJECT_DIR/.tmp/screen-build-pack.json
Use only the typed domain hooks and types exported from @/data. The repository
interfaces remain stable when graduation replaces mock adapters with
Dataverse adapters. Do not import fixtures, repositories, generated services,
raw connector clients, or weaken the approved domain-specific first viewport.
Read PROJECT_DIR/.tmp/experience-contract.json and
PROJECT_DIR/.tmp/experience-screen-contract.json before writing. For the
primary screen, materialize the exact ordered `experience-region-*` anchors,
`experience-primary-action`, and `experience-motif-*` anchors; do not replace
the entry mode with a dashboard, generic List, or CRUD trio.
Read PROJECT_DIR/.tmp/experience-foundation-contract.json and import the exact
selected primitives from `@/components/experience/<component>` rather than
recreating their motifs inside the screen.
Read PROJECT_DIR/.tmp/workflow-journey-contract.json,
PROJECT_DIR/.tmp/navigation-contract.json, and the matching build-pack screen.
Preserve stage guards, action priority, continuity keys, destination
ownership, first viewport, states, dependencies, test IDs, and header mode.
Use canonical domain IDs and `resolveDomainMedia` from @/data. Missing or stale
contracts are blockers; do not infer a fallback navigation or data shape.
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

After writing canary screens:

1. validate each canary with `validate-mobile-app.js --scope screen --screen`;
2. run `npm --prefix "$PROJECT_DIR" run type-check`;
3. apply and validate the navigation shell;
4. mark canary routes `type-safe`;
5. start Metro with `--require-canary`;
6. capture/review clean native Home and key-flow evidence when the host has a
   simulator/device capture surface;
7. repair shared/root causes once, then rerun the canary gates.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/apply-navigation-shell.js" --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-shell.js" --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-continuity.js" --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/route-manifest.js" \
  --project-root "$PROJECT_DIR" --action update \
  --screen <canary-screen-id> [--screen <canary-screen-id> ...] \
  --status type-safe
node "${CLAUDE_SKILL_DIR}/../../scripts/start-prototype-metro.js" \
  --project-root "$PROJECT_DIR" --require-canary
node "${CLAUDE_SKILL_DIR}/../../scripts/route-manifest.js" \
  --project-root "$PROJECT_DIR" --action update \
  --screen <canary-screen-id> [--screen <canary-screen-id> ...] \
  --status available-in-metro
```

Do not evaluate a refreshing/disconnected/debug-overlay frame. If native
capture is unavailable, record `DONE_WITH_CONCERNS: native canary capture
unavailable` and continue only after static canary/type/Metro gates pass.

Once the canary passes, build `supporting-*` waves in dependency order. Screens
inside one wave may run in parallel; waves remain sequential. Mark each wave
`building`, persist artifacts through the same writer, run per-screen checks
and TypeScript, then mark it `type-safe`. Group failures by root cause and cap
retries at two per screen. Never let builder completion order change Home,
navigation, tokens, shared components, domain data, or route ownership.

### Step 9 - Final Validation

Run in this order from `PROJECT_DIR`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-contracts.js" "$PROJECT_DIR/native-app-plan.md" --project-root "$PROJECT_DIR" --phase build
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-contract.js" --project-root "$PROJECT_DIR" --phase build
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report app
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report app
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope all --record --reuse-if-unchanged
node "${CLAUDE_SKILL_DIR}/../../scripts/route-manifest.js" \
  --project-root "$PROJECT_DIR" --action validate --require-complete
```

The canonical complete-app validator runs domain, requirement/task,
navigation, runtime-state, media, screen-source, accessibility, safe-area, and
TypeScript checks after every supporting screen is type-safe. Validate the
route manifest again and fail if any planned screen is unreachable or remains
`planned`/`building`.

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
`DONE_WITH_CONCERNS: native experience visual capture unavailable` in
`.tmp/final-validation.md`; continue only after all static experience, route,
quality, contrast, and TypeScript gates pass. Static HTML/browser previews do
not satisfy the native visual review.

Run the mandatory changed-file dispatcher against every file written by this
workflow or its agents. Pass explicit files, not directories:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-files.js" \
  --project-root "$PROJECT_DIR" \
  --file <changed-file> [--file <changed-file> ...]
```

### Step 9.6 - Optional Finding-Scoped Design Repair

Default: skip. Do not invoke `/design-react-native-app` after a successful
normal build merely to add polish; that broad second design pass bypasses the
bounded automatic-native path and can mutate screens after validation.

Invoke it only when the maker explicitly requests a refinement or a named
static quality/composition check has failed and the affected screen-builder has
already attempted its local repair. Pass only the affected screen files, exact
findings, `brand/tokens.ts`, native-app-plan.md, `.tmp/experience-contract.json`,
`.tmp/experience-screen-contract.json`, `.tmp/experience-foundation-contract.json`,
`.tmp/screen-build-pack.json`, and brand/design-system.md. Reference-led work
also receives design-intake.md.

The repair may adjust hierarchy, density, spacing, focal clarity, and existing
signature motifs. It must not change routes, jobs, data operations, entry mode,
region order, primary action, composition profile, or forbidden defaults. When
it writes any file, rerun every affected per-screen check, TypeScript, changed-
file validation, and the complete Step 9 validation sequence. A repair that
cannot pass those existing gates is reverted only by the repair owner and
reported as a concern; it never triggers planner regeneration.

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
native capabilities, screens, validation result, and preview path.

Reuse the Metro process started after the native canary. Do not start a second
process or rerun planning/design because Metro disconnected. Return its
recorded URL, port, command, log path, and truthful status. If launch failed,
preserve the project and report the exact manual command. Do not use a web
runtime or crawl routes in a browser. The user opens the URL/QR in the Power
Apps Developer app or a compatible custom development client; Expo Go is
unsupported.

### Step 10.5 - Native Reference Evidence

For every prototype, native capture additionally validates the generic
experience contract. Ensure `$PROJECT_DIR/.tmp/experience-visual-review.json`
names `keyFlowRoute`, captures Home and key-flow outcome on iOS and Android,
captures Home at large text on at least one platform, and scopes every
evidence-backed check to `primary` and `key-flow`. Every capture records
`screenId`, route, platform/device, dimensions, text size, stable state, and
cleanliness with Metro overlay, development error overlay, and host debug
chrome all `absent`.

Do not capture or review while the app says `Refreshing...`, `Disconnected`,
shows a development error/red box, or displays the purple host/debug gear.
Those frames fail evidence even when the app composition underneath is good.
Review focal point/action, header and safe areas, media/fallback, card/list
density and crop, bottom/sticky clearance, touch targets, readable text,
screen-reader order, responsive width, and long/localized content.
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
3. Key-flow outcome at default text size on iOS.
4. Key-flow outcome at default text size on Android.
5. Home at large system text on either platform.

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
      "captureId": "native automation capture ID when a local path is unavailable",
      "screenId": "Home or key-flow screen ID",
      "dimensions": { "width": 390, "height": 844 },
      "captureState": "stable",
      "cleanliness": {
        "metroOverlay": "absent",
        "developmentErrorOverlay": "absent",
        "hostDebugChrome": "absent"
      }
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

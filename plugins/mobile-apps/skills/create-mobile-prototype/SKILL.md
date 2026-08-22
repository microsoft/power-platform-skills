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

- Start with either an empty target directory or a fresh `expo-app-standalone`
  template. Track A may materialize the bundled template only into an empty
  target; it never overlays an existing app.
- Require the committed `package-lock.json`. Prefer pnpm's committed lockfile
  and warm content-addressed store; use `npm install` when pnpm is unavailable.
  Never use `npm ci` for this workflow.
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

## Two-Track Progress Contract

Start both tracks at Step 1. Track A is deterministic and never waits for the
model: materialize/install, start Metro, paint the temporary branded shell, then
hold the server. Track B captures the brief, plans, generates, builds, and
repairs. Track B never starts a dev server.

Read and follow [`runtime/supervisor.md`](./runtime/supervisor.md). Track A
failure records a concern and Track B continues in text-only mode. All watched
files use atomic writes; shell progress updates are debounced by 500 ms.

The single progress source is `<PROJECT_DIR>/.mobile-build/events.ndjson`.
Neither track prints progress directly. Emit through `runtime/events.js`; its
terminal renderer is one consumer, while the phone shell reduces the same file.
Metro exposes `GET /build/events` (SSE replay from `t=0`) and
`GET /build/state` (cold-load reduction). Never start a second server.

Before and after every long Track B phase:

```bash
node "${CLAUDE_SKILL_DIR}/runtime/events.js" emit "$PROJECT_DIR" \
  --json '{"kind":"phase","track":"B","id":"<phase>","state":"start","label":"<label>"}'
# phase work
node "${CLAUDE_SKILL_DIR}/runtime/events.js" emit "$PROJECT_DIR" \
  --json '{"kind":"phase","track":"B","id":"<phase>","state":"complete","label":"<label>"}'
```

## Workflow

### Step 1 - Start Both Tracks

Resolve `PROJECT_DIR` from `--working-dir` or the current directory. Start Track
A immediately, before reading the brief or invoking a model:

```bash
node "${CLAUDE_SKILL_DIR}/runtime/supervisor.js" start "$PROJECT_DIR"
```

The command returns `DONE` or `DONE_WITH_CONCERNS` as JSON. Record concerns and
continue Track B. A failed install, occupied port, Metro crash, or missing QR
must not stop planning.

Classify the directory using the same markers as
[`/create-mobile-app`](../create-mobile-app/SKILL.md#fresh-template-working-directory-mode):

| State | Action |
|---|---|
| Empty target | Track A copies the bundled template and installs from locks. |
| Fresh installed template | Track A installs only when dependencies are absent. |
| Template files exist but `node_modules/expo` is absent | Track A runs the deterministic installer. Do not provision npm credentials. |
| `memory-bank.md`, `native-app-plan.md`, `.datamodel-manifest.json`, `src/generated/services/*.ts`, or `.mobile-app/state.json` exists | STOP unless this is an explicitly confirmed resume of the same prototype run. |
| Required template files are missing | STOP and point to the README `degit` setup. |

Require Node 22+ and npm 10+. Do not probe Power Platform or native build
toolchains.

The supervisor selects `pnpm install --frozen-lockfile` when pnpm is available
and falls back to `npm install`. Both consume committed lockfiles. It writes the
`Building your app` shell before the plan exists and budgets 30 seconds for a
scannable Metro handoff.

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

Within roughly five seconds of parsing the brief, emit this compact echo before
the impact preview. It names inferred and dropped behavior, not plan prose:

```text
Understood: <domain and user outcome>
Flow:       <actor action -> decision -> completion>
Records:    <important records and relationships>
Inferred:   <every inferred record, role, identity, or workflow assumption>
Native:     <ready template capabilities or none>
Dropped:    <every requested unsupported capability and allowlist reason or none>
Connectors: <planned connector names or none>
Assumed:    <visual direction and why it was selected>
```

Anything dropped from the template capability allowlist must appear here.
Write the structured summary and let the event renderer print those eight lines:

```bash
node "${CLAUDE_SKILL_DIR}/runtime/events.js" emit "$PROJECT_DIR" --json \
  '{"kind":"brief","summary":{"understood":"...","flow":"...","records":[],"inferred":[],"native":[],"dropped":[],"connectors":[],"assumed":"..."}}'
```

#### Step 2.1 - Derive Seed Vocabulary (Spike)

After writing `brief.md` and before showing the impact preview, derive a seed
vocabulary from that brief alone and write
`<PROJECT_DIR>/.tmp/seed-vocabulary.json`. This is an LLM-authored planning
artifact, not a selection from a bundled catalogue.

```json
{
  "domain": "<short domain phrase copied from the brief>",
  "rowCount": 12,
  "pools": {
    "person": ["8-10 plausible full names with varied origins"],
    "company": ["6-8 domain-specific organisation names"],
    "location": ["4-6 domain-specific sites or buildings"],
    "door": ["6-8 domain-specific rooms, gates, zones, or sub-locations"],
    "title": ["6-8 recognisable work-item titles"],
    "note": ["5-6 short domain-real remarks"],
    "role": ["roles using the wording present in the brief"]
  },
  "idFormats": {
    "serial": "<domain prefix>-{seq4}",
    "reference": "<domain prefix>-{year}-{seq4}",
    "code": "{ALPHA2}-{seq3}"
  }
}
```

Hard rules:

- Derive every pool value from the users, records, workflow, places, and
  terminology in `brief.md`. Do not read, select, or copy a fixed domain pack.
- Keep `domain` as a concise phrase that appears verbatim in the brief. Preserve
  the brief's wording for `pools.role` so provenance is mechanically checkable.
- Use stable ordering and unique values within each pool. Do not add generic
  numbered strings such as `Item 1` or `<Entity> 1`.
- Add extra string-array pools when the brief explicitly names another display
  role that the base pools do not represent. Do not invent schema-only pools
  before the data model exists.
- Use `rowCount: 12` for this spike unless an approved input explicitly requires
  a different density.

Validate the artifact before the impact preview:

```bash
mkdir -p "$PROJECT_DIR/.tmp"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-seed-vocabulary.js" \
  "$PROJECT_DIR/.tmp/seed-vocabulary.json" \
  --brief "$PROJECT_DIR/brief.md"
```

If validation fails, repair only the vocabulary and rerun the command. Do not
continue to planning with an invalid artifact.

**Generator contract:** Step 5 consumes this validated vocabulary. Treat it as
immutable seed intent for the approved brief; revise and revalidate it only when
the brief changes.

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

Choose `REAL_PROTOTYPE_ENTRY_ROUTE` from the approved Screen Map: use the explicit
initial/home route, otherwise the first tab/root route. Normalize the plan's
`app/(app)/...tsx` file to an Expo href such as `/(app)/home`.

Restore the template index atomically, then enable the reversible local runtime
on the temporary shell route. The real route is released only after screens are
built:

```bash
node "${CLAUDE_SKILL_DIR}/runtime/supervisor.js" prepare-runtime "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/scripts/configure-prototype-runtime.js" \
  "$PROJECT_DIR" prototype "/building"
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
test -f "$PROJECT_DIR/.tmp/seed-vocabulary.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-seed-vocabulary.js" \
  "$PROJECT_DIR/.tmp/seed-vocabulary.json" \
  --brief "$PROJECT_DIR/brief.md"
node "${CLAUDE_SKILL_DIR}/scripts/gen-mock-services.js" "$PROJECT_DIR"
npm --prefix "$PROJECT_DIR" run type-check
```

The generator reads `.tmp/dataverse-schema-contract.json` plus the validated
`.tmp/seed-vocabulary.json` and writes:

- one in-memory CRUD service and deterministic seed file per service-required
  table;
- one prototype schema per table;
- connector throw-stubs from `## Connectors`;
- `src/generated/choiceLabels.ts`, with one contract-derived map per choice
  column and a safe `choiceLabel()` helper;
- `src/generated/services/index.ts`, `src/generated/index.ts`, and registries;
- `src/generated/.prototype-manifest.json`, including the vocabulary hash and
  exact cleanup inventory.

Inspect seed density before screen construction. Require related parent IDs,
multiple workflow/choice states, past and future dates where relevant, edge
states, and domain-readable labels. Generic numbered rows are a blocker for a
recognized field-service, inventory, CRM, grocery/retail, or healthcare brief.

Do not hand-edit a generated service to hide a contract mismatch. Repair the
approved structured contract or generator, regenerate, and rerun type-check.

### Step 6 - Apply Native Capabilities And Design

Run `/design-system` in orchestrator mode unless `--no-design`. Pass
`--working-dir` and `--from-design-intake` when supplied. Preserve its existing
approval flow and wait for the approved `brand/tokens.ts` and
`brand/design-system.md`; do not bypass or pre-answer its gate. With explicit
`--no-design`, the deterministic helper below supplies the required baseline.

After the design approval gate or explicit skip, add the prototype's schema
semantics before invoking any screen planner or builder:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/generate-prototype-design-system.js" \
  "$PROJECT_DIR"
test -f "$PROJECT_DIR/brand/tokens.ts"
test -f "$PROJECT_DIR/brand/design-system.md"
npm --prefix "$PROJECT_DIR" run type-check
```

When approved brand artifacts already exist, the helper preserves their palette
and design direction and updates only its managed status/date blocks. Without
brand artifacts, it authors a deterministic app-specific baseline.
`brand/tokens.ts` must exist before Step 7 creates a screen skeleton and before
Step 8 spawns the first screen-builder.

For every approved `## Native Capabilities` row, execute `/add-native`
sequentially from `PROJECT_DIR`. The template allowlist and runtime bans remain
unchanged. A capability absent from the bundled template is a blocker; do not
install native code or fake a wrapper.

Apply `brand/tokens.ts` to `tamagui.config.ts` using the current
`/create-mobile-app` brand-token integration contract, then type-check.

### Step 7 - Navigation, Shared Code, And Skeletons

Reuse the current owning implementation in `/create-mobile-app`, in this order:

1. Step 10.7 generated-service snapshot, using the prototype services now on
   disk.
2. Generate navigation from the approved Screen Map plus Navigation Contracts:
  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/generate-prototype-navigation.js" \
    "$PROJECT_DIR"
  node "${CLAUDE_SKILL_DIR}/runtime/supervisor.js" plan "$PROJECT_DIR" \
    --plan "$PROJECT_DIR/native-app-plan.md"
  ```
  Tab roots must use `navigate`, labels must be content nouns, and at most one
  tab may be app furniture (`Home`, `Profile`, `Settings`, and equivalents).
  The active/inactive tab colours and icon size must come from
  `brand/tokens.ts`; status tokens are forbidden on navigation chrome.
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

For every screen, update the supervisor around the existing builder and
TypeScript gates using the slug printed by `supervisor.js plan`:

```bash
node "${CLAUDE_SKILL_DIR}/runtime/supervisor.js" screen "$PROJECT_DIR" --id <id> --state building
# builder writes the skeleton, then fills content atomically
node "${CLAUDE_SKILL_DIR}/runtime/supervisor.js" screen "$PROJECT_DIR" --id <id> --state written
# after the screen-wave type-check
node "${CLAUDE_SKILL_DIR}/runtime/supervisor.js" screen "$PROJECT_DIR" --id <id> --state checked
# after its focused checks
node "${CLAUDE_SKILL_DIR}/runtime/supervisor.js" screen "$PROJECT_DIR" --id <id> --state built
```

Use `failed` for a terminal builder/check failure. Skeleton always lands before
content. Never write the same watched file concurrently.

```text
Data mode: prototype.
Use only the typed services exported from @/generated/services. They are
in-memory implementations with deterministic seed data and the same app-facing
CRUD contract that graduation will preserve through adapters when necessary.
Do not import *.seed.json, call Dataverse, call connectors directly, or weaken
the approved domain-specific first viewport.

Prototype screen-builder rules (HARD):
1. Tokens only - every colour, size, and radius resolves to brand/tokens.ts. No
  raw colour, size, or radius literals in a screen file.
2. testIDs by convention - use screen:<name> on the screen root; pinned:<what>
  on every pinned layer; row:<entity>:<id> on each data row; row-meta on the
  row fact container; cta-primary and cta-secondary on commands; hero on the
  catalogue hero.
3. Bottom inset - scroll content bottom padding is at least the sum of all
  pinned-layer heights plus the current safe-area bottom inset.
4. Catalogue hero - hero imagery comes only from a field explicitly marked
  hero-eligible in the plan/schema. If no field is eligible, render no hero;
  never substitute a mood or atmospheric asset.
5. Attribute chains - every list row shows 3-4 data-bound facts in one fixed
  order shared by all rows on that screen.
6. Icons - use the approved icon family for every row and every labelled field.
  Icons supplement visible labels and never replace them.
7. Status micro-copy - every screen that writes data shows a provenance line,
  such as "Saved locally - syncs automatically" or "Recorded locally -
  <time>".
8. Cardinality - implement every `Cardinality` decision from the screen spec
  and put `testID="cardinality:<element-key>:<pattern-key>"` on the rendered
  pattern root. Never choose chips, tabs, choice controls, lists, child lists,
  action groups, stat layouts, or image layouts without using the recorded N.
9. Images - every remote image has an explicit aspect ratio or fixed size and
  `contentFit`/`resizeMode`; percentage dimensions are forbidden. Show a
  token-based loading treatment and the local template placeholder on
  failure/offline. Meaningful images use a data-bound accessible description;
  decorative images are hidden from assistive technology. Image count follows
  the approved Cardinality pattern.
10. Discipline - use only `typeScale` roles and `shapeScale` radii from
  `brand/tokens.ts`. A gradient must use a named `gradients` token and
  `testID="gradient:<token>:<content|state|magnitude|legibility>"`; never put a
  gradient on interactive chrome. State/magnitude gradients also set
  `dataSet={{ gradientBound: '<schema-field>' }}` unless they wrap a
  `chart:*`/`progress:*` component. Use one row icon size, one chrome icon
  size, and at most one filled full-width `cta-primary` per screen.
11. Conditional UX - implement `Field visibility`, `Warning remedies`, `Input
  roles`, and `Entity icons` exactly. Rows expose `data-record-state`; use
  `conditional-field:<field>`, sibling `warning:<key>` + interactive
  `remedy:<key>`, `input-role:<field>:numeric-stepper` with decrement/increment
  testIDs, and `entity-icon:<entity>:<icon>`. A selected cautionary/negative
  option uses its status tone, never the accent. Compute every planned Rollup
  from loaded child rows and render `rollup:<name>`.
12. Sort - implement every `Sort options` contract with `sort-control`.
  Use `sort-control:inline-chips` for 2-3 options or `sort-control:sheet` for
  4+, and `sort-active:<field>:<direction>` on visible active-sort text.
  Results use `sort-results` plus `dataSet={{ sortReset: 'top' }}`; applying a
  sort resets to offset 0 and calls the declared service `orderBy`.
13. Batch selection - implement `Batch actions` with `multi-select-list` and
  `batch-action-bar`. Enter by long-press or visible Select, never permanent
  checkboxes. Active mode exposes `selection-mode:active`, `selection-count`,
  interactive `selection-select-all` and `selection-exit`, and exactly one
  `pinned:batch-actions` replacing the normal CTA. Use `batch-actions:buttons`
  for 1-3 actions or `batch-actions:primary-overflow` for 4+. Destructive
  `batch-destructive:<key>` confirmation visibly/accessibly names the count.
14. Carousel - implement `Carousel` only on a browsable non-queue image
  collection with at least 3 items. Use `carousel:<entity>:carousel-row` and
  `carousel-item:<id>`, trailing-edge bleed, snap-to-start, preserved offset,
  no auto-advance, and accessible `<position> of <total>` labels. One or two
  items fall back to a static row.
15. Charts - implement approved `Chart` only with exact installed
  `d3-scale@4.0.2` and its approved type companion. Use `chart:sparkline` or
  `chart:series-chart:<bar|area>`, `chart-point:<index>`, chart token data
  attributes, and a visible `chart-caption` plus accessible root summary.
  Series charts render `chart-axis-label` elements in `labelSmall`, use at most
  12 points and one series, and show the planned range-aware empty state. Area
  form uses only `gradient:chartArea:magnitude`; colors never use accent/status.
```

Run the screen-wave TypeScript gate after every wave. Group failures by root
cause and cap retries at two per screen.

After the cold builder wave, inspect its output without editing the screen
files. For every applicable screen, require: conventional testIDs, one icon per
row and labelled field, 3-4 ordered row facts, write provenance, token-only
styling, and bottom padding that accounts for pinned layers plus safe area. If
any rule is missed, return:

```text
BLOCKED: prompt-injection-failed - cold screen-builder output did not follow: <rules>
```

Do not hand-fix the generated screens in this failure path. Record the result
so a later phase can decide whether rendered per-direction references are
required instead of prose-only prompt injection.

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

Then run the direct-component harness. It bundles each signed-in screen without
starting Expo web, renders it in headless Chrome through the required native
shims, and blocks on each invariant independently:

```bash
for CHECK in \
  scroll-padding \
  contrast \
  raw-values \
  seed-hero \
  interactive-overlap \
  primary-label-truncation \
  cardinality \
  discipline \
  conditional \
  sort \
  batch-selection \
  carousel \
  chart
do
  node "${CLAUDE_SKILL_DIR}/harness/run.js" \
    --project "$PROJECT_DIR" \
    --check "$CHECK"
done
```

The harness must use the generated project's own `esbuild`, React, Tamagui,
and React Native Web dependencies. Do not replace it with a full Expo web build
or suppress a screen that fails to bundle/render.

Finally, report first-viewport seed density without gating completion yet:

```bash
node "${CLAUDE_SKILL_DIR}/harness/run.js" \
  --project "$PROJECT_DIR" \
  --check density | tee "$PROJECT_DIR/.tmp/density-report.txt"
```

`density` builds its oracle from every generated `*.seed.json`, counts matching
visible text nodes in the first viewport, and reports the comparison floor:
35 for List/queue screens, 8 for other data-backed screens. This phase is
measurement-only: record `wouldMeetFloor`, but do not fail generation on it.

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

Invoke the design skill:
```text
/design-react-native-app
```
Instruct the skill to review the generated screens in `<PROJECT_DIR>/app/(app)/` against the design system at `<PROJECT_DIR>/brand/tokens.ts`. 

Wait for it to complete. If it modifies any UI files, run:
```bash
npm --prefix "$PROJECT_DIR" run type-check
```
to guarantee it didn't break TS typing.

After validation and design polish, invoke `/preview-screens --working-dir <PROJECT_DIR>` unless
the user opted out of visual companion output.

### Step 10 - Record State And Release The Built App

Update `.mobile-app/state.json`:

- `dataMode: "prototype"`
- `environment: null`
- `transition: null`
- `lastSyncedPlanHash`: SHA-256 of `native-app-plan.md`
- `lastDataverseManifestHash: null`
- `lastSyncAt`: current ISO timestamp

Append a memory-bank entry with generated tables, planned connector stubs,
native capabilities, screens, validation result, and preview path.

Release the approved real entry route and inspect the Track A process that has
been running since Step 1:

```bash
node "${CLAUDE_SKILL_DIR}/runtime/supervisor.js" release "$PROJECT_DIR" \
  --route "$REAL_PROTOTYPE_ENTRY_ROUTE"
node "${CLAUDE_SKILL_DIR}/runtime/supervisor.js" status "$PROJECT_DIR"
```

Do not start Metro here. If status reports that Metro stopped, complete with
`DONE_WITH_CONCERNS` and the text-only reason. Return its persisted URL/QR when
available.

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
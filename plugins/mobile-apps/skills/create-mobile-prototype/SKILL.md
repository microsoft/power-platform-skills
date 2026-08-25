---
name: create-mobile-prototype
description: Use when the user wants a polished Expo/React Native Power Apps mobile prototype backed by a neutral typed domain and deterministic local repositories, with no environment selection and a stable adapter path to Dataverse later.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, Skill
model: opus
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** - read first.

# Create Mobile Prototype

Build a high-fidelity Power Apps mobile prototype in a fresh installed Expo
template without selecting a Power Platform environment. Prototype planning
owns neutral product semantics, not provisional Dataverse metadata. Screens
depend only on `@/data` hooks; local and Dataverse repositories implement the
same contracts so `/prototype-to-real-app` can swap adapters without rewriting
screens, navigation, domain types, or feature hooks.

## Resolve The Plugin Once

At skill load, record the host-supplied absolute skill directory as `SKILL_DIR`
and derive `PLUGIN_ROOT` as its `../..` ancestor. Substitute that resolved path
for `${CLAUDE_SKILL_DIR}` in every command. Never search the home directory,
installed packages, GitHub, or the internet to rediscover this plugin. If the
base directory is unavailable, stop with:

```text
BLOCKED: local skill base directory unavailable
```

## Route The Request

| Goal | Skill |
|---|---|
| Local UX prototype, no environment | `/create-mobile-prototype` |
| New app bound directly to a real environment | `/create-mobile-app` |
| Convert this prototype to Dataverse/connectors/auth | `/prototype-to-real-app` |

Do not accept an environment argument here. Do not ask environment, publisher,
solution, ownership, reuse-vs-create, connector binding, or auth questions.

## Inputs

- `--working-dir <path>`: fresh installed template; defaults to current directory.
- `--from-plan <path>`: optional reviewed plan. Preserve approved product
  semantics and fill only missing machine contracts.
- `--design-intake <path>`: optional structured visual requirements.
- `--from-design-intake <path>`: compatibility alias.
- `--from-screenshot <path[,path...]>`: optional local references.
- `--reference-fidelity <directional|high|strict-structural>`.
- `--review=consolidated|full`: defaults to one consolidated local review;
  `full` uses four local domain/context, native, connector, and
  screen/composition reviews.
- `--no-design`: skip interactive design choices, not app-specific tokens.

If no brief was supplied, return:

```text
NEEDS_CONTEXT: provide a one-line mobile app brief
```

## Invariants

- Never run `npx power-apps`, `pac`, `az`, Dataverse HTTP, connection creation,
  app registration, offline-profile mutation, or deployment.
- `.tmp/prototype-domain-model.json` is the canonical product/data contract.
  It contains neutral entities, fields, relationships, choices, operations,
  actors, UX permissions, offline intent, fixtures, and scenarios.
- `.tmp/dataverse-schema-contract.json` must be absent in prototype mode. Do
  not invent logical names, publisher prefixes, ownership, alternate keys,
  service names, or target-environment reuse decisions.
- Generate runtime data only under `src/data/`. Screens import only `@/data`
  hooks; they never import fixtures, repositories, generated services, or raw
  connector clients.
- Keep `PowerAppsProvider` as host/query owner. Mount
  `PrototypeDataProvider` inside it and never add another
  `QueryClientProvider`.
- Planned external connectors remain explicit intentions. Their UI may render,
  but runtime access is blocked until graduation supplies a repository adapter.
- Prototype means local data, not placeholder quality. Apply the same design,
  navigation, state, accessibility, and static quality bar as a real app.

## Progress

Print one line before each long phase:

```text
-> [prototype 1/9] Checking the installed mobile template...
-> [prototype 2/9] Capturing product, experience, and reversible context...
-> [prototype 3/9] Planning the neutral domain and screen operations...
-> [prototype 4/9] Reviewing the complete prototype plan...
-> [prototype 5/9] Generating the domain data layer and runtime shell...
-> [prototype 6/9] Applying design, navigation, and shared foundations...
-> [prototype 7/9] Compiling one immutable screen pack and skeletons...
-> [prototype 8/9] Building Home and the complete native key-flow canary...
-> [prototype 9/9] Probing Metro and recording truthful performance evidence...
```

## Workflow

### 1. Verify The Installed Template

Resolve `PROJECT_DIR`. Require `package.json`, `app.config.js`,
`auth.config.json`, `tamagui.config.ts`, and `node_modules/expo`. Require Node
22+ and npm 10+. Do not probe Power Platform or native build toolchains.

After resolving the project, initialize performance evidence and keep a local
integer `FOREGROUND_TOOL_CALLS` for commands/tools executed by this workflow:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase workflow --event start
```

Continue only for a fresh template or an explicitly confirmed resume of this
same prototype. If dependencies are absent, stop and ask the user to run
`npm install`; never request npm credentials. If another app already owns the
directory, stop rather than overwriting it.

Legacy prototype resume is the only exception. When
`src/generated/.prototype-manifest.json` exists, preserve it until Step 5 runs
the compatibility migrator.

### 2. Capture Brief And Experience Contract

Write `<PROJECT_DIR>/brief.md` with `Mode: prototype` and source paths for any
plan/design inputs. Derive the experience contract:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/experience-patterns.js" \
  --brief-file "$PROJECT_DIR/brief.md" \
  --output "$PROJECT_DIR/.tmp/experience-contract.json"
```

Use `--media-policy remote-cdn-cached` only when the brief explicitly requires
cache-backed CDN media. Read the resulting audience, primary job, interaction
and entry modes, first viewport, motifs, asset policy, forbidden defaults, and
confidence. For low confidence, ask one question about the first user outcome,
revise the brief, and regenerate. Otherwise record assumptions and continue.

Resolve and validate reversible prototype context before planning:

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

Context entries must retain brief evidence, source
`inferred-prototype-fixture`, assumptions, prototype-session persistence, and
forbidden inferences. They may enrich fixtures/hierarchy but never create a
workflow, integration, permission, connector, native capability, or permanent
entity.

Prepare the execution preflight before planning:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/prepare-mobile-plan-execution-contract.js" \
  --project-root "$PROJECT_DIR" \
  --brief "brief.md"
```

### 3. Plan Neutral Product Semantics

Compile the complete planner request once. The resulting JSON is the only
normal-path planner input; pass its contents inline and do not ask the planner
to read any file or invoke another agent:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase planning --event start
node "${CLAUDE_SKILL_DIR}/../../scripts/prepare-prototype-planner-request.js" \
  --project-root "$PROJECT_DIR"
```

Invoke `mobile-app:native-app-planner` once in return-only mode with:

- `workflow: create-mobile-prototype`;
- `planningMode: prototype`;
- the confirmed brief, experience contract, and validated Context Enrichment Contract;
- the validated foreground Workflow Journey Contract as the binding baseline
  for journey kind, ordered stages, resume behavior, guards, signatures,
  continuity keys, capability composition, and scenario state;
- template capability/preflight facts;
- any approved plan/design/reference inputs;
- explicit prohibition on environment discovery and mutation.

The planner returns one raw `prototype-semantic-plan` JSON object under the
256 KiB ceiling, with no status text or Markdown fence. It owns complete neutral
domain semantics, realistic fixtures/scenarios, preliminary screen semantics,
requirement/capability/connector bindings, assumptions, and warnings.

Every screen item must preserve hierarchy, regions, first-viewport budget,
purpose/outcome, action ID/label/placement/binding/double-tap policy, all runtime
states and recovery, signature/test IDs, media role/aspect/coverage/fallback/alt
text, operations, relationships, and failure behavior. It supplies semantic
route segments and parent IDs, never final route or file paths.

`designIntent` must include `visualCharacter`, `informationHierarchy`,
`density`, explicit platform-safe typography families, an original semantic
palette, `shapeAndElevation`, `mediaStrategy`, implementation-complete
`signatureComponents`, all native state treatments, `motionIntent`,
complete focus/keyboard/safe-area `accessibilityIntent`, and hard `avoid`
rules. Remote media also requires explicit source/licensing authorization and
a connectivity rationale. Every Foundation Contract motif
must have exactly one signature binding. `navigationIntent` must include the primary and durable
destinations, revisit patterns, linear-versus-independent job evidence,
tabs-stack recommendation, nested-screen tab visibility, and stack-only
evidence when applicable.

The response must not contain copied Context or Journey contracts, Markdown,
hashes, final artifact wrappers, final Navigation, Dataverse/environment
identity, output paths, commands, approval state, or mutation instructions.
Use explicit foreground source references for primary Context and Experience
signature values rather than repeating them. Do not return `Product 1`, table
prefixes, generated service names, or generic CRUD inferred only from nouns.

Write the exact first response bytes to `.tmp/planner-response-1.json`, then
stage them through the transport gate:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/stage-prototype-planner-response.js" \
  --project-root "$PROJECT_DIR" \
  --response ".tmp/planner-response-1.json" \
  --attempt 1
```

The gate rejects invalid UTF-8, truncation, wrappers, unknown keys, copied final
artifacts, Dataverse leakage, oversized transport, or invalid semantic
references. It writes `.tmp/prototype-semantic-plan.json` and records only
request/response hashes, byte sizes, attempt count, and error category. On that
single failure, invoke the same planner once
more with the original inline request, the invalid response, and only those
errors. Stage the result as attempt 2. A second failure is terminal. Never
manually construct, complete, or reconstruct the semantic plan or final bundle,
and never invoke a second normal-path planner.

Build the single repair input deterministically before that one repair call:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/prepare-prototype-planner-repair.js" \
  --project-root "$PROJECT_DIR" \
  --invalid-response ".tmp/planner-response-1.json"
```

Pass the complete `.tmp/prototype-planner-repair-request.json` contents inline
to the same `mobile-app:native-app-planner`. Write its exact raw response bytes
to `.tmp/planner-response-2.json`, then run the staging gate with `--attempt 2`.
Do not add other context or reinterpret the reported errors.

After semantic response validation, use exactly this order:

```text
compile draft bundle
-> resolve Navigation from navigationIntent + preliminary Screen Graph
-> render native-app-plan.md and compatibility sections
-> validate path-level semantic preservation against the final bundle
-> validate the complete v3 bundle
-> atomically write all existing final artifacts
```

The finalizer enforces that order in one command:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/finalize-prototype-plan.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase planning --event end
```

The planner never emits the final Navigation Contract. The deterministic
resolver compiles it from `navigationIntent` plus the preliminary Screen Graph.
`render-native-prototype-plan.js` runs only after Navigation is final.
`validate-prototype-semantic-preservation.js` writes path-specific findings to
`.tmp/prototype-semantic-preservation.json` and blocks any generic fallback or
dropped hierarchy, action, state, signature, media, operation, relationship,
fixture, rationale, visual character, or navigation decision. The existing
atomic bundle writer remains the only owner of final artifact persistence.

Do not parse `native-app-plan.md` to recover machine facts. The Markdown is the
human review surface; sidecars are execution authority.

### 4. Local Prototype Review

Draft one local review checkpoint:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/plan-checkpoints.js" \
  --project-root "$PROJECT_DIR" \
  --action draft \
  --workflow create-mobile-prototype \
  --review-mode "$REVIEW_MODE"
```

Present one concise review containing:

- entities, relationships, choices, operations, actors, UX permissions, and
  offline behavior;
- inferred prototype context, its evidence/assumptions, and forbidden
  inferences;
- fixture/scenario summary;
- native capabilities and connector intentions;
- screen map, navigation, design direction, critical flow, and assumptions;
- explicit statement that no environment or external mutation is authorized.

By default set `REVIEW_MODE=consolidated`, ask once for `approve`, revisions,
or cancellation, and record approval only with:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/plan-checkpoints.js" \
  --project-root "$PROJECT_DIR" \
  --action approve \
  --workflow create-mobile-prototype \
  --review-mode consolidated \
  --section prototype-review \
  --response approve
```

For `--review=full`, set `REVIEW_MODE=full` and present/record four local
sections in order: `domain-context`, `native-capabilities`, `connectors`, and
`screen-composition`. Pass `--review-mode full` and the matching `--section`
to each approval command. All four must pass for local approval.

Any plan/sidecar change invalidates the review. Regenerate the affected bundle,
validate/write it, and repeat the selected review mode. An approved prototype receipt
must keep `mayAuthorizeExternalMutations: false`.

### 5. Prepare Runtime And Parallel Domain/Design Generation

Apply `/create-mobile-app` template-preparation rules without binding an
environment: update identity, remove stale examples, preserve aliases and root
provider order, keep `@ts-ignore` generated-config boundaries, and do not run
`power-apps init`.

For a legacy generated-service prototype, run the one-time transactional
migrator first. It archives owned artifacts, preserves edited seed records
under `src/data/legacy-fixtures/`, generates/validates the new layout, restores
the old app on failure, and removes the archive only after success:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/migrate-legacy-prototype.js" "$PROJECT_DIR"
```

After template preparation, start neutral data layer generation and the
automatic design compiler in parallel because both consume only approved
immutable contracts and own disjoint files. Do not invoke `/design-system` on
the normal prompt-only path; that would load optional-mode instructions and
references that the compiler does not need. The design branch
must use the post-PR1 compiler path: no brand question, style/cost picker,
gallery, Figma, screenshot, or optional reference library. It writes and
validates the recipe, semantic tokens, Foundation primitives, and signature
registry transactionally:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase design --event start
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-design-instruction-manifest.js" \
  --project-root "$PROJECT_DIR" --mode automatic-native
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-native-prototype-design.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-native-prototype-design.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase design --event end
```

Explicit maker requests for brand-kit ingestion, Figma, screenshot matching,
reskinning, galleries, or HTML preview continue through the corresponding
optional `/design-system` mode. Native/package/connector/layout/lifecycle
mutations remain sequential. For a fresh app, the domain branch runs:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase domain --event start
node "${CLAUDE_SKILL_DIR}/scripts/gen-data-layer.js" "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase domain --event end
```

This writes models, repository interfaces, mock repositories, TanStack Query
hooks, validated ephemeral context, fixtures/scenarios, media resolution, and
`PrototypeDataProvider` under `src/data/`. The generated Dataverse adapter is a
fail-closed placeholder; graduation replaces only that file.

Choose `PROTOTYPE_ENTRY_ROUTE` from the approved initial/root screen, then run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/configure-prototype-runtime.js" \
  "$PROJECT_DIR" prototype "$PROTOTYPE_ENTRY_ROUTE"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope domain
npm --prefix "$PROJECT_DIR" run type-check
```

Write `.mobile-app/state.json` using lifecycle schema version 2 with
`dataMode: prototype`, null environment/transition/Dataverse hash, and current
domain/repository/fixture revisions. Never store secrets or local absolute
paths.

### 6. Join Parallel Work, Then Apply Sequential Mutations

Apply every approved template-supported native capability sequentially through
`/add-native`; never install unsupported native code or fake wrappers.

Join the automatic design branch here. `--no-design` suppresses optional visual
review only; the compact recipe, app-specific semantic tokens, registry, and
Foundation primitives remain required. Integrate them through the existing
`PowerAppsProvider`; never add outer Tamagui or Query Client providers. Honor
reference fidelity and materialize required media. Invoke `/design-system`
only when the maker explicitly selected one of its optional modes.

Install only exact `executionContract.javascriptDependencies` through the
repository's installation contract, one at a time, then type-check.

Generate navigation only through the resolved Navigation Contract. Preserve
the prototype auth bypass in `app/(app)/_layout.tsx`; do not change
data-provider ownership or let screen builders edit shared layouts:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/apply-navigation-shell.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-destinations.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-shell.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-continuity.js" \
  --project-root "$PROJECT_DIR"
```

Do not recreate Foundation or signature components here. The automatic design
compiler owns exactly the components and exports recorded by
`.mobile-app/prototype-design-manifest.json`.

After navigation/foundation writes, pass every changed file to
`validate-mobile-files.js --file <path>` and run type-check before pack
compilation. Do the same after writing typed skeletons. A changed-file or
TypeScript failure blocks builder dispatch.

### 7. Compile The Single Pack And Typed Skeletons

Compile the single pack only after Context, Journey, Domain, Execution, Screen
v3, Foundation, generated domain layer/fixture manifest, design recipe, and
tokens all exist and validate:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-native-prototype-design.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "$PROJECT_DIR" \
  --output ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-build-pack.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-native-prototype-design.js" \
  --project-root "$PROJECT_DIR" --require-build-pack
```

The compiler writes only `.tmp/screen-build-pack.json`. Generate typed skeletons
only for `nativeCanary.screenIds`; supporting-screen fan-out is the next
iteration. Each canary skeleton imports only `ScreenShell`, approved
foundation components, route APIs, and work-order-listed hooks/helpers from
`@/data`. It must contain the literal header mode, route bindings, operation-ID
anchors, and `// TODO: screen-builder fills JSX here`.

Never put fixture arrays, repository calls, generated service imports,
`toExperienceRecord`, or a second provider in a skeleton.

### 8. Build The Native Canary

Prepare one aggregate in-memory dispatch from the pack. It contains the
permanent primary destination plus the complete smallest critical flow and
uses the same compact work-order/artifact protocol as later builders:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase canary --event start
node "${CLAUDE_SKILL_DIR}/../../scripts/prepare-native-canary.js" \
  --project-root "$PROJECT_DIR" > "$CANARY_DISPATCH_PATH"
```

Run at most five screen builders concurrently for only the dispatch targets.
Give each builder exactly one compact `screen_work_order`, the immutable
`screen_build_pack_revision`, target, and input-file hash. The dispatch file is
ephemeral and must be removed after artifact persistence. Do not give a builder
the aggregate pack, plan, optional design references, or supporting screens.

Each builder is return-only. The foreground parses its single
`mobile-screen-artifact`, then validates and writes only the authorized target:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/write-screen-artifact.js" \
  --project-root "$PROJECT_DIR" \
  --pack ".tmp/screen-build-pack.json" \
  --artifact "$ARTIFACT_PATH" \
  --screen-id "$SCREEN_ID"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-files.js" \
  --project-root "$PROJECT_DIR" \
  --file "$TARGET_FILE"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" \
  --scope screen \
  --screen "$SCREEN_ID"
```

After each wave, run the changed-file dispatcher with every file written in
the canary, then type-check. Repair only the owning screen or shared foundation.
Maximum three repair cycles per failing scope; then stop with the exact blocker
rather than weakening a contract. Do not dispatch `remaining-screens`.

Validate the completed primary and key-flow sources as one native canary before
Metro. This command rechecks source hashes, composition, routes, continuity,
domain hooks, capability fallbacks, media, accessibility, design runtime, and
TypeScript, then writes `.tmp/native-canary-validation.json`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-native-canary.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase canary --event end
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope domain
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope tasks
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope screen --screen "$PRIMARY_SCREEN_ID"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope screen --screen "$KEY_FLOW_SCREEN_ID"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-action-state.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-cross-screen-continuity.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-signature-components.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-capability-composition.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-semantic-color-usage.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-static-layout-budgets.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-continuity.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-shell.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-composition.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-shells.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-media.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-design-runtime.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report app
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report app
npm --prefix "$PROJECT_DIR" run type-check
```

Any failure blocks early Metro. Repair only the owning layer and rerun the same
gate before continuing.

After that vertical slice passes, start Metro early on an explicit available
port without an interactive prompt:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase metro --event start
node "${CLAUDE_SKILL_DIR}/../../scripts/start-prototype-metro.js" \
  --project-root "$PROJECT_DIR" \
  --preferred-port 8081
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase metro --event end
```

Report the selected port and exact command only after Metro's HTTP health probe
passes. Status is `statically validated + Metro ready`, not visual completion.
Do not continue supporting-screen waves in this iteration.

Run final canary gates through the dispatcher and specialized visual validators:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope all --record --reuse-if-unchanged
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-composition.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-shells.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-media.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-design-runtime.js" \
  --project-root "$PROJECT_DIR"
```

The dispatcher reports `unchanged-since-recorded-pass` only when the same
successful scope and relevant content fingerprint were recorded previously.
Report that skip. Any relevant source, asset, config, contract, fixture, or
pack change forces validation.

### 9. Finish Static Validation

Confirm lifecycle state contains current `lastDomainModelHash`,
`lastContextEnrichmentHash`, `lastWorkflowJourneyHash`,
`lastNavigationContractHash`, `lastNavigationShellHash`, `lastVisualCompositionHash`,
`lastRepositoryMappingHash`, `lastFixtureRevision`, and passing
`lastValidation` with `qualityStatus: statically-validated` and
`nativeVisualEvidence: null`. Report the earlier Metro command/port.

Record the final foreground command/tool count, close the workflow timing, and
compile performance evidence. If Metro startup failed, still close the Metro
phase and finalize; the evidence truthfully records the manual-command status.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action count \
  --counter foregroundToolCalls --amount "$FOREGROUND_TOOL_CALLS"
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action mark --phase workflow --event end
node "${CLAUDE_SKILL_DIR}/../../scripts/record-prototype-performance.js" \
  --project-root "$PROJECT_DIR" --action finalize
```

Completion output must include:

- project directory and prototype entry route;
- domain entities/operations and fixture/scenario counts;
- built canary screens, deferred supporting screens, and critical flow;
- native capabilities and blocked connector intentions;
- static validation and type-check results;
- status: `Statically validated + Metro ready vertical slice`, or
  `Statically validated canary; manual Metro command required` when the health
  probe did not pass;
- explicit note that native screenshots were not captured and the prototype is
  not yet a `Visually complete prototype`;
- performance evidence path plus planner bytes, loaded design bytes, model/tool
  calls, repair count, phase durations, time to validated Home, and time to
  Metro-ready key flow;
- `dataMode: prototype` and confirmation that no environment was selected;
- the exact next step: `/prototype-to-real-app --working-dir <PROJECT_DIR>`.

Do not claim Dataverse readiness. Graduation must reconcile the same neutral
domain against a chosen environment and generate repository adapters before it
can switch lifecycle state to `dataverse`.
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
  navigation, state, accessibility, and native review bar as a real app.

## Progress

Print one line before each long phase:

```text
-> [prototype 1/9] Checking the installed mobile template...
-> [prototype 2/9] Capturing product and experience intent...
-> [prototype 3/9] Planning the neutral domain and screen operations...
-> [prototype 4/9] Reviewing the complete prototype plan...
-> [prototype 5/9] Generating the domain data layer and runtime shell...
-> [prototype 6/9] Applying design, navigation, and shared foundations...
-> [prototype 7/9] Compiling immutable screen tasks and skeletons...
-> [prototype 8/9] Building and validating screens in bounded waves...
-> [prototype 9/9] Recording lifecycle state and starting Metro...
```

## Workflow

### 1. Verify The Installed Template

Resolve `PROJECT_DIR`. Require `package.json`, `app.config.js`,
`auth.config.json`, `tamagui.config.ts`, and `node_modules/expo`. Require Node
22+ and npm 10+. Do not probe Power Platform or native build toolchains.

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

Prepare the execution preflight before planning:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/prepare-mobile-plan-execution-contract.js" \
  --project-root "$PROJECT_DIR" \
  --brief "brief.md"
```

### 3. Plan Neutral Product Semantics

Invoke `mobile-app:native-app-planner` once in return-only mode with:

- `workflow: create-mobile-prototype`;
- `planningMode: prototype`;
- the confirmed brief and experience contract;
- template capability/preflight facts;
- any approved plan/design/reference inputs;
- explicit prohibition on environment discovery and mutation.

The planner returns one version-3 `mobile-plan-artifact-bundle`. Its artifacts
must contain:

- `nativeAppPlanMarkdown`;
- `prototypeDomainModel` with `mode: prototype-domain`;
- `dataverseSchemaContract: null`;
- schema-v3 `experienceScreenContract` whose operations name
  `domainOperation`, repository, method, and hook;
- `experienceFoundationContract`;
- `executionContract`.

The domain model must include stable opaque IDs, real field types, explicit
relationships, choice keys/labels, operation contracts, actors/UX permissions,
offline intent, realistic fixtures, and loading/empty/error/offline scenarios.
Do not return `Product 1`, table prefixes, generated service names, or generic
CRUD inferred only from nouns.

The foreground owns all writes:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-plan-artifact-bundle.js" \
  --project-root "$PROJECT_DIR" \
  --bundle "$PROJECT_DIR/.tmp/plan-artifact-bundle.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/write-plan-artifact-bundle.js" \
  --project-root "$PROJECT_DIR" \
  --bundle "$PROJECT_DIR/.tmp/plan-artifact-bundle.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-prototype-domain-model.js" \
  --project-root "$PROJECT_DIR"
```

Do not parse `native-app-plan.md` to recover machine facts. The Markdown is the
human review surface; sidecars are execution authority.

### 4. One Consolidated Review

Draft one local review checkpoint:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/plan-checkpoints.js" \
  --project-root "$PROJECT_DIR" \
  --action draft \
  --workflow create-mobile-prototype
```

Present one concise review containing:

- entities, relationships, choices, operations, actors, UX permissions, and
  offline behavior;
- fixture/scenario summary;
- native capabilities and connector intentions;
- screen map, navigation, design direction, critical flow, and assumptions;
- explicit statement that no environment or external mutation is authorized.

Ask for `approve`, revisions, or cancellation. Record approval only with:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/plan-checkpoints.js" \
  --project-root "$PROJECT_DIR" \
  --action approve \
  --workflow create-mobile-prototype \
  --section prototype-review \
  --response approve
```

Any plan/sidecar change invalidates the review. Regenerate the affected bundle,
validate/write it, and repeat this single review. An approved prototype receipt
must keep `mayAuthorizeExternalMutations: false`.

### 5. Generate Domain Data And Configure Runtime

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

For a fresh app, generate the neutral data layer:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/gen-data-layer.js" "$PROJECT_DIR"
```

This writes models, repository interfaces, mock repositories, TanStack Query
hooks, fixtures/scenarios, media resolution, and
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

### 6. Design, Navigation, And Shared Foundations

Apply every approved template-supported native capability sequentially through
`/add-native`; never install unsupported native code or fake wrappers.

Run `/design-system` unless `--no-design`. Even with `--no-design`, create
app-specific semantic tokens and integrate them through the existing
`PowerAppsProvider`; never add outer Tamagui or Query Client providers. Honor
reference fidelity and materialize required media.

Install only exact `executionContract.javascriptDependencies` through the
repository's installation contract, one at a time, then type-check.

Generate navigation from the screen contract. Preserve the prototype auth
bypass in `app/(app)/_layout.tsx`; do not change data-provider ownership.
Create only the 2-5 foundation primitives named by the foundation contract and
export them from `@/components`.

### 7. Compile Tasks And Typed Skeletons

Compile and validate the aggregate pack plus one immutable task per screen:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "$PROJECT_DIR" \
  --output ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-build-pack.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-task-pack.js" \
  --project-root "$PROJECT_DIR"
```

The compiler writes `.tmp/screen-tasks/<screen-id>.json`. Generate one typed
skeleton per task. Each skeleton imports only `ScreenShell`, approved
foundation components, route APIs, and task-listed hooks/helpers from
`@/data`. It must contain the literal header mode, route bindings, operation-ID
anchors, and `// TODO: screen-builder fills JSX here`.

Never put fixture arrays, repository calls, generated service imports,
`toExperienceRecord`, or a second provider in a skeleton.

### 8. Build In Bounded Waves

Use the pack's `builderWaves`. Run at most five screen builders concurrently.
Give each builder exactly one task path, task revision, parent pack revision,
target, and input-file hash. Do not give it the aggregate pack or plan.
Use the explicit invocation fields `screen_task_path`, `screen_task_revision`,
and `screen_build_pack_revision`.

Each builder is return-only. The foreground parses its single
`mobile-screen-artifact`, then validates and writes only the authorized target:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/write-screen-artifact.js" \
  --project-root "$PROJECT_DIR" \
  --pack ".tmp/screen-build-pack.json" \
  --artifact "$ARTIFACT_PATH" \
  --screen-id "$SCREEN_ID"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" \
  --scope screen \
  --screen "$SCREEN_ID"
```

After each wave, run type-check. Repair only the owning screen or shared
foundation. Maximum three repair cycles per failing scope; then stop with the
exact blocker rather than weakening a contract.

For the primary and key-flow screens, run native visual review at phone and
large-text widths. Check first viewport, loading/empty/error/offline states,
keyboard/touch behavior, media fallback, and route flow. Save evidence under
`.tmp/visual-evidence/`.

Run final gates through the dispatcher and specialized visual validators:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope all --record
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-composition.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-shells.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-media.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-design-runtime.js" \
  --project-root "$PROJECT_DIR"
```

### 9. Finish And Start Metro

Confirm lifecycle state contains current `lastDomainModelHash`,
`lastRepositoryMappingHash`, `lastFixtureRevision`, and passing
`lastValidation`. Start the development server with the template's `npm run
dev` command and report its URL/QR target.

Completion output must include:

- project directory and prototype entry route;
- domain entities/operations and fixture/scenario counts;
- screens and critical flow;
- native capabilities and blocked connector intentions;
- validation/type-check/native-review results;
- `dataMode: prototype` and confirmation that no environment was selected;
- the exact next step: `/prototype-to-real-app --working-dir <PROJECT_DIR>`.

Do not claim Dataverse readiness. Graduation must reconcile the same neutral
domain against a chosen environment and generate repository adapters before it
can switch lifecycle state to `dataverse`.
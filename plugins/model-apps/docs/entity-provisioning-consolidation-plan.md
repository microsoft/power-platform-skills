# Entity-Provisioning Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Author:** akmaloo

**Goal:** Make `/genpage` and `/model-app-maker` create Dataverse tables/columns/relationships/records through **one shared entity-provisioning library** (SDK-backed), eliminating the duplicate hand-rolled Web-API scripts — with **zero regression** to the PROD `/genpage` skill and updated evals.

**Architecture:** Extract the solution + data-model + sample-data logic that currently lives inside `scripts/lib/sdk-build.js` into a new `scripts/lib/entity-provision.js`. `sdk-build.js` (model-app-maker) delegates to it; a new thin CLI `scripts/provision-entities.js` (genpage) also imports it. The `genpage-entity-builder` agent stops shelling out to `create-table.js` / `add-column.js` / `create-relationship.js` / `create-record.js` and instead emits one App-Spec-subset JSON, calls `provision-entities.js` once, and writes the same `entity-creation-log.md` from its structured result. The library is SDK-based, idempotent (discover-then-create), and a strict superset of the old scripts (adds MultiChoice, BigInt, Double, File, Image, AutoNumber, Customer, global choices, status reasons, alternate keys).

**Tech Stack:** Node.js (CommonJS), `node:test` unit tests, the vendored `@maker-studio/cds-maker-sdk` bundle (`scripts/vendor/cds-maker-sdk.cjs`), the `az`-token HttpClient (`scripts/lib/sdk-http-client.js`), the genpage TAP eval suite (`evals/model-apps/genpage/`).

## Global Constraints

- **PROD safety:** `/genpage` is used in production. No task may leave the eval suite red. Every phase ends with the full regression gate green before moving on.
- **Model-app-maker parity:** `scripts/lib/sdk-build.js` currently passes **241** unit tests. After the extraction, `runSdkBuild` behavior — including the exact `{ phase, status, label, n, total }` emit sequence and `BuildHalt` semantics — MUST be unchanged. The 241 tests are the parity guard; they must stay green with no test edits (other than moved-code test relocation in Task 2).
- **Observable-contract stability:** The genpage plan-doc contract (`references/plan-schema.md` headings, especially `## Environment` and `## Entity Creation Required`) and the `entity-creation-log.md` token format the evals parse (`Resolved Full Name:` / `Logical Name:` / `Schema Name:` followed by a `${prefix}_${suffix}` name) MUST be preserved.
- **Prefix discipline:** `## Entity Creation Required` stores **suffixes only** (`^[a-z][a-z0-9]+$`); the prefix lives once in `## Environment` → `Publisher Prefix:`. The new JSON the agent emits carries **full** schema names it constructs (`${prefix}_${Suffix}`), exactly as the agent constructs them today.
- **Choice value convention:** inline/global choice option values are `100000000 + index` (unchanged; the SDK already assigns these).
- **Auth:** `az account get-access-token` only. No `pac` for metadata create, no Python, no MCP.
- **Doc convention:** doc content uses bare author `akmaloo`, no date in filename/frontmatter, no AI attribution.
- **Commits:** frequent, one per task minimum. Commit body trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do not open a PR unless asked.
- **Live Dataverse writes to 983a1 are gated** on explicit user go-ahead. This plan is verifiable offline through Task 9; the live shakeout (Task 10) is gated.

---

## File Structure

**Created:**
- `scripts/lib/entity-provision.js` — shared provisioning core. Exports `provisionSolution`, `provisionDataModel`, `provisionSampleData`, and `makeRunner`. SDK-based, idempotent. Owns the extracted solution + data-model + sample-data logic.
- `scripts/provision-entities.js` — genpage-facing CLI. Constructs the two SDK clients + an `az`-token HttpClient (same as `build-model-app.js`), validates the input, runs the shared core, prints a structured JSON result (`{ ok, solution, entities:[{schemaName,logicalName,metadataId,entitySetName}], columns:[...], relationships:[...], records:{...} }`). Dry-run default; `--apply` writes; `--sample-data` opt-in.
- `scripts/lib/provision-input.js` — pure validator/normalizer for the provision-entities JSON input (an App-Spec subset: `{ solution, entities, relationships, globalChoices, sampleData }`). Exports `validateProvisionInput(input) -> { ok, errors }`.
- `scripts/tests/entity-provision.test.js` — unit tests for the shared core (mock SDK).
- `scripts/tests/provision-entities.test.js` — wiring test for the CLI (validation gate, dry-run, apply threads to the core, structured result shape).
- `scripts/tests/provision-input.test.js` — validator unit tests.

**Modified:**
- `scripts/lib/sdk-build.js` — its `solution`, `data-model`, and `sample-data` phase bodies are replaced by calls into `entity-provision.js`. Public exports and `runSdkBuild` emit contract unchanged.
- `agents/genpage-entity-builder.md` — Step 4/5/7 rewritten to emit one JSON + call `provision-entities.js` + write `entity-creation-log.md` from its result. Steps 1–3, 6, 8 unchanged.
- `references/plan-schema.md` — a note in `## Entity Creation Required` that the builder now provisions via `provision-entities.js` (headings/contract unchanged).
- `AGENTS.md` — the entity-builder bullet + scripts list updated.
- `evals/model-apps/genpage/lib/assertions-layer-1.js` — the check-auth-ordering assertion regex extended to recognize `provision-entities.js`.
- `evals/model-apps/genpage/tests/assertions-layer-1.test.js` — matching test updates.
- Eval fixtures with entity creation: `fixtures/7-job-candidates-new-entities/`, `fixtures/15-support-tickets-real/`, `fixtures/11-recruitment-pages-real/` — `workflow-log.md` + `entity-creation-log.md` refreshed to the new command.

**Removed (final, gated task):**
- `scripts/create-table.js`, `scripts/add-column.js`, `scripts/create-relationship.js`, `scripts/create-record.js`, `scripts/create-solution.js`, `scripts/add-to-solution.js` and their `scripts/tests/*.test.js` — only after evals are green and the user approves (Task 11).

---

## Target Interfaces

`scripts/lib/entity-provision.js`:

```js
// A Runner owns the emit/counter/BuildHalt machinery so both consumers produce the
// identical { phase, status, label, n, total } event stream. `total` is supplied by the
// consumer (each computes its own plan length), so counting stays consumer-scoped.
function makeRunner({ emit, total }) // -> { run, mapLimit, count() }

// Discover-then-create the solution + publisher (idempotent). No-op emit-wise if present.
async function provisionSolution({ sdk, provision, runner, solution })

// Discover-then-create global choices, tables, columns, status reasons, alternate keys,
// and relationships (idempotent). Returns captured maps used by sample data + later phases.
async function provisionDataModel({ sdk, provision, runner, spec, apply, concurrency })
//   -> { entities: { [schemaName]: { logicalName, entitySetName } },
//        globalChoiceIds: { [name]: metadataId },
//        statusReasonValues: { [logical]: { [label]: { value, stateCode } } } }

// Create sample rows topologically, binding $parent/$parents via @odata.bind. Needs the
// captured maps from provisionDataModel.
async function provisionSampleData({ sdk, provision, runner, spec, dataModel })
//   -> { records: { [schemaName]: string[] } }
```

`scripts/lib/provision-input.js`:

```js
function validateProvisionInput(input) // -> { ok: boolean, errors: string[] }
```

`scripts/provision-entities.js` (CLI) prints on success:

```json
{ "ok": true,
  "solution": "Default",
  "entities": [{ "schemaName": "cr_Candidate", "logicalName": "cr_candidate", "metadataId": "…", "entitySetName": "cr_candidates" }],
  "columns":  [{ "table": "cr_candidate", "schemaName": "cr_Status", "logicalName": "cr_status", "metadataId": "…" }],
  "relationships": [{ "kind": "1n", "schemaName": "cr_JobRequisition_cr_Candidate", "metadataId": "…" }],
  "records": { "cr_candidate": ["id1", "id2"] } }
```

---

## Phase A — Shared library, model-app-maker parity preserved

### Task 1: Extract solution + data-model + sample-data into `entity-provision.js`

**Files:**
- Create: `scripts/lib/entity-provision.js`
- Modify: `scripts/lib/sdk-build.js` (replace the `solution`, `data-model`, `sample-data` phase bodies — the three blocks guarded by `has('solution')`, `has('data-model')`, `has('sample-data') && sampleData` — with delegations; keep everything else)
- Test: `scripts/tests/sdk-build.test.js` (existing — must stay green unchanged)

**Interfaces:**
- Produces: `makeRunner`, `provisionSolution`, `provisionDataModel`, `provisionSampleData` (signatures above).
- Consumes: the SDK clients `sdk`/`provision`, and the `emit` callback already threaded through `runSdkBuild`.

**Extraction notes (exact source):** The logic to move is the current bodies of the three phase blocks in `sdk-build.js` (locate by the `has('solution')`, `has('data-model')`, and `has('sample-data') && sampleData` guards) plus their private helpers already defined in that file: `SDK_COLUMN_TYPE`, `REQUIRED`, `columnOptions`, `choiceOptions`, `STATE_CODE`, `isAlreadyExists`, and the `entitySetFor`/`entitySetCache` resolver. Move these helpers into `entity-provision.js` and re-export the ones `sdk-build.js` still needs (`SDK_COLUMN_TYPE` is in `sdk-build`'s public exports — re-export it from `sdk-build` via `require('./entity-provision.js')` to keep the export surface identical). The `run`/`mapLimit`/counter machinery becomes `makeRunner`; `sdk-build.js`'s `runSdkBuild` builds one runner with `total = plan.length` and passes it to both the extracted functions AND its own remaining phases (web-resources/views/charts/forms/commands/dashboards/app-shell/publish), so the `n` counter stays a single monotonic sequence across all phases.

- [ ] **Step 1: Write the parity characterization test (captures the CURRENT emit stream)**

Add to `scripts/tests/sdk-build.test.js`:

```js
test('data-model + sample-data emit a stable phase/label sequence (parity anchor)', async () => {
  const { sdk } = mockSdk();
  const events = [];
  await runSdkBuild(desk, { sdk, apply: true, sampleData: true, emit: (e) => events.push(e) });
  const terminal = events.filter((e) => e.status !== 'start');
  // one monotonic counter across all phases
  const ns = terminal.map((e) => e.n);
  assert.deepStrictEqual(ns, [...ns].sort((a, b) => a - b));
  assert.strictEqual(new Set(ns).size, ns.length);
  // data-model creates the three tables + their columns; sample-data creates 3 record steps
  assert.ok(terminal.some((e) => e.phase === 'data-model' && /table new_ticket/.test(e.label)));
  assert.ok(terminal.filter((e) => e.phase === 'sample-data').length >= 1);
});
```

- [ ] **Step 2: Run it against the current code to capture the baseline**

Run: `node --test plugins/model-apps/scripts/tests/sdk-build.test.js`
Expected: PASS (this documents current behavior before the refactor).

- [ ] **Step 3: Create `entity-provision.js` and move the three phase bodies + helpers into the four exported functions**

Create `scripts/lib/entity-provision.js` implementing `makeRunner`, `provisionSolution`, `provisionDataModel`, `provisionSampleData` by lifting the existing code verbatim (the create/discover calls, `skipIf: isAlreadyExists`, status-reason pinning, `$parent`/`$parents` binding, the `statusReason` guard-throw). Keep the `BuildHalt` class in `sdk-build.js` and pass it into `makeRunner` (or import it from `sdk-build.js` — choose one direction to avoid a require cycle; recommended: move `BuildHalt` into `entity-provision.js` and re-export it from `sdk-build.js`).

- [ ] **Step 4: Refactor `sdk-build.js` to delegate**

Replace the three phase blocks with:

```js
const runner = makeRunner({ emit, total: plan.length });
const sol = spec.solution;
if (has('solution')) await provisionSolution({ sdk, provision, runner, solution: sol });
let dataModel = { entities: {}, globalChoiceIds: {}, statusReasonValues: {} };
if (has('data-model')) dataModel = await provisionDataModel({ sdk, provision, runner, spec, apply, concurrency });
Object.assign(result.created.entities, dataModel.entities);
if (has('sample-data') && sampleData) {
  const sd = await provisionSampleData({ sdk, provision, runner, spec, dataModel });
  Object.assign(result.created.records, sd.records);
}
```

Ensure the remaining phases (web-resources … publish) use the same `runner.run` and share its counter so `n` stays monotonic. Keep `result.created.entities[...] .entitySetName` populated (later phases read it via the entitySet resolver — move that resolver into `entity-provision.js` and export it, or return an `entitySetFor` closure from `provisionDataModel`).

- [ ] **Step 5: Run the FULL sdk-build + model-app-maker suite (parity gate)**

Run: `node --test plugins/model-apps/scripts/tests/sdk-build.test.js plugins/model-apps/scripts/tests/build-model-app.test.js`
Expected: PASS — same counts as before plus the new parity test. If any emit-sequence test fails, the extraction changed behavior; fix until identical.

- [ ] **Step 6: Run the entire model-apps script suite**

Run: `node --test plugins/model-apps/scripts/tests/*.test.js`
Expected: PASS, `# fail 0` (≥ 242 tests: 241 prior + parity anchor).

- [ ] **Step 7: Commit**

```bash
git add plugins/model-apps/scripts/lib/entity-provision.js plugins/model-apps/scripts/lib/sdk-build.js plugins/model-apps/scripts/tests/sdk-build.test.js
git commit -m "refactor(model-apps): extract shared entity-provision core from sdk-build"
```

### Task 2: Focused unit tests for the shared core

**Files:**
- Create: `scripts/tests/entity-provision.test.js`

**Interfaces:**
- Consumes: `provisionSolution`, `provisionDataModel`, `provisionSampleData`, `makeRunner` from Task 1.

- [ ] **Step 1: Write tests exercising idempotency + capture**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeRunner, provisionDataModel } = require(path.join(__dirname, '..', 'lib', 'entity-provision.js'));

function mockSdk(existing = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      createTable: async (o) => { calls.push(['createTable', o.schemaName]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
      createColumn: async (l, o) => { calls.push(['createColumn', l, o.schemaName]); return { logicalName: o.schemaName.toLowerCase() }; },
      createCustomerColumn: async () => ({}),
      createRelationship: async (o) => { calls.push(['createRelationship', o.schemaName]); return { schemaName: o.schemaName }; },
      createGlobalOptionSet: async (o) => { calls.push(['createGlobalOptionSet', o.name]); return { metadataId: `gc-${o.name}` }; },
      insertStatusValue: async () => 100000000,
      createAlternateKey: async () => ({}),
    },
    provision: {
      findTables: async (s) => (existing[s.toLowerCase()] ? [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s` }] : []),
      findColumns: async () => [],
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    },
  };
}

test('provisionDataModel creates missing tables + columns and captures entitySetName', async () => {
  const m = mockSdk();
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Choice', options: ['Low', 'High'] }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  const dm = await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 });
  assert.strictEqual(dm.entities.new_ticket.entitySetName, 'new_tickets');
  assert.ok(m.calls.some((c) => c[0] === 'createTable' && c[1] === 'new_ticket'));
  assert.ok(m.calls.some((c) => c[0] === 'createColumn' && c[2] === 'new_priority'));
});

test('provisionDataModel skips an existing table (idempotent)', async () => {
  const m = mockSdk({ new_ticket: true });
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 });
  assert.ok(!m.calls.some((c) => c[0] === 'createTable'), 'existing table not re-created');
});
```

- [ ] **Step 2: Run**

Run: `node --test plugins/model-apps/scripts/tests/entity-provision.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/model-apps/scripts/tests/entity-provision.test.js
git commit -m "test(model-apps): unit-cover shared entity-provision core"
```

---

## Phase B — genpage adopter

### Task 3: Input validator `provision-input.js`

**Files:**
- Create: `scripts/lib/provision-input.js`
- Test: `scripts/tests/provision-input.test.js`

**Interfaces:**
- Produces: `validateProvisionInput(input) -> { ok, errors }`.
- The input is an App-Spec subset: `{ solution:{uniqueName,publisherPrefix,displayName?}, entities:[…], relationships:[…], globalChoices?:[…], sampleData?:{} }`. Reuse the entity/relationship validation rules from `scripts/lib/app-spec.js` — import its helpers rather than duplicating (DRY). If `validateAppSpec` hard-requires `app`/`forms`/`views`, add a `validateAppSpec(spec, { require: ['solution','entities'] })` option OR a dedicated subset validator that calls the shared field checks.

- [ ] **Step 1: Write failing tests**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateProvisionInput } = require(path.join(__dirname, '..', 'lib', 'provision-input.js'));

test('accepts a minimal valid input', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }], relationships: [] });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('rejects a missing solution.publisherPrefix', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default' }, entities: [], relationships: [] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /publisherPrefix/i.test(e)));
});

test('rejects an entity whose schemaName lacks a prefix', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'candidate', displayName: 'C', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }], relationships: [] });
  assert.strictEqual(r.ok, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test plugins/model-apps/scripts/tests/provision-input.test.js`
Expected: FAIL ("Cannot find module …/provision-input.js").

- [ ] **Step 3: Implement `provision-input.js`** delegating to `app-spec.js` field checks; enforce `solution.uniqueName`, `solution.publisherPrefix`, each `entities[].schemaName` matches `/^[a-z][a-z0-9]+_[A-Za-z][A-Za-z0-9]+$/`, each entity has `primaryAttribute.schemaName`, relationships reference declared/known entities.

- [ ] **Step 4: Run to verify pass**

Run: `node --test plugins/model-apps/scripts/tests/provision-input.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/model-apps/scripts/lib/provision-input.js plugins/model-apps/scripts/tests/provision-input.test.js
git commit -m "feat(model-apps): add provision-entities input validator"
```

### Task 4: The `provision-entities.js` CLI

**Files:**
- Create: `scripts/provision-entities.js`
- Test: `scripts/tests/provision-entities.test.js`

**Interfaces:**
- Consumes: `validateProvisionInput` (Task 3); `provisionSolution`/`provisionDataModel`/`provisionSampleData`/`makeRunner` (Task 1); `createAzHttpClient` (`lib/sdk-http-client.js`); `createMakerSdk` (`vendor/cds-maker-sdk.cjs`) — mirror `build-model-app.js`'s `makeSdk`.
- Produces: the structured JSON result shape in "Target Interfaces". Exports `provisionEntities(input, opts, deps)` for testing (deps injects `sdk`/`provision`/`emit`/`log`, so tests never touch the network or the real bundle).

- [ ] **Step 1: Write the wiring test (mock SDK, no network)**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { provisionEntities } = require(path.join(__dirname, '..', 'provision-entities.js'));

const input = { solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
  entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', pluralName: 'Candidates', primaryAttribute: { schemaName: 'cr_name' },
    columns: [{ schemaName: 'cr_status', type: 'Choice', options: ['Applied', 'Hired'] }] }], relationships: [] };

function mockDeps() {
  const calls = [];
  const sdk = {
    queryRecords: async () => [{ solutionid: 's' }], createPublisher: async () => ({ id: 'p' }), createSolution: async () => ({ id: 's' }),
    createTable: async (o) => { calls.push('createTable'); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
    createColumn: async () => { calls.push('createColumn'); return { logicalName: 'cr_status' }; },
    createGlobalOptionSet: async () => ({ metadataId: 'g' }), insertStatusValue: async () => 1, createAlternateKey: async () => ({}), createCustomerColumn: async () => ({}),
    createRecordsBulk: async (e, rows) => rows.map((_, i) => `${e}-${i}`),
  };
  const provision = { findTables: async () => [], findColumns: async () => [], fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }), queryRecords: async () => [{ solutionid: 's' }] };
  return { sdk, provision, calls };
}

test('dry-run validates + plans, no SDK writes', async () => {
  const d = mockDeps();
  const r = await provisionEntities(input, { apply: false }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(d.calls.length, 0);
});

test('apply provisions and returns resolved names', async () => {
  const d = mockDeps();
  const r = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.ok, true);
  assert.ok(d.calls.includes('createTable'));
  assert.strictEqual(r.entities[0].logicalName, 'cr_candidate');
  assert.strictEqual(r.entities[0].entitySetName, 'cr_candidates');
});

test('rejects an invalid input before any write', async () => {
  const d = mockDeps();
  const r = await provisionEntities({ solution: { uniqueName: 'Default' }, entities: [] }, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(d.calls.length, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test plugins/model-apps/scripts/tests/provision-entities.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `provision-entities.js`.** Model `main()` and `makeSdk` on `build-model-app.js`. `provisionEntities(input, opts, deps)`: validate via `validateProvisionInput`; if invalid return `{ ok:false, errors }`; compute a plan length (entities + columns + relationships + sample steps); build a runner; call the three provision functions; assemble the structured result from the captured maps. Dry-run returns `{ ok:true, dryRun:true, plan:[…] }`. CLI usage: `node provision-entities.js --env <url> --input @<path> [--apply] [--sample-data]`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test plugins/model-apps/scripts/tests/provision-entities.test.js`
Expected: PASS.

- [ ] **Step 5: Smoke-test the CLI dry-run end-to-end (offline)**

Write a temp input JSON to `D:/temp-claude/prov-input.json` mirroring the test `input`, then:
Run: `node plugins/model-apps/scripts/provision-entities.js --env https://example.crm.dynamics.com --input @D:/temp-claude/prov-input.json`
Expected: a JSON line with `"dryRun": true` and a `plan` listing the table + column; no network calls. Delete the temp file.

- [ ] **Step 6: Commit**

```bash
git add plugins/model-apps/scripts/provision-entities.js plugins/model-apps/scripts/tests/provision-entities.test.js
git commit -m "feat(model-apps): add provision-entities CLI over the shared core"
```

### Task 5: Rewire the `genpage-entity-builder` agent

**Files:**
- Modify: `agents/genpage-entity-builder.md`

**Interfaces:**
- Consumes: `provision-entities.js` CLI (Task 4). Preserves the `entity-creation-log.md` token format the eval parses.

- [ ] **Step 1: Rewrite Steps 4, 5, 7** so the agent:
  1. Builds one JSON (`<working-dir>/provision-input.json`) from `## Entity Creation Required` + `## Environment`, constructing **full** `${prefix}_${Suffix}` schema names exactly as today (the suffix-validation in the current Step 1 stays). Map plan column types → App-Spec types (`string→Text`, `int→Integer`, `decimal→Decimal`, `money→Money`, `memo→Memo`, `datetime→DateTime`, `boolean→Boolean`, `picklist→Choice` with `options: [labels]`). Map relationships → `relationships: [{ type:'OneToMany', referenced, referencing, lookup:{schemaName,displayName} }]` / `{ type:'ManyToMany', entity1, entity2 }`.
  2. Runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/provision-entities.js" --env "$ENV_URL" --input @<working-dir>/provision-input.json --apply` (add `--sample-data` when the user opts in at Step 6). One call replaces the per-table `create-table.js`/`add-column.js`/`create-relationship.js`/`create-record.js` sequence and the propagation `sleep`s (the SDK handles ordering + propagation).
  3. Parses the CLI's structured JSON and writes `entity-creation-log.md` with the SAME tokens the eval parses — for every created table/column, a line `Resolved Full Name: <logicalName>` (and keep `Schema Name:` / `Metadata ID:`). Keep the `## Environment` block (URL/Solution/Publisher Prefix).
- [ ] **Step 2: Remove the now-obsolete guidance** — the 4s/8s propagation waits, the per-type `add-column.js` examples, and the "one script invocation per logical operation" framing — replace with the single-call flow. Keep: Step 1 (read plan), Step 2 (check-auth), Step 3 (open log), Step 6 (sample-data AskUserQuestion), Step 8 (return summary), and all Critical Constraints except the per-script ones.
- [ ] **Step 3: Verify the agent doc references only existing scripts**

Run: `grep -nE "create-table\.js|add-column\.js|create-relationship\.js|create-record\.js" plugins/model-apps/agents/genpage-entity-builder.md`
Expected: no matches (all replaced by `provision-entities.js`).

- [ ] **Step 4: Commit**

```bash
git add plugins/model-apps/agents/genpage-entity-builder.md
git commit -m "refactor(model-apps): genpage entity-builder provisions via shared core"
```

### Task 6: Docs — plan-schema note + AGENTS.md

**Files:**
- Modify: `references/plan-schema.md`, `AGENTS.md`

- [ ] **Step 1:** In `plan-schema.md`, under `## Entity Creation Required`, add one line: the entity-builder now provisions the whole section in one pass via `scripts/provision-entities.js` (SDK-backed, idempotent); the section contract (suffix-only names) is unchanged.
- [ ] **Step 2:** In `AGENTS.md`, update the `genpage-entity-builder` row and the scripts list: add `provision-entities.js` + `lib/entity-provision.js` + `lib/provision-input.js`; note the create-table/add-column/create-relationship/create-record scripts are superseded (removed in Task 11).
- [ ] **Step 3: Commit**

```bash
git add plugins/model-apps/references/plan-schema.md plugins/model-apps/AGENTS.md
git commit -m "docs(model-apps): record entity-provisioning consolidation"
```

---

## Phase C — Evals, regression gate, cleanup

### Task 7: Update eval assertions

**Files:**
- Modify: `evals/model-apps/genpage/lib/assertions-layer-1.js`
- Test: `evals/model-apps/genpage/tests/assertions-layer-1.test.js`

**Context:** The assertion "Phase 2a: … check-auth.js runs … before entity-builder is invoked" (locate by the string `entity creation script invoked before check-auth.js`) searches the workflow log for `/\b(create-table\.js|add-column\.js|create-relationship\.js|create-record\.js)\b/`. It must recognize `provision-entities.js` too.

- [ ] **Step 1: Write the failing assertion test**

Add to `evals/model-apps/genpage/tests/assertions-layer-1.test.js` a case whose workflow log uses `provision-entities.js` (not the old scripts) after `check-auth.js`, and assert the check-auth-ordering assertion returns pass; and a case where `provision-entities.js` appears BEFORE `check-auth.js` and assert it fails.

- [ ] **Step 2: Run to verify failure**

Run: `node --test evals/model-apps/genpage/tests/assertions-layer-1.test.js`
Expected: FAIL (regex doesn't include `provision-entities.js`).

- [ ] **Step 3: Extend the regex** in `assertions-layer-1.js` to `/\b(provision-entities\.js|create-table\.js|add-column\.js|create-relationship\.js|create-record\.js)\b/` (keep the old names so pre-migration fixtures still validate). Update the assertion's prose description to mention `provision-entities.js`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test evals/model-apps/genpage/tests/assertions-layer-1.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add evals/model-apps/genpage/lib/assertions-layer-1.js evals/model-apps/genpage/tests/assertions-layer-1.test.js
git commit -m "test(evals): recognize provision-entities.js in entity-creation ordering"
```

### Task 8: Refresh entity-creating fixtures

**Files:**
- Modify: `evals/model-apps/genpage/fixtures/7-job-candidates-new-entities/{workflow-log.md,entity-creation-log.md}`
- Modify: `evals/model-apps/genpage/fixtures/15-support-tickets-real/{workflow-log.md,entity-creation-log.md}`
- Modify: `evals/model-apps/genpage/fixtures/11-recruitment-pages-real/{workflow-log.md,entity-creation-log.md}` (if it contains entity creation)

**Context:** Fixtures are captured artifacts the runners assert against. Only the **command** representation changes: the workflow log's `create-table.js …` / `add-column.js …` lines and the `entity-creation-log.md` "Commands" block become a single `provision-entities.js --input @…/provision-input.json --apply` call. The `Resolved Full Name:` / `Schema Name:` / `Metadata ID:` tokens and the `## Environment` block stay identical (so the prefix-discipline assertion still passes).

- [ ] **Step 1:** For each fixture, replace the per-script command lines with the single `provision-entities.js` command; keep the resolved-name tables/lines byte-for-byte where the assertions read them.
- [ ] **Step 2: Run both eval layers, smoke + full**

Run:
```
node evals/model-apps/genpage/run-layer-1.js --tier smoke
node evals/model-apps/genpage/run-layer-1.js --tier full
node evals/model-apps/genpage/run-layer-2.js --tier smoke
node evals/model-apps/genpage/run-layer-2.js --tier full
```
Expected: all green (TAP `# fail 0`). If a fixture assertion fails, diff the token it reads and restore it.

- [ ] **Step 3: Commit**

```bash
git add evals/model-apps/genpage/fixtures
git commit -m "test(evals): refresh entity-creation fixtures for provision-entities.js"
```

### Task 9: Full regression gate

**Files:** none (verification only)

- [ ] **Step 1: Run every model-apps script test**

Run: `node --test plugins/model-apps/scripts/tests/*.test.js`
Expected: `# fail 0`.

- [ ] **Step 2: Run every eval unit test**

Run: `node --test evals/model-apps/genpage/tests/*.test.js`
Expected: `# fail 0`.

- [ ] **Step 3: Run both eval runners (smoke + full)**

Run the four commands from Task 8 Step 2.
Expected: all green.

- [ ] **Step 4: Confirm no stale references to the old scripts in genpage runtime paths**

Run: `grep -rnE "create-table\.js|add-column\.js|create-relationship\.js|create-record\.js" plugins/model-apps/agents plugins/model-apps/skills plugins/model-apps/references`
Expected: no matches (docs/agents fully migrated). Matches are allowed only in `AGENTS.md` "superseded" note and in `scripts/tests` (until Task 11).

- [ ] **Step 5: Commit any doc fixups; otherwise proceed.**

### Task 10 (GATED — needs user go-ahead): Live shakeout on 983a1

**Files:** none (a throwaway probe on the shared env)

- [ ] **Step 1:** With explicit user approval and `az`/`pac` pointed at 983a1, run `/genpage` for a small new-entity request (or drive `provision-entities.js --apply --sample-data` directly with a `rc_probe*` input). Confirm tables/columns/relationships/records land via `dataverse-request.js` GETs.
- [ ] **Step 2:** Tear down with the first-class teardown: `node scripts/teardown-model-app.js --env <983a1> --spec @<probe>/app-spec.json --apply` (or a spec-shaped file), confirm 0 leftovers.
- [ ] **Step 3:** Record the shakeout in `docs/model-app-maker-roadmap.md` (dated changelog line) and commit.

### Task 11 (GATED — needs user go-ahead): Remove the superseded scripts

**Files:**
- Remove: `scripts/create-table.js`, `scripts/add-column.js`, `scripts/create-relationship.js`, `scripts/create-record.js`, `scripts/create-solution.js`, `scripts/add-to-solution.js` and their `scripts/tests/*.test.js`.

- [ ] **Step 1:** Confirm nothing references them (Task 9 Step 4 grep, plus `grep -rn "create-solution\.js\|add-to-solution\.js" plugins/model-apps`).
- [ ] **Step 2:** Delete the scripts + tests. Update `AGENTS.md` to drop them from the scripts list.
- [ ] **Step 3: Full regression gate** (Task 9 Steps 1–3) — expect green with the reduced test count.
- [ ] **Step 4: Commit**

```bash
git rm plugins/model-apps/scripts/create-table.js plugins/model-apps/scripts/add-column.js plugins/model-apps/scripts/create-relationship.js plugins/model-apps/scripts/create-record.js plugins/model-apps/scripts/create-solution.js plugins/model-apps/scripts/add-to-solution.js plugins/model-apps/scripts/tests/create-table.test.js plugins/model-apps/scripts/tests/add-column.test.js plugins/model-apps/scripts/tests/create-relationship.test.js plugins/model-apps/scripts/tests/create-record.test.js plugins/model-apps/scripts/tests/create-solution.test.js plugins/model-apps/scripts/tests/add-to-solution.test.js
git commit -m "chore(model-apps): remove Web-API entity scripts superseded by shared core"
```

---

## Risks & Mitigations

- **Extraction changes model-app-maker behavior.** Mitigation: Task 1's parity anchor + the untouched 241 sdk-build/build-model-app tests are the gate; the refactor is mechanical (move code, delegate) with no logic changes.
- **SDK propagation differs from the agent's explicit 4s/8s waits.** Mitigation: the SDK's HttpClient already retries transient 5xx/429 (`sdk-http-client.js`); the discover-then-create relationship step tolerates "just created" races. Validate in the live shakeout (Task 10).
- **Eval fixtures over-couple to command text.** Mitigation: only the command line changes; the resolved-name tokens the assertions parse are preserved byte-for-byte (Task 8).
- **`Default` solution + arbitrary prefix.** The shared solution phase skips creating the existing `Default` solution and only creates a publisher when the prefix's publisher is missing — matches current genpage behavior.
- **Removing scripts breaks an external caller.** Mitigation: Task 11 is gated + reversible (git); keep the scripts until evals are green and the user approves.

## Verification Summary (offline, through Task 9)

```
node --test plugins/model-apps/scripts/tests/*.test.js          # unit: shared core, CLI, validator, sdk-build parity
node --test evals/model-apps/genpage/tests/*.test.js            # eval assertion unit tests
node evals/model-apps/genpage/run-layer-1.js --tier full        # eval Layer 1 (static)
node evals/model-apps/genpage/run-layer-2.js --tier full        # eval Layer 2 (behavior)
```
All must report `# fail 0` / TAP green before Phase C is considered done.

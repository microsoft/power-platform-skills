# App-Builder Staged Flow — Plan 4: Evals, Author Redesign & Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the FINAL plan of the staged-flow re-architecture; it assumes Plans 1–3 are landed. Do not skip a code task's RED run, and keep the full suite green after every task.

**Goal:** Close the staged flow with its evaluation, author-redesign, and documentation layers — (1) a pure `schema-facts.js` data-model provisioning extractor (the data-stage analogue of `wire-facts.js`), (2) a pure whole-app design renderer `preview-app.js`/`app-preview.js` (reusing `form-preview.js`), (3) the **data-driven OFFLINE eval harness** under `evals/model-apps/app-builder/` (modeled on `evals/model-apps/genpage/`) that asserts per-stage **structural** facts, (4) the **author-redesign DOC updates** (design-only author, two consent levels, generate-pages step, `--stage`/`--allow-destructive`/`--non-interactive`), and (5) the full **doc-sync** (architecture stage diagram, `AGENTS.md`, `CHANGELOG.md`, `app-spec-schema.md`). No engine phase is renamed; no Dataverse write behavior changes.

**Architecture:** Purely additive. Two new **pure leaf modules** — `schema-facts.js` (spec → normalized data-model facts, reusing `app-spec.js` naming/value rules) and `app-preview.js` (spec → ASCII whole-app design, reusing `form-preview.js`) — plus a thin CLI `preview-app.js`. The eval harness lives at the **repo root** (`evals/model-apps/app-builder/`, sibling of `genpage/`), reuses the existing plugin primitives (`validateAppSpec`, `lintAppSpec`, `planFor`, `schemaFacts`, `viewDef`/`chartDef`/`compileFormIntent`/`appDef`, `verifySpec`) to compute deterministic per-stage facts, and reuses the genpage `TapReporter`. Tasks 4–5 are **doc-only**. The page-facts oracle is **loosely coupled** to Plan 3's `pageref-resolver.js`: where that module is absent, the page-navigation-resolution sub-check degrades to a TAP `SKIP`.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`. Plugin suite: `node scripts/run-tests.js`. Eval harness: `node --test evals/model-apps/app-builder/tests/*.test.js` + `node evals/model-apps/app-builder/run-app-builder.js` (run from the **repo root**). Design source of truth: `plugins/model-apps/docs/app-builder-staged-flow-design.md` — **§12** (whole-app preview), **§13.2** (structural eval oracles + `schema-facts`), **§7** (author redesign), **§16** (doc-sync).

## Global Constraints

- **Plugin-root commands** (Tasks 1, 2, 4, 5): run from `D:\Projects\power-platform-skills-sdk\plugins\model-apps`. **Repo-root commands** (Task 3 — the eval harness): run from `D:\Projects\power-platform-skills-sdk` (the `evals/` tree lives at the repo root, exactly like `evals/model-apps/genpage/`).
- Tests use `node:test`: `const { test } = require('node:test'); const assert = require('node:assert');`. Plugin full suite: `node scripts/run-tests.js` (currently **570** passing after Plan 2 — **re-confirm the live count first**, since Plan 3 lands around this plan and adds tests; keep whatever the current count is green). Single file: `node --test scripts/tests/<file>.test.js`.
- **Prerequisite:** Plans 1–3 are landed. This plan builds on committed interfaces: `app-spec.js` (`validateAppSpec(spec,{profile})`, `normalizePageSource`, `migrateAppSpec`, page `key`/`navigatesTo`/`pageInput`/`design`, `columnTypeMap`/`choiceValueMap`/`relationshipSchemaName`/`manyToManySchemaName`), `stages.js` (`PHASES`/`STAGES`/`--stage`), `op-diff.js` + `--allow-destructive`/`--non-interactive` (Plan 2), and Plan 3's page manifest + `pageref-resolver.js` + page verify. Where Plan 3's `pageref-resolver.js` is not yet present, the page-facts eval row degrades to `SKIP` (do **not** hard-require it).
- **Pure modules are offline-only:** `schema-facts.js` and `app-preview.js` have **no I/O and no SDK handle** — they derive everything deterministically from the App Spec. They are unit-tested with in-memory specs. The eval harness is offline + deterministic (**no live env, no network, no vendored-bundle round-trip**); it computes facts from the pure primitives only.
- The **13 engine phase names and order are unchanged**: `solution, data-model, sample-data, web-resources, views, charts, forms, commands, dashboards, app-shell, pages, ai-features, publish`.
- **`schema-facts.js` mirrors `wire-facts.js` conventions:** lowercase logical identities, stable sort, and reuse of the engine's real derivation rules (relationship schema-name prefixing via `relationshipSchemaName`/`manyToManySchemaName`; choice values `100000000 + index` via `choiceValueMap`; the "buildable column" filter — every App Spec type except `Lookup`, i.e. `columnTypeMap(type).dv !== null`, matching `entity-provision.js` and `planFor`). A fact equals what the engine **would provision**, not a naive spec echo.
- Commit trailers on every commit:
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89
  ```

---

## File Structure

- `scripts/lib/schema-facts.js` **(new)** — pure data-model provisioning fact extractor: `schemaFacts(spec)`, `isBuildableColumn(c)`. Depends only on `app-spec.js` (leaf).
- `scripts/lib/app-preview.js` **(new)** — pure whole-app design renderer: `renderAppPreview(spec)`. Reuses `form-preview.js` (`renderFormWireframe`).
- `scripts/preview-app.js` **(new)** — thin CLI over `app-preview.js` (reads a spec, migrates on load, prints).
- `scripts/tests/schema-facts.test.js`, `scripts/tests/app-preview.test.js` **(new)** — offline unit tests (part of the plugin suite).
- `scripts/tests/golden/schema-facts.support-desk.json` **(new)** — golden snapshot for the support-desk data model (via the existing `assertGolden` helper).
- `evals/model-apps/app-builder/` **(new — repo root)**:
  - `evals.json` — data-driven cases + `common_stage_assertions` + per-eval `expect` blocks.
  - `fixtures/1-support-desk/app-spec.json` — copy of `samples/app-spec.support-desk.json`.
  - `fixtures/2-orders-multipage/app-spec.json` — a `schemaVersion: 2` multi-page spec (2 tables, 2 pages with navigation + a `design` contract).
  - `lib/fixture-loader.js` — loads each fixture's `app-spec.json`.
  - `lib/facts.js` — pure per-stage fact computation reusing the plugin primitives (+ `schema-facts.js`).
  - `lib/assertions.js` — registry mapping each assertion text → a check function.
  - `run-app-builder.js` — TAP v13 runner (reuses the genpage `TapReporter`).
  - `EVAL_GUIDE.md` — guide (companion to `genpage/EVAL_GUIDE.md`).
  - `tests/facts.test.js`, `tests/run-app-builder.test.js` — offline unit + e2e tests (run via `node --test`, **not** part of the plugin `run-tests.js`).
- `skills/app-builder/SKILL.md`, `references/authoring-flow.md` **(modify — doc-only, Task 4)** — design-only author, two consent levels, generate-pages step, `--stage`/`--allow-destructive`/`--non-interactive`, `Task` in `allowed-tools`, `preview-app.js`.
- `docs/architecture.md`, `AGENTS.md`, `CHANGELOG.md`, `references/app-spec-schema.md` **(modify — doc-only, Task 5)** — staged-flow stage diagram, file-tree + component specs, changelog, schema cross-links.

---

## Task 1: `schema-facts.js` — normalized data-model provisioning facts (pure)

**Files:**
- Create: `scripts/lib/schema-facts.js`
- Create: `scripts/tests/schema-facts.test.js`
- Create: `scripts/tests/golden/schema-facts.support-desk.json` (generated in Step 4 via `UPDATE_GOLDENS=1`)

**Interfaces:**
- Consumes: `app-spec.js` — `columnTypeMap(type) → { dv }`, `choiceValueMap(entity, spec) → { columnLogical: { label: value } }`, `relationshipSchemaName(rel, prefix) → string`, `manyToManySchemaName(rel, prefix) → string`. (All already exported: `app-spec.js:733-751`.) No I/O, no SDK.
- Produces:
  - `isBuildableColumn(c) → boolean` — true for every App Spec column type the engine actually creates (all types except `Lookup`, which maps to `dv:null`; `Customer` → `dv:'lookup'` counts as buildable). Matches `entity-provision.js:212` and `planFor` (`sdk-build.js:250`).
  - `schemaFacts(spec) → { globalChoices: [{ name, options:[{value,label}] }], tables: [{ logicalName, displayName, hasNotes, primary:{logicalName,displayName,autoNumber}, columns:[{logicalName,type,required,choices?:[{value,label}]}], statusReasons:[{label,state}], alternateKeys:[{logicalName,columns:[…]}] }], relationships: [ { kind:'1:n', schemaName, referenced, referencing, lookup:{logicalName,displayName} } | { kind:'n:n', schemaName, entity1, entity2, intersect? } ] }` — every identity lowercased, every array sorted by a stable key (globalChoices/tables/relationships by name/logicalName/schemaName; columns by logicalName; statusReasons by label; alternateKeys by logicalName). Two deep-equal fact sets prove two builds provision the **same** data model — the **data-stage** eval oracle (design §13.2).

- [ ] **Step 1: Write the failing test** — `scripts/tests/schema-facts.test.js`

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { schemaFacts, isBuildableColumn } = require('../lib/schema-facts.js');
const { assertGolden } = require('./helpers/golden.js');

const sample = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', `app-spec.${n}.json`), 'utf8'));

test('isBuildableColumn: every type except Lookup is buildable; Customer is buildable', () => {
  for (const type of ['Text', 'Memo', 'Choice', 'MultiChoice', 'Boolean', 'Money', 'DateTime', 'Integer', 'BigInt', 'Decimal', 'Double', 'File', 'Image', 'AutoNumber', 'Customer']) {
    assert.strictEqual(isBuildableColumn({ type }), true, `${type} should be buildable`);
  }
  assert.strictEqual(isBuildableColumn({ type: 'Lookup' }), false);
  assert.strictEqual(isBuildableColumn({}), true); // undefined type defaults to Text (buildable)
});

test('schemaFacts normalizes tables: lowercased logical, buildable columns only, choice values pinned', () => {
  const spec = {
    solution: { publisherPrefix: 'new' },
    globalChoices: [{ name: 'new_Region', options: ['East', 'West'] }],
    entities: [{
      schemaName: 'new_Order', displayName: 'Order', hasNotes: true,
      primaryAttribute: { schemaName: 'new_Name', displayName: 'Order #', autoNumberFormat: 'ORD-{SEQNUM:4}' },
      columns: [
        { schemaName: 'new_Status', displayName: 'Status', type: 'Choice', options: ['Open', 'Closed'] },
        { schemaName: 'new_Owner', displayName: 'Owner', type: 'Lookup' }, // not buildable — dropped
      ],
      statusReasons: [{ label: 'On Hold', state: 'Active' }],
    }],
  };
  const f = schemaFacts(spec);
  const t = f.tables[0];
  assert.strictEqual(t.logicalName, 'new_order');
  assert.strictEqual(t.hasNotes, true);
  assert.deepStrictEqual(t.primary, { logicalName: 'new_name', displayName: 'Order #', autoNumber: true });
  // Lookup column dropped; only the Choice column survives.
  assert.deepStrictEqual(t.columns.map((c) => c.logicalName), ['new_status']);
  assert.deepStrictEqual(t.columns[0].choices, [{ value: 100000000, label: 'Open' }, { value: 100000001, label: 'Closed' }]);
  assert.deepStrictEqual(f.globalChoices[0], { name: 'new_region', options: [{ value: 100000000, label: 'East' }, { value: 100000001, label: 'West' }] });
  assert.deepStrictEqual(t.statusReasons, [{ label: 'On Hold', state: 'Active' }]);
});

test('schemaFacts normalizes relationships with prefixed schema names, sorted', () => {
  const spec = {
    solution: { publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_customer', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    relationships: [
      { type: 'ManyToMany', entity1: 'new_ticket', entity2: 'new_tag', intersectEntityName: 'new_ticket_tag' },
      { type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } },
    ],
  };
  const f = schemaFacts(spec);
  assert.strictEqual(f.relationships.length, 2);
  // Sorted by schemaName; 1:n schema name is `<referenced>_<referencing>` (already prefixed).
  assert.deepStrictEqual(f.relationships[0], { kind: '1:n', schemaName: 'new_customer_new_ticket', referenced: 'new_customer', referencing: 'new_ticket', lookup: { logicalName: 'new_customerid', displayName: 'Customer' } });
  assert.strictEqual(f.relationships[1].kind, 'n:n');
  assert.strictEqual(f.relationships[1].schemaName, 'new_ticket_new_tag');
});

test('schemaFacts is deterministic regardless of input entity/column order', () => {
  const base = { solution: { publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_b', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_z', type: 'Text' }, { schemaName: 'new_a', type: 'Text' }] },
    { schemaName: 'new_a', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ] };
  const reordered = { solution: { publisherPrefix: 'new' }, entities: [base.entities[1], base.entities[0]] };
  assert.deepStrictEqual(schemaFacts(base), schemaFacts(reordered));
});

test('schemaFacts golden: support-desk data model is stable', () => {
  assertGolden('schema-facts.support-desk.json', JSON.stringify(schemaFacts(sample('support-desk')), null, 2) + '\n');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/schema-facts.test.js`
Expected: FAIL — `Cannot find module '../lib/schema-facts.js'`.

- [ ] **Step 3: Create `scripts/lib/schema-facts.js`**

```javascript
'use strict';
// Data-model provisioning fact extractor — the DATA-stage analogue of wire-facts.js. wire-facts
// normalizes the SERIALIZED wire payloads for forms/views/charts/sitemap (wire-facts.js:34-99);
// schema-facts normalizes the data model the engine PROVISIONS (createGlobalOptionSet / createTable /
// createColumn / createRelationship — entity-provision.js:167-291) into stable, comparable facts the
// offline eval harness diffs per build. Pure (no I/O, no SDK): it derives everything deterministically
// from the App Spec, reusing the SAME naming/value rules the engine uses, so a fact equals what WOULD
// be provisioned — not a naive spec echo. See docs/app-builder-staged-flow-design.md §13.2, §14.
const { columnTypeMap, choiceValueMap, relationshipSchemaName, manyToManySchemaName } = require('./app-spec.js');

const lc = (s) => String(s || '').toLowerCase();
const byKey = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);

// A column the engine actually creates. Every App Spec type maps to a Dataverse attribute EXCEPT
// `Lookup` (columnTypeMap('Lookup').dv === null — lookups come from relationships[], not columns).
// `Customer` maps to dv:'lookup' and IS buildable (createCustomerColumn). This is the exact set
// entity-provision.js builds (entity-provision.js:212) and planFor plans (sdk-build.js:250).
function isBuildableColumn(c) {
  return columnTypeMap(c && c.type).dv !== null;
}

// Choice/MultiChoice { value, label } pairs via the engine's shared rule (value = 100000000 + index;
// inline options AND globalChoice refs) so the fact carries the exact values the build assigns
// (app-spec.js choiceValueMap:35-55). Sorted by value (its natural, stable order).
function choiceFacts(entity, spec, columnLogical) {
  const map = choiceValueMap(entity, spec)[columnLogical];
  if (!map) return undefined;
  return Object.entries(map).map(([label, value]) => ({ value, label })).sort((a, b) => a.value - b.value);
}

function tableFacts(spec, e) {
  const primary = e.primaryAttribute || {};
  const columns = (e.columns || []).filter(isBuildableColumn).map((c) => {
    const columnLogical = lc(c.schemaName);
    const fact = { logicalName: columnLogical, type: c.type || 'Text', required: c.required === true };
    const choices = (c.type === 'Choice' || c.type === 'MultiChoice') ? choiceFacts(e, spec, columnLogical) : undefined;
    if (choices) fact.choices = choices;
    return fact;
  }).sort(byKey('logicalName'));
  return {
    logicalName: lc(e.schemaName),
    displayName: e.displayName || '',
    hasNotes: e.hasNotes === true,
    primary: { logicalName: lc(primary.schemaName), displayName: primary.displayName || '', autoNumber: !!primary.autoNumberFormat },
    columns,
    statusReasons: (e.statusReasons || []).map((sr) => ({ label: sr.label, state: sr.state || 'Active' })).sort(byKey('label')),
    alternateKeys: (e.alternateKeys || []).map((k) => ({ logicalName: lc(k.schemaName), columns: (k.columns || []).map(lc).sort() })).sort(byKey('logicalName')),
  };
}

function relationshipFacts(spec) {
  const prefix = spec.solution && spec.solution.publisherPrefix;
  const rels = [];
  for (const r of spec.relationships || []) {
    if (r.type === 'OneToMany') {
      rels.push({ kind: '1:n', schemaName: lc(relationshipSchemaName(r, prefix)), referenced: lc(r.referenced), referencing: lc(r.referencing),
        lookup: { logicalName: lc(r.lookup && r.lookup.schemaName), displayName: (r.lookup && r.lookup.displayName) || '' } });
    } else if (r.type === 'ManyToMany') {
      const fact = { kind: 'n:n', schemaName: lc(manyToManySchemaName(r, prefix)), entity1: lc(r.entity1), entity2: lc(r.entity2) };
      if (r.intersectEntityName) fact.intersect = lc(r.intersectEntityName);
      rels.push(fact);
    }
  }
  return rels.sort(byKey('schemaName'));
}

// The full normalized data-model fact set (stable order, lowercased identities). Deep-equal two of
// these to prove two builds provision the SAME data model — the DATA-stage eval oracle.
function schemaFacts(spec) {
  const s = spec || {};
  return {
    globalChoices: (s.globalChoices || []).map((g) => ({ name: lc(g.name), options: (g.options || []).map((label, i) => ({ value: 100000000 + i, label })) })).sort(byKey('name')),
    tables: (s.entities || []).map((e) => tableFacts(s, e)).sort(byKey('logicalName')),
    relationships: relationshipFacts(s),
  };
}

module.exports = { schemaFacts, isBuildableColumn };
```

- [ ] **Step 4: Generate the golden, then run tests**

Generate the golden once (review the diff before committing): `UPDATE_GOLDENS=1 node --test scripts/tests/schema-facts.test.js`
Then verify green: `node --test scripts/tests/schema-facts.test.js` → PASS.
Then the full gate: `node scripts/run-tests.js` → PASS (new file adds tests; nothing else changes).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/schema-facts.js scripts/tests/schema-facts.test.js scripts/tests/golden/schema-facts.support-desk.json
git commit -m "feat(model-apps): schema-facts.js — normalized data-model provisioning facts for evals" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 2: `preview-app.js` + `app-preview.js` — whole-app design renderer (pure)

**Files:**
- Create: `scripts/lib/app-preview.js`
- Create: `scripts/preview-app.js`
- Create: `scripts/tests/app-preview.test.js`

**Interfaces:**
- Consumes: `form-preview.js` — `renderFormWireframe(spec, form) → string` (`form-preview.js:86-138`). CLI also consumes `dataverse-auth.js` `parseArgs`/`readJsonArg` and `app-spec.js` `migrateAppSpec`.
- Produces:
  - `renderAppPreview(spec) → string` — the **entire** design as one ASCII artifact (design §12): a header, a **data-model** summary (tables + buildable columns + relationships), the **appShell sitemap tree** (each subarea labeled by target kind: `table` / `page` / `dashboard` / `url`), **views & charts**, **per-form wireframes** (reusing `renderFormWireframe`), **page-intents** (key/name/purpose/data-sources/navigation + implemented-vs-intent state), and the **page design contract**. Pure (no writes) → offline-testable. Empty/absent sections render a `(none)` placeholder rather than throwing.
  - `scripts/preview-app.js` `main()` — reads `--spec @<path>`, `migrateAppSpec`s it, writes `renderAppPreview(spec)` to stdout (mirrors `preview-form.js:12-22`).

- [ ] **Step 1: Write the failing test** — `scripts/tests/app-preview.test.js`

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderAppPreview } = require('../lib/app-preview.js');

const sample = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', `app-spec.${n}.json`), 'utf8'));

test('renderAppPreview renders every design section for the support-desk sample', () => {
  const out = renderAppPreview(sample('support-desk'));
  assert.match(out, /APP: Support Desk/);
  assert.match(out, /=== Data model ===/);
  assert.match(out, /new_customer/); // table logical shown
  assert.match(out, /=== Sitemap \(appShell\) ===/);
  assert.match(out, /table:new_customer/); // entity subarea labeled by target kind
  assert.match(out, /=== Views & charts ===/);
  assert.match(out, /Tickets by Priority/);
  assert.match(out, /=== Forms ===/);
  // A reused form wireframe (from form-preview.js) is embedded — its box border is present.
  assert.match(out, /┌─/);
  // 1:N relationships summarized.
  assert.match(out, /1:N\s+new_customer\s+→\s+new_ticket/);
});

test('renderAppPreview renders page-intents and the design contract for a v2 multi-page spec', () => {
  const spec = {
    schemaVersion: 2,
    app: { name: 'Orders', description: 'Order ops' },
    entities: [{ schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_order', title: 'Orders' }, { page: 'overview', title: 'Overview' }] }] }] },
    pages: [
      { key: 'overview', name: 'Overview', purpose: 'KPIs', dataSources: ['new_order'], source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'order-detail', data: { orderId: 'string' } }] },
      { key: 'order-detail', name: 'Order Detail', purpose: 'One order', dataSources: ['new_order'], source: { kind: 'tsx', codeFile: 'order-detail.tsx' } },
    ],
    design: { accentColor: '#0f6cbd', density: 'comfortable' },
  };
  const out = renderAppPreview(spec);
  assert.match(out, /=== Pages \(generative\) ===/);
  assert.match(out, /Overview \[overview\] — intent \(design-only\)/);
  assert.match(out, /Order Detail \[order-detail\] — implemented \(order-detail\.tsx\)/);
  assert.match(out, /purpose: KPIs/);
  assert.match(out, /→ navigates to order-detail/);
  assert.match(out, /page:overview/); // page subarea labeled by key
  assert.match(out, /=== Design contract ===/);
  assert.match(out, /accentColor=#0f6cbd/);
});

test('renderAppPreview does not throw on a minimal / empty spec', () => {
  const out = renderAppPreview({ app: { name: 'Bare' } });
  assert.match(out, /APP: Bare/);
  assert.match(out, /\(no tables\)/);
  assert.match(out, /\(no forms\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/app-preview.test.js`
Expected: FAIL — `Cannot find module '../lib/app-preview.js'`.

- [ ] **Step 3: Create `scripts/lib/app-preview.js`**

```javascript
'use strict';
// Whole-app design preview: render the ENTIRE App Spec as the single approval artifact the user signs
// off at design gate #2 / plan mode (or that autopilot writes to disk). preview-form.js renders ONE
// form; this renders the whole app — a data-model summary, the appShell sitemap tree, views/charts,
// per-form wireframes (reusing form-preview.js), page-INTENTS (purpose/data-sources/navigation), and
// the page design contract. Pure (no I/O); the CLI wrapper is preview-app.js. See design §12.
const { renderFormWireframe } = require('./form-preview.js');

const lc = (s) => String(s || '').toLowerCase();
const h = (title) => `\n=== ${title} ===`;

function dataModelSection(spec) {
  const out = [h('Data model')];
  if (!(spec.entities || []).length) { out.push('  (no tables)'); }
  for (const e of spec.entities || []) {
    out.push(`  • ${e.displayName || e.schemaName} [${lc(e.schemaName)}]${e.hasNotes ? '  (notes/timeline)' : ''}`);
    out.push(`      primary: ${e.primaryAttribute ? e.primaryAttribute.schemaName : '(none)'}`);
    const cols = (e.columns || []).map((c) => `${c.schemaName} (${c.type || 'Text'})`);
    if (cols.length) out.push(`      columns: ${cols.join(', ')}`);
  }
  for (const r of spec.relationships || []) {
    if (r.type === 'OneToMany') out.push(`  ↳ 1:N  ${lc(r.referenced)}  →  ${lc(r.referencing)}  (lookup ${r.lookup && r.lookup.schemaName})`);
    else if (r.type === 'ManyToMany') out.push(`  ↳ N:N  ${lc(r.entity1)}  ↔  ${lc(r.entity2)}`);
  }
  return out;
}

// The target kind of a sitemap subarea. Exactly one of entity/page/dashboard/url is set (lint-enforced,
// app-spec.js:535-537), so label by the one present — this is what the user reviews for nav wiring.
function subAreaTarget(sa) {
  if (sa.entity) return `table:${lc(sa.entity)}`;
  if (sa.page) return `page:${sa.page}`;
  if (sa.dashboard) return `dashboard:${sa.dashboard}`;
  if (sa.url) return `url:${sa.url}`;
  return '(no target)';
}

function sitemapSection(spec) {
  const out = [h('Sitemap (appShell)')];
  const areas = (spec.appShell && spec.appShell.areas) || [];
  if (!areas.length) out.push('  (no sitemap)');
  for (const a of areas) {
    out.push(`  ▸ ${a.label || '(area)'}`);
    for (const g of a.groups || []) {
      out.push(`     ▹ ${g.label || '(group)'}`);
      for (const sa of g.subAreas || []) out.push(`        - ${sa.title || subAreaTarget(sa)}  →  ${subAreaTarget(sa)}`);
    }
  }
  return out;
}

function viewsChartsSection(spec) {
  const out = [h('Views & charts')];
  const views = spec.views || [];
  const charts = spec.charts || [];
  if (!views.length && !charts.length) out.push('  (none)');
  for (const v of views) out.push(`  ▦ view "${v.name}" (${lc(v.entity)}): ${(v.columns || []).join(', ')}`);
  for (const c of charts) out.push(`  ◫ chart "${c.name}" (${c.chartType}) on ${lc(c.entity)} — ${c.measure || 'count'} by ${c.groupBy}`);
  return out;
}

function formsSection(spec) {
  const out = [h('Forms')];
  const forms = spec.forms || [];
  if (!forms.length) { out.push('  (no forms)'); return out; }
  for (const f of forms) out.push(renderFormWireframe(spec, f));
  return out;
}

function pagesSection(spec) {
  const out = [h('Pages (generative)')];
  const pages = spec.pages || [];
  if (!pages.length) { out.push('  (no pages)'); return out; }
  for (const p of pages) {
    const impl = p.source && p.source.kind === 'tsx' ? `implemented (${p.source.codeFile})` : 'intent (design-only)';
    out.push(`  ▪ ${p.name} [${p.key || '(no key)'}] — ${impl}`);
    if (p.purpose) out.push(`      purpose: ${p.purpose}`);
    if ((p.dataSources || []).length) out.push(`      data: ${p.dataSources.join(', ')}`);
    for (const nav of p.navigatesTo || []) out.push(`      → navigates to ${nav.targetKey}${nav.data ? ` (data: ${Object.keys(nav.data).join(', ')})` : ''}`);
  }
  return out;
}

function designSection(spec) {
  if (!spec.design || typeof spec.design !== 'object' || Array.isArray(spec.design)) return [];
  return [h('Design contract'), '  ' + Object.entries(spec.design).map(([k, v]) => `${k}=${v}`).join('  ')];
}

function renderAppPreview(spec) {
  const s = spec || {};
  const lines = [`APP: ${(s.app && s.app.name) || '(unnamed app)'}`];
  if (s.app && s.app.description) lines.push(s.app.description);
  lines.push(...dataModelSection(s), ...sitemapSection(s), ...viewsChartsSection(s), ...formsSection(s), ...pagesSection(s), ...designSection(s));
  return lines.join('\n') + '\n';
}

module.exports = { renderAppPreview };
```

- [ ] **Step 4: Create the CLI `scripts/preview-app.js`**

```javascript
#!/usr/bin/env node
// Print an ASCII preview of the WHOLE App Spec — data-model summary, sitemap tree, views/charts,
// per-form wireframes, page-intents, and the design contract — so the user can review the entire app
// design at once during authoring (design gate #2 / plan mode). Read-only; the same spec the builder
// uses. Migrates a legacy spec on load so pages render by key. See scripts/lib/app-preview.js.
//
// Usage:
//   node preview-app.js --spec @<app-folder>/app-spec.json
const path = require('node:path');
const { renderAppPreview } = require('./lib/app-preview.js');
const { parseArgs, readJsonArg } = require('./lib/dataverse-auth.js');
const { migrateAppSpec } = require('./lib/app-spec.js');

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const specArg = flags.spec || positional[0];
  if (!specArg) {
    process.stderr.write('Usage: node preview-app.js --spec @<app-folder>/app-spec.json\n');
    process.exit(1);
  }
  const specPath = path.resolve(typeof specArg === 'string' && specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  process.stdout.write(renderAppPreview(spec));
}

if (require.main === module) main();
module.exports = { main };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/tests/app-preview.test.js` → PASS.
Smoke the CLI: `node scripts/preview-app.js --spec @samples/app-spec.support-desk.json` → prints the whole-app preview (no error).
Full gate: `node scripts/run-tests.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/app-preview.js scripts/preview-app.js scripts/tests/app-preview.test.js
git commit -m "feat(model-apps): preview-app.js — whole-app design preview (reuses form-preview)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 3: `evals/model-apps/app-builder/` — the offline structural eval harness

> **All Task-3 commands run from the REPO ROOT** (`D:\Projects\power-platform-skills-sdk`) — the `evals/` tree lives there, sibling to `evals/model-apps/genpage/`. These tests are **not** part of the plugin `run-tests.js`; run them with `node --test evals/model-apps/app-builder/tests/*.test.js`. Task 3 depends on **Task 1** (`schema-facts.js`).

**Files (all new, under `evals/model-apps/app-builder/`):**
- `fixtures/1-support-desk/app-spec.json`, `fixtures/2-orders-multipage/app-spec.json`
- `evals.json`, `lib/fixture-loader.js`, `lib/facts.js`, `lib/assertions.js`, `run-app-builder.js`, `EVAL_GUIDE.md`
- `tests/facts.test.js`, `tests/run-app-builder.test.js`

**Interfaces:**
- Consumes (via `../../../../plugins/model-apps/scripts/lib/…`): `app-spec.js` (`migrateAppSpec`, `validateAppSpec`), `spec-lint.js` (`lintAppSpec`), `sdk-build.js` (`planFor`, `PHASES`, `appDef`, `viewDef`, `chartDef`, `compileFormIntent`, `formFieldLogicals`), `schema-facts.js` (`schemaFacts` — Task 1), `verify-spec.js` (`verifySpec`), and **optionally** `pageref-resolver.js` (Plan 3 — loaded in a `try/catch`; absent ⇒ page oracle `SKIP`). Reuses the genpage `TapReporter` (`../genpage/lib/reporter.js`).
- Produces: `stageFacts(spec) → { author, plan, data, ui, app, verify, page, PHASES }` (offline per-stage facts); `loadFixtures(dir) → [{ id, dirName, dir, spec }]`; `ASSERTIONS: Map<text, ({facts,spec,eval}) → {status,reason?}>`; a TAP v13 runner exiting `0`/`1`/`2`.

- [ ] **Step 1: Author the two fixtures**

`evals/model-apps/app-builder/fixtures/1-support-desk/app-spec.json` — **copy** `plugins/model-apps/samples/app-spec.support-desk.json` verbatim (the data/ui/app/verify oracle case; no pages). From the repo root:

```bash
mkdir -p evals/model-apps/app-builder/fixtures/1-support-desk
cp plugins/model-apps/samples/app-spec.support-desk.json evals/model-apps/app-builder/fixtures/1-support-desk/app-spec.json
```

`evals/model-apps/app-builder/fixtures/2-orders-multipage/app-spec.json` — a `schemaVersion: 2` multi-page spec (exercises page-intents + navigation + design contract):

```json
{
  "schemaVersion": 2,
  "solution": { "uniqueName": "ContosoOrders", "displayName": "Contoso Orders", "publisherPrefix": "new" },
  "app": { "name": "Orders", "description": "Order operations + overview" },
  "entities": [
    { "schemaName": "new_order", "displayName": "Order", "pluralName": "Orders",
      "primaryAttribute": { "schemaName": "new_name", "displayName": "Order #" },
      "columns": [
        { "schemaName": "new_status", "displayName": "Status", "type": "Choice", "options": ["New", "Shipped", "Delivered"] },
        { "schemaName": "new_total", "displayName": "Total", "type": "Money" }
      ] },
    { "schemaName": "new_customer", "displayName": "Customer", "pluralName": "Customers",
      "primaryAttribute": { "schemaName": "new_name", "displayName": "Name" }, "columns": [] }
  ],
  "relationships": [
    { "type": "OneToMany", "referenced": "new_customer", "referencing": "new_order",
      "lookup": { "schemaName": "new_CustomerId", "displayName": "Customer" } }
  ],
  "forms": [
    { "entity": "new_order", "type": "main", "name": "Order", "layout": "auto" },
    { "entity": "new_customer", "type": "main", "name": "Customer", "layout": "auto",
      "subgrids": [{ "childEntity": "new_order", "view": "Active Orders", "label": "Orders" }] }
  ],
  "views": [
    { "entity": "new_order", "type": "main", "name": "Active Orders", "columns": ["new_name", "new_status", "new_total"], "activeOnly": true }
  ],
  "charts": [
    { "entity": "new_order", "name": "Orders by Status", "groupBy": "new_status", "measure": "count", "chartType": "Pie" }
  ],
  "pages": [
    { "key": "overview", "name": "Overview", "purpose": "KPI overview of orders",
      "dataSources": ["new_order"], "source": { "kind": "intent" },
      "navigatesTo": [{ "targetKey": "order-detail", "data": { "orderId": "string" } }], "pageInput": { "data": {} } },
    { "key": "order-detail", "name": "Order Detail", "purpose": "One order + line items",
      "dataSources": ["new_order"], "source": { "kind": "intent" }, "pageInput": { "data": { "orderId": "string" } } }
  ],
  "appShell": {
    "areas": [
      { "label": "Sales", "groups": [
        { "label": "Work", "subAreas": [
          { "page": "overview", "title": "Overview" },
          { "entity": "new_order", "title": "Orders" },
          { "entity": "new_customer", "title": "Customers" }
        ] }
      ] }
    ]
  },
  "design": { "accentColor": "#0f6cbd", "density": "comfortable", "cornerRadius": "medium", "darkMode": "system", "layout": "cards" }
}
```

- [ ] **Step 2: Write `evals.json`**

`evals/model-apps/app-builder/evals.json`:

```json
{
  "skill_name": "app-builder",
  "eval_instructions": "Offline, deterministic structural evals for /app-builder. See EVAL_GUIDE.md. Each eval's fixture is an App Spec (app-spec.json); the runner computes per-stage facts (author/plan/data/ui/app/verify/page) from the plugin's pure primitives and grades them against the common_stage_assertions + per-eval expect block. No live env, no network.",
  "common_stage_assertions": [
    "author: validateAppSpec(plan profile) passes with no errors",
    "author: spec-lint reports no errors",
    "plan: every planned item targets a known engine phase",
    "data: schema-facts provision exactly the expected tables",
    "data: schema-facts provision exactly the expected relationships",
    "ui: wire-facts build exactly the expected views and charts",
    "app: every sitemap subarea resolves to a concrete target (no dangling entity/page/dashboard)",
    "app: every navigatesTo target resolves to a known page key",
    "verify: reconcile against an all-present reader returns ok with no missing",
    "generate-pages: no PAGEREF_ navigation target is left unresolved"
  ],
  "evals": [
    {
      "id": 1, "tier": "smoke", "spec": "app-spec.json",
      "prompt": "Support desk: customers, tickets, and comments.",
      "expect": {
        "tables": ["new_customer", "new_ticket", "new_comment"],
        "relationships": ["new_customer_new_ticket", "new_ticket_new_comment"],
        "views": ["Active Customers", "Active Tickets", "Active Comments"],
        "charts": ["Tickets by Priority", "Tickets by Status"]
      },
      "expectations": []
    },
    {
      "id": 2, "tier": "full", "spec": "app-spec.json",
      "prompt": "Orders app with an overview page that navigates to an order-detail page.",
      "expect": {
        "tables": ["new_customer", "new_order"],
        "relationships": ["new_customer_new_order"],
        "views": ["Active Orders"],
        "charts": ["Orders by Status"],
        "pages": ["overview", "order-detail"]
      },
      "expectations": []
    }
  ]
}
```

- [ ] **Step 3: Write `lib/fixture-loader.js`**

```javascript
'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Load each fixture subdir (named "<eval-id>-<slug>"); its app-spec.json is the graded input. Mirrors
// evals/model-apps/genpage/lib/fixture-loader.js, but the app-builder input is the App Spec (not .tsx).
function loadFixtures(fixturesDir) {
  if (!fs.existsSync(fixturesDir)) throw new Error(`Fixtures directory does not exist: ${fixturesDir}`);
  const entries = fs.readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const fixtures = [];
  for (const entry of entries) {
    const m = entry.name.match(/^(\d+)(?:-(.+))?$/);
    if (!m) continue;
    const dir = path.join(fixturesDir, entry.name);
    const specPath = path.join(dir, 'app-spec.json');
    if (!fs.existsSync(specPath)) continue;
    fixtures.push({ id: parseInt(m[1], 10), dirName: entry.name, dir, spec: JSON.parse(fs.readFileSync(specPath, 'utf8')) });
  }
  return fixtures;
}
module.exports = { loadFixtures };
```

- [ ] **Step 4: Write `lib/facts.js` (per-stage fact computation)**

```javascript
'use strict';
const path = require('node:path');
// Reach the plugin's pure primitives (4 levels up from evals/model-apps/app-builder/lib → repo root,
// same depth genpage/lib uses to reach references/verified-icons.txt).
function pluginLib(name) { return require(path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'scripts', 'lib', name)); }

const { migrateAppSpec, validateAppSpec } = pluginLib('app-spec.js');
const { lintAppSpec } = pluginLib('spec-lint.js');
const { planFor, PHASES, appDef, viewDef, chartDef, compileFormIntent, formFieldLogicals } = pluginLib('sdk-build.js');
const { schemaFacts } = pluginLib('schema-facts.js');
const { verifySpec } = pluginLib('verify-spec.js');

// Plan 3's pure PAGEREF_ resolver may not be landed yet — load it optionally so the page oracle degrades
// to a SKIP instead of crashing the harness (design §13.2 page row; deliberate Plan-3 loose coupling).
let pagerefResolver = null;
try { pagerefResolver = pluginLib('pageref-resolver.js'); } catch { pagerefResolver = null; }

const lc = (s) => String(s || '').toLowerCase();

// author: design-profile validation + lint. The harness runs in autopilot/design mode — pages are
// intents, so 'plan' is the right profile (design §7.1).
function authorFacts(spec) {
  return { validate: validateAppSpec(spec, { profile: 'plan' }), lint: lintAppSpec(spec) };
}

// plan: the deterministic phase-grouped plan (planFor is pure for a fixed spec/opts — design §13.2).
function planFacts(spec) {
  const items = planFor(spec, { phases: PHASES, sampleData: true, publish: true });
  const byPhase = {};
  for (const it of items) byPhase[it.phase] = (byPhase[it.phase] || 0) + 1;
  return { byPhase, phases: Object.keys(byPhase), labels: items.map((i) => `${i.phase}\t${i.label}`) };
}

// ui: normalized view/chart/form facts from the pure def builders — the pre-serialization equivalents
// of wire-facts.js (viewFacts/chartFacts/formFacts), deterministic with no live env or bundle round-trip.
function wireFacts(spec) {
  return {
    views: (spec.views || []).map((v) => { const d = viewDef(spec, v); return { entity: d.entityLogicalName, name: d.name, columns: d.columns.map((c) => c.name) }; }),
    charts: (spec.charts || []).map((c) => { const d = chartDef(spec, c); return { entity: d.entityLogicalName, name: d.name, measure: d.series[0].aggregate, groupBy: d.categories[0].attribute }; }),
    forms: (spec.forms || []).map((f) => { const intent = compileFormIntent(spec, f, {}); return { entity: intent.entityLogicalName, name: intent.name, fields: formFieldLogicals(intent) }; }),
  };
}

// app: sitemap subarea target facts + navigation-graph validity. appDef resolves page/dashboard
// subareas from a result map; synthesize deterministic ids offline (no build) so the shape is stable.
function appFacts(spec) {
  const result = { forms: {}, views: {}, charts: {}, dashboards: {}, pages: {} };
  for (const d of spec.dashboards || []) result.dashboards[d.name] = `dash-${d.name}`;
  for (const p of spec.pages || []) result.pages[p.key || p.name] = `gp-${p.key || p.name}`;
  const def = appDef(spec, result);
  const areas = (def.siteMap.areas || []).map((a) => ({
    groups: (a.groups || []).map((g) => ({ subAreas: (g.subAreas || []).map((s) => ({ type: s.type, ref: s.entity || s.genPageId || s.dashboardId || s.url || null })) })),
  }));
  const keys = new Set((spec.pages || []).map((p) => p.key || p.name));
  const danglingNav = [];
  for (const p of spec.pages || []) for (const nav of p.navigatesTo || []) if (!keys.has(nav.targetKey)) danglingNav.push(`${p.key || p.name}→${nav.targetKey}`);
  return { areas, danglingNav };
}

// A synthesized reader that reports every artifact the spec declares as present, so verifySpec's
// reconcile (verify-spec.js:9-68) returns ok:true offline — proving the spec is internally verifiable.
// Superset reader: also emits GenPage sitemap subareas + best-effort pages()/pageCode() so Plan 3's
// extended page checks pass where landed. If Plan 3's verifySpec calls a reader method not provided
// here, verifyFacts catches the throw and the assertion SKIPs (loose Plan-3 coupling).
function makeAllPresentReader(spec) {
  const entities = new Set((spec.entities || []).map((e) => lc(e.schemaName)));
  const columnsByEntity = {};
  for (const e of spec.entities || []) columnsByEntity[lc(e.schemaName)] = (e.columns || []).map((c) => ({ logicalName: lc(c.schemaName) }));
  const tags = [];
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    if (a.icon) tags.push(`<Area Icon="${lc(a.icon)}"/>`);
    for (const g of a.groups || []) for (const sa of g.subAreas || []) {
      const attrs = [];
      if (sa.entity) attrs.push(`Entity="${lc(sa.entity)}"`);
      if (sa.page) attrs.push(`Type="GenPage" GenPageId="gp-${sa.page}"`);
      if (sa.icon) attrs.push(`Icon="${lc(sa.icon)}"`);
      tags.push(`<SubArea ${attrs.join(' ')}/>`);
    }
  }
  const xml = `<SiteMap>${tags.join('')}</SiteMap>`;
  return {
    findTable: async (logical) => (entities.has(logical) ? { logicalName: logical } : null),
    findColumns: async (logical) => columnsByEntity[logical] || [],
    queryRecords: async () => [{ savedqueryid: 'x', savedqueryvisualizationid: 'x', formid: 'x' }],
    sitemapXml: async () => xml,
    // Best-effort page reader surface for Plan 3's extended verifySpec (aligned to whatever it calls).
    pages: async () => ({ ok: true, pages: (spec.pages || []).map((p) => ({ name: p.name, GenPageId: `gp-${p.key || p.name}` })) }),
    pageCode: async () => '', // resolved deployment source — no PAGEREF_ left
  };
}

async function verifyFacts(spec) {
  try { return await verifySpec(spec, makeAllPresentReader(spec)); }
  catch (e) { return { skipped: e.message }; }
}

// page: PAGEREF_ resolution facts (Plan 3). Null when pageref-resolver isn't landed → the assertion
// layer emits SKIP. When present, resolve each declared nav edge against the synthesized key→id map.
function pageFacts(spec) {
  if (!pagerefResolver) return null;
  const keyToId = new Map((spec.pages || []).map((p) => [p.key || p.name, `gp-${p.key || p.name}`]));
  const sources = new Map();
  for (const p of spec.pages || []) for (const nav of p.navigatesTo || []) sources.set(`${p.key}:${nav.targetKey}`, { code: `"PAGEREF_${nav.targetKey}"` });
  const { unresolved } = pagerefResolver.resolvePageRefs(sources, keyToId);
  return { unresolved };
}

async function stageFacts(rawSpec) {
  const spec = migrateAppSpec(rawSpec);
  return {
    author: authorFacts(spec), plan: planFacts(spec), data: schemaFacts(spec),
    ui: wireFacts(spec), app: appFacts(spec), verify: await verifyFacts(spec), page: pageFacts(spec), PHASES,
  };
}

module.exports = { stageFacts, makeAllPresentReader };
```

- [ ] **Step 5: Write `lib/assertions.js` (the check registry)**

```javascript
'use strict';
// Maps each assertion text in evals.json to a check function receiving { facts, spec, eval } and
// returning { status: 'pass'|'fail'|'skip', reason? }. Mirrors evals/model-apps/genpage/lib/assertions-*.js.
const PASS = { status: 'pass' };
const fail = (reason) => ({ status: 'fail', reason });
const skip = (reason) => ({ status: 'skip', reason });
const sortedLc = (a) => (a || []).map((s) => String(s).toLowerCase()).sort();
const sorted = (a) => (a || []).map(String).sort();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ASSERTIONS = new Map();

ASSERTIONS.set('author: validateAppSpec(plan profile) passes with no errors', ({ facts }) =>
  facts.author.validate.ok ? PASS : fail(`validate errors: ${facts.author.validate.errors.join('; ')}`));

ASSERTIONS.set('author: spec-lint reports no errors', ({ facts }) =>
  facts.author.lint.errors.length === 0 ? PASS : fail(`lint errors: ${facts.author.lint.errors.join('; ')}`));

ASSERTIONS.set('plan: every planned item targets a known engine phase', ({ facts }) => {
  const known = new Set(facts.PHASES);
  const bad = facts.plan.phases.filter((p) => !known.has(p));
  return bad.length ? fail(`unknown phases in plan: ${bad.join(', ')}`) : PASS;
});

ASSERTIONS.set('data: schema-facts provision exactly the expected tables', ({ facts, eval: ev }) => {
  const expected = sortedLc(ev.expect && ev.expect.tables);
  const actual = facts.data.tables.map((t) => t.logicalName).sort();
  return eq(expected, actual) ? PASS : fail(`tables: expected [${expected}] got [${actual}]`);
});

ASSERTIONS.set('data: schema-facts provision exactly the expected relationships', ({ facts, eval: ev }) => {
  const expected = sortedLc(ev.expect && ev.expect.relationships);
  const actual = facts.data.relationships.map((r) => r.schemaName).sort();
  return eq(expected, actual) ? PASS : fail(`relationships: expected [${expected}] got [${actual}]`);
});

ASSERTIONS.set('ui: wire-facts build exactly the expected views and charts', ({ facts, eval: ev }) => {
  const evV = sorted(ev.expect && ev.expect.views), acV = sorted(facts.ui.views.map((v) => v.name));
  if (!eq(evV, acV)) return fail(`views: expected [${evV}] got [${acV}]`);
  const evC = sorted(ev.expect && ev.expect.charts), acC = sorted(facts.ui.charts.map((c) => c.name));
  if (!eq(evC, acC)) return fail(`charts: expected [${evC}] got [${acC}]`);
  return PASS;
});

ASSERTIONS.set('app: every sitemap subarea resolves to a concrete target (no dangling entity/page/dashboard)', ({ facts }) => {
  let bad = 0;
  for (const a of facts.app.areas) for (const g of a.groups) for (const s of g.subAreas) if (!s.ref) bad += 1;
  return bad ? fail(`${bad} subarea(s) with no resolved target`) : PASS;
});

ASSERTIONS.set('app: every navigatesTo target resolves to a known page key', ({ facts }) =>
  facts.app.danglingNav.length ? fail(`dangling nav: ${facts.app.danglingNav.join(', ')}`) : PASS);

ASSERTIONS.set('verify: reconcile against an all-present reader returns ok with no missing', ({ facts }) => {
  if (facts.verify.skipped) return skip(`verifySpec needs a reader method not synthesized here (Plan 3): ${facts.verify.skipped}`);
  return facts.verify.ok ? PASS : fail(`verify missing: ${facts.verify.missing.map((m) => `${m.kind} ${m.name}`).join(', ')}`);
});

ASSERTIONS.set('generate-pages: no PAGEREF_ navigation target is left unresolved', ({ facts }) => {
  if (facts.page === null) return skip('pageref-resolver.js not landed (Plan 3)');
  return facts.page.unresolved.length ? fail(`unresolved PAGEREF_: ${facts.page.unresolved.join(', ')}`) : PASS;
});

module.exports = { ASSERTIONS };
```

- [ ] **Step 6: Write `run-app-builder.js` (TAP runner)**

```javascript
#!/usr/bin/env node
'use strict';
// app-builder OFFLINE eval runner — grades each fixture's App Spec against per-stage STRUCTURAL facts
// (author/plan/data/ui/app/verify/page) via the assertion registry + per-eval expectations in evals.json.
// Deterministic + offline: plugin pure primitives only — no Anthropic API, no Dataverse, no live env.
// Mirrors evals/model-apps/genpage/run-layer-*.js. See EVAL_GUIDE.md.
//
// Usage: node run-app-builder.js [--fixtures <dir>] [--eval <id>] [--tier <smoke|full>]
// Exit:  0 all pass · 1 an assertion failed · 2 runner error.
const path = require('node:path');
const fs = require('node:fs');
const { loadFixtures } = require('./lib/fixture-loader.js');
const { TapReporter } = require('../genpage/lib/reporter.js');
const { stageFacts } = require('./lib/facts.js');
const { ASSERTIONS } = require('./lib/assertions.js');

function parseArgs(argv) {
  const args = { fixtures: null, eval: null, tier: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixtures') args.fixtures = argv[++i];
    else if (a === '--eval') args.eval = parseInt(argv[++i], 10);
    else if (a === '--tier') args.tier = argv[++i];
    else if (a === '--help' || a === '-h') { process.stdout.write('Usage: run-app-builder.js [--fixtures <dir>] [--eval <id>] [--tier <smoke|full>]\n'); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

function loadEvals() { return JSON.parse(fs.readFileSync(path.join(__dirname, 'evals.json'), 'utf8')); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args.fixtures ? path.resolve(args.fixtures) : path.join(__dirname, 'fixtures');
  let fixtures, evalsData;
  try { fixtures = loadFixtures(fixturesDir); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  try { evalsData = loadEvals(); } catch (e) { console.error(`error: failed to load evals.json: ${e.message}`); process.exit(2); }
  const evalById = new Map(evalsData.evals.map((e) => [e.id, e]));

  let selected = fixtures;
  if (args.eval !== null) selected = selected.filter((f) => f.id === args.eval);
  if (args.tier) selected = selected.filter((f) => { const ev = evalById.get(f.id); return ev && ev.tier === args.tier; });
  if (!selected.length) { console.error('error: no fixtures matched the filter'); process.exit(2); }

  const reporter = new TapReporter();
  reporter.start(selected.length);
  for (const fix of selected) {
    reporter.startFixture(fix.dirName);
    const ev = evalById.get(fix.id);
    if (!ev) { reporter.assertion(`fixture references eval id ${fix.id}`, { status: 'fail', reason: `no eval id ${fix.id} in evals.json` }); reporter.endFixture(); continue; }
    let facts;
    try { facts = await stageFacts(fix.spec); }
    catch (e) { reporter.assertion('stage facts computed without error', { status: 'fail', reason: e.message }); reporter.endFixture(); continue; }
    const texts = [...evalsData.common_stage_assertions, ...(ev.expectations || [])];
    for (const text of texts) {
      const check = ASSERTIONS.get(text);
      reporter.assertion(text, check ? check({ facts, spec: fix.spec, eval: ev }) : { status: 'skip', reason: 'no check registered for this assertion text' });
    }
    reporter.endFixture();
  }
  reporter.end();
  process.exit(reporter.exitCode);
}

if (require.main === module) main();
module.exports = { main, parseArgs };
```

- [ ] **Step 7: Write `tests/facts.test.js`**

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { stageFacts } = require('../lib/facts.js');

const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  app: { name: 'T', description: '' },
  entities: [{ schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['New', 'Done'] }] }],
  views: [{ entity: 'new_order', name: 'Active Orders', columns: ['new_name', 'new_status'], activeOnly: true }],
  charts: [{ entity: 'new_order', name: 'Orders by Status', groupBy: 'new_status', measure: 'count', chartType: 'Pie' }],
  forms: [{ entity: 'new_order', type: 'main', name: 'Order', layout: 'auto' }],
  pages: [{ key: 'overview', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'overview' }] }],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_order', title: 'Orders' }, { page: 'overview', title: 'Overview' }] }] }] },
};

test('stageFacts.author validates under the plan profile and lints clean', async () => {
  const f = await stageFacts(spec);
  assert.strictEqual(f.author.validate.ok, true, JSON.stringify(f.author.validate.errors));
  assert.strictEqual(f.author.lint.errors.length, 0, JSON.stringify(f.author.lint.errors));
});

test('stageFacts.data/ui expose normalized structural facts', async () => {
  const f = await stageFacts(spec);
  assert.deepStrictEqual(f.data.tables.map((t) => t.logicalName), ['new_order']);
  assert.deepStrictEqual(f.ui.views.map((v) => v.name), ['Active Orders']);
  assert.deepStrictEqual(f.ui.charts.map((c) => c.name), ['Orders by Status']);
  assert.ok(f.ui.forms[0].fields.includes('new_name')); // primary field placed
});

test('stageFacts.app resolves every sitemap subarea and reports no dangling nav', async () => {
  const f = await stageFacts(spec);
  const refs = f.app.areas.flatMap((a) => a.groups.flatMap((g) => g.subAreas.map((s) => s.ref)));
  assert.ok(refs.every((r) => r)); // entity + resolved GenPageId
  assert.deepStrictEqual(f.app.danglingNav, []); // overview→overview resolves
});

test('stageFacts.plan groups items by known engine phase; verify runs offline', async () => {
  const f = await stageFacts(spec);
  assert.ok(f.plan.phases.every((p) => f.PHASES.includes(p)));
  assert.ok(f.verify.ok === true || typeof f.verify.skipped === 'string');
});
```

- [ ] **Step 8: Write `tests/run-app-builder.test.js`**

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, '..', 'run-app-builder.js');
function run(args) { const r = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }

test('runner: real fixtures all pass and emit TAP v13', () => {
  const { code, stdout } = run([]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^TAP version 13/m);
  assert.match(stdout, /# Subtest: 1-support-desk/);
  assert.match(stdout, /# Subtest: 2-orders-multipage/);
  assert.match(stdout, /# fixtures 2 \(pass 2, fail 0\)/);
});

test('runner: --eval selects one fixture; --tier smoke filters', () => {
  const one = run(['--eval', '1']);
  assert.equal(one.code, 0);
  assert.match(one.stdout, /1\.\.1/);
  const smoke = run(['--tier', 'smoke']);
  assert.equal(smoke.code, 0);
  assert.match(smoke.stdout, /# Subtest: 1-support-desk/);
  assert.doesNotMatch(smoke.stdout, /# Subtest: 2-orders-multipage/);
});

test('runner: a fixture whose data model contradicts the eval expect fails (exit 1)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-eval-'));
  try {
    const dir = path.join(root, '1-broken');
    fs.mkdirSync(dir, { recursive: true });
    // eval id 1 expects tables new_customer/new_ticket/new_comment — provide only one so the
    // "expected tables" assertion fails.
    fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify({
      solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'X' },
      entities: [{ schemaName: 'new_customer', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
      appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_customer', title: 'C' }] }] }] },
    }));
    const { code, stdout } = run(['--fixtures', root, '--eval', '1']);
    assert.equal(code, 1);
    assert.match(stdout, /not ok \d+ - data: schema-facts provision exactly the expected tables/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runner: exits 2 when the fixtures dir is missing', () => {
  const { code, stderr } = run(['--fixtures', path.join(os.tmpdir(), 'does-not-exist-xyz')]);
  assert.equal(code, 2);
  assert.match(stderr, /Fixtures directory does not exist/);
});
```

- [ ] **Step 9: Write `EVAL_GUIDE.md`**

Author `evals/model-apps/app-builder/EVAL_GUIDE.md` (companion to `genpage/EVAL_GUIDE.md`) covering: **what we evaluate** (per-stage *structural* facts, never `.tsx` snapshots — design §13.2); **the stage→oracle table** (author→validate+lint · plan→`planFor` · data→`schemaFacts` · ui→`viewDef`/`chartDef`/`compileFormIntent` facts · app→`appDef` sitemap facts + nav graph · verify→`verifySpec` reconcile · generate-pages→`pageref-resolver` when landed); **fixtures** (an `app-spec.json` per case; naming `<id>-<slug>/`); **evals.json** (`common_stage_assertions` + per-eval `expect`); **running** (`node evals/model-apps/app-builder/run-app-builder.js [--eval|--tier]`, from the repo root); **TAP output**; **adding an eval/assertion** (add a fixture spec + an `expect` block; register any new assertion text in `lib/assertions.js`); and **the live tier** (`plugins/model-apps/scripts/smoke-eval.js` stays the thin live smoke; a multi-page live case is a follow-up). Cross-link the plugin `AGENTS.md` → *Eval Suite* and `docs/app-builder-staged-flow-design.md` §13.

- [ ] **Step 10: Run the harness + its tests**

From the repo root:
```bash
node evals/model-apps/app-builder/run-app-builder.js                 # → TAP, exit 0
node --test evals/model-apps/app-builder/tests/*.test.js             # → all pass
```
Also confirm the plugin suite is still green (Task 3 adds no plugin-suite files, but Task 1's `schema-facts.js` is a dependency): from the plugin root, `node scripts/run-tests.js` → PASS.

- [ ] **Step 11: Commit**

```bash
git add evals/model-apps/app-builder
git commit -m "test(model-apps): offline structural eval harness for /app-builder staged flow" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 4: Author-redesign docs — design-only author (doc-only)

> **Doc-only** (no tests). Precisely rewrite the author flow so it emits a **design-only** spec: page `.tsx` is **not** authored during Phase 1 — pages are declared as **intents** and their code is generated in a distinct **generate-pages** step **after** plan approval and **after** tables are deployed. Document the **two design consent levels**, the generate-pages step, `preview-app.js`, and the `--stage`/`--allow-destructive`/`--non-interactive` flags. Source of truth: design **§7** (author redesign), **§5**/**§8** (execution model + generate-pages). Keep `SKILL.md` **under 500 lines**.

**Files:**
- Modify: `skills/app-builder/SKILL.md`
- Modify: `references/authoring-flow.md`

- [ ] **Step 1: `SKILL.md` — frontmatter**
  - Bump `version: 0.6.0` → `0.7.0`.
  - Add **`Task`** to `allowed-tools` (line 8) so the main loop can dispatch the **headless** `page-builder` worker in generate-pages (design §8; the interactive author never runs in a subagent). New list: `Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate, TaskList`.
  - Update the `description` clause "author its `.tsx` `codeFile`" wording to reflect design-only authoring (pages authored as intents; `.tsx` generated after approval).

- [ ] **Step 2: `SKILL.md` — Genpage-first policy (lines ~63-74)**
  Replace the bullet that says *"Each generative page needs a `codeFile` … You author that page code here, at the skill layer, before the build — a page always resolves to a concrete `codeFile`."* with a **design-only** statement:
  - A generative page is authored as a **design intent** (`source: { kind: "intent" }`, schemaVersion 2) during Phase 1 — its `.tsx` is **not** written yet.
  - The page's `.tsx` `codeFile` is produced in the **generate-pages** step (new Phase 1.5), **after** plan approval and **after** the data pre-build (`--stage data --apply`) creates the tables so `generate-types` can emit `RuntimeTypes.ts`. Cross-link design §5/§8 and `references/authoring-flow.md` → *Pages*.
  - Keep the SDK-single-sitemap-writer bullet; note a page's nav entry still comes from an `appShell` `page` subarea referenced by **`key`**.

- [ ] **Step 3: `SKILL.md` — Phase 1 (lines ~83-119): the two design consent levels**
  Reframe Step 4 as **design-only, two confirmed levels** (design §7):
  - **Level (a) — data model**: propose entities/columns/relationships → `AskUserQuestion` confirm → early data-model lint (unchanged).
  - **Level (b) — artifacts + page-intents + design**: propose forms/views/charts + sample data **and** page **intents** (key/name/purpose/dataSources/navigatesTo/pageInput, `source: { kind: "intent" }`) + the optional `design` contract → `AskUserQuestion` confirm. **Do not author page `.tsx` here.**
  - Replace the "**Show the form wireframe** … `preview-form.js`" line to **also** offer the whole-app preview: `node "${PLUGIN_ROOT}/scripts/preview-app.js" --spec @<working-dir>/app-spec.json` (data-model + sitemap + views/charts + form wireframes + **page-intents** + design contract — the design gate #2 artifact, design §12). Keep `preview-form.js` for a single form.
  - Step 6 (plan-mode) unchanged as the **single build approval**, but note the dry-run plan now uses the `plan` validation profile (intent pages allowed).

- [ ] **Step 4: `SKILL.md` — new "Phase 1.5 — Generate pages (main loop)" between Phase 1 and Phase 2**
  Add a section (design §5/§8) describing, after plan-mode approval:
  1. **Data pre-build** — `node "${PLUGIN_ROOT}/scripts/build-model-app.js" --env <envUrl> --spec @<working-dir>/app-spec.json --stage data --apply` (solution + data-model only; **no `--sample-data`** — rows are created once in the full build). Only `--stage data` is apply-safe.
  2. **Types** — `pac model genpage generate-types` → `RuntimeTypes.ts`.
  3. **Generate** — for each `source.kind === "intent"` page, dispatch the **headless** `page-builder` worker (via `Task`) with the page intent + `RuntimeTypes.ts` + the `design` contract + the navigation graph (`PAGEREF_<key>` for cross-page links). **Validate** each page (compile/structure + verified columns + navigation), then flip `source` `intent → { kind: "tsx", codeFile }` (all-or-nothing).
  4. Proceed to Phase 2 (the **full** idempotent build), which now validates under the `deploy` profile (every page implemented) and **fails fast** if any page is still intent.

- [ ] **Step 5: `SKILL.md` — Phase 2 + safety flags (lines ~143-205)**
  - In the phase-selector paragraph, add **`--stage <data|ui|app|publish>`** as the stage-level selector (sugar over `--from/--to`), noting **only `--stage data` is apply-safe**; other stages are dry-run-only (their phase ranges aren't dependency-closed — design §14).
  - The safety-flags block already documents `--allow-destructive` / `--non-interactive` / `POWER_PLATFORM_SKILLS_NONINTERACTIVE` (Plan 2) — leave intact; add a one-line note that autopilot/eval mode is **non-interactive + fail-closed** (design §11) and that `preview-app.js` is the design artifact written to disk in that mode.

- [ ] **Step 6: `SKILL.md` — "What the builder does (in order)" + Notes/limits (lines ~281-324)**
  - Update any "pages are authored before the build" phrasing to the design-only model.
  - Confirm the total file stays **< 500 lines** (`(Get-Content skills/app-builder/SKILL.md).Count`); trim redundancy if needed.

- [ ] **Step 7: `references/authoring-flow.md` — Step 4 framing (lines ~236-252)**
  State explicitly that Phase 1 is a **design-only author** with **two confirmed design levels** (data model, then artifacts + page-intents + design), and that **the author never emits `.tsx`** — page code is generated later (cross-link `SKILL.md` → Phase 1.5). Reiterate "do not pre-create tables/columns".

- [ ] **Step 8: `references/authoring-flow.md` — Level (b): add a "#### Pages (generative page intents — design only)" subsection**
  After the Charts / Sample data subsections (before *App shell*), add a subsection that authors page **intents** (not `.tsx`):
  - Shape: `{ "key", "name", "purpose", "dataSources": [...], "navigatesTo": [{ "targetKey", "data": {…} }], "pageInput": { "data": {…} }, "source": { "kind": "intent" } }` — cross-link `references/app-spec-schema.md` → `pages[]` + `design`.
  - **Classification** (genpage-first): overview/dashboard/analytics/landing → a page **intent**; record CRUD → a form/view. Reference each page from `appShell` by **`key`**.
  - The optional `design` contract (accent/density/cornerRadius/darkMode/layout) threads to every page for a consistent look.
  - Note: the page's `.tsx` is generated in the generate-pages step; do **not** write `codeFile` here.

- [ ] **Step 9: `references/authoring-flow.md` — generate-pages + Critical Constraints (lines ~455-666)**
  - Add a short "generate-pages happens after approval + data pre-build" note (or a new Step 6.5) cross-linking `SKILL.md` → Phase 1.5, so the playbook and the skill agree.
  - In *Critical Constraints (Phase 1 — authoring only)*, add: **the author is design-only — it never writes page `.tsx`; pages stay `source: { kind: "intent" }` until generate-pages**; and **only `--stage data` is apply-safe during the data pre-build**.

- [ ] **Step 10: Sanity-check the docs (no automated test)**
  - Verify links resolve and the `preview-app.js`/`--stage` examples are copy-pasteable.
  - `(Get-Content skills/app-builder/SKILL.md).Count` **< 500**.

- [ ] **Step 11: Commit**

```bash
git add skills/app-builder/SKILL.md references/authoring-flow.md
git commit -m "docs(model-apps): design-only author — page intents, generate-pages step, --stage" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 5: Doc-sync — architecture, AGENTS, CHANGELOG, schema (doc-only)

> **Doc-only** (no tests). Reflect the staged flow, the new scripts/modules, the eval harness, and the safety flags across the four canonical docs. Source of truth: design **§16** (doc-sync checklist), **§5-§6** (execution model + stages). Keep each doc's existing structure; **cross-link, don't duplicate** (per the plugin `AGENTS.md` Documentation Map rule).

**Files:**
- Modify: `docs/architecture.md`, `AGENTS.md`, `CHANGELOG.md`, `references/app-spec-schema.md`

- [ ] **Step 1: `docs/architecture.md` — the `/app-builder` build pipeline (lines ~134-177)**
  Update the ASCII pipeline to show the **staged flow** over the unchanged 13 phases (design §5-§6):
  - Phase 1 authoring is **design-only** (2 confirmed levels: data model, then artifacts + **page-intents** + design) → plan-mode approval.
  - **Data pre-build** (`build --stage data --apply` — solution + data-model only) → **generate-pages** (main loop: `generate-types` + headless `page-builder` workers fill each intent page's `.tsx`, `PAGEREF_<key>` for cross-page nav) → **full idempotent build** (`build --apply --verify` — ui · app [incl. page upload + `PAGEREF_` resolve + sitemap finalize] · publish · verify).
  - Add a compact **stage → engine-phase** legend (`data` = solution·data-model·sample-data; `ui` = web-resources…dashboards; `app` = app-shell·pages·ai-features; `publish`; plus the main-loop stages `author`/`generate-pages`/`verify`).
  - Add one line on **safety** (destructive ops fail-closed without `--allow-destructive`; `--non-interactive`/autopilot suppress prompts only) and the durable `<app>_pagemanifest` (Plan 3) carrying page semantics across download/rebuild.

- [ ] **Step 2: `docs/architecture.md` — Eval suite (lines ~179-195)**
  Add a short subsection documenting the **offline `/app-builder` structural eval harness** at `evals/model-apps/app-builder/` (alongside the genpage 3-layer suite): per-stage structural oracles (`author/plan/data/ui/app/verify`), a TAP runner, run from the repo root — `node evals/model-apps/app-builder/run-app-builder.js`. Cross-link `evals/model-apps/app-builder/EVAL_GUIDE.md`.

- [ ] **Step 3: `AGENTS.md` — component specs + file tree**
  - **Scripts list + File Tree:** add `preview-app.js` (whole-app design preview, next to `preview-form.js`), and under `lib/`: `schema-facts.js` (data-model provisioning fact extractor for evals), `app-preview.js` (whole-app wireframe renderer). Keep the tree accurate; also confirm `stages.js`/`op-diff.js` (Plans 1-2) and Plan 3's `pageref-resolver.js`/`page-manifest.js` are listed (add if the earlier plans' doc-sync didn't).
  - **`build-model-app.js` bullet:** note `--stage <data|ui|app|publish>` (apply-safe only for `data`) and the design-only author → data pre-build → generate-pages → full build sequence; keep the phase list unchanged (13 phases).
  - **`preview-form.js` bullet:** add a sibling sentence for `preview-app.js` (renders the *whole* app design — data model + sitemap + views/charts + form wireframes + page-intents + design contract — as the design gate #2 / plan-mode approval artifact).
  - **Eval Suite section:** add the app-builder offline harness (`evals/model-apps/app-builder/` — `evals.json` + fixtures + `run-app-builder.js` + `EVAL_GUIDE.md`; `node evals/model-apps/app-builder/run-app-builder.js` from the repo root) beside the genpage suite. Note it grades **structural per-stage facts**, not `.tsx` snapshots.

- [ ] **Step 4: `CHANGELOG.md` — add entries under the current unreleased/preview section**
  Concise Keep-a-Changelog bullets (detail lives in this plan + design doc):
  - `Added` — `schema-facts.js` (normalized data-model provisioning facts); `preview-app.js` (whole-app design preview); the offline `/app-builder` structural eval harness (`evals/model-apps/app-builder/`).
  - `Added`/`Changed` — staged-flow authoring: **design-only author** (page intents), a **generate-pages** step after plan approval, and the `--stage <data|ui|app|publish>` selector (apply-safe for `data`).
  - `Changed` — doc-sync across `SKILL.md`, `authoring-flow.md`, `architecture.md`, `AGENTS.md`, `app-spec-schema.md` for the staged flow + safety flags.
  (If Plans 1-3 already added related bullets, extend that section rather than duplicating.)

- [ ] **Step 5: `references/app-spec-schema.md` — cross-links (light; the `pages[]`/`design`/`appShell` shapes already landed in Plans 1/3)**
  - Near the top (after the intro), add a one-line pointer to `preview-app.js` as the way to **review the whole spec** (data model + sitemap + forms + page-intents + design) during authoring, beside the existing `preview-form.js` mention if present.
  - Under `## design` (lines ~317-323), add a sentence that the design contract is threaded to every generated page in **generate-pages** (Fluent UI V9 token alignment; design §10) and previewed via `preview-app.js`.
  - Under `## pages[]` (lines ~273-293), confirm the note that the **author emits `source: { kind: "intent" }`** and **generate-pages** fills `{ kind: "tsx", codeFile }` (already present — verify wording matches the Phase 1.5 language in `SKILL.md`).

- [ ] **Step 6: Verify links + rendering (no automated test)**
  Confirm the four docs render, cross-links resolve, and the stage diagram is consistent with the design doc §6 stage table.

- [ ] **Step 7: Commit**

```bash
git add docs/architecture.md AGENTS.md CHANGELOG.md references/app-spec-schema.md
git commit -m "docs(model-apps): doc-sync — staged-flow stage diagram, evals, schema cross-links" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Self-Review (completed while writing)

**Spec coverage** (against design §12, §13.2, §7, §16):
- **§13.2 structural eval oracles** — Task 3 delivers the offline harness with the exact per-stage oracles from the design table: author (`validateAppSpec`+`lintAppSpec`), plan (`planFor`), data (**new `schema-facts.js`**, Task 1), ui (`viewDef`/`chartDef`/`compileFormIntent` facts — the pre-serialization equivalents of `wire-facts.js`), app (`appDef` sitemap facts + nav graph), verify (`verifySpec` reconcile). The generate-pages/`PAGEREF_` row is **loosely coupled** to Plan 3's `pageref-resolver.js` and degrades to `SKIP` when absent. `smoke-eval.js` is kept as the thin live tier (unchanged).
- **§13.2 `schema-facts` extractor** — Task 1: `schemaFacts(spec)` normalizes tables/columns/relationships/global-choices, reusing the engine's real derivation (`relationshipSchemaName`/`manyToManySchemaName`, `choiceValueMap` value = 100000000+i, `columnTypeMap`-based buildable filter). Data-model is the gap `wire-facts.js` does **not** cover (`wire-facts.js` = forms/views/charts/sitemap).
- **§12 whole-app preview** — Task 2: `preview-app.js`/`app-preview.js` renders data-model + sitemap tree + views/charts + per-form wireframes (**reusing `form-preview.js`**) + page-intents + design contract; pure, offline-testable.
- **§7 author redesign** — Task 4 (doc): design-only author, two consent levels, page-intents, generate-pages step, `--stage`/`--allow-destructive`/`--non-interactive`, `Task` in `allowed-tools`.
- **§16 doc-sync** — Task 5 (doc): `architecture.md` stage diagram, `AGENTS.md`, `CHANGELOG.md`, `app-spec-schema.md`; `SKILL.md`/`authoring-flow.md` covered in Task 4.
- **§C (mode-aware consent)** — landed in Plan 2's flags (`--allow-destructive`/`--non-interactive`/`op-diff.js`); Task 4/5 only **document** them (no code here), as scoped.

**Placeholder scan:** none — Tasks 1-3 have runnable RED test + full implementation + exact `node --test`/`node scripts/run-tests.js`/`node evals/…/run-app-builder.js` commands + commit steps; Tasks 4-5 are doc-only with precise, enumerated edits and a commit step (no test steps, matching how Plans 1-3 handle doc changes).

**Type consistency:** `schemaFacts(spec) → { globalChoices, tables, relationships }` and `isBuildableColumn(c)` are used identically in `schema-facts.js`, its unit test, and the harness `facts.js`. `renderAppPreview(spec) → string` is consistent across `app-preview.js`, `preview-app.js`, and its test. The harness `stageFacts(spec) → { author, plan, data, ui, app, verify, page, PHASES }` shape matches every `ASSERTIONS` check and both harness tests. `validateAppSpec(spec, { profile })`, `migrateAppSpec`, `planFor(spec, { phases, sampleData, publish })`, `viewDef`/`chartDef`/`compileFormIntent`/`formFieldLogicals`/`appDef`, and `verifySpec(spec, reader)` are consumed with the exact committed signatures (verified against `app-spec.js:252/703/733`, `sdk-build.js:240/316/396/486/1141`, `verify-spec.js:9/99`).

**Notes / uncertainties for the implementer:**
- **Baseline test count:** the plan states 570 (post-Plan 2) — **re-run `node scripts/run-tests.js` first** and keep whatever the current count is green; Plan 3 lands around this plan and adds tests. Tasks 1-2 add plugin-suite tests; Task 3's tests run separately (`node --test evals/model-apps/app-builder/tests/*.test.js`).
- **`wire-facts.js` reuse:** the harness `ui` oracle asserts the **pure `def`-builder** facts (equivalent to `wire-facts.js` output) rather than round-tripping XML through the vendored bundle — deterministic and offline. If a reviewer requires literal `wire-facts.js` XML parity, the offline capture technique in `scripts/tests/golden.test.js:37-60` / `hardening2-real-bundle.test.js:26-78` can be lifted into a `lib/build-capture.js` — noted, not required for v1.
- **Verify oracle Plan-3 coupling:** `makeAllPresentReader` best-effort-satisfies both the current `verifySpec` (`verify-spec.js`) and Plan 3's extended page checks; if Plan 3's `verifySpec` calls a reader method not synthesized, `verifyFacts` catches and the assertion **SKIPs** (align the reader with Plan 3's actual reader contract when landed).
- **Eval location:** the harness lives at the **repo root** `evals/model-apps/app-builder/` (sibling of `genpage/`), not under the plugin — mirror genpage's runner/loader/reporter shape (`evals/model-apps/genpage/run-layer-2.js`, `lib/fixture-loader.js`, `lib/reporter.js`), which this plan reuses (`TapReporter`) and copies (`fixture-loader`).


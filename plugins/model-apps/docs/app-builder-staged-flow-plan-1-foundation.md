# App-Builder Staged Flow — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the contract skeleton for the staged flow — App Spec `schemaVersion` + discriminated page `source` + validation profiles, stable page keys + navigation graph + page design contract, legacy-spec migration, and a `stages.js` stage layer with `--stage` and unknown-selector rejection — all offline-testable, with no change to the engine's Dataverse writes.

**Architecture:** Purely additive to the existing spec-driven engine. A new pure `stages.js` becomes the canonical home of `PHASES` and adds a `STAGES` map + helpers; `validateAppSpec` gains an `opts.profile` and a discriminated page-source model; a `migrateAppSpec` upgrades legacy specs on load. No engine phase is renamed and no build behavior changes — later plans (Safety, Pages, Evals/Author) build on this.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, run via `node scripts/run-tests.js`. Design source of truth: `plugins/model-apps/docs/app-builder-staged-flow-design.md` (§6 stages, §7 author/schema/profiles).

## Global Constraints

- All commands run from the plugin root: `D:\Projects\power-platform-skills-sdk\plugins\model-apps`.
- Tests use `node:test`: `const { test } = require('node:test'); const assert = require('node:assert');`. Full suite: `node scripts/run-tests.js` (currently **510** passing — keep it green). Single file: `node --test scripts/tests/<file>.test.js`.
- `validateAppSpec` returns `{ ok: boolean, errors: string[] }`; errors are pushed as human-readable strings.
- The **13 engine phase names and order are unchanged**: `solution, data-model, sample-data, web-resources, views, charts, forms, commands, dashboards, app-shell, pages, ai-features, publish`.
- **One namespace** for stage names: `data, ui, app, publish` (plus `generate-pages`/`verify` as orchestrator stages, not engine phase ranges — not introduced in this plan).
- New page shape is gated by `schemaVersion: 2`. Legacy specs (no `schemaVersion`, name-referenced pages, top-level `codeFile`) must keep working via migration.
- Default `validateAppSpec` profile is `deploy` (preserves today's "pages must be implemented" behavior for any caller that passes no profile).
- Commit trailers on every commit:
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89
  ```

---

## File Structure

- `scripts/lib/stages.js` **(new)** — canonical `PHASES`, the `STAGES` map, and pure phase/stage resolution helpers. No dependencies (leaf module).
- `scripts/lib/sdk-build.js` **(modify)** — import `PHASES` from `stages.js` (remove the local const); tighten `resolvePhases` to reject unknown phases.
- `scripts/build-model-app.js` **(modify)** — wire `--stage`, unknown-selector rejection, and the validation `profile` through `main()`.
- `scripts/lib/app-spec.js` **(modify)** — `validateAppSpec(spec, opts)` profiles; discriminated page `source`; stable `key`, `navigatesTo`, `pageInput`, `spec.design`; export `migrateAppSpec`.
- `scripts/teardown-model-app.js`, `scripts/verify-model-app.js` **(modify)** — pass an explicit profile; migrate on load.
- `references/app-spec-schema.md` **(modify)** — document the new page shape.
- `scripts/tests/stages.test.js`, `scripts/tests/app-spec-profiles.test.js`, `scripts/tests/app-spec-migrate.test.js` **(new)** — offline unit tests.

---

## Task 1: Stage layer (`stages.js`) + `--stage` + reject unknown selectors

**Files:**
- Create: `scripts/lib/stages.js`
- Create: `scripts/tests/stages.test.js`
- Modify: `scripts/lib/sdk-build.js:82` (PHASES const), `:192-199` (resolvePhases)
- Modify: `scripts/build-model-app.js:207-228` (main arg handling), `:213` (usage string)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `PHASES: string[]` — the 13 phases (moved here, canonical).
  - `STAGES: { data: string[], ui: string[], app: string[], publish: string[] }` — stage → contiguous engine-phase range.
  - `phasesForStage(stage: string): string[]` — throws `Error` on an unknown stage.
  - `stagePhasesOrResolve({ stage, only, skip, from, to }): string[]` — if `stage` is set, returns its phases (and throws if combined with `only/skip/from/to`); else delegates to `resolvePhases`. Throws on unknown stage/phase.
  - `sdk-build.js` continues to export `resolvePhases` (now throws on unknown phase).

- [ ] **Step 1: Write the failing test** — `scripts/tests/stages.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PHASES, STAGES, phasesForStage, stagePhasesOrResolve } = require(path.join(__dirname, '..', 'lib', 'stages.js'));
const { resolvePhases } = require(path.join(__dirname, '..', 'lib', 'sdk-build.js'));

test('PHASES is the canonical 13-phase ordered list', () => {
  assert.deepStrictEqual(PHASES, ['solution', 'data-model', 'sample-data', 'web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'publish']);
});

test('STAGES map groups contiguous phase ranges', () => {
  assert.deepStrictEqual(STAGES.data, ['solution', 'data-model', 'sample-data']);
  assert.deepStrictEqual(STAGES.ui, ['web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards']);
  assert.deepStrictEqual(STAGES.app, ['app-shell', 'pages', 'ai-features']);
  assert.deepStrictEqual(STAGES.publish, ['publish']);
  // Every stage phase is a real engine phase, and the four stages tile PHASES with no gaps/overlaps.
  assert.deepStrictEqual([...STAGES.data, ...STAGES.ui, ...STAGES.app, ...STAGES.publish], PHASES);
});

test('phasesForStage returns the range; unknown stage throws', () => {
  assert.deepStrictEqual(phasesForStage('data'), ['solution', 'data-model', 'sample-data']);
  assert.throws(() => phasesForStage('bogus'), /unknown stage 'bogus'/);
});

test('stagePhasesOrResolve: --stage wins; conflicting selectors throw', () => {
  assert.deepStrictEqual(stagePhasesOrResolve({ stage: 'data' }), ['solution', 'data-model', 'sample-data']);
  assert.throws(() => stagePhasesOrResolve({ stage: 'data', only: ['forms'] }), /--stage cannot be combined/);
});

test('stagePhasesOrResolve without --stage delegates to resolvePhases', () => {
  assert.deepStrictEqual(stagePhasesOrResolve({ from: 'forms' }), ['forms', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'publish']);
});

test('resolvePhases rejects an unknown phase instead of silently ignoring it', () => {
  assert.throws(() => resolvePhases({ from: 'bogus' }), /unknown phase\(s\): bogus/);
  assert.throws(() => resolvePhases({ only: ['forms', 'nope'] }), /unknown phase\(s\): nope/);
  // Known selectors still work.
  assert.deepStrictEqual(resolvePhases({ to: 'sample-data' }), ['solution', 'data-model', 'sample-data']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/stages.test.js`
Expected: FAIL — `Cannot find module '.../lib/stages.js'`.

- [ ] **Step 3: Create `scripts/lib/stages.js`**

```javascript
'use strict';

// Canonical ordered list of the engine's 13 build phases. This is the SINGLE source of truth —
// sdk-build.js imports it from here so the stage layer and the engine can never drift. Order is
// load-bearing: phases run top-to-bottom, and downstream phases depend on earlier ones (e.g. the
// app phase consumes forms/views/charts built earlier). See docs/app-builder-staged-flow-design.md §6.
const PHASES = ['solution', 'data-model', 'sample-data', 'web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'publish'];

// User-facing stages, each a contiguous range of engine phases. Stages are the vocabulary the
// orchestrator narrates, gates consent on, and evals assert against — they do NOT rename or merge
// phases. `data`, `ui`, `app`, `publish` tile PHASES exactly (no gaps/overlaps); the design-only
// `author`, the code-gen `generate-pages`, and `verify` are orchestrator stages with no phase range
// and are intentionally absent from this map. See the design doc §5–§6.
const STAGES = {
  data: ['solution', 'data-model', 'sample-data'],
  ui: ['web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards'],
  app: ['app-shell', 'pages', 'ai-features'],
  publish: ['publish'],
};

// Resolve a stage name to its engine-phase range. Throws (rather than silently returning nothing)
// so a typo'd `--stage` fails loudly instead of running an empty/surprising build.
function phasesForStage(stage) {
  if (!Object.prototype.hasOwnProperty.call(STAGES, stage)) {
    throw new Error(`unknown stage '${stage}' (valid: ${Object.keys(STAGES).join(', ')})`);
  }
  return STAGES[stage].slice();
}

// Single entry point for the CLI: `--stage` selects a whole stage range and is mutually exclusive
// with the fine-grained `--only/--skip/--from/--to` selectors (mixing them is ambiguous, so reject
// it). Without `--stage`, delegate to the engine's resolvePhases (which now rejects unknown phases).
function stagePhasesOrResolve({ stage, only, skip, from, to } = {}) {
  if (stage) {
    if (only || skip || from || to) {
      throw new Error('--stage cannot be combined with --only/--skip/--from/--to');
    }
    return phasesForStage(stage);
  }
  // Lazy require to avoid a load-order cycle (sdk-build.js requires this module for PHASES).
  const { resolvePhases } = require('./sdk-build.js');
  return resolvePhases({ only, skip, from, to });
}

module.exports = { PHASES, STAGES, phasesForStage, stagePhasesOrResolve };
```

- [ ] **Step 4: Modify `scripts/lib/sdk-build.js` — import `PHASES`, tighten `resolvePhases`**

Replace the local `PHASES` const (line 82) so the value lives in `stages.js`:

```javascript
// BEFORE (sdk-build.js:82):
// const PHASES = ['solution', 'data-model', 'sample-data', 'web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'publish'];

// AFTER — import the canonical list (add near the other requires at the top of the file, and delete
// the local const at line 82):
const { PHASES } = require('./stages.js');
```

Replace `resolvePhases` (lines 191-199) to reject unknown phases:

```javascript
/** Resolve --only/--skip/--from/--to into the ordered set of phases to run. Rejects unknown
 *  phase names (a typo previously ran a surprising/empty subset — from/to indexOf(-1) was a no-op). */
function resolvePhases({ only, skip, from, to } = {}) {
  const known = new Set(PHASES);
  const named = [from, to, ...[].concat(only || []), ...[].concat(skip || [])].filter(Boolean);
  const bad = [...new Set(named.filter((p) => !known.has(p)))];
  if (bad.length) throw new Error(`unknown phase(s): ${bad.join(', ')} (valid: ${PHASES.join(', ')})`);
  let active = PHASES.slice();
  if (from) { const i = active.indexOf(from); active = active.slice(i); }
  if (to) { const i = active.indexOf(to); active = active.slice(0, i + 1); }
  const onlySet = only && new Set([].concat(only));
  const skipSet = skip && new Set([].concat(skip));
  return active.filter((p) => (!onlySet || onlySet.has(p)) && (!skipSet || !skipSet.has(p)));
}
```

(No change to the `module.exports` — `resolvePhases` is already exported and imported by `build-model-app.js:17`.)

- [ ] **Step 5: Wire `--stage` + usage into `scripts/build-model-app.js` `main()`**

Update the import (line 17) to also pull the stage helper, and change `main()` (lines 213 + 225) to use it:

```javascript
// Line 17 — add stagePhasesOrResolve:
const { runSdkBuild, planFor, resolvePhases, appUniqueName } = require('./lib/sdk-build.js');
const { stagePhasesOrResolve } = require('./lib/stages.js');

// Line 213 — usage string: add --stage:
    process.stderr.write(
      'Usage: node build-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--sample-data] [--publish] [--verify] [--stage <data|ui|app|publish>] [--only|--skip <phases>] [--from|--to <phase>] [--workspace <dir>]\n'
    );

// Line 225 — resolve phases via the stage-aware helper (throws a clear error on unknown/conflicting
// selectors, caught by the main().catch handler at the bottom of the file):
    phases: stagePhasesOrResolve({ stage: flags.stage, only: list(flags.only), skip: list(flags.skip), from: flags.from, to: flags.to }),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test scripts/tests/stages.test.js scripts/tests/sdk-build.test.js`
Expected: PASS (new stages tests pass; the existing `sdk-build.test.js` still passes — `PHASES`/`resolvePhases` behavior is unchanged for valid input).

Then the full gate: `node scripts/run-tests.js`
Expected: PASS — plugin suite green.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/stages.js scripts/tests/stages.test.js scripts/lib/sdk-build.js scripts/build-model-app.js
git commit -m "feat(model-apps): stage layer (stages.js) + --stage + reject unknown selectors" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 2: Discriminated page `source` + `schemaVersion` + validation profiles

**Files:**
- Modify: `scripts/lib/app-spec.js:223` (validateAppSpec signature), `:431-439` (page validation), exports (`:588`)
- Modify: `scripts/build-model-app.js:97-101` region (thread profile), `main()` (compute profile)
- Modify: `scripts/teardown-model-app.js:63`, `scripts/verify-model-app.js:61` (explicit profile)
- Modify: `references/app-spec-schema.md:273-297` (page schema doc)
- Create: `scripts/tests/app-spec-profiles.test.js`
- Modify: `scripts/tests/app-spec.test.js:136-144` (update the codeFile-required test to the new shape)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `validateAppSpec(spec, opts = {})` — `opts.profile ∈ { 'design', 'plan', 'deploy', 'structural' }`, **default `'deploy'`**.
  - Page implementation model: a page is *implemented* when `page.source` is `{ kind: 'tsx', codeFile: string }`; *intent* when `{ kind: 'intent' }`. A legacy top-level `page.codeFile` string is normalized to `{ kind: 'tsx', codeFile }`.
  - `normalizePageSource(page): { kind: 'intent' } | { kind: 'tsx', codeFile: string } | null` (exported; `null` = neither present).
  - Profile semantics for pages: `deploy` requires every page implemented; `design`/`plan` allow intent; `structural` ignores page implementation entirely.

- [ ] **Step 1: Write the failing test** — `scripts/tests/app-spec-profiles.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateAppSpec, normalizePageSource } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

// Minimal valid spec (solution + app + one entity) we can attach pages to.
function base() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso' },
    entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
  };
}

test('normalizePageSource: legacy codeFile -> tsx; explicit source passes through; neither -> null', () => {
  assert.deepStrictEqual(normalizePageSource({ name: 'A', codeFile: 'a.tsx' }), { kind: 'tsx', codeFile: 'a.tsx' });
  assert.deepStrictEqual(normalizePageSource({ name: 'A', source: { kind: 'intent' } }), { kind: 'intent' });
  assert.deepStrictEqual(normalizePageSource({ name: 'A', source: { kind: 'tsx', codeFile: 'a.tsx' } }), { kind: 'tsx', codeFile: 'a.tsx' });
  assert.strictEqual(normalizePageSource({ name: 'A' }), null);
});

test('deploy profile (default) requires every page implemented (tsx)', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  const r = validateAppSpec(s); // default profile = deploy
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /page 'ov': must be implemented/.test(e)), JSON.stringify(r.errors));
});

test('plan/design profile allows an intent page', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));
  assert.strictEqual(validateAppSpec(s, { profile: 'design' }).ok, true);
});

test('deploy profile accepts an implemented page (explicit tsx and legacy codeFile)', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }];
  assert.strictEqual(validateAppSpec(s).ok, true, JSON.stringify(validateAppSpec(s).errors));
  const legacy = base();
  delete legacy.schemaVersion; // legacy spec, top-level codeFile
  legacy.pages = [{ name: 'Overview', codeFile: 'overview.tsx' }];
  assert.strictEqual(validateAppSpec(legacy).ok, true, JSON.stringify(validateAppSpec(legacy).errors));
});

test('malformed source is rejected regardless of profile', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'tsx' } }]; // tsx with no codeFile
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /page 'ov': source.kind 'tsx' needs a codeFile/.test(e)), JSON.stringify(r.errors));

  const s2 = base();
  s2.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'nope' } }];
  assert.ok(validateAppSpec(s2, { profile: 'plan' }).errors.some((e) => /page 'ov': source.kind must be 'intent' or 'tsx'/.test(e)));
});

test('structural profile ignores page implementation entirely', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  assert.strictEqual(validateAppSpec(s, { profile: 'structural' }).ok, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/app-spec-profiles.test.js`
Expected: FAIL — `normalizePageSource` is not exported; profile behavior absent.

- [ ] **Step 3: Implement in `scripts/lib/app-spec.js`**

Change the signature (line 223) to accept options and resolve a profile:

```javascript
// Valid validation profiles. `deploy` (default) is the strictest — every page must be implemented
// (a real .tsx). `design`/`plan` allow intent-only pages (author designs pages before generate-pages
// writes their .tsx). `structural` ignores page implementation (teardown/cleanup only cares about refs).
// See docs/app-builder-staged-flow-design.md §7.1.
const VALIDATION_PROFILES = ['design', 'plan', 'deploy', 'structural'];

// Normalize a page's implementation source into a discriminated shape:
//   { kind: 'tsx', codeFile } | { kind: 'intent' } | null
// A legacy top-level `codeFile` (schemaVersion < 2) is treated as an implemented tsx page. `null`
// means the page declares neither a source nor a codeFile.
function normalizePageSource(page) {
  if (page && page.source && typeof page.source === 'object') {
    if (page.source.kind === 'intent') return { kind: 'intent' };
    if (page.source.kind === 'tsx') return { kind: 'tsx', codeFile: page.source.codeFile };
    return { kind: page.source.kind }; // malformed — surfaced by the validator below
  }
  if (page && typeof page.codeFile === 'string') return { kind: 'tsx', codeFile: page.codeFile };
  return null;
}

function validateAppSpec(spec, opts = {}) {
  const profile = opts.profile || 'deploy';
  const errors = [];
  if (!VALIDATION_PROFILES.includes(profile)) {
    return { ok: false, errors: [`unknown validation profile '${profile}' (valid: ${VALIDATION_PROFILES.join(', ')})`] };
  }
  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: ['spec is not an object'] };
  }
  // ...(existing solution/app/entities validation unchanged)...
```

Replace the page loop (lines 434-439) with source-aware, profile-gated validation:

```javascript
  // Generative pages. Each needs a name. Implementation state is a discriminated `source`
  // (`intent` | `tsx`+codeFile); a legacy top-level `codeFile` is accepted as an implemented tsx.
  // The `deploy` profile requires every page implemented; `design`/`plan` allow intent (the page's
  // .tsx is produced by generate-pages after approval); `structural` ignores implementation.
  const pageNamesSet = new Set();
  for (const p of spec.pages || []) {
    if (!p || !p.name) { errors.push('a page is missing a name'); continue; }
    pageNamesSet.add(p.name);
    const src = normalizePageSource(p);
    if (src && src.kind !== 'intent' && src.kind !== 'tsx') {
      errors.push(`page '${p.key || p.name}': source.kind must be 'intent' or 'tsx'`);
    } else if (src && src.kind === 'tsx' && (typeof src.codeFile !== 'string' || !src.codeFile)) {
      errors.push(`page '${p.key || p.name}': source.kind 'tsx' needs a codeFile (path to the .tsx)`);
    }
    if (profile === 'deploy') {
      if (!(src && src.kind === 'tsx' && typeof src.codeFile === 'string' && src.codeFile)) {
        errors.push(`page '${p.key || p.name}': must be implemented (source.kind 'tsx' with a codeFile) for a deploy build — run generate-pages`);
      }
    } else if (profile !== 'structural' && src === null) {
      // design/plan still require SOME declared source (intent or tsx) — a page with neither is a
      // spec error, not a valid design.
      errors.push(`page '${p.key || p.name}': needs a source ({ kind: 'intent' } or { kind: 'tsx', codeFile })`);
    }
  }
```

Add `normalizePageSource` and `VALIDATION_PROFILES` to `module.exports` (line ~588):

```javascript
module.exports = {
  validateAppSpec,
  normalizePageSource,
  VALIDATION_PROFILES,
  // ...(existing exports unchanged)...
};
```

- [ ] **Step 4: Update the one existing page test that assumed `codeFile`-required**

In `scripts/tests/app-spec.test.js`, the test at lines 136-144 (`rejects a page missing codeFile and a subarea referencing an unknown page`) must reflect the new model. A page with neither source nor codeFile is still invalid under the default `deploy` profile, so update the assertion message expectation:

```javascript
test('validateAppSpec rejects a page with no source/codeFile and a subarea referencing an unknown page', () => {
  const s = cloneDesk();
  s.pages = [{ name: 'Overview' }]; // no source, no codeFile
  s.appShell.areas[0].groups[0].subAreas.push({ title: 'Overview', page: 'Nope' });
  const r = validateAppSpec(s); // default deploy profile
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /page 'Overview': must be implemented/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /unknown page 'Nope'/.test(e)), JSON.stringify(r.errors));
});
```

(If `cloneDesk()`'s `appShell` path differs, adjust the subarea push to match the sample's actual `appShell.areas[].groups[].subAreas` shape — verify by reading `samples/app-spec.support-desk.json`.)

- [ ] **Step 5: Thread the profile through the three CLI callers**

`scripts/build-model-app.js` — compute the profile in `main()` and pass it in `opts`, then use it at the validate call. Per the design §7.1: a dry-run or a `--stage data` run uses `plan`; a full apply uses `deploy`.

```javascript
// In main() opts (near line 220-228), add:
    profile: (flags.apply === true && flags.stage !== 'data') ? 'deploy' : 'plan',

// In buildModelApp (line 98), pass the profile through (default deploy keeps other callers unchanged):
  const v = validateAppSpec(spec, { profile: opts.profile || 'deploy' });
```

`scripts/teardown-model-app.js:63` — teardown only needs structural refs:

```javascript
  const v = validateAppSpec(spec, { profile: 'structural' });
```

`scripts/verify-model-app.js:61` — verify runs against a built app (pages should be implemented):

```javascript
  const v = validateAppSpec(spec, { profile: 'deploy' });
```

- [ ] **Step 6: Update `references/app-spec-schema.md` (lines 273-297)**

Replace the `pages[]` section to document `schemaVersion`, the discriminated `source`, and that a legacy top-level `codeFile` still works:

```markdown
## pages[] (optional — generative pages / genux)  [schemaVersion 2]
```jsonc
[ { "key": "overview", "name": "Overview", "purpose": "KPI overview + recent orders",
    "dataSources": ["new_order", "new_customer"],
    "source": { "kind": "intent" } } ]        // design-time; generate-pages fills the .tsx
// after generate-pages: "source": { "kind": "tsx", "codeFile": "overview.tsx" }
```
- **Genpage-first policy** is unchanged. A page's implementation state is an explicit discriminated
  `source`: `{ "kind": "intent" }` (declared but not yet coded) or `{ "kind": "tsx", "codeFile": "…" }`
  (the `.tsx` the build uploads). A **legacy** top-level `"codeFile"` (no `schemaVersion`) is still
  accepted and treated as an implemented tsx page.
- Validation is **profile-scoped**: `design`/`plan` accept intent pages; a `deploy` build (the default)
  requires every page implemented.
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test scripts/tests/app-spec-profiles.test.js scripts/tests/app-spec.test.js`
Expected: PASS.

Then: `node scripts/run-tests.js`
Expected: PASS — full suite green.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/app-spec.js scripts/build-model-app.js scripts/teardown-model-app.js scripts/verify-model-app.js references/app-spec-schema.md scripts/tests/app-spec-profiles.test.js scripts/tests/app-spec.test.js
git commit -m "feat(model-apps): discriminated page source + schemaVersion + validation profiles" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 3: Stable page `key` + navigation graph + page design contract

**Files:**
- Modify: `scripts/lib/app-spec.js` (page validation: keys + `navigatesTo` + `pageInput`; `spec.design`; appShell `page`-by-key for schemaVersion ≥ 2)
- Modify: `references/app-spec-schema.md` (document keys, `navigatesTo`, `pageInput`, `design`)
- Create: `scripts/tests/app-spec-keys.test.js`

**Interfaces:**
- Consumes: `validateAppSpec(spec, opts)`, `normalizePageSource` (Task 2).
- Produces (validation rules, schemaVersion ≥ 2):
  - `page.key: string` — required + unique across `pages[]`.
  - `page.navigatesTo?: [{ targetKey: string, data?: object }]` — every `targetKey` must resolve to a known page `key`.
  - `page.pageInput?: { data?: object }` — shape only (object).
  - `spec.design?: { accentColor?, density?, cornerRadius?, darkMode?, layout? }` — shape only (object; unknown keys rejected).
  - `appShell` page subareas reference the page **`key`** when `schemaVersion >= 2` (legacy specs keep name-based refs — migrated in Task 4).

- [ ] **Step 1: Write the failing test** — `scripts/tests/app-spec-keys.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateAppSpec } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

function base() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso', },
    entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
  };
}

test('schemaVersion 2 page requires a unique key', () => {
  const s = base();
  s.pages = [{ name: 'Overview', source: { kind: 'intent' } }]; // no key
  assert.ok(validateAppSpec(s, { profile: 'plan' }).errors.some((e) => /page 'Overview': needs a stable key/.test(e)));
  const dup = base();
  dup.pages = [{ key: 'ov', name: 'A', source: { kind: 'intent' } }, { key: 'ov', name: 'B', source: { kind: 'intent' } }];
  assert.ok(validateAppSpec(dup, { profile: 'plan' }).errors.some((e) => /duplicate page key 'ov'/.test(e)));
});

test('navigatesTo.targetKey must resolve to a known page key', () => {
  const s = base();
  s.pages = [
    { key: 'ov', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'detail', data: { orderId: 'string' } }] },
    { key: 'detail', name: 'Detail', source: { kind: 'intent' }, pageInput: { data: { orderId: 'string' } } },
  ];
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));

  const bad = base();
  bad.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'ghost' }] }];
  assert.ok(validateAppSpec(bad, { profile: 'plan' }).errors.some((e) => /navigatesTo target 'ghost' is not a known page key/.test(e)));
});

test('appShell page subarea references the key (schemaVersion 2)', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  s.appShell.areas[0].groups[0].subAreas.push({ title: 'Overview', page: 'ov' });
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));

  const badRef = base();
  badRef.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  badRef.appShell.areas[0].groups[0].subAreas.push({ title: 'Overview', page: 'Overview' }); // used name, not key
  assert.ok(validateAppSpec(badRef, { profile: 'plan' }).errors.some((e) => /unknown page 'Overview'/.test(e)));
});

test('spec.design accepts known keys and rejects unknown ones', () => {
  const s = base();
  s.design = { accentColor: '#0f6cbd', density: 'comfortable', layout: 'cards' };
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));
  const bad = base();
  bad.design = { accent: '#000' };
  assert.ok(validateAppSpec(bad, { profile: 'plan' }).errors.some((e) => /design: unknown key 'accent'/.test(e)));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/app-spec-keys.test.js`
Expected: FAIL — key/navigatesTo/design rules absent.

- [ ] **Step 3: Implement in `scripts/lib/app-spec.js`**

Extend the page loop to collect keys and validate them (schemaVersion ≥ 2), then validate `navigatesTo` and `pageInput` after the loop, and switch appShell page-ref resolution to keys for v2. Add a `spec.design` block.

```javascript
  const isV2 = (spec.schemaVersion || 0) >= 2;
  const pageKeysSet = new Set();
  // ...(inside the existing `for (const p of spec.pages || [])` loop, after the source checks)...
    if (isV2) {
      if (!p.key || typeof p.key !== 'string') errors.push(`page '${p.name}': needs a stable key (schemaVersion 2)`);
      else if (pageKeysSet.has(p.key)) errors.push(`duplicate page key '${p.key}'`);
      else pageKeysSet.add(p.key);
    }

  // After the page loop — navigation graph + pageInput shape.
  for (const p of spec.pages || []) {
    for (const nav of p.navigatesTo || []) {
      if (!nav || typeof nav.targetKey !== 'string') { errors.push(`page '${p.key || p.name}': navigatesTo entry needs a targetKey`); continue; }
      if (isV2 && !pageKeysSet.has(nav.targetKey)) errors.push(`page '${p.key || p.name}': navigatesTo target '${nav.targetKey}' is not a known page key`);
      if (nav.data !== undefined && (typeof nav.data !== 'object' || nav.data === null || Array.isArray(nav.data))) errors.push(`page '${p.key || p.name}': navigatesTo.data must be an object`);
    }
    if (p.pageInput !== undefined) {
      if (typeof p.pageInput !== 'object' || p.pageInput === null || Array.isArray(p.pageInput)) errors.push(`page '${p.key || p.name}': pageInput must be an object`);
    }
  }

  // Page design contract (optional). Shape-only in this plan; the token->Fluent mapping + generated-
  // page validation land in the Pages plan. Reject unknown keys so typos fail early.
  if (spec.design !== undefined) {
    if (typeof spec.design !== 'object' || spec.design === null || Array.isArray(spec.design)) {
      errors.push('design must be an object');
    } else {
      const allowed = new Set(['accentColor', 'density', 'cornerRadius', 'darkMode', 'layout']);
      for (const k of Object.keys(spec.design)) if (!allowed.has(k)) errors.push(`design: unknown key '${k}' (allowed: ${[...allowed].join(', ')})`);
    }
  }
```

Change the appShell page-subarea resolution (line 457) to resolve by key for v2, keeping name resolution for legacy specs:

```javascript
        // schemaVersion 2 references pages by stable KEY; legacy specs still reference by name.
        const pageRefSet = isV2 ? pageKeysSet : pageNamesSet;
        if (sa.page && !pageRefSet.has(sa.page)) errors.push(`sitemap subArea references unknown page '${sa.page}' (declare it in pages[])`);
```

(Ensure `isV2`/`pageKeysSet`/`pageNamesSet` are all in scope where the appShell subarea loop runs — declare `isV2` and the sets before the appShell loop; both loops already live in the same function.)

- [ ] **Step 4: Document in `references/app-spec-schema.md`**

Add `key`, `navigatesTo`, `pageInput` to the `pages[]` example, note the `page` subarea references the **key** at schemaVersion 2, and add a short `design` (page contract) subsection:

```markdown
- **`key`** (schemaVersion 2, required, unique) is the page's stable identity — used by
  `navigatesTo[].targetKey`, the `PAGEREF_<key>` navigation placeholder, and the `page` sitemap
  subarea. Renaming a page never changes its key.
- **`navigatesTo`**: `[{ "targetKey": "<page key>", "data": { … } }]` — declared page-to-page
  navigation (custom ids travel in `data`, read as `pageInput?.data?.<key>` on the target).
- **`pageInput`**: `{ "data": { … } }` — the input this page expects when navigated to.

## design (optional — page design contract)
```jsonc
{ "accentColor": "#0f6cbd", "density": "comfortable", "cornerRadius": "medium",
  "darkMode": "system", "layout": "cards" }
```
- Shared styling tokens threaded to every page so generated pages look consistent with each other
  and the model-driven shell (both Fluent UI V9). Unknown keys are rejected.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/tests/app-spec-keys.test.js scripts/tests/app-spec.test.js scripts/tests/app-spec-profiles.test.js`
Expected: PASS.

Then: `node scripts/run-tests.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/app-spec.js references/app-spec-schema.md scripts/tests/app-spec-keys.test.js
git commit -m "feat(model-apps): stable page keys + navigation graph + page design contract" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 4: Legacy spec migration (`migrateAppSpec`)

**Files:**
- Modify: `scripts/lib/app-spec.js` (add + export `migrateAppSpec`)
- Modify: `scripts/build-model-app.js:218`, `scripts/teardown-model-app.js`, `scripts/verify-model-app.js` (migrate on load, before validate)
- Create: `scripts/tests/app-spec-migrate.test.js`

**Interfaces:**
- Consumes: `normalizePageSource` (Task 2), the key/ref model (Task 3).
- Produces:
  - `migrateAppSpec(spec): spec` — returns a `schemaVersion: 2` spec: mints a stable `key` per page (slug of `name`, de-duplicated), wraps a legacy top-level `codeFile` into `source: { kind: 'tsx', codeFile }`, and rewrites `appShell` page subareas + `navigatesTo.targetKey` from name → key. **Idempotent**: a spec already at `schemaVersion >= 2` is returned unchanged. Pure (no I/O; does not mutate its input — returns a deep-updated copy).

- [ ] **Step 1: Write the failing test** — `scripts/tests/app-spec-migrate.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { migrateAppSpec, validateAppSpec } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

test('migrates a legacy (name-referenced, top-level codeFile) spec to schemaVersion 2', () => {
  const legacy = {
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso' },
    entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    pages: [{ name: 'Sales Overview', codeFile: 'sales.tsx' }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [{ title: 'Sales Overview', page: 'Sales Overview' }] }] }] },
  };
  const m = migrateAppSpec(legacy);
  assert.strictEqual(m.schemaVersion, 2);
  assert.strictEqual(m.pages[0].key, 'sales-overview');
  assert.deepStrictEqual(m.pages[0].source, { kind: 'tsx', codeFile: 'sales.tsx' });
  // appShell page subarea rewritten name -> key
  assert.strictEqual(m.appShell.areas[0].groups[0].subAreas[0].page, 'sales-overview');
  // The migrated spec passes deploy validation.
  assert.strictEqual(validateAppSpec(m).ok, true, JSON.stringify(validateAppSpec(m).errors));
});

test('de-duplicates keys minted from colliding names', () => {
  const legacy = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [],
    pages: [{ name: 'Overview', codeFile: 'a.tsx' }, { name: 'Overview', codeFile: 'b.tsx' }],
  };
  const m = migrateAppSpec(legacy);
  assert.strictEqual(m.pages[0].key, 'overview');
  assert.strictEqual(m.pages[1].key, 'overview-2');
});

test('is idempotent for a schemaVersion 2 spec (returns it unchanged)', () => {
  const v2 = { schemaVersion: 2, solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [], pages: [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }] };
  assert.deepStrictEqual(migrateAppSpec(v2), v2);
});

test('does not mutate its input', () => {
  const legacy = { solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [], pages: [{ name: 'Overview', codeFile: 'a.tsx' }] };
  const before = JSON.stringify(legacy);
  migrateAppSpec(legacy);
  assert.strictEqual(JSON.stringify(legacy), before);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/app-spec-migrate.test.js`
Expected: FAIL — `migrateAppSpec` is not exported.

- [ ] **Step 3: Implement `migrateAppSpec` in `scripts/lib/app-spec.js`**

```javascript
// Slugify a page name into a stable key candidate: lowercase, non-alphanumerics -> '-', trimmed.
//   "Sales Overview"  -> "sales-overview"
//   "KPI / Analytics" -> "kpi-analytics"
function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

// Upgrade a legacy App Spec to schemaVersion 2 in one pure pass (no I/O; returns a deep copy):
//   - mint a stable, unique `key` per page (slug of name, de-duplicated with a -N suffix)
//   - wrap a legacy top-level `codeFile` into `source: { kind: 'tsx', codeFile }`
//   - rewrite name-based references (appShell page subareas + navigatesTo.targetKey) to keys
// Idempotent: a spec already at schemaVersion >= 2 is returned as-is. Runs on load before validate,
// so downstream code only ever sees the v2 shape. See docs/app-builder-staged-flow-design.md §7.3.
function migrateAppSpec(spec) {
  if (!spec || typeof spec !== 'object' || (spec.schemaVersion || 0) >= 2) return spec;
  const out = JSON.parse(JSON.stringify(spec));
  out.schemaVersion = 2;
  const nameToKey = new Map();
  const used = new Set();
  for (const p of out.pages || []) {
    let key = slugify(p.name);
    let n = 1;
    while (used.has(key)) { n += 1; key = `${slugify(p.name)}-${n}`; }
    used.add(key);
    p.key = key;
    nameToKey.set(p.name, key);
    if (!p.source && typeof p.codeFile === 'string') { p.source = { kind: 'tsx', codeFile: p.codeFile }; delete p.codeFile; }
    for (const nav of p.navigatesTo || []) { if (nav && nameToKey.has(nav.targetKey)) nav.targetKey = nameToKey.get(nav.targetKey); }
  }
  // Second pass for navigatesTo targets that referenced a page declared later than the source page.
  for (const p of out.pages || []) for (const nav of p.navigatesTo || []) { if (nav && nameToKey.has(nav.targetKey)) nav.targetKey = nameToKey.get(nav.targetKey); }
  for (const a of (out.appShell && out.appShell.areas) || []) {
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) { if (sa && sa.page && nameToKey.has(sa.page)) sa.page = nameToKey.get(sa.page); }
    }
  }
  return out;
}
```

Add to `module.exports`:

```javascript
module.exports = {
  validateAppSpec,
  normalizePageSource,
  VALIDATION_PROFILES,
  migrateAppSpec,
  // ...(existing exports unchanged)...
};
```

- [ ] **Step 4: Migrate on load in the three CLIs (before validate)**

`scripts/build-model-app.js` — after reading the spec (line 218):

```javascript
  const { migrateAppSpec } = require('./lib/app-spec.js'); // (or add to the existing line-16 destructure)
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
```

`scripts/teardown-model-app.js` and `scripts/verify-model-app.js` — wrap their spec read with `migrateAppSpec(...)` the same way (import from `./lib/app-spec.js`, migrate immediately after `readJsonArg`/`JSON.parse`, before `validateAppSpec`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/tests/app-spec-migrate.test.js scripts/tests/app-spec.test.js scripts/tests/app-spec-keys.test.js scripts/tests/app-spec-profiles.test.js`
Expected: PASS.

Then: `node scripts/run-tests.js`
Expected: PASS — full suite green.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/app-spec.js scripts/build-model-app.js scripts/teardown-model-app.js scripts/verify-model-app.js scripts/tests/app-spec-migrate.test.js
git commit -m "feat(model-apps): migrate legacy App Specs to schemaVersion 2 on load" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Self-Review (completed while writing)

**Spec coverage** (against design §6, §7.1, §7.2, §7.3): stage layer + `--stage` + reject-unknown (Task 1 → §6); discriminated `source` + `schemaVersion` + validation profiles + per-caller wiring (Task 2 → §7.1/§7.2); stable keys + `navigatesTo`/`pageInput` + `spec.design` + appShell-by-key (Task 3 → §7.2); legacy migration + reverse name→key rewrite on load (Task 4 → §7.3). Deferred (later plans, called out): the durable `<app>_pagemanifest` web resource + download reverse-normalization (Pages plan — needs the deployment path); `op-diff`/autopilot flags (Safety plan); `stages.js` runtime use to drive the two-run pipeline (Pages plan).

**Placeholder scan:** none — every step has runnable test + implementation code and exact commands.

**Type consistency:** `validateAppSpec(spec, opts)`, `normalizePageSource(page)`, `migrateAppSpec(spec)`, `PHASES`, `STAGES`, `phasesForStage`, `stagePhasesOrResolve`, `resolvePhases` are used consistently across tasks; page shape (`key`, `name`, `source:{kind,codeFile}`, `navigatesTo:[{targetKey,data}]`, `pageInput`, `spec.design`) matches the design doc §7.2 and is identical everywhere it appears.

**Note for the implementer:** Task 2 Step 4 and Task 3's appShell tests assume `samples/app-spec.support-desk.json` has an `appShell.areas[].groups[].subAreas` shape; read that sample first and adjust the subarea push path if it differs. Run `node scripts/run-tests.js` after every task — the suite must stay at 510+ green.

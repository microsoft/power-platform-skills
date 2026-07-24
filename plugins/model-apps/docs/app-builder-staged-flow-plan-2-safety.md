# App-Builder Staged Flow — Plan 2: Safety & Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/app-builder` applies safe and idempotent. (1) Commands and dashboards become **additive discover-reconcile** — a rebuild/retry reuses an existing per-entity command bar / dashboard instead of creating a duplicate, and never removes tiles or buttons. (2) A new **pure** `op-diff.js` classifies the destructive operations an apply (or teardown) would perform. (3) `build-model-app.js` and `teardown-model-app.js` **fail closed** on destructive ops unless `--allow-destructive` is passed, and an unattended (`--non-interactive` or `POWER_PLATFORM_SKILLS_NONINTERACTIVE=1`) create **fails** on an existing-app collision instead of warning — while the env var / `--non-interactive` suppress interactive prompts **only** and never grant destructive authority.

**Architecture:** Purely additive to the committed spec-driven engine and the Plan 1 foundation. The op-diff classifier is a pure leaf module that **reuses the existing single sources of truth** (`formFieldLogicals`, `planTeardown`) instead of re-deriving removal detection. The safety gates live in the **CLI wrappers** (`build-model-app.js`, `teardown-model-app.js`) — never inside the pure engine (`runSdkBuild` / `runTeardown` / `planTeardown`) — so every engine-level test is unaffected. The idempotency fix upgrades two engine phases (`commands`, `dashboards`) to the same discover-then-skip pattern the `charts` phase already uses, via the SDK's `resolveArtifact` discovery (the only discovery that supports the `dashboard`/`command` kinds). Read-only discovery is recomputed immediately before the write loop (TOCTOU).

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, run via `node scripts/run-tests.js`. Design source of truth: `plugins/model-apps/docs/app-builder-staged-flow-design.md` (§11 safety & autopilot, §14 additive commands/dashboards, §7.1 validation profiles — landed in Plan 1).

## Global Constraints

- All commands run from the plugin root: `D:\Projects\power-platform-skills-sdk\plugins\model-apps`.
- Tests use `node:test`: `const { test } = require('node:test'); const assert = require('node:assert');`. Full suite: `node scripts/run-tests.js` (currently **544** passing — keep it green; each task below adds tests). Single file: `node --test scripts/tests/<file>.test.js`.
- The **13 engine phase names and order are unchanged**: `solution, data-model, sample-data, web-resources, views, charts, forms, commands, dashboards, app-shell, pages, ai-features, publish`.
- **The safety gate lives in the CLI wrappers** (`build-model-app.js` / `teardown-model-app.js`), NOT in the pure engine (`runSdkBuild` / `runTeardown` / `planTeardown`). Engine tests must stay green untouched.
- **`op-diff.js` is PURE:** no I/O, no SDK handle. The caller fetches read-only state and passes it in. `classifyOps` returns `{ destructive: [{ kind, label, detail }], hasDestructive }`.
- **Commands/dashboards reconcile is ADDITIVE ONLY:** discover-then-skip if the artifact exists; never remove tiles/buttons. Discovery uses `provision.resolveArtifact` — `findArtifact` supports only `view`/`chart`/`form`/`app`, NOT `dashboard`/`command` (proven by the teardown engine, which uses `resolveArtifact` for both).
- **`--non-interactive` and `POWER_PLATFORM_SKILLS_NONINTERACTIVE=1|true` suppress interactive prompts ONLY.** They never grant destructive authority. `--allow-destructive` is the ONLY thing that authorizes a destructive apply/teardown.
- **Fail-closed:** a destructive op halts BEFORE any write unless `--allow-destructive` is set — including teardown.
- Commit trailers on every commit:
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89
  ```

---

## File Structure

- `scripts/lib/op-diff.js` **(new)** — the pure destructive-op classifier: `classifyOps` / `sitemapTargets` / `formRemovals`. Reuses `formFieldLogicals` (`artifact-intent.js`) and `planTeardown` (`sdk-teardown.js`); no SDK handle, no I/O.
- `scripts/lib/sdk-build.js` **(modify)** — `dashboards` phase (`:974-984`) and `commands` phase (`:959-968`): discover-then-skip via `provision.resolveArtifact` (additive; populate `result.created`). Mirrors the `charts` skip-if-exists pattern (`:839-856`).
- `scripts/build-model-app.js` **(modify)** — add `envTruthy` + `discoverOpDiffState`; wire `--non-interactive` / `--allow-destructive`; replace the warn-only collision block (`:111-121`) with the collision gate + fail-closed destructive-op gate (recomputed immediately before the write loop — TOCTOU). Export `discoverOpDiffState`, `envTruthy`.
- `scripts/teardown-model-app.js` **(modify)** — fail-closed gate: `--apply` now requires `--allow-destructive` (via `classifyOps` teardown mode). Dry-run unaffected.
- `scripts/smoke-eval.js` **(modify)** — add `--allow-destructive` to the teardown `--apply` invocation (`:122`) so the live smoke eval's teardown still runs after the gate lands.
- `skills/app-builder/SKILL.md` **(modify)** — document `--non-interactive`, `--allow-destructive`, the `POWER_PLATFORM_SKILLS_NONINTERACTIVE` env var, and that `teardown --apply` now requires `--allow-destructive`. (Docs — not tested.)
- `scripts/tests/op-diff.test.js` **(new)** — offline unit tests for the classifier.
- `scripts/tests/sdk-build.test.js` **(modify)** — add `resolveArtifact` to `mockSdk`; add commands/dashboards idempotency tests.
- `scripts/tests/build-model-app.test.js` **(modify)** — add collision-gate + destructive-gate + `envTruthy` tests.
- `scripts/tests/teardown-model-app.test.js` **(modify)** — add the fail-closed gate tests; thread `allowDestructive: true` through the existing apply tests.

---

## Task 1: Additive discover-reconcile for dashboards + commands (idempotency)

Today the `dashboards` phase always `createArtifact('dashboard', { name })` with no find-existing, so every rebuild/retry **duplicates** the dashboard. The `commands` phase always `createArtifact('command', def)` + `pushArtifact`, risking a duplicate per-entity command bar. Fix both with the same discover-then-skip the `charts` phase already uses (`sdk-build.js:839-856`), discovering via `provision.resolveArtifact` (the only discovery that supports these kinds). ADDITIVE ONLY — never remove tiles/buttons. Design §14.

**Files:**
- Modify: `scripts/lib/sdk-build.js:959-968` (commands phase), `:974-984` (dashboards phase)
- Modify: `scripts/tests/sdk-build.test.js:54-168` (add `resolveArtifact` to `mockSdk`, after the `findArtifact` mock at `:85`), plus new tests near the existing commands test (`:729`) and dashboards test (`:754`)

**Interfaces:**
- Consumes:
  - `provision.resolveArtifact(kind: string, identity: object): Promise<Array<{ id: string, name?: string, entity?: string }>>` — the vendored bundle's discovery (already in `SKILL_SDK_SURFACE`, `sdk-surface-contract.test.js:70`; used by the teardown engine for `dashboard`/`command`). For `kind: 'dashboard'` the identity is `{ name }`; for `kind: 'command'` it is `{ entity }`.
  - Unchanged: `provision.createArtifact`, `provision.addElement`, `provision.pushArtifact`, `provision.addSolutionComponent`; `runner.skip(phase, label)`, `runner.run(phase, label, fn)`.
- Produces:
  - Unchanged phase side effects, PLUS: when the artifact already exists, `result.created.dashboards[name]` / `result.created.commands[entity]` are populated with the **existing** id (not a fresh duplicate), and a `runner.skip` step is recorded. No new exports.

- [ ] **Step 1: Write the failing tests** — `scripts/tests/sdk-build.test.js`

First add a `resolveArtifact` mock to `mockSdk` (insert immediately after the `findArtifact` mock at `:85`):

```javascript
    // Discovery seam mirrored from the vendored bundle. The teardown engine — and now the additive
    // commands/dashboards reconcile — uses resolveArtifact for the `dashboard`/`command` kinds that
    // findArtifact does NOT support. Returns [{ id, name?/entity? }]. Honors seeded existing artifacts
    // (opts.existingDashboards / opts.existingCommands) AND anything created into `store` this run, so a
    // rebuild in the same test observes the first run's artifacts — proving the reconcile never duplicates.
    resolveArtifact: async (kind, identity) => {
      calls.push({ name: 'resolveArtifact', args: [kind, identity] });
      const out = [];
      if (kind === 'dashboard') {
        for (const n of opts.existingDashboards || []) out.push({ id: `dashboard-existing-${n}`, name: n });
        for (const k of Object.keys(store)) if (k.startsWith('dashboard:') && store[k].name) out.push({ id: store[k].id, name: store[k].name });
        return identity && identity.name != null ? out.filter((o) => o.name === identity.name) : out;
      }
      if (kind === 'command') {
        for (const e of opts.existingCommands || []) out.push({ id: `command-existing-${e}`, entity: e });
        for (const k of Object.keys(store)) if (k.startsWith('command:') && store[k].entityLogicalName) out.push({ id: store[k].id, entity: store[k].entityLogicalName });
        return identity && identity.entity != null ? out.filter((o) => o.entity === identity.entity) : out;
      }
      return [];
    },
```

Then add these tests (place after the existing dashboards test at `:754-781`):

```javascript
test('dashboards: an existing dashboard is reused (no duplicate) and reported in result.created', async () => {
  const spec = makeSpec();
  spec.dashboards = [{ name: 'Ops', tiles: [{ type: 'list', view: 'Active Tickets', name: 'Recent' }] }];
  const { sdk, calls } = mockSdk({ existingDashboards: ['Ops'] });
  const result = await runSdkBuild(spec, { sdk, apply: true });
  // The old code create-duplicated every run; the reconcile must NOT create when one already exists.
  assert.ok(!find(calls, 'createArtifact').some((c) => c.args[0] === 'dashboard'), 'no duplicate dashboard created');
  // The existing id is still threaded into result.created so downstream references resolve.
  assert.strictEqual(result.created.dashboards.Ops, 'dashboard-existing-Ops');
  assert.ok(find(calls, 'resolveArtifact').some((c) => c.args[0] === 'dashboard' && c.args[1].name === 'Ops'), 'discovered via resolveArtifact');
});

test('dashboards: a new dashboard is still created + pushed + added to the solution', async () => {
  const spec = makeSpec();
  spec.dashboards = [{ name: 'Ops', tiles: [{ type: 'list', view: 'Active Tickets', name: 'Recent' }] }];
  const { sdk, calls } = mockSdk(); // nothing pre-exists
  const result = await runSdkBuild(spec, { sdk, apply: true });
  assert.ok(find(calls, 'createArtifact').some((c) => c.args[0] === 'dashboard'), 'dashboard created when absent');
  assert.ok(find(calls, 'pushArtifact').some((c) => c.args[0] === 'dashboard'), 'dashboard pushed');
  assert.ok(result.created.dashboards.Ops, 'created id recorded');
});

test('commands: an existing command bar is reused (no duplicate) and reported in result.created', async () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'var T={a:function(){}};' }];
  spec.commands = [{ entity: 'new_ticket', label: 'A', library: 'new_ticket.js', function: 'T.a' }];
  const { sdk, calls } = mockSdk({ existingCommands: ['new_ticket'] });
  const result = await runSdkBuild(spec, { sdk, apply: true });
  assert.ok(!find(calls, 'createArtifact').some((c) => c.args[0] === 'command'), 'no duplicate command created');
  assert.strictEqual(result.created.commands.new_ticket, 'command-existing-new_ticket');
  assert.ok(find(calls, 'resolveArtifact').some((c) => c.args[0] === 'command' && c.args[1].entity === 'new_ticket'), 'discovered via resolveArtifact');
});

test('commands: a new command bar is still created + pushed', async () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'var T={a:function(){}};' }];
  spec.commands = [{ entity: 'new_ticket', label: 'A', library: 'new_ticket.js', function: 'T.a' }];
  const { sdk, calls } = mockSdk();
  const result = await runSdkBuild(spec, { sdk, apply: true });
  assert.ok(find(calls, 'createArtifact').some((c) => c.args[0] === 'command'), 'command created when absent');
  assert.strictEqual(typeof result.created.commands.new_ticket, 'string');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/tests/sdk-build.test.js`
Expected: FAIL on the two "existing … is reused" tests — the current phases always `createArtifact` and never call `resolveArtifact`, so `createArtifact('dashboard'/'command')` IS present, `result.created.dashboards.Ops` is a freshly-minted id (not `dashboard-existing-Ops`), and no `resolveArtifact` call is recorded. The two "new … still created" tests and all existing tests still pass.

- [ ] **Step 3: Implement the dashboards discover-then-skip** — `scripts/lib/sdk-build.js:974-984`

Replace the current dashboards `for` loop body:

```javascript
  if (has('dashboards')) {
    for (const dash of spec.dashboards || []) {
      // Additive discover-reconcile (design §14): a dashboard is global (identity = name), so a rebuild
      // or retry must REUSE the existing one instead of createArtifact-ing a duplicate every run (the old
      // behavior). Discovery is `resolveArtifact('dashboard', { name })` — findArtifact does NOT support
      // the dashboard kind (only view/chart/form/app), but the vendored bundle's resolveArtifact does (it
      // is what the teardown engine uses to find dashboards, sdk-teardown.js). Like charts, dashboard TILE
      // EDITS are not reapplied on a rebuild — recreate the dashboard to change it. Never removes tiles.
      const existing = await provision.resolveArtifact('dashboard', { name: dash.name });
      const existingId = existing && existing[0] && existing[0].id;
      if (existingId) {
        runner.skip('dashboards', `dashboard "${dash.name}" (exists — reuse; tile edits aren't applied on rebuild, recreate to change)`);
        result.created.dashboards[dash.name] = existingId;
        continue;
      }
      await runner.run('dashboards', `dashboard "${dash.name}" (${(dash.tiles || []).length} tile(s))`, async () => {
        const art = provision.createArtifact('dashboard', { name: dash.name });
        (dash.tiles || []).forEach((tile, ti) => provision.addElement('dashboard', art.id, '/components', dashboardComponent(dashboardTileOpts(spec, tile, result), ti)));
        const pushed = requireSuccessfulPush(await provision.pushArtifact('dashboard', art.id), `dashboard ${dash.name}`);
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.dashboard, solutionUniqueName: sol.uniqueName });
        result.created.dashboards[dash.name] = pushed.id;
      });
    }
  }
```

- [ ] **Step 4: Implement the commands discover-then-skip** — `scripts/lib/sdk-build.js:959-968`

Replace the current commands `for` loop body:

```javascript
  if (has('commands')) {
    for (const [entityLogical, cmds] of Object.entries(commandsByEntity(spec))) {
      // Additive discover-reconcile (design §14): one command artifact per entity (identity = entity).
      // Re-pushing the appaction on every rebuild risks a duplicate command bar on the entity, so
      // discover-then-skip like charts/dashboards. Discovery is `resolveArtifact('command', { entity })`
      // (findArtifact has no command kind; the vendored resolveArtifact — what teardown uses to find a
      // per-entity command — does). Button EDITS are not reapplied on a rebuild — recreate to change.
      // Never removes buttons (additive only).
      const existing = await provision.resolveArtifact('command', { entity: entityLogical });
      const existingId = existing && existing[0] && existing[0].id;
      if (existingId) {
        runner.skip('commands', `command bar for ${entityLogical} (exists — reuse; button edits aren't applied on rebuild, recreate to change)`);
        result.created.commands[entityLogical] = existingId;
        continue;
      }
      await runner.run('commands', `command bar for ${entityLogical} (${cmds.length} button(s))`, async () => {
        const def = commandDef(entityLogical, cmds, result.created.webResources);
        const art = provision.createArtifact('command', def);
        const pushed = requireSuccessfulPush(await provision.pushArtifact('command', art.id), `command ${entityLogical}`);
        result.created.commands[entityLogical] = pushed.id;
      });
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/tests/sdk-build.test.js`
Expected: PASS — the reuse tests now skip creation and populate `result.created`; the existing create tests (`:729`, `:754`) still create because `resolveArtifact` returns `[]` on an empty store.

- [ ] **Step 6: Run the full suite**

Run: `node scripts/run-tests.js`
Expected: PASS — plugin suite green (**544** + 4 new = 548).

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/sdk-build.js scripts/tests/sdk-build.test.js
git commit -m "fix(model-apps): additive discover-reconcile for dashboards + commands (no duplicates on rebuild)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

> **Implementer note (command duplication):** confirm whether a re-push of an existing per-entity appaction actually duplicates the command bar or whether the SDK already replaces it idempotently by entity identity. Either way the discover-then-skip is safe — it never removes buttons, and it avoids a redundant re-push. If you find the SDK genuinely upserts commands, keep the skip (it is still correct and cheaper) and note the finding in the commit body.

---

## Task 2: `op-diff.js` — pure destructive-operation classifier

A read-only classifier that, given the spec plus **read-only discovered state**, reports the destructive operations an apply (or teardown) would perform. It is PURE — no SDK handle, no I/O — so it is fully offline-testable. It **reuses** the existing single sources of truth: `formFieldLogicals` (the exact field set a form places, so a removal here equals what `reconcileForm` prunes at `sdk-build.js:707-733`) and `planTeardown` (the ordered delete plan, reused verbatim). v1 scope per design §11/§19: unexpected-app collision, explicit-layout form-field removals, sitemap-target removals, and all `planTeardown` ops.

**Files:**
- Create: `scripts/lib/op-diff.js`
- Create: `scripts/tests/op-diff.test.js`

**Interfaces:**
- Consumes:
  - `formFieldLogicals(formJson): string[]` — `require('./artifact-intent.js')` (exported at `artifact-intent.js:422`). Ordered, de-duped, lowercased bound-field logicals over `tabs[].columns[].sections[].rows[].cells[].control.fieldName`.
  - `planTeardown(spec): Array<{ kind, phase, label, target }>` — `require('./sdk-teardown.js')` (exported at `sdk-teardown.js:461`). Pure; no require cycle (`sdk-teardown.js` → `sdk-build.js`, neither requires `op-diff.js`).
- Produces:
  - `classifyOps(spec, discovered = {}, opts = {}): { destructive: Array<{ kind: string, label: string, detail: string }>, hasDestructive: boolean }`. `kind ∈ { 'app-collision', 'form-field-removal', 'sitemap-removal', 'teardown' }`.
  - `sitemapTargets(container): string[]` — id-comparable nav targets as `entity:<logical>` / `url:<url>`.
  - `formRemovals(deployedForm, def): string[]` — fields an explicit-layout form would prune (never the primary; `[]` for an auto layout).
  - `discovered` shape (all optional, read-only): `{ collision?: { appExists, appUnique, solutionExists?, solutionName? }, forms?: Array<{ label, deployedForm, def }>, sitemap?: { deployedTargets: string[], wantTargets: string[] } }`. `opts`: `{ teardown?: boolean }`.

- [ ] **Step 1: Write the failing test** — `scripts/tests/op-diff.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { classifyOps, sitemapTargets, formRemovals } = require(path.join(__dirname, '..', 'lib', 'op-diff.js'));

const desk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8'));

// Minimal form topology matching artifact-intent.js formFieldLogicals' walk:
// tabs[].columns[].sections[].rows[].cells[].control.fieldName
const cell = (fn) => ({ control: { fieldName: fn } });
const formOf = (fields) => ({ tabs: [{ columns: [{ sections: [{ rows: fields.map((f) => ({ cells: [cell(f)] })) }] }] }] });

test('sitemapTargets extracts entity/url subareas (lowercased); omits dashboard/genpage subareas', () => {
  const container = { areas: [{ groups: [{ subAreas: [
    { entity: 'New_Ticket', title: 'Tickets' },
    { url: 'https://x/y' },
    { dashboard: 'Ops' }, // omitted — not id-comparable from a read-only fetch (design §11 v1)
    { pageKey: 'home' },  // omitted
  ] }] }] };
  assert.deepStrictEqual(sitemapTargets(container), ['entity:new_ticket', 'url:https://x/y']);
});

test('sitemapTargets tolerates an empty/missing container', () => {
  assert.deepStrictEqual(sitemapTargets({}), []);
  assert.deepStrictEqual(sitemapTargets({ areas: [] }), []);
  assert.deepStrictEqual(sitemapTargets(null), []);
});

test('formRemovals returns pruned fields for an explicit layout only (never the primary)', () => {
  const def = Object.assign(formOf(['new_name', 'new_subject']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployed = formOf(['new_name', 'new_subject', 'new_priority', 'new_stale']);
  assert.deepStrictEqual(formRemovals(deployed, def), ['new_priority', 'new_stale']);
});

test('formRemovals never removes the primary field, even if absent from the want set', () => {
  const def = Object.assign(formOf(['new_subject']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployed = formOf(['new_name', 'new_subject']);
  assert.deepStrictEqual(formRemovals(deployed, def), []);
});

test('formRemovals is empty for an auto layout (auto never prunes)', () => {
  const def = Object.assign(formOf(['new_subject']), { __explicitLayout: false, __primaryField: 'new_name' });
  const deployed = formOf(['new_name', 'new_subject', 'new_priority']);
  assert.deepStrictEqual(formRemovals(deployed, def), []);
});

test('classifyOps: no destructive ops when nothing is discovered', () => {
  assert.deepStrictEqual(classifyOps({ app: { name: 'X' } }, {}), { destructive: [], hasDestructive: false });
});

test('classifyOps: an existing app is an app-collision op', () => {
  const r = classifyOps({ app: { name: 'Support Desk' } }, { collision: { appExists: true, appUnique: 'new_supportdesk' } });
  assert.strictEqual(r.hasDestructive, true);
  assert.strictEqual(r.destructive.length, 1);
  assert.strictEqual(r.destructive[0].kind, 'app-collision');
  assert.match(r.destructive[0].label, /new_supportdesk/);
});

test('classifyOps: an explicit-layout form field removal is destructive', () => {
  const def = Object.assign(formOf(['new_name']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployed = formOf(['new_name', 'new_priority']);
  const r = classifyOps({}, { forms: [{ label: 'form "Ticket" (new_ticket)', deployedForm: deployed, def }] });
  assert.strictEqual(r.hasDestructive, true);
  assert.strictEqual(r.destructive[0].kind, 'form-field-removal');
  assert.match(r.destructive[0].detail, /new_priority/);
});

test('classifyOps: a dropped sitemap target is destructive', () => {
  const r = classifyOps({}, { sitemap: { deployedTargets: ['entity:new_customer', 'entity:new_ticket'], wantTargets: ['entity:new_customer'] } });
  assert.strictEqual(r.hasDestructive, true);
  assert.strictEqual(r.destructive[0].kind, 'sitemap-removal');
  assert.match(r.destructive[0].detail, /entity:new_ticket/);
});

test('classifyOps: teardown mode maps every planTeardown step to a destructive op', () => {
  const r = classifyOps(desk, {}, { teardown: true });
  assert.strictEqual(r.hasDestructive, true);
  assert.ok(r.destructive.length > 0);
  assert.ok(r.destructive.every((o) => o.kind === 'teardown'));
  assert.ok(r.destructive.some((o) => /app module/.test(o.label)), 'includes the app-module delete');
  assert.ok(r.destructive.some((o) => /^table /.test(o.label)), 'includes a table delete');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/op-diff.test.js`
Expected: FAIL — `Cannot find module '.../lib/op-diff.js'`.

- [ ] **Step 3: Create `scripts/lib/op-diff.js`**

```javascript
'use strict';

// Read-only destructive-operation classifier for the app-builder safety gate. Given the spec plus
// READ-ONLY discovered state (collision result, deployed explicit-layout forms, deployed app sitemap)
// and — for teardown — the pure teardown plan, it classifies the ops an apply WOULD perform and
// surfaces the DESTRUCTIVE ones so the caller can fail closed unless --allow-destructive is set. This
// module performs NO I/O and holds NO SDK handle: the caller fetches state read-only and passes it in,
// keeping classification pure and offline-testable. See docs/app-builder-staged-flow-design.md §11
// (safety/autopilot) and §14 (additive commands/dashboards).
//
// It REUSES the existing single sources of truth rather than reimplementing them:
//   - formFieldLogicals (artifact-intent.js) — the exact field-logical set a form places, so a removal
//     here is the same set reconcileForm prunes (sdk-build.js:707-733).
//   - planTeardown (sdk-teardown.js) — the ordered destructive delete plan, reused verbatim as the
//     teardown op set (so the gate and the engine can never disagree about what will be deleted).
const { formFieldLogicals } = require('./artifact-intent.js');
const { planTeardown } = require('./sdk-teardown.js');

// Walk a sitemap CONTAINER ({ areas: [{ groups: [{ subAreas: [...] }] }] }) — the shape both the spec's
// `appShell` and a deployed app's structured `.siteMap` use (built by appDef, sdk-build.js:486-527, and
// fetched+rewritten by the app-shell reconcile, sdk-build.js:999-1010). Return the id-comparable
// navigation targets only: entity subareas as `entity:<logical>` and URL subareas as `url:<url>`.
// Dashboard / generative-page subareas are OMITTED in v1 — they have no stable pre-deploy identity to
// compare read-only, so a spec/deployed diff on them would be noise (design §11 v1 scope).
function sitemapTargets(container) {
  const out = [];
  for (const area of (container && container.areas) || []) {
    for (const group of (area.groups) || []) {
      for (const sub of (group.subAreas) || []) {
        if (sub && sub.entity) out.push(`entity:${String(sub.entity).toLowerCase()}`);
        else if (sub && sub.url) out.push(`url:${sub.url}`);
      }
    }
  }
  return out;
}

// The field logicals an EXPLICIT-layout form would remove from its deployed counterpart. Mirrors the
// reconcileForm prune (sdk-build.js:707-733): only an explicit layout prunes; an auto layout is purely
// additive and never removes, so it can never be destructive. `def` is a compiled form intent
// (compileFormIntent); `deployedForm` is the fetched deployed form. Never counts the primary field
// (reconcile never prunes it). Returns [] for an auto layout or when nothing is removed.
function formRemovals(deployedForm, def) {
  if (!def || !def.__explicitLayout) return [];
  const want = new Set(formFieldLogicals(def));
  const primary = def.__primaryField;
  const removed = [];
  for (const logical of formFieldLogicals(deployedForm || {})) {
    if (logical === primary) continue;
    if (!want.has(logical)) removed.push(logical);
  }
  return removed;
}

// Classify the destructive ops an apply WOULD perform against the discovered state. Returns
// { destructive: [{ kind, label, detail }], hasDestructive }. `kind` is one of:
//   'app-collision'      — an app already exists under our unique name. Reusing it rewrites its sitemap
//                          and components (sdk-build.js:999-1010) — a destructive overwrite the caller
//                          must authorize when unattended (design §11). Solution existence is NORMAL and
//                          never flagged here.
//   'form-field-removal' — an explicit-layout form would prune fields off the deployed form.
//   'sitemap-removal'    — the app sitemap rewrite would drop an entity/URL subarea present today.
//   'teardown'           — a planTeardown delete step (opts.teardown mode only).
// `opts.teardown === true` switches to teardown mode: every planTeardown step is destructive.
function classifyOps(spec, discovered = {}, opts = {}) {
  const destructive = [];

  if (opts.teardown) {
    // Teardown is wholly destructive by construction — reuse the pure plan verbatim.
    for (const step of planTeardown(spec)) {
      destructive.push({ kind: 'teardown', label: step.label, detail: step.phase });
    }
    return { destructive, hasDestructive: destructive.length > 0 };
  }

  const col = discovered.collision;
  if (col && col.appExists) {
    destructive.push({
      kind: 'app-collision',
      label: `app "${col.appUnique || (spec.app && spec.app.name) || ''}" already exists`,
      detail: 'reusing it rewrites its sitemap and app components',
    });
  }

  for (const f of discovered.forms || []) {
    const removed = formRemovals(f.deployedForm, f.def);
    if (removed.length) {
      destructive.push({ kind: 'form-field-removal', label: f.label, detail: `removes field(s): ${removed.join(', ')}` });
    }
  }

  if (discovered.sitemap) {
    const want = new Set(discovered.sitemap.wantTargets || []);
    const dropped = (discovered.sitemap.deployedTargets || []).filter((t) => !want.has(t));
    if (dropped.length) {
      destructive.push({ kind: 'sitemap-removal', label: 'app sitemap', detail: `drops navigation target(s): ${dropped.join(', ')}` });
    }
  }

  return { destructive, hasDestructive: destructive.length > 0 };
}

module.exports = { classifyOps, sitemapTargets, formRemovals };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/tests/op-diff.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `node scripts/run-tests.js`
Expected: PASS — full suite green (548 + 11 new = 559).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/op-diff.js scripts/tests/op-diff.test.js
git commit -m "feat(model-apps): op-diff.js — pure destructive-operation classifier for the safety gate" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 3: Fail-closed destructive gate + `--non-interactive` / `--allow-destructive`

Wire the safety flags and the fail-closed gate into the CLI wrappers. In `build-model-app.js`, replace the current warn-only collision block (`:111-121`) with two gates computed from read-only discovery, immediately before the write loop (TOCTOU): (1) an unattended run **fails** on an existing-app collision unless `--allow-destructive`; interactively it still warns + proceeds (idempotent update). (2) ANY content removal (explicit-layout form-field prune or dropped sitemap target) **halts** unless `--allow-destructive`, interactive or not. In `teardown-model-app.js`, `--apply` now requires `--allow-destructive`. Design §11.

**Files:**
- Modify: `scripts/build-model-app.js:16-20` (imports), `:111-121` (replace the warn-only block), `:214` (usage), `:221-230` (opts), `:263` (exports); add `envTruthy` and `discoverOpDiffState` helpers
- Modify: `scripts/teardown-model-app.js:22-24` (import `classifyOps`), `:62-75` (gate in `teardownModelApp`), `:83` (usage), `:89` / `:94` (flag + pass-through in `main`)
- Modify: `scripts/smoke-eval.js:122` (add `--allow-destructive`)
- Modify: `skills/app-builder/SKILL.md` (document the flags + env var + teardown behavior change)
- Modify: `scripts/tests/build-model-app.test.js` (gate + `envTruthy` tests), `scripts/tests/teardown-model-app.test.js` (gate tests + thread `allowDestructive` through the existing apply tests)

**Interfaces:**
- Consumes:
  - `classifyOps`, `sitemapTargets` — `require('./lib/op-diff.js')`.
  - `checkCollisions(spec, provision): Promise<{ appExists, solutionExists, appUnique, solutionName }>` (this file, `:80-96`), `compileFormIntent`, `appUniqueName` — `require('./lib/sdk-build.js')`.
  - `parseArgs` flags: `--allow-destructive` → `flags['allow-destructive'] === true`; `--non-interactive` → `flags['non-interactive'] === true`. Env: `POWER_PLATFORM_SKILLS_NONINTERACTIVE`.
- Produces:
  - `envTruthy(v): boolean` — `'1'`/`'true'` (case-insensitive) → `true`; else `false` (exported).
  - `discoverOpDiffState(spec, provision): Promise<{ collision, forms: Array<{ label, deployedForm, def }>, sitemap: { deployedTargets, wantTargets } | null }>` — read-only discovery for the gate (exported; injectable via `deps.discoverOpDiffState`).
  - `buildModelApp(spec, opts, deps)`: new `opts.allowDestructive?: boolean`, `opts.nonInteractive?: boolean`; new `deps.discoverOpDiffState?` seam; returns `{ ok: false, errors: string[] }` on a fail-closed halt.
  - `teardownModelApp(spec, opts, deps)`: new `opts.allowDestructive?: boolean`; returns `{ ok: false, errors: string[] }` when `--apply` is not authorized.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/tests/build-model-app.test.js` (the file already imports `buildModelApp` and defines `mockSdk`/`desk` at `:11-60`). Add these form-topology helpers near the top (after the `desk` load), then the tests:

```javascript
// Minimal explicit-layout form fixtures for the destructive gate (match formFieldLogicals' walk).
const cell = (fn) => ({ control: { fieldName: fn } });
const formOf = (fields) => ({ tabs: [{ columns: [{ sections: [{ rows: fields.map((f) => ({ cells: [cell(f)] })) }] }] }] });

test('envTruthy: only 1/true (case-insensitive) count as set', () => {
  const { envTruthy } = require(path.join(__dirname, '..', 'build-model-app.js'));
  assert.strictEqual(envTruthy('1'), true);
  assert.strictEqual(envTruthy('true'), true);
  assert.strictEqual(envTruthy('TRUE'), true);
  assert.strictEqual(envTruthy('0'), false);
  assert.strictEqual(envTruthy('yes'), false);
  assert.strictEqual(envTruthy(undefined), false);
  assert.strictEqual(envTruthy(''), false);
});

test('collision gate: a non-interactive run refuses an existing app without --allow-destructive', async () => {
  const { sdk, calls } = mockSdk();
  sdk.queryRecords = async (set) => (set === 'appmodule' ? [{ appmoduleid: 'app-x' }] : set === 'solution' ? [] : [{ publisherid: 'pub-1' }]);
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0, nonInteractive: true }, { sdk, provisionSdk: sdk });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /allow-destructive/.test(e)), 'halt names --allow-destructive');
  assert.ok(!calls.some((c) => c[0] === 'createSolution'), 'halted before any write');
});

test('collision gate: --allow-destructive lets a non-interactive run proceed to update the app', async () => {
  const { sdk, calls } = mockSdk();
  sdk.queryRecords = async (set) => (set === 'appmodule' ? [{ appmoduleid: 'app-x' }] : set === 'solution' ? [] : [{ publisherid: 'pub-1' }]);
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0, nonInteractive: true, allowDestructive: true }, { sdk, provisionSdk: sdk });
  assert.notStrictEqual(r.ok, false, 'not halted by the gate');
  assert.ok(calls.some((c) => c[0] === 'createSolution'), 'proceeded past the gate into the build');
});

test('destructive gate: build halts on a form-field removal without --allow-destructive', async () => {
  const { sdk, calls } = mockSdk();
  const def = Object.assign(formOf(['new_name']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployedForm = formOf(['new_name', 'new_priority']);
  const state = { collision: { appExists: false, solutionExists: false }, forms: [{ label: 'form "Ticket" (new_ticket)', deployedForm, def }], sitemap: null };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0 }, { sdk, provisionSdk: sdk, discoverOpDiffState: async () => state });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /allow-destructive/.test(e) && /new_priority/.test(e)), 'names the field it would remove');
  assert.ok(!calls.some((c) => c[0] === 'createSolution'), 'halted before any write');
});

test('destructive gate: --allow-destructive lets the same build proceed', async () => {
  const { sdk, calls } = mockSdk();
  const def = Object.assign(formOf(['new_name']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployedForm = formOf(['new_name', 'new_priority']);
  const state = { collision: { appExists: false }, forms: [{ label: 'form "Ticket" (new_ticket)', deployedForm, def }], sitemap: null };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0, allowDestructive: true }, { sdk, provisionSdk: sdk, discoverOpDiffState: async () => state });
  assert.notStrictEqual(r.ok, false);
  assert.ok(calls.some((c) => c[0] === 'createSolution'), 'proceeded past the gate into the build');
});
```

Add to `scripts/tests/teardown-model-app.test.js` (this new fail-closed gate test) and thread `allowDestructive: true` through the two existing apply tests:

```javascript
test('apply without --allow-destructive halts before any delete (fail-closed)', async () => {
  const sdk = presentSdk();
  const cap = logCapture();
  const r = await teardownModelApp(desk, { apply: true }, { sdk, log: cap.log });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /allow-destructive/.test(e)));
  assert.strictEqual(sdk.calls.length, 0, 'no SDK calls — halted before touching anything');
  assert.ok(cap.logs.some((l) => /refusing to delete/.test(l)), 'a clear refusal is printed');
});

test('apply --allow-destructive performs the deletes', async () => {
  const sdk = presentSdk();
  const r = await teardownModelApp(desk, { apply: true, allowDestructive: true }, { sdk });
  assert.strictEqual(r.ok, true);
  assert.ok(sdk.calls.some((c) => c.method === 'deleteAppCascade'), 'app deleted');
});
```

Update the two existing apply tests so the gate lets them through:
- `:80` → `const r = await teardownModelApp(desk, { apply: true, allowDestructive: true }, { sdk });`
- `:90` → `await teardownModelApp(desk, { apply: true, allowDestructive: true }, { sdk, log: cap.log });`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/tests/build-model-app.test.js scripts/tests/teardown-model-app.test.js`
Expected: FAIL — `envTruthy` is not exported; the collision gate does not yet fail unattended (it only warns), so the non-interactive refusal test fails; the destructive gate does not exist, so the form-field-removal halt test fails; the teardown gate does not exist, so the fail-closed test fails (the teardown proceeds and issues deletes).

- [ ] **Step 3: Wire the flags, helpers, and gates into `build-model-app.js`**

Extend the imports (`:16-20`):

```javascript
const { runSdkBuild, planFor, appUniqueName, compileFormIntent } = require('./lib/sdk-build.js');
const { classifyOps, sitemapTargets } = require('./lib/op-diff.js');
```

Add `envTruthy` near the other top-level helpers (e.g. beside `list` at `:204`):

```javascript
// Env var truthiness for the unattended opt-in: '1' or 'true' (case-insensitive) count as set; a
// missing/other value is false. Matches the dotnet-style boolean env convention used elsewhere in this
// repo (see AGENTS.md "Shared Telemetry"). This gates PROMPT SUPPRESSION ONLY — it never grants
// destructive authority (only --allow-destructive does).
function envTruthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
}
```

Add `discoverOpDiffState` immediately after `checkCollisions` (`:96`):

```javascript
// Read-only discovery for the op-diff safety gate. Gathers ONLY what classifyOps needs — the collision
// result, deployed EXPLICIT-layout forms (an auto layout never prunes, so it can't be destructive), and
// the deployed app's sitemap targets — using read-only SDK calls (queryRecords via checkCollisions, then
// findArtifact/fetchArtifact + getArtifact). No writes. `provision` is the header-less SDK client.
// Returns the `discovered` shape classifyOps consumes.
async function discoverOpDiffState(spec, provision) {
  const collision = await checkCollisions(spec, provision);
  // Explicit-layout forms only. compileFormIntent needs no notesClassId here — that id only affects the
  // non-field notes cell, never the field-logical set formRemovals compares (artifact-intent.js).
  const forms = [];
  for (const f of spec.forms || []) {
    const def = compileFormIntent(spec, f, {});
    if (!def.__explicitLayout) continue;
    const id = await provision.findArtifact('form', { name: def.name, entity: def.entityLogicalName });
    if (!id) continue; // not deployed yet → nothing to prune
    await provision.fetchArtifact('form', id); // seed the workspace copy so getArtifact can read it
    forms.push({ label: `form "${f.name || f.entity}" (${String(f.entity).toLowerCase()})`, deployedForm: provision.getArtifact('form', id) || {}, def });
  }
  // Sitemap removals only make sense when the app already exists (a fresh app has no deployed sitemap).
  let sitemap = null;
  if (spec.appShell && collision.appExists) {
    const appId = await provision.findArtifact('app', { uniqueName: collision.appUnique });
    if (appId) {
      await provision.fetchArtifact('app', appId);
      const deployed = provision.getArtifact('app', appId) || {};
      sitemap = { deployedTargets: sitemapTargets(deployed.siteMap || {}), wantTargets: sitemapTargets(spec.appShell) };
    }
  }
  return { collision, forms, sitemap };
}
```

Replace the warn-only collision block (`:111-121`) with the unified gate:

```javascript
  // Pre-flight safety gate (apply only). Recomputed here — immediately before the write loop — so it
  // reflects live state (TOCTOU). Best-effort discovery (reads only): if there is no provision client or
  // discovery is disabled, the gate is skipped. `deps.discoverOpDiffState` is an injection seam for tests.
  // The gate lives here, in the CLI wrapper, NOT inside runSdkBuild — the pure engine is unaffected.
  // See design §11 (fail-closed destructive gate) and §14.
  if (opts.apply && (deps.discoverOpDiffState || (deps.provisionSdk && opts.checkCollisions !== false))) {
    const nonInteractive = opts.nonInteractive === true;
    const allowDestructive = opts.allowDestructive === true;
    let state;
    try {
      state = deps.discoverOpDiffState
        ? await deps.discoverOpDiffState(spec, deps.provisionSdk)
        : await discoverOpDiffState(spec, deps.provisionSdk);
    } catch { state = null; } // discovery must never crash the build; a read failure = no gate
    if (state) {
      const col = state.collision || {};
      // (1) Collision gate. Unattended, an existing app is a HARD stop unless authorized — there is no
      //     human to see a warning and Ctrl-C (design §11). Interactively we preserve today's behavior:
      //     warn + proceed to UPDATE the existing app.
      if (col.appExists || col.solutionExists) {
        const which = [col.appExists ? `app '${col.appUnique}'` : null, col.solutionExists ? `solution '${col.solutionName}'` : null].filter(Boolean).join(' and ');
        if (col.appExists && nonInteractive && !allowDestructive) {
          const msg = `${which} already exist(s) and this is a non-interactive run — refusing to overwrite an existing app. Re-run with --allow-destructive to authorize, or use a different app name.`;
          log(`\n✗ ${msg}`);
          if (journal) journal.close({ status: 'halt', phase: 'preflight', label: which, detail: 'app-collision (non-interactive)', ...counts });
          return { ok: false, errors: [msg] };
        }
        log(`\n⚠ ${which} already exist(s) — this build will UPDATE the existing app (idempotent reuse), not create a fresh one. Use a different name for a new app.`);
        if (journal) journal.record({ phase: 'preflight', status: 'collision', label: which, detail: JSON.stringify({ appExists: col.appExists, solutionExists: col.solutionExists }) });
      }
      // (2) Fail-closed destructive-op gate. ANY content removal (explicit-layout form-field prune or a
      //     dropped sitemap target) requires --allow-destructive, interactive or not — the env var /
      //     --non-interactive suppress prompts only, they never grant destructive authority. The
      //     app-collision op is handled above (interactive/non-interactive nuance), so exclude it here.
      const diff = classifyOps(spec, state, { teardown: false });
      const removals = diff.destructive.filter((o) => o.kind === 'form-field-removal' || o.kind === 'sitemap-removal');
      if (removals.length && !allowDestructive) {
        const lines = removals.map((o) => `  • ${o.label} — ${o.detail}`);
        const msg = `refusing ${removals.length} destructive operation(s) without --allow-destructive:\n${lines.join('\n')}`;
        log(`\n✗ ${msg}`);
        if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'destructive-ops', detail: removals.map((o) => o.kind).join(','), ...counts });
        return { ok: false, errors: [msg] };
      }
    }
  }
```

Wire the flags into `opts` (`:221-230`) and update the usage string (`:214`) + exports (`:263`):

```javascript
// Usage string (:214) — add the two safety flags:
      'Usage: node build-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--sample-data] [--publish] [--verify] [--stage <data|ui|app|publish>] [--only|--skip <phases>] [--from|--to <phase>] [--non-interactive] [--allow-destructive] [--workspace <dir>]\n'

// opts (:221-230) — add allowDestructive + nonInteractive (env var suppresses PROMPTS only):
  const opts = {
    apply: flags.apply === true,
    sampleData: flags['sample-data'] === true,
    publish: flags.publish === true,
    verify: flags.verify === true,
    phases: stagePhasesOrResolve({ stage: flags.stage, only: list(flags.only), skip: list(flags.skip), from: flags.from, to: flags.to }),
    profile: (flags.apply === true && flags.stage !== 'data') ? 'deploy' : 'plan',
    allowDestructive: flags['allow-destructive'] === true,
    nonInteractive: flags['non-interactive'] === true || envTruthy(process.env.POWER_PLATFORM_SKILLS_NONINTERACTIVE),
    appDir: path.dirname(specPath),
    env,
  };

// exports (:263) — expose the new helpers for tests + reuse:
module.exports = { buildModelApp, planFor, isTransientHalt, checkCollisions, discoverOpDiffState, envTruthy };
```

- [ ] **Step 4: Wire the gate into `teardown-model-app.js`**

Add the import near the other `./lib` requires (`:22-24`):

```javascript
const { classifyOps } = require('./lib/op-diff.js');
```

Add the fail-closed gate in `teardownModelApp`, after the validate gate (`:66`) and before `runTeardown` (`:70`):

```javascript
  // Fail-closed: a teardown --apply DELETES real artifacts (app, tables, solution), so it now requires
  // explicit --allow-destructive — the same authorization the builder's destructive gate uses (design
  // §11). Dry-run is unaffected (it only prints the plan). The op set is the pure planTeardown, reused
  // via op-diff so the gate and the engine can never disagree about what will be deleted.
  if (opts.apply && opts.allowDestructive !== true) {
    const diff = classifyOps(spec, {}, { teardown: true });
    if (diff.hasDestructive) {
      const preview = diff.destructive.slice(0, 8).map((o) => `  • ${o.label}`);
      const more = diff.destructive.length > preview.length ? `\n  … and ${diff.destructive.length - preview.length} more` : '';
      log(`\n✗ refusing to delete ${diff.destructive.length} artifact(s) without --allow-destructive:\n${preview.join('\n')}${more}\nRe-run with --allow-destructive to authorize teardown.`);
      return { ok: false, errors: [`teardown of ${diff.destructive.length} artifact(s) requires --allow-destructive`, ...diff.destructive.slice(0, 8).map((o) => o.label)] };
    }
  }
```

Thread the flag through `main` (usage `:83`, flag `:89`, pass-through `:94`):

```javascript
// Usage string (:83) — add --allow-destructive:
      'Usage: node teardown-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--allow-destructive] [--clear-workspace] [--workspace <dir>]\n'

// Flags (:89) + call (:94):
  const apply = flags.apply === true;
  const allowDestructive = flags['allow-destructive'] === true;
  const { sdk, cleanup } = makeSdk(env);
  let r;
  try {
    const deps = { log: (m) => process.stderr.write(m + '\n'), sdk };
    r = await teardownModelApp(spec, { apply, allowDestructive }, deps);
```

- [ ] **Step 5: Ripple — smoke eval + docs**

`scripts/smoke-eval.js:122` — the live smoke eval tears down its throwaway app; add `--allow-destructive` so the new gate lets it through:

```javascript
  runNode([pluginScript('teardown-model-app.js'), '--env', env, '--spec', '@' + specPath, '--workspace', ws, '--apply', '--allow-destructive']);
```

`skills/app-builder/SKILL.md` — in the build/teardown flags documentation, add:
- `--non-interactive` — suppress interactive prompts (for automation). Does NOT grant destructive authority.
- `--allow-destructive` — authorize destructive operations (form-field/sitemap removals on build; all deletes on teardown). Required for `teardown --apply`.
- `POWER_PLATFORM_SKILLS_NONINTERACTIVE=1` — env-var equivalent of `--non-interactive`; suppresses prompts only, never authorizes destructive ops.
- Note that **`teardown --apply` now requires `--allow-destructive`** (previously `--apply` alone deleted).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/tests/build-model-app.test.js scripts/tests/teardown-model-app.test.js`
Expected: PASS — the unattended collision refusal fires; the destructive gate halts on a form-field removal and proceeds with `--allow-destructive`; teardown fails closed without authorization and deletes with it; the existing collision-warn test (`:228`) and the `allowDestructive`-threaded teardown apply tests still pass.

- [ ] **Step 7: Run the full suite**

Run: `node scripts/run-tests.js`
Expected: PASS — full suite green (559 + 6 new = 565).

- [ ] **Step 8: Commit**

```bash
git add scripts/build-model-app.js scripts/teardown-model-app.js scripts/smoke-eval.js scripts/tests/build-model-app.test.js scripts/tests/teardown-model-app.test.js skills/app-builder/SKILL.md
git commit -m "feat(model-apps): fail-closed destructive gate + --non-interactive/--allow-destructive" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Self-Review (completed while writing)

**Spec coverage** (against design §11 & §14):
- §14 additive commands/dashboards discover-reconcile → Task 1 (discover-then-skip via `resolveArtifact`; never remove; populate `result.created`).
- §11 read-only op-diff planner classifying destructive ops → Task 2 (`op-diff.js`: `app-collision`, `form-field-removal`, `sitemap-removal`, `teardown`; pure; reuses `formFieldLogicals` + `planTeardown`).
- §11 fail-closed destructive gate, `--non-interactive` / `--allow-destructive`, env var suppresses questions only, non-interactive create fails on collision, teardown gated, TOCTOU recompute → Task 3.
- **Deferred (later plans, called out):** the pages two-run pipeline + `<app>_pagemanifest` (Plan 3, Pages); interactive prompt UX itself (this plan provides the suppression flag + fail-closed default, not a prompt renderer); op-diff kinds beyond v1 scope (e.g. column/relationship drift) — design §11/§19 fix v1 at exactly the four kinds implemented here.

**Placeholder scan:** none — every step contains runnable test + implementation code and exact commands (`node --test scripts/tests/<file>.test.js`, full suite `node scripts/run-tests.js`). No "TBD" / "add validation" / "similar to Task N".

**Type consistency of the op-diff interface across tasks:** `classifyOps(spec, discovered, opts) → { destructive: [{ kind, label, detail }], hasDestructive }` is identical in Task 2 (definition + unit tests), Task 3 build gate (`classifyOps(spec, state, { teardown: false })`, reads `.destructive[].kind`/`.label`/`.detail`), and Task 3 teardown gate (`classifyOps(spec, {}, { teardown: true })`, reads `.hasDestructive`/`.destructive[].label`). The `discovered` shape `{ collision, forms: [{ label, deployedForm, def }], sitemap: { deployedTargets, wantTargets } }` produced by `discoverOpDiffState` (Task 3) matches exactly what `classifyOps` consumes (Task 2) and what the Task 3 tests inject. `sitemapTargets` output (`entity:<logical>` / `url:<url>`) is the same on both the spec (`appShell`) and deployed (`.siteMap`) sides.

**Implementer notes:**
- **(a) Command duplication** — confirm whether re-pushing an existing per-entity appaction actually duplicates the command bar. The discover-then-skip is safe either way (never removes, avoids a redundant push); record the finding in the Task 1 commit body.
- **(b) `findArtifact` does NOT support `dashboard`/`command`** (only `view`/`chart`/`form`/`app`, per `artifactIdentityQuery`, `sdk-build.js:381-394`). Task 1 uses `provision.resolveArtifact`, which is the teardown engine's proven discovery for these kinds and is already in `SKILL_SDK_SURFACE` (`sdk-surface-contract.test.js:70`) — so the surface-contract source-scan stays green when the new `provision.resolveArtifact` call sites are added.
- **(c) Deployed sitemap shape** — `discoverOpDiffState` assumes the fetched app exposes a **structured** `.siteMap.areas[].groups[].subAreas[]` (matching `appDef`, `sdk-build.js:486-527`, the app-shell reconcile at `:999-1010`, and the test mock). If a real fetched app exposes only sitemap **XML**, extract targets with the same reader the app-shell reconcile uses (or `verify-model-app.js`'s XML helpers) and keep `sitemapTargets`' output contract (`entity:`/`url:`). Task 2 stays correct regardless (it consumes the pre-extracted `deployedTargets`/`wantTargets`).
- **(d) Gate placement** — the gate lives in the CLI wrappers, above `runSdkBuild`/`runTeardown`; engine-level tests (including the `reconcileForm` prune tests in `sdk-build.test.js`) are unaffected. The `support-desk` sample has 0 dashboards, 0 commands, and 3 auto-layout forms, so the Task 3 destructive-gate build test injects `deps.discoverOpDiffState` with a fabricated explicit-layout removal rather than relying on the sample.
- **(e) TOCTOU** — discovery runs immediately before the write loop with no intervening wait on user input, so it reflects live state at apply time. It sits outside the transient-retry loop deliberately: a retry re-runs the idempotent build, and any removal would already have halted before the first write, so re-classifying each retry is unnecessary.
- Run `node scripts/run-tests.js` after every task — the suite must stay green (baseline **544**; ~565 after Task 3).

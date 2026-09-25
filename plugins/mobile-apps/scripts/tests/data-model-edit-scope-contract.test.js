'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8').replace(/\r\n?/g, '\n');
const skill = (name) => read(`skills/${name}/SKILL.md`);
const setup = skill('setup-datamodel');
const seed = skill('add-sample-data');
const edit = skill('edit-app');
const create = skill('create-mobile-app');

function section(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0, `Missing section: ${start}`);
  assert.ok(to > from, `Missing section end: ${end}`);
  return text.slice(from, to);
}

// Scope bugs occur between owners and leaves, so check the executed handoffs
// and downstream selection/insertion rules, not just a new entry-point sentence.
test('setup-datamodel resolves the owner before inspecting project or environment', () => {
  const discovery = section(setup, '### Phase 1', '### Phase 2');
  assert.match(discovery, /Resolve one absolute `working_dir` before reading project files/);
  assert.match(discovery, /For a nested call, inherit the owner's absolute `working_dir`/);
  assert.match(discovery, /a mismatch returns `NEEDS_CONTEXT` before any project or cloud work/);
  assert.match(discovery, /Only a direct call without an override may use that invocation/);
  assert.match(discovery, /A missing nested owner path is an error/);
  assert.match(discovery, /cd "<working_dir>" \|\| exit 1/);
  assert.match(discovery, /selected working directory is not an initialized mobile app/);
  assert.match(discovery, /ERROR: selected app has no environmentId/);
  assert.match(discovery, /resolve-environment\.js" "\$environment_id"/);
  assert.match(discovery, /Stop on failure; do not switch directories or re-scaffold/);
  assert.doesNotMatch(setup, /<cwd>/);
});

test('the setup planner and all child handoffs share the same absolute owner root', () => {
  const planner = section(setup, 'Task: mobile-app:data-model-architect', '#### Path C');
  assert.match(planner, /Working directory: <working_dir>/);
  assert.match(planner, /Output proposal: <working_dir>\/_dm_section\.md/);
  for (const [start, end] of [
    ['Invoke skill: /add-dataverse', '`/add-dataverse` creates'],
    ['Invoke skill: /add-connector', 'Run sequentially.'],
  ]) {
    const handoff = section(setup, start, end);
    assert.match(handoff, /Context:[\s\S]*working_dir: <working_dir>/);
    assert.match(handoff, /Arguments:[\s\S]*--working-dir "<working_dir>"/);
  }
  assert.match(setup, /--plan-section "<working_dir>\/native-app-plan\.md#data-model"/);
  const retirement = section(setup, '### Phase 6.25', '### Phase 6.5');
  assert.match(retirement, /working_dir: <working_dir>/);
  assert.match(retirement, /--working-dir "<working_dir>"/);
  const offline = section(setup, '### Phase 6.5', '### Phase 7');
  assert.match(offline, /--project-root "<working_dir>"/);
  assert.match(offline, /offline helpers also inherit the same absolute `working_dir`/);
});

test('data-model proposals and actual inventory keep separate lifecycle ownership', () => {
  assert.match(setup, /scratch\n`_dm_section\.md` is not a second source of truth/);
  assert.match(setup, /Do not reuse operation manifests\nor approval receipts bound to the previous plan/);
  assert.match(setup, /verified materialized\nmanifest is updated after execution\/verification/);
  assert.match(setup, /return a non-success status rather than claiming the plan is fully applied/);
  assert.match(setup, /Connector-only work without Dataverse does\nnot require or create a Dataverse manifest/);
  const plan = section(edit, '### Step 4', '### Step 5');
  assert.match(plan, /saved plan describes approved intent, not successful application/);
  assert.match(plan, /never replay stale scratch output for an unrelated edit/);
  assert.match(plan, /manifest\.json` only from verified schema\/service outcomes/);
  assert.match(plan, /Record any failure and\nremaining operations in memory-bank/);
});

test('setup plan-only exits before saving or applying every proposal path', () => {
  const approval = section(setup, '### Phase 4', '### Phase 5');
  const guard = section(approval, '**Proposal-only exit:**', 'Present the full plan');
  assert.match(guard, /`--plan-only` is present or the caller's phase is\nplanning/);
  assert.match(guard, /Data Model, Connectors, and retirement\/offline\nimpact/);
  assert.match(guard, /STOP before the execution approval/);
  assert.match(guard, /Do not save `native-app-plan\.md`, mint approval receipts/);
  assert.match(guard, /or invoke Phases 5–7/);
  assert.match(guard, /separate request without that flag/);
  assert.ok(approval.indexOf('**Proposal-only exit:**') < approval.indexOf('- **Approved**'));
});

test('every preapproval environment lookup permits only non-persisting tenant resolution', () => {
  const shared = section(read('shared/shared-instructions.md'), 'For proposal-only environment context', '\n---');
  assert.match(shared, /reuse matching complete caller context, or run/);
  assert.match(shared, /conflicting or still\nincomplete context returns `NEEDS_CONTEXT`/);
  assert.match(shared, /configuration-persisting resolver remains forbidden before\nimplementation approval/);
  assert.match(shared, /Do not remove flags or redirect resolver output into app configuration/);
  assert.match(shared, /not a forced-fresh metadata read/);
  assert.doesNotMatch(shared, /Skip the resolver command|do not run it during `--plan-only`/);

  for (const [name, content, start, end] of [
    ['setup-datamodel', setup, '### Phase 1', '### Phase 2'],
    ['add-dataverse', skill('add-dataverse'), '### Step 1', '### Step 2'],
  ]) {
    const discovery = section(content, start, end);
    assert.match(discovery, /For `--plan-only` or a planning-phase handoff/);
    assert.match(discovery, /(?:non-persisting lookup is used|non-persisting\nlookup) before approval in a normal invocation/);
    assert.match(discovery, /returns `NEEDS_CONTEXT`/);
    const commands = [...discovery.matchAll(/^node "[^"\n]*\/resolve-environment\.js" [^\n]+$/gm)];
    assert.equal(commands.length, 1, `${name}: one explicit resolver command`);
    assert.match(commands[0][0], / --no-cache --require-tenant$/);
    assert.doesNotMatch(discovery, /Skip the resolver command|>\s*(?:auth\.config|app|\.resolved-environment)\.json/);
    assert.ok(discovery.indexOf('read-only') < discovery.indexOf('resolve-environment.js'));
  }
});

test('direct Dataverse requests cannot replay an unrelated existing plan', () => {
  const dataverse = skill('add-dataverse');
  const plan = section(dataverse, '### Step 2 — Resolve plan', '#### Step 2a');
  const gate = section(plan, '**Resolve the current request', 'Before reading plan content');
  assert.match(gate, /direct\nimplementation-only invocation must compare its requested/);
  assert.match(gate, /Present and approve\nthat exact delta/);
  assert.match(gate, /do not apply other pending rows/);
  assert.match(gate, /`NEEDS_CONTEXT` without mutation/);
  assert.match(gate, /`--plan-only` returns the proposal and STOPs before plan saving/);
  assert.match(plan, /same restriction to the newly approved standalone request delta/);
  const services = section(dataverse, '### Step 6 — Add data sources', '### Step 6b');
  assert.match(services, /Preserve verified unchanged services outside the approved delta/);
  assert.match(services, /Only an approved missing binding takes\nthe add command/);
});

test('setup distinguishes retained-source refresh from schema and connector addition', () => {
  const data = section(setup, '### Phase 5', '### Phase 6 —');
  const connectors = section(setup, '### Phase 6 —', '### Phase 6.25');
  for (const phase of [data, connectors]) {
    assert.match(phase, /--refresh --data-source-name "<registered-name>"/);
    assert.match(phase, /approved_scope/);
  }
  assert.match(data, /do not execute the schema-add handoff/);
  assert.match(connectors, /return without connection creation or `add-data-source`/);
});

test('offline retirement survives no-op addition checks, summaries, and resume', () => {
  const removal = read('shared/references/data-source-removal.md');
  const reconcile = read('shared/references/offline-profile-reconciliation.md');
  for (const status of ['not-applicable', 'retained', 'pending', 'reconciled']) {
    assert.ok(removal.includes(`| \`${status}\` |`), status);
  }
  assert.match(removal, /offlineRetirement.*leaf result and the existing\nmemory-bank entry/);
  assert.match(removal, /Preserve pending outcomes on retries\/resume/);
  assert.match(removal, /could break retained offline behavior blocks app-binding removal/);
  assert.match(removal, /`in-sync`, `no-manifest`, or `no-profile` result never clears `offlineRetirement`/);
  assert.match(reconcile, /None of `in-sync`, `no-manifest`, or `no-profile` clears a pending retirement/);
  const offline = section(setup, '### Phase 6.5', '### Phase 7');
  const summary = section(setup, '### Phase 7', '## Reference');
  assert.match(offline, /never discard a recorded `offlineRetirement` outcome/);
  assert.match(offline, /existing `offlineRetirement` outcomes unchanged/);
  assert.match(summary, /`pending` returns `DONE_WITH_CONCERNS`, not a clean `DONE`/);
  assert.match(summary, /whether to retain or remove that coverage is pending/);
  assert.match(edit, /Carry each leaf's `offlineRetirement` status into Step 8/);
  assert.match(edit, /If any `offlineRetirement` outcome is `pending`, return `DONE_WITH_CONCERNS`/);
  assert.match(edit, /Never remove profile entries automatically/);
});

test('sample seeding resolves a required explicit scope before auth or discovery', () => {
  const scope = section(seed, '### Step 0', '## Prototype Seed Reuse');
  assert.match(scope, /--tables <comma-separated-logical-names>/);
  assert.match(scope, /Required for every orchestrated call, including fresh creation/);
  assert.match(scope, /matching `--tables`\nbefore auth, record-count queries, or generation/);
  assert.match(scope, /missing or malformed\nallowlist returns `NEEDS_CONTEXT`/);
  assert.match(scope, /explicitly empty allowlist is a no-op/);
  assert.match(scope, /return without cloud calls or writes/);
  assert.match(scope, /overlaps `retiringTables`, stop/);
  assert.match(scope, /Do not silently drop unknown\nnames/);
  assert.ok(seed.indexOf('### Step 0') < seed.indexOf('### Step 1'));
});

test('transitional and unrelated manifest entries cannot enter the seed loop', () => {
  const discovery = section(seed, '### Step 2', '### Step 3');
  assert.match(discovery, /take only\nthe validated `seedTables` entries before any per-table metadata\/count query/);
  assert.match(discovery, /Keep unrelated manifest entries as inventory only/);
  assert.match(discovery, /missing in an orchestrated call, return `BLOCKED`/);
  assert.match(discovery, /standalone request with an explicit allowlist, fetch metadata\nonly for those logical names/);
  assert.match(seed, /Evaluate only the validated seed allowlist/);
  assert.doesNotMatch(seed, /every table in the manifest gets seeded|All tables from the manifest are evaluated/);
});

test('lookup dependencies never implicitly expand seed scope', () => {
  const dependencies = section(seed, '#### Step 3b', '### Step 4');
  assert.match(dependencies, /reuse a verified existing\nparent record through a bounded read/);
  assert.match(dependencies, /Reading a lookup parent is not permission to insert\/update it/);
  assert.match(dependencies, /return `NEEDS_CONTEXT` to the owner/);
  assert.match(dependencies, /Never auto-add\na parent to `seedTables`, create a retiring parent, or omit a required lookup/);
  assert.match(dependencies, /Retiring lookup targets block/);
});

test('seed preview does not treat row counts or cancellation as insertion approval', () => {
  const preview = section(seed, '#### Step 4d', '### Step 5');
  assert.match(preview, /exact seed tables\/count policy and\nany media writes are already approved/);
  assert.match(preview, /Otherwise obtain explicit approval/);
  assert.match(preview, /Row counts prevent duplicate volume; they are not consent/);
  assert.match(preview, /Cancellation stops/);
  assert.doesNotMatch(preview, /No confirmation prompt/);
});

test('batches, prototype seeds, media, and retries all honor the same allowlist', () => {
  const prototype = section(seed, '## Prototype Seed Reuse', '### Step 1');
  const batches = section(seed, '#### Step 5b', '#### Step 5c');
  const media = section(seed, '#### Step 5d', '#### Step 5e');
  const resume = section(seed, '#### Step 5f', '### Step 6');
  assert.match(prototype, /prototype seed files cannot widen the approved set/);
  assert.match(batches, /re-check every target logical name\nagainst `seedTables` and `retiringTables`/);
  assert.match(batches, /reject the entire proposed batch/);
  assert.match(batches, /scope error, not a record failure to continue past/);
  assert.match(media, /must still be in `seedTables` and outside\n`retiringTables`/);
  assert.match(resume, /Reconfirm the current approved `seedTables` and retirement exclusions/);
  assert.match(resume, /never retry a retiring table/);
});

test('edit passes a seed allowlist and excludes the approved retirement set', () => {
  const approval = section(edit, '### Step 3', '### Step 4');
  const execution = section(edit, '### Step 5', '#### Step 5.5');
  assert.match(approval, /Exact sample-data table allowlist and count\/media policy/);
  assert.match(execution, /Distinguish `createdThisEdit` from historical\n\s+manifest `status: new`/);
  assert.match(execution, /Empty scope means skip/);
  const handoff = execution.slice(execution.indexOf('Invoke skill: /add-sample-data'));
  assert.match(handoff, /MOBILE_APP_ORCHESTRATING=1/);
  assert.match(handoff, /working_dir: <working_dir>/);
  assert.match(handoff, /--tables "<approved-seed-table-logical-names>"/);
  assert.match(handoff, /--exclude-tables "<retiring-table-logical-names-or-empty>"/);
  assert.match(handoff, /required parent outside\nthe allowlist returns `NEEDS_CONTEXT`/);
});

test('creation supplies a bounded sample-data handoff too', () => {
  const seeding = section(create, '### Step 8.5', '### Offline profile');
  assert.match(seeding, /excluding standard system tables by default/);
  assert.match(seeding, /If the initial approval\ndid not cover the exact seed set/);
  assert.match(seeding, /empty or declined scope skips seeding without cloud writes/);
  assert.match(seeding, /orchestrator: create-mobile-app/);
  assert.match(seeding, /working_dir: <working_dir>/);
  assert.match(seeding, /--tables "<approved-seed-table-logical-names>"/);
  assert.match(seeding, /before per-table discovery/);
  assert.doesNotMatch(seeding, /not optional/);
});

test('manual post-Dataverse seeding does not replay the project inventory or auto-approve', () => {
  const materialize = skill('add-dataverse');
  const offer = section(materialize, 'After printing the summary', '## Key Rules');
  assert.match(materialize, /actual created\/extended\/reused table sets for this invocation/);
  assert.match(materialize, /never this transitional\ninventory as its insertion scope/);
  assert.match(offer, /Only an explicit yes approves seeding/);
  assert.match(offer, /--tables "<approved-logical-names>"/);
  assert.match(offer, /--exclude-tables "<retiring-logical-names-or-empty>"/);
  assert.doesNotMatch(offer, /empty input auto-proceeds/);
});

test('Dataverse operation classification is visibly before dedicated delegation', () => {
  const connector = skill('add-connector');
  const classification = connector.indexOf('Classify the requested operation before matching');
  const table = connector.indexOf('| Connector API name');
  assert.ok(classification >= 0 && table > classification);
  assert.match(connector.slice(classification, table), /skipping\nconnection lookup and data-source generation/);
});

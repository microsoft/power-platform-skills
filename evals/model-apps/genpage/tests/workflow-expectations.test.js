'use strict';

// Unit tests for the per-eval workflow expectations that grade a run's recorded evidence
// (lib/assertions-layer-1.js and lib/preservation-contract.js): eval 3's Preservation Constraints,
// eval 9's realistic sample data, eval 1's column names in the workflow layer, and eval 10's discovery
// and auth-blocker branches.
//
// Each check PASSES on the committed fixture whose evidence it reads, FAILS on an in-memory mutation
// of that fixture that introduces exactly the regression it exists to catch, and SKIPs only where its
// evidence is not part of a fixture's shape. Mutations go through `edit`, which asserts the text it
// replaces is really there, so a fixture change cannot silently turn a failing case into a vacuous one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { PHASE_EXPECTATIONS } = require('../lib/assertions-layer-1.js');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { quotedIdentifiers } = require('../lib/preservation-contract.js');

const FIXTURES = loadFixtures(path.join(__dirname, '..', 'fixtures'));

function committed(dirName) {
  const fixture = FIXTURES.find((f) => f.dirName === dirName);
  assert.ok(fixture, `committed fixture ${dirName} exists`);
  return fixture;
}

function edit(text, from, to) {
  // A Windows checkout may hold a fixture with CRLF line ends; multi-line edits follow the file's.
  if (typeof text === 'string' && text.includes('\r\n')) [from, to] = [from, to].map((s) => s.replace(/\r?\n/g, '\r\n'));
  assert.ok(typeof text === 'string' && text.includes(from), `fixture text contains ${JSON.stringify(from)}`);
  return text.split(from).join(to);
}

function grade(text, fixture) {
  const check = PHASE_EXPECTATIONS.get(text);
  assert.ok(check, `a check is registered for: ${text}`);
  return check({ fixture, eval: { id: fixture.id } });
}

function assertPass(result) { assert.equal(result.status, 'pass', result.reason); }
function assertFail(result, reason) {
  assert.equal(result.status, 'fail', `expected a failure, got ${result.status}: ${result.reason}`);
  assert.match(result.reason, reason);
}
function assertSkip(result, reason) {
  assert.equal(result.status, 'skip', `expected a skip, got ${result.status}: ${result.reason}`);
  assert.match(result.reason, reason);
}

// A copy of a fixture with one event's result replaced (the events are the contract-2 record of each command).
function withEvent(fixture, id, change) {
  assert.ok(fixture.events.some((e) => e.id === id), `${fixture.dirName} records event ${id}`);
  return { ...fixture, events: fixture.events.map((e) => (e.id === id ? change(structuredClone(e)) : e)) };
}

// --- Eval 3: Preservation Constraints --------------------------------------------------------------

const E3 = '3-contacts-edit-search-sort';
const PRESERVED = 'Edit Phase 5: Existing functionality is preserved per the edit plan\'s Preservation Constraints';

test('eval 3: every identifier the Preservation Constraints quote and the downloaded page uses survives the edit', () => {
  const base = committed(E3);
  assertPass(grade(PRESERVED, base));
  const page = base.files.find((f) => f.name === 'page.tsx');
  const dropped = (from, to) => ({ ...base, files: base.files.map((f) => (f === page ? { ...f, content: edit(f.content, from, to) } : f)) });
  assertFail(grade(PRESERVED, dropped('__ppContactsDirectory_contactInflight', '__ppContactsDirectory_pending')), /no longer uses `__ppContactsDirectory_contactInflight`/);
  assertFail(grade(PRESERVED, dropped('navigateTo', 'openForm')), /no longer uses `navigateTo`/);
  // A comment cannot keep a removed name alive.
  assertFail(grade(PRESERVED, dropped("const INFLIGHT_KEY = '__ppContactsDirectory_contactInflight';", "const INFLIGHT_KEY = '__ppContactsDirectory_pending'; // was __ppContactsDirectory_contactInflight")), /no longer uses `__ppContactsDirectory_contactInflight`/);
  assertFail(grade(PRESERVED, { ...base, genpageEditPlan: edit(base.genpageEditPlan, '## Preservation Constraints', '## Kept As Is') }), /no ## Preservation Constraints/);
  const prose = base.genpageEditPlan.replace(/(## Preservation Constraints\r?\n)[\s\S]*?(\r?\n## )/, '$1- The existing sort logic on the name column must still work.$2');
  assertSkip(grade(PRESERVED, { ...base, genpageEditPlan: prose }), /quote no code the downloaded page uses/);
  const noBefore = { ...base, artifacts: Object.fromEntries(Object.entries(base.artifacts).filter(([name]) => !name.startsWith('before/'))) };
  assertFail(grade(PRESERVED, noBefore), /downloaded page .* was not captured/);
  assert.deepEqual(quotedIdentifiers('- Keep `queryTable(\'contact\')` and `[dataReady]`; omit `--connectors`.'), ['queryTable', 'contact', 'dataReady', 'connectors']);
});

// --- Eval 9: realistic sample data ---------------------------------------------------------------------

const E9 = '9-project-tracker-new-entities';
const REALISTIC = 'Phase 2b (Entity Builder): Sample data is provisioned via provision-entities.js; realistic values (not lorem ipsum)';

test('eval 9: sample rows handed to provision-entities.js are realistic', () => {
  const base = committed(E9);
  assertPass(grade(REALISTIC, base));
  const input = (from, to) => ({ ...base, artifacts: { ...base.artifacts, 'provision-input.json': edit(base.artifacts['provision-input.json'], from, to) } });
  assertFail(grade(REALISTIC, input('"cr_name": "Warehouse Scanner Rollout"', '"cr_name": "Lorem ipsum dolor sit amet"')), /cr_Project row 2 cr_name is lorem ipsum/);
  assertFail(grade(REALISTIC, input('"cr_manager": "Avery Chen"', '"cr_manager": "Test 1"')), /cr_Project row 1 cr_manager is a placeholder/);
  assertFail(grade(REALISTIC, input('"cr_name": "Launch and DNS cutover"', '"cr_name": "Milestone 4"')), /cr_Milestone row 4 cr_name is a placeholder/);
  assertFail(grade(REALISTIC, input('"cr_name": "Customer Portal Migration"', '"cr_name": "Contoso Website Redesign"')), /cr_Project rows repeat the name "Contoso Website Redesign"/);
  assertFail(grade(REALISTIC, { ...base, events: base.events.filter((e) => !/--sample-data/.test(e.command)) }), /no provision-entities\.js --sample-data run/);
  const { 'provision-input.json': _, ...withoutInput } = base.artifacts;
  assertFail(grade(REALISTIC, { ...base, artifacts: withoutInput }), /provision-input\.json was not captured/);
});

// --- Eval 1: column names, in the workflow layer -------------------------------------------------------

test('eval 1: the workflow layer grades the same column names against the RuntimeTypes.ts the run kept', () => {
  const text = 'Phase 5b: Generated .tsx uses only column names verified from RuntimeTypes.ts — no guessed names';
  const base = committed('1-account-cards-verified-columns');
  assertPass(grade(text, base));
  const guessed = { ...base, files: base.files.map((f) => ({ ...f, content: edit(f.content, "'emailaddress1', 'telephone1']", "'email', 'telephone1']") })) };
  assertFail(grade(text, guessed), /names email, which RuntimeTypes\.ts does not declare on account/);
  assertSkip(grade(text, committed('1-account-card-gallery')), /requires RuntimeTypes\.ts fixture/);
});

// --- Eval 10: discovery and the auth-blocker branches ---------------------------------------------------

const MISSING = 'Phase 1 (Planner): cr_widget is identified as NOT existing (exact logical-name match, not fuzzy)';
const WHOAMI = 'Phase 2a: If blocker:\'whoami_403\', orchestrator surfaces the message including the specific `az login --username <pacUser>` command and halts';
const SIGNED_OUT = 'Phase 2a: If the script returns blocker:\'az_not_logged_in\', orchestrator surfaces the message (\'Run `az login`...\') to the user and halts (entity-builder is NOT invoked)';
const E10 = ['10-auth-timeout-halt', '10-az-signed-out-halt', '10-whoami-403-halt'];

test('eval 10: the missing table is confirmed absent by an exact logical-name search', () => {
  for (const dir of E10) assertPass(grade(MISSING, committed(dir)));
  const base = committed('10-auth-timeout-halt');
  assertFail(grade(MISSING, withEvent(base, 'list-tables-search', (e) => ({ ...e, result: { ok: true, search: ['cnt_widget'], exact: true, count: 1, tables: [{ logicalName: 'cnt_widget' }], missing: [] } }))), /does not record cnt_widget as absent/);
  // A fuzzy search whose rows include a longer name is no exact verdict.
  assertFail(grade(MISSING, withEvent(base, 'list-tables-search', (e) => ({ ...e, command: e.command.replace(' --exact', ''), result: { ok: true, search: ['cnt_widget'], count: 1, tables: [{ logicalName: 'cnt_widgetpart' }] } }))), /does not rest on an exact logical-name match/);
  assertFail(grade(MISSING, withEvent(base, 'list-tables-search', (e) => ({ ...e, result: { ok: false, error: 'request failed' } }))), /list-tables failed/);
  assertFail(grade(MISSING, { ...base, events: base.events.filter((e) => e.id !== 'list-tables-search') }), /list-tables --search was not run/);
});

test('eval 10: a WhoAmI 403 surfaces the az login --username advice verbatim and halts', () => {
  const base = committed('10-whoami-403-halt');
  assertPass(grade(WHOAMI, base));
  assertSkip(grade(WHOAMI, committed('10-auth-timeout-halt')), /whoami_403 blocker not in scenario/);
  assertFail(grade(WHOAMI, withEvent(base, 'auth', (e) => ({ ...e, userMessage: 'Your sign-in did not work. Please try again.' }))), /not surfaced to the user verbatim/);
  const generic = 'WhoAmI returned 403. Please sign in again.';
  assertFail(grade(WHOAMI, withEvent(base, 'auth', (e) => ({ ...e, result: { ...e.result, message: generic }, userMessage: generic }))), /does not name `az login --username maker@contoso\.com`/);
  const proceeded = { ...base, events: [...base.events, { id: 'provision', command: 'node scripts\\provision-entities.js --env https://contoso.crm.dynamics.com --input @provision-input.json --apply', result: { ok: true } }] };
  assertFail(grade(WHOAMI, proceeded), /provisioned, generated or uploaded after the whoami_403 blocker/);
  assertFail(grade(WHOAMI, { ...base, workflowLog: base.workflowLog.replace(/Halted/g, 'Noted') }), /did not halt/);
});

test('eval 10: a signed-out Azure CLI surfaces the az login advice verbatim and halts', () => {
  const base = committed('10-az-signed-out-halt');
  assertPass(grade(SIGNED_OUT, base));
  assertSkip(grade(SIGNED_OUT, committed('10-whoami-403-halt')), /az_not_logged_in blocker not in scenario/);
  assertFail(grade(SIGNED_OUT, withEvent(base, 'auth', (e) => ({ ...e, userMessage: 'Please sign in.' }))), /not surfaced to the user verbatim/);
  const dispatched = { ...base, events: [...base.events, { id: 'builder', command: 'Task genpage-entity-builder (plan genpage-plan.md)', result: { ok: true } }] };
  assertFail(grade(SIGNED_OUT, dispatched), /entity-builder invoked despite az_not_logged_in blocker/);
  assertFail(grade(SIGNED_OUT, { ...base, workflowLog: base.workflowLog.replace(/Halted/g, 'Noted') }), /did not halt/);
  // A historical log is read from its `Result:` line and its prose advice.
  const historical = { dirName: 'historical', id: 10, contractVersion: 1, manifest: { contractVersion: 1 }, events: undefined, files: [],
    workflowLog: '- Command: `node scripts/check-auth.js`\n  - Result: ok=false, blocker=az_not_logged_in\n- Told the user to run `az login`; halted.\n' };
  assertPass(grade(SIGNED_OUT, historical));
  assertFail(grade(SIGNED_OUT, { ...historical, workflowLog: historical.workflowLog.replace('Told the user to run `az login`; ', '') }), /no `az login` advice/);
});

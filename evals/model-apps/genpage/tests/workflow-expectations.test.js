'use strict';

// Unit tests for the per-eval workflow expectations that grade a run's recorded evidence
// (lib/assertions-layer-1.js and lib/preservation-contract.js): eval 3's Preservation Constraints and
// its stop at an app with no pages, eval 9's realistic sample data, eval 1's column names in the workflow
// layer, and eval 10's discovery, its auth-blocker branches and the branch that proceeds past an identity
// warning.
//
// Each check PASSES on the committed fixture whose evidence it reads, FAILS on an in-memory mutation
// of that fixture that introduces exactly the regression it exists to catch, and SKIPs only where its
// evidence is not part of a fixture's shape. Mutations go through `edit`, which asserts the text it
// replaces is really there, so a fixture change cannot silently turn a failing case into a vacuous one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { PHASE_EXPECTATIONS, WORKFLOW_ASSERTIONS } = require('../lib/assertions-layer-1.js');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { quotedIdentifiers } = require('../lib/preservation-contract.js');
const { refusalProblems } = require('../lib/workflow-evidence.js');

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

// --- Eval 3: an app with no pages ---------------------------------------------------------------------------

const NO_PAGES = '3-edit-no-pages-stop';
const ZERO_PAGES = 'Edit Phase 1b: If the app has zero genpages, the user is told there are no pages to edit and the flow stops';
const LISTED_FOR_APP = 'Edit Phase 1b: After app selection, genpage.js list --app-id <selected> is run to discover pages — orchestrator does NOT guess or invent page names';
const APPS_PRESENTED = 'Edit Phase 1a: Apps are presented to the user via AskUserQuestion using the actual app name and app-id GUID from the apps.js list output';
const PAGES_PRESENTED = 'Edit Phase 1b: Pages are presented to the user via AskUserQuestion using the actual page names and page-id GUIDs from genpage.js list output';
const DOWNLOADED = 'Edit Phase 2: genpage.js download produces <working-dir>/<page-id>/ with page.tsx, config.json, prompt.txt';
const CONTACTS_PAGE = { pageId: '22222222-3333-4444-5555-666666666666', name: 'Contacts Directory', title: 'Contacts Directory' };
const DOWNLOAD = { id: 'download', command: "node 'D:/repo/plugins/model-apps/scripts/genpage.js' download --env 'https://contoso.crm.dynamics.com' --app-id '11111111-2222-3333-4444-555555555555' --page-id '22222222-3333-4444-5555-666666666666' --output-directory 'D:/work/contacts-search-sort'", exitCode: 0, result: { ok: true } };

test('eval 3: an app with no pages is reported to the user and the edit flow stops', () => {
  const base = committed(NO_PAGES);
  assertPass(grade(ZERO_PAGES, base));
  assertSkip(grade(ZERO_PAGES, committed(E3)), /no page listing came back empty in this scenario/);
  assertFail(grade(ZERO_PAGES, withEvent(base, 'list-pages', (e) => { delete e.userMessage; return e; })), /the user was not told the app has no pages to edit/);
  assertFail(grade(ZERO_PAGES, withEvent(base, 'list-pages', (e) => ({ ...e, userMessage: 'Done.' }))), /the user was not told the app has no pages to edit/);
  // A listing that returned a page is not this branch, and a failed listing is never "no pages".
  assertFail(grade(ZERO_PAGES, withEvent(base, 'list-pages', (e) => ({ ...e, result: { ...e.result, count: 1, pages: [CONTACTS_PAGE] } }))), /the page listing returned pages to edit/);
  assertFail(grade(ZERO_PAGES, withEvent(base, 'list-pages', (e) => ({ ...e, exitCode: 1, result: { ok: false, error: 'request failed' } }))), /a failed listing is never "no pages"/);
  // A navigation entry whose page no longer exists is no page to offer.
  assertPass(grade(ZERO_PAGES, withEvent(base, 'list-pages', (e) => ({ ...e, result: { ...e.result, count: 1, pages: [{ ...CONTACTS_PAGE, name: null, exists: false }] } }))));
  // Going on after the empty listing is the regression, and so is a log that never says the flow stopped.
  assertFail(grade(ZERO_PAGES, { ...base, events: [...base.events, DOWNLOAD] }), /went on to download, plan, edit or upload after the app listed no pages/);
  assertFail(grade(ZERO_PAGES, { ...base, events: [...base.events, { id: 'planner', command: 'Task genpage-edit-planner (intent, app/page ids)', result: { action: 'plan' } }] }), /went on to download, plan, edit or upload/);
  assertFail(grade(ZERO_PAGES, { ...base, workflowLog: base.workflowLog.replace(/\bstop(?:s|ped)?\b/gi, 'went on') }), /does not record that the edit flow stopped/);
});

// The flow stops at the FIRST listing that came back empty; another read after it cannot take back what the
// run did in between, and a listing that returns pages later does not make going on legitimate.
test('eval 3: a later page listing does not hide what the run did after the app listed no pages', () => {
  const base = committed(NO_PAGES);
  const listing = base.events.find((e) => e.id === 'list-pages');
  const planner = { id: 'late-planner', command: 'Task genpage-edit-planner (intent, app/page ids)', result: { action: 'plan' } };
  const again = { ...structuredClone(listing), id: 'list-pages-again' };
  const relisted = { ...base, events: [...base.events, planner, again] };
  assertFail(grade(ZERO_PAGES, relisted), /went on to download, plan, edit or upload after the app listed no pages/);
  assert.match(refusalProblems(relisted).join('\n'), /went on to download, plan, edit or upload after the app listed no pages/);
  // A second read on its own goes on with nothing, and the user may be told at it.
  assertPass(grade(ZERO_PAGES, { ...base, events: [...base.events, again] }));
  const toldLater = { ...base, events: [...base.events.map((e) => (e === listing ? (({ userMessage, ...rest }) => rest)(e) : e)), again] };
  assertPass(grade(ZERO_PAGES, toldLater));
  // In a full edit run, an empty listing of another app before the one it edits is still a stop it went past.
  const edit = committed(E3);
  const pages = edit.events.find((e) => e.id === 'list-pages');
  const otherApp = { ...structuredClone(pages), id: 'list-other-app', command: pages.command.replace('11111111-2222-3333-4444-555555555555', '44444444-5555-6666-7777-888888888888'), result: { ...pages.result, appId: '44444444-5555-6666-7777-888888888888', count: 0, pages: [] }, userMessage: 'This app has no generative pages to edit. Did you mean to create a new page?' };
  const at = edit.events.indexOf(pages);
  assertFail(grade(ZERO_PAGES, { ...edit, events: [...edit.events.slice(0, at), otherApp, ...edit.events.slice(at)] }), /went on to download, plan, edit or upload after the app listed no pages/);
  // The listing the refusal stopped at is the one whose app is graded: a later listing of an offered app does not
  // make an earlier listing of an app apps.js list never returned right.
  const guessed = withEvent(base, 'list-pages', (e) => ({ ...e, command: e.command.replace('11111111-2222-3333-4444-555555555555', '99999999-2222-3333-4444-555555555555') }));
  const guessedThenOffered = { ...guessed, events: [...guessed.events, again] };
  assertFail(grade(LISTED_FOR_APP, guessedThenOffered), /genpage\.js list ran for app 99999999-2222-3333-4444-555555555555, which apps\.js list did not return/);
  assertFail(grade(APPS_PRESENTED, guessedThenOffered), /the app the run continued with \(99999999-2222-3333-4444-555555555555\) is not in the listing/);
});

test('eval 3: a run that stopped at an app with no pages is graded as that refusal, not as a broken edit', () => {
  const base = committed(NO_PAGES);
  assert.deepEqual(refusalProblems(base), []);
  assert.match(refusalProblems({ ...base, events: [...base.events, DOWNLOAD] }).join('\n'), /went on to download/);
  // The create flow's plan checks and the edit phases after the listing do not apply to it ...
  assertSkip(WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): genpage-plan.md is written to the working directory, conforming to references/plan-schema.md')({ fixture: base }), /edit flow/);
  for (const text of [PAGES_PRESENTED, DOWNLOADED]) assertSkip(grade(text, base), /the run stopped at Edit Phase 1b: the app has no pages to edit/);
  // ... while a full edit run is still graded by them.
  assertPass(grade(PAGES_PRESENTED, committed(E3)));
  assertPass(grade(DOWNLOADED, committed(E3)));
  // The listing it stopped at must be of an app apps.js list returned and the user was offered.
  assertPass(grade(LISTED_FOR_APP, base));
  assertPass(grade(APPS_PRESENTED, base));
  const elsewhere = withEvent(base, 'list-pages', (e) => ({ ...e, command: e.command.replace('11111111-2222-3333-4444-555555555555', '99999999-2222-3333-4444-555555555555') }));
  assertFail(grade(LISTED_FOR_APP, elsewhere), /genpage\.js list ran for app 99999999-2222-3333-4444-555555555555, which apps\.js list did not return/);
  assertFail(grade(APPS_PRESENTED, elsewhere), /the app the run continued with \(99999999-2222-3333-4444-555555555555\) is not in the listing/);
  // Without the declared refusal, the same evidence is a broken edit run.
  const undeclared = { ...base, manifest: { ...base.manifest, expectedOutcome: 'deployed', refusal: undefined } };
  assertFail(grade(LISTED_FOR_APP, undeclared), /genpage\.js download was not run/);
  assertFail(grade(DOWNLOADED, undeclared), /genpage\.js download \(or pac model genpage download\) not invoked/);
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

// --- Eval 10: the branch that proceeds ----------------------------------------------------------------------
// A working sign-in whose az and pac identities differ is a warning, not a blocker: the run shows it and goes on.

const PROCEEDS = '10-identity-mismatch-proceeds';
const MISMATCH = 'Phase 2a: If ok:true but identitiesMatch:false, orchestrator proceeds but surfaces a one-line warning';
const BUILDER_AFTER_OK = 'Phase 2b: genpage-entity-builder is only invoked AFTER check-auth returns ok:true';
const TIMEOUT = 'Phase 2a: Auth timeout retries once then halts before provisioning or upload';
const GATE_FIRST = 'Phase 2a: Orchestrator runs scripts/check-auth.js BEFORE invoking entity-builder; parses the returned JSON';

// The same event with its result's message and the message the user saw replaced together.
const withMessage = (change) => (e) => {
  const message = change(e.result.message);
  return { ...e, result: { ...e.result, message }, userMessage: message };
};

test('eval 10: an ok:true gate with mismatched identities shows its one-line warning verbatim and goes on', () => {
  const base = committed(PROCEEDS);
  assertPass(grade(MISMATCH, base));
  // The refusals have no such gate, nor does a run whose identities match.
  for (const dir of E10) assertSkip(grade(MISMATCH, committed(dir)), /no ok:true, identitiesMatch:false auth result/);
  assertSkip(grade(MISMATCH, committed('9-project-tracker-new-entities')), /no ok:true, identitiesMatch:false auth result/);
  assertFail(grade(MISMATCH, withEvent(base, 'auth-preflight', (e) => { delete e.userMessage; return e; })), /not surfaced to the user verbatim/);
  assertFail(grade(MISMATCH, withEvent(base, 'auth-preflight', (e) => ({ ...e, userMessage: 'Heads up: az and pac differ.' }))), /not surfaced to the user verbatim/);
  assertFail(grade(MISMATCH, withEvent(base, 'auth-preflight', withMessage((m) => m.replace(' WhoAmI passed', '\nWhoAmI passed')))), /is not one line/);
  assertFail(grade(MISMATCH, withEvent(base, 'auth-preflight', withMessage((m) => m.replace(/ — but if a later step.*$/, '.')))), /does not name `az login --username maker@contoso\.onmicrosoft\.com`/);
  // Stopping at a warning is the regression: the run must go on to the entity-builder.
  const stopped = { ...base, events: base.events.slice(0, base.events.findIndex((e) => e.id === 'auth-preflight') + 1) };
  assertFail(grade(MISMATCH, stopped), /did not go on past the ok:true, identitiesMatch:false gate/);
  assertFail(grade(MISMATCH, { ...base, manifest: { ...base.manifest, expectedOutcome: 'refused', refusal: { stage: 'auth' } } }), /run stopped although its only auth finding was a warning-only identity mismatch/);
});

test('eval 10: a builder re-probe that sees the mismatch logs the warning in its transaction log', () => {
  const base = committed(PROCEEDS);
  assertPass(grade(GATE_FIRST, base));
  const unlogged = { ...base, entityCreationLog: base.entityCreationLog.split(/\r?\n/).filter((line) => !/^- Warning:/.test(line)).join('\n') };
  assertFail(grade(GATE_FIRST, unlogged), /the entity-builder did not log its identity-mismatch warning/);
  // The orchestrator's own gate still owes the user the verbatim warning.
  assertFail(grade(GATE_FIRST, withEvent(base, 'auth-preflight', (e) => { delete e.userMessage; return e; })), /warning-only identity mismatch was not surfaced verbatim/);
});

test('eval 10: the entity-builder is dispatched only after an ok:true gate, read from the recorded calls', () => {
  const base = committed(PROCEEDS);
  assertPass(grade(BUILDER_AFTER_OK, base));
  for (const dir of E10) assertSkip(grade(BUILDER_AFTER_OK, committed(dir)), /entity-builder not invoked/);
  const builder = base.events.find((e) => e.id === 'entity-builder-1');
  assertFail(grade(BUILDER_AFTER_OK, { ...base, events: [builder, ...base.events.filter((e) => e !== builder)] }), /entity-builder invoked before check-auth\.js/);
  const blocked = withEvent(base, 'auth-preflight', (e) => ({ ...e, result: { ...e.result, ok: false, blocker: 'whoami_403' } }));
  assertFail(grade(BUILDER_AFTER_OK, blocked), /the check-auth\.js result before it is not ok:true/);
  // A capture made before the calls were recorded is read from its log lines.
  const historical = { dirName: 'historical', id: 10, contractVersion: 1, manifest: { contractVersion: 1 }, events: undefined, files: [],
    workflowLog: '- Command: `node scripts/check-auth.js`\n  - Result: ok=true\n- genpage-entity-builder invoked with the plan\n' };
  assertPass(grade(BUILDER_AFTER_OK, historical));
  assertFail(grade(BUILDER_AFTER_OK, { ...historical, workflowLog: '- genpage-entity-builder invoked with the plan\n- Command: `node scripts/check-auth.js`\n  - Result: ok=true\n' }), /entity-builder invoked before check-auth\.js/);
});

test('eval 10: the timeout expectation grades a refusal whole, and a run that went on only when it timed out', () => {
  assertPass(grade(TIMEOUT, committed('10-auth-timeout-halt')));
  const base = committed(PROCEEDS);
  assertSkip(grade(TIMEOUT, base), /no auth timeout in this scenario/);
  const gate = base.events.find((e) => e.id === 'auth-preflight');
  const advice = 'Azure CLI did not answer within 60 s; retry once or set POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS=120000.';
  const slow = (id) => ({ id, command: gate.command, exitCode: 1, result: { ok: false, blocker: 'az_timeout', message: advice, warnings: [], envUrl: null, identitiesMatch: false, whoAmI: null }, userMessage: advice });
  const at = base.events.indexOf(gate);
  const retried = (...extra) => ({ ...base, events: [...base.events.slice(0, at), ...extra, ...base.events.slice(at)] });
  // One timeout, one retry that passes: the run went on legitimately.
  assertPass(grade(TIMEOUT, retried(slow('auth-slow'))));
  assertFail(grade(TIMEOUT, retried(slow('auth-slow-1'), slow('auth-slow-2'), slow('auth-slow-3'))), /auth timeout retried more than once/);
});

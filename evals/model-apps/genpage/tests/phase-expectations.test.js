'use strict';

// Unit tests for the per-eval Phase expectations graded from structured evidence (the checks under
// "Per-eval expectations graded from structured evidence" and "Evals 3, 8, 9, 12, 14 and 16" in
// lib/assertions-layer-1.js, and the hardcoded-format check in lib/assertions-layer-2.js).
//
// Each check is proven three ways where they apply: it PASSES on the committed fixture whose
// evidence it reads, it FAILS on an in-memory mutation of that fixture that introduces exactly the
// regression it exists to catch, and it SKIPs only when its evidence is not part of a fixture's
// shape. Mutations go through `edit`, which asserts the text it replaces is really there, so a
// fixture change can never silently turn a failing case into a vacuous one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { PHASE_EXPECTATIONS } = require('../lib/assertions-layer-1.js');
const { PHASE5_EXPECTATIONS } = require('../lib/assertions-layer-2.js');
const { loadFixtures } = require('../lib/fixture-loader.js');

const FIXTURES = loadFixtures(path.join(__dirname, '..', 'fixtures'));

// The two fixtures whose app listing and app create are graded in the last section of the file, where all of eval 8's tests are (eval 3 has more under its own heading).
const E3 = '3-contacts-edit-search-sort';
const E8 = '8-account-metrics-new-app';

function committed(dirName) {
  const fixture = FIXTURES.find((f) => f.dirName === dirName);
  assert.ok(fixture, `committed fixture ${dirName} exists`);
  return fixture;
}

function edit(text, from, to) {
  // A Windows checkout may hold a fixture with CRLF line ends; multi-line edits follow the file's.
  if (typeof text === 'string' && text.includes('\r\n')) {
    [from, to] = [from, to].map((s) => s.replace(/\r?\n/g, '\r\n'));
  }
  assert.ok(typeof text === 'string' && text.includes(from), `fixture text contains ${JSON.stringify(from)}`);
  return text.split(from).join(to);
}

// A copy of a committed fixture with `field` edited (string replacement) or replaced outright.
function mutated(dirName, field, from, to) {
  const base = committed(dirName);
  return { ...base, [field]: to === undefined ? from : edit(base[field], from, to) };
}

function withFile(dirName, name, from, to) {
  const base = committed(dirName);
  return { ...base, files: base.files.map((f) => (f.name === name ? { ...f, content: edit(f.content, from, to) } : f)) };
}

function grade(text, fixture) {
  const check = PHASE_EXPECTATIONS.get(text);
  assert.ok(check, `a check is registered for: ${text}`);
  return check({ fixture, eval: { id: fixture.id } });
}

function gradeCode(text, files) {
  const check = PHASE5_EXPECTATIONS.get(text);
  assert.ok(check, `a check is registered for: ${text}`);
  return check({ files, fixture: { files }, eval: {} });
}

function assertPass(result) { assert.equal(result.status, 'pass', result.reason); }
function assertFail(result, reason) {
  assert.equal(result.status, 'fail', 'expected a failure');
  assert.match(result.reason, reason);
}
function assertSkip(result, reason) {
  assert.equal(result.status, 'skip', `expected a skip, got ${result.status}: ${result.reason}`);
  assert.match(result.reason, reason);
}

// --- Eval 2 ------------------------------------------------------------------------------------

test('eval 2: the data-source question resolves to mock data and no entity detection runs', () => {
  const text = "Phase 1 (Planner): Data source question is skipped or answered 'mock data' — no entity detection needed";
  assertPass(grade(text, committed('2-mock-dashboard')));
  assertPass(grade(text, committed('2-mock-dashboard-real')));
  assertFail(grade(text, mutated('2-mock-dashboard', 'workflowLog', 'user answered "Mock data"', 'user answered "Dataverse entities"')),
    /not answered with mock data: - Question 2 \(data source\): user answered "Dataverse entities"/);
  // An unrecorded question was skipped; the mock data mode handed to the builder records the result.
  const silent = mutated('2-mock-dashboard', 'workflowLog', '- Question 2 (data source): user answered "Mock data"\n', '');
  assertPass(grade(text, silent));
  assertFail(grade(text, { ...silent, workflowLog: edit(silent.workflowLog, 'Data mode: mock', 'Data mode: dataverse') }), /no data-source answer and no mock data mode/);
  const base = committed('2-mock-dashboard');
  assertFail(grade(text, { ...base, workflowLog: `${base.workflowLog}\n- \`pac model list-tables --search 'account'\` — account exists\n` }),
    /entity detection ran/);
  assertFail(grade(text, { ...base, workflowLog: `${base.workflowLog}\n- \`node scripts/list-tables.js --env https://contoso.crm.dynamics.com --search 'account' --exact\` — account exists\n` }),
    /entity detection ran/);
  assertFail(grade(text, mutated('2-mock-dashboard', 'genpagePlan', '(none — mock data page)', 'account')), /existing entities \(account\)/);
});

// --- Eval 4 ------------------------------------------------------------------------------------

test('eval 4: list-tables confirms incident and contact as existing tables', () => {
  const text = "Phase 1 (Planner): list-tables.js --search 'incident,contact' --exact is run; both entities confirmed as existing";
  assertPass(grade(text, committed('4-case-wizard')));
  assertFail(grade(text, mutated('4-case-wizard', 'workflowLog', "--search 'incident,contact'", "--search 'incident'")),
    /no list-tables --search covered contact/);
  assertFail(grade(text, mutated('4-case-wizard', 'genpagePlan', '## Existing Entities\n\nincident, contact', '## Existing Entities\n\nincident')),
    /does not confirm contact/);
});

// scripts/list-tables.js answers as data: `tables` holds the rows, `missing` the terms no table has (with --exact). The check reads that, and still reads the prose of a capture made before it.
const LIST_TABLES_JS = "node 'D:/repo/plugins/model-apps/scripts/list-tables.js' --env 'https://contoso.crm.dynamics.com'";
const tableRow = (logicalName) => ({ logicalName, displayName: logicalName, schemaName: logicalName, isCustom: false });

test('eval 4: list-tables.js results are read as data — a table that is in `tables` exists, one in `missing` does not', () => {
  const text = "Phase 1 (Planner): list-tables.js --search 'incident,contact' --exact is run; both entities confirmed as existing";
  const found = { ok: true, search: ['incident', 'contact'], exact: true, count: 2, tables: [tableRow('incident'), tableRow('contact')], missing: [] };
  const withSearch = (result) => ({ ...committed('4-case-wizard'), events: [{ id: 'list-tables', command: `${LIST_TABLES_JS} --search 'incident,contact' --exact`, result }] });
  assertPass(grade(text, withSearch(found)));
  assertFail(grade(text, withSearch({ ...found, count: 1, tables: [tableRow('incident')], missing: ['contact'] })), /list-tables recorded contact as not found/);
  // A substring search returns more rows than the table it was asked for: only an exact logical name counts.
  assertFail(grade(text, withSearch({ ...found, exact: false, tables: [tableRow('incident'), tableRow('contactleads')], missing: [] })), /list-tables recorded contact as not found/);
  // A failed read says nothing about the tables, and is not "they exist".
  assertFail(grade(text, withSearch({ ok: false, error: 'the read failed', code: 'CONNECTION_ERROR' })), /list-tables failed, so incident was not confirmed to exist/);
});

test('eval 4: the entity-builder is skipped when every table exists', () => {
  const text = 'Phase 2: Entity-builder is SKIPPED';
  assertPass(grade(text, committed('4-case-wizard')));
  const base = committed('4-case-wizard');
  assertFail(grade(text, { ...base, workflowLog: `${base.workflowLog}\n- Dispatched genpage-entity-builder agent\n` }), /entity-builder was invoked/);
  assertFail(grade(text, { ...base, workflowLog: `${base.workflowLog}\n- \`node scripts/provision-entities.js --input @x.json --apply\`\n` }), /provisioned/);
  assertFail(grade(text, { ...base, genpagePlan: committed('7-job-candidates-new-entities').genpagePlan }), /plan schedules entity creation/);
});

test('eval 4: genpage.js types runs with exactly incident and contact', () => {
  const text = "Phase 4: genpage.js types --data-sources 'incident,contact' is run";
  assertPass(grade(text, committed('4-case-wizard')));
  assertFail(grade(text, mutated('4-case-wizard', 'workflowLog', "generate-types --data-sources 'incident,contact'", "generate-types --data-sources 'incident'")),
    /no genpage\.js types run has --data-sources incident,contact \(saw incident\)/);
  assertFail(grade(text, mutated('4-case-wizard', 'workflowLog', 'pac model genpage generate-types', 'generate types')), /was not run/);
});

test('eval 4: the wizard sample is read, not merely listed', () => {
  const text = 'Phase 5 (Page Builder): Wizard sample (2-wizard-multi-step.tsx) is read';
  assertPass(grade(text, committed('4-case-wizard')));
  // The plan still names the sample in ## Relevant Samples; only the log records a read.
  assertFail(grade(text, mutated('4-case-wizard', 'workflowLog', 'Read sample: plugins/model-apps/samples/2-wizard-multi-step.tsx', 'Read sample: plugins/model-apps/samples/9-list-with-caching.tsx')),
    /does not record reading samples\/2-wizard-multi-step\.tsx/);
});

test('eval 4: every upload binds incident and contact, on either upload transport', () => {
  const text = "Phase 6: Upload includes --data-sources 'incident,contact'";
  assertPass(grade(text, committed('4-case-wizard')));
  assertFail(grade(text, mutated('4-case-wizard', 'workflowLog', "--data-sources 'incident,contact' --prompt", '--prompt')),
    /page\.tsx: --data-sources is none, expected incident,contact/);
  // The file transport (scripts/genpage-upload.js) carries the same flag and is graded the same way.
  const fileTransport = mutated('4-case-wizard', 'workflowLog', /- `pac model genpage upload[^\n]*/.exec(committed('4-case-wizard').workflowLog)[0],
    "- Command: `node \"${PLUGIN_ROOT}/scripts/genpage-upload.js\" --env 'https://contoso.crm.dynamics.com' --app-id 'a' --code-file 'new-case-wizard/page.tsx' --data-sources 'contact,incident' --prompt-file 'new-case-wizard/prompt.txt' --agent-message-file 'new-case-wizard/agent-message.txt' --name-file 'new-case-wizard/page-name.txt' --add-to-sitemap`");
  assertPass(grade(text, fileTransport));
  assertFail(grade(text, { ...fileTransport, workflowLog: edit(fileTransport.workflowLog, "--data-sources 'contact,incident'", "--data-sources 'contact'") }),
    /--data-sources is contact, expected incident,contact/);
});

// --- Eval 5 ------------------------------------------------------------------------------------

test('eval 5: task exists and the plan maps the three kanban columns to status values', () => {
  const text = 'Phase 1 (Planner): task entity confirmed as existing; plan describes kanban with 3 columns mapped to task statecode/statuscode values';
  assertPass(grade(text, committed('5-kanban-task-board')));
  assertFail(grade(text, mutated('5-kanban-task-board', 'workflowLog', "list-tables --search 'task'", "list-tables --search 'account'")),
    /no list-tables --search covered task/);
  assertFail(grade(text, mutated('5-kanban-task-board', 'genpagePlan', 'Three columns mapped to task statuscode values', 'Three columns')),
    /does not map the columns to task statuscode\/statecode/);
});

test('eval 5: status values identified after the type generator match the generated RuntimeTypes.ts', () => {
  const text = 'Phase 4: RuntimeTypes.ts is read — status field enum values are identified for column mapping';
  assertPass(grade(text, committed('5-kanban-task-board')));
  assertFail(grade(text, mutated('5-kanban-task-board', 'workflowLog', '`"In Progress" = 3`', '`"In Progress" = 2`')),
    /not in RuntimeTypes\.ts: "In Progress" = 2/);
  const base = committed('5-kanban-task-board');
  const noPairs = base.workflowLog.replace(/`"[^"]+" = \d+`/g, 'a status');
  assertFail(grade(text, { ...base, workflowLog: noPairs }), /does not record the status enum values/);
  // Without a captured RuntimeTypes.ts the recorded mapping is still required, just not cross-checked.
  assertPass(grade(text, { ...base, runtimeTypes: null, workflowLog: edit(base.workflowLog, '`"In Progress" = 3`', '`"In Progress" = 2`') }));
});

// --- Eval 7 ------------------------------------------------------------------------------------

const E7 = '7-job-candidates-new-entities';

test('eval 7: list-tables records both new tables as absent on an exact match', () => {
  const text = 'Phase 1 (Planner): list-tables.js --search --exact confirms cr_candidate and cr_jobrequisition do NOT exist (named in missing — an exact logical-name match, not fuzzy)';
  assertPass(grade(text, committed(E7)));
  assertFail(grade(text, mutated(E7, 'workflowLog', "--search 'cr_candidate'` — exact logical-name match: NOT FOUND", "--search 'cr_candidate'` — fuzzy match: NOT FOUND")),
    /cr_candidate does not rest on an exact logical-name match/);
  assertFail(grade(text, mutated(E7, 'workflowLog', "--search 'cr_jobrequisition'` — exact logical-name match: NOT FOUND", "--search 'cr_jobrequisition'` — exact logical-name match: cr_jobrequisition")),
    /does not record cr_jobrequisition as absent/);
  assertFail(grade(text, mutated(E7, 'genpagePlan', '### candidate', '### applicant')), /no "### candidate" block/);
});

test('eval 7: list-tables.js --exact names both tables in `missing`; a fuzzy reading of a longer name is not an absence', () => {
  const text = 'Phase 1 (Planner): list-tables.js --search --exact confirms cr_candidate and cr_jobrequisition do NOT exist (named in missing — an exact logical-name match, not fuzzy)';
  const absent = { ok: true, search: ['cr_candidate', 'cr_jobrequisition'], exact: true, count: 0, tables: [], missing: ['cr_candidate', 'cr_jobrequisition'] };
  const withSearch = (result, flags = '--exact') => ({ ...committed(E7), events: [{ id: 'list-tables', command: `${LIST_TABLES_JS} --search 'cr_candidate,cr_jobrequisition' ${flags}`, result }] });
  assertPass(grade(text, withSearch(absent)));
  // Without --exact the same two terms can return longer names (`cr_candidatenote`) and no row of the exact name: the table is still absent, but only the data says so, not --exact.
  assertFail(grade(text, withSearch({ ...absent, exact: false, count: 1, tables: [tableRow('cr_candidatenote')], missing: [] }, '')), /cr_candidate does not rest on an exact logical-name match/);
  assertFail(grade(text, withSearch({ ...absent, count: 1, tables: [tableRow('cr_candidate')], missing: ['cr_jobrequisition'] })), /does not record cr_candidate as absent/);
  assertFail(grade(text, withSearch({ ok: false, error: 'the read failed', code: 'CONNECTION_ERROR' })), /list-tables failed, so cr_candidate was not confirmed to be absent/);
});

test('eval 7: the plan defines both tables with typed columns and the candidate → jobrequisition lookup', () => {
  const text = 'Phase 1 (Planner): Plan includes entity definitions with columns, types, and a lookup relationship (cr_candidate → cr_jobrequisition)';
  assertPass(grade(text, committed(E7)));
  assertFail(grade(text, mutated(E7, 'genpagePlan', '| 1:N | jobrequisition | jobrequisition | Restrict |', '| none | none | none | none |')),
    /candidate has no lookup relationship to jobrequisition/);
  assertFail(grade(text, mutated(E7, 'genpagePlan', '| openings | int | yes |', '| openings |  | yes |')), /without a type: openings/);
});

test('eval 7 and 15: the solution question is asked and its answer is what ## Environment records', () => {
  const e7 = "Phase 1 (Planner): Because entities will be created, the planner asks the solution selection question via AskUserQuestion and records the choice in ## Environment as 'Solution: <uniqueName>' and 'Publisher Prefix: <prefix>'";
  const e15 = 'Phase 1 (Planner): Solution selection question is asked (because new entity will be created) and recorded in ## Environment';
  assertPass(grade(e7, committed(E7)));
  assertPass(grade(e15, committed('15-support-tickets-real')));
  assertFail(grade(e7, mutated(E7, 'genpagePlan', '- Solution: Default', '- Solution: ContosoRecruiting')), /maker answered "?"Use Default Solution"?/);
  assertFail(grade(e15, mutated('15-support-tickets-real', 'genpagePlan', '- Solution: Crdec34', '- Solution: Default')), /maker answered "Crdec34/);
  assertFail(grade(e7, mutated(E7, 'workflowLog', '- User selected: "Use Default Solution"', '- (answer not recorded)')), /answer to the solution question is not recorded/);
  assertFail(grade(e7, mutated(E7, 'genpagePlan', '- Publisher Prefix: cr\n', '\n')), /no "Publisher Prefix/);
});

test('eval 7: the entity-builder records the Environment it read from the plan', () => {
  const text = "Phase 2b (Entity Builder): Reads Solution + Publisher Prefix from the plan's ## Environment";
  assertPass(grade(text, committed(E7)));
  assertFail(grade(text, mutated(E7, 'entityCreationLog', '- Publisher Prefix: cr', '- Publisher Prefix: new')), /builder recorded Publisher Prefix: new, plan declares cr/);
  assertFail(grade(text, mutated(E7, 'workflowLog', 'Reads Solution=Default, Publisher Prefix=cr', 'Reads Solution=Contoso, Publisher Prefix=cr')), /builder read Solution=Contoso/);
  assertFail(grade(text, { ...committed(E7), entityCreationLog: null }), /no genpage-entity-creation-log\.md/);
});

test('eval 7: the referenced table is provisioned before the table holding the lookup', () => {
  const text = 'Phase 2b (Entity Builder): cr_jobrequisition (independent) is provisioned before cr_candidate (has lookup) to satisfy dependency ordering';
  assertPass(grade(text, committed(E7)));
  const reversed = [
    '# Entity Creation Log', '', '## Environment', '- Solution: Default', '- Publisher Prefix: cr', '',
    '## Created Tables', '', '### Candidate', '- Resolved Full Name: cr_candidate', '',
    '### Job Requisition', '- Resolved Full Name: cr_jobrequisition', '',
  ].join('\n');
  assertFail(grade(text, { ...committed(E7), entityCreationLog: reversed }), /candidate \(has the lookup\) was provisioned before jobrequisition/);
  assertFail(grade(text, mutated(E7, 'genpagePlan', '| 1:N | jobrequisition | jobrequisition | Restrict |', '| none | none | none | none |')),
    /no candidate → jobrequisition lookup/);
});

test('eval 7: provision-entities.js creates tables and columns from one input JSON', () => {
  const text = 'Phase 2b (Entity Builder): provision-entities.js handles entity creation and column definitions atomically with internal propagation management';
  assertPass(grade(text, committed(E7)));
  const base = committed(E7);
  assertFail(grade(text, { ...base, workflowLog: `${base.workflowLog}\n- \`node scripts/add-column.js --table cr_candidate --solution Default\`\n` }), /per-object scripts .*add-column\.js/);
  assertFail(grade(text, mutated(E7, 'workflowLog', 'provision-input.json --apply --sample-data', 'provision-input.json --sample-data')), /--input <json> --apply/);
  assertFail(grade(text, mutated(E7, 'workflowLog', 'scripts/provision-entities.js', 'scripts/provision.js')), /provision-entities\.js was not run/);
});

test('eval 7: the lookup is provisioned through the input JSON and recorded', () => {
  const text = 'Phase 2b (Entity Builder): Lookup relationship (cr_candidate → cr_jobrequisition) is provisioned via input JSON; provision-entities.js handles propagation internally';
  assertPass(grade(text, committed(E7)));
  assertFail(grade(text, mutated(E7, 'entityCreationLog', '| 1:N  | cr_jobrequisition | cr_candidate |', '| 1:N  | cr_candidate | cr_jobrequisition |')),
    /no jobrequisition → candidate \(1:N\) row/);
  const base = committed(E7);
  assertFail(grade(text, { ...base, workflowLog: `${base.workflowLog}\n- \`node scripts/create-relationship.js --from cr_jobrequisition --to cr_candidate\`\n` }),
    /create-relationship\.js was run/);
});

test('eval 7: the sample-data question is asked and its answer is the one acted on', () => {
  const text = 'Phase 2b (Entity Builder): User is asked about sample data via AskUserQuestion';
  assertPass(grade(text, committed(E7)));
  assertFail(grade(text, mutated(E7, 'workflowLog', 'user answered "Yes, add sample data"', 'user answered "No, skip"')),
    /answered "No, skip" but provisioning seeded sample data/);
  assertFail(grade(text, mutated(E7, 'workflowLog', '- Question 4 (sample data): user answered "Yes, add sample data"', '- Question 4: none')),
    /no answered sample-data question/);
});

test('eval 7: sample rows go through the input JSON with $parent/match parent references', () => {
  const text = 'Phase 2b (Entity Builder): Sample data is provisioned via provision-entities.js input JSON; parent references use $parent/match convention for dependency resolution';
  assertPass(grade(text, committed(E7)));
  assertFail(grade(text, mutated(E7, 'workflowLog', ' (parent binding via $parent/match)', '')), /\$parent\/match parent reference/);
  assertFail(grade(text, mutated(E7, 'workflowLog', '--apply --sample-data', '--apply')), /no provision-entities\.js --sample-data run/);
  assertSkip(grade(text, mutated(E7, 'workflowLog', 'user answered "Yes, add sample data"', 'user answered "No, skip"')), /declined sample data/);
});

test('eval 7: the transaction log records every planned create and the names are reported back', () => {
  const text = 'Phase 2b (Entity Builder): Actual logical names are reported back (may be normalized by Dataverse); a transaction log at <working-dir>/genpage-entity-creation-log.md captures each successful operation';
  assertPass(grade(text, committed(E7)));
  assertFail(grade(text, mutated(E7, 'entityCreationLog', '| cr_candidate | Recruiter | cr_Recruiter | cr_recruiter | ... |', '')),
    /column recruiter of cr_candidate has no Created Columns row/);
  assertFail(grade(text, mutated(E7, 'entityCreationLog', '- Resolved Full Name: cr_candidate', '- Resolved Full Name: ')), /table candidate has no Created Tables entry/);
  assertFail(grade(text, { ...committed(E7), entityCreationLog: null }), /no genpage-entity-creation-log\.md/);
});

test('eval 7: genpage.js types and the upload use the created table names', () => {
  const types = 'Phase 4: genpage.js types is run with the created entity names';
  const upload = 'Phase 6: Upload includes --data-sources with both created entity names';
  assertPass(grade(types, committed(E7)));
  assertPass(grade(upload, committed(E7)));
  assertFail(grade(types, mutated(E7, 'workflowLog', "generate-types --data-sources 'cr_candidate,cr_jobrequisition'", "generate-types --data-sources 'cr_candidate'")),
    /no genpage\.js types run has --data-sources cr_jobrequisition,cr_candidate/);
  assertFail(grade(upload, mutated(E7, 'workflowLog', "page.tsx --data-sources 'cr_candidate,cr_jobrequisition'", "page.tsx --data-sources 'cr_candidate'")),
    /--data-sources is cr_candidate, expected cr_jobrequisition,cr_candidate/);
});

// --- Eval 10 -----------------------------------------------------------------------------------

test('eval 10: the plan schedules the widget table for creation', () => {
  const text = 'Phase 1 (Planner): Plan records cr_widget under Entity Creation Required';
  assertPass(grade(text, committed('10-auth-timeout-halt')));
  assertFail(grade(text, mutated('10-auth-timeout-halt', 'genpagePlan', '### widget', '### gadget')), /no "### widget" block/);
});

test('eval 10: check-auth.js runs and parses before any entity-builder dispatch', () => {
  const text = 'Phase 2a: Orchestrator runs scripts/check-auth.js BEFORE invoking entity-builder; parses the returned JSON';
  assertPass(grade(text, committed('10-auth-timeout-halt')));
  const base = { ...committed('4-case-wizard'), genpagePlan: null };
  assertFail(grade(text, { ...base, workflowLog: '- Dispatched genpage-entity-builder agent\n- `node scripts/check-auth.js` → returned `{ ok: true, ... }`\n' }),
    /mutation attempted without the latest successful auth gate/);
  assertFail(grade(text, { ...base, workflowLog: '- `node scripts/check-auth.js` → returned something unreadable\n' }), /malformed or missing auth result/);
  assertFail(grade(text, { ...base, workflowLog: '- Dispatched genpage-entity-builder agent\n' }), /check-auth\.js not invoked/);
});

// --- Eval 11 -----------------------------------------------------------------------------------

const E11 = '11-recruitment-multi-page';
const E11_REAL = '11-recruitment-pages-real';

test('eval 11: three pages with distinct files, purposes and per-page specifications', () => {
  const pages = 'Phase 1 (Planner): Plan includes 3 pages in the Pages table with distinct file names and purposes';
  const specs = 'Phase 1 (Planner): Per-Page Specifications section has an entry for each of the 3 pages';
  for (const dir of [E11, E11_REAL]) {
    assertPass(grade(pages, committed(dir)));
    assertPass(grade(specs, committed(dir)));
  }
  assertFail(grade(pages, mutated(E11, 'genpagePlan', '| Metrics | hiring-metrics.tsx |', '| Metrics | interview-schedule.tsx |')), /file names are not distinct/);
  assertFail(grade(pages, { ...committed(E11), genpagePlan: committed('4-case-wizard').genpagePlan }), /## Pages has 1 row\(s\), expected 3/);
  assertFail(grade(specs, mutated(E11, 'genpagePlan', '### Metrics', '### Dashboard')), /no "### Metrics" entry/);
});

test('eval 11: pages are only built from a plan that passes the Phase 5a gate', () => {
  const text = 'Phase 5a: Orchestrator validates the plan — at least one page, unique filenames, each page has a matching Per-Page Specifications subsection';
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  const invalid = mutated(E11, 'genpagePlan', '| Metrics | hiring-metrics.tsx |', '| Metrics | interview-schedule.tsx |');
  assertFail(grade(text, invalid), /pages were built from a plan that fails Phase 5a/);
  // The same invalid plan with nothing generated is the gate holding.
  assertPass(grade(text, { ...invalid, files: [] }));
});

test('eval 11: genpage.js types runs once for contact and appointment into one RuntimeTypes.ts', () => {
  const text = "Phase 4: genpage.js types is run ONCE with --data-sources 'contact,appointment'; a single RuntimeTypes.ts is generated";
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  const base = committed(E11);
  assertFail(grade(text, { ...base, workflowLog: `${base.workflowLog}\n- pac model genpage generate-types --data-sources 'contact' --output-file other/RuntimeTypes.ts\n` }),
    /ran 2 time\(s\), expected once/);
  assertFail(grade(text, mutated(E11, 'workflowLog', "--data-sources 'contact,appointment' --output-file recruitment-pages/RuntimeTypes.ts", "--data-sources 'contact' --output-file recruitment-pages/RuntimeTypes.ts")),
    /no genpage\.js types run has --data-sources contact,appointment/);
  assertFail(grade(text, mutated(E11, 'workflowLog', '--output-file recruitment-pages/RuntimeTypes.ts', '--output-file recruitment-pages/Types.ts')), /wrote Types\.ts/);
});

test('eval 11: each builder targets its own file', () => {
  const text = 'Phase 5c: Each builder receives a distinct target filename — no two builders target the same file';
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  assertFail(grade(text, mutated(E11, 'workflowLog', 'Builder C target: hiring-metrics.tsx', 'Builder C target: interview-schedule.tsx')),
    /two builders were dispatched with target interview-schedule\.tsx/);
  const base = committed(E11);
  assertFail(grade(text, { ...base, files: base.files.filter((f) => f.name !== 'hiring-metrics.tsx') }), /no builder wrote hiring-metrics\.tsx/);
  assertSkip(grade(text, committed('4-case-wizard')), /single-page plan/);
});

test('eval 11: each page binds only the tables its own specification declares', () => {
  const text = 'Phase 5c: Each builder reads the same genpage-plan.md but extracts only its own page specification';
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  assertFail(grade(text, withFile(E11, 'candidate-list.tsx', "dataApi.queryTable('contact', {", "dataApi.queryTable('appointment', {")),
    /candidate-list\.tsx binds appointment, which its own specification \(Entities: contact\) does not declare/);
  // A call inside a comment or a string is not a binding.
  assertPass(grade(text, withFile(E11, 'candidate-list.tsx', "dataApi.queryTable('contact', {", "/* dataApi.queryTable('appointment') */ dataApi.queryTable('contact', {")));
  assertSkip(grade(text, committed('4-case-wizard')), /single-page plan/);
});

test('eval 11: every page resolves its types from the one generated RuntimeTypes.ts', () => {
  const text = 'Phase 5c: Each builder reads the same RuntimeTypes.ts for column verification';
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  assertFail(grade(text, withFile(E11, 'hiring-metrics.tsx', "from './RuntimeTypes'", "from './MetricsTypes'")), /hiring-metrics\.tsx does not import the shared \.\/RuntimeTypes/);
  const base = committed(E11);
  assertFail(grade(text, { ...base, workflowLog: `${base.workflowLog}\n- pac model genpage generate-types --data-sources 'contact' --output-file metrics/RuntimeTypes.ts\n` }),
    /could read different schemas/);
});

test('eval 11: each page has exactly one create upload with its own --code-file', () => {
  const text = 'Phase 6: All 3 pages are deployed via separate genpage-upload.js create uploads, each with the correct --code-file';
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  assertFail(grade(text, mutated(E11, 'workflowLog', '--code-file recruitment-pages/hiring-metrics.tsx', '--code-file recruitment-pages/candidate-list.tsx')),
    /candidate-list\.tsx has 2 create upload/);
});

test('eval 11: cross-page navigation uses sibling PAGEREF placeholders or deployed ids, never invented GUIDs', () => {
  const text = 'Phase 5c: Cross-page navigation (e.g., candidate list → candidate detail) uses quoted `"PAGEREF_<filename>"` placeholders, never invented GUIDs';
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  assertFail(grade(text, withFile(E11, 'candidate-list.tsx', "pageId: 'PAGEREF_interview-schedule'", "pageId: '11111111-2222-3333-4444-555555555555'")),
    /literal page id appears before resolution/);
  assertFail(grade(text, withFile(E11_REAL, 'hiring-metrics-dashboard.tsx', '492d8c42-b5fc-4ec5-ad44-6809c6673e9a', '99999999-b5fc-4ec5-ad44-6809c6673e9a')),
    /not a deployed GUID from the page map/);
  assertSkip(grade(text, committed('4-case-wizard')), /single-page fixture/);
});

test('eval 11: Phase 6.5 re-uploads exactly the affected pages with the update flag set', () => {
  const text = 'Phase 6.5: If any .tsx contains PAGEREF_ tokens, orchestrator builds a filename→page-id map sorted by length desc, replaces quoted `"PAGEREF_<name>"` tokens with the matching GUID (word-boundary safe), and re-uploads only affected files with the full update flag set';
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  const base = committed(E11);
  const secondReupload = base.workflowLog.split(/\r?\n/).find((l) => /interview-schedule\.tsx --page-id/.test(l));
  assertFail(grade(text, { ...base, workflowLog: edit(base.workflowLog, secondReupload, '') }),
    /re-uploaded candidate-list\.tsx, but the affected files are candidate-list\.tsx,interview-schedule\.tsx/);
  assertFail(grade(text, mutated(E11_REAL, 'workflowLog', '--agent-message "Replaced PAGEREF_candidate-list', '--add-to-sitemap --agent-message "Replaced PAGEREF_candidate-list')),
    /re-upload passes --add-to-sitemap/);
  assertFail(grade(text, mutated(E11_REAL, 'workflowLog', '--page-id e2022b27-548b-43be-95bd-4dafa02e060c', '--page-id 00000000-548b-43be-95bd-4dafa02e060c')),
    /was never returned by an upload/);
  assertFail(grade(text, mutated(E11_REAL, 'workflowLog', '--page-id e2022b27-548b-43be-95bd-4dafa02e060c --code-file D:/temp/recruitment-app/hiring-metrics-dashboard.tsx --data-sources "contact,appointment"', '--page-id e2022b27-548b-43be-95bd-4dafa02e060c --code-file D:/temp/recruitment-app/hiring-metrics-dashboard.tsx')),
    /re-upload --data-sources none differs from its create/);
  assertSkip(grade(text, committed('4-case-wizard')), /no \.tsx carries a PAGEREF_/);
});

test('eval 11: the Phase 6.5 re-upload prompt is a delta, not the original description', () => {
  const text = "Phase 6.5: Re-upload uses a DELTA --prompt (e.g. 'Resolve cross-page navigation placeholders to real page GUIDs') — NOT a copy of the original page description from Phase 6";
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  const original = 'Build me three pages for a recruitment app: a candidate list page, an interview schedule page, and a hiring metrics dashboard. Use the contact and appointment entities.';
  assertFail(grade(text, mutated(E11_REAL, 'workflowLog', 'Resolve cross-page navigation placeholders to real page GUIDs (post-deploy fix-up)', original)),
    /re-upload prompt restates ## User Requirements/);
  assertFail(grade(text, mutated(E11, 'workflowLog', '--page-id <resolved-id> --data-sources \'contact,appointment\' --prompt "Resolve cross-page navigation placeholders to real page GUIDs" --model claude-sonnet --agent-message "PAGEREF resolution"\n- pac model genpage upload --app-id 44444444-3333-4444-5555-666666666666 --code-file recruitment-pages/interview-schedule.tsx',
    '--page-id <resolved-id> --data-sources \'contact,appointment\' --prompt "Candidate list page (eval 11)" --model claude-sonnet --agent-message "PAGEREF resolution"\n- pac model genpage upload --app-id 44444444-3333-4444-5555-666666666666 --code-file recruitment-pages/interview-schedule.tsx')),
    /candidate-list\.tsx: re-upload prompt repeats the create prompt/);
  assertSkip(grade(text, committed('4-case-wizard')), /no Phase 6\.5 re-upload/);
});

test('eval 11: an unresolved PAGEREF is reported and never shipped', () => {
  const text = 'Phase 6.5: Unresolved PAGEREF tokens (typos, missing siblings) cause an explicit error to the user — never silently shipped';
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  const typo = withFile(E11, 'candidate-list.tsx', "'PAGEREF_interview-schedule'", "'PAGEREF_interview-scheduel'");
  assertFail(grade(text, typo), /PAGEREF_interview-scheduel names no sibling page and no error was reported/);
  const reported = { ...typo, workflowLog: `${typo.workflowLog}\n- ERROR: PAGEREF_interview-scheduel has no matching sibling page — stopped\n` };
  assertFail(grade(text, reported), /re-uploaded despite unresolved PAGEREF_interview-scheduel/);
  const candidateReupload = reported.workflowLog.split(/\r?\n/).find((l) => /candidate-list\.tsx --page-id/.test(l));
  assertPass(grade(text, { ...reported, workflowLog: edit(reported.workflowLog, candidateReupload, '') }));
  assertFail(grade(text, withFile(E11_REAL, 'hiring-metrics-dashboard.tsx', '"492d8c42-b5fc-4ec5-ad44-6809c6673e9a"', '"PAGEREF_candidate-list"')),
    /PAGEREF_candidate-list remains after resolution/);
  assertSkip(grade(text, committed('4-case-wizard')), /no cross-page navigation/);
});

test('eval 11: the Phase 8 summary lists every page with its deployed entities and status', () => {
  const text = 'Phase 8: Summary table lists all 3 pages with their files, entities, and deployment status';
  assertPass(grade(text, committed(E11)));
  assertPass(grade(text, committed(E11_REAL)));
  assertFail(grade(text, mutated(E11_REAL, 'workflowLog', '| Candidate List | candidate-list.tsx | contact | Deployed |', '| Candidate List | candidate-list.tsx | contact, appointment | Deployed |')),
    /lists candidate-list\.tsx with entities contact, appointment, deployed with contact/);
  assertFail(grade(text, mutated(E11, 'workflowLog', '| Metrics | hiring-metrics.tsx | contact, appointment | Deployed |', '')), /does not list hiring-metrics\.tsx/);
  assertFail(grade(text, mutated(E11, 'workflowLog', '| Metrics | hiring-metrics.tsx | contact, appointment | Deployed |', '| Metrics | hiring-metrics.tsx | contact, appointment |  |')),
    /gives hiring-metrics\.tsx no deployment status/);
});

// --- Eval 13 -----------------------------------------------------------------------------------

const E13 = '13-contact-localization';
const LANGUAGES_OUTPUT = 'Phase 1 (Planner): language discovery output includes Arabic (1025) and French (1036) in addition to English';
const LANGUAGES_SECTION = 'Phase 1 (Planner): Plan includes a Localization section listing detected languages';
// The committed capture records scripts/list-languages.js and its JSON line — the command and its `Result:` — whose
// `languages` are read as data.
const scriptCall = () => /- `node "\$\{PLUGIN_ROOT\}\/scripts\/list-languages\.js"[^\n]*\n[^\n]*/.exec(committed(E13).workflowLog)[0];
const FRENCH = ',{"lcid":1036,"code":"fr-FR","name":"French (France)","rtl":false}';
// The same capture, edited as text, one replacement after another.
const withLog = (...replacements) => replacements.reduce((fixture, [from, to]) => ({ ...fixture, workflowLog: edit(fixture.workflowLog, from, to) }), committed(E13));

// What the script prints when it cannot read the languages (a missing Azure CLI), as the real script prints it, for the
// environment the capture's own command names.
const originOf13 = () => /--env '([^']+)'/.exec(scriptCall())[1];
const failedRead = () => `{"ok":false,"error":"Transport failure reaching ${originOf13()}/api/data/v9.0/organizations?$select=languagecode: Could not get an Azure CLI token for ${originOf13()}: Azure CLI (\`az\`) is not on PATH. Install it from https://aka.ms/azure-cli and run \`az login\`.","code":"CONNECTION_ERROR"}`;
// What `pac model list-languages` printed for the same environment — the table of a capture made before the script, and what the removed fallback would have recorded.
const PAC_ROWS = ['1033 English (United States) en-US No', '1025 Arabic (Saudi Arabia)   ar-SA Yes', '1036 French (France)         fr-FR No'];
const pacTable = (rows = PAC_ROWS) => `\`pac model list-languages\`\nLCID Language                Code  RTL\n${rows.join('\n')}`;
// The removed fallback was pinned to the environment the script was given (`--environment '<envUrl>'`); to the grader that is the same command.
const pinnedPacTable = (rows) => pacTable(rows).replace('`pac model list-languages`', `\`pac model list-languages --environment '${originOf13()}'\``);
// The log of a run whose script failed: the script's command and result, then what the removed fallback recorded — the `pac` command and its table, each verbatim.
const failedScriptLog = () => `${scriptCall().split('\n')[0]}\n  Result: ${failedRead()}`;
const fellBackLog = ({ note = '', rows } = {}) => `${failedScriptLog()}\n${note}- ${pacTable(rows)}`;
const SAID = '- Language detection used `pac model list-languages`: the languages script exited 1 (the Azure CLI is not on PATH)\n';

test('eval 13: language-discovery output and the plan Localization section carry every detected LCID', () => {
  assertPass(grade(LANGUAGES_OUTPUT, committed(E13)));
  assertPass(grade(LANGUAGES_SECTION, committed(E13)));
  assertFail(grade(LANGUAGES_OUTPUT, withLog([FRENCH, ''])), /lacks LCID 1036/);
  // A language the script could not name is still a detected one — written the way the script writes it: the LCID stays,
  // its code is null, it is listed in `unmapped` and its summary line says unknown.
  const unnamed = withLog(
    [FRENCH, ',{"lcid":1036,"code":null,"name":null,"rtl":null}'],
    ['"unmapped":[]', '"unmapped":[1036]'],
    ['"1036 fr-FR \\u2014 RTL: No"', '"1036 unknown \\u2014 RTL: unknown"']
  );
  assertPass(grade(LANGUAGES_OUTPUT, unnamed));
  // The PAC table of a capture made before that script is read too.
  assertPass(grade(LANGUAGES_OUTPUT, mutated(E13, 'workflowLog', scriptCall(), pacTable())));
  assertFail(grade(LANGUAGES_SECTION, mutated(E13, 'genpagePlan', '## Localization', '## Notes')), /no Localization section/);
  assertFail(grade(LANGUAGES_SECTION, mutated(E13, 'genpagePlan', '(1036, fr-FR)', '(fr-FR)')), /does not list detected LCID 1036/);
  assertFail(grade(LANGUAGES_SECTION, mutated(E13, 'workflowLog', '/scripts/list-languages.js', '/scripts/language-discovery.js')), /language discovery was not run/);
});

test('eval 13: a result that parses as the script\u2019s own JSON is read as data and as nothing else', () => {
  // Only `languages` — the PROVISIONED ones — count. Read as text, the JSON would give up LCIDs it merely mentions: the
  // base language, a `summary` line, and any number within sixty characters of a language tag.
  const notProvisioned = [FRENCH, ''];
  assertFail(grade(LANGUAGES_OUTPUT, withLog(notProvisioned, ['"baseLanguage":{"lcid":1033,"code":"en-US"', '"baseLanguage":{"lcid":1036,"code":"fr-FR"'])), /lacks LCID 1036/);
  assertFail(grade(LANGUAGES_OUTPUT, withLog(notProvisioned)), /lacks LCID 1036/);
  assertFail(grade(LANGUAGES_OUTPUT, withLog(notProvisioned, ['"unmapped":[]', '"unmapped":[1036]'], ['"1036 fr-FR \\u2014 RTL: No"', '"1036 unknown \\u2014 RTL: unknown"'])), /lacks LCID 1036/);
  // A failed read detected nothing, whatever its error text says — even text that names languages.
  const error = '{"ok":false,"error":"HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.0/RetrieveProvisionedLanguages(): 1033 en-US, 1025 ar-SA and 1036 fr-FR cannot be read by this user","code":"CONNECTION_ERROR"}';
  assertFail(grade(LANGUAGES_OUTPUT, mutated(E13, 'workflowLog', /Result: \{"ok":true[^\n]*/.exec(committed(E13).workflowLog)[0], `Result: ${error}`)), /saw none/);
  // A `Result:` that is not the script's shape (an abbreviation) is not decisive: the text around it still is read.
  assertPass(grade(LANGUAGES_OUTPUT, mutated(E13, 'workflowLog', /Result: \{"ok":true[^\n]*/.exec(committed(E13).workflowLog)[0], 'Result: { ok: true, ... }\n  English (United States) (1033, en-US), Arabic (Saudi Arabia) (1025, ar-SA), French (France) (1036, fr-FR)')));
});

test('eval 13: when the script could not read the languages nothing is detected — the pac fallback it used to have is gone', () => {
  // agents/genpage-planner.md: a failed read ends language detection, and the planner reports why and stops. A `pac model list-languages` that
  // follows a failed script is the removed fallback, so the grader credits it with none of the languages it printed.
  for (const log of [fellBackLog(), fellBackLog({ note: SAID }), `${failedScriptLog()}\n- ${pinnedPacTable()}`]) {
    const fellBack = mutated(E13, 'workflowLog', scriptCall(), log);
    assertFail(grade(LANGUAGES_OUTPUT, fellBack), /lacks LCID 1033, 1025, 1036 \(saw none\)/);
    assertFail(grade(LANGUAGES_SECTION, fellBack), /detected no languages/);
  }
  // A run that stopped at the failed script detected nothing as well: it is credited with no language it never read, and a
  // plan that lists languages has none to be listing.
  const stopped = mutated(E13, 'workflowLog', scriptCall(), failedScriptLog());
  assertFail(grade(LANGUAGES_OUTPUT, stopped), /lacks LCID 1033, 1025, 1036 \(saw none\)/);
  assertFail(grade(LANGUAGES_SECTION, stopped), /detected no languages/);
  // The table of a capture made before the script has no failed script ahead of it, so it is read — and a table that lists fewer languages than the plan is caught.
  assertPass(grade(LANGUAGES_OUTPUT, mutated(E13, 'workflowLog', scriptCall(), pacTable())));
  assertFail(grade(LANGUAGES_OUTPUT, mutated(E13, 'workflowLog', scriptCall(), pacTable(PAC_ROWS.slice(0, 2)))), /lacks LCID 1036/);
});

test('eval 13: the whole fixture still grades clean when its language discovery is a pac table from before the script', () => {
  // Every common assertion and the eval's own expectations, as run-layer-1.js grades a fixture — not one check alone.
  const fs = require('node:fs');
  const { gradeFixture } = require('../run-layer-1.js');
  const evalsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals.json'), 'utf8'));
  const ev = evalsData.evals.find((e) => e.id === committed(E13).id);
  const failures = (fixture) => gradeFixture(fixture, ev, evalsData).filter((r) => r.result.status === 'fail').map((r) => `${r.text}: ${r.result.reason}`);
  assert.deepEqual(failures(committed(E13)), []);
  assert.deepEqual(failures(mutated(E13, 'workflowLog', scriptCall(), pacTable())), []);
});

test('eval 13: generated text carries no hardcoded currency symbols or date formats', () => {
  const text = 'Phase 5 (Page Builder): Generated .tsx does NOT hardcode currency symbols or date formats';
  const page = (body) => [{ name: 'page.tsx', content: `export default function GeneratedComponent() {\n  ${body}\n}\n` }];
  assertPass(gradeCode(text, committed('13-contact-localization').files));
  assertPass(gradeCode(text, page('return <Text>{`${count} items`}</Text>;')));
  assertPass(gradeCode(text, page('// never write $100 or MM/dd/yyyy here\n  return <Text>{formatCurrency(total)} {formatDate(due)}</Text>;')));
  assertFail(gradeCode(text, page('return <Text>${total}</Text>;')), /hardcoded "\$" currency symbol/);
  assertFail(gradeCode(text, page('return <Text>{`$${amount.toFixed(2)}`}</Text>;')), /hardcoded "\$" currency symbol/);
  assertFail(gradeCode(text, page("return <Text>{'Total: \u20ac'}</Text>;")), /hardcoded currency symbol "\u20ac"/);
  assertFail(gradeCode(text, page("const fmt = 'MM/dd/yyyy'; return null;")), /hardcoded date format "MM\/dd\/yyyy"/);
  assertFail(gradeCode(text, page("const f = new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD' }); return null;")), /hardcoded currency code/);
  assertFail(gradeCode(text, page("return <Text>{due.toLocaleDateString('en-US')}</Text>;")), /hardcoded locale for date formatting/);
  // `$` at a string boundary, joined onto an amount with `+`.
  assertFail(gradeCode(text, page("return <Text>{'$' + total.toFixed(2)}</Text>;")), /hardcoded "\$" currency symbol/);
  assertFail(gradeCode(text, page("const label = 'Total: $' + total; return null;")), /hardcoded "\$" currency symbol/);
  assertFail(gradeCode(text, page('const label = "Total: $ " + total; return null;')), /hardcoded "\$" currency symbol/);
  assertFail(gradeCode(text, page("const label = total + ' $'; return null;")), /hardcoded "\$" currency symbol/);
  assertFail(gradeCode(text, page('const label = `Total: $` + total; return null;')), /hardcoded "\$" currency symbol/);
  // ...while OData query options and template interpolation stay valid.
  assertPass(gradeCode(text, page("const q = '?$select=name,revenue&$top=' + n; return null;")));
  assertPass(gradeCode(text, page("const q = '$filter=statecode eq 0'; return null;")));
  assertPass(gradeCode(text, page('return <Text>{`${count}` + suffix}</Text>;')));
  // `currency:` is a number-format option only beside style: 'currency'.
  assertPass(gradeCode(text, page("const labels = { currency: 'Devise', total: 'Total' }; return null;")));
  assertPass(gradeCode(text, page("const t = { fr: { currency: 'Devise' } }; return null;")));
  assertFail(gradeCode(text, page("return <Text>{n.toLocaleString(lang, { currency: 'EUR', style: 'currency' })}</Text>;")), /hardcoded currency code/);
  // Regex literals match INPUT; they display nothing. Stripping symbols before formatting is fine.
  assertPass(gradeCode(text, page("const v = Number(raw.replace(/[$\u20ac\u00a3]/g, '')); return <Text>{formatCurrency(v)}</Text>;")));
  assertPass(gradeCode(text, page("const v = raw.replace(/^\\$\\s*/, ''); return <Text>{formatCurrency(Number(v))}</Text>;")));
  assertFail(gradeCode(text, page("const v = raw.replace(/[$]/g, ''); return <Text>{'$' + v}</Text>;")), /hardcoded "\$" currency symbol/);
  // Property keys are read as keys whether bare or quoted; the VALUE's literal type decides.
  assertFail(gradeCode(text, page('const f = new Intl.NumberFormat(lang, { "style": "currency", "currency": "USD" }); return null;')), /hardcoded currency code/);
  assertFail(gradeCode(text, page("const f = new Intl.NumberFormat(lang, { style: 'currency', currency: `USD` }); return null;")), /hardcoded currency code/);
  assertPass(gradeCode(text, page('const f = new Intl.NumberFormat(lang, { style: "currency", currency: `${currencyCode}` }); return null;')));
  assertPass(gradeCode(text, page("const f = new Intl.NumberFormat(lang, { style: 'currency', currency: settings.currencycode }); return null;")));
  assertPass(gradeCode(text, page('const labels = { "currency": "Devise", "style": "Style" }; return null;')));
  assertPass(gradeCode(text, page("const mode = isMoney ? 'currency' : 'decimal'; return null;")));
});

// JSX decodes the character references in its text and in an attribute's string (lib/jsx-references.js, the page compiler's
// own decoding), so a page shows `&euro;` as "€" and `&#36;` as "$": a symbol or a date format spelled with them is hardcoded
// exactly as its plain spelling is. A JavaScript string is not decoded, so `'&euro;'` shows those characters and no symbol.
test('eval 13: a currency symbol or a date format spelled with character references in JSX is hardcoded too', () => {
  const text = 'Phase 5 (Page Builder): Generated .tsx does NOT hardcode currency symbols or date formats';
  const page = (body) => [{ name: 'page.tsx', content: `export default function GeneratedComponent() {\n  ${body}\n}\n` }];
  assertFail(gradeCode(text, page('return <Text>&euro;{total}</Text>;')), /hardcoded currency symbol "\u20ac"/);
  assertFail(gradeCode(text, page('return <Text>{total} &pound;</Text>;')), /hardcoded currency symbol "\u00a3"/);
  assertFail(gradeCode(text, page('return <Input placeholder="&yen;" />;')), /hardcoded currency symbol "\u00a5"/);
  assertFail(gradeCode(text, page('return <Text>&#36;{total}</Text>;')), /hardcoded "\$" currency symbol/);
  assertFail(gradeCode(text, page('return <Text>&#x24;100</Text>;')), /hardcoded "\$" currency symbol/);
  assertFail(gradeCode(text, page('return <Text>$&#49;00</Text>;')), /hardcoded "\$" currency symbol/);
  assertFail(gradeCode(text, page('return <Text>MM&#47;dd&#47;yyyy</Text>;')), /hardcoded date format "MM\/dd\/yyyy"/);
  // As when written plainly, a "$" with no amount after it is not currency, nor is a reference that is no symbol.
  assertPass(gradeCode(text, page('return <Text>$</Text>;')));
  assertPass(gradeCode(text, page('return <Text>&#36;</Text>;')));
  assertPass(gradeCode(text, page('return <Text>{formatCurrency(total)} &amp; {formatDate(due)} &copy; &nbsp;</Text>;')));
  assertPass(gradeCode(text, page("return <Text>{'&euro;'}{total}</Text>;")));
  assertPass(gradeCode(text, page("const label = '&#36;' + total; return null;")));
});

// The page compiler erases a component's type arguments, so the string of a generic component's attribute renders like any
// other: `<DataGridRow<Row> title="&euro;" />` shows "€". A tag whose type arguments are not names only (a function, string,
// template or other type) is one the reader cannot bound for certain (lib/tsx-structure.js), so the check fails on it
// rather than pass a symbol it could not see.
test('eval 13: a currency symbol in a generic component\u2019s attribute is hardcoded too, and a tag the reader cannot read fails', () => {
  const text = 'Phase 5 (Page Builder): Generated .tsx does NOT hardcode currency symbols or date formats';
  const page = (body) => [{ name: 'page.tsx', content: `export default function GeneratedComponent() {\n  ${body}\n}\n` }];
  for (const tag of ['<DataGridRow<Row>', '<A <Row>', '<A /* row */ <Row>', '<A\n<Row>', '<A\r\n<Row>', '<Grid<Map<string, Row[]>>', '<A.B<T | U, V & W>', '<A<B>']) {
    assertFail(gradeCode(text, page(`return ${tag} title="&euro;" />;`)), /hardcoded currency symbol "\u20ac"/);
  }
  assertFail(gradeCode(text, page('return <DataGridRow<Row> title="&#36;100" />;')), /hardcoded "\$" currency symbol/);
  assertPass(gradeCode(text, page('return <DataGridRow<Row> title={t("total")} aria-label="&amp;" />;')));
  const unreadable = [
    '<A<() => () => "<B<() => string>>"> title="&euro;">Hello</A>',
    '<DataGridRow<() => () => string /* <B<() => string>> */> title="&euro;" />',
    '<A<() => "a\\\nb"> title="&euro;" />',
    '<A<() => "a\\\r\nb"> title="&euro;" />',
    '<A<() => `x${string /* the type\'s name */}y`> title={t("ok")} />',
    '<A<"a\\"//"> title="&euro;" />',
    '<A<"a\\"/*"> title="&euro;" />',
  ];
  for (const tag of unreadable) {
    const name = tag.match(/^<(\w+)/)[1];
    assertFail(gradeCode(text, page(`return ${tag};`)), new RegExp(`^page\\.tsx: <${name}> at line 2, column 10 has type arguments that are not only names`));
  }
});

// --- Eval 15 -----------------------------------------------------------------------------------

const E15 = '15-support-tickets-real';

test('eval 15: cr_ticket is found absent and planned with priority/status choices and a due date', () => {
  const absent = 'Phase 1 (Planner): cr_ticket is identified as NOT existing';
  const choices = 'Phase 1 (Planner): Plan includes choice column definitions for priority and status under Choice Columns, with numeric option values starting at 100000000';
  const due = 'Phase 1 (Planner): Plan includes a datetime column for due date';
  assertPass(grade(absent, committed(E15)));
  assertPass(grade(choices, committed(E15)));
  assertPass(grade(due, committed(E15)));
  assertFail(grade(absent, mutated(E15, 'workflowLog', 'No tables found matching the specified criteria.\nResult: cr_ticket does NOT exist → needs creation.', 'Found 1 table: cr_ticket.')),
    /does not record cr_ticket as absent/);
  assertFail(grade(choices, mutated(E15, 'genpagePlan', 'Low (100000000)', 'Low (1)')), /priority option values 1, 100000001/);
  assertFail(grade(choices, mutated(E15, 'genpagePlan', '| status | Open', '| state | Open')), /Choice Columns has no status row/);
  assertFail(grade(due, mutated(E15, 'genpagePlan', '| duedate | datetime |', '| duedate | string |')), /duedate has type string, not datetime/);
});

test('eval 15: the entity-builder runs only after an ok:true check-auth result', () => {
  const text = 'Phase 2a: scripts/check-auth.js returns ok:true before entity-builder is invoked';
  assertPass(grade(text, committed(E15)));
  assertFail(grade(text, mutated(E15, 'workflowLog', 'Result: ok=true, identitiesMatch=true', 'Result: ok=false, blocker=whoami_403')),
    /without the latest successful auth gate/);
  assertFail(grade(text, { ...committed(E15), workflowLog: '- `node scripts/check-auth.js` → returned `{ ok: true, ... }`\n' }), /entity-builder was never invoked/);
});

test('eval 15: provisioned picklists, read from the generated RuntimeTypes.ts', () => {
  const priority = 'Phase 2b (Entity Builder): Priority picklist has 4 options starting at 100000000 (Low=100000000, Medium=100000001, High=100000002, Critical=100000003)';
  const status = 'Phase 2b (Entity Builder): Status picklist has 4 options starting at 100000000';
  assertPass(grade(priority, committed(E15)));
  assertPass(grade(status, committed(E15)));
  assertFail(grade(priority, mutated(E15, 'runtimeTypes', '"Critical" = 100000003,', '')), /has 3 option\(s\), expected 4/);
  assertFail(grade(priority, mutated(E15, 'runtimeTypes', '"Medium" = 100000001,', '"Normal" = 100000001,')), /options are Low=100000000, Normal=100000001/);
  assertFail(grade(status, mutated(E15, 'runtimeTypes', '"Open" = 100000000,', '"Open" = 1,')), /values are 1, 100000001/);
  assertFail(grade(status, mutated(E15, 'runtimeTypes', '"cr_ticket-cr_status": cr_ticket_cr_status,', '')), /registers no ticket-status choice/);
  assertSkip(grade(status, { ...committed(E15), runtimeTypes: null }), /RuntimeTypes\.ts was not captured/);
});

test('eval 15: the solution travels in the input JSON and matches ## Environment', () => {
  const text = 'Phase 2b (Entity Builder): Solution is specified via provision-entities.js input JSON; verified through ## Environment → Solution: declaration';
  assertPass(grade(text, committed(E15)));
  assertFail(grade(text, mutated(E15, 'entityCreationLog', '- Solution: Crdec34', '- Solution: Default')), /transaction log records Solution: Default, plan declares Crdec34/);
  assertFail(grade(text, mutated(E15, 'workflowLog', '--input @D:/temp/support-tickets/provision-input.json --apply', '--solution Default --input @D:/temp/support-tickets/provision-input.json --apply')),
    /--solution Default contradicts Solution: Crdec34/);
  assertFail(grade(text, mutated(E15, 'workflowLog', '--input @D:/temp/support-tickets/provision-input.json ', '')), /not run with --input <json>/);
});

test('eval 15: every create in the transaction log carries its metadata id', () => {
  const text = 'Phase 2b (Entity Builder): Transaction log (genpage-entity-creation-log.md) records each create with its returned metadataId';
  assertPass(grade(text, committed(E15)));
  assertFail(grade(text, mutated(E15, 'entityCreationLog', '| cr_ticket | Due Date | cr_DueDate | cr_duedate | n/a |', '| cr_ticket | Due Date | cr_DueDate | cr_duedate | ... |')),
    /Created Columns cr_duedate has Metadata ID \.\.\./);
  assertFail(grade(text, mutated(E15, 'entityCreationLog', '| cr_ticket | Due Date | cr_DueDate | cr_duedate | n/a |', '')), /column duedate of cr_ticket has no Created Columns row/);
  // A GUID is a recorded id too.
  assertPass(grade(text, mutated(E15, 'entityCreationLog', '| cr_ticket | Due Date | cr_DueDate | cr_duedate | n/a |', '| cr_ticket | Due Date | cr_DueDate | cr_duedate | 0f8fad5b-d9cb-469f-a165-70867728950e |')));
});

test('eval 15: genpage.js types picks up an enum registration for every planned choice column', () => {
  const text = 'Phase 4: genpage.js types picks up the enum registrations';
  assertPass(grade(text, committed(E15)));
  assertFail(grade(text, mutated(E15, 'runtimeTypes', '"cr_ticket-cr_status": cr_ticket_cr_status,', '')), /EnumRegistrations has no ticket-status entry/);
  assertFail(grade(text, mutated(E15, 'runtimeTypes', '"Closed" = 100000003,', '"Closed" = 100000004,')), /values 100000000,100000001,100000002,100000004 differ/);
  assertFail(grade(text, mutated(E15, 'workflowLog', 'generate-types --data-sources "cr_ticket"', 'generate-types --data-sources "contact"')), /no genpage\.js types run has --data-sources cr_ticket/);
  assertSkip(grade(text, { ...committed(E15), runtimeTypes: null }), /RuntimeTypes\.ts was not captured/);
});

// The input JSON as agents/genpage-entity-builder.md Step 4 has the entity-builder write it, for eval 15's plan: each Choice option is its
// label, in the plan's order. The capture did not keep its input, so the cases below hand it one.
const TICKET_CHOICES = "Phase 2b (Entity Builder): cr_ticket is provisioned with choice columns via provision-entities.js input JSON; each picklist option is written as its label, in the plan's order (numbered 100000000 + index)";
function ticketInput(priority = ['Low', 'Medium', 'High', 'Critical'], status = ['Open', 'In Progress', 'Resolved', 'Closed']) {
  return {
    solution: { uniqueName: 'Crdec34', publisherPrefix: 'cr' },
    entities: [{
      schemaName: 'cr_Ticket', displayName: 'Ticket', pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'cr_name', displayName: 'Name', maxLength: 100 },
      columns: [
        { schemaName: 'cr_Priority', displayName: 'Priority', type: 'Choice', options: priority },
        { schemaName: 'cr_Status', displayName: 'Status', type: 'Choice', options: status },
        { schemaName: 'cr_DueDate', displayName: 'Due Date', type: 'DateTime', dateFormat: 'DateOnly' },
      ],
    }],
    relationships: [],
  };
}
const withInput = (input) => ({ ...committed(E15), artifacts: { ...committed(E15).artifacts, 'provision-input.json': typeof input === 'string' ? input : JSON.stringify(input) } });

test('eval 15: the choice options of the input JSON are labels in the plan\'s order, as provision-entities.js takes them', () => {
  assertPass(grade(TICKET_CHOICES, withInput(ticketInput())));
  // A label in several languages is a label too.
  assertPass(grade(TICKET_CHOICES, withInput(ticketInput([{ 1033: 'Low', 1036: 'Bas' }, 'Medium', 'High', 'Critical']))));
  // The shape the entity-builder page used to show: refused by the plugin's own gate, before anything is written.
  const labelValue = ticketInput(['Low', 'Medium', 'High', 'Critical'].map((label, i) => ({ label, value: 100000000 + i })));
  assertFail(grade(TICKET_CHOICES, withInput(labelValue)), /provision-entities\.js refuses the captured input: .*options\[0\]: 'label' is not an LCID/);
  assertFail(grade(TICKET_CHOICES, withInput(ticketInput(['Medium', 'Low', 'High', 'Critical']))), /ticket priority options are "Medium", "Low", "High", "Critical", but the plan numbers Low, Medium, High, Critical from 100000000/);
  assertFail(grade(TICKET_CHOICES, withInput(ticketInput(undefined, ['Open', 'Resolved', 'Closed']))), /ticket status options are .*, but the plan numbers Open, In Progress, Resolved, Closed/);
  const noStatus = ticketInput();
  noStatus.entities[0].columns.splice(1, 1);
  assertFail(grade(TICKET_CHOICES, withInput(noStatus)), /declares no ticket status column/);
  const textStatus = ticketInput();
  textStatus.entities[0].columns[1] = { schemaName: 'cr_Status', displayName: 'Status', type: 'Text' };
  assertFail(grade(TICKET_CHOICES, withInput(textStatus)), /ticket status is Text, not a Choice column/);
  assertFail(grade(TICKET_CHOICES, withInput('{ not json')), /provision-input\.json is not JSON/);
  assertFail(grade(TICKET_CHOICES, { ...withInput(ticketInput()), workflowLog: committed(E15).workflowLog.replace('--input @D:/temp/support-tickets/provision-input.json ', '') }), /not run with --input <json>/);
});

test('eval 15: a capture that did not keep its input JSON is skipped, and a current fixture without it fails', () => {
  assertSkip(grade(TICKET_CHOICES, committed(E15)), /provision-input\.json was not captured/);
  assertFail(grade(TICKET_CHOICES, { ...committed(E15), contractVersion: 2, manifest: { contractVersion: 2, provenance: 'synthetic' } }), /provision-input\.json was not captured/);
});

// A table is provisioned by a run that APPLIED its input: provision-entities.js without --apply only plans, writes nothing, and answers
//   { "ok": true, "dryRun": true, "plan": [ … ] }
// so such a run is no provisioning, however good its input. The input graded is the one the applying run was handed, not a preview's.
function provisionedBy(events, artifacts) {
  return { ...committed(E15), contractVersion: 2, manifest: { contractVersion: 2, provenance: 'synthetic' }, artifacts: { ...committed(E15).artifacts, ...artifacts }, events };
}
const provisionRun = (id, input, flags, result) => ({ id, command: `node scripts/provision-entities.js --env https://contoso.crm.dynamics.com --input @${input}${flags}`, result });

test('eval 15: a dry run of provision-entities.js provisions nothing, and the input graded is the applying run\'s', () => {
  const good = JSON.stringify(ticketInput());
  const labelValue = JSON.stringify(ticketInput(['Low', 'Medium', 'High', 'Critical'].map((label, i) => ({ label, value: 100000000 + i }))));
  const applied = { ok: true, entities: [{ schemaName: 'cr_Ticket', logicalName: 'cr_ticket', entitySetName: 'cr_tickets' }] };
  const planned = { ok: true, dryRun: true, plan: [{ step: 'createTable', schemaName: 'cr_Ticket' }] };
  assertPass(grade(TICKET_CHOICES, provisionedBy([provisionRun('apply', 'provision-input.json', ' --apply', applied)], { 'provision-input.json': good })));
  // Planned only: no --apply, and the CLI's own dry-run answer.
  assertFail(grade(TICKET_CHOICES, provisionedBy([provisionRun('plan', 'provision-input.json', '', planned)], { 'provision-input.json': good })),
    /provision-entities\.js was not run with --input <json> --apply/);
  // An answer that says it was a dry run is no apply, whatever flags were recorded with it.
  assertFail(grade(TICKET_CHOICES, provisionedBy([provisionRun('apply', 'provision-input.json', ' --apply', planned)], { 'provision-input.json': good })),
    /provision-entities\.js was not run with --input <json> --apply/);
  // A preview with another input file, then the apply: the apply's input decides — either way round.
  const previewThenApply = [provisionRun('plan', 'preview-input.json', '', planned), provisionRun('apply', 'provision-input.json', ' --apply', applied)];
  assertPass(grade(TICKET_CHOICES, provisionedBy(previewThenApply, { 'preview-input.json': labelValue, 'provision-input.json': good })));
  assertFail(grade(TICKET_CHOICES, provisionedBy(previewThenApply, { 'preview-input.json': good, 'provision-input.json': labelValue })),
    /provision-entities\.js refuses the captured input: .*options\[0\]: 'label' is not an LCID/);
  // The applying run's input was not kept: a current fixture fails, though the preview's was.
  assertFail(grade(TICKET_CHOICES, provisionedBy(previewThenApply, { 'preview-input.json': good })), /provision-input\.json was not captured/);
});

// --- Eval 19 -----------------------------------------------------------------------------------

const E19 = '19-add-weather-connector';

test('eval 19: the edited page comes from a genpage list of the selected app', () => {
  const text = 'Edit Phase 1b: After app selection, genpage.js list --app-id <selected> is run to discover pages — orchestrator does NOT guess or invent page names';
  assertPass(grade(text, committed(E19)));
  assertFail(grade(text, mutated(E19, 'workflowLog', 'pac model genpage list --app-id aa112233-1122-1122-1122-aabbccdd1234', 'pac model genpage list --app-id cc334455-3344-3344-3344-ccddeeff3456')),
    /genpage\.js list --app-id aa112233-1122-1122-1122-aabbccdd1234 was not run/);
  assertFail(grade(text, mutated(E19, 'workflowLog', '  - Seattle Weather — `bb223344-2233-2233-2233-bbccddee2345`', '  - Seattle Weather')),
    /page bb223344-2233-2233-2233-bbccddee2345 does not appear in the recorded genpage list output/);
  assertFail(grade(text, mutated(E19, 'workflowLog', '- `pac model list` → 2 apps found:', '- apps recalled from memory:')), /before the app was discovered/);
});

test('eval 19: genpage-edit-plan.md is written at the working-directory root', () => {
  const text = 'Edit Phase 4: genpage-edit-plan.md is written to the working directory root (not inside <page-id>/)';
  assertPass(grade(text, committed(E19)));
  assertFail(grade(text, { ...committed(E19), genpageEditPlan: null }), /not at the working-directory root/);
  assertFail(grade(text, mutated(E19, 'workflowLog', '`genpage-edit-plan.md` written to the working directory root (not inside `bb223344-…/`)',
    'genpage-edit-plan.md written to seattle-weather-edit/bb223344-2233-2233-2233-bbccddee2345/genpage-edit-plan.md')),
    /written inside the <page-id>\/ folder/);
  assertSkip(grade(text, committed('4-case-wizard')), /create flow/);
});

// --- Contract-2 fixtures: helpers for event and artifact mutations ------------------------------

// A copy of a committed fixture whose ordered tool-result events are rewritten by `change`.
function withEvents(dirName, change) {
  const base = committed(dirName);
  return { ...base, events: change(structuredClone(base.events)) };
}

function event(events, id) {
  const found = events.find((e) => e.id === id);
  assert.ok(found, `fixture event ${id} exists`);
  return found;
}

function withArtifact(dirName, name, from, to) {
  const base = committed(dirName);
  return { ...base, artifacts: { ...base.artifacts, [name]: to === undefined ? from : edit(base.artifacts[name], from, to) } };
}

function withoutArtifact(dirName, name) {
  const base = committed(dirName);
  const artifacts = { ...base.artifacts };
  assert.ok(name in artifacts, `fixture artifact ${name} exists`);
  delete artifacts[name];
  return { ...base, artifacts };
}

// --- Eval 3: the edit flow (the app and page listing test is in the last section) ---------------
// Each test grades one expectation of the edit flow against the committed synthetic fixture.
test('eval 3: config.json dataSources drive RuntimeTypes generation', () => {
  const text = "Edit Phase 3: config.json is read; since dataSources contains 'contact', RuntimeTypes.ts is generated";
  assertPass(grade(text, committed(E3)));
  assertFail(grade(text, withArtifact(E3, 'before/config.json', '"dataSources": ["contact"]', '"dataSources": []')), /dataSources are none, not contact/);
  assertFail(grade(text, withEvents(E3, (ev) => { event(ev, 'generate-types').command = event(ev, 'generate-types').command.replace("--data-sources 'contact'", "--data-sources 'account'"); return ev; })),
    /not run with config\.json's dataSources contact \(saw account\)/);
  assertSkip(grade(text, withoutArtifact(E3, 'before/config.json')), /config\.json was not captured/);
});

test('eval 3: the edit plan restates what the planner read from the downloaded <page-id>/ folder', () => {
  const text = 'Edit Phase 4: edit-planner reads page.tsx, config.json, and prompt.txt from the <page-id>/ folder';
  assertPass(grade(text, committed(E3)));
  assertFail(grade(text, mutated(E3, 'genpageEditPlan', '- **Original prompt (from prompt.txt):** Build a contacts directory page', '- **Original prompt (from prompt.txt):** Build a contacts gallery page')),
    /original prompt differs from the downloaded prompt\.txt/);
  assertFail(grade(text, mutated(E3, 'genpageEditPlan', '- **Absolute path:** D:/work/contacts-search-sort/22222222-3333-4444-5555-666666666666/page.tsx', '- **Absolute path:** D:/work/contacts-search-sort/page.tsx')),
    /is not inside the downloaded 22222222-3333-4444-5555-666666666666\/ folder/);
  assertFail(grade(text, mutated(E3, 'genpageEditPlan', '- **Original data sources (from config.json):** contact', '- **Original data sources (from config.json):** account')),
    /original data sources account differ from config\.json's contact/);
  assertSkip(grade(text, withoutArtifact(E3, 'before/prompt.txt')), /snapshot was not captured/);
});

test('eval 3: Edit Phase 5 reads the edit plan, rules, RuntimeTypes and the page; search and sort use Fluent UI V9', () => {
  const reads = 'Edit Phase 5: Orchestrator reads genpage-edit-plan.md, rules.md, RuntimeTypes.ts, and page.tsx';
  const ui = 'Edit Phase 5: Search implementation uses Fluent UI V9 SearchBox or Input; sort uses column header handlers';
  assertPass(grade(reads, committed(E3)));
  assertPass(grade(ui, committed(E3)));
  assertFail(grade(reads, mutated(E3, 'workflowLog', 'Orchestrator read genpage-edit-plan.md, references/rules.md, RuntimeTypes.ts', 'Orchestrator read genpage-edit-plan.md, RuntimeTypes.ts')),
    /does not record reading rules\.md/);
  assertFail(grade(ui, withFile(E3, 'page.tsx', '<SearchBox', '<Text')), /no Fluent UI V9 SearchBox or Input is imported and rendered/);
  assertFail(grade(ui, withFile(E3, 'page.tsx', 'onSortChange={(_, next) => setSortState(next)}', '')), /not sorted through column header handlers/);
  // A comment naming SearchBox is not a search control.
  assertFail(grade(ui, withFile(E3, 'page.tsx', '<SearchBox', '{/* <SearchBox /> */}<Text')), /no Fluent UI V9 SearchBox/);
});

// --- Eval 9 ------------------------------------------------------------------------------------

const E9 = '9-project-tracker-new-entities';

test('eval 9: both tables are absent, planned with the milestone → project lookup, behind the solution question', () => {
  const absent = 'Phase 1 (Planner): cr_project and cr_milestone confirmed as NOT existing';
  const lookup = 'Phase 1 (Planner): Plan includes a lookup relationship (cr_milestone → cr_project)';
  const solution = 'Phase 1 (Planner): Solution selection question is asked because new entities will be created';
  for (const text of [absent, lookup, solution]) assertPass(grade(text, committed(E9)));
  assertFail(grade(absent, withEvents(E9, (ev) => { event(ev, 'list-tables-search').result = { ok: true, search: ['cr_project', 'cr_milestone'], exact: true, count: 1, tables: [{ logicalName: 'cr_project', displayName: 'Project', schemaName: 'cr_Project', isCustom: true }], missing: ['cr_milestone'] }; return ev; })),
    /does not record cr_project as absent/);
  assertFail(grade(lookup, mutated(E9, 'genpagePlan', '| 1:N lookup | project | project | RemoveLink |', '| none | none | none | none |')), /milestone has no lookup relationship to project/);
  assertFail(grade(solution, mutated(E9, 'genpagePlan', '- Solution: ContosoProjects', '- Solution: FieldSurveys')), /maker answered "Continue in 'ContosoProjects'/);
});

test('eval 9: provision-entities.js creates both tables and the lookup from one input', () => {
  const text = 'Phase 2b (Entity Builder): cr_project and cr_milestone entities are provisioned with lookup relationship (cr_milestone → cr_project) via provision-entities.js; dependency ordering is handled automatically';
  assertPass(grade(text, committed(E9)));
  const input = JSON.parse(committed(E9).artifacts['provision-input.json']);
  assertFail(grade(text, withArtifact(E9, 'provision-input.json', JSON.stringify({ ...input, relationships: [] }))), /declares no project → milestone OneToMany relationship/);
  assertFail(grade(text, mutated(E9, 'entityCreationLog', '| 1:N  | cr_project | cr_milestone |', '| 1:N  | cr_milestone | cr_project |')), /no project → milestone \(1:N\) row/);
  assertFail(grade(text, withEvents(E9, (ev) => { event(ev, 'provision-data-model').result = { ok: false, error: 'throttled' }; return ev; })), /did not return ok:true/);
  assertFail(grade(text, withArtifact(E9, 'provision-input.json', '{ not json')), /provision-input\.json is not JSON/);
});

test('eval 9: sample data is seeded because the prompt asked, with milestones bound to seeded projects', () => {
  const requested = 'Phase 2b (Entity Builder): Sample data is created because the user explicitly requested it in the prompt';
  const parents = 'Phase 2b (Entity Builder): Sample records respect relationships (milestones reference projects via $parent/match convention)';
  assertPass(grade(requested, committed(E9)));
  assertPass(grade(parents, committed(E9)));
  assertFail(grade(requested, mutated(E9, 'genpagePlan', 'entities with sample data to test the page.', 'entities.')), /does not ask for sample data/);
  assertFail(grade(requested, mutated(E9, 'workflowLog', 'for testing? → Yes, add sample data', 'for testing? → No, skip')), /answer was "No, skip/);
  const input = JSON.parse(committed(E9).artifacts['provision-input.json']);
  const typo = structuredClone(input);
  typo.sampleData.cr_Milestone[0].$parent.match.cr_name = 'Contoso Website Redesing';
  assertFail(grade(parents, withArtifact(E9, 'provision-input.json', JSON.stringify(typo))), /milestone row 1 matches no seeded project/);
  const orphan = structuredClone(input);
  delete orphan.sampleData.cr_Milestone[2].$parent;
  assertFail(grade(parents, withArtifact(E9, 'provision-input.json', JSON.stringify(orphan))), /milestone row 3 has no \$parent\/match reference/);
  assertSkip(grade(parents, withoutArtifact(E9, 'provision-input.json')), /provision-input\.json was not captured/);
});

test('eval 9: the upload binds both created tables', () => {
  const text = 'Phase 6: Deployment includes --data-sources with both entity names';
  assertPass(grade(text, committed(E9)));
  assertFail(grade(text, withEvents(E9, (ev) => { event(ev, 'create').command = event(ev, 'create').command.replace("--data-sources 'cr_project,cr_milestone'", "--data-sources 'cr_project'"); return ev; })),
    /--data-sources is cr_project, expected cr_project,cr_milestone/);
});

// --- Eval 12 -----------------------------------------------------------------------------------

const E12 = '12-account-plan-revision';

test('eval 12: present, request a revision, revise, re-present and approve — in that order', () => {
  const initial = 'Phase 1 (Planner): Initial plan is presented via EnterPlanMode';
  const request = 'Phase 1 (Planner): User requests a revision (ExitPlanMode with changes-requested response)';
  const revise = 'Phase 1 (Planner): Planner revises the plan based on user feedback and re-enters plan mode';
  const second = 'Phase 1 (Planner): User approves the revised plan on the second presentation';
  for (const text of [initial, request, revise, second]) assertPass(grade(text, committed(E12)));
  assertFail(grade(initial, mutated(E12, 'workflowLog', '- EnterPlanMode called with the initial plan:', '- Plan shown in chat:')), /precedes the first plan presentation/);
  const approvedFirst = mutated(E12, 'workflowLog', '- ExitPlanMode called → changes requested (revised): "add a search box in addition to the filter toolbar"', '- ExitPlanMode called → approved');
  assertFail(grade(request, approvedFirst), /not a change request/);
  assertFail(grade(second, approvedFirst), /first presentation was not answered with a change request/);
  assertFail(grade(request, mutated(E12, 'workflowLog', '→ changes requested (revised): "add a search box in addition to the filter toolbar"', '→ changes requested')),
    /does not record what the maker asked for/);
  // With the revision re-invocation gone, the only planner call left is the approval writeback, which
  // comes after the re-presentation.
  assertFail(grade(revise, mutated(E12, 'workflowLog', '- Task genpage-planner re-invoked with the revision request', '- Revised the plan inline with the revision request')),
    /plan mode was re-entered before the planner revised the plan/);
  assertFail(grade(second, mutated(E12, 'workflowLog', '- EnterPlanMode called with the revised plan (search box + filter toolbar + sortable columns)\n- ExitPlanMode called → approved',
    '- EnterPlanMode called with the revised plan (search box + filter toolbar + sortable columns)\n- ExitPlanMode called → changes requested ("smaller header")')), /second presentation was not approved/);
});

test('eval 12: the approved and written plan carry the requested search box', () => {
  const reflects = "Phase 1 (Planner): Revised plan reflects the user's requested changes (search box added)";
  const written = 'Phase 1 (Planner): genpage-plan.md reflects the approved (revised) version, not the initial version';
  assertPass(grade(reflects, committed(E12)));
  assertPass(grade(written, committed(E12)));
  const base = committed(E12);
  const noSearch = base.artifacts['.approved-genpage-plan.md'].replace(/search box/gi, 'header');
  assertFail(grade(reflects, withArtifact(E12, '.approved-genpage-plan.md', noSearch)), /approved revised plan has no search box/);
  assertFail(grade(reflects, withArtifact(E12, '.approved-genpage-plan.md', base.artifacts['.approved-genpage-plan.md'].replace(/filter toolbar/gi, 'filters'))), /dropped the filter toolbar/);
  // An initial-version plan: no search box anywhere.
  assertFail(grade(written, { ...base, genpagePlan: base.genpagePlan.replace(/search box|SearchBox/gi, 'header') }), /is the initial version: it has no search box/);
  assertFail(grade(written, mutated(E12, 'genpagePlan', '| Accounts | account-list.tsx |', '| Accounts | accounts.tsx |')), /genpage-plan\.md targets \["accounts\.tsx"\], the approved plan \["account-list\.tsx"\]/);
  assertFail(grade(written, withEvents(E12, (ev) => { event(ev, 'plan-verify').result.ok = false; return ev; })), /verification of genpage-plan\.md did not pass/);
});

// --- Eval 14 -----------------------------------------------------------------------------------

const E14 = '14-account-list-edit-collision';
const STALE = '.genpage-provenance/genpage-plan.stale-e0fbb49f3c98.md';

test('eval 14: the first plan has two pages whose shared file name the Phase 5a gate detects', () => {
  const initial = 'Phase 1 (Planner): Plan initially contains a Pages table with 2 pages';
  const detects = 'Phase 5a: Orchestrator reads the Pages table and detects duplicate filenames';
  assertPass(grade(initial, committed(E14)));
  assertPass(grade(detects, committed(E14)));
  assertFail(grade(initial, withArtifact(E14, STALE, committed(E12).genpagePlan)), /first plan's ## Pages has 1 row\(s\), expected 2/);
  assertFail(grade(detects, withEvents(E14, (ev) => { Object.assign(event(ev, 'page-files-1').result, { ok: true, problems: [] }); return ev; })),
    /did not report the collision/);
  assertFail(grade(detects, withEvents(E14, (ev) => { event(ev, 'page-files-1').result.files = ['account-list.tsx', 'account-edit.tsx']; return ev; })),
    /the gate read account-list\.tsx,account-edit\.tsx, but the plan's Pages table lists account\.tsx,account\.tsx/);
  assertFail(grade(detects, withEvents(E14, (ev) => {
    const i = ev.findIndex((e) => e.id === 'page-files-1');
    return [...ev.slice(0, i), { id: 'early-stamp', command: 'node scripts\\genpage-worker-output.js --stamp --file account.tsx', result: { ok: true, existed: false } }, ...ev.slice(i)];
  })), /page dispatch started before the page-file gate ran/);
});

test('eval 14: the refused plan is re-planned and re-approved, never renamed in place, before dispatch', () => {
  const text = "Phase 5a: check-page-files.js refuses the colliding plan and the orchestrator halts and re-plans through the planner (it never renames files itself), so genpage-plan.md carries unique, re-approved filenames (e.g., account-list.tsx, account-edit.tsx) before any builder is dispatched";
  assertPass(grade(text, committed(E14)));
  const insertAfterRefusal = (entry) => withEvents(E14, (ev) => {
    const i = ev.findIndex((e) => e.id === 'page-files-1') + 1;
    return [...ev.slice(0, i), entry, ...ev.slice(i)];
  });
  assertFail(grade(text, insertAfterRefusal({ id: 'stamp', command: 'node scripts\\genpage-worker-output.js --stamp --file account.tsx', result: { ok: true, existed: false } })),
    /ran after the refusal, before a passing re-plan/);
  assertFail(grade(text, insertAfterRefusal({ id: 'rename', command: 'Edit genpage-plan.md (rename the second account.tsx to account-edit.tsx)' })),
    /orchestrator edited genpage-plan\.md itself/);
  assertFail(grade(text, withEvents(E14, (ev) => { event(ev, 'plan-prepare-2').result.quarantinedPath = null; return ev; })), /was not quarantined/);
  assertFail(grade(text, withEvents(E14, (ev) => { event(ev, 'page-files-2').result.ok = false; return ev; })), /no later check-page-files\.js run passed/);
  assertFail(grade(text, mutated(E14, 'workflowLog', '- Task genpage-planner re-invoked with the check-page-files problem', '- Renamed the files in the plan')),
    /were not re-planned by genpage-planner and re-approved/);
  assertFail(grade(text, withArtifact(E14, '.approved-genpage-plan.md', committed(E14).artifacts['.approved-genpage-plan.md'].replace('account-edit.tsx', 'account-detail.tsx'))),
    /are not the re-approved/);
});

test('eval 14: two parallel builders write two distinct, intact pages that deploy separately', () => {
  const parallel = 'Phase 5c: Two page-builders are invoked in parallel with distinct target filenames';
  const intact = "Phase 5c: No builder overwrites another builder's output (both .tsx files exist after Phase 5)";
  const deployed = 'Phase 6: Both pages are deployed with their distinct filenames';
  for (const text of [parallel, intact, deployed]) assertPass(grade(text, committed(E14)));
  // Adjacent dispatches ARE the parallel evidence; a log that never says "single message" or
  // "in parallel" (a correct run need not) must still pass.
  const plainLog = committed(E14).workflowLog.replace(/single message|in parallel|\(parallel\)/gi, 'together');
  assert.doesNotMatch(plainLog, /single message|in parallel/i);
  assertPass(grade(parallel, { ...committed(E14), workflowLog: plainLog }));
  assertFail(grade(parallel, withEvents(E14, (ev) => { event(ev, 'builder-edit').command = 'Task genpage-page-builder: Edit Account, target file account-list.tsx'; return ev; })),
    /both page-builders target account-list\.tsx/);
  assertFail(grade(parallel, withEvents(E14, (ev) => {
    const i = ev.findIndex((e) => e.id === 'builder-edit');
    return [...ev.slice(0, i), { id: 'gate-list-early', command: 'node scripts\\genpage-worker-output.js --file account-list.tsx', result: { ok: true, problems: [] } }, ...ev.slice(i)];
  })), /were not dispatched together/);
  const base = committed(E14);
  const list = base.files.find((f) => f.name === 'account-list.tsx');
  assertFail(grade(intact, { ...base, files: base.files.map((f) => (f.name === 'account-edit.tsx' ? { ...f, content: list.content } : f)) }), /identical content/);
  assertFail(grade(intact, { ...base, files: base.files.filter((f) => f.name !== 'account-edit.tsx') }), /account-edit\.tsx does not exist after Phase 5/);
  assertFail(grade(intact, withEvents(E14, (ev) => { event(ev, 'stamp-edit').result.existed = true; return ev; })), /account-edit\.tsx was not stamped as a fresh target/);
  assertFail(grade(deployed, withEvents(E14, (ev) => { event(ev, 'edit-create').command = event(ev, 'edit-create').command.replace('--code-file before\\account-edit.tsx', '--code-file before\\account-list.tsx'); return ev; })),
    /account-list\.tsx has 2 create upload/);
  assertFail(grade(deployed, withEvents(E14, (ev) => { event(ev, 'edit-create').result.pageId = event(ev, 'list-create').result.pageId; return ev; })),
    /two create uploads returned the same page id/);
});

// --- Eval 16 -----------------------------------------------------------------------------------

const E16 = '16-account-list';

test('eval 16: the written plan conforms to plan-schema.md section by section', () => {
  const conforms = 'Phase 1 (Planner): genpage-plan.md is written and conforms to references/plan-schema.md';
  const headings = 'Phase 1 (Planner): genpage-plan.md contains ALL required sections with exact headings: # Genpage Plan, ## User Requirements, ## Working Directory, ## Plugin Root, ## Environment, ## Pages, ## Entity Creation Required, ## Existing Entities, ## Design Preferences, ## Relevant Samples, ## Per-Page Specifications';
  const table = 'Phase 1 (Planner): ## Pages table has at least one row with columns Page, File, Purpose, Entities';
  const specs = 'Phase 1 (Planner): ## Per-Page Specifications has one ### <Page Name> subsection for each row in ## Pages';
  const unique = 'Phase 1 (Planner): File names in ## Pages are unique';
  for (const text of [conforms, headings, table, specs, unique]) assertPass(grade(text, committed(E16)));
  assertFail(grade(conforms, mutated(E16, 'genpagePlan', '## Relevant Samples', '## Samples')), /missing required section "## Relevant Samples"/);
  assertFail(grade(conforms, withEvents(E16, (ev) => { event(ev, 'plan-verify').result.targets = ['other.tsx']; return ev; })), /verified targets other\.tsx are not this plan's files/);
  assertFail(grade(conforms, withEvents(E16, (ev) => ev.filter((e) => e.id !== 'plan-verify'))), /was not provenance-verified/);
  assertFail(grade(headings, mutated(E16, 'genpagePlan', '## Pages\n', '## Page List\n')), /missing exact heading "## Pages"/);
  assertFail(grade(headings, mutated(E16, 'genpagePlan', '# Genpage Plan\n', '# Plan\n')), /missing exact heading "# Genpage Plan"/);
  assertFail(grade(table, mutated(E16, 'genpagePlan', '| Account List | account-list.tsx | Simple sortable list of Account records with click-to-open | account |', '| Account List | account-list.tsx |  | account |')),
    /row "Account List" has an empty cell/);
  assertFail(grade(specs, mutated(E16, 'genpagePlan', '### Account List', '### Accounts')), /no "### Account List" subsection/);
  const twoRows = mutated(E16, 'genpagePlan', '| Account List | account-list.tsx | Simple sortable list of Account records with click-to-open | account |',
    '| Account List | account-list.tsx | Simple sortable list of Account records with click-to-open | account |\n| Account Grid | Account-List.tsx | Grid | account |');
  assertFail(grade(unique, twoRows), /file names collide/);
});

test('eval 16: account exists, so the plan uses the no-creation sentence and lists account for RuntimeTypes', () => {
  const sentinel = "Phase 1 (Planner): Because the account entity exists, ## Entity Creation Required contains the literal string 'No entity creation required — all entities already exist.'";
  const existing = 'Phase 1 (Planner): ## Existing Entities contains the entity logical name used for RuntimeTypes generation (account)';
  assertPass(grade(sentinel, committed(E16)));
  assertPass(grade(existing, committed(E16)));
  assertFail(grade(sentinel, mutated(E16, 'genpagePlan', 'No entity creation required — all entities already exist.', 'No entity creation needed.')), /exact no-entity sentence/);
  assertFail(grade(sentinel, withEvents(E16, (ev) => { event(ev, 'list-tables').command = event(ev, 'list-tables').command.replace("--search 'account'", "--search 'contact'"); return ev; })), /no list-tables --search covered account/);
  assertFail(grade(existing, mutated(E16, 'genpagePlan', '## Existing Entities\naccount', '## Existing Entities\ncontact')), /lists contact, not account/);
  assertFail(grade(existing, withEvents(E16, (ev) => { event(ev, 'generate-types').command = "node 'D:/repo/plugins/model-apps/scripts/genpage.js' types --env 'https://contoso.crm.dynamics.com' --data-sources 'account,contact' --output-file 'RuntimeTypes.ts'"; return ev; })), /genpage\.js types used contact, which ## Existing Entities does not list/);
});

// --- Evals 3 and 8: the app listing, and the app create, through apps.js -------------------------
//
// All of eval 8's tests are here, and the app-listing test of eval 3; the rest of eval 3 is above. `apps.js list` is read as data (`apps`), and a new app is built from the first page
// (SKILL.md Phase 6, "A new app") — the first page uploaded with no app, `apps.js create` after it, then every upload naming the app it returned.

test('eval 3: apps and pages are offered from the app and page listings, and the restated choice precedes download', () => {
  const apps = 'Edit Phase 1a: Apps are presented to the user via AskUserQuestion using the actual app name and app-id GUID from the apps.js list output';
  const pages = 'Edit Phase 1b: Pages are presented to the user via AskUserQuestion using the actual page names and page-id GUIDs from genpage.js list output';
  const restated = 'Edit Phase 1c: Selection is restated to the user before proceeding to download';
  assertPass(grade(apps, committed(E3)));
  assertPass(grade(pages, committed(E3)));
  assertPass(grade(restated, committed(E3)));
  // The listing names the app differently from the question: the offered name is not the listed one.
  assertFail(grade(apps, withEvents(E3, (ev) => { event(ev, 'list-apps').result.apps[0].name = 'Sales Desk'; return ev; })),
    /offers 11111111-2222-3333-4444-555555555555 without its listed name "Sales Desk"/);
  assertFail(grade(apps, withEvents(E3, (ev) => { const listing = event(ev, 'list-apps').result; listing.apps = listing.apps.filter((app) => app.name !== 'Sales Hub'); return ev; })),
    /offers 11111111-2222-3333-4444-555555555555, which the listing does not contain/);
  // The run downloaded a page that was listed but never offered.
  assertFail(grade(pages, withEvents(E3, (ev) => { event(ev, 'download').command = event(ev, 'download').command.replace('22222222-3333-4444-5555-666666666666', '33333333-4444-5555-6666-777777777777'); return ev; })),
    /continued with \(33333333-4444-5555-6666-777777777777\) was not among the offered pages/);
  // genpage.js list is read as data (`pages`, each with its pageId and name), as apps.js list is: the offered name is the listed one, and an offered page is one the listing holds.
  assertFail(grade(pages, withEvents(E3, (ev) => { event(ev, 'list-pages').result.pages[0].name = 'Contacts Desk'; return ev; })),
    /offers 22222222-3333-4444-5555-666666666666 without its listed name "Contacts Desk"/);
  assertFail(grade(pages, withEvents(E3, (ev) => { const listing = event(ev, 'list-pages').result; listing.pages = listing.pages.filter((page) => page.name !== 'Contacts Directory'); return ev; })),
    /offers 22222222-3333-4444-5555-666666666666, which the listing does not contain/);
  // A listing that failed to read lists no page, and no page can be presented from it.
  assertFail(grade(pages, withEvents(E3, (ev) => { event(ev, 'list-pages').result = { ok: false, error: 'the read failed', code: 'CONNECTION_ERROR' }; return ev; })),
    /the page listing recorded no pages to present/);
  assertFail(grade(pages, withEvents(E3, (ev) => ev.filter((e) => e.id !== 'list-pages'))), /the page listing command was not run/);
  assertFail(grade(restated, mutated(E3, 'workflowLog', '- "Editing **Contacts Directory** (22222222-3333-4444-5555-666666666666) in app **Sales Hub** (11111111-2222-3333-4444-555555555555). Continuing to download the existing page code…"', '- Continuing.')),
    /no restatement of the selected app and page/);
});

test('eval 8: the solution question runs for the new app and its choice is recorded', () => {
  const text = 'Phase 1 (Planner): Because a new app will be created, the planner asks the solution selection question and records the choice in ## Environment';
  assertPass(grade(text, committed(E8)));
  assertFail(grade(text, mutated(E8, 'genpagePlan', '- Solution: ContosoCore', '- Solution: Default')), /maker answered "Continue in 'Contoso Core'/);
  assertFail(grade(text, mutated(E8, 'genpagePlan', '- App: create new: Account Metrics', '- App: Sales Hub (1)')), /does not record a new app/);
});

test('eval 8: apps.js list returns zero apps, the create-or-cancel question is asked, and the plan records the new app', () => {
  const zero = 'Phase 1 (Planner): apps.js list returns zero apps';
  const asked = 'Phase 1 (Planner): User is asked via AskUserQuestion whether to create a new app or cancel';
  const recorded = "Phase 1 (Planner): Plan records 'create new app' decision";
  for (const text of [zero, asked, recorded]) assertPass(grade(text, committed(E8)));
  assertFail(grade(zero, withEvents(E8, (ev) => { event(ev, 'app-list').result = { ok: true, count: 1, apps: [{ id: '99999999-0000-4000-8000-000000000000', name: 'Old App', uniqueName: 'old_app', description: '', published: true, unpublishedChanges: false }] }; return ev; })),
    /returned 1 app/);
  assertFail(grade(zero, withEvents(E8, (ev) => { event(ev, 'app-list').result = {}; return ev; })), /does not record zero apps/);
  // A listing that failed to read is not an empty one.
  assertFail(grade(zero, withEvents(E8, (ev) => { event(ev, 'app-list').result = { ok: false, code: 'CONNECTION_ERROR', error: 'the read failed' }; return ev; })), /apps\.js list failed: the read failed/);
  assertFail(grade(zero, withEvents(E8, (ev) => ev.filter((e) => e.id !== 'app-list'))), /apps\.js list \(or pac model list\) was not run/);
  assertFail(grade(asked, withEvents(E8, (ev) => ev.filter((e) => e.id !== 'ask-create-app'))), /no AskUserQuestion offered to create a new app or cancel/);
  assertFail(grade(recorded, withEvents(E8, (ev) => { event(ev, 'ask-create-app').result.answer = 'Cancel'; return ev; })), /answered "Cancel", not create/);
  assertFail(grade(recorded, mutated(E8, 'genpagePlan', '- App: create new: Account Metrics', '- App: create new: Metrics Hub')), /not the app the maker named \("Account Metrics"\)/);
  assertFail(grade(recorded, mutated(E8, 'genpagePlan', '- App: create new: Account Metrics', '- App: Sales Hub (11111111-2222-3333-4444-555555555555)')), /does not record "App: create new/);
});

test('eval 8: the app is built from the first page — apps.js create after the first upload, then every upload names the app', () => {
  const made = "Phase 6 (new app): apps.js create --name 'Account Metrics' --solution '<Solution from plan>' --page-id <first page> --publish is run after the first page's upload; --solution is ALWAYS passed (apps.js create refuses a call without it)";
  const first = 'Phase 6 (new app): The first page is created with no --app-id and no --add-to-sitemap, before the app exists';
  const used = 'Phase 6: Every upload after the app is created uses the newly created app-id';
  for (const text of [made, first, used]) assertPass(grade(text, committed(E8)));

  // --solution is mandatory and is the plan's; --name is the plan's app; --publish keeps the app out of draft; --page-id is the page the first upload made.
  const create = (from, to) => (ev) => { event(ev, 'app-create').command = event(ev, 'app-create').command.replace(from, to); return ev; };
  assertFail(grade(made, withEvents(E8, create(" --solution 'ContosoCore'", ''))), /apps\.js create is missing --solution/);
  assertFail(grade(made, withEvents(E8, create("--solution 'ContosoCore'", "--solution 'Default'"))), /--solution Default is not the plan's Solution: ContosoCore/);
  assertFail(grade(made, withEvents(E8, create("--name 'Account Metrics'", "--name 'Metrics Hub'"))), /--name Metrics Hub is not the app the plan names: Account Metrics/);
  assertFail(grade(made, withEvents(E8, create(' --publish', ''))), /no --publish, so the new app is left in draft/);
  assertFail(grade(made, withEvents(E8, create(" --page-id '66666666-7777-4888-8999-aaaaaaaaaaaa'", ''))), /no --page-id/);
  assertFail(grade(made, withEvents(E8, create("--page-id '66666666-7777-4888-8999-aaaaaaaaaaaa'", "--page-id '11111111-2222-3333-4444-555555555555'"))), /is not the page the first upload created/);
  // The command it replaced is not the way, and a create that failed made no app.
  assertFail(grade(made, withEvents(E8, (ev) => { event(ev, 'app-create').command = "pac model create --name 'Account Metrics' --solution 'ContosoCore' --publish"; return ev; })), /not apps\.js create/);
  assertFail(grade(made, withEvents(E8, (ev) => { event(ev, 'app-create').result = { ok: false, code: 'PAGE_NOT_FOUND', error: 'no such page', written: false }; return ev; })), /apps\.js create did not succeed: no such page/);
  assertFail(grade(first, withEvents(E8, (ev) => { delete event(ev, 'app-create').result.appId; return ev; })), /recorded no returned appId/);
  assertFail(grade(made, withEvents(E8, (ev) => ev.filter((e) => e.id !== 'app-create'))), /apps\.js create was not run/);

  // The app is built around a page that exists, so the first upload comes first.
  const reordered = (ev) => { const [made1] = ev.splice(ev.findIndex((e) => e.id === 'app-create'), 1); ev.splice(ev.findIndex((e) => e.id === 'upload'), 0, made1); return ev; };
  assertFail(grade(made, withEvents(E8, reordered)), /ran before the first page was uploaded/);
  assertFail(grade(first, withEvents(E8, reordered)), /the first page was uploaded after the app was created/);

  // The first page has no app yet to name or to be placed in.
  const firstUpload = (from, to) => (ev) => { event(ev, 'upload').command = event(ev, 'upload').command.replace(from, to); return ev; };
  assertFail(grade(first, withEvents(E8, firstUpload('--code-file', "--app-id '44444444-5555-4666-8777-888888888888' --code-file"))), /first page's upload passed --app-id 44444444/);
  assertFail(grade(first, withEvents(E8, firstUpload('--agent-message-file', '--add-to-sitemap --agent-message-file'))), /passed --add-to-sitemap/);

  // The create pins the first page's tables into the app itself, so an app of one page is complete with it: no upload follows, and "every upload after the app is created" holds of none.
  // A page that does follow — the second page of a plan — names the app that apps.js create printed, and nothing else.
  const second = (flags, result = {}) => (ev) => {
    ev.splice(ev.findIndex((e) => e.id === 'app-create') + 1, 0, {
      id: 'second-upload',
      command: `node 'D:/repo/plugins/model-apps/scripts/genpage-upload.js' --env 'https://contoso.crm.dynamics.com' --code-file 'account-detail.tsx' --name-file 'page-name.txt' --data-sources 'account' --prompt-file 'prompt.txt' --model 'claude-sonnet-4.5' --agent-message-file 'agent-message.txt'${flags}`,
      result: { ok: true, pageId: '99999999-aaaa-4bbb-8ccc-dddddddddddd', updated: false, ...result },
      exitCode: 0,
    });
    return ev;
  };
  const named = " --app-id '44444444-5555-4666-8777-888888888888' --add-to-sitemap";
  assertPass(grade(used, withEvents(E8, second(named, { appId: '44444444-5555-4666-8777-888888888888' }))));
  assertPass(grade(first, withEvents(E8, second(named))));
  assertFail(grade(used, withEvents(E8, second(" --app-id '11111111-2222-3333-4444-555555555555' --add-to-sitemap"))), /--app-id 11111111-2222-3333-4444-555555555555 is not the created app/);
  assertFail(grade(used, withEvents(E8, second(''))), /--app-id missing is not the created app/);
  assertFail(grade(used, withEvents(E8, second(named, { appId: '11111111-2222-3333-4444-555555555555' }))), /upload result names app 11111111/);
  // The old way — uploading the first page again to pin its tables — is still an upload that names the app, so it still passes: it is needless, not wrong.
  assertPass(grade(used, withEvents(E8, second(" --app-id '44444444-5555-4666-8777-888888888888' --page-id '66666666-7777-4888-8999-aaaaaaaaaaaa'", { appId: '44444444-5555-4666-8777-888888888888', updated: true, unchanged: true }))));
});

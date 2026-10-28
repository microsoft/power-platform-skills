'use strict';
// The plan's semantic contract (references/plan-schema.md: ## Assumptions, per-page Data semantics and Lookup metadata), read
// by the pure readers of lib/genpage-plan-semantics.js: the written plan at its levels, the approval preview at its own, every
// entry rule, the cross-references, the comparison of the approved against the written records, and the check of observed
// lookups against get-lookup-metadata.js evidence. Plans without any of it are older plans: "not recorded", never "none".
const { test } = require('node:test');
const assert = require('node:assert/strict');

const semantics = require('../lib/genpage-plan-semantics.js');

const A1 = [
  '- Decision: Use opportunity.customerid directly referencing the selected account; exclude opportunities whose customer is one of that account\'s contacts.',
  '- Alternatives considered: opportunity.parentaccountid; direct opportunity.customerid; customerid through the account\'s contacts.',
  '- Evidence: metadata: customerid targets account, contact; parentaccountid targets account.',
  '- Resolution: user-confirmed',
  '- Question: opportunities-account-scope',
  '- Answer: Direct customer account only.',
].join('\n');
const A2 = [
  '- Decision: De-duplicate and cache the initial list read.',
  '- Alternatives considered: An empty form with no initial read; uncached loading.',
  '- Evidence: default: this page loads on mount, so Critical Rule 15 applies.',
  '- Resolution: planner-default',
].join('\n');
const DECISIONS = [
  '##### R1',
  '- Kind: relationship',
  '- Definition: opportunity.customerid references the selected account directly; exclude contact roll-up.',
  '- Source: A1',
  '',
  '##### F1',
  '- Kind: filter',
  '- Definition: In the account-only view, match the selected account\'s bare id through the verified Customer-to-account navigation path.',
  '- Source: A1',
  '',
  '##### F2',
  '- Kind: filter',
  '- Definition: Match customer names containing the entered substring; the separate target restriction is defined by F1.',
  '- Source: User Requirements',
  '- Requirement quote: search customer names by substring',
].join('\n');
const LOOKUPS = [
  '| Table | Column | Read property | Targets | Used by | Metadata state |',
  '|-------|--------|---------------|---------|---------|----------------|',
  '| opportunity | customerid | _customerid_value | account, contact | R1, F1, F2; customer navigation; customer picker | observed |',
  '',
  '| Table | Column | Target | Navigation property | Referenced key |',
  '|-------|--------|--------|---------------------|----------------|',
  '| opportunity | customerid | account | customerid_account | accountid |',
  '| opportunity | customerid | contact | customerid_contact | contactid |',
  '',
  '- Evidence: lookup-metadata.json; successful source/target metadata discovery.',
  '- Read target strategy: normalize the logical-name annotation and qualified prefix; use metadata-backed fallback only for a bare id with missing target evidence.',
].join('\n');
const REQUIREMENTS = 'Build an opportunity browser for an account. Users can search customer names by substring, open and change customers.';

function written({ assumptions = `### A1 — Opportunity relationship\n${A1}\n\n### A2 — Initial-load caching\n${A2}`, decisions = DECISIONS, lookups = LOOKUPS } = {}) {
  return [
    '# Genpage Plan',
    '',
    '## User Requirements',
    REQUIREMENTS,
    '',
    ...(assumptions === null ? [] : ['## Assumptions', '', assumptions, '']),
    '## Working Directory',
    'D:/work/customer-lookup',
    '',
    '## Pages',
    '| Page | File | Purpose | Entities |',
    '|------|------|---------|----------|',
    '| Customer Lookup | customer-lookup.tsx | Browse opportunities by customer | opportunity, account, contact |',
    '',
    '## Per-Page Specifications',
    '',
    '### Customer Lookup',
    '- **File:** customer-lookup.tsx',
    '- **Purpose:** Browse opportunities by customer',
    '- **Interactions:** Search, open and change customers',
    '',
    ...(decisions === null ? [] : ['#### Data semantics', '', decisions, '']),
    ...(lookups === null ? [] : ['#### Lookup metadata', '', lookups, '']),
  ].join('\n');
}

function preview({ assumptions = `#### A1 — Opportunity relationship\n${A1}\n\n#### A2 — Initial-load caching\n${A2}`, decisions = DECISIONS, lookups = LOOKUPS, order = 'normal' } = {}) {
  const assumed = assumptions === null ? [] : ['### Assumptions', '', assumptions, ''];
  const pages = ['### Pages (1 total)', '| Page | File | Purpose | Entities |', '|------|------|---------|----------|',
    '| Customer Lookup | customer-lookup.tsx | Browse opportunities by customer | opportunity, account, contact |', ''];
  const semantic = decisions === null ? [] : ['### Data Semantics', '', '#### customer-lookup.tsx', '', decisions, ''];
  const lookup = lookups === null ? [] : ['### Lookup Metadata', '', '#### customer-lookup.tsx', '', lookups, ''];
  const rest = ['### Data Strategy', '- Entities that exist: opportunity, account, contact', ''];
  const sections = order === 'assumptions-late' ? [...pages, ...assumed, ...semantic, ...lookup, ...rest]
    : order === 'semantics-early' ? [...assumed, ...semantic, ...pages, ...lookup, ...rest]
      : [...assumed, ...pages, ...semantic, ...lookup, ...rest];
  return ['## Genpage Plan', '', ...sections].join('\n');
}

const codes = (problems) => problems.map((p) => p.code);
const EVIDENCE = {
  ok: true,
  tables: [{
    logicalName: 'opportunity',
    primaryIdAttribute: 'opportunityid',
    primaryNameAttribute: 'name',
    lookups: [{
      column: 'customerid',
      readProperty: '_customerid_value',
      targets: ['account', 'contact'],
      paths: [
        { target: 'account', navigationProperty: 'customerid_account', referencedKey: 'accountid' },
        { target: 'contact', navigationProperty: 'customerid_contact', referencedKey: 'contactid' },
      ],
      sharedPaths: [],
    }],
  }],
};

test('the written plan and the preview each read cleanly at their own levels, to the same records', () => {
  const w = semantics.readWrittenSemantics(written());
  const p = semantics.readPreviewSemantics(preview());
  assert.deepEqual(w.problems, []);
  assert.deepEqual(p.problems, []);
  assert.equal(w.assumptions.entries.size, 2);
  assert.equal(w.assumptions.entries.get('A1').resolution, 'user-confirmed');
  assert.equal(w.assumptions.entries.get('A1').title, 'Opportunity relationship');
  assert.deepEqual([...w.pages.get('customer-lookup.tsx').semantics.entries.keys()], ['R1', 'F1', 'F2']);
  assert.deepEqual(w.pages.get('customer-lookup.tsx').lookups.rows.get('opportunity|customerid').targets, ['account', 'contact']);
  assert.deepEqual(semantics.compareSemantics(p, w), []);
  assert.equal(semantics.hasSemanticContract(w), true);
  assert.equal(semantics.hasSemanticContract(p), true);
});

test('an older plan or preview without the contract reads as not recorded — no problems, no contract', () => {
  const w = semantics.readWrittenSemantics(written({ assumptions: null, decisions: null, lookups: null }));
  const p = semantics.readPreviewSemantics(preview({ assumptions: null, decisions: null, lookups: null }));
  assert.deepEqual(w.problems, []);
  assert.deepEqual(p.problems, []);
  assert.equal(w.assumptions, null);
  assert.equal(semantics.hasSemanticContract(w), false);
  assert.equal(semantics.hasSemanticContract(p), false);
  assert.deepEqual(semantics.compareSemantics(p, w), []);
  assert.deepEqual(semantics.writtenSemanticsProblems(written({ assumptions: null, decisions: null, lookups: null })), []);
});

test('a plan carrying the contract has one specification per page: a second block with its title or file is refused in either order', () => {
  const block = (title, file, binding) => ['', `### ${title}`, `- **File:** ${file}`, '- **Purpose:** Browse opportunities by customer', `- **Data Binding:** ${binding}`, ''].join('\n');
  const contact = block('Customer Lookup', 'customer-lookup.tsx', 'customerid_contact/contactid');
  for (const [label, plan] of [
    ['a later block without records, same title and file', written() + contact],
    ['an earlier block without records, same title and file', written().replace('\n### Customer Lookup\n', `${contact}\n### Customer Lookup\n`)],
    ['a later block under another title, same file', written() + block('Customer Lookup (contacts)', 'customer-lookup.tsx', 'customerid_contact/contactid')],
    ['a later block with the same title, another file', written() + block('Customer Lookup', 'customer-lookup-2.tsx', 'customerid_contact/contactid')],
  ]) {
    const read = semantics.readWrittenSemantics(plan);
    assert.ok(read.problems.some((p) => p.code === 'invalid-data-semantics' && /another page specification/.test(p.message)), `${label}: ${JSON.stringify(read.problems)}`);
    assert.ok(semantics.writtenSemanticsProblems(plan, { require: true }).length > 0, `${label}: the schema check refuses it too`);
  }
  // An older plan without the contract keeps its absence-only reading: duplicates there are the schema reader's business.
  const legacy = written({ assumptions: null, decisions: null, lookups: null });
  assert.deepEqual(semantics.readWrittenSemantics(legacy + contact).problems, []);
});

test('the empty sentinels are exact and read as recorded-and-empty', () => {
  const w = semantics.readWrittenSemantics(written({ assumptions: 'No assumptions.', decisions: 'None.', lookups: 'None.' }));
  assert.deepEqual(w.problems, []);
  assert.equal(w.assumptions.sentinel, true);
  assert.equal(w.pages.get('customer-lookup.tsx').semantics.sentinel, true);
  assert.equal(w.pages.get('customer-lookup.tsx').lookups.sentinel, true);
  for (const variant of ['No assumptions', 'none', 'No assumptions.\nExtra prose.', '']) {
    assert.ok(codes(semantics.readWrittenSemantics(written({ assumptions: variant, decisions: 'None.', lookups: 'None.' })).problems).includes('invalid-assumptions'), JSON.stringify(variant));
  }
  for (const variant of ['none', 'None', 'N/A']) {
    assert.ok(codes(semantics.readWrittenSemantics(written({ decisions: variant, lookups: 'None.' })).problems).includes('invalid-data-semantics'), variant);
    assert.ok(codes(semantics.readWrittenSemantics(written({ lookups: variant })).problems).includes('invalid-lookup-metadata'), variant);
  }
});

test('every malformed assumption entry is invalid-assumptions', () => {
  const entry = (body, title = 'A2 — Initial-load caching') => written({ assumptions: `### A1 — Opportunity relationship\n${A1}\n\n### ${title}\n${body}` });
  for (const [label, plan] of [
    ['missing Resolution', entry(A2.replace('\n- Resolution: planner-default', ''))],
    ['missing Decision', entry(A2.replace(/- Decision: .*\n/, ''))],
    ['empty Alternatives', entry(A2.replace(/(- Alternatives considered:).*/, '$1   '))],
    ['duplicate id', entry(A2, 'A1 — Again')],
    ['an id that is not A<n>', entry(A2, 'Assumption 2')],
    ['A0', entry(A2, 'A0 — Zero')],
    ['unknown resolution', entry(A2.replace('planner-default', 'assumed'))],
    ['user-confirmed without Question/Answer', entry(A2.replace('planner-default', 'user-confirmed'))],
    ['evidence without a prefix', entry(A2.replace('default: this page', 'this page'))],
    ['evidence with an empty prefix', entry(A2.replace('default: this page loads on mount, so Critical Rule 15 applies.', 'default:'))],
    ['an unknown field', entry(`${A2}\n- Owner: the planner`)],
    ['a duplicate field', entry(`${A2}\n- Decision: something else`)],
    ['a prose line', entry(`${A2}\nThis line is not a field.`)],
    ['a nested heading', entry(`${A2}\n#### Notes`)],
    ['a planner-default that names a question', entry(`${A2}\n- Question: opportunities-account-scope\n- Answer: Direct`)],
    ['a Default record on a planner-default', entry(`${A2}\n- Default record: Unattended default: A2 / x → y (z)`)],
    ['text before the first entry', written({ assumptions: `Some intro.\n\n### A1 — Opportunity relationship\n${A1}` })],
  ]) {
    assert.ok(codes(semantics.readWrittenSemantics(plan).problems).includes('invalid-assumptions'), label);
  }
  const twice = written().replace('## Working Directory', `## Assumptions\n\nNo assumptions.\n\n## Working Directory`);
  assert.ok(semantics.readWrittenSemantics(twice).problems.some((p) => p.code === 'invalid-assumptions' && /more than one/.test(p.message)));
});

test('values may continue on indented lines and compare after NFC and whitespace normalization only', () => {
  const wrapped = A2.replace('- Decision: De-duplicate and cache the initial list read.', '- Decision: De-duplicate and cache\n  the initial   list read.');
  const w = semantics.readWrittenSemantics(written({ assumptions: `### A1 — Opportunity relationship\n${A1}\n\n### A2 — Initial-load caching\n${wrapped}` }).replace(/\n/g, '\r\n'));
  assert.deepEqual(w.problems, []);
  assert.equal(w.assumptions.entries.get('A2').decision, 'De-duplicate and cache the initial list read.');
  assert.deepEqual(semantics.compareSemantics(semantics.readPreviewSemantics(preview()), w), []);
  // Case is substantive.
  const shouted = semantics.readWrittenSemantics(written({ assumptions: `### A1 — Opportunity relationship\n${A1}\n\n### A2 — Initial-load caching\n${A2.replace('cache the initial', 'CACHE the initial')}` }));
  assert.deepEqual(semantics.compareSemantics(semantics.readPreviewSemantics(preview()), shouted), ['Assumptions: A2 changed its Decision']);
  // A blank line ends a value: an indented line after it continues nothing.
  const detached = A2.replace('- Resolution: planner-default', '- Resolution: planner-default\n\n  stray continuation');
  assert.ok(codes(semantics.readWrittenSemantics(written({ assumptions: `### A1 — Opportunity relationship\n${A1}\n\n### A2 — Initial-load caching\n${detached}` })).problems).includes('invalid-assumptions'));
});

test('an unattended default records the exact line, and its reason never says approved', () => {
  const unattended = (record, answer = 'Direct customer account only.') => written({ assumptions: `### A1 — Opportunity relationship\n${A1
    .replace('user-confirmed', 'unattended-default').replace('Direct customer account only.', answer)}\n- Default record: ${record}` });
  const ok = (plan) => semantics.readWrittenSemantics(plan).problems;
  assert.deepEqual(ok(unattended('Unattended default: A1 / opportunities-account-scope → Direct customer account only. (the request excludes contact roll-up and metadata leaves one matching path)')), []);
  assert.deepEqual(ok(unattended('Unattended default: A1 / opportunities-account-scope -> Direct customer account only. (historical arrow)')), []);
  // A legitimate answer that is the word Approved is kept; only the reason may not use it.
  assert.deepEqual(ok(unattended('Unattended default: A1 / opportunities-account-scope → Approved (the only status value the request names)', 'Approved')), []);
  for (const [label, record] of [
    ['a reason that says approved', 'Unattended default: A1 / opportunities-account-scope → Direct customer account only. (matches the approved plan)'],
    ['another assumption id', 'Unattended default: A2 / opportunities-account-scope → Direct customer account only. (reason)'],
    ['another question', 'Unattended default: A1 / other-question → Direct customer account only. (reason)'],
    ['another answer', 'Unattended default: A1 / opportunities-account-scope → Parent account (reason)'],
    ['no reason', 'Unattended default: A1 / opportunities-account-scope → Direct customer account only.'],
    ['an empty reason', 'Unattended default: A1 / opportunities-account-scope → Direct customer account only. ( )'],
    ['the plan-approval line', 'Unattended default: plan approval → approved (unattended mode)'],
  ]) {
    assert.ok(codes(ok(unattended(record))).includes('invalid-assumptions'), label);
  }
  const missing = written({ assumptions: `### A1 — Opportunity relationship\n${A1.replace('user-confirmed', 'unattended-default')}` });
  assert.ok(semantics.readWrittenSemantics(missing).problems.some((p) => /needs its Default record/.test(p.message)));
});

test('decision sources resolve: an assumption that exists, or a quote found in the original requirements', () => {
  const read = (decisions, assumptions) => semantics.readWrittenSemantics(written({ decisions, ...(assumptions === undefined ? {} : { assumptions }) })).problems;
  assert.deepEqual(codes(read(DECISIONS.replace('- Source: A1\n\n##### F1', '- Source: A99\n\n##### F1'))), ['unknown-assumption']);
  assert.deepEqual(codes(read(DECISIONS, null)), ['unknown-assumption', 'unknown-assumption'], 'no Assumptions section: A1 resolves to nothing');
  assert.deepEqual(codes(read(DECISIONS.replace('- Source: A1\n\n##### F1', '\n##### F1'))), ['missing-semantic-source']);
  assert.deepEqual(codes(read(DECISIONS.replace('- Source: A1\n\n##### F1', '- Source: A1, User Requirements\n\n##### F1'))), ['missing-semantic-source']);
  assert.deepEqual(codes(read(DECISIONS.replace('\n- Requirement quote: search customer names by substring', ''))), ['unmatched-requirement-quote']);
  assert.deepEqual(codes(read(DECISIONS.replace('search customer names by substring', 'search all records'))), ['unmatched-requirement-quote']);
  assert.deepEqual(codes(read(DECISIONS.replace('search customer names by substring', 'Search customer names by substring'))), ['unmatched-requirement-quote'], 'case is kept');
  assert.deepEqual(read(DECISIONS.replace('search customer names by substring', '"search   customer names\n  by substring"')), [], 'quotes and whitespace are not substantive');
  for (const [label, decisions] of [
    ['Kind that does not match the id', DECISIONS.replace('- Kind: relationship', '- Kind: filter')],
    ['a level-three id', DECISIONS.replace('##### R1', '### R1')],
    ['a duplicate id', `${DECISIONS}\n\n##### F2\n- Kind: filter\n- Definition: x\n- Source: A1`],
    ['an id that is not R/F', DECISIONS.replace('##### R1', '##### X1')],
    ['missing Definition', DECISIONS.replace(/- Definition: opportunity\.customerid.*\n/, '')],
    ['an unknown field', DECISIONS.replace('- Source: A1\n\n##### F1', '- Source: A1\n- Scope: all\n\n##### F1')],
  ]) {
    assert.ok(codes(semantics.readWrittenSemantics(written({ decisions })).problems).includes('invalid-data-semantics'), label);
  }
});

test('lookup records: names, the complete target set, Used by, state, paths and their bullets', () => {
  const read = (lookups) => codes(semantics.readWrittenSemantics(written({ lookups })).problems);
  for (const [label, lookups] of [
    ['a wrong read property', LOOKUPS.replace('| _customerid_value |', '| customerid |')],
    ['no targets', LOOKUPS.replace('| account, contact |', '|  |')],
    ['a target twice', LOOKUPS.replace('| account, contact |', '| account, account |')],
    ['a plural or display target', LOOKUPS.replace('| account, contact |', '| Accounts, contact |')],
    ['Used by a decision the page does not define', LOOKUPS.replace('R1, F1, F2;', 'R1, F9;')],
    ['no Used by', LOOKUPS.replace('| R1, F1, F2; customer navigation; customer picker |', '|  |')],
    ['an unknown state', LOOKUPS.replace('| observed |', '| guessed |')],
    ['a planned lookup with a path', LOOKUPS.replace('| observed |', '| planned |')],
    ['a path to a target the lookup does not list', LOOKUPS.replace('| opportunity | customerid | contact | customerid_contact | contactid |', '| opportunity | customerid | lead | customerid_lead | leadid |')],
    ['a path for an unlisted lookup', LOOKUPS.replace('| opportunity | customerid | contact | customerid_contact | contactid |', '| opportunity | parentaccountid | account | parentaccountid | accountid |')],
    ['a duplicate lookup row', LOOKUPS.replace('|-------|--------|---------------|---------|---------|----------------|', '|-------|--------|---------------|---------|---------|----------------|\n| opportunity | customerid | _customerid_value | account, contact | R1 | observed |')],
    ['a table with a File column', `${LOOKUPS}\n\n| Page | File |\n|---|---|\n| X | x.tsx |`],
    ['no Evidence bullet', LOOKUPS.replace(/- Evidence: .*\n/, '')],
    ['no strategy bullet', LOOKUPS.replace(/\n- Read target strategy: .*/, '')],
    ['a prose line', `${LOOKUPS}\nThe lookup is polymorphic.`],
    ['an empty table', LOOKUPS.split('\n').slice(0, 2).join('\n')],
  ]) {
    assert.ok(read(lookups).includes('invalid-lookup-metadata'), label);
  }
  const planned = LOOKUPS.replace('| observed |', '| planned |').split('\n').filter((line) => !/customerid_(account|contact)|Navigation property|---------------------/.test(line)).join('\n');
  assert.deepEqual(read(planned), [], 'a planned lookup without paths is valid');
});

test('the preview presents Assumptions first, and Data Semantics and Lookup Metadata after its Pages table', () => {
  assert.ok(codes(semantics.readPreviewSemantics(preview({ order: 'assumptions-late' })).problems).includes('invalid-assumptions'));
  assert.ok(codes(semantics.readPreviewSemantics(preview({ order: 'semantics-early' })).problems).includes('invalid-data-semantics'));
  // A preview written at the plan's levels is not the preview's contract: nothing of it is read.
  const levels = preview().replace('### Assumptions', '## Assumptions').replace(/^#### A/gm, '### A');
  assert.equal(semantics.readPreviewSemantics(levels).assumptions, null);
  // A written plan's per-page subsections are not the preview's groups.
  const ungrouped = preview().replace('### Data Semantics\n\n#### customer-lookup.tsx\n\n', '### Data Semantics\n\n');
  assert.ok(codes(semantics.readPreviewSemantics(ungrouped).problems).includes('invalid-data-semantics'));
});

test('the comparison refuses an added, omitted or changed assumption, decision or lookup record', () => {
  const approved = semantics.readPreviewSemantics(preview());
  const diff = (plan, options) => semantics.compareSemantics(approved, semantics.readWrittenSemantics(plan), options);
  assert.deepEqual(diff(written({ assumptions: `### A1 — Opportunity relationship\n${A1.replace('Use opportunity.customerid', 'Use opportunity.parentaccountid')}\n\n### A2 — Initial-load caching\n${A2}` })), ['Assumptions: A1 changed its Decision']);
  assert.deepEqual(diff(written({ assumptions: `### A1 — Opportunity relationship\n${A1}` })), ['Assumptions: A2 was approved but is not written']);
  assert.deepEqual(diff(written({ assumptions: `### A1 — Opportunity relationship\n${A1}\n\n### A2 — Initial-load caching\n${A2}\n\n### A3 — Sort\n${A2}` })), ['Assumptions: A3 is written but was not approved']);
  assert.deepEqual(diff(written({ assumptions: 'No assumptions.', decisions: DECISIONS.replace(/- Source: A1/g, '- Source: User Requirements\n- Requirement quote: open and change customers') })).slice(0, 1), ['Assumptions: approved recorded, written "No assumptions."']);
  assert.deepEqual(diff(written({ decisions: DECISIONS.replace('through the verified Customer-to-account navigation path', 'through parentaccountid') })), ['customer-lookup.tsx Data semantics: F1 changed its Definition']);
  assert.deepEqual(diff(written({ lookups: LOOKUPS.replace('| account, contact |', '| account |').replace(/\| opportunity \| customerid \| contact .*\n/, '') })), [
    'customer-lookup.tsx Lookup metadata: opportunity.customerid changed its Targets',
    'customer-lookup.tsx Lookup metadata: the paths of opportunity.customerid changed',
  ]);
  assert.deepEqual(diff(written({ lookups: LOOKUPS.replace('customerid_contact', 'customerid_lead') })), ['customer-lookup.tsx Lookup metadata: the paths of opportunity.customerid changed']);
  assert.deepEqual(diff(written({ decisions: null, lookups: null })), [
    'customer-lookup.tsx Data semantics: approved recorded, written not recorded',
    'customer-lookup.tsx Lookup metadata: approved recorded, written not recorded',
  ]);
});

test('reconciliation may promote a planned lookup to observed with its measured paths — only with evidence, and nothing else', () => {
  const plannedLookups = LOOKUPS.replace('| observed |', '| planned |').split('\n')
    .filter((line) => !/customerid_(account|contact)|Navigation property|---------------------/.test(line)).join('\n');
  const approved = semantics.readPreviewSemantics(preview({ lookups: plannedLookups }));
  const promoted = semantics.readWrittenSemantics(written());
  assert.deepEqual(semantics.compareSemantics(approved, promoted, { promotions: true }), []);
  assert.deepEqual(semantics.compareSemantics(approved, promoted), [
    'customer-lookup.tsx Lookup metadata: opportunity.customerid was approved planned and is written observed without successful lookup metadata evidence',
    'customer-lookup.tsx Lookup metadata: the paths of opportunity.customerid changed',
  ]);
  const narrowed = semantics.readWrittenSemantics(written({ lookups: LOOKUPS.replace('| account, contact |', '| account |').replace(/\| opportunity \| customerid \| contact .*\n/, '') }));
  assert.deepEqual(semantics.compareSemantics(approved, narrowed, { promotions: true }), ['customer-lookup.tsx Lookup metadata: opportunity.customerid changed its Targets']);
  const demoted = semantics.readWrittenSemantics(written({ lookups: plannedLookups }));
  assert.deepEqual(semantics.compareSemantics(semantics.readPreviewSemantics(preview()), demoted, { promotions: true }), [
    'customer-lookup.tsx Lookup metadata: opportunity.customerid was approved observed and is written planned',
    'customer-lookup.tsx Lookup metadata: the paths of opportunity.customerid changed',
  ]);
});

test('observed lookups must match successful get-lookup-metadata.js evidence exactly', () => {
  const w = semantics.readWrittenSemantics(written());
  assert.deepEqual(semantics.lookupEvidenceProblems(w, EVIDENCE), []);
  const evidence = (change) => { const copy = structuredClone(EVIDENCE); change(copy.tables[0].lookups[0], copy); return copy; };
  for (const [label, bad] of [
    ['a failed read', { ok: false, code: 'X', error: 'failed' }],
    ['no answer', null],
    ['a target set the plan narrows', evidence((lookup) => { lookup.targets.push('lead'); })],
    ['another read property', evidence((lookup) => { lookup.readProperty = '_parentcustomerid_value'; })],
    ['a path the evidence does not hold', evidence((lookup) => { lookup.paths.pop(); })],
    ['another key', evidence((lookup) => { lookup.paths[0].referencedKey = 'leadid'; })],
    ['no such lookup', evidence((lookup) => { lookup.column = 'parentaccountid'; })],
    ['no such table', evidence((lookup, copy) => { copy.tables[0].logicalName = 'quote'; })],
  ]) {
    const found = semantics.lookupEvidenceProblems(w, bad);
    assert.ok(found.length && found.every((p) => p.code === 'invalid-lookup-metadata'), label);
  }
  // A shared path (Owner's ownerid) never stands in for a concrete one.
  const shared = evidence((lookup) => { lookup.sharedPaths = [{ navigationProperty: 'customerid_contact', targets: ['account', 'contact'] }]; lookup.paths.pop(); });
  assert.equal(semantics.lookupEvidenceProblems(w, shared).length, 1);
});

test('a newly authored plan must carry every part; an older one is not asked to', () => {
  const plan = written({ assumptions: null, decisions: null, lookups: null });
  assert.deepEqual(semantics.writtenSemanticsProblems(plan), []);
  assert.deepEqual(codes(semantics.writtenSemanticsProblems(plan, { require: true })), ['invalid-assumptions', 'invalid-data-semantics', 'invalid-lookup-metadata']);
  assert.deepEqual(semantics.writtenSemanticsProblems(written({ assumptions: 'No assumptions.', decisions: 'None.', lookups: 'None.' }), { require: true }), []);
  assert.deepEqual(semantics.writtenSemanticsProblems(written(), { require: true }), []);
});

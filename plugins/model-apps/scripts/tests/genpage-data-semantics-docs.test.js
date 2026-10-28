'use strict';
// What the reference documents teach about data semantics and lookup identities, pinned where a page builder or the planner reads it.
// Nothing executes these documents, so a reworded rule could quietly put back the advice that broke pages: that a lookup's
// `_<field>_value` is a GUID (the current player returns `/<table>(<guid>)` for Customer and Owner lookups), that a Customer
// lookup can be opened as an account, or that a failed lookup write may be retried.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8').replace(/\r\n/g, '\n');
const RULES = read('references', 'rules.md');
const LOOKUPS_HEADING = '### Lookup references (Customer, Owner, Regarding and every other lookup)';

function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `the document has the section "${heading}"`);
  const next = text.slice(start + heading.length + 2).search(/\n#{2,3} /);
  return next < 0 ? text.slice(start) : text.slice(start, start + heading.length + 2 + next);
}

test('rules.md no longer says a lookup `_<field>_value` read value is the GUID; it teaches the dual shape', () => {
  assert.doesNotMatch(RULES, /`_<field>_value` is the GUID/, 'the measured player returns `/<table>(<guid>)` for Customer and Owner lookups');
  assert.match(RULES, /normalizeLookupReference/, 'the read contract names the canonical normalizer');
  const usage = section(RULES, '## DataAPI Usage Examples');
  assert.match(usage, /bare GUID or `\/<table>\(<guid>\)`/, 'the usage examples state both read shapes');
  assert.match(usage, /FormattedValue/, 'neighbour: the label still comes from the FormattedValue annotation');
});

test('the lookup section sits after DataAPI Rule 13, shows the canonical normalizer once, and states the measured read contract', () => {
  const rule13 = RULES.indexOf('13. **Setting a lookup on create/update');
  const lookups = RULES.indexOf(`\n${LOOKUPS_HEADING}\n`);
  const grid = RULES.indexOf('\n### DataGrid Requirements\n');
  assert.ok(rule13 > 0 && rule13 < lookups && lookups < grid, 'between Rule 13 and the DataGrid requirements');
  const body = section(RULES, LOOKUPS_HEADING);
  assert.equal((body.match(/\bfunction normalizeLookupReference\(/g) || []).length, 1, 'the body is shown once, not reimplemented per pair');
  for (const state of ["'unset'", "'resolved'", "'needs-target'", "'invalid'"]) assert.ok(body.includes(state), state);
  assert.match(body, /@Microsoft\.Dynamics\.CRM\.lookuplogicalname/);
  assert.match(body, /HTTP 400/, 'a qualified filter operand is refused');
  assert.match(body, /Single-target lookups, team-owned rows, Regarding and `loadMoreRows` pages were not part of that verification/, 'the live claim is scoped');
  assert.match(body, /complete\*\* target set/, 'allowedTargets is the complete metadata target set');
  // Rules 12 and 13 point at it, and keep their own advice.
  const rule12 = RULES.slice(RULES.indexOf('12. **Lookup display-name fields'), rule13);
  assert.match(rule12, /Lookup references/);
  assert.match(rule12, /@OData\.Community\.Display\.V1\.FormattedValue/);
  const rule13Text = RULES.slice(rule13, lookups);
  assert.match(rule13Text, /Lookup references/);
  assert.match(rule13Text, /never `@odata\.bind`/);
});

test('the five pitfalls each show WRONG and CORRECT, and the CORRECT code never guesses a target', () => {
  const body = section(RULES, LOOKUPS_HEADING);
  const pairs = ['**A. Read and consume a normalized identity.**', '**B. Select the relationship and roll-up meaning before generating a filter.**',
    '**C. Non-id filters and name searches do not implicitly select a target.**', '**D. Navigate to the resolved target with the bare id.**',
    '**E. Write the selected target; rebuild the qualified form only at the write boundary.**'];
  let at = 0;
  for (const pair of pairs) {
    const start = body.indexOf(pair, at);
    assert.ok(start >= at, `${pair} in order`);
    const next = pairs.indexOf(pair) + 1 < pairs.length ? body.indexOf(pairs[pairs.indexOf(pair) + 1]) : body.length;
    const text = body.slice(start, next);
    assert.match(text, /\/\/ WRONG/, `${pair} WRONG`);
    assert.match(text, /\/\/ CORRECT/, `${pair} CORRECT`);
    at = start + 1;
  }
  const correct = [...body.matchAll(/\/\/ CORRECT[^\n]*\n([\s\S]*?)(?=\n\/\/ |\n```)/g)].map((match) => match[1]).join('\n');
  assert.match(correct, /entityName: reference\.table, entityId: reference\.id/, 'navigation uses the resolved pair');
  assert.match(correct, /customerid_account\/accountid eq \$\{reference\.id\}/, 'a typed path with the bare id');
  assert.match(correct, /selected\.table === 'account'/, 'a write chooses the table from the selection');
  assert.doesNotMatch(correct, /targets\[0\]|allowedTargets\[0\]\s*\]/, 'never the first target');
  assert.doesNotMatch(body, /ownerid_(?:team|systemuser)/, 'no manufactured Owner path');
  assert.doesNotMatch(correct, /@odata\.bind/);
  assert.match(body, /`_customerid_value: null`/, 'a link is cleared with null');
});

test('lookup failures go through the five-argument reporter: reads as read, writes as write with no retry', () => {
  const body = section(RULES, LOOKUPS_HEADING);
  const calls = [...body.matchAll(/reportPageError\(([^)]*)\)/g)].map((match) => match[1]);
  assert.ok(calls.length >= 2, 'the section names the reporter');
  for (const args of calls) {
    if (args.includes('…')) continue;
    const parts = args.split(',').map((part) => part.trim());
    assert.equal(parts.length, 5, `five arguments, no retry: reportPageError(${args})`);
    assert.match(parts[4], /^'(?:read|write)'$/, `the kind is the fifth argument: ${args}`);
    assert.equal(parts[0], 'PAGE_NAME');
  }
  assert.match(body, /with \*\*no retry argument\*\*/);
  assert.match(body, /never a row, a reference pair or a returned success payload/);
  assert.match(body, /a thrown read is never cached as unknown, no match, rows or success/);
});

// --- The authoring path: the schema, the planner, the orchestrator and the page builder agree on the records ----------------------

const SCHEMA = read('references', 'plan-schema.md');
const PLANNER = read('agents', 'genpage-planner.md');
const SKILL = read('skills', 'genpage', 'SKILL.md');
const BUILDER = read('agents', 'genpage-page-builder.md');
const CHECKLIST = 'Every relationship and every server-side or client-side filter used in `## Per-Page Specifications` traces to the user\'s stated text in `## User Requirements` or a named `## Assumptions` entry. The builder introduces no unrecorded business predicate, relationship or roll-up.';
const LIMIT = 'Validation proves structure, ID resolution, quote presence and agreement with approved structured decisions. It does not prove natural-language entailment, judge materiality, or discover arbitrary contradictory prose. Those remain planner/reviewer responsibilities, supplemented by scenario-specific code checks.';

test('plan-schema.md places Assumptions right after User Requirements and gives every record its grammar', () => {
  const template = SCHEMA.slice(SCHEMA.indexOf('## Required Structure'), SCHEMA.indexOf('## Section Semantics'));
  const at = (heading) => template.indexOf(`\n${heading}\n`);
  assert.ok(at('## User Requirements') < at('## Assumptions') && at('## Assumptions') < at('## Working Directory'), 'Assumptions sits between User Requirements and Working Directory');
  for (const text of ['No assumptions.', '### A1 — [short title]', '- Decision:', '- Alternatives considered:', '- Evidence:', '- Resolution: [user-confirmed | planner-default | unattended-default]', 'Unattended default: A1 / <question id> → <answer> (<reason>)',
    '#### Data semantics', '##### R1', '##### F1', '- Requirement quote:', '#### Lookup metadata', '| Table | Column | Read property | Targets | Used by | Metadata state |', '| Table | Column | Target | Navigation property | Referenced key |']) {
    assert.ok(template.includes(text), text);
  }
  assert.match(SCHEMA, /`Evidence` starts with `metadata:`, `sample:` or `default:`/);
  assert.match(SCHEMA, /reason that never contains the word "approved"/);
  assert.match(SCHEMA, /level five, never level three/);
  assert.match(SCHEMA, /`### Assumptions` \*\*first\*\*/, 'the preview shows Assumptions first');
  assert.match(SCHEMA, /never a whole-document hash/);
  assert.match(SCHEMA, /An older plan without these sections is \*\*not recorded\*\*/);
  assert.match(SCHEMA, /byte for byte/, 'User Requirements stays the original request');
});

test('the traceability checklist is stated with its limit beside it, in the schema, the planner and the orchestrator', () => {
  for (const [name, text] of [['plan-schema.md', SCHEMA], ['genpage-planner.md', PLANNER], ['SKILL.md', SKILL]]) {
    const flat = text.replace(/\s+/g, ' ');
    const at = flat.indexOf(CHECKLIST);
    assert.ok(at >= 0, `${name} states the checklist`);
    assert.equal(flat.indexOf(LIMIT, at), at + CHECKLIST.length + 1, `${name} states the limit right after it`);
  }
});

test('the planner discovers lookups, asks rather than assumes, and records the answer only after it returns', () => {
  const step4 = PLANNER.slice(PLANNER.indexOf('## Step 4 — Detect What Exists'), PLANNER.indexOf('## Step 5 — Hand the Plan Back for Approval'));
  const resolve = step4.slice(step4.indexOf('### Resolve Data Semantics'));
  assert.ok(resolve.length > 0 && step4.indexOf('### Entity Detection') < step4.indexOf('### Resolve Data Semantics'), 'after Entity Detection, before Step 5');
  assert.match(resolve, /get-lookup-metadata\.js" --env '<envUrl>' --tables/);
  assert.match(resolve, /<working-dir>\/lookup-metadata\.json/);
  assert.match(resolve, /never read a failure as "no candidates" or "one candidate"/);
  const examples = [...resolve.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  assert.equal(examples.length, 2);
  assert.equal(examples[0].questions[0].options.filter((option) => option.default).length, 0, 'several candidates: no default');
  assert.equal(examples[1].questions[0].options.length, 1);
  assert.equal(examples[1].questions[0].options[0].default, true, 'a sole candidate is the one marked default');
  assert.match(resolve, /only then write the settled assumption/);
  assert.match(resolve, /plan approval never\s+answers a semantic question/);
  assert.match(resolve, /Unattended default: <assumption id> \/ <question id> → <answer> \(<reason>\)/);
  assert.match(resolve, /may only promote a `planned` lookup|promote each `planned` lookup/);
});

test('the planner previews Assumptions first and writes the same records at the plan\'s levels', () => {
  const step5 = PLANNER.slice(PLANNER.indexOf('## Step 5 — Hand the Plan Back for Approval'), PLANNER.indexOf('## Step 6 — Write genpage-plan.md'));
  const preview = /```\n(## Genpage Plan[\s\S]*?)\n```/.exec(step5)[1];
  const order = ['### Assumptions', '### Pages (N total)', '### Data Semantics', '### Lookup Metadata', '### Data Strategy'].map((heading) => preview.indexOf(`\n${heading}\n`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `preview order: ${order}`);
  const step6 = PLANNER.slice(PLANNER.indexOf('## Step 6 — Write genpage-plan.md'), PLANNER.indexOf('## Step 7 — Return Summary'));
  assert.match(step6, /Write `## Assumptions` right after `## User Requirements`/);
  assert.match(step6, /the records\s+the maker approved, unchanged/);
  assert.match(step6, /`## User Requirements` the original request, byte for byte/);
});

test('the orchestrator verifies a new plan\'s records, reconciles planned lookups after provisioning, and gates generation on observed ones', () => {
  const phase1 = SKILL.slice(SKILL.indexOf('### Phase 1: Plan'), SKILL.indexOf('#### 1a. Connector discovery'));
  assert.match(phase1, /genpage-plan-provenance\.js" verify --plan '<working-dir>\/genpage-plan\.md' --approved '@<working-dir>\/\.approved-genpage-plan\.md' --require-assumptions/);
  assert.match(phase1, /its `### Assumptions` first/);
  assert.match(phase1, /never approve a plan while one is open/);
  assert.match(phase1, /Only once every data-semantics question is answered, treat the plan as approved/);
  assert.match(phase1, /Unattended default: <assumption id> \/ <question id> → <answer> \(<reason>\)/);
  const reconcile = SKILL.slice(SKILL.indexOf('#### 2c. Reconcile planned lookups'), SKILL.indexOf('### Phase 3: App Creation/Selection'));
  assert.match(reconcile, /get-lookup-metadata\.js" --env '<envUrl>' --tables/);
  assert.match(reconcile, /Lookup reconciliation:/);
  assert.match(reconcile, /verify [^\n]*--require-assumptions --lookup-metadata '<working-dir>\/lookup-metadata\.json'/);
  assert.match(reconcile, /Do not\s+edit the plan yourself/);
  const gate = SKILL.slice(SKILL.indexOf('#### 5a. Validate the plan before dispatch'), SKILL.indexOf('#### 5b. Single-page fast path'));
  assert.match(gate, /verify [^\n]*--require-assumptions --require-observed-lookups --lookup-metadata '<working-dir>\/lookup-metadata\.json'/);
});

test('the page builder reads the records and consumes lookups only as validated pairs', () => {
  const step1 = BUILDER.slice(BUILDER.indexOf('## Step 1 — Read the Plan Document'), BUILDER.indexOf('## Step 2 — Read RuntimeTypes.ts'));
  assert.match(step1, /`#### Data semantics`\*\* and \*\*`#### Lookup metadata`/);
  assert.match(step1, /add no unrecorded predicate, relationship or\s+roll-up/);
  assert.match(step1, /stop and report the missing fact/);
  const rules = BUILDER.slice(BUILDER.indexOf('### Mandatory Rules'), BUILDER.indexOf('### Localization'));
  assert.match(rules, /Copy `normalizeLookupReference` unchanged from rules\.md/);
  assert.match(rules, /`reference\.id` \(bare\)/);
  assert.match(rules, /\*\*Traceability\*\*/);
  assert.match(rules, /never `@odata\.bind`/, 'neighbour: the write rule stays');
});

test('Critical Rule 23 states lookup identities as a validated pair, beside the rules it does not renumber', () => {
  const critical = RULES.slice(RULES.indexOf('\n## Critical Rules\n'), RULES.indexOf('\n## Supported Libraries\n')).replace(/\s+/g, ' ');
  const rule23 = /\s23\. (.*?)(?= --- |$)/.exec(critical);
  assert.ok(rule23, 'rules.md has Critical Rule 23');
  assert.ok(rule23[1].startsWith(`**Lookup identities**: A lookup reference is a validated table-and-bare-id pair, not its label or the first metadata target. Normalize bare GUID and \`/<table>(<guid>)\` read values using the logical-name annotation and/or qualified prefix, checking both against metadata and rejecting conflicts. Use the bare id for filters, retrieval and navigation; rebuild the qualified value only for writes. Record every lookup used by a join/filter and its complete target set in Per-Page Specifications. Ask about unresolved relationship/filter meaning; never broaden a failed typed query. Unresolved references cannot trigger target-dependent actions.`), rule23[1]);
  assert.match(rule23[1], /See \*\*DataAPI Rules > Lookup references\*\*/, 'it points at the canonical normalizer');
  // Rules 1-21 and DataAPI Rules 12/13 keep their numbers: 22 follows 21, and 23 follows 22.
  assert.ok(critical.indexOf(' 21. **End final type-argument') < critical.indexOf(' 22. **Consistent errors**'));
  assert.ok(critical.indexOf(' 22. **Consistent errors**') < critical.indexOf(' 23. **Lookup identities**'));
  assert.match(RULES, /\n12\. \*\*Lookup display-name fields cannot be in \$select\*\*/);
  assert.match(RULES, /\n13\. \*\*Setting a lookup on create\/update — use `_<field>_value`, never `@odata\.bind`\*\*/);
});
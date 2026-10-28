'use strict';
// The plan's semantic contract (references/plan-schema.md), read without any I/O: what was assumed rather than stated, the
// relationship and filter decisions each page makes, and the lookups it relies on. Two documents carry it, at different heading
// levels, and each is read by its own reader — never by planSection, which knows level-two sections only:
//
//   written plan (genpage-plan.md)                     approval preview (the body the maker approved)
//   ## Assumptions                                     ### Assumptions            (first, before ### Pages)
//   ### A1 — Opportunity relationship                  #### A1 — Opportunity relationship
//   - Decision: …                                      - Decision: …
//   ## Per-Page Specifications                         ### Data Semantics
//   ### <Page Name>          (its - **File:** names    #### <page file>
//   #### Data semantics       the page)                ##### R<n> or F<n>
//   ##### R<n> or F<n>                                 ### Lookup Metadata
//   #### Lookup metadata                               #### <page file>
//   | Table | Column | Read property | Targets | Used by | Metadata state |
//
// Entry grammar (both documents): `- <Field>: <value>` bullets, a value continued on indented lines (a blank line ends it).
// Values are compared after Unicode NFC and whitespace collapsing only — case and wording are substantive. Anything the grammar
// does not name (another field, a prose line, a nested heading, a second section of the same name) is an error, never skipped:
// a skipped line is an approved decision nobody can see. Empty sections hold an exact sentinel (`No assumptions.`, `None.`).
//
// What this proves is structure, identifiers, sources, quotes and agreement between the approved and the written records. It
// does not prove that a quote entails a predicate, that a decision is material, or that prose elsewhere does not contradict it.

const path = require('node:path');
const { planSection } = require('./plan-sections.js');

const ASSUMPTION_ID = /^A[1-9][0-9]*$/;
const DECISION_ID = /^([RF])[1-9][0-9]*$/;
const QUESTION_ID = /^[^\s/()]+$/;
// The repository's logical-name shape (lib/app-components.js TABLE_NAME): lower case letters, digits, underscores, not a digit first.
const LOGICAL_NAME = /^[a-z_][a-z0-9_]*$/;
// A navigation property keeps its schema casing (`parentcustomerid_account`, `cr123_ProjectId`).
const NAVIGATION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESOLUTIONS = ['user-confirmed', 'planner-default', 'unattended-default'];
const EVIDENCE = /^(?:metadata|sample|default):\s*\S/;
const ASSUMPTION_FIELDS = ['Decision', 'Alternatives considered', 'Evidence', 'Resolution', 'Question', 'Answer', 'Default record'];
const DECISION_FIELDS = ['Kind', 'Definition', 'Source', 'Requirement quote'];
const LOOKUP_BULLETS = ['Evidence', 'Read target strategy'];
const LOOKUP_COLUMNS = ['table', 'column', 'read property', 'targets', 'used by', 'metadata state'];
const PATH_COLUMNS = ['table', 'column', 'target', 'navigation property', 'referenced key'];
const NO_ASSUMPTIONS = 'No assumptions.';
const NONE = 'None.';
const KIND_OF = { R: 'relationship', F: 'filter' };

function problem(code, message) {
  return { code, message };
}

// What a value is compared as: NFC, every run of whitespace one space, trimmed. Case and wording are kept.
function normalizeValue(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

// An ATX heading: `### A1 — Opportunity relationship` → { level: 3, title: 'A1 — Opportunity relationship' }.
function heading(line) {
  const match = /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line);
  return match && match[2] ? { level: match[1].length, title: match[2] } : null;
}

// Every heading of exactly `level` among `lines`, each with its body: the lines up to the next heading at `level` or shallower.
function sectionsAt(lines, level) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const found = heading(lines[i]);
    if (!found || found.level !== level) continue;
    let end = i + 1;
    while (end < lines.length) {
      const next = heading(lines[end]);
      if (next && next.level <= level) break;
      end += 1;
    }
    out.push({ title: found.title, index: i, body: lines.slice(i + 1, end) });
  }
  return out;
}

// A bounded body split at its headings of `level`: { lead, blocks: [{ title, body }] }. A heading of any other level stays in the
// body it falls in, where the grammar refuses it.
function blocksAt(lines, level) {
  const lead = [];
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const found = heading(line);
    if (found && found.level === level) {
      current = { title: found.title, body: [] };
      blocks.push(current);
      continue;
    }
    (current ? current.body : lead).push(line);
  }
  return { lead, blocks };
}

const meaningful = (lines) => lines.map((line) => line.trim()).filter(Boolean);

// The `- Field: value` bullets of an entry body, by canonical field name. A value may continue on indented lines; a blank line ends
// it. An unknown field, a repeated one, a nested heading or any other line is reported through `fail` and read as nothing.
//   - Evidence: metadata: customerid targets account, contact;
//     parentaccountid targets account.
// is Evidence = "metadata: customerid targets account, contact; parentaccountid targets account."
function entryFields(body, known, label, fail) {
  const fields = new Map();
  let last = null;
  for (const raw of body) {
    if (!raw.trim()) { last = null; continue; }
    if (heading(raw)) { fail(`${label}: unexpected heading "${raw.trim()}"`); last = null; continue; }
    const bullet = /^[-*][ \t]+([^:\n]+?)[ \t]*:[ \t]*(.*)$/.exec(raw);
    if (bullet) {
      const name = known.find((field) => field.toLowerCase() === bullet[1].trim().toLowerCase());
      if (!name) { fail(`${label}: unrecognized field "${bullet[1].trim()}"`); last = null; continue; }
      if (fields.has(name)) { fail(`${label}: duplicate field "${name}"`); last = null; continue; }
      fields.set(name, bullet[2]);
      last = name;
      continue;
    }
    if (last && /^[ \t]+\S/.test(raw)) { fields.set(last, `${fields.get(last)} ${raw.trim()}`); continue; }
    fail(`${label}: unrecognized line "${raw.trim().slice(0, 80)}"`);
    last = null;
  }
  for (const [name, value] of fields) fields.set(name, normalizeValue(value));
  return fields;
}

// A page file as the Pages table and planTargets spell it: backticks dropped, `.` segments removed (`./a.tsx` is `a.tsx`).
function pageFileKey(text) {
  const bare = String(text || '').trim().replace(/^`(.*)`$/, '$1').trim();
  return bare ? path.posix.normalize(bare) : '';
}

const quoteless = (text) => text.replace(/^(["'“‘])(.*)(["'”’])$/u, (all, open, inner, close) => (
  (open === '"' && close === '"') || (open === "'" && close === "'") || (open === '“' && close === '”') || (open === '‘' && close === '’') ? inner : all));

// The assumption entries of a section body (written: level 3 under `## Assumptions`; preview: level 4 under `### Assumptions`):
// { sentinel, entries: Map(id → entry) }. Entry rules (references/plan-schema.md "## Assumptions"):
//   - ids `A<n>`, unique; Decision, Alternatives considered, Evidence and Resolution present and non-empty;
//   - Evidence starts with `metadata:`, `sample:` or `default:`;
//   - Resolution `user-confirmed` (needs Question and Answer), `planner-default` (no question asked, so neither, and no Default record)
//     or `unattended-default` (Question, Answer and the exact Default record line, below).
function readAssumptions(body, level, where, problems) {
  const fail = (message) => problems.push(problem('invalid-assumptions', message));
  const { lead, blocks } = blocksAt(body, level);
  const leadText = meaningful(lead);
  const entries = new Map();
  if (!blocks.length) {
    if (leadText.length === 1 && leadText[0] === NO_ASSUMPTIONS) return { sentinel: true, entries };
    fail(`${where} must hold "${'#'.repeat(level)} A1 — …" entries or exactly "${NO_ASSUMPTIONS}"`);
    return { sentinel: false, entries };
  }
  if (leadText.length) fail(`${where} has text before its first entry: "${leadText[0].slice(0, 80)}"`);
  for (const block of blocks) {
    const title = /^(A[1-9][0-9]*)(?:[ \t]+[—–-][ \t]+(\S.*))?$/.exec(block.title.trim());
    if (!title) { fail(`${where}: "${'#'.repeat(level)} ${block.title}" is not an assumption id (A1, A2, …)`); continue; }
    const id = title[1];
    const label = `${where} ${id}`;
    if (entries.has(id)) { fail(`${where}: duplicate assumption id ${id}`); continue; }
    const fields = entryFields(block.body, ASSUMPTION_FIELDS, label, fail);
    const entry = {
      id,
      title: normalizeValue(title[2] || ''),
      decision: fields.get('Decision'),
      alternatives: fields.get('Alternatives considered'),
      evidence: fields.get('Evidence'),
      resolution: fields.get('Resolution'),
      question: fields.get('Question'),
      answer: fields.get('Answer'),
      defaultRecord: fields.get('Default record'),
    };
    for (const field of ['Decision', 'Alternatives considered', 'Evidence', 'Resolution']) {
      if (!fields.get(field)) fail(`${label}: missing ${field}`);
    }
    for (const field of ['Question', 'Answer', 'Default record']) {
      if (fields.has(field) && !fields.get(field)) fail(`${label}: ${field} is empty`);
    }
    if (entry.evidence && !EVIDENCE.test(entry.evidence)) fail(`${label}: Evidence must start with "metadata:", "sample:" or "default:"`);
    if (entry.resolution && !RESOLUTIONS.includes(entry.resolution)) {
      fail(`${label}: Resolution must be ${RESOLUTIONS.join(', ')} (got "${entry.resolution}")`);
    }
    if (entry.question && !QUESTION_ID.test(entry.question)) fail(`${label}: Question must be the question's id (got "${entry.question}")`);
    if (entry.resolution === 'user-confirmed' || entry.resolution === 'unattended-default') {
      if (!entry.question) fail(`${label}: a ${entry.resolution} assumption needs the Question it answered`);
      if (!entry.answer) fail(`${label}: a ${entry.resolution} assumption needs the actual Answer`);
    }
    if (entry.resolution === 'planner-default' && (entry.question || entry.answer)) {
      fail(`${label}: a planner-default assumption asked no question — an answered one is user-confirmed or unattended-default`);
    }
    if (entry.resolution === 'unattended-default') {
      const why = defaultRecordProblem(entry);
      if (why) fail(`${label}: ${why}`);
    } else if (entry.defaultRecord) {
      fail(`${label}: only an unattended-default assumption carries a Default record`);
    }
    entries.set(id, entry);
  }
  return { sentinel: false, entries };
}

// The Default record of an unattended-default assumption is the exact line the run logged in workflow-log.md:
//   Unattended default: A1 / opportunities-account-scope → Direct customer account only (the request excludes contact roll-up)
// — this entry's id, its Question, its Answer word for word, either arrow (`→`, or the historical `->`), and a non-empty reason
// in parentheses that does not contain the word "approved": that word is reserved for the separate plan-approval record
// (`Unattended default: plan approval → approved (…)`), which a semantic default must never be mistaken for.
function defaultRecordProblem(entry) {
  if (!entry.defaultRecord) return 'an unattended-default assumption needs its Default record';
  if (!entry.question || !entry.answer) return null;
  const record = entry.defaultRecord;
  const head = ['→', '->'].map((arrow) => normalizeValue(`Unattended default: ${entry.id} / ${entry.question} ${arrow} ${entry.answer} (`))
    .find((prefix) => record.startsWith(prefix));
  if (!head) return `the Default record must read "Unattended default: ${entry.id} / ${entry.question} → ${entry.answer} (<reason>)"`;
  const rest = record.slice(head.length);
  if (!rest.endsWith(')') || !rest.slice(0, -1).trim()) return 'the Default record must end with its reason in parentheses';
  if (/\bapproved\b/i.test(rest.slice(0, -1))) return 'the Default record\'s reason must not contain the word "approved" (reserved for plan approval)';
  return null;
}
// The relationship and filter decisions of one page (written: level 5 under `#### Data semantics`; preview: level 5 under the page's
// `#### <file>` in `### Data Semantics`): { sentinel, entries: Map(id → decision) }. Ids are page-local `R<n>` (Kind relationship)
// and `F<n>` (Kind filter); Source is one assumption id or exactly `User Requirements`, which also needs a Requirement quote.
// The cross-references (an assumption that exists, a quote found in the requirements) are checked by the caller, which knows both.
function readDecisions(body, where, problems) {
  const fail = (message) => problems.push(problem('invalid-data-semantics', message));
  const { lead, blocks } = blocksAt(body, 5);
  const leadText = meaningful(lead);
  const entries = new Map();
  if (!blocks.length) {
    if (leadText.length === 1 && leadText[0] === NONE) return { sentinel: true, entries };
    fail(`${where} must hold "##### R1" / "##### F1" entries or exactly "${NONE}"`);
    return { sentinel: false, entries };
  }
  if (leadText.length) fail(`${where} has text before its first entry: "${leadText[0].slice(0, 80)}"`);
  for (const block of blocks) {
    const id = block.title.trim();
    const shape = DECISION_ID.exec(id);
    if (!shape) { fail(`${where}: "##### ${block.title}" is not a decision id (R1, F1, …)`); continue; }
    const label = `${where} ${id}`;
    if (entries.has(id)) { fail(`${where}: duplicate decision id ${id}`); continue; }
    const fields = entryFields(block.body, DECISION_FIELDS, label, fail);
    const decision = {
      id,
      kind: fields.get('Kind'),
      definition: fields.get('Definition'),
      source: fields.get('Source'),
      quote: fields.has('Requirement quote') ? quoteless(fields.get('Requirement quote')) : undefined,
    };
    if (decision.kind !== KIND_OF[shape[1]]) fail(`${label}: Kind must be "${KIND_OF[shape[1]]}" for an ${shape[1]} id (got "${decision.kind || ''}")`);
    if (!decision.definition) fail(`${label}: missing Definition`);
    if (!decision.source) {
      problems.push(problem('missing-semantic-source', `${label}: missing Source — one assumption id or exactly "User Requirements"`));
    } else if (decision.source !== 'User Requirements' && !ASSUMPTION_ID.test(decision.source)) {
      problems.push(problem('missing-semantic-source', `${label}: Source must be one assumption id or exactly "User Requirements" (got "${decision.source}")`));
    }
    entries.set(id, decision);
  }
  return { sentinel: false, entries };
}

// Splits a `| a | b |` line into its trimmed cells, or null for a line that is not a table row.
function tableCells(line) {
  return /^\s*\|.*\|\s*$/.test(line) ? line.trim().slice(1, -1).split('|').map((cell) => cell.trim()) : null;
}
const isDelimiter = (cells) => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));

// The lookup records of one page (written: under `#### Lookup metadata`; preview: under the page's `#### <file>` in
// `### Lookup Metadata`), exactly the shape references/plan-schema.md documents:
//   | Table | Column | Read property | Targets | Used by | Metadata state |
//   |-------|--------|---------------|---------|---------|----------------|
//   | opportunity | customerid | _customerid_value | account, contact | R<n>, F<n>; customer navigation | observed |
//
//   | Table | Column | Target | Navigation property | Referenced key |
//   |-------|--------|--------|---------------------|----------------|
//   | opportunity | customerid | account | customerid_account | accountid |
//
//   - Evidence: lookup-metadata.json; successful source/target metadata discovery.
//   - Read target strategy: normalize the logical-name annotation and qualified prefix; …
// or exactly `None.`. Returns { sentinel, rows: Map('table|column' → row), paths: Map('table|column|target' → path), evidence,
// strategy }. Targets is the complete allowed set; Used by names decisions (R<n>/F<n>, checked by the caller) and declared purposes;
// Metadata state is `planned` (a table not created yet — no paths) or `observed`.
function readLookups(body, where, problems) {
  const fail = (message) => problems.push(problem('invalid-lookup-metadata', message));
  const result = { sentinel: false, rows: new Map(), paths: new Map(), evidence: undefined, strategy: undefined };
  const text = meaningful(body);
  if (text.length === 1 && text[0] === NONE) return { ...result, sentinel: true };
  if (!text.length) { fail(`${where} must hold the lookup table or exactly "${NONE}"`); return result; }
  const tables = [];
  const bulletLines = [];
  for (let i = 0; i < body.length; i += 1) {
    const cells = tableCells(body[i]);
    if (!cells) { bulletLines.push(body[i]); continue; }
    const next = i + 1 < body.length ? tableCells(body[i + 1]) : null;
    if (!next || !isDelimiter(next)) { fail(`${where}: a table row outside a table: "${body[i].trim().slice(0, 80)}"`); continue; }
    const table = { headers: cells.map((cell) => cell.toLowerCase()), rows: [] };
    i += 2;
    while (i < body.length && tableCells(body[i])) {
      const row = tableCells(body[i]);
      if (isDelimiter(row)) fail(`${where}: a second delimiter row inside a table`);
      else table.rows.push(row);
      i += 1;
    }
    i -= 1;
    tables.push(table);
  }
  const sameColumns = (headers, wanted) => headers.length === wanted.length && wanted.every((column) => headers.includes(column));
  const lookupTables = tables.filter((table) => sameColumns(table.headers, LOOKUP_COLUMNS));
  const pathTables = tables.filter((table) => sameColumns(table.headers, PATH_COLUMNS));
  for (const table of tables) {
    if (!lookupTables.includes(table) && !pathTables.includes(table)) fail(`${where}: a table with columns ${table.headers.join(', ')} is not a lookup or path table`);
  }
  if (lookupTables.length !== 1) fail(`${where} must hold exactly one lookup table (Table, Column, Read property, Targets, Used by, Metadata state)`);
  if (pathTables.length > 1) fail(`${where} must hold at most one path table (Table, Column, Target, Navigation property, Referenced key)`);
  const cell = (table, row, column) => normalizeValue(row[table.headers.indexOf(column)] ?? '');
  for (const table of lookupTables.slice(0, 1)) {
    for (const raw of table.rows) {
      const row = {
        table: cell(table, raw, 'table'),
        column: cell(table, raw, 'column'),
        readProperty: cell(table, raw, 'read property'),
        targets: cell(table, raw, 'targets').split(',').map((target) => target.trim()).filter(Boolean),
        usedBy: cell(table, raw, 'used by').split(/[;,]/).map((item) => normalizeValue(item)).filter(Boolean),
        state: cell(table, raw, 'metadata state'),
      };
      const key = `${row.table}|${row.column}`;
      const label = `${where} ${row.table}.${row.column}`;
      if (raw.length !== table.headers.length) fail(`${label}: the row has ${raw.length} cells, the table ${table.headers.length} columns`);
      if (!LOGICAL_NAME.test(row.table) || !LOGICAL_NAME.test(row.column)) fail(`${label}: Table and Column must be logical names`);
      if (row.readProperty !== `_${row.column}_value`) fail(`${label}: Read property must be _${row.column}_value`);
      if (!row.targets.length) fail(`${label}: Targets must list the lookup's complete target set`);
      if (row.targets.some((target) => !LOGICAL_NAME.test(target))) fail(`${label}: every target must be a table logical name`);
      if (new Set(row.targets).size !== row.targets.length) fail(`${label}: a target is listed twice`);
      if (!row.usedBy.length) fail(`${label}: Used by must name the decisions or purposes that use the lookup`);
      if (row.state !== 'planned' && row.state !== 'observed') fail(`${label}: Metadata state must be planned or observed (got "${row.state}")`);
      if (result.rows.has(key)) fail(`${where}: ${row.table}.${row.column} is listed twice`);
      else result.rows.set(key, row);
    }
    if (!table.rows.length) fail(`${where}: the lookup table has no rows — write exactly "${NONE}" when the page uses no lookup`);
  }
  for (const table of pathTables.slice(0, 1)) {
    for (const raw of table.rows) {
      const entry = {
        table: cell(table, raw, 'table'),
        column: cell(table, raw, 'column'),
        target: cell(table, raw, 'target'),
        navigation: cell(table, raw, 'navigation property'),
        key: cell(table, raw, 'referenced key'),
      };
      const label = `${where} ${entry.table}.${entry.column} → ${entry.target}`;
      const lookup = result.rows.get(`${entry.table}|${entry.column}`);
      if (!lookup) fail(`${label}: the path names a lookup the lookup table does not list`);
      else if (!lookup.targets.includes(entry.target)) fail(`${label}: ${entry.target} is not one of the lookup's targets`);
      else if (lookup.state !== 'observed') fail(`${label}: a planned lookup has no measured path yet`);
      if (!NAVIGATION_NAME.test(entry.navigation)) fail(`${label}: Navigation property must be a navigation property name`);
      if (!LOGICAL_NAME.test(entry.key)) fail(`${label}: Referenced key must be the target's key column`);
      const key = `${entry.table}|${entry.column}|${entry.target}`;
      if (result.paths.has(key)) fail(`${label}: the path is listed twice`);
      else result.paths.set(key, entry);
    }
  }
  const bullets = entryFields(bulletLines, LOOKUP_BULLETS, where, fail);
  result.evidence = bullets.get('Evidence');
  result.strategy = bullets.get('Read target strategy');
  if (result.rows.size && !result.evidence) fail(`${where}: missing "- Evidence:" — the metadata read the records come from`);
  if (result.rows.size && !result.strategy) fail(`${where}: missing "- Read target strategy:"`);
  return result;
}
// Cross-references within one document: a decision's assumption exists; a `User Requirements` source carries a Requirement quote
// that the original requirements contain (after the same NFC and whitespace normalization, case kept); every decision a lookup
// is Used by exists on that page. `requirements` is null for the preview, which does not carry the requirements text: its records
// must equal the written plan's, which is checked against them.
function crossCheck(read, requirements, problems) {
  const assumed = read.assumptions ? read.assumptions.entries : new Map();
  const text = requirements === null ? null : normalizeValue(requirements);
  for (const [file, page] of read.pages) {
    const decisions = page.semantics ? page.semantics.entries : new Map();
    for (const decision of decisions.values()) {
      const label = `${file} ${decision.id}`;
      if (decision.source && ASSUMPTION_ID.test(decision.source) && !assumed.has(decision.source)) {
        problems.push(problem('unknown-assumption', `${label}: Source ${decision.source} is not an entry of Assumptions`));
      }
      if (decision.source === 'User Requirements' && !decision.quote) {
        problems.push(problem('unmatched-requirement-quote', `${label}: a User Requirements source needs a Requirement quote`));
      }
      if (decision.quote !== undefined && text !== null && !text.includes(normalizeValue(decision.quote))) {
        problems.push(problem('unmatched-requirement-quote', `${label}: the Requirement quote "${decision.quote.slice(0, 80)}" is not in User Requirements`));
      }
    }
    for (const row of page.lookups ? page.lookups.rows.values() : []) {
      for (const item of row.usedBy) {
        if (DECISION_ID.test(item) && !decisions.has(item)) {
          problems.push(problem('invalid-lookup-metadata', `${file} ${row.table}.${row.column}: Used by names ${item}, which the page's Data semantics does not define`));
        }
      }
    }
  }
}

// The written plan's semantic records: { problems, assumptions: null | { sentinel, entries }, pages: Map(file → { page,
// semantics: null | …, lookups: null | … }), requirements }. null means "not recorded" — an older plan — never "none".
// Pages are keyed by their `- **File:** <file>` bullet, the name the approval preview groups them by.
function readWrittenSemantics(plan) {
  const lines = String(plan ?? '').replace(/\r\n?/g, '\n').split('\n');
  const problems = [];
  const read = { problems, assumptions: null, pages: new Map(), requirements: planSection(lines.join('\n'), 'User Requirements') ?? '' };
  const level2 = sectionsAt(lines, 2);
  const assumptionSections = level2.filter((section) => section.title.trim().toLowerCase() === 'assumptions');
  if (assumptionSections.length > 1) problems.push(problem('invalid-assumptions', 'the plan has more than one ## Assumptions section'));
  if (assumptionSections.length) read.assumptions = readAssumptions(assumptionSections[0].body, 3, '## Assumptions', problems);
  const specs = level2.filter((section) => section.title.trim().toLowerCase() === 'per-page specifications');
  const blocks = specs.flatMap((section) => sectionsAt(section.body, 3));
  const contract = read.assumptions !== null || blocks.some((block) => sectionsAt(block.body, 4)
    .some((sub) => ['data semantics', 'lookup metadata'].includes(sub.title.trim().toLowerCase())));
  if (specs.length > 1 && contract) problems.push(problem('invalid-data-semantics', 'the plan has more than one ## Per-Page Specifications section'));
  const fileLines = (block) => block.body.map((line) => /^\s*[-*]\s+\*\*File:\*\*\s*(.*?)\s*$/i.exec(line)).filter(Boolean).map((match) => pageFileKey(match[1]));
  if (contract) {
    // A plan carrying the contract has ONE specification per page. A second block with the same title or file — with or
    // without records of its own, before or after the one that has them — is refused here, before the legacy branch below
    // skips a block without records: the schema reader keeps the LAST block of a title and this reader the first with
    // records, so two authoritative blocks would otherwise be certified as one approved page. An older plan (no contract)
    // keeps its absence-only reading.
    const titles = new Set();
    const named = new Set();
    for (const block of specs.length ? sectionsAt(specs[0].body, 3) : []) {
      const title = block.title.trim().toLowerCase();
      if (titles.has(title)) problems.push(problem('invalid-data-semantics', `### ${block.title}: the plan has another page specification with this title`));
      titles.add(title);
      for (const file of new Set(fileLines(block).filter(Boolean))) {
        if (named.has(file)) problems.push(problem('invalid-data-semantics', `### ${block.title}: another page specification has the file ${file}`));
        named.add(file);
      }
    }
  }
  for (const block of specs.length ? sectionsAt(specs[0].body, 3) : []) {
    const subs = sectionsAt(block.body, 4);
    const semantics = subs.filter((sub) => sub.title.trim().toLowerCase() === 'data semantics');
    const lookups = subs.filter((sub) => sub.title.trim().toLowerCase() === 'lookup metadata');
    const files = fileLines(block);
    const where = `### ${block.title}`;
    if (!semantics.length && !lookups.length) {
      if (files.length === 1 && files[0] && !read.pages.has(files[0])) read.pages.set(files[0], { page: block.title, semantics: null, lookups: null });
      continue;
    }
    if (files.length !== 1 || !files[0]) {
      problems.push(problem('invalid-data-semantics', `${where}: a page with Data semantics or Lookup metadata needs exactly one - **File:** line`));
      continue;
    }
    if (read.pages.has(files[0]) && (read.pages.get(files[0]).semantics !== null || read.pages.get(files[0]).lookups !== null)) {
      problems.push(problem('invalid-data-semantics', `${where}: another page specification has the file ${files[0]}`));
      continue;
    }
    if (semantics.length > 1) problems.push(problem('invalid-data-semantics', `${where} has more than one #### Data semantics`));
    if (lookups.length > 1) problems.push(problem('invalid-lookup-metadata', `${where} has more than one #### Lookup metadata`));
    read.pages.set(files[0], {
      page: block.title,
      semantics: semantics.length ? readDecisions(semantics[0].body, `${where} #### Data semantics`, problems) : null,
      lookups: lookups.length ? readLookups(lookups[0].body, `${where} #### Lookup metadata`, problems) : null,
    });
  }
  crossCheck(read, read.requirements, problems);
  return read;
}

// The approval preview's semantic records, the same shape as readWrittenSemantics, from its own level-three sections. Assumptions
// is the preview's FIRST section — the maker reads what was assumed before the page list — and Data Semantics and Lookup Metadata
// follow `### Pages`, grouped under `#### <page file>`.
function readPreviewSemantics(preview) {
  const lines = String(preview ?? '').replace(/\r\n?/g, '\n').split('\n');
  const problems = [];
  const read = { problems, assumptions: null, pages: new Map(), requirements: null };
  const level3 = sectionsAt(lines, 3);
  const named = (title) => level3.filter((section) => section.title.trim().toLowerCase() === title);
  const [assumptions, semantics, lookups] = ['assumptions', 'data semantics', 'lookup metadata'].map(named);
  const pagesAt = level3.findIndex((section) => /^pages\b/i.test(section.title.trim()));
  if (assumptions.length > 1) problems.push(problem('invalid-assumptions', 'the preview has more than one ### Assumptions section'));
  if (semantics.length > 1) problems.push(problem('invalid-data-semantics', 'the preview has more than one ### Data Semantics section'));
  if (lookups.length > 1) problems.push(problem('invalid-lookup-metadata', 'the preview has more than one ### Lookup Metadata section'));
  if (assumptions.length) {
    if (level3[0] !== assumptions[0]) problems.push(problem('invalid-assumptions', 'the preview must present ### Assumptions first, before ### Pages'));
    read.assumptions = readAssumptions(assumptions[0].body, 4, '### Assumptions', problems);
  }
  const page = (file) => {
    if (!read.pages.has(file)) read.pages.set(file, { page: file, semantics: null, lookups: null });
    return read.pages.get(file);
  };
  for (const [sections, key, title, code, reader] of [
    [semantics, 'semantics', 'Data Semantics', 'invalid-data-semantics', readDecisions],
    [lookups, 'lookups', 'Lookup Metadata', 'invalid-lookup-metadata', readLookups],
  ]) {
    if (!sections.length) continue;
    const at = level3.indexOf(sections[0]);
    if (pagesAt < 0 || at < pagesAt) problems.push(problem(code, `the preview's ### ${title} must follow its ### Pages table`));
    const { lead, blocks } = blocksAt(sections[0].body, 4);
    if (meaningful(lead).length) problems.push(problem(code, `### ${title} has text before its first "#### <page file>" group`));
    if (!blocks.length) problems.push(problem(code, `### ${title} must group its records under "#### <page file>" headings`));
    for (const block of blocks) {
      const file = pageFileKey(block.title);
      const where = `### ${title} #### ${block.title.trim()}`;
      if (page(file)[key] !== null) { problems.push(problem(code, `### ${title} lists ${file} twice`)); continue; }
      page(file)[key] = reader(block.body, where, problems);
    }
  }
  const lookupsAt = lookups.length ? level3.indexOf(lookups[0]) : -1;
  const semanticsAt = semantics.length ? level3.indexOf(semantics[0]) : -1;
  if (lookupsAt >= 0 && semanticsAt > lookupsAt) problems.push(problem('invalid-lookup-metadata', 'the preview\'s ### Lookup Metadata must follow its ### Data Semantics'));
  crossCheck(read, null, problems);
  return read;
}

// Whether a read carries any part of the new contract. A document without any of it is an older plan: "not recorded".
function hasSemanticContract(read) {
  return read.assumptions !== null || [...read.pages.values()].some((page) => page.semantics !== null || page.lookups !== null);
}

// What a newly authored plan must also have (the `--require-assumptions` mode): the Assumptions section, and for every page file
// named, its Data semantics and Lookup metadata (entries or the `None.` sentinel).
function requiredContractProblems(read, files, label) {
  const problems = [];
  if (read.assumptions === null) problems.push(problem('invalid-assumptions', `${label} has no Assumptions section (write "${NO_ASSUMPTIONS}" when nothing was assumed)`));
  for (const file of files) {
    const page = read.pages.get(file);
    if (!page || page.semantics === null) problems.push(problem('invalid-data-semantics', `${label}: ${file} has no Data semantics (write "${NONE}" when it has no relationship or filter)`));
    if (!page || page.lookups === null) problems.push(problem('invalid-lookup-metadata', `${label}: ${file} has no Lookup metadata (write "${NONE}" when it uses no lookup)`));
  }
  return problems;
}
// The records a document approves, as plain data in a fixed order — what compareSemantics compares and semanticsHash hashes.
function semanticRecord(read) {
  const byNumber = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)) || a.id.localeCompare(b.id);
  const assumptions = read.assumptions === null ? null : (read.assumptions.sentinel ? NO_ASSUMPTIONS
    : [...read.assumptions.entries.values()].sort(byNumber).map((entry) => ({ ...entry })));
  const pages = {};
  for (const file of [...read.pages.keys()].sort()) {
    const page = read.pages.get(file);
    if (page.semantics === null && page.lookups === null) continue;
    pages[file] = {
      semantics: page.semantics === null ? null : (page.semantics.sentinel ? NONE : [...page.semantics.entries.values()].sort(byNumber).map((d) => ({ ...d }))),
      lookups: page.lookups === null ? null : (page.lookups.sentinel ? NONE : {
        rows: [...page.lookups.rows.values()].map((row) => ({ ...row, targets: [...row.targets].sort(), usedBy: [...row.usedBy].sort() }))
          .sort((a, b) => `${a.table}|${a.column}`.localeCompare(`${b.table}|${b.column}`)),
        paths: [...page.lookups.paths.values()].map((entry) => ({ ...entry }))
          .sort((a, b) => `${a.table}|${a.column}|${a.target}`.localeCompare(`${b.table}|${b.column}|${b.target}`)),
        strategy: page.lookups.strategy,
      }),
    };
  }
  return { assumptions, pages };
}

const ASSUMPTION_LABELS = { title: 'title', decision: 'Decision', alternatives: 'Alternatives considered', evidence: 'Evidence', resolution: 'Resolution', question: 'Question', answer: 'Answer', defaultRecord: 'Default record' };
const DECISION_LABELS = { kind: 'Kind', definition: 'Definition', source: 'Source', quote: 'Requirement quote' };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const describe = (value) => (value === null ? 'not recorded' : value === NO_ASSUMPTIONS || value === NONE ? `"${value}"` : 'recorded');

// What the written plan changed from the approved preview, as sentences (empty when it changed nothing it may not). Every
// assumption by id, every decision by page file and id, every lookup by table and column: an addition, an omission or a changed
// field needs new approval even when the page files are the same. The one change allowed is the post-provision reconciliation
// (references/plan-schema.md "Lookup metadata"): with `promotions` (successful lookup-metadata evidence, checked separately), a
// lookup approved as `planned` may be written as `observed` and gain its measured paths — never another column, target set or use.
function compareSemantics(approvedRead, writtenRead, { promotions = false } = {}) {
  const approved = semanticRecord(approvedRead);
  const written = semanticRecord(writtenRead);
  const out = [];
  if (!Array.isArray(approved.assumptions) || !Array.isArray(written.assumptions)) {
    if (!same(approved.assumptions, written.assumptions)) out.push(`Assumptions: approved ${describe(approved.assumptions)}, written ${describe(written.assumptions)}`);
  } else {
    const before = new Map(approved.assumptions.map((entry) => [entry.id, entry]));
    const after = new Map(written.assumptions.map((entry) => [entry.id, entry]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (!after.has(id)) { out.push(`Assumptions: ${id} was approved but is not written`); continue; }
      if (!before.has(id)) { out.push(`Assumptions: ${id} is written but was not approved`); continue; }
      const changed = Object.keys(ASSUMPTION_LABELS).filter((field) => !same(before.get(id)[field], after.get(id)[field]));
      if (changed.length) out.push(`Assumptions: ${id} changed its ${changed.map((field) => ASSUMPTION_LABELS[field]).join(', ')}`);
    }
  }
  for (const file of new Set([...Object.keys(approved.pages), ...Object.keys(written.pages)])) {
    const a = approved.pages[file] || { semantics: null, lookups: null };
    const w = written.pages[file] || { semantics: null, lookups: null };
    if (!Array.isArray(a.semantics) || !Array.isArray(w.semantics)) {
      if (!same(a.semantics, w.semantics)) out.push(`${file} Data semantics: approved ${describe(a.semantics)}, written ${describe(w.semantics)}`);
    } else {
      const before = new Map(a.semantics.map((d) => [d.id, d]));
      const after = new Map(w.semantics.map((d) => [d.id, d]));
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (!after.has(id)) { out.push(`${file} Data semantics: ${id} was approved but is not written`); continue; }
        if (!before.has(id)) { out.push(`${file} Data semantics: ${id} is written but was not approved`); continue; }
        const changed = Object.keys(DECISION_LABELS).filter((field) => !same(before.get(id)[field], after.get(id)[field]));
        if (changed.length) out.push(`${file} Data semantics: ${id} changed its ${changed.map((field) => DECISION_LABELS[field]).join(', ')}`);
      }
    }
    if (a.lookups === null || w.lookups === null || a.lookups === NONE || w.lookups === NONE) {
      if (!same(a.lookups, w.lookups)) out.push(`${file} Lookup metadata: approved ${describe(a.lookups)}, written ${describe(w.lookups)}`);
      continue;
    }
    if (!same(a.lookups.strategy, w.lookups.strategy)) out.push(`${file} Lookup metadata: the Read target strategy changed`);
    const before = new Map(a.lookups.rows.map((row) => [`${row.table}.${row.column}`, row]));
    const after = new Map(w.lookups.rows.map((row) => [`${row.table}.${row.column}`, row]));
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (!after.has(key)) { out.push(`${file} Lookup metadata: ${key} was approved but is not written`); continue; }
      if (!before.has(key)) { out.push(`${file} Lookup metadata: ${key} is written but was not approved`); continue; }
      const was = before.get(key);
      const is = after.get(key);
      const changed = [['readProperty', 'Read property'], ['targets', 'Targets'], ['usedBy', 'Used by']].filter(([field]) => !same(was[field], is[field]));
      if (changed.length) out.push(`${file} Lookup metadata: ${key} changed its ${changed.map(([, label]) => label).join(', ')}`);
      const promoted = was.state === 'planned' && is.state === 'observed';
      if (was.state !== is.state && !(promoted && promotions)) {
        out.push(`${file} Lookup metadata: ${key} was approved ${was.state} and is written ${is.state}${promoted ? ' without successful lookup metadata evidence' : ''}`);
      }
      const pathsOf = (record) => record.lookups.paths.filter((entry) => `${entry.table}.${entry.column}` === key);
      if (!(promoted && promotions) && !same(pathsOf(a), pathsOf(w))) out.push(`${file} Lookup metadata: the paths of ${key} changed`);
    }
  }
  return out;
}

// Checks every `observed` lookup of the written plan against the successful JSON answer of scripts/get-lookup-metadata.js:
//   { "ok": true, "tables": [ { "logicalName": "opportunity", "lookups": [ { "column": "customerid", "readProperty": "_customerid_value",
//     "targets": ["account", "contact"], "paths": [ { "target": "account", "navigationProperty": "customerid_account",
//     "referencedKey": "accountid" } ], "sharedPaths": [ … ] } ] } ] }
// The column must be a lookup of that table with the same read property and the SAME COMPLETE target set, and every path the plan
// records must be one of the concrete paths read (a shared path such as Owner's `ownerid` is not a target discriminator). A bare
// `observed` claim with no such answer, a failed answer, or any mismatch is a problem: no network I/O happens here.
function lookupEvidenceProblems(writtenRead, evidence) {
  const fail = (message) => problem('invalid-lookup-metadata', message);
  if (!evidence || typeof evidence !== 'object' || evidence.ok !== true || !Array.isArray(evidence.tables)) {
    return [fail('the lookup metadata evidence is not a successful get-lookup-metadata.js answer ({ "ok": true, "tables": [...] })')];
  }
  const tables = new Map(evidence.tables.filter((table) => table && typeof table.logicalName === 'string').map((table) => [table.logicalName, table]));
  const out = [];
  for (const [file, page] of writtenRead.pages) {
    if (!page.lookups || page.lookups.sentinel) continue;
    for (const row of page.lookups.rows.values()) {
      if (row.state !== 'observed') continue;
      const label = `${file} ${row.table}.${row.column}`;
      const table = tables.get(row.table);
      const lookup = table && Array.isArray(table.lookups) ? table.lookups.find((entry) => entry && entry.column === row.column) : null;
      if (!lookup) { out.push(fail(`${label}: the lookup metadata evidence has no such lookup`)); continue; }
      if (lookup.readProperty !== row.readProperty) out.push(fail(`${label}: the evidence reads it as ${lookup.readProperty}, the plan as ${row.readProperty}`));
      const read = Array.isArray(lookup.targets) ? [...lookup.targets].sort() : [];
      if (!same(read, [...row.targets].sort())) out.push(fail(`${label}: the plan's targets (${row.targets.join(', ')}) are not the complete set read (${read.join(', ')})`));
      for (const entry of page.lookups.paths.values()) {
        if (entry.table !== row.table || entry.column !== row.column) continue;
        const measured = (Array.isArray(lookup.paths) ? lookup.paths : []).find((candidate) => candidate && candidate.target === entry.target);
        if (!measured || measured.navigationProperty !== entry.navigation || measured.referencedKey !== entry.key) {
          out.push(fail(`${label} → ${entry.target}: the path ${entry.navigation} / ${entry.key} is not a concrete path the evidence read`));
        }
      }
    }
  }
  return out;
}

// The written plan's semantic problems for the schema validator: what readWrittenSemantics found, and — when `require` is set
// (a newly authored plan) — the parts a new plan must have for each of its pages.
function writtenSemanticsProblems(plan, { require = false } = {}) {
  const read = readWrittenSemantics(plan);
  const problems = [...read.problems];
  if (require) problems.push(...requiredContractProblems(read, [...read.pages.keys()], 'the plan'));
  return problems;
}

module.exports = {
  NO_ASSUMPTIONS,
  NONE,
  normalizeValue,
  readWrittenSemantics,
  readPreviewSemantics,
  hasSemanticContract,
  requiredContractProblems,
  semanticRecord,
  compareSemantics,
  lookupEvidenceProblems,
  writtenSemanticsProblems,
};

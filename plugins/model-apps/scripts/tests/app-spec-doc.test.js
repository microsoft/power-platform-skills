'use strict';
// Coverage for the App Spec -> model-app-plan.md renderer (scripts/lib/app-spec-doc.js) and its
// CLI wrapper (scripts/write-app-spec-doc.js). The renderer replaces a freehand "abbreviated counts"
// summary the /app-builder skill used to write from prose — testers reported that prose plan skipped
// jobs-to-be-done, produced no readable design doc, and never proposed generative pages, all because
// prose instructions get silently ignored. Rendering deterministically from app-spec.json means the
// document is (a) complete, (b) always in sync, and (c) regenerable. These tests pin that contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { renderAppSpecDoc } = require('../lib/app-spec-doc.js');

const CLI = path.join(__dirname, '..', 'write-app-spec-doc.js');

// A realistic multi-entity, multi-persona, multi-page spec. Kept in one factory so a single test can
// mutate a copy without perturbing the others. Matches the /app-builder authoring flow's shape.
function realisticSpec() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoSupport', publisherPrefix: 'new' },
    app: {
      name: 'Support Desk',
      uniqueName: 'contoso_support',
      description: 'Manage customers, their support tickets, and ticket comments.',
    },
    entities: [
      {
        schemaName: 'new_customer', displayName: 'Customer',
        primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: [{ schemaName: 'new_segment', displayName: 'Segment', type: 'Choice', options: [{ label: 'Enterprise' }, { label: 'Mid-Market' }] }],
      },
      {
        schemaName: 'new_ticket', displayName: 'Ticket',
        primaryAttribute: { schemaName: 'new_name', displayName: 'Title' },
        columns: [
          { schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options: [{ label: 'Low' }, { label: 'High' }] },
          { schemaName: 'new_description', displayName: 'Description', type: 'Memo', required: true },
        ],
        hasNotes: true,
      },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId' } },
    ],
    personas: [{
      persona: 'Agent',
      appAccess: true,
      jobs: [
        {
          name: 'Triage new tickets',
          description: 'See what came in overnight',
          privileges: [{ entity: 'new_ticket', access: ['read', 'write'], scope: 'user' }],
          surfaces: ['Active Tickets', 'overview'],
        },
        {
          name: 'Resolve escalations',
          privileges: [{ entity: 'new_ticket', access: ['read', 'write', 'delete'], scope: 'organization' }],
          surfaces: ['Ticket Main'],
        },
      ],
    }],
    forms: [
      { entity: 'new_ticket', type: 'main', name: 'Ticket Main', layout: 'auto', subgrids: [{ childEntity: 'new_comment' }] },
    ],
    views: [
      { entity: 'new_ticket', name: 'Active Tickets', columns: ['new_name', 'new_priority'] },
    ],
    charts: [
      { entity: 'new_ticket', name: 'By Priority', chartType: 'bar', measure: 'count', groupBy: 'new_priority' },
    ],
    pages: [
      {
        key: 'overview', name: 'Overview', purpose: 'KPIs at a glance',
        dataSources: ['new_ticket'], source: { kind: 'intent' },
        navigatesTo: [{ targetKey: 'ticket-detail' }],
      },
      {
        key: 'ticket-detail', name: 'Ticket Detail', purpose: 'Drill into one ticket',
        dataSources: ['new_ticket'], source: { kind: 'tsx', codeFile: 'ticket-detail.tsx' },
      },
    ],
    appShell: {
      areas: [{
        label: 'Work', groups: [{ label: 'Tickets', subAreas: [
          { title: 'Overview', page: 'overview' },
          { title: 'All Tickets', entity: 'new_ticket' },
        ] }],
      }],
    },
    sampleData: { new_customer: [{ new_name: 'Acme' }, { new_name: 'Contoso' }] },
    design: { accentColor: '#0f6cbd', density: 'compact' },
    ai: { rowSummaries: 'auto' },
  };
}

// A markdown table row is `| c1 | c2 | c3 |`. The renderer promises `|` inside a cell VALUE is
// escaped as `\|` and newlines are flattened — otherwise a stray pipe in a description or purpose
// silently breaks the column count and the reviewer sees a garbled table. Count pipes that are NOT
// preceded by a backslash: for a row with N columns that number is exactly N+1.
function unescapedPipeCount(row) {
  let n = 0;
  for (let i = 0; i < row.length; i++) if (row[i] === '|' && row[i - 1] !== '\\') n += 1;
  return n;
}

test('renders every expected section heading in document order', () => {
  const md = renderAppSpecDoc(realisticSpec(), { envUrl: 'https://x.crm.dynamics.com' });
  const expected = [
    '# Support Desk',
    '## Environment',
    '## Jobs to be done',
    '## Data model',
    '## Surfaces',
    '### Generative pages',
    '### Forms',
    '### Views',
    '### Charts',
    '## Navigation',
    '## Security',
    '## Sample data',
    '## Design contract',
    '## AI features',
  ];
  let cursor = -1;
  for (const heading of expected) {
    const at = md.indexOf(heading);
    assert.notEqual(at, -1, `missing section "${heading}"`);
    assert.ok(at > cursor, `section "${heading}" is out of document order`);
    cursor = at;
  }
});

test('absent optional blocks omit their section entirely', () => {
  // The empty-block omission is what keeps the design doc honest: a section header with no content
  // reads as "we considered this and left it blank", which is not what an absent block means.
  const s = realisticSpec();
  delete s.sampleData;
  delete s.design;
  delete s.ai;
  delete s.charts;
  delete s.dashboards; // never had them, but be explicit
  const md = renderAppSpecDoc(s);
  assert.doesNotMatch(md, /^## Sample data$/m);
  assert.doesNotMatch(md, /^## Design contract$/m);
  assert.doesNotMatch(md, /^## AI features$/m);
  assert.doesNotMatch(md, /^### Charts$/m);
  assert.doesNotMatch(md, /^### Classic dashboards$/m);
  // The mandatory sections that do NOT depend on optional blocks are still present.
  assert.match(md, /^## Data model$/m);
  assert.match(md, /^## Surfaces$/m);
});

test('a pipe or newline inside a cell value is escaped/flattened so the row keeps its column count', () => {
  // Regression: cell values (an app description, a job name, a page purpose) arrive from author
  // prose or from a downloaded spec. A stray `|` or `\n` in any of them would break a table row
  // silently — the reviewer would see a garbled table but no error. This is the important one:
  // assert structurally by counting unescaped pipes per row, not just that a substring appears.
  const s = realisticSpec();
  s.app.description = 'Track suppliers | contracts\nand renewals';
  s.personas[0].jobs[0].name = 'Triage | urgent\nissues';
  s.pages[0].purpose = 'KPIs | trends\nat a glance';
  const md = renderAppSpecDoc(s);

  // The Jobs table row for the persona/job with pipes must have exactly 4 unescaped pipes
  // (3 columns → 4 boundaries: Persona | Job | Surfaces). And the escaped literal must be present.
  const jobRow = md.split('\n').find((l) => l.includes('Triage \\|'));
  assert.ok(jobRow, `job row with escaped pipe not found. Rendered doc:\n${md}`);
  assert.equal(unescapedPipeCount(jobRow), 4, `job row column boundary count: "${jobRow}"`);

  // The Generative pages table row for the page with pipes must have exactly 7 boundaries
  // (6 columns: Page | Key | Purpose | Reads | Navigates to | State).
  const pageRow = md.split('\n').find((l) => l.includes('| Overview |'));
  assert.ok(pageRow, `overview page row not found. Rendered doc:\n${md}`);
  assert.equal(unescapedPipeCount(pageRow), 7, `page row column boundary count: "${pageRow}"`);
  assert.ok(pageRow.includes('KPIs \\|'), `page purpose pipe should be escaped: "${pageRow}"`);

  // The app description appears in the overview paragraph (not a table) — verify the newline is
  // flattened to a space so it does not silently open a new block that changes document order.
  assert.match(md, /Track suppliers \| contracts and renewals/);
});

test('a tsx-built page renders with its codeFile; an intent page renders as intent', () => {
  const md = renderAppSpecDoc(realisticSpec());
  const overviewRow = md.split('\n').find((l) => l.startsWith('| Overview '));
  const detailRow = md.split('\n').find((l) => l.startsWith('| Ticket Detail '));
  assert.match(overviewRow, /intent \(code not yet generated\)/);
  assert.match(detailRow, /built \(`ticket-detail\.tsx`\)/);
});

test('the security section unions privileges per table with max scope winning', () => {
  // Regression protection: two jobs on the same persona both touch new_ticket, one at `user` and
  // one at `organization`. The SDK unions them (max scope wins) and the reviewer should see ONE
  // row for new_ticket at `organization`, not two rows they have to merge mentally.
  const md = renderAppSpecDoc(realisticSpec());
  const secStart = md.indexOf('## Security');
  // Match the NEXT `## ` heading only — a plain indexOf('## ') would hit `### ` sub-headings
  // (Role: Agent) as a substring and slice the section down to nothing.
  const nextTop = md.slice(secStart + 3).search(/\n## /);
  const secEnd = nextTop === -1 ? md.length : secStart + 3 + nextTop;
  const section = md.slice(secStart, secEnd);

  const ticketRows = section.split('\n').filter((l) => /^\| new_ticket \|/.test(l));
  assert.equal(ticketRows.length, 1, `expected ONE unioned new_ticket row, got: ${JSON.stringify(ticketRows)}`);
  assert.match(ticketRows[0], /organization/, `max scope should win: "${ticketRows[0]}"`);
  // Access set is the union of both jobs, so all three levels must appear.
  for (const level of ['read', 'write', 'delete']) {
    assert.ok(ticketRows[0].includes(level), `unioned access must include ${level}: "${ticketRows[0]}"`);
  }
});

test('the no-personas warning callout is rendered when personas[] is absent', () => {
  const s = realisticSpec();
  delete s.personas;
  const md = renderAppSpecDoc(s);
  // Callouts are `> ⚠ …` blockquote lines inside `## Jobs to be done`.
  assert.match(md, /## Jobs to be done[\s\S]*?> ⚠ No `personas\[\]` were captured/);
});

test('the unmapped-jobs warning callout names the count when a job has no surfaces', () => {
  const s = realisticSpec();
  s.personas[0].jobs[1].surfaces = []; // drop mapping on one of two jobs
  const md = renderAppSpecDoc(s);
  assert.match(md, /> ⚠ 1 job\(s\) are not mapped to a surface/);
});

test('the no-pages warning callout appears when pages[] is empty', () => {
  const s = realisticSpec();
  s.pages = [];
  const md = renderAppSpecDoc(s);
  assert.match(md, /### Generative pages[\s\S]*?> ⚠ No generative pages\./);
});

// ---- CLI wrapper (write-app-spec-doc.js) --------------------------------------------------------

function makeWorkspace(spec) {
  // os.tmpdir() on Windows is %LOCALAPPDATA%\Temp, matching every other test in this suite.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appdoc-'));
  fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify(spec, null, 2), 'utf8');
  return dir;
}

function runCli(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

test('CLI writes the doc next to the spec by default and returns ok:true with byte count', () => {
  const dir = makeWorkspace(realisticSpec());
  try {
    const r = runCli(['--spec', '@' + path.join(dir, 'app-spec.json')]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.docPath, path.join(dir, 'model-app-plan.md'));
    assert.ok(fs.existsSync(out.docPath), 'doc file was written');
    const contents = fs.readFileSync(out.docPath, 'utf8');
    assert.equal(out.bytes, Buffer.byteLength(contents, 'utf8'));
    assert.match(contents, /^# Support Desk — design/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --out honours a caller-supplied path', () => {
  const dir = makeWorkspace(realisticSpec());
  try {
    const custom = path.join(dir, 'nested', 'other-name.md');
    const r = runCli(['--spec', '@' + path.join(dir, 'app-spec.json'), '--out', custom]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.docPath, custom);
    assert.ok(fs.existsSync(custom), 'custom-path doc file was written');
    // The default location must NOT be written when --out is provided.
    assert.equal(fs.existsSync(path.join(dir, 'model-app-plan.md')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI warnings equal designGaps(spec) — the JSON echo of the callouts in the document', () => {
  // The orchestrator surfaces warnings in chat rather than making the user open the file, so the
  // JSON `warnings` array MUST match designGaps exactly (order and text). Pinning the equality
  // prevents the two from drifting when a new gap is added to only one side.
  const { designGaps } = require('../write-app-spec-doc.js');
  const { migrateAppSpec } = require('../lib/app-spec.js');

  // A spec that trips all three gaps: no personas, no pages. (`personas` empty implies no jobs.)
  const s = realisticSpec();
  delete s.personas;
  s.pages = [];
  const dir = makeWorkspace(s);
  try {
    const r = runCli(['--spec', '@' + path.join(dir, 'app-spec.json')]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const gaps = designGaps(migrateAppSpec(s));
    assert.deepEqual(out.warnings, gaps, 'CLI warnings must equal designGaps');
    assert.ok(out.warnings.some((w) => /no jobs-to-be-done captured/.test(w)), JSON.stringify(out.warnings));
    assert.ok(out.warnings.some((w) => /no generative pages/.test(w)), JSON.stringify(out.warnings));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI warnings include unmapped-job entries with persona and job name', () => {
  const s = realisticSpec();
  s.personas[0].jobs[0].surfaces = []; // one of two jobs is unmapped
  const dir = makeWorkspace(s);
  try {
    const r = runCli(['--spec', '@' + path.join(dir, 'app-spec.json')]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const unmapped = out.warnings.find((w) => /not mapped to a surface/.test(w));
    assert.ok(unmapped, `expected unmapped-job warning, got: ${JSON.stringify(out.warnings)}`);
    assert.match(unmapped, /Agent → Triage new tickets/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI warnings are empty when the spec has personas with mapped jobs and pages', () => {
  const dir = makeWorkspace(realisticSpec());
  try {
    const r = runCli(['--spec', '@' + path.join(dir, 'app-spec.json')]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.warnings, [], `expected no gaps, got: ${JSON.stringify(out.warnings)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails cleanly (exit 1, message to stderr) when --spec is missing', () => {
  // Failure paths matter for the skill: a raw Node stack in stderr would leak into chat and
  // confuse the user. Assert the friendly usage line instead of a stack frame.
  const r = runCli([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage:/);
  assert.doesNotMatch(r.stderr, /at Object\.<anonymous>/);
});

test('CLI fails cleanly when the spec file does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appdoc-bad-'));
  try {
    const r = runCli(['--spec', '@' + path.join(dir, 'does-not-exist.json')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot read app spec/);
    assert.doesNotMatch(r.stderr, /at Object\.<anonymous>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails cleanly when the spec is not valid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appdoc-badjson-'));
  try {
    fs.writeFileSync(path.join(dir, 'app-spec.json'), '{ not: json', 'utf8');
    const r = runCli(['--spec', '@' + path.join(dir, 'app-spec.json')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot read app spec/);
    assert.doesNotMatch(r.stderr, /at Object\.<anonymous>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'preview-app.js');
const tempDirs = [];

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSpec(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-app-test-'));
  tempDirs.push(dir);
  const specPath = path.join(dir, 'app-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
  return specPath;
}

function run(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

test('missing spec argument exits 1 with the CLI usage string', () => {
  const res = run([]);

  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: node scripts\/preview-app\.js --spec @<app-folder>\/app-spec\.json/);
  assert.equal(res.stdout, '');
});

test('renders a whole-app preview from --spec @file and migrates legacy page references to keys', () => {
  const specPath = writeSpec({
    schemaVersion: 1,
    app: { name: 'Service Console', description: 'Triage customer work' },
    solution: { uniqueName: 'new_service', publisherPrefix: 'new' },
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Work', subAreas: [{ page: 'Overview', title: 'Overview' }] }] }] },
    pages: [
      { name: 'Overview', purpose: 'Queue KPIs', dataSources: ['new_ticket'], codeFile: 'overview.tsx', navigatesTo: [{ targetKey: 'Ticket Detail' }] },
      { name: 'Ticket Detail', purpose: 'One ticket', dataSources: ['new_ticket'], codeFile: 'ticket-detail.tsx' },
    ],
    design: { accentColor: '#0f6cbd', density: 'compact' },
  });

  const res = run(['--spec', '@' + specPath]);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /APP: Service Console/);
  assert.match(res.stdout, /=== Data model ===/);
  assert.match(res.stdout, /page:overview/);
  assert.match(res.stdout, /Overview \[overview\] — implemented \(overview\.tsx\)/);
  assert.match(res.stdout, /→ navigates to ticket-detail/);
  assert.match(res.stdout, /accentColor=#0f6cbd/);
});

test('accepts a positional spec path without @ and renders minimal missing sections', () => {
  const specPath = writeSpec({ app: { name: 'Bare Console' } });

  const res = run([specPath]);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /APP: Bare Console/);
  assert.match(res.stdout, /\(no tables\)/);
  assert.match(res.stdout, /\(no forms\)/);
});

test('malformed JSON exits non-zero before a partial preview is printed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-app-test-'));
  tempDirs.push(dir);
  const specPath = path.join(dir, 'app-spec.json');
  fs.writeFileSync(specPath, '{"app":', 'utf8');

  const res = run(['--spec', '@' + specPath]);

  assert.notEqual(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /SyntaxError/);
});

test('renders scalar persona privilege access without crashing', () => {
  const specPath = writeSpec({
    personas: [
      {
        persona: 'Support',
        jobs: [{ name: 'Read tickets', privileges: [{ entity: 'new_ticket', access: 'read' }] }],
      },
    ],
  });

  const res = run(['--spec', '@' + specPath]);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /new_ticket: read @ user/);
});

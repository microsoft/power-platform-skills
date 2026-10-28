'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, '..', 'run-layer-1.js');

function mkTempFixturesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'layer1-tests-'));
}

function writeFixture(rootDir, fixtureName, files) {
  const dir = path.join(rootDir, fixtureName);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function runRunner(args) {
  const result = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Minimal workflow log + plan that should satisfy core assertions for a mock
// (code-only) eval like id 2.
function mockEval2Artifacts() {
  return {
    'workflow-log.md': `# Workflow Log
## Phase 0
- working directory created
## Phase 1
- node --version
- pac help → PAC CLI Version 2.11.0 (> 2.10.0 verified)
- pac auth list — active profile, environment https://x.crm.dynamics.com
- AskUserQuestion: new or edit → create new
- Solution selection question SKIPPED (code-only flow)
- EnterPlanMode → approved
## Phase 2 — SKIPPED (mock data)
## Phase 4 — genpage.js types not run (mock data)
## Phase 5b — single-page fast path, inlined build
- Data mode: mock
- read verified-icons.txt
- read samples/8-dashboard-with-charts.tsx
- icon verification: grep "react-icons", verified icons against verified-icons.txt
## Phase 6
- node scripts/genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 1 --code-file p.tsx --prompt-file prompt.txt --model claude-sonnet --name-file page-name.txt --agent-message-file agent-message.txt --add-to-sitemap
`,
    'genpage-plan.md': `# Genpage Plan
## User Requirements
foo
## Working Directory
D:\\work\\mock-dashboard
## Plugin Root
D:\\repo\\plugins\\model-apps
## Environment
- URL: https://x.crm.dynamics.com
- App: Existing App (1)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new
## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| P | p.tsx | Mock dashboard | mock data |
## Entity Creation Required
No entity creation required — all entities already exist.
## Existing Entities
None
## Connector Bindings
No connector bindings.
## Custom API Bindings
No custom API bindings.
## Design Preferences
- Styling: clean
- Features: mock dashboard
- Accessibility: WCAG AA
## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| P | 8-dashboard-with-charts.tsx | Dashboard layout |
## Per-Page Specifications
### P
- **File:** p.tsx
- **Purpose:** Mock dashboard
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** KPI cards
- **Components:** Card, Text
- **Layout:** Responsive grid
- **Data Binding:** Inline mock arrays
- **Interactions:** Local filtering only
`,
  };
}

// ---------- end-to-end: green-path fixture ----------

test('runner: exits 0 when fixture satisfies common assertions', () => {
  const root = mkTempFixturesDir();
  try {
    writeFixture(root, '2-mock', mockEval2Artifacts());
    // Add at least one .tsx so fixture-loader doesn't choke (it doesn't gate on .tsx for L1 but we keep parity)
    fs.writeFileSync(path.join(root, '2-mock', 'p.tsx'), `// pretend page`);
    const { code, stdout } = runRunner(['--fixtures', root, '--eval', '2']);
    assert.equal(code, 0, `expected exit 0 but got ${code}.\nstdout:\n${stdout}`);
    assert.match(stdout, /ok 1 - 2-mock/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: missing workflow-log.md ----------

test('runner: fails when workflow-log.md missing', () => {
  const root = mkTempFixturesDir();
  try {
    const artifacts = mockEval2Artifacts();
    delete artifacts['workflow-log.md'];
    writeFixture(root, '2-no-log', artifacts);
    fs.writeFileSync(path.join(root, '2-no-log', 'p.tsx'), `// page`);
    const { code, stdout } = runRunner(['--fixtures', root, '--eval', '2']);
    assert.equal(code, 1);
    assert.match(stdout, /not ok \d+ - A workflow-log\.md file is saved/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: missing genpage-plan.md ----------

test('runner: fails when genpage-plan.md missing', () => {
  const root = mkTempFixturesDir();
  try {
    const artifacts = mockEval2Artifacts();
    delete artifacts['genpage-plan.md'];
    writeFixture(root, '2-no-plan', artifacts);
    fs.writeFileSync(path.join(root, '2-no-plan', 'p.tsx'), `// page`);
    const { code, stdout } = runRunner(['--fixtures', root, '--eval', '2']);
    assert.equal(code, 1);
    assert.match(stdout, /not ok \d+ - .*'Solution:' and 'Publisher Prefix:'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: filter by tier ----------

test('runner: --tier filters by eval tier', () => {
  const root = mkTempFixturesDir();
  try {
    writeFixture(root, '2-smoke', mockEval2Artifacts());
    fs.writeFileSync(path.join(root, '2-smoke', 'p.tsx'), `// page`);
    writeFixture(root, '4-full', mockEval2Artifacts());
    fs.writeFileSync(path.join(root, '4-full', 'p.tsx'), `// page`);
    const { stdout } = runRunner(['--fixtures', root, '--tier', 'smoke']);
    assert.match(stdout, /# Subtest: 2-smoke/);
    assert.doesNotMatch(stdout, /# Subtest: 4-full/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: missing fixtures dir ----------

test('runner: exits 2 when fixtures dir missing', () => {
  const { code, stderr } = runRunner(['--fixtures', '/nonexistent/path/zzz']);
  assert.equal(code, 2);
  assert.match(stderr, /Fixtures directory does not exist/);
});

// ---------- end-to-end: TAP shape ----------

test('runner: emits TAP version 13 and aggregate counts', () => {
  const root = mkTempFixturesDir();
  try {
    writeFixture(root, '2-x', mockEval2Artifacts());
    fs.writeFileSync(path.join(root, '2-x', 'p.tsx'), `// page`);
    const { stdout } = runRunner(['--fixtures', root]);
    assert.match(stdout, /^TAP version 13/m);
    assert.match(stdout, /# tests \d+/);
    assert.match(stdout, /# pass\s+\d+/);
    assert.match(stdout, /# fail\s+\d+/);
    assert.match(stdout, /# skip\s+\d+/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- a newly authored plan's semantic records: a real callback and a real exit status ----------

const NEW_CONTRACT = "Phase 1 (Planner): The newly authored plan records its assumptions and every page's data semantics and lookup metadata, the approved preview carries the same records, and provenance is verified with --require-assumptions";

test('runner: fixture 27 grades its newly authored plan, and a copy verified without --require-assumptions fails with exit 1', (t) => {
  const green = runRunner(['--eval', '27']);
  assert.equal(green.code, 0, green.stdout + green.stderr);
  const line = green.stdout.split('\n').find((entry) => entry.includes(NEW_CONTRACT));
  assert.ok(line && /^\s*ok \d+ - /.test(line) && !/# SKIP/.test(line), `graded and passing, not skipped: ${line}`);
  const root = mkTempFixturesDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copy = path.join(root, '27-page-error-helper');
  fs.cpSync(path.join(__dirname, '..', 'fixtures', '27-page-error-helper'), copy, { recursive: true });
  const results = path.join(copy, 'tool-results.json');
  const events = JSON.parse(fs.readFileSync(results, 'utf8'));
  for (const event of events) event.command = event.command.replace(' --require-assumptions', '');
  fs.writeFileSync(results, JSON.stringify(events, null, 2));
  const red = runRunner(['--fixtures', root, '--eval', '27']);
  assert.equal(red.code, 1, red.stdout);
  assert.match(red.stdout, /provenance was never verified with --require-assumptions/);
  // A preview whose assumption differs from the written plan's is not the approval of that plan.
  fs.writeFileSync(results, JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', '27-page-error-helper', 'tool-results.json'), 'utf8')), null, 2));
  const preview = path.join(copy, 'approved-plan.md');
  fs.writeFileSync(preview, fs.readFileSync(preview, 'utf8').replace('sorted by name ascending, 50 rows per page.', 'sorted by name ascending, 100 rows per page.'));
  const changed = runRunner(['--fixtures', root, '--eval', '27']);
  assert.equal(changed.code, 1, changed.stdout);
  assert.match(changed.stdout, /the written plan differs from the approved preview: .*A1/);
});

test('runner: fixture 26 grades its answered question, lookup metadata, typed lookup and gate; a copy that drops a declared reference fails with exit 1', (t) => {
  const green = runRunner(['--eval', '26']);
  assert.equal(green.code, 0, green.stdout + green.stderr);
  const graded = [
    'The open account-scope question reaches the maker as needs_input',
    "get-lookup-metadata.js reads opportunity's lookups before approval",
    NEW_CONTRACT,
    "RuntimeTypes.ts is generated for opportunity and types each recorded lookup's read property",
    'The page is generated only after provenance is verified with --require-assumptions --require-observed-lookups',
  ];
  for (const text of graded) {
    const line = green.stdout.split('\n').find((entry) => entry.includes(text));
    assert.ok(line && /^\s*ok \d+ - /.test(line) && !/# SKIP/.test(line), `graded and passing, not skipped: ${line}`);
  }
  const root = mkTempFixturesDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copy = path.join(root, '26-customer-lookup');
  fs.cpSync(path.join(__dirname, '..', 'fixtures', '26-customer-lookup'), copy, { recursive: true });
  const manifestPath = path.join(copy, 'fixture.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const [key, reason] of [['interactions', /does not declare its interactions evidence/], ['lookupMetadata', /does not declare its lookupMetadata evidence/]]) {
    const changed = structuredClone(manifest);
    delete changed.semantics[key];
    fs.writeFileSync(manifestPath, JSON.stringify(changed, null, 2));
    const red = runRunner(['--fixtures', root, '--eval', '26']);
    assert.equal(red.code, 1, `${key}: ${red.stdout}`);
    assert.match(red.stdout, reason);
  }
});
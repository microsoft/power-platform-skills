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
- pac help → PAC CLI Version 2.7.3 (>= 2.7.0 verified)
- pac auth list — active profile, environment https://x.crm.dynamics.com
- AskUserQuestion: new or edit → create new
- Solution selection question SKIPPED (code-only flow)
- EnterPlanMode → approved
## Phase 2 — SKIPPED (mock data)
## Phase 4 — pac model genpage generate-types not run (mock data)
## Phase 5b — single-page fast path, inlined build
- Data mode: mock
- read verified-icons.txt
- read samples/8-dashboard-with-charts.tsx
- icon verification: grep "react-icons", verified icons against verified-icons.txt
## Phase 6
- pac model genpage upload --app-id 1 --code-file p.tsx --prompt "x" --model claude-sonnet --name "p" --agent-message "m" --add-to-sitemap
`,
    'genpage-plan.md': `# Genpage Plan
## User Requirements
foo
## Working Directory
wd/
## Plugin Root
pr/
## Environment
- Solution: Default
- Publisher Prefix: new
## Pages
| Page | File |
| P | p.tsx |
## Entity Creation Required
No entity creation required — all entities already exist.
## Existing Entities
account
## Design Preferences
clean
## Relevant Samples
8-dashboard-with-charts.tsx
## Per-Page Specifications
### P
foo
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

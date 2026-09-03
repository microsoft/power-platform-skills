'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BACKUP_PATH,
  REQUIRED_IMMUTABLE_INPUTS,
  beginDesignRun,
  verifyDesignRun,
} = require('../design-run-ownership');

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-design-ownership-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relativePath of REQUIRED_IMMUTABLE_INPUTS) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relativePath.endsWith('.json')
      ? `${JSON.stringify({ artifact: relativePath, values: [1, 2, 3] }, null, 2)}\n`
      : '# Approved plan\n');
  }
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default null;\n');
  return root;
}

test('automatic design permits only brand, preview, and design evidence writes', (context) => {
  const root = project(context);
  beginDesignRun({
    projectRoot: root,
    now: () => '2026-09-03T00:00:00.000Z',
    runId: () => 'design-run-1',
  });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), 'export const tokens = {};\n');
  fs.writeFileSync(path.join(root, '_plan_preview.html'), '<!doctype html>\n');
  fs.writeFileSync(path.join(root, '.tmp', 'design-run-status.json'), '{}\n');
  const result = verifyDesignRun({ projectRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.writeViolations, []);
  assert.deepEqual(result.immutableMutations, []);
});

test('ICRC design cannot reorder journeys or rewrite scenario evidence', (context) => {
  const root = project(context);
  beginDesignRun({ projectRoot: root });
  const journeyPath = path.join(root, '.tmp', 'workflow-journey-contract.json');
  const scenarioPath = path.join(root, '.tmp', 'scenario-facts.json');
  const journey = JSON.parse(fs.readFileSync(journeyPath, 'utf8'));
  journey.values.reverse();
  fs.writeFileSync(journeyPath, `${JSON.stringify(journey, null, 2)}\n`);
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  scenario.values = ['replacement evidence'];
  fs.writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);

  const result = verifyDesignRun({ projectRoot: root });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.immutableMutations.map((item) => item.path),
    ['.tmp/workflow-journey-contract.json', '.tmp/scenario-facts.json'],
  );
  assert.ok(result.errors.some(
    (error) => error.code === 'design-ownership-immutable-input-mutated',
  ));
  assert.deepEqual(result.restoredFiles, [
    '.tmp/scenario-facts.json',
    '.tmp/workflow-journey-contract.json',
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(journeyPath, 'utf8')).values, [1, 2, 3]);
  assert.deepEqual(JSON.parse(fs.readFileSync(scenarioPath, 'utf8')).values, [1, 2, 3]);
  assert.equal(verifyDesignRun({ projectRoot: root }).ok, true);
});

test('automatic design rejects ad-hoc generators and app writes', (context) => {
  const root = project(context);
  beginDesignRun({ projectRoot: root });
  fs.writeFileSync(path.join(root, '.tmp', 'generate-preview.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default function Home() {}\n');
  const result = verifyDesignRun({ projectRoot: root });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.writeViolations.map((item) => item.path),
    ['.tmp/generate-preview.js', 'app/home.tsx'],
  );
  assert.ok(result.errors.some(
    (error) => error.code === 'design-ownership-write-outside-allowlist',
  ));
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'generate-preview.js')), false);
  assert.equal(
    fs.readFileSync(path.join(root, 'app', 'home.tsx'), 'utf8'),
    'export default null;\n',
  );
});

test('automatic design verification requires a preflight state', (context) => {
  const result = verifyDesignRun({ projectRoot: project(context) });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'design-ownership-state-missing');
});

test('automatic design cannot restamp an active ownership baseline', (context) => {
  const root = project(context);
  beginDesignRun({ projectRoot: root });
  assert.throws(
    () => beginDesignRun({ projectRoot: root }),
    /already active; verify it instead of restamping/,
  );
});

test('automatic design cannot tamper with the ownership recovery backup', (context) => {
  const root = project(context);
  beginDesignRun({ projectRoot: root });
  fs.writeFileSync(
    path.join(root, BACKUP_PATH, 'files', 'native-app-plan.md'),
    '# Tampered backup\n',
  );
  assert.throws(
    () => verifyDesignRun({ projectRoot: root }),
    /design-run backup is missing or invalid: native-app-plan\.md/,
  );
});
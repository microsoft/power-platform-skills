'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', '..', 'skills', 'prototype-to-real-app', 'scripts', 'rebase-prototype-plan.js');

function makeProject(t, contractOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-rebase-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = {
    schemaVersion: 1,
    planningMode: 'prototype',
    executionEligible: false,
    publisherPrefix: 'cr',
    tables: [{
      logicalName: 'cr_inspection',
      schemaName: 'cr_inspection',
      plannedDecision: 'create',
      columns: [
        { logicalName: 'cr_name', schemaName: 'cr_name', type: 'string', plannedDecision: 'create' },
        { logicalName: 'cr_siteid', schemaName: 'cr_siteid', type: 'lookup', lookupTarget: 'cr_site', plannedDecision: 'create' },
      ],
      relationships: [{ schemaName: 'cr_site_inspection', parentTable: 'cr_site', childTable: 'cr_inspection' }],
    }, {
      logicalName: 'cr_site',
      schemaName: 'cr_site',
      plannedDecision: 'create',
      columns: [{ logicalName: 'cr_name', schemaName: 'cr_name', type: 'string', plannedDecision: 'create' }],
    }],
    ...contractOverrides,
  };
  const files = {
    'native-app-plan.md': 'Use `cr_inspection`, `cr_site`, and `cr_siteid`. Do not change cr_unplanned or the word create.\n',
    '.tmp/prototype-plan-artifacts/dataverse-schema-contract.json': `${JSON.stringify(contract, null, 2)}\n`,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return root;
}

function run(root, prefix) {
  return spawnSync(process.execPath, [script, root, prefix], { encoding: 'utf8' });
}

test('rebases only identifiers proven by the archived prototype contract', (t) => {
  const root = makeProject(t);
  const result = run(root, 'cr8142a');
  assert.equal(result.status, 0, result.stderr);

  const plan = fs.readFileSync(path.join(root, 'native-app-plan.md'), 'utf8');
  assert.match(plan, /cr8142a_inspection/);
  assert.match(plan, /cr8142a_siteid/);
  assert.match(plan, /cr_unplanned/);
  assert.doesNotMatch(plan, /`cr_inspection`/);

  const rebased = JSON.parse(fs.readFileSync(path.join(root, '.tmp/prototype-plan-artifacts/rebased-schema-contract.json'), 'utf8'));
  assert.equal(rebased.planningMode, 'prototype-rebased');
  assert.equal(rebased.executionEligible, false);
  assert.equal(rebased.tables[0].logicalName, 'cr8142a_inspection');
  assert.equal(rebased.tables[0].columns[1].lookupTarget, 'cr8142a_site');

  const archived = JSON.parse(fs.readFileSync(path.join(root, '.tmp/prototype-plan-artifacts/dataverse-schema-contract.json'), 'utf8'));
  assert.equal(archived.tables[0].logicalName, 'cr_inspection');
});

test('fails closed for an executable or non-prototype contract', (t) => {
  const root = makeProject(t, { executionEligible: true });
  const result = run(root, 'cr8142a');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a non-executable prototype contract/);
});

test('rejects malformed publisher prefixes', (t) => {
  const root = makeProject(t);
  const result = run(root, 'bad-prefix!');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid publisher prefix/);
});
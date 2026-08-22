'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', 'validate-seed-consistency.js');
const { validateProject } = require(script);

function project(t, rows, columns) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-consistency-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relativePath, value) => {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  };
  write('.tmp/dataverse-schema-contract.json', {
    tables: [{ logicalName: 'cr_orderline', columns }],
  });
  write('src/generated/.prototype-manifest.json', {
    tableSchemas: [{ logicalName: 'cr_orderline', seedFile: 'src/generated/services/Cr_orderline.seed.json' }],
  });
  write('src/generated/services/Cr_orderline.seed.json', rows);
  return root;
}

const arithmeticColumns = [
  { logicalName: 'cr_quantity', type: 'integer' },
  { logicalName: 'cr_unitprice', type: 'money' },
  { logicalName: 'cr_lineamount', type: 'money' },
  { logicalName: 'cr_subtotal', type: 'decimal' },
];

test('accepts arithmetic totals equal to quantity times unit price', (t) => {
  const root = project(t, [
    { cr_quantity: 2, cr_unitprice: 4.25, cr_lineamount: 8.5, cr_subtotal: 8.5 },
    { cr_quantity: 3, cr_unitprice: 10, cr_lineamount: 30, cr_subtotal: 30 },
  ], arithmeticColumns);
  const result = validateProject(root);
  assert.deepEqual(result, { valid: true, findings: [], checkedTables: 1, checkedRows: 2 });
  const cli = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /PASS \(2 rows across 1 arithmetic table/);
});

test('rejects inconsistent stored amounts', (t) => {
  const root = project(t, [
    { cr_quantity: 2, cr_unitprice: 4.25, cr_lineamount: 11, cr_subtotal: 8.5 },
  ], arithmeticColumns);
  const result = validateProject(root);
  assert.equal(result.valid, false);
  assert.match(result.findings.join('\n'), /cr_lineamount is 11, expected 8\.5/);
});

test('does not widen beyond arithmetic component triples', (t) => {
  const root = project(t, [{ cr_amount: 99, cr_status: 1 }], [
    { logicalName: 'cr_amount', type: 'money' },
    { logicalName: 'cr_status', type: 'integer' },
  ]);
  assert.deepEqual(validateProject(root), { valid: true, findings: [], checkedTables: 0, checkedRows: 0 });
});
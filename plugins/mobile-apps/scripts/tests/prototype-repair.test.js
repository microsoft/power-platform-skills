'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repairRoot = path.resolve(__dirname, '../../skills/create-mobile-prototype/harness/repair');
const { applyClassA } = require(path.join(repairRoot, 'ast'));
const core = require(path.join(repairRoot, 'core'));

function project(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app/(app)'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'app.config.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'auth.config.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'app/(app)/home.tsx'), source);
  return root;
}

function finding(root, id, line, actual, expected) {
  return { id, class: 'A', file: path.join(root, 'app/(app)/home.tsx'), line, actual, expected, state: 'OPEN' };
}

test('Class A uses AST-guided transforms and one typecheck with zero model calls', (t) => {
  const root = project(t, `export function Home() {\n  return <View allowFontScaling={false} style={{ marginLeft: 4, backgroundColor: '#fff', fontWeight: '600' }} />;\n}\n`);
  const findings = [
    finding(root, 'static.font-scaling', 2, 'allowFontScaling={false}', 'font scaling enabled'),
    finding(root, 'static.logical-properties', 2, 'marginLeft', 'marginStart'),
    finding(root, 'static.raw-hex', 2, 'backgroundColor: #fff', 'a semantic color token'),
  ];
  let typechecks = 0;
  const result = applyClassA(root, findings, { typecheck: () => { typechecks += 1; return { ok: true }; } });
  const output = fs.readFileSync(path.join(root, 'app/(app)/home.tsx'), 'utf8');
  assert.equal(result.ok, true);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.typecheckRuns, 1);
  assert.equal(typechecks, 1);
  assert.doesNotMatch(output, /allowFontScaling/);
  assert.match(output, /marginStart/);
  assert.match(output, /backgroundColor: "\$surface0"/);
  assert.match(output, /fontWeight: '600'/);
});

test('Class A restores every changed file when typecheck fails', (t) => {
  const source = `export function Home() {\n  return <View allowFontScaling={false} />;\n}\n`;
  const root = project(t, source);
  const result = applyClassA(root, [finding(root, 'static.font-scaling', 2, 'allowFontScaling={false}', 'font scaling enabled')], { typecheck: () => ({ ok: false, output: 'TS2322' }) });
  assert.equal(result.ok, false);
  assert.equal(result.reverted, true);
  assert.equal(result.modelCalls, 0);
  assert.equal(fs.readFileSync(path.join(root, 'app/(app)/home.tsx'), 'utf8'), source);
});

test('Class B packets expose evidence but never check identity', () => {
  const packet = core.evidence({ id: 'layout.overlap', class: 'B', file: 'app/home.tsx', line: 9, actual: 'button overlaps footer', expected: '20px clearance', screenshot: '/tmp/home.png' });
  assert.deepEqual(Object.keys(packet), ['file', 'line', 'actual', 'expected', 'screenshot']);
  assert.equal(JSON.stringify(packet).includes('layout.overlap'), false);
});

test('Class B stops when findings reshape instead of reduce', async () => {
  const initial = [
    { id: 'one', class: 'B', file: 'a.tsx', line: 1, actual: 'a', expected: 'x' },
    { id: 'two', class: 'B', file: 'b.tsx', line: 1, actual: 'b', expected: 'y' },
  ];
  let calls = 0;
  const result = await core.runClassBRounds(initial, async () => { calls += 1; }, async () => [{ id: 'three', class: 'B', file: 'c.tsx', line: 1, actual: 'c', expected: 'z' }]);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'findings-reshaped');
  assert.equal(calls, 1);
});

test('Class B performs at most two reducing repair rounds', async () => {
  const initial = [1, 2, 3].map((number) => ({ id: `same-${number}`, class: 'B', file: 'a.tsx', line: number, actual: `${number}`, expected: 'fixed' }));
  let current = initial;
  let calls = 0;
  const result = await core.runClassBRounds(initial, async () => { calls += 1; current = current.slice(0, -1); }, async () => current);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'round-limit');
  assert.equal(calls, 2);
  assert.equal(result.findings.length, 1);
});

test('unresolved findings emit one deduplicated OPEN panel event', (t) => {
  const root = project(t, 'export function Home() { return null; }\n');
  const unresolved = [{ id: 'layout.one', class: 'B', file: 'app/(app)/home.tsx', line: 1, actual: 'a', expected: 'b', screenshot: '/tmp/home.png' }];
  assert.equal(core.emitOpen(root, unresolved).length, 1);
  assert.equal(core.emitOpen(root, unresolved).length, 0);
  const events = fs.readFileSync(path.join(root, '.mobile-build/events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((event) => event.kind === 'finding' && event.state === 'OPEN').length, 1);
});
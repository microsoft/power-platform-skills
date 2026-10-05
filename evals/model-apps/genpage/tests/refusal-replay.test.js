'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { refusalProblems, discoveryProblems } = require('../lib/workflow-evidence.js');

const root = path.join(__dirname, '..');
const corpus = loadFixtures(path.join(root, 'fixtures'));

test('declared auth and discovery refusals replay green without fabricated pages', () => {
  for (const id of [10, 21]) {
    const fixture = corpus.find((entry) => entry.id === id);
    assert.ok(fixture);
    assert.deepEqual(refusalProblems(fixture), [], fixture.dirName);
    for (const layer of [1, 2]) {
      const replay = spawnSync(process.execPath, [path.join(root, `run-layer-${layer}.js`), '--eval', String(id)], { encoding: 'utf8' });
      assert.equal(replay.status, 0, replay.stdout + replay.stderr);
    }
  }
});

test('an expected refusal cannot hide a successful gate or generated output', (t) => {
  const original = corpus.find((entry) => entry.id === 21);
  for (const changed of [
    { ...original, events: [{ ...original.events[0], result: { ok: true, connections: [], connectionReferences: [] } }] },
    { ...original, files: [{ name: 'page.tsx', content: 'export default GeneratedComponent;' }] },
    { ...original, events: [...original.events, { command: 'node genpage-upload.js --prompt-file prompt.txt', result: { ok: true } }] },
  ]) assert.ok(refusalProblems(changed).length);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-refusal-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dir = path.join(temp, '21-false-refusal');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(original.manifest));
  fs.writeFileSync(path.join(dir, 'tool-results.json'), JSON.stringify([{ ...original.events[0], result: { ok: true, connections: [], connectionReferences: [] } }]));
  fs.writeFileSync(path.join(dir, 'workflow-log.md'), original.workflowLog);
  const replay = spawnSync(process.execPath, [path.join(root, 'run-layer-2.js'), '--fixtures', temp], { encoding: 'utf8' });
  assert.equal(replay.status, 1, replay.stdout);
});

test('discovery distinguishes unreadable output from a genuine empty success and orders ready bindings first', () => {
  const make = (rawOutput, result) => ({
    contractVersion: 2,
    workflowLog: 'needs_input: failed discovery; stopped.',
    events: [{ command: 'node list-connections.js https://contoso.crm.dynamics.com', rawOutput, result, userMessage: result.error }],
  });
  const empty = { ok: true, connections: [], connectionReferences: [] };
  assert.deepEqual(discoveryProblems(make('No connections found.\n', empty)), []);
  for (const raw of ['Warning: failed to retrieve connector metadata.\n', '-----  -----\n', 'Unsupported header\n']) {
    assert.ok(discoveryProblems(make(raw, empty)).length, raw);
  }
  const connectorId = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
  const unready = { connectionId: 'synthetic-unbound', connectorId, readyToBind: false };
  const ready = { connectionId: 'synthetic-bound', connectorId, readyToBind: true };
  assert.deepEqual(discoveryProblems(make(undefined, { ...empty, connections: [ready, unready] })), []);
  assert.ok(discoveryProblems(make(undefined, { ...empty, connections: [unready, ready] })).length);
});

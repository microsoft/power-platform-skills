'use strict';
// Thin wiring test for teardown-model-app.js: the validation gate, dry-run purity, that apply
// threads through to the teardown engine, and the phase-grouped [n/total] log + summary. The
// engine's per-kind behavior is covered exhaustively in sdk-teardown.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { teardownModelApp } = require(path.join(__dirname, '..', 'teardown-model-app.js'));

const desk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8'));

// A request that reports every artifact as present (one id each) so apply performs deletes.
// Stateful for tables so the EntityDefinitions cosmetic-404 flow confirms "gone" on the follow-up
// GET (delete records the logical name; the confirm GET then answers 404 for it).
function presentRequest() {
  const calls = [];
  const deletedTables = new Set();
  const logicalOf = (p) => { const m = p.match(/LogicalName='([^']*)'/); return m && m[1]; };
  const request = async (method, apiPath, body) => {
    calls.push({ method, apiPath, body });
    if (method === 'GET') {
      if (apiPath.startsWith('EntityDefinitions(')) {
        const l = logicalOf(apiPath);
        return deletedTables.has(l) ? { status: 404, data: { error: { message: 'does not exist' } } } : { status: 200, data: { LogicalName: l } };
      }
      return { status: 200, data: { value: [{ appmoduleid: 'id', formid: 'id', appactionid: 'id', webresourceid: 'id', solutionid: 'id' }] } };
    }
    if (method === 'DELETE' && apiPath.startsWith('EntityDefinitions(')) {
      deletedTables.add(logicalOf(apiPath));
      return { status: 404, data: { error: { message: 'cosmetic' } } };
    }
    return { status: 204, data: null };
  };
  return { request, calls };
}
const logCapture = () => { const logs = []; return { log: (m) => logs.push(m), logs }; };

test('rejects an invalid spec before any teardown', async () => {
  const { request, calls } = presentRequest();
  const r = await teardownModelApp({ entities: [] }, { apply: true }, { request });
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length);
  assert.strictEqual(calls.length, 0, 'no Web API calls on a bad spec');
});

test('dry-run returns the plan and never touches the network', async () => {
  const throwing = () => { throw new Error('dry-run must not call the API'); };
  const r = await teardownModelApp(desk, { apply: false }, { request: throwing });
  assert.strictEqual(r.dryRun, true);
  assert.ok(r.plan.some((p) => /app module/.test(p)));
  assert.ok(r.plan.some((p) => /^table /.test(p)));
  assert.ok(r.plan.some((p) => /^solution /.test(p)));
});

test('apply threads through to the engine (deletes issued) and returns ok', async () => {
  const { request, calls } = presentRequest();
  const r = await teardownModelApp(desk, { apply: true }, { request });
  assert.strictEqual(r.ok, true);
  assert.ok(calls.some((c) => c.method === 'DELETE' && /appmodules\(/.test(c.apiPath)));
  assert.ok(calls.some((c) => c.method === 'DELETE' && /EntityDefinitions\(/.test(c.apiPath)));
  assert.ok(calls.some((c) => c.method === 'DELETE' && /solutions\(/.test(c.apiPath)));
});

test('apply emits status-marked [n/total] lines under phase headers + a summary', async () => {
  const { request } = presentRequest();
  const cap = logCapture();
  await teardownModelApp(desk, { apply: true }, { request, log: cap.log });
  const lines = cap.logs.filter((l) => /\[\d+\/\d+\]/.test(l));
  assert.ok(lines.length >= 4);
  const totals = new Set(lines.map((l) => Number(l.match(/\[\d+\/(\d+)\]/)[1])));
  assert.strictEqual(totals.size, 1, 'one consistent total');
  assert.ok(cap.logs.some((l) => /▶ /.test(l)), 'phases grouped under ▶ headers');
  assert.ok(cap.logs.some((l) => /✓/.test(l)), 'deleted steps marked ✓');
  assert.ok(cap.logs.some((l) => /teardown complete — \d+ deleted/.test(l)), 'a closing summary is printed');
});

test('dry-run lists the plan with a ▢ marker and no summary', async () => {
  const throwing = () => { throw new Error('no network'); };
  const cap = logCapture();
  await teardownModelApp(desk, { apply: false }, { request: throwing, log: cap.log });
  assert.ok(cap.logs.some((l) => /\[\d+\/\d+\] ▢ /.test(l)), 'plan items use the ▢ marker');
  assert.ok(!cap.logs.some((l) => /teardown complete/.test(l)), 'no summary on a dry-run');
});

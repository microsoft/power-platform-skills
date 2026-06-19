const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const registry = require(path.join(__dirname, '..', 'steps', 'registry.js'));
const state = require(path.join(__dirname, '..', 'lib', 'run-state.js'));
const { runRegistry } = require(path.join(__dirname, '..', 'lib', 'runner.js'));

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.project-tracker.json'), 'utf8')
);

test('registry lists the 8 ordered steps with run/verify/rollback', () => {
  const ids = registry.map((s) => s.id);
  assert.deepStrictEqual(ids, [
    'data-model', 'publish-entities', 'sample-data', 'views',
    'charts', 'forms', 'app-shell', 'publish',
  ]);
  for (const s of registry) {
    assert.strictEqual(typeof s.run, 'function');
    assert.strictEqual(typeof s.title, 'string');
    assert.strictEqual(typeof s.verify, 'function');
    assert.strictEqual(typeof s.rollback, 'function');
  }
});

test('run-state initializes, writes, and reads back', () => {
  const p = path.join(os.tmpdir(), `run-state-${process.pid}.json`);
  const s = state.initState('r1', 'https://env', 'spec.json');
  s.steps['data-model'] = { status: 'done', created: { entities: { a: 1 } } };
  state.writeState(p, s);
  const back = state.readState(p);
  assert.strictEqual(back.run, 'r1');
  assert.strictEqual(back.steps['data-model'].status, 'done');
  fs.unlinkSync(p);
});

function mockDeps() {
  const events = []; let seq = 0; let formSeq = 0;
  return {
    events,
    runScript: (name, args) => {
      if (name === 'create-record.js') { const b = JSON.parse(args[3] || '[]'); const a = Array.isArray(b) ? b : [b]; return { ok: true, ids: a.map(() => 'rec' + ++seq) }; }
      return { ok: true, logicalName: (args[1] || 'x').toLowerCase(), metadataId: 'm' };
    },
    dv: (method, apiPath) => {
      if (method === 'GET' && String(apiPath).includes('systemforms')) return { status: 200, data: { value: [{ formid: 'F' + ++formSeq, type: 2 }] } };
      if (method === 'GET' && String(apiPath).includes('EntityDefinitions')) { const m = String(apiPath).match(/LogicalName='([^']+)'/); return { status: 200, data: { EntitySetName: (m ? m[1] : 'x') + 's' } }; }
      if (method === 'POST' && apiPath === 'savedqueries') return { status: 204, data: {}, headers: { 'odata-entityid': `savedqueries(SQ${++seq})` } };
      if (method === 'POST' && apiPath === 'savedqueryvisualizations') return { status: 204, data: {}, headers: { 'odata-entityid': `savedqueryvisualizations(SQV${++seq})` } };
      if (method === 'POST' && apiPath === 'appmodules') return { status: 204, data: {}, headers: { 'odata-entityid': 'appmodules(APP1)' } };
      if (method === 'POST' && apiPath === 'sitemaps') return { status: 204, data: {}, headers: { 'odata-entityid': 'sitemaps(SM1)' } };
      return { status: 204, data: {}, headers: {} };
    },
    kernel: (job) => job.kind === 'buildChart' ? { ok: true, datadescription: '<d/>', presentationdescription: '<p/>' } : { ok: true, formxml: '<form/>', fetchxml: '<f/>', layoutxml: '<g/>', sitemapxml: '<s/>' },
    log: () => {},
    emit: (e) => events.push(e),
  };
}

test('--only runs exactly one step and emits start+done', async () => {
  const deps = mockDeps();
  await runRegistry(sample, { env: 'x' }, deps, { created: {} }, null, { only: 'views' });
  const vs = deps.events.filter((e) => e.step === 'views');
  assert.ok(vs.some((e) => e.status === 'start'));
  assert.ok(vs.some((e) => e.status === 'done'));
  assert.ok(!deps.events.some((e) => e.step === 'forms'));
});

test('--from runs from specified step through end, skipping earlier steps', async () => {
  const deps = mockDeps();
  await runRegistry(sample, { env: 'x' }, deps, { created: {} }, null, { from: 'forms' });
  const stepIds = [...new Set(deps.events.map((e) => e.step))];
  assert.ok(stepIds.includes('forms'));
  assert.ok(stepIds.includes('app-shell'));
  assert.ok(!stepIds.includes('data-model'));
  assert.ok(!stepIds.includes('views'));
});

test('--resume skips already-done steps and emits skipped event', async () => {
  const statePath = path.join(os.tmpdir(), `resume-state-${process.pid}.json`);
  try {
    // Seed a state file with 'views' already done.
    const seedState = state.initState('r2', 'x', '');
    seedState.steps['views'] = { status: 'done', created: {} };
    state.writeState(statePath, seedState);

    const deps = mockDeps();
    await runRegistry(sample, { env: 'x' }, deps, { created: {} }, statePath, { resume: true, only: 'views' });
    const skipped = deps.events.filter((e) => e.step === 'views' && e.status === 'skipped');
    assert.ok(skipped.length > 0, 'expected a skipped event for views');
    assert.ok(!deps.events.some((e) => e.step === 'views' && e.status === 'start'), 'views should not have started');
  } finally {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  }
});

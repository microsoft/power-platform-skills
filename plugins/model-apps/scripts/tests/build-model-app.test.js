const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { buildModelApp } = require(path.join(__dirname, '..', 'build-model-app.js'));

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.project-tracker.json'), 'utf8')
);

// A spec with a Choice column + sample data written as LABELS (the builder
// resolves "Active" -> the option's integer value).
function specWithSampleData() {
  const s = JSON.parse(JSON.stringify(sample));
  s.sampleData = {
    new_project: [
      { new_name: 'Apollo', new_budget: 5000, new_status: 'Active' },
      { new_name: 'Gemini', new_budget: 250, new_status: 'New' },
    ],
  };
  return s;
}

// Each recorded dv row is ['dv', method, apiPath, body]. Script rows are
// ['script', name, args]. Log lines are captured separately in `logs`.
function recordingDeps() {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    runScript: (name, args) => {
      calls.push(['script', name, args]);
      if (name === 'create-record.js') {
        const body = JSON.parse(args[3] || '[]');
        return { ok: true, count: Array.isArray(body) ? body.length : 1, ids: [] };
      }
      return { ok: true, logicalName: (args[1] || 'x').toLowerCase(), metadataId: 'mid_' + (args[1] || 'x') };
    },
    dv: (method, apiPath, body) => {
      calls.push(['dv', method, apiPath, body]);
      if (method === 'GET' && String(apiPath).includes('systemforms')) {
        return { status: 200, data: { value: [{ formid: 'F1', type: 2 }] } };
      }
      if (method === 'GET' && String(apiPath).includes('EntityDefinitions')) {
        return { status: 200, data: { EntitySetName: 'new_projects' } };
      }
      if (method === 'POST' && apiPath === 'savedqueries') {
        return { status: 204, data: {}, headers: { 'odata-entityid': 'savedqueries(SQ1)' } };
      }
      if (method === 'POST' && apiPath === 'appmodules') {
        return { status: 204, data: {}, headers: { 'odata-entityid': 'appmodules(APP1)' } };
      }
      if (method === 'POST' && apiPath === 'sitemaps') {
        return { status: 204, data: {}, headers: { 'odata-entityid': 'sitemaps(SM1)' } };
      }
      return { status: 204, data: {}, headers: {} };
    },
    kernel: (job) => {
      calls.push(['kernel', job.kind]);
      return { ok: true, formxml: '<form/>', fetchxml: '<fetch/>', layoutxml: '<grid/>', sitemapxml: '<SiteMap/>' };
    },
    log: (m) => logs.push(m),
  };
}

const dvCalls = (deps) => deps.calls.filter((c) => c[0] === 'dv');
const scriptNames = (deps) => deps.calls.filter((c) => c[0] === 'script').map((c) => c[1]);
const kernelKinds = (deps) => deps.calls.filter((c) => c[0] === 'kernel').map((c) => c[1]);
const stepLines = (deps) => deps.logs.filter((l) => /^\[\d+\/\d+\]/.test(l));
const idxScript = (deps, name) => deps.calls.findIndex((c) => c[0] === 'script' && c[1] === name);
const idxKernel = (deps, kind) => deps.calls.findIndex((c) => c[0] === 'kernel' && c[1] === kind);
const idxDv = (deps, apiPath) => deps.calls.findIndex((c) => c[0] === 'dv' && c[2] === apiPath);

test('dry-run (plan) writes nothing and reports the planned steps', async () => {
  const deps = recordingDeps();
  const r = await buildModelApp(sample, { apply: false, env: 'https://x' }, deps);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(deps.calls.length, 0);
  assert.ok(r.plan.some((p) => p.includes('create-table') && p.includes('new_project')));
  assert.ok(r.plan.some((p) => p.includes('main form')));
});

test('apply creates solution, table, and the two columns via dv-* scripts', async () => {
  const deps = recordingDeps();
  const r = await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  assert.strictEqual(r.ok, true);
  const scripts = scriptNames(deps);
  assert.ok(scripts.includes('create-solution.js'));
  assert.ok(scripts.includes('create-table.js'));
  assert.strictEqual(deps.calls.filter((c) => c[0] === 'script' && c[1] === 'add-column.js').length, 2);
});

test('apply builds the main form and PATCHes the system form', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  assert.ok(kernelKinds(deps).includes('buildForm'));
  const patch = dvCalls(deps).find((c) => c[1] === 'PATCH');
  assert.ok(patch, 'a PATCH was issued');
  assert.ok(String(patch[2]).includes('systemforms(F1)'));
  assert.ok(patch[3] && patch[3].formxml, 'PATCH body carries formxml');
});

test('apply builds + creates a savedquery view for the entity', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  assert.ok(kernelKinds(deps).includes('buildView'));
  const sq = dvCalls(deps).find((c) => c[1] === 'POST' && c[2] === 'savedqueries');
  assert.ok(sq, 'savedqueries POST issued');
  assert.strictEqual(sq[3].returnedtypecode, 'new_project');
  assert.ok(String(sq[3].fetchxml).length > 0);
});

test('apply publishes entities BEFORE building the form (so cells are not stripped)', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  const pubIdx = deps.calls.findIndex((c) => c[0] === 'dv' && c[1] === 'POST' && c[2] === 'PublishXml');
  const formIdx = deps.calls.findIndex((c) => c[0] === 'kernel' && c[1] === 'buildForm');
  assert.ok(pubIdx >= 0, 'PublishXml (entity publish) issued');
  assert.ok(pubIdx < formIdx, 'entity publish happens before buildForm');
});

test('apply + publish builds sitemap, creates appmodule, wires components, and publishes', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, publish: true, env: 'https://x' }, deps);
  assert.ok(kernelKinds(deps).includes('buildSitemap'));
  const app = dvCalls(deps).find((c) => c[1] === 'POST' && c[2] === 'appmodules');
  assert.ok(app && app[3].uniquename, 'appmodule POST with uniquename');
  assert.ok(dvCalls(deps).some((c) => c[1] === 'POST' && c[2] === 'sitemaps' && c[3].sitemapnameunique));
  // AddAppComponents is the UNBOUND action with an AppId + sitemap/form/view (no entity).
  const add = dvCalls(deps).find((c) => c[1] === 'POST' && c[2] === 'AddAppComponents');
  assert.ok(add && add[3].AppId, 'AddAppComponents called with AppId');
  assert.ok(!add[3].Components.some((x) => x['@odata.type'] === 'Microsoft.Dynamics.CRM.entity'), 'no explicit entity component');
  assert.ok(dvCalls(deps).some((c) => c[1] === 'POST' && c[2] === 'PublishAllXml'));
});

test('apply WITHOUT publish does not call PublishAllXml', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  assert.ok(!dvCalls(deps).some((c) => c[2] === 'PublishAllXml'));
});

// --- Sample data (opt-in) -------------------------------------------------

test('apply --sample-data inserts records, resolving choice labels to option ints', async () => {
  const deps = recordingDeps();
  await buildModelApp(specWithSampleData(), { apply: true, sampleData: true, env: 'https://x' }, deps);
  const cr = deps.calls.find((c) => c[0] === 'script' && c[1] === 'create-record.js');
  assert.ok(cr, 'create-record.js called');
  // args = [env, entitySet, '--body', '<json>']
  assert.strictEqual(cr[2][1], 'new_projects', 'uses the resolved entity-set name');
  const body = JSON.parse(cr[2][3]);
  assert.strictEqual(body.length, 2);
  assert.strictEqual(body[0].new_status, 100000001, '"Active" -> 100000001 (option index 1)');
  assert.strictEqual(body[1].new_status, 100000000, '"New" -> 100000000 (option index 0)');
  assert.strictEqual(body[0].new_name, 'Apollo', 'non-choice values pass through unchanged');
  assert.strictEqual(body[0].new_budget, 5000);
});

test('sample data is inserted AFTER entities are published and BEFORE forms', async () => {
  const deps = recordingDeps();
  await buildModelApp(specWithSampleData(), { apply: true, sampleData: true, env: 'https://x' }, deps);
  const pubIdx = idxDv(deps, 'PublishXml');
  const crIdx = idxScript(deps, 'create-record.js');
  const formIdx = idxKernel(deps, 'buildForm');
  assert.ok(pubIdx >= 0 && crIdx >= 0 && formIdx >= 0);
  assert.ok(pubIdx < crIdx, 'sample data after entity publish');
  assert.ok(crIdx < formIdx, 'sample data before form build');
});

test('apply WITHOUT --sample-data never inserts records, even if the spec has sampleData', async () => {
  const deps = recordingDeps();
  await buildModelApp(specWithSampleData(), { apply: true, env: 'https://x' }, deps);
  assert.ok(!deps.calls.some((c) => c[0] === 'script' && c[1] === 'create-record.js'));
});

test('dry-run plan lists the sample-data step when the spec carries sampleData', async () => {
  const r = await buildModelApp(specWithSampleData(), { apply: false, env: 'https://x' }, recordingDeps());
  assert.ok(r.plan.some((p) => /sample record/i.test(p)), 'plan mentions sample records');
});

// --- Live progress --------------------------------------------------------

test('apply emits monotonic [n/total] progress lines that end exactly at total', async () => {
  const deps = recordingDeps();
  await buildModelApp(specWithSampleData(), { apply: true, publish: true, sampleData: true, env: 'https://x' }, deps);
  const lines = stepLines(deps);
  assert.ok(lines.length >= 6, 'several progress lines emitted');
  const parse = (l) => l.match(/^\[(\d+)\/(\d+)\]/).slice(1, 3).map(Number);
  const totals = new Set(lines.map((l) => parse(l)[1]));
  assert.strictEqual(totals.size, 1, 'a single consistent total across all lines');
  const total = [...totals][0];
  const idxs = lines.map((l) => parse(l)[0]);
  assert.deepStrictEqual(idxs, idxs.slice().sort((a, b) => a - b), 'indices are monotonic');
  assert.strictEqual(Math.max(...idxs), total, 'the last step index equals the total');
  assert.strictEqual(idxs[0], 1, 'numbering starts at 1');
});

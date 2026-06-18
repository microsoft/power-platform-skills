const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { buildModelApp } = require(path.join(__dirname, '..', 'build-model-app.js'));

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.project-tracker.json'), 'utf8')
);

// Each recorded dv row is ['dv', method, apiPath, body].
function recordingDeps() {
  const calls = [];
  return {
    calls,
    runScript: (name, args) => {
      calls.push(['script', name, args]);
      return { ok: true, logicalName: (args[1] || 'x').toLowerCase(), metadataId: 'mid_' + (args[1] || 'x') };
    },
    dv: (method, apiPath, body) => {
      calls.push(['dv', method, apiPath, body]);
      if (method === 'GET' && String(apiPath).includes('systemforms')) {
        return { status: 200, data: { value: [{ formid: 'F1', type: 2 }] } };
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
    log: () => undefined,
  };
}

const dvCalls = (deps) => deps.calls.filter((c) => c[0] === 'dv');
const scriptNames = (deps) => deps.calls.filter((c) => c[0] === 'script').map((c) => c[1]);
const kernelKinds = (deps) => deps.calls.filter((c) => c[0] === 'kernel').map((c) => c[1]);

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

test('apply + publish builds sitemap, creates appmodule, and publishes', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, publish: true, env: 'https://x' }, deps);
  assert.ok(kernelKinds(deps).includes('buildSitemap'));
  const app = dvCalls(deps).find((c) => c[1] === 'POST' && c[2] === 'appmodules');
  assert.ok(app && app[3].uniquename, 'appmodule POST with uniquename');
  assert.ok(dvCalls(deps).some((c) => c[1] === 'POST' && c[2] === 'sitemaps'));
  assert.ok(dvCalls(deps).some((c) => c[1] === 'POST' && c[2] === 'PublishAllXml'));
});

test('apply WITHOUT publish does not call PublishAllXml', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  assert.ok(!dvCalls(deps).some((c) => c[2] === 'PublishAllXml'));
});

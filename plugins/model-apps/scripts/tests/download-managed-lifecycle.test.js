'use strict';
// The managed download's restore of declared views and charts end to end, on the strict lifecycle org (helpers/fake-lifecycle-org.js,
// which answers 501 to anything it does not model): a stable build, the CLI's own download main with --include-managed, a complete
// rebuild of what it wrote (every phase, publish and verify included), and a second download. A restored view or chart must cost a
// rebuild nothing a download without them does not cost: the comparison is with the plain download's spec, rebuilt the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, appUniqueName, publishesOf } = require('./helpers/lifecycle-harness.js');
const { main } = require('../download-model-app.js');
const { PREFIX } = require('../lib/managed-bindings.js');

const roots = [];
test.after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });

function stableSpec() {
  return {
    schemaVersion: 2, minimumPluginVersion: '2.21.0', createIdentity: 'stable-v1',
    solution: { uniqueName: 'ContosoReview', displayName: 'Review', publisherPrefix: 'contoso' },
    app: { name: 'Review', uniqueName: 'contoso_review' },
    entities: [{
      schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
      columns: [{ schemaName: 'contoso_kind', displayName: 'Kind', type: 'Choice', options: ['A', 'B'] }],
    }],
    views: [{ entity: 'contoso_item', name: 'Items', reconcile: 'declared', activeOnly: false, columns: ['contoso_name', 'contoso_kind'] }],
    charts: [{ entity: 'contoso_item', name: 'By Kind', chartType: 'Pie', groupBy: 'contoso_kind', reconcile: 'declared' }],
    appShell: { areas: [{ label: 'Work', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
  };
}

// A built app and the CLI's download main over the same org. `gated`: the build's client goes through its publication barrier, as the
// CLI's does — a stable build refuses to create without it.
async function builtLifecycle(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-managed-life-'));
  roots.push(root);
  const org = createLifecycleOrg();
  const harness = createLifecycleHarness(org, root);
  const built = await harness.measure(() => harness.build(spec, { gated: true }));
  assert.equal(built.error, undefined, built.error && built.error.stack);
  assert.equal(built.value.result.ok, true, JSON.stringify(built.value.result.steps || built.value.result));
  const store = path.join(harness.workspaceDir, fs.readdirSync(harness.workspaceDir).find((f) => f.startsWith(PREFIX)));
  let n = 0;
  async function download({ managed }) {
    const out = path.join(root, `download-${n += 1}`);
    let emitted = null;
    const said = [];
    await main({
      argv: ['--env', org.origin, '--app', appUniqueName(spec), '--out', out, ...(managed ? ['--include-managed', '--managed-manifest', store] : [])],
      stderr: { write: (t) => { said.push(String(t)); return true; } }, exit: () => {}, emitResult: (ok, payload) => { emitted = { ok, payload }; },
      preflightAuth: async () => ({ ok: true }), httpClient: harness.client,
    });
    assert.equal(emitted && emitted.ok, true, JSON.stringify(emitted) + said.join(''));
    const text = fs.readFileSync(path.join(out, 'app-spec.json'), 'utf8');
    return { out, text, spec: JSON.parse(text), payload: emitted.payload, said: said.join('') };
  }
  async function rebuild(downloaded) {
    const step = await harness.measure(() => harness.build(downloaded.spec, { appFolder: downloaded.out, gated: true }));
    assert.equal(step.error, undefined, step.error && step.error.stack);
    assert.equal(step.value.result.ok, true, JSON.stringify(step.value.result.steps || step.value.result));
    return step;
  }
  return { org, harness, download, rebuild };
}

const familyWrites = (org, step) => org.requests.slice(step.mark, step.end)
  .flatMap((r) => (r.operations ? r.operations : [r]))
  .filter((r) => r.method !== 'GET' && /savedquer|AddSolutionComponent|solutioncomponent|_association/i.test(r.path));

test('a complete rebuild of a managed download that restored a view and a chart sends what a rebuild of the plain download sends, and nothing to either', async () => {
  const app = await builtLifecycle(stableSpec());
  const managed = await app.download({ managed: true });
  assert.deepEqual(managed.payload.managedViews, { restored: ['contoso_item/Items'], omitted: [] });
  assert.deepEqual(managed.payload.managedCharts, { restored: ['contoso_item/By Kind'], omitted: [] });
  assert.equal(managed.spec.views.length, 1);
  assert.equal(managed.spec.charts.length, 1);

  const restoredRebuild = await app.rebuild(managed);
  assert.deepEqual(familyWrites(app.org, restoredRebuild), [], 'no write to a view, a chart or a solution membership');
  const plain = await app.download({ managed: false });
  assert.deepEqual(plain.spec.views || [], []);
  const plainRebuild = await app.rebuild(plain);
  // The same publishes, in the same order, and the same writes: the restored view and chart add none — no publish of their table
  // above the ones the rest of the app's rebuild sends anyway (its forms, the app).
  assert.deepEqual(publishesOf(app.org, restoredRebuild), publishesOf(app.org, plainRebuild));
  assert.deepEqual(restoredRebuild.writes, plainRebuild.writes);

  const again = await app.download({ managed: true });
  assert.equal(again.text, managed.text, 'a second managed download writes the same spec, byte for byte');
  assert.deepEqual(app.org.unexpected, []);
});

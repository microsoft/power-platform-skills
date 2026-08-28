'use strict';
// `entities[].columns[].visualization` — the App Spec surface over the SDK's per-column grid data
// visualization (preview).
//
// Four layers, because each fails silently in a different way:
//   1. VALIDATION — the enum must mirror the SDK's `ColumnVisualizationType` exactly. A value the
//      SDK does not know throws deep inside the push; catching it here names the column.
//   2. BUILD — the write must happen for columns that ALREADY EXIST, not just freshly created ones.
//      Getting that wrong makes the feature work on the first build and quietly stop on every
//      rebuild, which is the hardest variant to notice.
//   3. DEGRADATION — on an environment without the preview provisioned, Dataverse 404s the
//      `controlconfigurations` set. That must SKIP, not fail the data-model phase.
//   4. VERIFY — reconciliation is by VALUE. An existence-only check would pass a column deployed
//      with the wrong renderer.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { validateAppSpec, COLUMN_VISUALIZATIONS } = require('../lib/app-spec.js');
const { provisionDataModel, isVisualizationUnsupported } = require('../lib/entity-provision.js');
const { verifySpec } = require('../lib/verify-spec.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

function specWith(columns) {
  return {
    solution: { uniqueName: 'CV', displayName: 'CV', publisherPrefix: 'new' },
    app: { name: 'CV App', description: '' },
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns,
    }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
  };
}

const SCORE = { schemaName: 'new_score', displayName: 'Score', type: 'WholeNumber' };

// ---------------------------------------------------------------- 1. validation

test('every visualization the SDK accepts is accepted by the spec', () => {
  for (const v of COLUMN_VISUALIZATIONS) {
    const res = validateAppSpec(specWith([Object.assign({}, SCORE, { visualization: v })]));
    assert.strictEqual(res.errors.filter((e) => /visualization/.test(e)).length, 0, `${v} should validate`);
  }
});

test('the spec enum matches the shipped SDK exactly', () => {
  // The bundle is the authority. Widening the spec without widening the SDK produces a mid-build
  // throw; narrowing it silently drops a renderer an author asked for.
  //
  // Typings are not vendored, so pin against the renderer-id map the bundle actually ships — it is
  // the table `setColumnVisualization` looks the renderer up in:
  //   {RadialDial:"c3d4e5f6-…",LineChart:"a1b2c3d4-…",HeatMap:"e7f8a9b0-…",StarRating:"b5e4c3d2-…"}
  // `None` is not in that map by design: it is the CLEAR verb (delete the config row), not a
  // renderer, so it is added back before comparing.
  const bundle = require('node:fs').readFileSync(BUNDLE, 'utf8');
  const m = /\{RadialDial:"[^"]+",(?:[A-Za-z]+:"[^"]+",?)+\}/.exec(bundle);
  assert.ok(m, 'the renderer-id map must be present in the vendored bundle');
  const sdkRenderers = [...m[0].matchAll(/([A-Za-z]+):"/g)].map((x) => x[1]);
  assert.deepStrictEqual([...COLUMN_VISUALIZATIONS].sort(), ['None', ...sdkRenderers].sort());
});

test('the live-observed "preview absent" error is recognised as a SKIP', () => {
  // Pinned from a REAL failure (see the org scan: the set is missing on 17 of 18 test orgs). The
  // shape is easy to get wrong from first principles — the SDK stamps `code: 'CONNECTION_ERROR'`
  // even though this is a clean server 404, so a predicate keyed off `code` would never fire, and
  // an unprovisioned org would HALT the data-model phase over one optional flourish.
  const err = new Error("HTTP 404 from https://example.crm.dynamics.com/api/data/v9.0/controlconfigurations?$select=name: Resource not found for the segment 'controlconfigurations'.");
  err.code = 'CONNECTION_ERROR';
  err.statusCode = 404;
  assert.strictEqual(isVisualizationUnsupported(err), true);

  // Fail-loud on everything else: a permission error is a real defect, not an absent preview.
  const denied = new Error('Principal lacks prvWriteControlConfiguration');
  denied.statusCode = 403;
  assert.strictEqual(isVisualizationUnsupported(denied), false);

  // A 404 from somewhere else entirely must not be swallowed either.
  const otherFourOhFour = new Error("Resource not found for the segment 'workflows'.");
  otherFourOhFour.statusCode = 404;
  assert.strictEqual(isVisualizationUnsupported(otherFourOhFour), false);
});

test('an unknown visualization is rejected and names the column', () => {
  const res = validateAppSpec(specWith([Object.assign({}, SCORE, { visualization: 'Sparkline' })]));
  const err = res.errors.find((e) => /visualization/.test(e));
  assert.ok(err, 'expected a validation error');
  assert.match(err, /new_score/);
  assert.match(err, /Sparkline/);
});

test('omitting visualization is valid — it is not the same as None', () => {
  const res = validateAppSpec(specWith([SCORE]));
  assert.strictEqual(res.errors.filter((e) => /visualization/.test(e)).length, 0);
});

// ---------------------------------------------------------------- 2/3. build

// Minimal provision harness: entity-provision only needs a table/column surface plus the
// visualization setter, so the mock stays small enough that a behaviour change is obvious.
function provisionHarness(opts = {}) {
  const calls = [];
  const existing = opts.existingColumns || [];
  const sdk = {
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }),
    createColumn: async (e, o) => { calls.push(['createColumn', o.schemaName]); return { logicalName: o.schemaName.toLowerCase() }; },
    createCustomerColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase() }),
    createGlobalOptionSet: async (o) => ({ name: o.name }),
    createRelationship: async (o) => ({ schemaName: o.schemaName }),
    createAlternateKey: async (e, o) => ({ logicalName: o.schemaName.toLowerCase() }),
    insertStatusValue: async () => 100000001,
    updateTable: async () => undefined,
    setColumnVisualization: async (e, c, v) => {
      calls.push(['setColumnVisualization', e, c, v]);
      if (opts.setThrows) throw opts.setThrows;
    },
  };
  const provision = {
    findTables: async () => (opts.tableExists
      ? [{ logicalName: 'new_ticket', entitySetName: 'new_tickets', schemaName: 'new_ticket' }] : []),
    findColumns: async () => existing.map((c) => ({ logicalName: c })),
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    queryRecords: async () => [{ solutionid: 's' }],
  };
  return { sdk, provision, calls };
}

async function runProvision(spec, harness) {
  const steps = [];
  const runner = {
    run: async (phase, label, fn, o = {}) => {
      try {
        const v = await fn();
        steps.push({ phase, label, status: 'ok' });
        return v;
      } catch (err) {
        if (o.skipIf && o.skipIf(err)) { steps.push({ phase, label, status: 'skipped' }); return undefined; }
        throw err;
      }
    },
    skip: (phase, label) => steps.push({ phase, label, status: 'skipped' }),
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  await provisionDataModel({ spec, sdk: harness.sdk, provision: harness.provision, runner, preResolvedLanguageCode: 1033 });
  return steps;
}

test('a visualization is written for a NEWLY CREATED column', async () => {
  const h = provisionHarness();
  await runProvision(specWith([Object.assign({}, SCORE, { visualization: 'StarRating' })]), h);
  assert.deepStrictEqual(
    h.calls.find((c) => c[0] === 'setColumnVisualization'),
    ['setColumnVisualization', 'new_ticket', 'new_score', 'StarRating']);
});

test('a visualization is re-asserted for a column that ALREADY EXISTS', async () => {
  // The rebuild path. `setColumnVisualization` converges (PATCH + prune duplicates), so skipping
  // pre-existing columns would make the renderer stick only on the very first build.
  const h = provisionHarness({ tableExists: true, existingColumns: ['new_score'] });
  await runProvision(specWith([Object.assign({}, SCORE, { visualization: 'RadialDial' })]), h);
  assert.ok(!h.calls.some((c) => c[0] === 'createColumn'), 'column already exists — must not be re-created');
  assert.deepStrictEqual(
    h.calls.find((c) => c[0] === 'setColumnVisualization'),
    ['setColumnVisualization', 'new_ticket', 'new_score', 'RadialDial']);
});

test('columns without a visualization are left alone', async () => {
  const h = provisionHarness();
  await runProvision(specWith([SCORE]), h);
  assert.ok(!h.calls.some((c) => c[0] === 'setColumnVisualization'));
});

test("declaring 'None' still writes — it is how a spec CLEARS a renderer", async () => {
  const h = provisionHarness({ tableExists: true, existingColumns: ['new_score'] });
  await runProvision(specWith([Object.assign({}, SCORE, { visualization: 'None' })]), h);
  assert.deepStrictEqual(
    h.calls.find((c) => c[0] === 'setColumnVisualization'),
    ['setColumnVisualization', 'new_ticket', 'new_score', 'None']);
});

test('a 404 from an environment without the preview SKIPS instead of failing the build', async () => {
  const err = new Error("Resource not found for the segment 'controlconfigurations'.");
  err.statusCode = 404;
  const h = provisionHarness({ setThrows: err });
  const steps = await runProvision(specWith([Object.assign({}, SCORE, { visualization: 'HeatMap' })]), h);
  const step = steps.find((s) => /visualization new_ticket\.new_score/.test(s.label));
  assert.ok(step, 'the visualization step should be reported');
  assert.strictEqual(step.status, 'skipped');
});

test('a non-404 failure still halts the build', async () => {
  // Fail-loud on anything that is not "the preview is absent here": a 403 or a bad column name is a
  // real defect, and swallowing it would ship an app silently missing what the author asked for.
  const err = new Error('Principal lacks prvWriteControlConfiguration');
  err.statusCode = 403;
  const h = provisionHarness({ setThrows: err });
  await assert.rejects(
    () => runProvision(specWith([Object.assign({}, SCORE, { visualization: 'HeatMap' })]), h),
    /prvWriteControlConfiguration/);
});

// ---------------------------------------------------------------- 4. verify

function verifyReader(extra = {}) {
  return Object.assign({
    findTable: async () => ({ logicalName: 'new_ticket' }),
    findColumns: async () => [{ logicalName: 'new_score' }],
    queryRecords: async () => [],
    sitemapXml: async () => '',
  }, extra);
}

test('verify reconciles the visualization by VALUE, not existence', async () => {
  const spec = specWith([Object.assign({}, SCORE, { visualization: 'StarRating' })]);
  const good = await verifySpec(spec, verifyReader({ columnVisualization: async () => 'StarRating' }));
  const okCheck = good.checks.find((c) => c.kind === 'column-visualization');
  assert.ok(okCheck && okCheck.present, 'matching renderer must pass');

  const bad = await verifySpec(spec, verifyReader({ columnVisualization: async () => 'RadialDial' }));
  const badCheck = bad.checks.find((c) => c.kind === 'column-visualization');
  assert.ok(badCheck && !badCheck.present, 'a different deployed renderer must FAIL');
  assert.match(badCheck.detail, /expected 'StarRating', deployed 'RadialDial'/);
});

test('verify skips the check when the environment 404s the preview', async () => {
  const err = new Error("Resource not found for the segment 'controlconfigurations'.");
  err.statusCode = 404;
  const res = await verifySpec(
    specWith([Object.assign({}, SCORE, { visualization: 'StarRating' })]),
    verifyReader({ columnVisualization: async () => { throw err; } }));
  assert.ok(!res.checks.some((c) => c.kind === 'column-visualization'),
    'an unprovisioned environment must not report a divergence the build declined to create');
});

test('verify tolerates a reader that predates the capability', async () => {
  // Most callers build a reader with only the methods they need; an optional preview must never
  // become a TypeError for them.
  const res = await verifySpec(
    specWith([Object.assign({}, SCORE, { visualization: 'StarRating' })]),
    verifyReader());
  assert.ok(!res.checks.some((c) => c.kind === 'column-visualization'));
});

// ---------------------------------------------------------------- real bundle

test('the shipped SDK exposes the visualization surface the build calls', () => {
  // Assert on a real instance: the bundle's factory is `createMakerSdk`, and the class itself is
  // not exported, so a `prototype` check would only ever prove the export shape.
  const os = require('node:os');
  const fs = require('node:fs');
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-surface-'));
  try {
    const sdk = createMakerSdk({
      workspacePath: dir,
      instanceUrl: 'https://contoso.crm.dynamics.com',
      httpClient: {
        get: async () => ({ status: 200, headers: {}, body: { value: [] } }),
        post: async () => ({ status: 204, headers: {}, body: {} }),
        patch: async () => ({ status: 204, headers: {}, body: {} }),
        put: async () => ({ status: 204, headers: {}, body: {} }),
        delete: async () => ({ status: 204, headers: {}, body: {} }),
      },
    });
    assert.strictEqual(typeof sdk.setColumnVisualization, 'function');
    assert.strictEqual(typeof sdk.getColumnVisualization, 'function');
    // Arity is part of the contract: (entityLogicalName, columnLogicalName, visualization).
    // Passing an options object instead — the mistake that made an early probe look like an SDK
    // bug — is exactly what this pins.
    assert.strictEqual(sdk.setColumnVisualization.length, 3);
    assert.strictEqual(sdk.getColumnVisualization.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';
// The batched publish opt-in (SDK `publishArtifacts` + `enrichDefaultViews(…, { publish: false })`).
//
// The SDK measured a PublishXml at ~2-2.5 s even with nothing pending, with parallel ones queueing
// on the server, and the build published every enriched table twice. With `--publish` the build
// now defers the default-view enrichment's publish to its final phase and sends that phase as ONE
// envelope. These tests pin the contract: what goes in the envelope, what happens when the envelope
// fails or is refused, that a deferred enrichment's saves are never left unpublished, and that
// nothing changes without `--publish` or with an SDK that has no `publishArtifacts`. A build that
// halts before its publish phase hands what it still owes to its caller, which publishes it once no
// retry follows (settleOwedPublishes; the CLI side is pinned in build-model-app.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSdkBuild, publishTargets, partialEnrichment, settleOwedPublishes, BuildHalt } = require('../lib/sdk-build.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

// Two tables: Project (with a form, so phase 8 already names it) and Task (no form, view or chart,
// so only its enriched default views can put it in the envelope).
function spec() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoBatch', displayName: 'Contoso Batch', publisherPrefix: 'cnt' },
    app: { name: 'Batch App' },
    entities: [
      { schemaName: 'cnt_project', displayName: 'Project', pluralName: 'Projects', primaryAttribute: { schemaName: 'cnt_name', displayName: 'Name' },
        columns: [{ schemaName: 'cnt_code', displayName: 'Code', type: 'Text' }, { schemaName: 'cnt_budget', displayName: 'Budget', type: 'Decimal' }] },
      { schemaName: 'cnt_task', displayName: 'Task', pluralName: 'Tasks', primaryAttribute: { schemaName: 'cnt_name', displayName: 'Name' },
        columns: [{ schemaName: 'cnt_due', displayName: 'Due', type: 'DateTime' }, { schemaName: 'cnt_hours', displayName: 'Hours', type: 'Integer' }] },
    ],
    forms: [{ entity: 'cnt_project', name: 'Project', formType: 'Main' }],
    appShell: { areas: [{ label: 'Work', groups: [{ label: 'Items', subAreas: [{ entity: 'cnt_project' }, { entity: 'cnt_task' }] }] }] },
  };
}

// The simple mock, recording publishes, with the new SDK surface: a deferred enrichment returns the
// publish it owes, and `publishArtifacts` answers one result per input.
function batchSdk({ envelope = (targets) => targets.map(({ type, id }) => ({ type, id, shipped: true, publish: { kind: 'verified' } })), withBatch = true } = {}) {
  const { sdk, calls } = makeSimpleMockSdk();
  // The simple mock answers every query with a publisher row, which the form lookup would read as an
  // existing (id-less) form; a fresh org has none of this spec's forms.
  const query = sdk.queryRecords;
  sdk.queryRecords = async (entity, ...rest) => (entity === 'systemform' ? [] : query(entity, ...rest));
  sdk.enrichDefaultViews = async (logical, cols, opts = {}) => {
    calls.push(['enrichDefaultViews', logical, opts]);
    const updated = [`defview-${logical}`];
    if (opts.publish !== false) return { updated };
    return { updated, results: [], pendingPublish: [{ scope: { envelope: 'entity', entityLogicalName: logical }, artifacts: [{ type: 'view', id: `defview-${logical}` }] }] };
  };
  sdk.publishArtifact = async (type, id) => { calls.push(['publishArtifact', type, id]); return { type, id, shipped: true, publish: { kind: 'verified' } }; };
  if (withBatch) sdk.publishArtifacts = async (targets) => { calls.push(['publishArtifacts', targets]); return envelope(targets); };
  return { sdk, calls };
}

const named = (calls, name) => calls.filter((c) => c[0] === name);

test('with --publish, the enrichment defers its publish and the final phase sends one envelope', async () => {
  const { sdk, calls } = batchSdk();
  const warnings = [];
  await runSdkBuild(spec(), { sdk, apply: true, publish: true, warn: (w) => warnings.push(w) });
  const enrich = named(calls, 'enrichDefaultViews');
  assert.equal(enrich.length, 2, 'both tables are enriched');
  for (const call of enrich) assert.equal(call[2].publish, false, `${call[1]}: the enrichment's publish is deferred`);
  const batches = named(calls, 'publishArtifacts');
  assert.equal(batches.length, 1, 'one envelope');
  const targets = batches[0][1];
  assert.deepEqual(targets.map((t) => t.type), ['form', 'view', 'app'], JSON.stringify(targets));
  assert.equal(targets[1].id, 'defview-cnt_task', 'the table only its default views name is published through the view that owes it');
  assert.equal(targets[2].type, 'app', 'the app rides last in the same envelope');
  assert.equal(named(calls, 'publishArtifact').length, 0, 'no per-target publish when the envelope succeeds');
  assert.deepEqual(warnings.filter((w) => /publish/i.test(w)), []);
});

test('without --publish nothing is deferred and nothing is published', async () => {
  const { sdk, calls } = batchSdk();
  await runSdkBuild(spec(), { sdk, apply: true, publish: false });
  const enrich = named(calls, 'enrichDefaultViews');
  assert.equal(enrich.length, 2);
  for (const call of enrich) assert.notEqual(call[2].publish, false, 'the SDK publishes the enrichment itself');
  assert.equal(named(calls, 'publishArtifacts').length, 0);
  assert.equal(named(calls, 'publishArtifact').length, 0);
});

test('an SDK without publishArtifacts publishes per target, entities before the app', async () => {
  const { sdk, calls } = batchSdk({ withBatch: false });
  await runSdkBuild(spec(), { sdk, apply: true, publish: true });
  const singles = named(calls, 'publishArtifact').map((c) => `${c[1]} ${c[2]}`);
  assert.equal(singles.length, 3, singles.join(', '));
  assert.ok(singles.includes('view defview-cnt_task'), 'the owed table is still published');
  assert.match(singles[singles.length - 1], /^app /, 'the app goes last');
});

test('a failed envelope publishes each failed target again on its own', async () => {
  const failing = (targets) => targets.map(({ type, id }, i) => (i === 0
    ? { type, id, shipped: true, publish: { kind: 'verified' } }
    : { type, id, shipped: false, publish: { kind: 'failed', error: new Error('envelope 400') } }));
  const { sdk, calls } = batchSdk({ envelope: failing });
  const warnings = [];
  await runSdkBuild(spec(), { sdk, apply: true, publish: true, warn: (w) => warnings.push(w) });
  const retried = named(calls, 'publishArtifact').map((c) => `${c[1]} ${c[2]}`);
  assert.equal(retried.length, 2, retried.join(', '));
  assert.ok(retried.includes('view defview-cnt_task'));
  assert.ok(retried.some((r) => r.startsWith('app ')));
  assert.deepEqual(warnings.filter((w) => /FAILED/.test(w)), [], 'the shared envelope error is not reported for targets that then published');
});

test('a refused envelope falls back to the per-target path unchanged', async () => {
  const { sdk, calls } = batchSdk({ envelope: () => { throw new Error('ARTIFACT_NOT_FOUND: view/x not in workspace'); } });
  await runSdkBuild(spec(), { sdk, apply: true, publish: true });
  assert.equal(named(calls, 'publishArtifacts').length, 1);
  const singles = named(calls, 'publishArtifact').map((c) => c[1]);
  assert.deepEqual(singles, ['form', 'view', 'app']);
});

const failure = (promise) => promise.then(() => assert.fail('the build was expected to halt'), (e) => e);
const owedView = (logical) => ['view', `defview-${logical}`];

test('a deferred enrichment that fails part-way halts, and the halt carries every publish still owed', async () => {
  const PARTIAL = Symbol.for('cds-maker-sdk.partialDefaultViewEnrichment');
  const record = { updated: ['defview-cnt_task'], results: [], pendingPublish: [{ scope: { envelope: 'entity', entityLogicalName: 'cnt_task' }, artifacts: [{ type: 'view', id: 'defview-cnt_task' }] }] };
  // The SDK attaches the record to the error it throws; it may be wrapped, so the cause chain is read.
  const inner = Object.assign(new Error('second view push failed'), { [PARTIAL]: record });
  assert.equal(partialEnrichment(inner), record);
  assert.equal(partialEnrichment(new Error('outer', { cause: inner })), record);
  assert.equal(partialEnrichment(new Error('no record')), undefined);
  assert.equal(partialEnrichment(undefined), undefined);

  const { sdk, calls } = batchSdk();
  const enrich = sdk.enrichDefaultViews;
  sdk.enrichDefaultViews = async (logical, cols, opts) => {
    if (logical === 'cnt_task') { calls.push(['enrichDefaultViews', logical, opts]); throw new Error('wrapped', { cause: inner }); }
    return enrich(logical, cols, opts);
  };
  const steps = [];
  const halt = await failure(runSdkBuild(spec(), { sdk, apply: true, publish: true, emit: (e) => steps.push(e) }));
  assert.ok(halt instanceof BuildHalt && halt.phase === 'views', String(halt));
  assert.ok(steps.some((e) => e.status === 'error' && /enrich default views for cnt_task/.test(e.label || '')), 'the failed step is reported');
  // The build itself publishes nothing on a halt: only its caller knows whether a retry follows.
  assert.equal(named(calls, 'publishArtifacts').length + named(calls, 'publishArtifact').length, 0);
  assert.deepEqual(halt.owedPublishes, [owedView('cnt_project'), owedView('cnt_task')], 'the table enriched before the failure, and what the failed call had saved');
  assert.equal(Object.keys(halt).includes('owedPublishes'), false, 'it rides along, never into a serialized error');
  assert.equal(halt.owedPaid, false, 'no publish phase ran');
  assert.equal(Object.keys(halt).includes('owedPaid'), false);

  const warnings = [];
  await settleOwedPublishes(sdk, halt.owedPublishes, (w) => warnings.push(w));
  const batches = named(calls, 'publishArtifacts');
  assert.equal(batches.length, 1, 'one envelope');
  assert.deepEqual(batches[0][1], [{ type: 'view', id: 'defview-cnt_project' }, { type: 'view', id: 'defview-cnt_task' }]);
  assert.deepEqual(warnings, []);
});

test('a default-view push refused by value (a concurrent edit) fails the enrichment step; what was saved stays owed', async () => {
  const { sdk, calls } = batchSdk();
  const enrich = sdk.enrichDefaultViews;
  sdk.enrichDefaultViews = async (logical, cols, opts) => {
    if (logical !== 'cnt_task') return enrich(logical, cols, opts);
    calls.push(['enrichDefaultViews', logical, opts]);
    // The SDK RESOLVES a 412 as saved:false; the table's other default view saved.
    return {
      updated: ['defview-cnt_task-active'],
      results: [
        { type: 'view', id: 'defview-cnt_task-active', saved: true, shipped: false, publish: { kind: 'notRequested' } },
        { type: 'view', id: 'defview-cnt_task-inactive', saved: false, shipped: false, publish: { kind: 'notRequested' }, error: Object.assign(new Error('Version conflict for view/defview-cnt_task-inactive'), { code: 'VERSION_CONFLICT' }) },
      ],
      pendingPublish: [{ scope: { envelope: 'entity', entityLogicalName: 'cnt_task' }, artifacts: [{ type: 'view', id: 'defview-cnt_task-active' }] }],
    };
  };
  const halt = await failure(runSdkBuild(spec(), { sdk, apply: true, publish: true }));
  assert.ok(halt instanceof BuildHalt && halt.phase === 'views' && halt.code === 'version-conflict', `${halt.code}: ${halt.message}`);
  assert.match(halt.message, /default view defview-cnt_task-inactive of cnt_task/);
  assert.deepEqual(halt.owedPublishes, [owedView('cnt_project'), ['view', 'defview-cnt_task-active']], 'the saved view still owes its publish');
  assert.equal(halt.owedPaid, false);
  assert.equal(named(calls, 'publishArtifacts').length + named(calls, 'publishArtifact').length, 0);
});

test('a later phase that halts hands every enriched table to the caller: nothing it saved is lost', async () => {
  // Before the publish was batched, each table's enrichment published itself, so a build stopped by
  // a later phase left those tables live.
  const { sdk, calls } = batchSdk();
  const create = sdk.createArtifact;
  sdk.createArtifact = (type, def) => { if (type === 'app') throw new Error('app create refused'); return create(type, def); };
  const halt = await failure(runSdkBuild(spec(), { sdk, apply: true, publish: true }));
  assert.ok(halt instanceof BuildHalt && halt.phase === 'app-shell', String(halt));
  assert.equal(named(calls, 'publishArtifacts').length + named(calls, 'publishArtifact').length, 0);
  assert.deepEqual(halt.owedPublishes, [owedView('cnt_project'), owedView('cnt_task')]);
  assert.equal(halt.owedPaid, false);
  await settleOwedPublishes(sdk, halt.owedPublishes, () => {});
  assert.deepEqual(named(calls, 'publishArtifacts').map((c) => c[1].map((t) => t.id)), [['defview-cnt_project', 'defview-cnt_task']]);
});

test('a halt inside the publish phase still owes; once that phase has run, a later halt owes nothing', async () => {
  // Inside: the envelope and every per-target publish throw, so the phase halts having paid nothing.
  const inside = batchSdk({ envelope: () => { throw new Error('envelope refused'); } });
  inside.sdk.publishArtifact = async () => { throw new Error('publish down'); };
  const halted = await failure(runSdkBuild(spec(), { sdk: inside.sdk, apply: true, publish: true }));
  assert.ok(halted instanceof BuildHalt && halted.phase === 'publish', String(halted));
  assert.deepEqual(halted.owedPublishes, [owedView('cnt_project'), owedView('cnt_task')]);
  assert.equal(halted.owedPaid, false, 'a publish phase that halts has paid nothing');

  // After: the AI re-confirmation runs after the publish phase; an event it emits fails the build.
  const after = batchSdk();
  after.sdk.setAppAiFeatures = async () => ({ applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [] });
  let published = false;
  const emit = (e) => {
    if (e.phase === 'publish' && e.status === 'ok') published = true;
    if (published && e.phase === 'ai-features') throw new Error('late failure');
  };
  const late = await failure(runSdkBuild({ ...spec(), ai: { appFeatures: { formFill: true } } }, { sdk: after.sdk, apply: true, publish: true, emit }));
  assert.match(String(late && late.message), /late failure/);
  assert.equal(named(after.calls, 'publishArtifacts').length, 1, 'the publish phase ran and paid');
  assert.deepEqual(late.owedPublishes, [], 'nothing more is owed');
  // …and the CLI reads `owedPaid` as "an earlier attempt's debt is paid too": every attempt enriches the
  // same tables, and this one's publish phase published them.
  assert.equal(late.owedPaid, true);
});

test('settleOwedPublishes: nothing owed is a no-op, and one target that cannot be published keeps no other back', async () => {
  const calls = [];
  // A's publish throws, B's succeeds.
  const publishOne = async (type, id) => {
    calls.push(`publishArtifact ${id}`);
    if (id === 'defview-a') throw new Error('publish down');
    return { type, id, shipped: true, publish: { kind: 'verified' } };
  };
  const refused = { publishArtifacts: async () => { calls.push('publishArtifacts'); throw new Error('envelope refused'); }, publishArtifact: publishOne };
  for (const nothing of [[], undefined, null, [['view']], 'defview-a']) await settleOwedPublishes(refused, nothing, () => assert.fail('no warning'));
  await settleOwedPublishes(null, [owedView('a')], () => assert.fail('no warning'));
  assert.deepEqual(calls, []);

  // A refused envelope falls back to one publish per target; A throwing does not stop B.
  const warnings = [];
  await settleOwedPublishes(refused, [owedView('a'), owedView('b')], (w) => warnings.push(w));
  assert.deepEqual(calls, ['publishArtifacts', 'publishArtifact defview-a', 'publishArtifact defview-b']);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /^the build stopped before its publish phase; publish view defview-a FAILED: publish down — the change is SAVED/);

  // A failed envelope: each target is published again on its own, and again A throwing does not stop B.
  calls.length = 0;
  warnings.length = 0;
  const failed = {
    publishArtifacts: async (targets) => { calls.push('publishArtifacts'); return targets.map(({ type, id }) => ({ type, id, shipped: false, publish: { kind: 'failed', error: new Error('envelope 400') } })); },
    publishArtifact: publishOne,
  };
  await settleOwedPublishes(failed, [owedView('a'), owedView('b')], (w) => warnings.push(w));
  assert.deepEqual(calls, ['publishArtifacts', 'publishArtifact defview-a', 'publishArtifact defview-b']);
  assert.equal(warnings.length, 1, warnings.join('\n'));

  // Without a warn callback it still never throws.
  await settleOwedPublishes(refused, [owedView('a')]);
});

test('publishTargets in the publish phase still halts on a thrown per-target publish, as it always did', async () => {
  const provision = { publishArtifact: async () => { throw new Error('publish down'); } };
  const runner = { mapLimit: async (items, n, fn) => Promise.all(items.map(fn)) };
  await assert.rejects(publishTargets(provision, runner, 2, [['form', 'f1']], null, () => {}), /publish down/);
});

test('publishTargets: a single target and an empty list never use the envelope', async () => {
  const calls = [];
  const provision = {
    publishArtifacts: async (t) => { calls.push(['publishArtifacts', t]); return []; },
    publishArtifact: async (type, id) => { calls.push(['publishArtifact', type, id]); return { type, id, publish: { kind: 'verified' } }; },
  };
  const runner = { mapLimit: async (items, n, fn) => Promise.all(items.map(fn)) };
  await publishTargets(provision, runner, 2, [['form', 'f1']], null, () => {});
  assert.deepEqual(calls, [['publishArtifact', 'form', 'f1']]);
  calls.length = 0;
  await publishTargets(provision, runner, 2, [], null, () => {});
  assert.deepEqual(calls, []);
  // A result list of the wrong length is not trusted: every target is published on its own.
  await publishTargets(provision, runner, 2, [['form', 'f1'], ['view', 'v1']], ['app', 'a1', 'app One'], () => {});
  assert.deepEqual(calls.map((c) => c[0]), ['publishArtifacts', 'publishArtifact', 'publishArtifact', 'publishArtifact']);
});

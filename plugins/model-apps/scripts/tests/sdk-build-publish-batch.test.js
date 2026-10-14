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
const { runSdkBuild, publishTargets, partialEnrichment, settleOwedPublishes, collectOwedPublishes, BuildHalt } = require('../lib/sdk-build.js');
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
// A target as a caller hands it to settleOwedPublishes: just the artifact that stands for its table.
const owedView = (logical) => ['view', `defview-${logical}`];
// The same target as a halted build carries it: the artifact the SDK reported as saved but not published, and the name
// of what it covers, which a failed publish then says (publishTargets).
const savedDefaults = (logical, id = `defview-${logical}`) => ['view', id, [`default views of ${logical}`]];

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
  assert.deepEqual(halt.owedPublishes, [savedDefaults('cnt_project'), savedDefaults('cnt_task')], 'the table enriched before the failure, and what the failed call had saved');
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
  assert.deepEqual(halt.owedPublishes, [savedDefaults('cnt_project'), savedDefaults('cnt_task', 'defview-cnt_task-active')], 'the saved view still owes its publish');
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
  assert.deepEqual(halt.owedPublishes, [savedDefaults('cnt_project'), savedDefaults('cnt_task')]);
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
  assert.deepEqual(halted.owedPublishes, [savedDefaults('cnt_project'), savedDefaults('cnt_task')]);
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

// `publishTargets` tells the publish phase whether the app's OWN publish went through, because an AI override saved in
// the app's unpublished layer is in force once the app is published (and only then). The batched branch is the one a
// build takes whenever tables and the app publish together, so it answers for itself.
test('publishTargets reports whether the app\u2019s own publish went through, in the envelope or on its own', async () => {
  const runner = { mapLimit: async (items, n, fn) => Promise.all(items.map(fn)) };
  const publishOf = (kind) => (kind === 'failed' ? { kind, error: new Error('publish refused') } : kind === 'unverifiable' ? { kind, reason: 'the published copy was not read back' } : { kind });
  const outcome = (type, id, kind) => ({ type, id, shipped: kind === 'verified', publish: publishOf(kind) });
  // `envelope`: what the one envelope answers for [form, app]; `single`: what a publish on its own answers, by type.
  const run = async ({ envelope, single = {}, entities = [['form', 'f1']], app = ['app', 'a1', 'app One'] }) => {
    const provision = {
      publishArtifacts: async (targets) => targets.map(({ type, id }, i) => outcome(type, id, envelope[i])),
      publishArtifact: async (type, id) => outcome(type, id, single[type] || 'verified'),
    };
    return (await publishTargets(provision, runner, 2, entities, app, () => {})).appPublished;
  };
  assert.equal(await run({ envelope: ['verified', 'verified'] }), true);
  assert.equal(await run({ envelope: ['verified', 'unverifiable'] }), true, 'PublishXml answered; only the read-back was not possible');
  assert.equal(await run({ envelope: ['verified', 'failed'] }), true, 'failed in the envelope, published on its own');
  assert.equal(await run({ envelope: ['verified', 'failed'], single: { app: 'unverifiable' } }), true);
  assert.equal(await run({ envelope: ['verified', 'failed'], single: { app: 'failed' } }), false, 'failed in the envelope and again on its own');
  assert.equal(await run({ envelope: ['failed', 'verified'], single: { form: 'failed' } }), true, 'another target\u2019s failure says nothing about the app');
  assert.equal(await run({ envelope: ['verified', 'notRequested'] }), false, 'an outcome that says nothing about publishing proves nothing');
  assert.equal(await run({ envelope: ['verified', 'verified'], app: null }), false, 'no app target, no app publish');
  assert.equal(await run({ envelope: ['verified', 'verified', 'verified'], entities: [['form', 'f1'], ['view', 'v1']] }), true, 'the app\u2019s own entry is the one that counts, wherever it sits in the envelope');
});

test('publishTargets: a refused envelope falls back to per-target publishes, and the app\u2019s own decides', async () => {
  const runner = { mapLimit: async (items, n, fn) => Promise.all(items.map(fn)) };
  const run = async (appKind) => (await publishTargets({
    publishArtifacts: async () => { throw new Error('ARTIFACT_NOT_FOUND: view/x not in workspace'); },
    publishArtifact: async (type, id) => ({ type, id, publish: type === 'app' && appKind === 'failed' ? { kind: 'failed', error: new Error('refused') } : { kind: appKind === 'unverifiable' && type === 'app' ? 'unverifiable' : 'verified' } }),
  }, runner, 2, [['form', 'f1']], ['app', 'a1', 'app One'], () => {})).appPublished;
  assert.equal(await run('verified'), true);
  assert.equal(await run('unverifiable'), true);
  assert.equal(await run('failed'), false);
});

// `failed` names the TABLE targets whose last publish the SDK refused by value — the ones whose saved changes are not live.
// The build halts on one before it writes the app (publishReconciledTables), so a table the envelope refused but its own
// publish then took must not be in it, nor the app's own failure, nor an outcome that is not a refusal.
test('publishTargets names each table whose publish stayed refused, in the envelope and on its own, and nothing else', async () => {
  const runner = { mapLimit: async (items, n, fn) => Promise.all(items.map(fn)) };
  const refused = new Error('PublishXml refused');
  const outcome = (type, id, kind) => ({ type, id, publish: kind === 'failed' ? { kind, error: refused } : { kind } });
  const failedOf = async ({ envelope, single = {}, batch = true }) => (await publishTargets({
    ...(batch ? { publishArtifacts: async (targets) => targets.map(({ type, id }, i) => outcome(type, id, envelope[i])) } : {}),
    publishArtifact: async (type, id) => outcome(type, id, single[type] || 'submitted'),
  }, runner, 2, [['form', 'f1', ['form Ticket']], ['view', 'v1']], ['app', 'a1', 'app One'], () => {})).failed;
  assert.deepEqual(await failedOf({ envelope: ['submitted', 'submitted', 'submitted'] }), []);
  assert.deepEqual(await failedOf({ envelope: ['failed', 'submitted', 'submitted'] }), [], 'refused in the envelope, taken on its own');
  assert.deepEqual(await failedOf({ envelope: ['failed', 'submitted', 'submitted'], single: { form: 'failed' } }), [{ target: ['form', 'f1', ['form Ticket']], error: refused }]);
  assert.deepEqual(await failedOf({ envelope: ['submitted', 'submitted', 'failed'], single: { app: 'failed' } }), [], 'the app is no table');
  assert.deepEqual(await failedOf({ envelope: ['submitted', 'unverifiable', 'submitted'] }), [], 'unconfirmed is not refused');
  assert.deepEqual(await failedOf({ batch: false, single: { view: 'failed' } }), [{ target: ['view', 'v1'], error: refused }], 'one table at a time');
});

// The same fixture with an AI override that the SDK saved but could not yet publish — the case the report is for. The
// override row reads as present only once an app publish has really gone through, as on a live environment.
function aiBatchSdk({ envelope, single } = {}) {
  const state = { inForce: false };
  const { sdk, calls } = batchSdk({
    envelope: (targets) => {
      const out = envelope ? envelope(targets) : targets.map(({ type, id }) => ({ type, id, shipped: true, publish: { kind: 'verified' } }));
      out.forEach((o, i) => { if (targets[i].type === 'app' && o.publish.kind !== 'failed') state.inForce = true; });
      return out;
    },
  });
  sdk.publishArtifact = async (type, id) => {
    calls.push(['publishArtifact', type, id]);
    const publish = single ? single(type) : { kind: 'verified' };
    if (type === 'app' && publish.kind !== 'failed') state.inForce = true;
    return { type, id, shipped: publish.kind === 'verified', publish };
  };
  const fetched = sdk.fetchArtifact;
  sdk.fetchArtifact = async (type, id, ...rest) => { calls.push(['fetchArtifact', type, id]); return fetched(type, id, ...rest); };
  const query = sdk.queryRecords;
  sdk.queryRecords = async (entity, ...rest) => {
    if (entity === 'appmodule') return [{ appmoduleid: 'APPID' }];
    if (entity === 'settingdefinition') return [{ settingdefinitionid: 'DEFID' }];
    if (entity === 'appsetting') return state.inForce ? [{ value: '2' }] : [];
    return query(entity, ...rest);
  };
  sdk.setAppAiFeatures = async (appUnique, flags) => {
    calls.push(['setAppAiFeatures', appUnique, flags]);
    return { applied: ['formFill'], skipped: [], notPersisted: [], unverified: [], failed: [], outcomes: [{ feature: 'formFill', status: 'applied', appOverrideExists: true, pendingPublish: true }] };
  };
  return { sdk, calls };
}
const aiSpec = () => ({ ...spec(), ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
const aiWarnings = (events) => events.filter((e) => e.phase === 'ai-features' && e.status === 'skip').map((e) => e.label);
const appPublishes = (calls) => named(calls, 'publishArtifact').filter((c) => c[1] === 'app');

test('with --publish, an app the envelope published is not published again for a saved AI override: it is only proved', async () => {
  const { sdk, calls } = aiBatchSdk();
  const events = [];
  const r = await runSdkBuild(aiSpec(), { sdk, apply: true, publish: true, emit: (e) => events.push(e) });
  assert.equal(named(calls, 'publishArtifacts').length, 1, 'one envelope');
  assert.equal(appPublishes(calls).length, 0, 'the app rode in the envelope; nothing publishes it again');
  assert.equal(named(calls, 'fetchArtifact').filter((c) => c[1] === 'app').length, 0, 'and it is not fetched for a retry');
  assert.equal(named(calls, 'setAppAiFeatures').length, 1, 'nor is the override written again');
  assert.deepEqual(r.created.ai.appFeatures.applied, ['formFill']);
  assert.deepEqual(aiWarnings(events), []);
});

test('with --publish, an app the envelope could not publish is published again for a saved AI override, and the result is the proof\u2019s', async () => {
  const failedApp = { kind: 'failed', error: new Error('publish refused') };
  const { sdk, calls } = aiBatchSdk({
    envelope: (targets) => targets.map(({ type, id }) => (type === 'app'
      ? { type, id, shipped: false, publish: failedApp }
      : { type, id, shipped: true, publish: { kind: 'verified' } })),
    single: (type) => (type === 'app' ? failedApp : { kind: 'verified' }),
  });
  const events = [];
  const r = await runSdkBuild(aiSpec(), { sdk, apply: true, publish: true, emit: (e) => events.push(e), warn: () => {}, proofDelayMs: 0 });
  assert.equal(appPublishes(calls).length, 2, 'on its own after the envelope, and once more for the override');
  assert.equal(named(calls, 'setAppAiFeatures').length, 1, 'publishing is what a saved override needs; it is not written again');
  assert.ok(aiWarnings(events).some((l) => /NOT YET PUBLISHED: formFill/.test(l)), JSON.stringify(aiWarnings(events)));
  assert.ok(!r.created.ai.appFeatures.applied.includes('formFill'));
});

test('with --publish, an app the envelope could not publish but its own publish then did is not published a third time', async () => {
  const { sdk, calls } = aiBatchSdk({
    envelope: (targets) => targets.map(({ type, id }) => (type === 'app'
      ? { type, id, shipped: false, publish: { kind: 'failed', error: new Error('envelope 400') } }
      : { type, id, shipped: true, publish: { kind: 'verified' } })),
  });
  const r = await runSdkBuild(aiSpec(), { sdk, apply: true, publish: true });
  assert.equal(appPublishes(calls).length, 1, 'the retry on its own is the app\u2019s publish; the override needs no other');
  assert.deepEqual(r.created.ai.appFeatures.applied, ['formFill']);
});

// A target is `[type, id]` plus, optionally, what it is for: the names of the saved views and forms deferred onto its
// table, or the app's label. A line about a publish that failed or could not be confirmed says that, not `form <guid>`.
test('publishTargets names what a target is for in every line it prints, and falls back to `type id` for one that is not named', async () => {
  const runner = { mapLimit: async (items, n, fn) => Promise.all(items.map(fn)) };
  const down = (type, id) => ({ type, id, shipped: false, publish: { kind: 'failed', error: new Error('PublishXml 500') } });
  const targets = [['form', 'f1', ['view Open Tickets', 'form Ticket']], ['view', 'v2']];

  // One envelope that fails, then each failed target alone (which fails again).
  const warnings = [];
  await publishTargets({ publishArtifacts: async (t) => t.map(({ type, id }) => down(type, id)), publishArtifact: async (type, id) => down(type, id) }, runner, 2, targets, ['app', 'a1', 'app One'], (w) => warnings.push(w));
  assert.deepEqual(warnings.map((w) => w.replace(/ FAILED:.*/, '')), ['publish view Open Tickets, form Ticket', 'publish view v2', 'publish app One']);

  // Without an envelope each target is published alone, and named the same way.
  warnings.length = 0;
  await publishTargets({ publishArtifact: async (type, id) => down(type, id) }, runner, 2, targets, null, (w) => warnings.push(w));
  assert.deepEqual(warnings.map((w) => w.replace(/ FAILED:.*/, '')), ['publish view Open Tickets, form Ticket', 'publish view v2']);

  // A publish that cannot be CONFIRMED is named too.
  warnings.length = 0;
  const unverifiable = (type, id) => ({ type, id, shipped: false, publish: { kind: 'unverifiable', reason: 'projection not readable' } });
  await publishTargets({ publishArtifacts: async (t) => t.map(({ type, id }) => unverifiable(type, id)) }, runner, 2, targets, null, (w) => warnings.push(w));
  assert.deepEqual(warnings, [
    'publish view Open Tickets, form Ticket could not be CONFIRMED (projection not readable) — the publish call succeeded but the published projection was not read back, so treat "live" as unproven',
    'publish view v2 could not be CONFIRMED (projection not readable) — the publish call succeeded but the published projection was not read back, so treat "live" as unproven',
  ]);
});

test('collectOwedPublishes keeps one entry per target and unions the names every attempt recorded for it', () => {
  const byTarget = new Map();
  collectOwedPublishes(byTarget, [['view', 'v1', ['view A']], ['view', 'v2']]);
  collectOwedPublishes(byTarget, [['view', 'v1', ['view A', 'form B']], ['view', 'v2']]);
  collectOwedPublishes(byTarget, [['view', 'v1', ['form C']]]); // an attempt that stopped before the others got as far
  assert.deepEqual([...byTarget.values()], [['view', 'v1', ['view A', 'form B', 'form C']], ['view', 'v2']]);
  assert.equal(collectOwedPublishes(byTarget, undefined), byTarget);
  for (const nothing of [undefined, null, 'view:v1', [], [null], [undefined]]) collectOwedPublishes(byTarget, nothing);
  assert.equal(byTarget.size, 2, 'anything that is not a list of targets adds nothing');
});

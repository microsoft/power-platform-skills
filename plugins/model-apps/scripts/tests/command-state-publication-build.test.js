'use strict';
// The table publication of a build with commandStates, end to end through the build's own entry (build-model-app.js) and its journal: the
// before-app envelope's plain PublishXml, the managed publisher's PublishXml of a table a managed group routes
// (lib/managed-scope-publisher.js), and the SDK's publication of a reconciled table after the envelope is refused. Three things are pinned here:
//   - a refused publication is said by its checked facts only (lib/command-state-contract.js serviceAnswerText), never by the platform's
//     text, while a build without commandStates keeps quoting that text as it always did;
//   - a table the managed publisher confirmed is reported confirmed even when a later table's publish halts the build, and the table whose
//     publish failed is reported `failed`, never as unsent; the halt itself is the one the build always threw;
//   - a reconciled table the SDK published after the refused envelope is confirmed by that publication, and one it refused stays `failed`.
// tests/command-state-taint.test.js plants the marker in every position of these answers; this file pins the wording and the outcomes.

const test = require('node:test');
const assert = require('node:assert');
const { T, MD, ROW, HIDE, specFor, harness, buildWithJournal } = require('./helpers/command-state-build-harness.js');
const { commandRow, ORIGIN } = require('./helpers/command-state-org.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { openManagedContext } = require('../lib/managed-bindings.js');
const { createManagedTablePublisher } = require('../lib/managed-scope-publisher.js');
const { RETRY } = require('../lib/retry-policy.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const MARKER = 'review-service-message W/"498763"';
const TAINT = /review-service-message|498763/;
const T2 = 'new_case';
const MD2 = '55555555-5555-4555-8555-555555555555';
const ROW2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const refused = (status) => ({ status, body: { error: { code: '0x80040220', message: MARKER } } });
const everywhere = (out) => [out.caught ? `${out.caught.code} ${out.caught.message}` : '', out.said, out.logged, out.log, out.status].join('\n');

// A store with no managed group: the build's managed publisher is made (sdk-build.js managedTables) and `routed` tables are published by it.
// In a real workspace a committed group of the table routes it (routeStored); the route is set directly here, as nothing else differs.
function managedRun(barrier, spec, routed) {
  const { store } = openManagedContext({ workspaceDir: makeTempDir('cs-pub-store-'), environment: ORIGIN, appUniqueName: spec.app.uniqueName, solutionUniqueName: spec.solution.uniqueName, barrier });
  for (const table of routed) barrier.route(table, 'a managed group of the table');
  return { publicationBarrier: barrier, bindingGroups: { store } };
}

test('with commandStates, a refused before-app publish is said by its status and Dataverse code, never by the platform\'s text', async () => {
  for (const status of [403, 503]) {
    const h = harness({ publishAnswer: () => refused(status) });
    const spec = specFor();
    const { approvals } = await h.approve(spec);
    const out = await buildWithJournal(h, spec, approvals);
    assert.deepStrictEqual(h.published, [[T]], 'the table is published once, before the app');
    assert.ok(out.said.includes(`could not publish table ${T} before the app (PublishXml answered HTTP ${status}, Dataverse error 0x80040220)`), out.said);
    assert.ok(!TAINT.test(everywhere(out)), 'the platform\'s text is nowhere');
    assert.strictEqual(out.caught && out.caught.code, 'command-state-publish-unconfirmed', 'the build still stops on the unconfirmed table');
  }
  // A publish with no answer at all is said by its system code alone.
  const lost = harness({ publishAnswer: () => { throw Object.assign(new Error(MARKER), { code: 'ECONNRESET' }); } });
  const spec = specFor();
  const out = await buildWithJournal(lost, spec, (await lost.approve(spec)).approvals);
  assert.ok(out.said.includes(`could not publish table ${T} before the app (PublishXml got no usable answer (ECONNRESET))`), out.said);
  assert.ok(!TAINT.test(everywhere(out)));
});

test('without commandStates, a refused before-app publish is quoted as it always was', async () => {
  const h = harness({ publishAnswer: () => refused(403) });
  const out = await buildWithJournal(h, specFor(null), { rows: new Set(), tables: new Set() });
  assert.deepStrictEqual(h.published, [[T]], 'the app\'s navigation table is published before the app');
  assert.ok(out.said.includes(`could not publish table ${T} before the app (PublishXml answered HTTP 403: ${MARKER})`), out.said);
});

// Two declared tables a managed group routes: the first table's publish is answered ok and the second's is refused.
async function twoRouted({ commandStates = true } = {}) {
  const barrier = createPublicationBarrier();
  const h = harness({
    barrier,
    tables: { [T]: { metadataId: MD }, [T2]: { metadataId: MD2 } },
    rows: [commandRow(ROW, T, MD), commandRow(ROW2, T2, MD2)],
    publishAnswer: (tables) => (tables.includes(T2) ? refused(503) : undefined),
  });
  const entities = [
    { schemaName: T, displayName: 'Ticket', primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' } },
    { schemaName: T2, displayName: 'Case', primaryAttribute: { schemaName: 'new_title', displayName: 'Title' } },
  ];
  const spec = specFor(commandStates ? [HIDE, { ...HIDE, entity: T2, rowId: ROW2 }] : null, { entities });
  const approvals = commandStates ? (await h.approve(spec)).approvals : { rows: new Set(), tables: new Set() };
  const out = await buildWithJournal(h, spec, approvals, managedRun(barrier, spec, [T, T2]));
  return { h, out };
}

test('a managed-routed table published before a later table\'s publish halts is reported confirmed; the failed one is reported failed', async () => {
  const { h, out } = await twoRouted();
  assert.deepStrictEqual(h.published, [[T], [T2]], 'each routed table is sent once, by the managed publisher');
  const halt = out.caught;
  assert.ok(halt, 'the build halts');
  // The halt is the managed publisher's, as before: its code, its retry policy and its words are not the feature's to change.
  assert.strictEqual(halt.code, 'managed-publication-unconfirmed');
  assert.strictEqual(halt.retry, RETRY.NEVER);
  assert.match(halt.message, new RegExp(`the publish of table ${T2}: managed-publication-unconfirmed`));
  assert.deepStrictEqual(halt.commandStates.publication, [
    { entity: T2, outcome: 'unconfirmed', basis: 'existing-before-app-table-envelope', reason: 'failed', code: 'command-state-publish-unconfirmed' },
    { entity: T, outcome: 'confirmed', basis: 'existing-before-app-table-envelope', path: 'managed-before-app' },
  ]);
  assert.deepStrictEqual(halt.commandStatePublicationError.tables, [T2], 'only the table whose publish failed is unconfirmed');
  assert.ok(!halt.commandStatePublicationError.message.includes(T), halt.commandStatePublicationError.message);
  assert.ok(!TAINT.test(everywhere(out)), 'the managed publisher\'s halt does not carry the platform\'s text either');
});

test('the managed flush tells onHalt what it settled before a halt, and the halt it throws is the factory\'s whatever onHalt does', async () => {
  const run = async (onHalt) => {
    const barrier = createPublicationBarrier();
    const { store } = openManagedContext({ workspaceDir: makeTempDir('cs-pub-flush-'), environment: ORIGIN, appUniqueName: 'contoso_Support', solutionUniqueName: 'ContosoSD', barrier });
    const send = barrier.gateRequest(async (req) => (req.body.includes(`<entity>${T2}</entity>`) ? { statusCode: 503, headers: {}, body: '' } : { statusCode: 204, headers: {}, body: '' }));
    const client = {
      get: async () => { throw new Error('no layer is read'); },
      post: async (url, body) => { const res = await send({ method: 'POST', url: `${ORIGIN}/api/data/v9.2${url}`, headers: {}, body: JSON.stringify(body) }); return { status: res.statusCode, body: null }; },
    };
    const made = [];
    const halt = (phase, label, code) => { const e = Object.assign(new Error(`${phase} ${label} ${code}`), { code }); made.push(e); return e; };
    const publisher = createManagedTablePublisher({ store, barrier, client, halt });
    barrier.route(T, 'test');
    barrier.route(T2, 'test');
    const thrown = await publisher.flush([T, T2], { phase: 'app-shell', onHalt }).then(() => null, (e) => e);
    return { thrown, made };
  };
  const told = [];
  const seen = await run((partial) => told.push(partial));
  assert.deepStrictEqual(told, [{ published: [T], withheld: [], failed: [T2] }]);
  assert.strictEqual(seen.thrown, seen.made[0], 'the halt the factory made is thrown');
  const throwing = await run(() => { throw new Error('an observer that throws'); });
  assert.strictEqual(throwing.thrown, throwing.made[0], 'an onHalt that throws does not replace the halt');
  const none = await run(undefined);
  assert.strictEqual(none.thrown, none.made[0], 'without onHalt the halt is thrown as before');
});

// A build that reconciles an existing view of a declared table defers the view's publish onto that table (sdk-build.js publishReconciled);
// the before-app envelope names the table, and when the envelope is refused the SDK publishes the reconciled table instead
// (publishReconciledTables). `sdkRefuses(type, id)` says which of the SDK's publishes it refuses; `batch` gives the SDK the publish of
// several artifacts in one request (publishArtifacts), which publishTargets uses for more than one table and retries a refused one alone.
function reconciling({ commandStates = true, tables = [T], sdkRefuses = () => false, batch = false } = {}) {
  const sdkPublishes = [];
  const answer = (type, id) => {
    sdkPublishes.push(`${type} ${id}`);
    return sdkRefuses(type, id, sdkPublishes.length) ? { type, id, shipped: false, publish: { kind: 'failed', error: Object.assign(new Error(MARKER), { statusCode: 400 }) } } : { type, id, shipped: true, publish: { kind: 'verified' } };
  };
  const h = harness({
    tables: { [T]: { metadataId: MD }, [T2]: { metadataId: MD2 } },
    rows: [commandRow(ROW, T, MD), commandRow(ROW2, T2, MD2)],
    publishAnswer: () => refused(503),
    adaptSdk: (sdk) => {
      // The view the spec declares on each table already exists, so the build reconciles it: view-new_ticket, view-new_case.
      sdk.findArtifact = async (kind, identity) => (kind === 'view' ? `view-${JSON.stringify(identity).includes(T2) ? T2 : T}` : null);
      sdk.publishArtifact = async (type, id) => answer(type, id);
      if (batch) sdk.publishArtifacts = async (targets) => targets.map(({ type, id }) => answer(type, id));
    },
  });
  const entities = [
    { schemaName: T, displayName: 'Ticket', primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' } },
    { schemaName: T2, displayName: 'Case', primaryAttribute: { schemaName: 'new_title', displayName: 'Title' } },
  ];
  const views = tables.map((entity) => ({ entity, name: entity === T ? 'Active Tickets' : 'Open Cases', columns: [entity === T ? 'new_subject' : 'new_title'] }));
  const states = tables.map((entity) => (entity === T ? HIDE : { ...HIDE, entity: T2, rowId: ROW2 }));
  const spec = specFor(commandStates ? states : null, { entities, views });
  return { h, spec, sdkPublishes };
}
const run = async ({ h, spec }, commandStates = true) => buildWithJournal(h, spec, commandStates ? (await h.approve(spec)).approvals : { rows: new Set(), tables: new Set() });

test('a reconciled table the SDK published after the refused before-app envelope is confirmed by that publication', async () => {
  const on = reconciling();
  const out = await run(on);
  assert.ifError(out.caught);
  assert.deepStrictEqual(on.h.published, [[T]], 'the envelope named the table once, and was refused');
  assert.ok(on.sdkPublishes.includes(`view view-${T}`), 'the SDK published the reconciled table');
  assert.deepStrictEqual(out.result.commandStates.publication, [{ entity: T, outcome: 'confirmed', basis: 'existing-before-app-table-envelope', path: 'sdk-before-app' }]);
  assert.ok(!TAINT.test(everywhere(out)));
  // Without commandStates the same build sends the same requests and also completes.
  const off = reconciling({ commandStates: false });
  const outOff = await run(off, false);
  assert.ifError(outOff.caught);
  assert.deepStrictEqual([off.h.published, off.sdkPublishes], [on.h.published, on.sdkPublishes]);
});

test('a reconciled table whose SDK publication is refused stays unconfirmed, and the build halts before the app as it always did', async () => {
  const on = reconciling({ sdkRefuses: (type) => type === 'view' });
  const out = await run(on);
  assert.strictEqual(out.caught && out.caught.code, 'reconciled-publish-failed', out.caught && out.caught.message);
  assert.deepStrictEqual(out.caught.commandStates.publication, [{ entity: T, outcome: 'unconfirmed', basis: 'existing-before-app-table-envelope', reason: 'failed', code: 'command-state-publish-unconfirmed' }]);
  assert.deepStrictEqual(out.caught.commandStatePublicationError.tables, [T]);
  const off = reconciling({ commandStates: false, sdkRefuses: (type) => type === 'view' });
  const outOff = await run(off, false);
  assert.strictEqual(outOff.caught && outOff.caught.code, 'reconciled-publish-failed');
  assert.strictEqual(outOff.caught.message, out.caught.message, 'the halt is the same with the feature off');
});

test('of two reconciled tables published in one SDK request, only the one it published is confirmed; one published on its retry is confirmed too', async () => {
  // new_ticket is refused in the batch and again alone; new_case is published in the batch.
  const refusedTwice = reconciling({ tables: [T, T2], batch: true, sdkRefuses: (type, id) => id === `view-${T}` });
  const out = await run(refusedTwice);
  assert.strictEqual(out.caught && out.caught.code, 'reconciled-publish-failed', out.caught && out.caught.message);
  assert.deepStrictEqual(out.caught.commandStates.publication.map((p) => [p.entity, p.outcome, p.path || p.reason]), [[T2, 'confirmed', 'sdk-before-app'], [T, 'unconfirmed', 'failed']]);
  // new_ticket is refused in the batch and published on its retry alone.
  let tries = 0;
  const retried = reconciling({ tables: [T, T2], batch: true, sdkRefuses: (type, id) => id === `view-${T}` && ++tries === 1 });
  const outRetried = await run(retried);
  assert.ifError(outRetried.caught);
  assert.deepStrictEqual(outRetried.result.commandStates.publication.map((p) => [p.entity, p.outcome, p.path]), [[T2, 'confirmed', 'sdk-before-app'], [T, 'confirmed', 'sdk-before-app']]);
});
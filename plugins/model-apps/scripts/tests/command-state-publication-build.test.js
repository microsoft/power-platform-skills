'use strict';
// The table publication of a build with commandStates, end to end through the build's own entry (build-model-app.js) and its journal: the
// before-app envelope's plain PublishXml, the managed publisher's PublishXml of a table a managed group routes
// (lib/managed-scope-publisher.js), and the SDK's publication of a reconciled table after the envelope is refused. Three things are pinned here:
//   - a refused publication is said by its checked facts only (lib/command-state-contract.js serviceAnswerText), never by the platform's
//     text, while a build without commandStates keeps quoting that text as it always did;
//   - a table the managed publisher confirmed is reported confirmed even when a later table's publish halts the build, and the table whose
//     publish failed is reported `failed`, never as unsent; the halt itself is the one the build always threw;
//   - a reconciled table the SDK published after the refused envelope is confirmed by that publication, and one it refused stays `failed`;
//   - a table the publish phase published after the refused envelope is confirmed by it, and only by an answer that names the table;
//   - every table publication of lib/sdk-build.js goes through its one helper (createTablePublication), which tells the observer and says a
//     failure by its checked facts — the SDK's refusal, the fallback's and its settle's, the publish phase's, and a managed publish the
//     client failed before dispatch — and a source inventory fails on a table publication added outside it.
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
// `sdkKind(type, id, n)` is the kind of an answer it does not refuse (default `verified`); `shipped` is true only for `verified`, as the SDK
// answers (a `submitted` answer, and the `notApplicable` it gives for an artifact it sent nothing for, have `shipped: false`).
// `scopeOf(type, id)` is the answer's publishScope; by default it names the view's table in an `entity` envelope, as the SDK's answer
// for a view, form or chart does (it sends `<importexportxml><entities><entity>new_ticket</entity></entities></importexportxml>`).
// A refusal is the SDK's own shape: its message and the service's error message both carry the platform's text.
const sdkRefusal = () => Object.assign(new Error(`HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml: ${MARKER}`), {
  code: 'CONNECTION_ERROR', statusCode: 400, cause: { error: { code: '0x80040220', message: MARKER } },
});
// A publication that THROWS instead (`sdkThrows`): an error of the same shape thrown, as a provider or a callback can; the real SDK throws
// before any request for an artifact its workspace does not hold (ARTIFACT_NOT_FOUND), which the real-bundle case below runs.
const sdkThrown = () => Object.assign(new Error(MARKER), { code: 'CONNECTION_ERROR', statusCode: 400, cause: { error: { code: '0x80040220', message: MARKER } } });
const entityScope = (type, id) => ({ envelope: 'entity', entityLogicalName: id.includes(T2) ? T2 : T, blastRadiusWarning: 'the table is published' });
function reconciling({ commandStates = true, tables = [T], sdkRefuses = () => false, sdkThrows = () => false, batch = false, sdkKind = () => 'verified', scopeOf = entityScope } = {}) {
  const sdkPublishes = [];
  const answer = (type, id) => {
    sdkPublishes.push(`${type} ${id}`);
    if (sdkThrows(type, id)) throw sdkThrown();
    if (sdkRefuses(type, id, sdkPublishes.length)) return { type, id, shipped: false, publish: { kind: 'failed', error: sdkRefusal() } };
    const kind = sdkKind(type, id, sdkPublishes.length);
    const publishScope = scopeOf(type, id);
    return { type, id, shipped: kind === 'verified', publish: kind === undefined ? {} : { kind }, ...(publishScope ? { publishScope } : {}) };
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
  // The halt says the refusal by its checked facts, never the service's text, here and in what the build printed and journalled.
  assert.ok(out.caught.message.includes('publish view Active Tickets FAILED before the app was written: PublishXml answered HTTP 400, Dataverse error 0x80040220 — '), out.caught.message);
  assert.ok(!TAINT.test(everywhere(out)), 'the platform\'s text is nowhere');
  // The halt is final, so the build's entry settles the publish it still owes (settleOwedPublishes), which the SDK refuses again: said the same way.
  assert.ok(out.said.includes('the build stopped before its publish phase; publish view Active Tickets FAILED: PublishXml answered HTTP 400, Dataverse error 0x80040220 — '), out.said);
  const off = reconciling({ commandStates: false, sdkRefuses: (type) => type === 'view' });
  const outOff = await run(off, false);
  assert.strictEqual(outOff.caught && outOff.caught.code, 'reconciled-publish-failed');
  assert.ok(outOff.said.includes(`the build stopped before its publish phase; publish view Active Tickets FAILED: HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml: ${MARKER} — `), outOff.said);
  // With the feature off the halt quotes the SDK's message, as it always did; the policy, the status and the cause are the same either way.
  assert.ok(outOff.caught.message.includes(`FAILED before the app was written: HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml: ${MARKER} — `), outOff.caught.message);
  assert.deepStrictEqual([out.caught.retry, out.caught.statusCode, out.caught.phase], [outOff.caught.retry, outOff.caught.statusCode, outOff.caught.phase]);
  assert.strictEqual(out.caught.message.replace(/: PublishXml answered HTTP 400, Dataverse error 0x80040220 — /, ': X — '), outOff.caught.message.replace(/: HTTP 400 from .*? — /, ': X — '), 'only the refusal\'s words differ');
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
// An SDK answer proves a publication only by a kind that says the request was sent and answered success (publishAnswerProvesPublication):
// the real SDK answers `notApplicable`, with `shipped: false` and no request sent, for an artifact it has nothing to publish for, so such an
// answer — like `none`, `notRequested`, a kind it does not know, or none — leaves the table unconfirmed and the build ends
// `command-state-publish-unconfirmed`, on each of publishTargets' three paths. With the feature off the same build completes as it always did.
const NO_PROOF = ['notApplicable', 'none', 'notRequested', 'queued', undefined];
const outcomeOf = (out) => (out.caught ? out.caught.commandStates : out.result.commandStates).publication.map((p) => [p.entity, p.outcome, p.path || p.reason]);

test('an SDK publication answered with no request made, or an unknown kind, does not confirm the reconciled table (single publish)', async () => {
  for (const kind of NO_PROOF) {
    const on = reconciling({ sdkKind: (type) => (type === 'view' ? kind : 'verified') });
    const out = await run(on);
    assert.strictEqual(out.caught && out.caught.code, 'command-state-publish-unconfirmed', `${kind}: ${out.caught && out.caught.message}`);
    assert.deepStrictEqual(outcomeOf(out), [[T, 'unconfirmed', 'failed']], String(kind));
    assert.ok(on.sdkPublishes.includes(`view view-${T}`), `${kind}: the SDK was asked to publish the reconciled table`);
    assert.ok(!TAINT.test(everywhere(out)), String(kind));
    const off = reconciling({ commandStates: false, sdkKind: (type) => (type === 'view' ? kind : 'verified') });
    const outOff = await run(off, false);
    assert.ifError(outOff.caught);
    assert.deepStrictEqual([off.h.published, off.sdkPublishes], [on.h.published, on.sdkPublishes], `${kind}: the same requests with the feature off`);
  }
});

test('an SDK batch publication answered with no request made does not confirm that table, on the first pass or on its retry', async () => {
  for (const kind of NO_PROOF) {
    const firstPass = reconciling({ tables: [T, T2], batch: true, sdkKind: (type, id) => (id === `view-${T}` ? kind : 'verified') });
    const out = await run(firstPass);
    assert.strictEqual(out.caught && out.caught.code, 'command-state-publish-unconfirmed', `${kind}: ${out.caught && out.caught.message}`);
    assert.deepStrictEqual(outcomeOf(out), [[T2, 'confirmed', 'sdk-before-app'], [T, 'unconfirmed', 'failed']], `first pass ${kind}`);
    // new_ticket is refused in the batch, and its retry alone is answered with the kind.
    let tries = 0;
    const retry = reconciling({ tables: [T, T2], batch: true, sdkRefuses: (type, id) => id === `view-${T}` && ++tries === 1, sdkKind: (type, id) => (id === `view-${T}` ? kind : 'verified') });
    const outRetry = await run(retry);
    assert.strictEqual(outRetry.caught && outRetry.caught.code, 'command-state-publish-unconfirmed', `${kind}: ${outRetry.caught && outRetry.caught.message}`);
    assert.deepStrictEqual(outcomeOf(outRetry), [[T2, 'confirmed', 'sdk-before-app'], [T, 'unconfirmed', 'failed']], `retry ${kind}`);
    assert.ok(retry.sdkPublishes.filter((p) => p === `view view-${T}`).length >= 2, `${kind}: new_ticket was retried after the refused batch`);
    assert.ok(!TAINT.test(everywhere(out)) && !TAINT.test(everywhere(outRetry)), String(kind));
  }
});

test('an SDK publication answered submitted (shipped false), verified or unverifiable confirms the reconciled table on each path', async () => {
  for (const kind of ['submitted', 'verified', 'unverifiable']) {
    const single = await run(reconciling({ sdkKind: () => kind }));
    assert.ifError(single.caught);
    assert.deepStrictEqual(outcomeOf(single), [[T, 'confirmed', 'sdk-before-app']], `single ${kind}`);
    const batch = await run(reconciling({ tables: [T, T2], batch: true, sdkKind: () => kind }));
    assert.ifError(batch.caught);
    assert.deepStrictEqual(outcomeOf(batch), [[T2, 'confirmed', 'sdk-before-app'], [T, 'confirmed', 'sdk-before-app']], `batch ${kind}`);
    let tries = 0;
    const retry = await run(reconciling({ tables: [T, T2], batch: true, sdkRefuses: (type, id) => id === `view-${T}` && ++tries === 1, sdkKind: () => kind }));
    assert.ifError(retry.caught);
    assert.deepStrictEqual(outcomeOf(retry), [[T2, 'confirmed', 'sdk-before-app'], [T, 'confirmed', 'sdk-before-app']], `retry ${kind}`);
  }
});

// ---- Every table publication of the build is heard, and said by its checked facts (sdk-build.js createTablePublication) ----
// The publish phase (8) publishes, through the SDK, each table the build saved a view, chart or form on. When the envelope before the app was
// refused, that publication is the one that names the table after its latest row write, so the observer hears of it: the table is confirmed by
// `sdk-publish-phase`. Only an answer whose publishScope is the table's own entity envelope, of a kind that proves the request was answered,
// names the table; an answer that names another table, an envelope that names none (a dashboard's, the app's), or none, confirms nothing.
// `scopeOf(type, table)` is the answer's publishScope (default: the table's entity envelope, the app's appmodule one); `kind(type, table)` its
// kind; `refuses(type, table)` answers the SDK's refusal instead; `plain(tables)` answers the envelope before the app.
function publishing({ commandStates = true, tables = [T], batch = false, scopeOf, kind = () => 'verified', refuses = () => false, throws = () => false, plain = () => refused(503), barrier, adaptSdk } = {}) {
  const tableOfId = new Map();
  const sdkPublishes = [];
  const answer = (type, id) => {
    sdkPublishes.push(`${type} ${id}`);
    const table = tableOfId.get(id) || null;
    if (throws(type, table)) throw sdkThrown();
    if (refuses(type, table)) return { type, id, shipped: false, publish: { kind: 'failed', error: sdkRefusal() } };
    const k = kind(type, table);
    const publishScope = scopeOf ? scopeOf(type, table) : table ? entityScope(type, table) : { envelope: 'appmodule', blastRadiusWarning: 'the app is published' };
    return { type, id, shipped: k === 'verified', publish: { kind: k }, ...(publishScope ? { publishScope } : {}) };
  };
  const h = harness({
    barrier,
    tables: { [T]: { metadataId: MD }, [T2]: { metadataId: MD2 } },
    rows: [commandRow(ROW, T, MD), commandRow(ROW2, T2, MD2)],
    publishAnswer: plain,
    adaptSdk: (sdk) => {
      // The views the spec declares do not exist yet, so the build creates them; their ids are the mock's (view-1), so the table each was
      // made for is kept here for the answer to name.
      const create = sdk.createArtifact;
      sdk.createArtifact = (type, def) => {
        const made = create(type, def);
        const table = def && (def.entityLogicalName || def.entity);
        if (table) tableOfId.set(made.id, table);
        return made;
      };
      sdk.publishArtifact = async (type, id) => answer(type, id);
      if (batch) sdk.publishArtifacts = async (targets) => targets.map(({ type, id }) => answer(type, id));
      if (adaptSdk) adaptSdk(sdk);
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

test('a table the publish phase published after the refused before-app envelope is confirmed by that publication, alone or in one batch', async () => {
  for (const [tables, batch] of [[[T], false], [[T, T2], false], [[T, T2], true]]) {
    for (const kind of ['verified', 'submitted', 'unverifiable']) {
      const on = publishing({ tables, batch, kind: () => kind });
      const out = await run(on);
      const what = `${tables.join('+')} batch=${batch} ${kind}`;
      assert.ifError(out.caught);
      assert.deepStrictEqual(on.h.published.map((names) => [...names].sort()), [[...tables].sort()], `${what}: the envelope named the tables once, and was refused`);
      assert.deepStrictEqual(outcomeOf(out), [...tables].sort().map((t) => [t, 'confirmed', 'sdk-publish-phase']), what);
      assert.ok(!TAINT.test(everywhere(out)), what);
      // Without commandStates the same build makes the same SDK publications and completes, as it always did (its envelope names only the
      // app's navigation table, as 2.23.0's did; the feature adds its declared tables to it).
      const off = publishing({ commandStates: false, tables, batch, kind: () => kind });
      const outOff = await run(off, false);
      assert.ifError(outOff.caught);
      assert.deepStrictEqual(off.sdkPublishes, on.sdkPublishes, what);
    }
  }
});

test('a publish-phase answer that does not name the table, or proves no request, confirms nothing', async () => {
  const cases = {
    'another table': () => ({ envelope: 'entity', entityLogicalName: T2 }),
    'a dashboard envelope': () => ({ envelope: 'dashboard', dashboardIds: ['d1'] }),
    'the app envelope': () => ({ envelope: 'appmodule' }),
    'an entity envelope with no name': () => ({ envelope: 'entity' }),
    'no publishScope': () => undefined,
  };
  for (const [what, scopeOf] of Object.entries(cases)) {
    const out = await run(publishing({ scopeOf }));
    assert.strictEqual(out.caught && out.caught.code, 'command-state-publish-unconfirmed', `${what}: ${out.caught && out.caught.message}`);
    assert.deepStrictEqual(outcomeOf(out), [[T, 'unconfirmed', 'failed']], what);
  }
  for (const kind of ['notApplicable', 'none', 'notRequested', 'queued']) {
    const out = await run(publishing({ kind: (type) => (type === 'view' ? kind : 'verified') }));
    assert.strictEqual(out.caught && out.caught.code, 'command-state-publish-unconfirmed', kind);
    assert.deepStrictEqual(outcomeOf(out), [[T, 'unconfirmed', 'failed']], kind);
  }
  // Of two tables in one batch, the answer that names new_case confirms new_case alone, even when it is the answer to new_ticket's view.
  const crossed = await run(publishing({ tables: [T, T2], batch: true, scopeOf: () => ({ envelope: 'entity', entityLogicalName: T2 }) }));
  assert.deepStrictEqual(outcomeOf(crossed), [[T2, 'confirmed', 'sdk-publish-phase'], [T, 'unconfirmed', 'failed']]);
});

test('with commandStates, a publish-phase table publication the SDK refused is said by its checked facts; without, quoted as it always was', async () => {
  const on = publishing({ plain: () => undefined, refuses: (type) => type === 'view' });
  const out = await run(on);
  assert.ok(on.sdkPublishes.some((p) => p.startsWith('view ')), 'the SDK was asked to publish the view');
  assert.match(out.said, /publish view Active Tickets[^\n]*PublishXml answered HTTP 400, Dataverse error 0x80040220/, out.said);
  assert.ok(!TAINT.test(everywhere(out)), 'the platform\'s text is nowhere');
  const off = publishing({ commandStates: false, plain: () => undefined, refuses: (type) => type === 'view' });
  const outOff = await run(off, false);
  assert.ok(outOff.said.includes(MARKER), outOff.said);
  assert.deepStrictEqual([off.h.published, off.sdkPublishes], [on.h.published, on.sdkPublishes], 'the same requests');
  assert.strictEqual(!!out.caught, !!outOff.caught, 'the build ends the same way');
});

test('a managed table publication the client failed before it was dispatched is said by its system code, never the client\'s text', async () => {
  const lose = (sdk) => {
    const post = sdk.dataverse.post;
    sdk.dataverse.post = async (url, body) => {
      if (String(body && body.ParameterXml).includes(`<entity>${T}</entity>`)) throw Object.assign(new Error(`socket closed: ${MARKER}`), { code: 'ECONNRESET' });
      return post(url, body);
    };
  };
  const barrier = createPublicationBarrier();
  const on = publishing({ plain: () => undefined, barrier, adaptSdk: lose });
  const out = await buildWithJournal(on.h, on.spec, (await on.h.approve(on.spec)).approvals, managedRun(barrier, on.spec, [T]));
  assert.strictEqual(out.caught && out.caught.code, 'publish-failed', out.caught && out.caught.message);
  assert.deepStrictEqual(on.h.published, [], 'nothing reached the service');
  assert.ok(out.caught.message.includes(`the publish of table ${T}: publish-failed — PublishXml got no usable answer (ECONNRESET)`), out.caught.message);
  assert.ok(everywhere(out).includes('PublishXml got no usable answer (ECONNRESET)'), everywhere(out));
  assert.ok(!TAINT.test(everywhere(out)), 'the client\'s text is nowhere');
  // Without commandStates the halt and its finding are the ones 2.23.0 made, the client's text among them.
  const offBarrier = createPublicationBarrier();
  const off = publishing({ commandStates: false, plain: () => undefined, barrier: offBarrier, adaptSdk: lose });
  const outOff = await buildWithJournal(off.h, off.spec, { rows: new Set(), tables: new Set() }, managedRun(offBarrier, off.spec, [T]));
  assert.strictEqual(outOff.caught && outOff.caught.code, out.caught.code);
  assert.ok(everywhere(outOff).includes(MARKER), 'the client\'s text is quoted as before');
});

// createTablePublication on its own: what each member tells the observer, with the path its call site names, and that the observer is only
// told — what it does or throws changes no answer and no halt.
test('createTablePublication tells the observer what each publication named, partial results on a managed halt included', async () => {
  const { createTablePublication } = require('../lib/sdk-build.js');
  const heard = [];
  const observer = {
    observePlain: (names, outcome, path) => heard.push(['plain', names, outcome && outcome.ok, path]),
    observeSdk: (names, path) => heard.push(['sdk', names, path]),
    observeManaged: (flushed, path) => heard.push(['managed', flushed, path]),
  };
  const flushes = [];
  const halt = Object.assign(new Error('halt'), { code: 'managed-publication-unconfirmed' });
  const managedTables = {
    flush: async (tables, options) => {
      flushes.push(Object.keys(options).sort());
      if (tables.includes(T2)) { options.onHalt({ published: [T], withheld: [], failed: [T2] }); throw halt; }
      return { published: tables, withheld: [] };
    },
  };
  const answers = {
    'view v1': { publish: { kind: 'verified' }, publishScope: { envelope: 'entity', entityLogicalName: 'NEW_TICKET' } },
    'view v2': { publish: { kind: 'verified' }, publishScope: { envelope: 'entity', entityLogicalName: T2 } },
    'view v3': { publish: { kind: 'notApplicable' }, publishScope: { envelope: 'entity', entityLogicalName: T } },
    'dashboard d1': { publish: { kind: 'verified' }, publishScope: { envelope: 'dashboard' } },
    // The table's name in an envelope that is not the table's own does not say the table was published.
    'view v4': { publish: { kind: 'verified' }, publishScope: { envelope: 'dashboard', entityLogicalName: T } },
  };
  const provision = { publishArtifact: async (type, id) => ({ type, id, ...answers[`${type} ${id}`] }) };
  const pub = createTablePublication({ observer, provision, runner: { mapLimit: async (items, n, fn) => Promise.all(items.map(fn)) }, managedTables, warn: () => {} });
  assert.strictEqual(pub.checked, true);
  assert.deepStrictEqual(await pub.managed([T], { phase: 'publish', path: 'p', observed: 'managed-publish-phase' }), { published: [T], withheld: [] });
  assert.strictEqual(await pub.managed([T, T2], { phase: 'publish', path: 'p', observed: 'managed-end-of-build' }).catch((e) => e), halt, 'the halt is the flush\'s');
  for (const id of ['v1', 'v2', 'v3', 'v4']) await pub.one('view', id, T, `view ${id}`, { observed: 'sdk-reconcile' });
  await pub.one('dashboard', 'd1', T, 'dashboard d1', { observed: 'sdk-reconcile' });
  await pub.sdk([['view', 'v1'], ['view', 'v2'], ['dashboard', 'd1'], ['view', 'v4']], null, { tableOf: () => T, observed: 'sdk-publish-phase' });
  assert.deepStrictEqual(heard, [
    ['managed', { published: [T], withheld: [] }, 'managed-publish-phase'],
    ['managed', { published: [T], withheld: [], failed: [T2] }, 'managed-end-of-build'],
    ['sdk', [T], 'sdk-reconcile'],
    ['sdk', [T], 'sdk-publish-phase'],
  ]);
  assert.deepStrictEqual(flushes, [['onHalt', 'path', 'phase', 'sayRefusal'], ['onHalt', 'path', 'phase', 'sayRefusal']], 'with an observer the flush is told what to say');
  // Without an observer nothing is told, and the managed flush is asked exactly as 2.23.0 asked it.
  const quiet = createTablePublication({ provision, runner: { mapLimit: async (items, n, fn) => Promise.all(items.map(fn)) }, managedTables, warn: () => {} });
  heard.length = 0;
  flushes.length = 0;
  assert.strictEqual(quiet.checked, false);
  await quiet.managed([T], { phase: 'publish', path: 'p', observed: 'managed-publish-phase' });
  await quiet.one('view', 'v1', T, 'view v1', { observed: 'sdk-reconcile' });
  assert.deepStrictEqual([heard, flushes], [[], [['path', 'phase']]]);
  // An observer that throws changes nothing.
  const loud = createTablePublication({ observer: { observeSdk: () => { throw new Error('observer'); }, observeManaged: () => { throw new Error('observer'); } }, provision, runner: { mapLimit: async (items, n, fn) => Promise.all(items.map(fn)) }, managedTables, warn: () => {} });
  assert.deepStrictEqual(await loud.one('view', 'v1', T, 'view v1', { observed: 'x' }), { type: 'view', id: 'v1', ...answers['view v1'] });
  assert.strictEqual(await loud.managed([T, T2], { phase: 'publish', path: 'p', observed: 'x' }).catch((e) => e), halt);
});

// A halted build publishes what it still owed (settleOwedPublishes), best-effort: a publish the SDK threw on, or answered refused, is a
// warning. In a build with commandStates (`checked`) the warning says it by its checked facts — the status, the Dataverse code, the error's
// own system code — and never the error's message; without, it quotes the message as 2.23.0 did.
test('a publish owed after a halt that throws or is refused is said by its checked facts with commandStates, and quoted without', async () => {
  const { settleOwedPublishes } = require('../lib/sdk-build.js');
  const answers = {
    v1: () => { throw Object.assign(new Error(`socket closed: ${MARKER}`), { code: 'ECONNRESET' }); },
    v2: () => ({ publish: { kind: 'failed', error: sdkRefusal() } }),
    v3: () => ({ publish: { kind: 'failed', error: Object.assign(new Error(`Transport failure reaching ${ORIGIN}/api/data/v9.2/PublishXml: ${MARKER}`), { code: 'CONNECTION_ERROR', statusCode: 0 }) } }),
  };
  const run = async (checked) => {
    const said = [];
    const provision = { publishArtifact: async (type, id) => ({ type, id, ...answers[id]() }) };
    await settleOwedPublishes(provision, [['view', 'v1', ['view One']], ['view', 'v2', ['view Two']], ['view', 'v3', ['view Three']]], (m) => said.push(m), { checked });
    return said.map((line) => line.replace(/^the build stopped before its publish phase; publish (.*?) FAILED: (.*?) — the change is SAVED.*$/, '$1: $2'));
  };
  assert.deepStrictEqual(await run(true), [
    'view One: PublishXml got no usable answer (ECONNRESET)',
    'view Two: PublishXml answered HTTP 400, Dataverse error 0x80040220',
    'view Three: PublishXml got no usable answer (CONNECTION_ERROR)',
  ]);
  assert.deepStrictEqual(await run(false), [
    `view One: socket closed: ${MARKER}`,
    `view Two: HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml: ${MARKER}`,
    `view Three: Transport failure reaching ${ORIGIN}/api/data/v9.2/PublishXml: ${MARKER}`,
  ]);
});

// ---- A table publication that THROWS (sdk-build.js createTablePublication) ----
// The vendored SDK answers a refused or unanswered PublishXml by value, but throws before any request for an artifact its workspace does not
// hold (ARTIFACT_NOT_FOUND), and a provider or a callback can throw too. Two things hold whatever throws, and wherever:
//   - a table a request already proved published stays confirmed: the helper hears each target as it settles, so a later target's throw, a
//     retry's after the batch, or the single-target pass's after a batch that threw does not erase it; the table whose publication threw
//     stays unconfirmed, and the error is the one thrown, unchanged;
//   - with commandStates the halt and every line around it say the thrown error by its checked facts; its code, cause, status and retry
//     policy are the same as without, where it is quoted as 2.23.0 quoted it.
test('a table the real SDK published stays confirmed when a later target of the same publication throws before its request', async () => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
  const { createTablePublication } = require('../lib/sdk-build.js');
  const { createCommandStatePublicationObserver } = require('../lib/command-state-run.js');
  const { mapLimit } = require('../lib/entity-provision.js');
  const requests = [];
  const client = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((method) => [method, async (url, body) => {
    requests.push({ method, url, body });
    return method === 'get' ? { status: 200, body: { value: [] } } : { status: 204 };
  }]));
  client.apiUrl = (p) => `${ORIGIN}/api/data/v9.2${p}`;
  const sdk = createMakerSdk({ instanceUrl: ORIGIN, httpClient: client, workspaceStorage: createNodeWorkspaceStorage(makeTempDir('cs-pub-real-')) });
  await sdk.initWorkspace();
  // A view of new_ticket the workspace holds, and one of new_case it does not: the SDK publishes the first and refuses the second locally.
  const view = await sdk.createArtifact('view', { name: 'Existing View', entityLogicalName: T, columns: [{ name: 'new_subject' }] });
  const MISSING = '99999999-9999-4999-8999-999999999999';
  for (const batch of [false, true]) {
    const runs = {};
    for (const commandStates of [true, false]) {
      const observer = commandStates ? createCommandStatePublicationObserver() : null;
      if (observer) for (const table of [T, T2]) { observer.register(table); observer.noteRowWrite(table); }
      const thrown = [];
      const provision = { publishArtifact: async (type, id) => sdk.publishArtifact(type, id).catch((e) => { thrown.push(e); throw e; }) };
      if (batch) provision.publishArtifacts = async (targets) => sdk.publishArtifacts(targets);
      const start = requests.length;
      const pub = createTablePublication({ observer, provision, runner: { mapLimit }, concurrency: 1, warn: () => {} });
      const caught = await pub.sdk([['view', view.id], ['view', MISSING]], null, { tableOf: (target) => (target[1] === view.id ? T : T2), observed: 'sdk-publish-phase' }).then(() => null, (e) => e);
      const what = `batch=${batch} commandStates=${commandStates}`;
      assert.strictEqual(caught && caught.code, 'ARTIFACT_NOT_FOUND', what);
      assert.strictEqual(caught, thrown[thrown.length - 1], `${what}: the error is the SDK's own`);
      const sends = requests.slice(start).filter((r) => /PublishXml/.test(r.url));
      assert.strictEqual(sends.length, 1, `${what}: one request, for the view the workspace holds`);
      assert.match(sends[0].body.ParameterXml, new RegExp(`<entity>${T}</entity>`), what);
      runs[commandStates] = sends.map((r) => r.body.ParameterXml);
      if (!observer) continue;
      observer.attachFailure(caught);
      assert.deepStrictEqual(caught.commandStates.publication.map((p) => [p.entity, p.outcome, p.path || p.reason]),
        [[T2, 'unconfirmed', 'halted-before-send'], [T, 'confirmed', 'sdk-publish-phase']], what);
      assert.deepStrictEqual(caught.commandStatePublicationError.tables, [T2], what);
    }
    assert.deepStrictEqual(runs.true, runs.false, `batch=${batch}: the same request with the feature off`);
  }
});

test('a table proven by the batch stays confirmed when another table\'s retry throws; a batch that proves nothing confirms nothing', async () => {
  const { createTablePublication, publishTargets } = require('../lib/sdk-build.js');
  const serial = { mapLimit: async (items, n, fn) => { const out = []; for (const [i, item] of items.entries()) out.push(await fn(item, i)); return out; } };
  const scope = (table) => ({ envelope: 'entity', entityLogicalName: table });
  const tableOf = (target) => (target[1] === 'v1' ? T : T2);
  const publishOf = async (provision) => {
    const heard = [];
    const pub = createTablePublication({ observer: { observeSdk: (names, path) => heard.push([names, path]) }, provision, runner: serial, warn: () => {} });
    const caught = await pub.sdk([['view', 'v1'], ['view', 'v2']], null, { tableOf, observed: 'sdk-publish-phase' }).then(() => null, (e) => e);
    return { heard, caught };
  };
  // v1 (new_ticket) is published in the batch, v2 (new_case) refused there; its retry alone throws.
  const boom = sdkThrown();
  const retried = await publishOf({
    publishArtifacts: async (targets) => targets.map(({ type, id }) => (id === 'v1'
      ? { type, id, publish: { kind: 'verified' }, publishScope: scope(T) }
      : { type, id, publish: { kind: 'failed', error: sdkRefusal() }, publishScope: scope(T2) })),
    publishArtifact: async () => { throw boom; },
  });
  assert.strictEqual(retried.caught, boom, 'the retry\'s error, unchanged');
  assert.deepStrictEqual(retried.heard, [[[T], 'sdk-publish-phase']]);
  // A batch answered for one target of two is no answer: nothing it says is read, and the single-target pass that follows proves nothing
  // before v2 throws.
  const partial = await publishOf({
    publishArtifacts: async () => [{ type: 'view', id: 'v1', publish: { kind: 'verified' }, publishScope: scope(T) }],
    publishArtifact: async (type, id) => { if (id === 'v2') throw boom; return { type, id, publish: { kind: 'notApplicable' }, publishScope: scope(T) }; },
  });
  assert.strictEqual(partial.caught, boom);
  assert.deepStrictEqual(partial.heard, []);
  // A batch that throws, then the single-target pass: v1 proven, then v2 throws.
  const fallback = await publishOf({
    publishArtifacts: async () => { throw new Error('batch preflight'); },
    publishArtifact: async (type, id) => { if (id === 'v2') throw boom; return { type, id, publish: { kind: 'submitted' }, publishScope: scope(T) }; },
  });
  assert.strictEqual(fallback.caught, boom);
  assert.deepStrictEqual(fallback.heard, [[[T], 'sdk-publish-phase']]);
  // The thrown error is the SDK's own: its words stay what they were, for what decides a retry reads them (retry-policy.js judgeFailure).
  assert.strictEqual(boom.message, MARKER);
  // publishTargets tells only an answer that proves a request was sent: none for a no-request kind, whatever envelope it carries.
  const told = [];
  await publishTargets({ publishArtifact: async (type, id) => ({ type, id, publish: { kind: 'notApplicable' }, publishScope: scope(T) }) }, serial, 1,
    [['view', 'v1']], null, () => {}, { onProven: (target) => told.push(target) });
  assert.deepStrictEqual(told, []);
});

test('a reconcile\'s own table publication that throws is said by its checked facts with commandStates, and is the SDK\'s error unchanged', async () => {
  const { createTablePublication } = require('../lib/sdk-build.js');
  const { checkedDisplay } = require('../lib/command-state-contract.js');
  for (const observer of [{ observeSdk: () => {} }, null]) {
    const boom = sdkThrown();
    const pub = createTablePublication({ observer, provision: { publishArtifact: async () => { throw boom; } }, runner: { mapLimit: async () => [] }, warn: () => {} });
    const caught = await pub.one('view', 'v1', T, 'view Open Tickets', { observed: 'sdk-reconcile' }).then(() => null, (e) => e);
    assert.strictEqual(caught, boom);
    assert.strictEqual(caught.message, MARKER);
    assert.deepStrictEqual(checkedDisplay(caught), observer
      ? { text: 'PublishXml answered HTTP 400, Dataverse error 0x80040220', code: 'CONNECTION_ERROR' }
      : { text: MARKER, code: 'CONNECTION_ERROR' });
  }
});

// The halt a thrown publication ends a build with, on and off: everything that decides it is the same; only its words differ.
const haltFacts = (halt) => halt && [halt.code, halt.phase, halt.retry, halt.recoverable, halt.statusCode, halt.cause && halt.cause.code, halt.cause && halt.cause.statusCode];

test('a publish-phase table publication that throws after another table\'s was proven: that one stays confirmed, and the halt is said by its checked facts', async () => {
  for (const batch of [false, true]) {
    const on = publishing({ tables: [T, T2], batch, throws: (type, table) => table === T2 });
    const out = await run(on);
    const what = `batch=${batch}`;
    assert.ok(out.caught, what);
    assert.deepStrictEqual(outcomeOf(out), [[T2, 'unconfirmed', 'failed'], [T, 'confirmed', 'sdk-publish-phase']], what);
    assert.ok(out.caught.message.includes('PublishXml answered HTTP 400, Dataverse error 0x80040220'), `${what}: ${out.caught.message}`);
    assert.ok(!TAINT.test(everywhere(out)), `${what}: the thrown error's text is nowhere`);
    const off = publishing({ commandStates: false, tables: [T, T2], batch, throws: (type, table) => table === T2 });
    const outOff = await run(off, false);
    assert.ok(outOff.caught && outOff.caught.message.includes(MARKER), `${what}: without commandStates the halt quotes it as before`);
    assert.deepStrictEqual(haltFacts(out.caught), haltFacts(outOff.caught), `${what}: the same halt but for its words`);
    assert.deepStrictEqual(off.sdkPublishes, on.sdkPublishes, `${what}: the same publications`);
  }
});

test('a reconciled table\'s SDK publication that throws after another\'s was proven: that one stays confirmed, and every line says the error by its checked facts', async () => {
  for (const batch of [false, true]) {
    const on = reconciling({ tables: [T, T2], batch, sdkThrows: (type, id) => id === `view-${T2}` });
    const out = await run(on);
    const what = `batch=${batch}`;
    assert.ok(out.caught, what);
    assert.deepStrictEqual(outcomeOf(out), [[T2, 'unconfirmed', 'failed'], [T, 'confirmed', 'sdk-before-app']], what);
    assert.ok(!TAINT.test(everywhere(out)), `${what}: the thrown error's text is nowhere`);
    assert.ok(out.caught.message.includes('PublishXml answered HTTP 400, Dataverse error 0x80040220'), `${what}: ${out.caught.message}`);
    const off = reconciling({ commandStates: false, tables: [T, T2], batch, sdkThrows: (type, id) => id === `view-${T2}` });
    const outOff = await run(off, false);
    assert.ok(outOff.caught && outOff.caught.message.includes(MARKER), what);
    assert.deepStrictEqual(haltFacts(out.caught), haltFacts(outOff.caught), `${what}: the same halt but for its words`);
    assert.deepStrictEqual(off.sdkPublishes, on.sdkPublishes, `${what}: the same publications`);
  }
});

// After a final halt the build reads what is still saved and not published on the spec's tables (table-publish.js readSavedNotPublished).
// When that READ fails, a build with commandStates says it by its checked facts, as a read (its status, its Dataverse code, the system code
// of a read with no answer, or the field a row got wrong), never the service's text; without, it is quoted as 2.23.0 quoted it. What the read
// found when it succeeded is said the same way in both.
test('after a halt, a saved-layer read that fails is said by its checked facts with commandStates, and quoted without', async () => {
  const { settleOwedPublishes } = require('../lib/sdk-build.js');
  const row = (fields) => ({ savedqueryid: '77777777-7777-4777-8777-777777777777', name: 'Open Tickets', returnedtypecode: T, componentstate: 1, ...fields });
  const views = (rows) => async (url) => ({ status: 200, body: { value: /savedqueries/.test(url) ? rows : [] } });
  const reads = {
    refused: async () => ({ status: 403, body: { error: { code: '0x80040220', message: MARKER } } }),
    'refused, code planted': async () => ({ status: 403, body: { error: { code: MARKER, message: 'denied' } } }),
    lost: async () => { throw Object.assign(new Error(`socket closed: ${MARKER}`), { code: 'ECONNRESET' }); },
    'bad componentstate': views([row({ componentstate: MARKER })]),
    'no table': views([row({ returnedtypecode: '' })]),
    'not a list': async () => ({ status: 200, body: { value: MARKER } }),
  };
  const CHECKED = {
    refused: 'the saved views: HTTP 403, Dataverse error 0x80040220; check that the signed-in account can read it, and look the error code up',
    'refused, code planted': 'the saved views: HTTP 403; check that the signed-in account can read it, and look the error code up',
    lost: 'the saved views: no usable answer (ECONNRESET); check the connection and run it again',
    'bad componentstate': 'the saved views: the answer holds an unreadable value (componentstate); run it again, and if it persists check the environment\'s answer for this read',
    'no table': 'the saved views: the answer holds a row that cannot be placed; run it again, and if it persists check the environment\'s answer for this read',
    'not a list': 'the saved views: the answer is not a list of rows; run it again, and if it persists check the environment\'s answer for this read',
  };
  const settle = async (get, checked) => {
    const said = [];
    await settleOwedPublishes({ dataverse: { apiUrl: (p) => `${ORIGIN}/api/data/v9.2${p}`, get } }, [], (m) => said.push(m), { tables: [T], checked });
    return said;
  };
  const couldNot = /^the build stopped before its publish phase; which forms, views and charts on the spec's tables are saved but not published could not be read \((.*)\)\. Run the build again with --publish, or publish these tables in Power Apps: new_ticket\.$/;
  for (const [what, get] of Object.entries(reads)) {
    const on = await settle(get, true);
    assert.strictEqual(on.length, 1, what);
    assert.strictEqual((couldNot.exec(on[0]) || [])[1], CHECKED[what], `${what}: ${on[0]}`);
    const off = await settle(get, false);
    assert.strictEqual(off.length, 1, what);
    assert.ok(couldNot.test(off[0]), `${what}: ${off[0]}`);
    if (['refused', 'lost', 'bad componentstate'].includes(what)) assert.ok(TAINT.test(off[0]), `${what}: without commandStates the reason is quoted as before: ${off[0]}`);
  }
  // A read is named only by one of its three fixed labels: a label it does not know is left out, whatever it holds.
  const { describeSavedNotPublished } = require('../lib/table-publish.js');
  const odd = describeSavedNotPublished({ ok: false, reason: MARKER, facts: { read: MARKER, problem: 'failed', status: 403 } }, [T], { checked: true });
  assert.strictEqual((couldNot.exec(`the build stopped before its publish phase; ${odd}`) || [])[1], 'HTTP 403; check that the signed-in account can read it, and look the error code up');
  // A read that succeeds lists what it found, the same with the feature on and off.
  const found = views([row({})]);
  assert.deepStrictEqual(await settle(found, true), await settle(found, false));
  assert.match((await settle(found, true))[0], /saved but not published on the spec's tables — new_ticket: view Open Tickets\./);
});

// The inventory: every request in lib/sdk-build.js that can publish a table is made inside createTablePublication or publishTargets (which
// only createTablePublication calls), so a table publication added anywhere else fails here until it goes through the helper. The one
// exception is the app's own publish (appWriters), whose request names the app module and no table. Comment lines are skipped; the file's
// line endings are normalised, since a checkout may give it CRLF.
test('every table publication in sdk-build.js goes through createTablePublication', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const lines = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-build.js'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const bodyOf = (header) => {
    const start = lines.findIndex((line) => line.startsWith(header));
    assert.ok(start >= 0, `${header} is in the file`);
    const end = lines.findIndex((line, i) => i > start && line === '}');
    assert.ok(end > start, `${header} has a body`);
    return [start, end];
  };
  const helper = bodyOf('function createTablePublication(');
  const targets = bodyOf('async function publishTargets(');
  const PUBLISHES = [
    /\bpublishTablesXml\(/, /\.publishArtifacts?\(/, /\bmanagedTables\.flush\(/, /\bpublishTargets\(/, /PublishXml['"`]/, /PublishAllXml/,
    /\b(pushArtifacts?|enrichDefaultViews)\([^)]*\bpublish:(?!\s*false\b)/,
  ];
  const ALLOWED = [
    { at: /^return provision\.publishArtifact\('app', appId\);$/, why: 'the app\'s own publish (appWriters): its request names the app module, never a table' },
  ];
  const stray = [];
  lines.forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    if (!PUBLISHES.some((re) => re.test(code))) return;
    if ([helper, targets].some(([start, end]) => i > start && i < end) || i === targets[0]) return;
    if (ALLOWED.some((a) => a.at.test(code))) return;
    stray.push(`${i + 1}: ${code}`);
  });
  assert.deepStrictEqual(stray, [], 'a table publication outside createTablePublication');
  // publishTargets is reached only through the helper, and every call site names itself to the observer.
  const calls = lines.map((line, i) => [i, line.trim()]).filter(([, code]) => !code.startsWith('//') && /\btablePublication\.(plain|managed|sdk|one)\(/.test(code));
  assert.ok(calls.length >= 11, `the build's table publications go through the helper (${calls.length})`);
  assert.deepStrictEqual(calls.filter(([, code]) => !/\bobserved: '[a-z-]+'/.test(code)).map(([i, code]) => `${i + 1}: ${code}`), [], 'each names its path');
  const observed = [...new Set(calls.map(([, code]) => /\bobserved: '([a-z-]+)'/.exec(code)[1]))].sort();
  assert.deepStrictEqual(observed, ['managed-app-publication', 'managed-before-app', 'managed-end-of-build', 'managed-publish-phase', 'managed-reconcile', 'managed-views-phase',
    'plain-before-app', 'sdk-app-publication', 'sdk-before-app', 'sdk-publish-phase', 'sdk-reconcile']);
});
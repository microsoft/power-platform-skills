'use strict';
// Managed (keyed) command reconciliation against the REAL vendored SDK and an in-memory
// `appactions` table (tests/helpers/command-bar-server.js). Assertions are on the requests the SDK
// actually sends: a push can answer `saved: true` while writing nothing, and "no-op sends no push"
// is only provable from the wire.
const test = require('node:test');
const assert = require('node:assert');
const { createCommandBarServer } = require('./helpers/command-bar-server.js');
const { fakeCreates, fakeManaged } = require('./helpers/feature-ports.js');
const {
  validateManagedCommands, planCommandReconcile, applyCommandReconcile, expectedCommandQueries, isManagedEntity,
} = require('../lib/command-reconcile.js');
const { commandDef } = require('../lib/sdk-build.js');

const WR = '66666666-6666-6666-6666-666666666666';
const WEB = { cr_lib: WR };
const DEFAULTS = { MainTab: '[{"type":5,"value":null}]', HomeTab: '[{"type":12,"value":null}]', ContextualTab: '[{"type":12,"value":null}]' };

async function reconcile(srv, commands, ports, extra = {}) {
  const sdk = await srv.newSdk();
  const ctx = { managed: ports.managed, creates: ports.creates, appUniqueName: 'cr_app', environmentFingerprint: 'env-1', ...extra };
  const plan = await planCommandReconcile({ entity: 'account', commands, sdk, webResources: WEB, defaultParameters: DEFAULTS }, ctx);
  const result = await applyCommandReconcile(plan, { sdk }, ctx);
  ports.managed.persist(result.managedBindings);
  return { plan, result, sdk };
}

const nonGet = (srv) => srv.writes.map((w) => w.verb);
const bodyOf = (srv, rowId) => srv.writes.filter((w) => w.url.toLowerCase().includes(rowId)).map((w) => w.body);

function baseCommands() {
  return [
    { entity: 'account', key: 'approve', label: 'Approve', library: 'cr_lib', function: 'Contoso.approve', hidden: false, disabled: false },
    { entity: 'account', key: 'more', type: 'FlyoutAnchor', label: 'More', children: [
      { key: 'export', label: 'Export', library: 'cr_lib', function: 'Contoso.export' },
    ] },
  ];
}

test('a new keyed bar is created with ids from the creation port and explicit false flags on the wire', async () => {
  const srv = createCommandBarServer();
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  const { result } = await reconcile(srv, baseCommands(), ports);
  assert.deepStrictEqual(result.refused, []);
  assert.deepStrictEqual(result.unknown, []);
  assert.strictEqual(ports.creates.calls.length, 1, 'one creation operation for the table');
  const minted = ports.creates.calls[0].ids.childIds;
  assert.deepStrictEqual(Object.keys(minted).sort(), ['approve', 'more', 'more/export']);
  // The rows POSTed carry exactly the ids the port recorded before the push.
  for (const id of Object.values(minted)) assert.ok(srv.rows.has(id), `row ${id} was created with the recorded id`);
  const approve = srv.writes.find((w) => w.verb === 'post' && w.body.appactionid === minted.approve).body;
  assert.strictEqual(approve.hidden, false, 'explicit hidden:false reaches the wire');
  assert.strictEqual(approve.isdisabled, false, 'explicit disabled:false reaches the wire');
  assert.strictEqual(approve.onclickeventjavascriptparameters, DEFAULTS.MainTab, 'the bar default parameters are used when the spec states none');
  assert.deepStrictEqual(result.managedBindings.map((b) => [b.key, b.id, b.origin]).sort(), [
    ['account/approve', minted.approve, 'created'],
    ['account/more', minted.more, 'created'],
    ['account/more/export', minted['more/export'], 'created'],
  ].sort());
  assert.strictEqual(result.managedBindings.find((b) => b.key === 'account/more/export').parentKey, 'account/more');
  assert.ok(nonGet(srv).every((v) => v === 'post'), 'a first build only creates');
});

test('the legacy builder drops an explicit false — the managed path is what sends it (neighbour pin)', () => {
  const def = commandDef('account', [{ entity: 'account', label: 'X', hidden: false, disabled: false }], {});
  const control = def.commandBars[0].groups[0].controls[0];
  assert.strictEqual('hidden' in control, false);
  assert.strictEqual('disabled' in control, false);
});

test('a second run with nothing changed sends no write at all', async () => {
  const srv = createCommandBarServer();
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  await reconcile(srv, baseCommands(), ports);
  srv.clearLog();
  const { result } = await reconcile(srv, baseCommands(), ports);
  assert.deepStrictEqual(nonGet(srv), [], 'no PATCH, POST or DELETE on a no-op');
  assert.strictEqual(result.saved.length, 0);
  assert.strictEqual(result.unchanged.length, 3);
  assert.strictEqual(ports.creates.calls.length, 1, 'no second creation operation');
});

test('rename, new function, new parameters and disabled true->false keep the row id and are written', async () => {
  const srv = createCommandBarServer();
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  const first = baseCommands();
  first[0].disabled = true;
  await reconcile(srv, first, ports);
  const id = ports.managed.lookup('command', 'account/approve').id;
  assert.strictEqual(srv.rows.get(id).isdisabled, true);
  srv.clearLog();
  const next = baseCommands();
  next[0].label = 'Approve now';
  next[0].function = 'Contoso.approveNow';
  next[0].parameters = '[{"type":5,"value":null},{"type":12,"value":null}]';
  next[0].disabled = false;
  const { result } = await reconcile(srv, next, ports);
  assert.deepStrictEqual(result.refused, []);
  assert.ok(!nonGet(srv).includes('post') && !nonGet(srv).includes('delete'), `only PATCHes: ${nonGet(srv)}`);
  const patch = bodyOf(srv, id).find((b) => b && b.buttonlabeltext);
  assert.strictEqual(patch.buttonlabeltext, 'Approve now');
  assert.strictEqual(patch.onclickeventjavascriptfunctionname, 'Contoso.approveNow');
  assert.strictEqual(patch.onclickeventjavascriptparameters, next[0].parameters);
  assert.strictEqual(patch.isdisabled, false, 'the transition to enabled is sent as an explicit false');
  assert.strictEqual(srv.rows.get(id).buttonlabeltext, 'Approve now');
  assert.strictEqual(ports.managed.lookup('command', 'account/approve').id, id, 'the binding still names the same row');
  assert.deepStrictEqual(result.saved.map((s) => s.key), ['account/approve']);
});

test('two controls with the same caption stay two rows; editing one leaves the other', async () => {
  const srv = createCommandBarServer();
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  const cmds = [
    { entity: 'account', key: 'a', label: 'Send', library: 'cr_lib', function: 'C.sendA' },
    { entity: 'account', key: 'b', label: 'Send', library: 'cr_lib', function: 'C.sendB' },
  ];
  await reconcile(srv, cmds, ports);
  const a = ports.managed.lookup('command', 'account/a').id;
  const b = ports.managed.lookup('command', 'account/b').id;
  assert.notStrictEqual(a, b);
  srv.clearLog();
  cmds[1].label = 'Send later';
  await reconcile(srv, cmds, ports);
  assert.strictEqual(srv.rows.get(a).buttonlabeltext, 'Send');
  assert.strictEqual(srv.rows.get(b).buttonlabeltext, 'Send later');
});

test('a foreign control on the bar is kept (never deleted, its caption untouched)', async () => {
  const srv = createCommandBarServer();
  srv.seed({ appactionid: 'f0f0f0f0-0000-4000-8000-000000000001', buttonlabeltext: 'Theirs', location: 0, sequence: 0 });
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  await reconcile(srv, baseCommands(), ports);
  srv.clearLog();
  const next = baseCommands();
  next[0].label = 'Approve!';
  await reconcile(srv, next, ports);
  assert.ok(!nonGet(srv).includes('delete'), 'nothing is deleted');
  assert.strictEqual(srv.rows.get('f0f0f0f0-0000-4000-8000-000000000001').buttonlabeltext, 'Theirs');
});

test('changing an existing control\'s type or bar is refused with zero writes', async () => {
  for (const change of [(c) => { c[0].type = 'SplitButton'; }, (c) => { c[0].location = 'HomeTab'; }]) {
    const srv = createCommandBarServer();
    const ports = { managed: fakeManaged(), creates: fakeCreates() };
    await reconcile(srv, baseCommands(), ports);
    srv.clearLog();
    const next = baseCommands();
    next[0].label = 'Also renamed';
    change(next);
    const { result } = await reconcile(srv, next, ports);
    assert.deepStrictEqual(nonGet(srv), [], 'nothing on the bar is written');
    assert.ok(['command-immutable-type', 'command-immutable-location'].includes(result.refused[0].code), JSON.stringify(result.refused));
    assert.deepStrictEqual(result.saved, []);
  }
});

test('a new child under an existing flyout is created at the flyout\'s actual Location', async () => {
  const srv = createCommandBarServer();
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  const cmds = baseCommands();
  cmds[1].location = 'HomeTab';
  await reconcile(srv, cmds, ports);
  const flyout = ports.managed.lookup('command', 'account/more').id;
  assert.strictEqual(srv.rows.get(flyout).location, 1);
  srv.clearLog();
  cmds[1].children.push({ key: 'print', label: 'Print', library: 'cr_lib', function: 'Contoso.print' });
  const { result } = await reconcile(srv, cmds, ports);
  assert.deepStrictEqual(result.refused, []);
  const printId = ports.managed.lookup('command', 'account/more/print').id;
  assert.strictEqual(srv.rows.get(printId).location, 1, 'the child is stored at its parent\'s Location');
  assert.deepStrictEqual(nonGet(srv).filter((v) => v === 'post').length, 1, 'only the new child is created');
});

test('validation: a child stating another bar, mixed keyed/unkeyed, duplicate keys and positions are errors', () => {
  const { errors } = validateManagedCommands({ commands: [
    { entity: 'account', key: 'm', type: 'FlyoutAnchor', location: 'HomeTab', children: [{ key: 'c', location: 'MainTab' }] },
    { entity: 'account', label: 'unkeyed' },
    { entity: 'account', key: 'm' },
    { entity: 'account', key: 'p', position: 0 },
    { entity: 'contact', label: 'legacy', rowId: '11111111-1111-1111-1111-111111111111' },
  ] });
  const text = errors.join('\n');
  assert.match(text, /served only at its parent's location/);
  assert.match(text, /every command on a table with keyed commands needs a key/);
  assert.match(text, /used twice/);
  assert.match(text, /position in an existing bar is not supported/);
  assert.match(text, /rowId is only allowed on a command that has a key/);
  assert.deepStrictEqual(validateManagedCommands({ commands: [{ entity: 'account', label: 'Old' }] }).errors, [], 'an unkeyed spec is valid and untouched');
});

test('an unkeyed (legacy) table is not managed: no read and no write', async () => {
  const srv = createCommandBarServer();
  const sdk = await srv.newSdk();
  const cmds = [{ entity: 'account', label: 'Old' }];
  assert.strictEqual(isManagedEntity(cmds), false);
  const plan = await planCommandReconcile({ entity: 'account', commands: cmds, sdk, webResources: WEB, defaultParameters: DEFAULTS }, {});
  const result = await applyCommandReconcile(plan, { sdk }, {});
  assert.strictEqual(plan.managed, false);
  assert.deepStrictEqual(srv.reads.filter((u) => /appactions/i.test(u)), []);
  assert.deepStrictEqual(nonGet(srv), []);
  assert.deepStrictEqual(result.saved, []);
});

test('adoption: a single context match needs approval, rowId adopts, several matches refuse', async () => {
  const seedTwo = (srv, n) => {
    for (let i = 1; i <= n; i += 1) {
      srv.seed({ appactionid: `a0a0a0a0-0000-4000-8000-00000000000${i}`, buttonlabeltext: `Old ${i}`, location: 0, sequence: i,
        onclickeventtype: 2, onclickeventjavascriptfunctionname: 'Contoso.approve', _onclickeventjavascriptwebresourceid_value: WR,
        onclickeventjavascriptparameters: DEFAULTS.MainTab });
    }
  };
  const cmd = [{ entity: 'account', key: 'approve', label: 'Approve', library: 'cr_lib', function: 'Contoso.approve' }];

  let srv = createCommandBarServer();
  seedTwo(srv, 1);
  let ports = { managed: fakeManaged(), creates: fakeCreates() };
  let { result } = await reconcile(srv, cmd, ports);
  assert.strictEqual(result.refused[0].code, 'command-adoption-not-authorized');
  assert.deepStrictEqual(nonGet(srv), []);
  ({ result } = await reconcile(srv, cmd, ports, { authorizedAdoption: true }));
  assert.deepStrictEqual(result.refused, []);
  assert.strictEqual(ports.managed.lookup('command', 'account/approve').id, 'a0a0a0a0-0000-4000-8000-000000000001');
  assert.strictEqual(ports.managed.lookup('command', 'account/approve').origin, 'adopted');
  assert.strictEqual(srv.rows.get('a0a0a0a0-0000-4000-8000-000000000001').buttonlabeltext, 'Approve', 'the adopted row is renamed, not replaced');
  assert.strictEqual(ports.creates.calls.length, 0, 'adoption creates nothing');

  srv = createCommandBarServer();
  seedTwo(srv, 2);
  ports = { managed: fakeManaged(), creates: fakeCreates() };
  ({ result } = await reconcile(srv, cmd, ports, { authorizedAdoption: true }));
  assert.strictEqual(result.refused[0].code, 'command-adoption-ambiguous');
  assert.deepStrictEqual(nonGet(srv), []);
  ({ result } = await reconcile(srv, [{ ...cmd[0], rowId: '{A0A0A0A0-0000-4000-8000-000000000002}' }], ports));
  assert.deepStrictEqual(result.refused, []);
  assert.strictEqual(ports.managed.lookup('command', 'account/approve').id, 'a0a0a0a0-0000-4000-8000-000000000002');
});

test('drift: an owned field changed outside the spec is refused unless approved; a converged one is accepted', async () => {
  const srv = createCommandBarServer();
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  await reconcile(srv, baseCommands(), ports);
  const id = ports.managed.lookup('command', 'account/approve').id;
  srv.rows.get(id).buttonlabeltext = 'Edited in the designer';
  srv.clearLog();
  const next = baseCommands();
  next[0].label = 'Approve v2';
  let { result } = await reconcile(srv, next, ports);
  assert.strictEqual(result.refused[0].code, 'command-drift');
  assert.deepStrictEqual(nonGet(srv), []);
  ({ result } = await reconcile(srv, next, ports, { authorizedOverwrite: new Set(['account/approve']) }));
  assert.deepStrictEqual(result.refused, []);
  assert.strictEqual(srv.rows.get(id).buttonlabeltext, 'Approve v2');
  // Converged: the server was changed to exactly what the spec now says — nothing to write.
  srv.rows.get(id).buttonlabeltext = 'Approve v3';
  srv.clearLog();
  next[0].label = 'Approve v3';
  ({ result } = await reconcile(srv, next, ports));
  assert.deepStrictEqual(result.refused, []);
  assert.deepStrictEqual(nonGet(srv), []);
});

test('a bound row that disappeared is refused, not silently recreated', async () => {
  const srv = createCommandBarServer();
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  await reconcile(srv, baseCommands(), ports);
  srv.rows.delete(ports.managed.lookup('command', 'account/approve').id);
  srv.clearLog();
  const { result } = await reconcile(srv, baseCommands(), ports);
  assert.strictEqual(result.refused[0].code, 'command-bound-row-missing');
  assert.deepStrictEqual(nonGet(srv), []);
});

test('a pending unknown creation for the table refuses without writing; no creation port refuses new controls', async () => {
  const srv = createCommandBarServer();
  let { result } = await reconcile(srv, baseCommands(), { managed: fakeManaged(), creates: fakeCreates({ pendingUnknown: ['account'] }) });
  assert.strictEqual(result.refused[0].code, 'creation-pending-unknown');
  assert.deepStrictEqual(nonGet(srv), []);
  ({ result } = await reconcile(srv, baseCommands(), { managed: fakeManaged(), creates: undefined }));
  assert.ok(result.refused.every((r) => r.code === 'creation-port-unavailable') && result.refused.length === 3);
  assert.deepStrictEqual(nonGet(srv), []);
  const sdk = await srv.newSdk();
  const plan = await planCommandReconcile({ entity: 'account', commands: baseCommands(), sdk, webResources: WEB, defaultParameters: DEFAULTS }, {});
  assert.strictEqual(plan.refused[0].code, 'managed-binding-port-unavailable');
});

test('the expected inspection queries verify managed controls by row id, and the real inspection agrees', async () => {
  const srv = createCommandBarServer();
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  const cmds = baseCommands();
  cmds[1].children[0].disabled = true;
  const { sdk } = await reconcile(srv, cmds, ports);
  const queries = expectedCommandQueries('account', cmds, (k) => ports.managed.lookup('command', k));
  // `more` states no disabled flag, so the spec cannot say whether it is served: unconstrained.
  assert.deepStrictEqual(queries.map((q) => [q.key, q.query.surface, q.query.menuPath, q.query.kind, q.expect.served]), [
    ['account/approve', 'form', [], 'button', true],
    ['account/more', 'form', [], 'flyout', undefined],
    ['account/more/export', 'form', ['More'], 'button', false],
  ]);
  const inspection = await sdk.inspectArtifact('command', 'account', { find: queries.map((q) => q.query) });
  const verdicts = inspection.found.map((f) => [f.identity, f.verdict]);
  assert.deepStrictEqual(verdicts.slice(0, 2), [['row', 'present'], ['row', 'present']]);
  assert.strictEqual(verdicts[2][0], 'row');
  assert.notStrictEqual(verdicts[2][1], 'present', 'a control stored disabled is not served, so it does not verify as present');
  assert.ok(inspection.found[2].elsewhere.includes(queries[2].query.rowId), 'the disabled row is proved elsewhere, not missing');
  assert.deepStrictEqual(queries.filter((q) => q.key === 'account/none'), []);
});

test('context adoption matches the action parameters: a row calling the same handler with other parameters is not adopted', async () => {
  const foreign = 'a1a1a1a1-0000-4000-8000-000000000001';
  const previous = '[{"type":1,"value":"FOREIGN_ACTION"}]';
  const desired = '[{"type":1,"value":"OWN_ACTION"}]';
  const seed = (srv, params) => srv.seed({ appactionid: foreign, buttonlabeltext: 'Foreign', location: 0, sequence: 0, onclickeventtype: 2,
    _onclickeventjavascriptwebresourceid_value: WR, onclickeventjavascriptfunctionname: 'Contoso.dispatch', onclickeventjavascriptparameters: params });
  const cmd = [{ entity: 'account', key: 'own', label: 'Owned', library: 'cr_lib', function: 'Contoso.dispatch', parameters: desired }];

  let srv = createCommandBarServer();
  seed(srv, previous);
  let ports = { managed: fakeManaged(), creates: fakeCreates() };
  let { result } = await reconcile(srv, cmd, ports, { authorizedAdoption: true });
  assert.deepStrictEqual(result.refused, []);
  assert.strictEqual(srv.rows.get(foreign).onclickeventjavascriptparameters, previous, 'the foreign row keeps its parameters');
  assert.strictEqual(srv.rows.get(foreign).buttonlabeltext, 'Foreign', 'the foreign row keeps its caption');
  assert.notStrictEqual(ports.managed.lookup('command', 'account/own').id, foreign, 'the spec key is not bound to the foreign row');
  assert.strictEqual(ports.creates.calls.length, 1, 'a new control is created instead');

  // Neighbour: the same parameters ARE the same context, so an approved adoption still adopts it.
  srv = createCommandBarServer();
  seed(srv, desired);
  ports = { managed: fakeManaged(), creates: fakeCreates() };
  ({ result } = await reconcile(srv, cmd, ports, { authorizedAdoption: true }));
  assert.deepStrictEqual(result.refused, []);
  assert.strictEqual(ports.managed.lookup('command', 'account/own').id, foreign);
  assert.strictEqual(ports.creates.calls.length, 0);
});

test('verification does not invent false for an omitted flag: a preserved disabled/hidden row is not required to be served', async () => {
  const id = 'a2a2a2a2-0000-4000-8000-000000000001';
  const srv = createCommandBarServer();
  srv.seed({ appactionid: id, buttonlabeltext: 'Existing', location: 0, sequence: 0, hidden: true, isdisabled: true });
  const ports = { managed: fakeManaged(), creates: fakeCreates() };
  const cmds = [{ entity: 'account', key: 'existing', rowId: id, label: 'Existing' }];
  await reconcile(srv, cmds, ports);
  assert.strictEqual(srv.rows.get(id).isdisabled, true, 'the omitted flag kept the stored value');
  const [q] = expectedCommandQueries('account', cmds, (k) => ports.managed.lookup('command', k));
  assert.notStrictEqual(q.expect.served, true, 'served is not invented from an omitted disabled flag');
  assert.strictEqual(q.expect.served, undefined);
  assert.strictEqual(q.expect.hidden, undefined, 'hidden is not invented either');
  assert.strictEqual(q.expect.ancestorHidden, false, 'a top-level control has no hidden ancestor');
  // An ancestor that states nothing leaves its children's ancestorHidden unconstrained too.
  const nested = expectedCommandQueries('account', [{ key: 'm', type: 'FlyoutAnchor', children: [{ key: 'c', hidden: false, disabled: false }] }], () => ({ id }));
  assert.deepStrictEqual(nested[1].expect, { served: undefined, hidden: false, ancestorHidden: undefined });
});

test('a lost create resolved by adoption binds the named rows, writes nothing, and the next run reconciles them', async () => {
  const id = 'a3a3a3a3-0000-4000-8000-000000000001';
  const srv = createCommandBarServer();
  // The row the lost send made (it reached the service before its answer was lost).
  srv.seed({ appactionid: id, buttonlabeltext: 'Approve', location: 0, sequence: 0 });
  const cmds = [{ entity: 'account', key: 'approve', label: 'Approve', library: 'cr_lib', function: 'Contoso.approve' }];
  const managed = fakeManaged();
  const creates = fakeCreates({ pendingUnknown: ['account'], adopt: { account: { id: 'ignored', childIds: { approve: id } } } });
  let { result } = await reconcile(srv, cmds, { managed, creates });
  assert.deepStrictEqual(nonGet(srv), [], 'an adopt resolution writes nothing');
  assert.deepStrictEqual(result.refused.map((r) => r.code), ['creation-adopted-rerun']);
  assert.deepStrictEqual(result.managedBindings.map((b) => [b.key, b.id]), [['account/approve', id]]);
  srv.clearLog();
  ({ result } = await reconcile(srv, [{ ...cmds[0], label: 'Approve now' }], { managed, creates: fakeCreates() }));
  assert.deepStrictEqual(result.refused, []);
  assert.strictEqual(srv.rows.get(id).buttonlabeltext, 'Approve now', 'the bound row is edited, not duplicated');
  assert.ok(!nonGet(srv).includes('post'));
});
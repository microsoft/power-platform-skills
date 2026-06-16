// Tests for the relay tool handlers (scripts/relay/handlers.js).
// Run: node --test plugins/model-apps/scripts/tests/relay-handlers.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { makeHandlers, toToolResult } = require(path.join(__dirname, '..', 'relay', 'handlers.js'));
const { Serializer } = require(path.join(__dirname, '..', 'relay', 'serialize.js'));

function mockDriver() {
  const calls = [];
  return {
    calls,
    async goto(url) { calls.push(['goto', url]); },
    async inject() { calls.push(['inject']); },
    async waitReady() { calls.push(['waitReady']); return { ok: true, source: 'fiber' }; },
    async call(method, args) { calls.push(['call', method, args]); return { ok: true, method }; },
    async status() { calls.push(['status']); return { ok: true, source: 'fiber' }; },
  };
}

test('open() navigates, injects, and waits for the designer', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  const r = await h.open({ url: 'https://example/form' });
  assert.deepStrictEqual(r, { ok: true, source: 'fiber' });
  assert.deepStrictEqual(d.calls, [['goto', 'https://example/form'], ['inject'], ['waitReady']]);
});

test('inspect() delegates to driver.call("inspect", [])', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  const r = await h.inspect();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(d.calls, [['call', 'inspect', []]]);
});

test('addField() forwards field/section/force to the bridge', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.addField({ fieldLogicalName: 'telephone1', targetSectionId: 'S1' });
  await h.addField({ fieldLogicalName: 'fax', targetSectionId: 'S2', force: true });
  assert.deepStrictEqual(d.calls, [
    ['call', 'addField', ['telephone1', 'S1', false]],
    ['call', 'addField', ['fax', 'S2', true]],
  ]);
});

test('listControls() forwards the field to the bridge (read-only)', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.listControls({ fieldLogicalName: 'name' });
  await h.listControls({});
  assert.deepStrictEqual(d.calls, [
    ['call', 'listControls', ['name']],
    ['call', 'listControls', [undefined]],
  ]);
});

test('describeControl() forwards the control id', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.describeControl({ controlId: 'X.Y' });
  assert.deepStrictEqual(d.calls, [['call', 'describeControl', ['X.Y']]]);
});

test('setControl() forwards field/control/params/factors (null-normalized)', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.setControl({ fieldLogicalName: 'name', controlId: 'X.Y' });
  await h.setControl({ fieldLogicalName: 'name', controlId: 'X.Y', params: { a: 1 }, formFactors: ['Web'] });
  assert.deepStrictEqual(d.calls, [
    ['call', 'setControl', ['name', 'X.Y', null, null]],
    ['call', 'setControl', ['name', 'X.Y', { a: 1 }, ['Web']]],
  ]);
});

test('addComponent() forwards control/section/params/factors', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.addComponent({ controlId: 'X.Y', targetSectionId: 'S1' });
  await h.addComponent({ controlId: 'X.Y', targetSectionId: 'S1', params: { a: 1 }, formFactors: ['Web'] });
  assert.deepStrictEqual(d.calls, [
    ['call', 'addComponent', ['X.Y', 'S1', null, null]],
    ['call', 'addComponent', ['X.Y', 'S1', { a: 1 }, ['Web']]],
  ]);
});

test('getControl() forwards the field to the bridge (read-only)', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.getControl({ fieldLogicalName: 'name' });
  assert.deepStrictEqual(d.calls, [['call', 'getControl', ['name']]]);
});

test('removeControl/setFieldProps/moveControl/addSubgrid handlers forward to the bridge', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.removeControl({ fieldLogicalName: 'fax' });
  await h.setFieldProps({ fieldLogicalName: 'telephone1', props: { visible: false } });
  await h.moveControl({ fieldLogicalName: 'telephone1', targetElementId: 'SEC2', position: 'after' });
  await h.addSubgrid({ targetSectionId: 'SEC1', entity: 'contact', relationshipName: 'rel' });
  assert.deepStrictEqual(d.calls, [
    ['call', 'removeControl', ['fax']],
    ['call', 'setFieldProps', ['telephone1', { visible: false }]],
    ['call', 'moveControl', ['telephone1', 'SEC2', 'after']],
    ['call', 'addSubgrid', ['SEC1', 'contact', { relationshipName: 'rel', viewId: undefined, recordsPerPage: undefined, displayName: undefined }]],
  ]);
});

test('addTab/addSection handlers forward to the bridge', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.addTab({ columns: 2, displayName: 'Details' });
  await h.addSection({ targetElementId: 'SEC1', columns: 3 });
  assert.deepStrictEqual(d.calls, [
    ['call', 'addTab', [null, 2, 'Details']],
    ['call', 'addSection', ['SEC1', 3, null]],
  ]);
});

test('addColumn/addEventHandler handlers forward to the bridge', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.addColumn({ sectionId: 'S1', columns: 3 });
  await h.addEventHandler({ target: 'form', eventType: 'onload', library: 'lib.js', functionName: 'ns.onLoad' });
  assert.deepStrictEqual(d.calls, [
    ['call', 'addColumn', ['S1', 3]],
    ['call', 'addEventHandler', ['form', { eventType: 'onload', library: 'lib.js', functionName: 'ns.onLoad', enabled: undefined, passExecutionContext: undefined, parameters: undefined }]],
  ]);
});

test('addLibrary handler forwards to the bridge', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.addLibrary({ libraryName: 'new_myscript' });
  assert.deepStrictEqual(d.calls, [['call', 'addLibrary', ['new_myscript']]]);
});

test('save() handler is gated by MM_ALLOW_SAVE (operator opt-in)', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  const prev = process.env.MM_ALLOW_SAVE;
  delete process.env.MM_ALLOW_SAVE;
  const blocked = await h.save();
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error.code, 'save-disabled');
  assert.deepStrictEqual(d.calls, []);
  process.env.MM_ALLOW_SAVE = '1';
  await h.save();
  assert.deepStrictEqual(d.calls, [['call', 'save', []]]);
  if (prev === undefined) delete process.env.MM_ALLOW_SAVE; else process.env.MM_ALLOW_SAVE = prev;
});

test('publish() handler is gated by MM_ALLOW_PUBLISH (operator opt-in)', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  const prev = process.env.MM_ALLOW_PUBLISH;
  delete process.env.MM_ALLOW_PUBLISH;
  assert.strictEqual((await h.publish()).error.code, 'publish-disabled');
  assert.deepStrictEqual(d.calls, []);
  process.env.MM_ALLOW_PUBLISH = '1';
  await h.publish();
  assert.deepStrictEqual(d.calls, [['call', 'publish', []]]);
  if (prev === undefined) delete process.env.MM_ALLOW_PUBLISH; else process.env.MM_ALLOW_PUBLISH = prev;
});

test('setFormProps/removeElement/undo/redo handlers forward to the bridge', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  await h.setFormProps({ props: { name: 'X' } });
  await h.removeElement({ elementId: 'SEC-9' });
  await h.undo();
  await h.redo();
  assert.deepStrictEqual(d.calls, [
    ['call', 'setFormProps', [{ name: 'X' }]],
    ['call', 'removeElement', ['SEC-9']],
    ['call', 'undo', []],
    ['call', 'redo', []],
  ]);
});

test('status() delegates to driver.status()', async () => {
  const d = mockDriver();
  const h = makeHandlers(d);
  const r = await h.status();
  assert.deepStrictEqual(r, { ok: true, source: 'fiber' });
});

test('handlers serialize designer ops (one in flight at a time)', async () => {
  const order = [];
  const driver = {
    async call(method) {
      order.push('start:' + method);
      await new Promise((r) => setTimeout(r, method === 'inspect' ? 25 : 1));
      order.push('end:' + method);
      return { ok: true };
    },
    async status() { return { ok: true }; },
  };
  const h = makeHandlers(driver, new Serializer());
  await Promise.all([h.inspect(), h.addField({ fieldLogicalName: 'x', targetSectionId: 'S1' })]);
  assert.deepStrictEqual(order, ['start:inspect', 'end:inspect', 'start:addField', 'end:addField']);
});

test('toToolResult wraps ok and flags isError on ok:false', () => {
  const okR = toToolResult({ ok: true, result: 1 });
  assert.strictEqual(okR.isError, false);
  assert.strictEqual(okR.content[0].type, 'text');
  assert.deepStrictEqual(JSON.parse(okR.content[0].text), { ok: true, result: 1 });

  const errR = toToolResult({ ok: false, error: { code: 'x' } });
  assert.strictEqual(errR.isError, true);
});

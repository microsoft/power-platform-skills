// Tests for the model-maker relay bridge (scripts/relay/bridge.js).
// Run: node --test plugins/model-apps/scripts/tests/relay-bridge.test.js
//
// bridge.js is the JS injected into the live form-designer page. It reads the
// ambient `window`/`document` at call time, so we exercise it by setting those
// globals to fakes and re-requiring the module.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const BRIDGE = path.join(__dirname, '..', 'relay', 'bridge.js');

// Re-load bridge.js against a given fake window/document. Restores globals after.
function withBridge({ win, doc }, fn) {
  const prevWin = global.window;
  const prevDoc = global.document;
  if (win !== undefined) global.window = win; else delete global.window;
  if (doc !== undefined) global.document = doc; else delete global.document;
  delete require.cache[require.resolve(BRIDGE)];
  try {
    const mod = require(BRIDGE);
    return fn(mod);
  } finally {
    global.window = prevWin;
    global.document = prevDoc;
    delete require.cache[require.resolve(BRIDGE)];
  }
}

function fakeService(overrides = {}) {
  return Object.assign({
    addFieldOnConfirm() {},
    onElementMetadataChange() {},
    formModel: { formType: 2, tabs: [], visit() {} },
    store: { getState() {}, dispatch() {}, subscribe() {} },
  }, overrides);
}

test('getDesignerHandle prefers window.__formDesignerApi (source=export)', () => {
  const svc = fakeService();
  withBridge(
    { win: { __formDesignerApi: { service: svc, store: svc.store } }, doc: { getElementById: () => null } },
    (mod) => {
      const h = mod.__test.getDesignerHandle();
      assert.ok(h, 'handle should be found');
      assert.strictEqual(h.service, svc);
      assert.strictEqual(h.source, 'export');
    }
  );
});

test('getDesignerHandle falls back to a fiber walk (source=fiber)', () => {
  const svc = fakeService();
  const serviceFiber = { memoizedProps: { value: svc }, child: null, sibling: null };
  const rootFiber = { memoizedProps: {}, child: serviceFiber, sibling: null };
  const root = { _reactRootContainer: { _internalRoot: { current: rootFiber } } };
  withBridge(
    { win: {}, doc: { getElementById: (id) => (id === 'root' ? root : null) } },
    (mod) => {
      const h = mod.__test.getDesignerHandle();
      assert.ok(h, 'handle should be found via fiber walk');
      assert.strictEqual(h.service, svc);
      assert.strictEqual(h.source, 'fiber');
    }
  );
});

test('inspect returns sections (node name "section") and available unused fields', () => {
  const svc = fakeService({
    formModel: {
      formType: 2,
      visit(cb) {
        cb({ getNodeName: () => 'tab', id: { guidString: 'T1' } });
        cb({ getNodeName: () => 'section', id: { guidString: 'S1' } });
        cb({ getNodeName: () => 'section', id: { guidString: 'S2' } });
      },
    },
    formFieldService: {
      getModel: () => ({
        attributes: [
          { name: 'name', displayName: 'Account Name', isValidForForm: true },
          { name: 'telephone1', displayName: 'Phone', isValidForForm: true },
          { name: 'hidden1', displayName: 'Nope', isValidForForm: false },
        ],
      }),
      computeUsedFields: () => ['name'], // array, as the live designer returns
    },
  });
  withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, (mod) => {
    const r = mod.inspect();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.result.sections, [{ id: 'S1' }, { id: 'S2' }]);
    assert.deepStrictEqual(r.result.available, [{ name: 'telephone1', displayName: 'Phone' }]);
    assert.strictEqual(r.result.formType, 2);
  });
});

test('addField refuses a duplicate field unless force is set', async () => {
  let called = 0;
  const svc = fakeService({
    addFieldOnConfirm: () => { called++; },
    formFieldService: { computeUsedFields: () => ['telephone1'] },
  });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.addField('telephone1', 'S1');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.validation[0].code, 'duplicate-field');
    assert.strictEqual(called, 0, 'addFieldOnConfirm must not be called for a duplicate');
  });
});

test('addField calls addFieldOnConfirm for a new field and returns ok', async () => {
  const calls = [];
  const svc = fakeService({
    addFieldOnConfirm: (f, t, mode) => { calls.push([f, t, mode]); return {}; },
    formFieldService: { computeUsedFields: () => ['name'] },
  });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.addField('telephone1', 'S1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.fieldName, 'telephone1');
    assert.deepStrictEqual(calls, [['telephone1', 'S1', 'Click']]);
  });
});

test('status reports not-ok when no designer handle is available', () => {
  withBridge({ win: {}, doc: { getElementById: () => null } }, (mod) => {
    const s = mod.status();
    assert.strictEqual(s.ok, false);
    assert.strictEqual(s.source, null);
  });
});

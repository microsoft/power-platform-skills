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
    assert.deepStrictEqual(r.result.tabs, [{ id: 'T1' }]);
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

test('listControls returns env controls compatible with a field (read-only)', async () => {
  const calls = [];
  const ccmd = (name, displayName, dataTypes) => ({
    name,
    displayName, // a plain string here; the bridge also tolerates a Loadable {value}
    compatibleDataTypes: dataTypes,
    isBound: () => true,
    hasDatasetConfiguration: false,
  });
  const svc = fakeService({
    Environment: { name: 'org-983a1' },
    formFieldService: {
      getEntityAttribute: (n) => (n === 'name' ? { name: 'name', dataType: 'String', dataTypeFormat: 'Text', formatName: 'Text' } : null),
    },
    FormModelService: {
      customControlDiscoveryService: {
        getAllCompatibleControlsMetadata: (env, seed, dataType, dataFormat, formatName) => {
          calls.push([env, seed, dataType, dataFormat, formatName]);
          return Promise.resolve(new Map([
            ['MscrmControls.BusinessCard.BusinessCardControl', ccmd('MscrmControls.BusinessCard.BusinessCardControl', 'Business card reader', ['Text', 'Multiline'])],
            ['Microsoft.RichTextEditor', ccmd('Microsoft.RichTextEditor', 'Rich Text Editor Control', ['Text', 'Multiline'])],
          ]));
        },
      },
    },
  });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.listControls('name');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.field, 'name');
    assert.strictEqual(r.result.count, 2);
    assert.deepStrictEqual(r.result.controls.map((c) => c.displayName).sort(), ['Business card reader', 'Rich Text Editor Control']);
    // the field's data type gates compatibility -> forwarded to the discovery service
    assert.deepStrictEqual(calls[0], ['org-983a1', [], 'String', 'Text', 'Text']);
  });
});

test('listControls errors cleanly when the discovery service is unavailable', async () => {
  const svc = fakeService(); // no FormModelService.customControlDiscoveryService
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.listControls('name');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'no-discovery');
  });
});

test('describeControl returns binding kind + param schema from the manifest', async () => {
  const md = {
    name: 'Intelligence.BusinessCardReaderControl.BusinessCardReader',
    displayName: 'Business card reader',
    compatibleDataTypes: ['SingleLine.Text', 'Multiple'],
    isBound: () => true,
    hasDatasetConfiguration: false,
    configurations: new Map([
      ['DefaultImage', { name: 'DefaultImage', displayName: 'Default image', usage: 1, ofType: 'Multiple', isRequired: true, isPrimary: false }],
      ['Email', { name: 'Email', usage: 0, ofType: 'SingleLine.Email', isRequired: false, isPrimary: false }],
    ]),
  };
  const svc = fakeService({
    FormModelService: { customControlDiscoveryService: { getCustomControlMetadata: () => Promise.resolve(md) } },
  });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.describeControl('Intelligence.BusinessCardReaderControl.BusinessCardReader');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.bindingKind, 'fieldBound');
    assert.deepStrictEqual(r.result.requiredParams, ['DefaultImage']);
    assert.strictEqual(r.result.params.length, 2);
  });
});

test('describeControl classifies a dataset control from its metadata', async () => {
  const md = { name: 'Grid', compatibleDataTypes: ['Grid'], isBound: () => true, hasDatasetConfiguration: true, configurations: new Map() };
  const svc = fakeService({ FormModelService: { customControlDiscoveryService: { getCustomControlMetadata: () => Promise.resolve(md) } } });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.describeControl('Grid');
    assert.strictEqual(r.result.bindingKind, 'dataset');
  });
});

test('setControl reports needs-facade when the first-party façade is absent', async () => {
  const svc = fakeService();
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.setControl('name', 'X.Y');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'needs-facade');
  });
});

test('setControl delegates to window.__formDesignerApi.addCustomControl when present', async () => {
  const calls = [];
  const svc = fakeService();
  const win = {
    __formDesignerApi: {
      service: svc,
      addCustomControl: (f, c, p, ff) => { calls.push([f, c, p, ff]); return Promise.resolve({ ok: true, result: { field: f, controlId: c } }); },
    },
  };
  await withBridge({ win, doc: {} }, async (mod) => {
    const r = await mod.setControl('name', 'X.Y');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.source, 'facade');
    assert.deepStrictEqual(calls, [['name', 'X.Y', null, null]]);
  });
});

test('addComponent reports needs-facade when the façade is absent', async () => {
  const svc = fakeService();
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.addComponent('MscrmControls.PowerBIPCFControl', 'S1');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'needs-facade');
  });
});

test('addComponent delegates to window.__formDesignerApi.addComponent (params forwarded)', async () => {
  const calls = [];
  const svc = fakeService();
  const win = {
    __formDesignerApi: {
      service: svc,
      addComponent: (id, sec, p, ff) => { calls.push([id, sec, p, ff]); return Promise.resolve({ ok: true, result: { controlId: id, targetSectionId: sec, appliedParams: [{ name: 'FilterPaneVisible', value: 'true', bound: false }] } }); },
    },
  };
  await withBridge({ win, doc: {} }, async (mod) => {
    const r = await mod.addComponent('MscrmControls.PowerBIPCFControl', 'S1', { FilterPaneVisible: 'true' }, ['Web']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, 'facade');
    assert.deepStrictEqual(calls, [['MscrmControls.PowerBIPCFControl', 'S1', { FilterPaneVisible: 'true' }, ['Web']]]);
  });
});

test('getControl reports the cell control class id + applied custom controls', () => {
  const svc = fakeService({
    formModel: {
      formType: 2,
      visit(cb) {
        cb({ getNodeName: () => 'section', id: { guidString: 'S1' } });
        cb({ getNodeName: () => 'cell', control: { dataFieldName: 'name', UniqueId: 'u1', ClassId: { guidString: 'custom-control-guid' } } });
      },
      getControlDescriptionByForControl: (uid) => (uid === 'u1'
        ? { customControls: [{ customControlName: 'Intelligence.BusinessCardReaderControl.BusinessCardReader', formFactor: 0 }] }
        : null),
    },
  });
  withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, (mod) => {
    const r = mod.getControl('name');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.classId, 'custom-control-guid');
    assert.strictEqual(r.result.customControls[0].name, 'Intelligence.BusinessCardReaderControl.BusinessCardReader');
  });
});

test('getControl returns no-cell when the field is not placed', () => {
  const svc = fakeService({ formModel: { formType: 2, visit() {} } });
  withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, (mod) => {
    const r = mod.getControl('missing');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'no-cell');
  });
});

test('removeControl removes the field cell via removeElement (direct command)', async () => {
  const removed = [];
  const svc = fakeService({
    removeElement: (id) => { removed.push(id); return Promise.resolve(id); },
    formModel: { visit(cb) { cb({ getNodeName: () => 'cell', control: { dataFieldName: 'fax' }, id: { guidString: 'CELL-FAX' } }); } },
  });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.removeControl('fax');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(removed, ['CELL-FAX']);
  });
});

test('setFieldProps sets cell properties inside makeFormModelChange', async () => {
  const cell = { getNodeName: () => 'cell', control: { dataFieldName: 'telephone1' }, id: { guidString: 'C1' }, visible: true, setDisplayName(v) { this._label = v; } };
  const svc = fakeService({
    sessionInfo: { lCID: '1033' },
    makeFormModelChange: (fn) => { fn(); return Promise.resolve(); },
    formModel: { visit(cb) { cb(cell); } },
  });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.setFieldProps('telephone1', { label: 'Phone', visible: false });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(cell.visible, false);
    assert.strictEqual(cell._label, 'Phone');
    assert.deepStrictEqual(r.result.applied, { label: 'Phone', visible: false });
  });
});

test('moveControl moves the field cell via moveElement (direct command)', async () => {
  const moves = [];
  const svc = fakeService({
    moveElement: (src, tgt, ui, pos) => { moves.push([src, tgt, ui, pos]); return Promise.resolve(); },
    formModel: { visit(cb) { cb({ getNodeName: () => 'cell', control: { dataFieldName: 'telephone1' }, id: { guidString: 'C1' } }); } },
  });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.moveControl('telephone1', 'SEC2', 'after');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(moves, [['C1', 'SEC2', 'Click', 'after']]);
  });
});

test('addSubgrid reports needs-facade when the façade is absent', async () => {
  const svc = fakeService();
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.addSubgrid('SEC1', 'contact', { relationshipName: 'rel' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'needs-facade');
  });
});

test('addSubgrid delegates to window.__formDesignerApi.addSubgrid when present', async () => {
  const calls = [];
  const svc = fakeService();
  const win = { __formDesignerApi: { service: svc, addSubgrid: (sec, ent, o) => { calls.push([sec, ent, o]); return Promise.resolve({ ok: true, result: { entity: ent, targetSectionId: sec } }); } } };
  await withBridge({ win, doc: {} }, async (mod) => {
    const r = await mod.addSubgrid('SEC1', 'contact', { relationshipName: 'rel' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, 'facade');
    assert.deepStrictEqual(calls, [['SEC1', 'contact', { relationshipName: 'rel' }]]);
  });
});

test('addTab reports needs-facade when the façade is absent', async () => {
  const svc = fakeService();
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    assert.strictEqual((await mod.addTab(null, 2, 'Details')).error.code, 'needs-facade');
  });
});

test('addSection reports needs-facade when the façade is absent', async () => {
  const svc = fakeService();
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    assert.strictEqual((await mod.addSection('SEC1', 2, 'More')).error.code, 'needs-facade');
  });
});

test('addTab delegates to the first-party façade', async () => {
  const calls = [];
  const svc = fakeService();
  const win = { __formDesignerApi: { service: svc, addTab: (tgt, cols, name) => { calls.push([tgt, cols, name]); return Promise.resolve({ ok: true, result: { kind: 'tab' } }); } } };
  await withBridge({ win, doc: {} }, async (mod) => {
    const t = await mod.addTab(null, 2, 'Details');
    assert.strictEqual(t.ok, true);
    assert.strictEqual(t.source, 'facade');
    assert.deepStrictEqual(calls, [[null, 2, 'Details']]);
  });
});

test('addSection delegates to the first-party façade', async () => {
  const calls = [];
  const svc = fakeService();
  const win = { __formDesignerApi: { service: svc, addSection: (tgt, cols, name) => { calls.push([tgt, cols, name]); return Promise.resolve({ ok: true, result: { kind: 'section' } }); } } };
  await withBridge({ win, doc: {} }, async (mod) => {
    const s = await mod.addSection('SEC1', 3, 'More');
    assert.strictEqual(s.ok, true);
    assert.deepStrictEqual(calls, [['SEC1', 3, 'More']]);
  });
});

test('addColumn sets a section column count via setNewColumnCount', async () => {
  const calls = [];
  const section = { getNodeName: () => 'section', id: { guidString: 'S1' } };
  const svc = fakeService({
    makeFormModelChange: (fn) => { fn(); return Promise.resolve(); },
    formModel: { visit(cb) { cb(section); } },
    formCanvasService: { formElementServiceFactory: { getFormElementService: () => ({ setNewColumnCount: (node, c) => calls.push([node === section, c]) }) } },
  });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.addColumn('S1', 3);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.columns, 3);
    assert.deepStrictEqual(calls, [[true, 3]]);
  });
});

test('addColumn returns no-section when the id is not found', async () => {
  const svc = fakeService({ formModel: { visit() {} } });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    assert.strictEqual((await mod.addColumn('missing', 2)).error.code, 'no-section');
  });
});

test('addEventHandler adds a form-level handler via formEventsService', async () => {
  const calls = [];
  const svc = fakeService({
    formModel: { getNodeName: () => 'form', visit() {} },
    formEventsService: { addEventHandler: (opts, node) => { calls.push([opts, node]); return Promise.resolve(); } },
  });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.addEventHandler('form', { eventType: 'onload', library: 'lib.js', functionName: 'ns.onLoad' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls[0][0].functionName, 'ns.onLoad');
    assert.strictEqual(calls[0][0].executionContext, true);
    assert.strictEqual(calls[0][0].enabled, true);
  });
});

test('addEventHandler requires library + functionName', async () => {
  const svc = fakeService({ formEventsService: { addEventHandler: () => Promise.resolve() } });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    assert.strictEqual((await mod.addEventHandler('form', { eventType: 'onload' })).error.code, 'missing-args');
  });
});

test('setFormProps sets form node properties inside makeFormModelChange', async () => {
  const node = { getNodeName: () => 'form' };
  const svc = fakeService({ makeFormModelChange: (fn) => { fn(); return Promise.resolve(); }, formModel: node });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.setFormProps({ name: 'Account v2', maxWidth: 1600, showImage: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(node.formName, 'Account v2');
    assert.strictEqual(node.MaxWidth, '1600');
    assert.strictEqual(node.ShowImagecheck, true);
    assert.deepStrictEqual(r.result.applied, { name: 'Account v2', maxWidth: '1600', showImage: true });
  });
});

test('removeElement removes any element by id', async () => {
  const removed = [];
  const svc = fakeService({ removeElement: (id) => { removed.push(id); return Promise.resolve(); } });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.removeElement('TAB-1');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(removed, ['TAB-1']);
  });
});

test('undo calls the service undo', async () => {
  let called = 0;
  const svc = fakeService({ undo: () => { called++; return Promise.resolve(); } });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.undo();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(called, 1);
  });
});

test('save calls saveAsync and returns the form id', async () => {
  const svc = fakeService({ saveAsync: () => Promise.resolve('FORM-99') });
  await withBridge({ win: { __formDesignerApi: { service: svc } }, doc: {} }, async (mod) => {
    const r = await mod.save();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.formId, 'FORM-99');
  });
});

test('status reports not-ok when no designer handle is available', () => {
  withBridge({ win: {}, doc: { getElementById: () => null } }, (mod) => {
    const s = mod.status();
    assert.strictEqual(s.ok, false);
    assert.strictEqual(s.source, null);
  });
});

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runKernel } = require(path.join(__dirname, '..', 'lib', 'maker-kernel.js'));

test('runKernel builds a view via the vendored bundle', () => {
  const r = runKernel({ kind: 'buildView', spec: { entity: 'new_project', primaryId: 'new_projectid', columns: [{ name: 'new_name' }] } });
  assert.strictEqual(r.ok, true);
  assert.ok(String(r.fetchxml).includes('new_project'));
});

test('runKernel builds a form via the vendored bundle', () => {
  const r = runKernel({
    kind: 'buildForm',
    spec: { tabs: [{ label: 'General', sections: [{ label: 'Details', fields: [{ logicalName: 'name', type: 'string' }] }] }] },
    ctx: { formId: '{33333333-3333-3333-3333-333333333333}', entityName: 'account' },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(String(r.formxml).includes('datafieldname="name"'));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { verifySpec } = require('../lib/verify-spec.js');
const { readerFor } = require('../verify-model-app.js');

function spec() {
  return {
    solution: { publisherPrefix: 'new' },
    app: { name: 'Default Probe', uniqueName: 'new_defaultprobe' },
    entities: [{ schemaName: 'new_project', columns: [] }],
    views: [], charts: [], appShell: { areas: [] },
    forms: [
      { entity: 'new_project', name: 'Operations', formType: 'Main' },
      { entity: 'new_project', name: 'Manager', formType: 'Main', isDefault: true },
      { entity: 'new_project', name: 'Quick', formType: 'QuickCreate' },
    ],
  };
}

function readWith(defaultIds, failIds = new Set()) {
  const ids = { Operations: 'form-ops', Manager: 'form-manager', Quick: 'form-quick' };
  return {
    findTable: async () => ({ logicalName: 'new_project' }),
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set, opts) => {
      if (set !== 'systemform') return [];
      for (const [name, id] of Object.entries(ids)) {
        if (opts.filter.includes(`name eq '${name}'`)) return [{ formid: id }];
      }
      return [];
    },
    formDefaultState: async (_entity, formId) => {
      if (failIds.has(formId)) throw new Error(`cannot read ${formId}`);
      return { isDefault: defaultIds.has(formId) };
    },
  };
}

test('verifySpec fails when another spec-declared Main form is still default', async () => {
  const result = await verifySpec(spec(), readWith(new Set(['form-manager', 'form-ops'])));

  assert.strictEqual(result.ok, false);
  assert.ok(result.checks.some((c) => c.kind === 'form-default' && c.name === 'new_project.Manager' && c.present), 'the chosen form is default');
  const sibling = result.checks.find((c) => c.kind === 'form-default-unique' && c.name === 'new_project.Operations');
  assert.ok(sibling && sibling.present === false, JSON.stringify(result.checks.filter((c) => /^form-default/.test(c.kind))));
  assert.match(sibling.detail, /also default/);
});

test('verifySpec passes default-form uniqueness when only the selected Main form is default', async () => {
  const result = await verifySpec(spec(), readWith(new Set(['form-manager'])));

  assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
  assert.ok(result.checks.some((c) => c.kind === 'form-default-unique' && c.name === 'new_project.Operations' && c.present));
  assert.ok(!result.checks.some((c) => c.name === 'new_project.Quick' && c.kind === 'form-default-unique'), 'non-Main sibling is not part of the uniqueness check');
});

test('verifySpec reports sibling default-state read failures as failures', async () => {
  const result = await verifySpec(spec(), readWith(new Set(['form-manager']), new Set(['form-ops'])));

  assert.strictEqual(result.ok, false);
  const sibling = result.checks.find((c) => c.kind === 'form-default-unique' && c.name === 'new_project.Operations');
  assert.ok(sibling && sibling.present === false);
  assert.match(sibling.detail, /could not read deployed systemform\.isdefault/);
});

test('readerFor supplies sibling form default state through the real reader seam', async () => {
  const calls = [];
  const sdk = {
    findTables: async () => [{ logicalName: 'new_project' }],
    findColumns: async () => [],
    queryRecords: async (set, opts) => {
      calls.push({ set, opts });
      if (set !== 'systemform') return [];
      if (/name eq 'Operations'/.test(opts.filter)) return [{ formid: 'form-ops' }];
      if (/name eq 'Manager'/.test(opts.filter)) return [{ formid: 'form-manager' }];
      if (/name eq 'Quick'/.test(opts.filter)) return [{ formid: 'form-quick' }];
      if (/formid eq form-manager/.test(opts.filter)) return [{ formid: 'form-manager', isdefault: true }];
      if (/formid eq form-ops/.test(opts.filter)) return [{ formid: 'form-ops', isdefault: true }];
      return [];
    },
    fetchEntityMetadata: async () => ({ Relationships: [] }),
    resolveArtifact: async () => [],
    retrieveSetting: async () => null,
  };

  const result = await verifySpec(spec(), readerFor(sdk, 'new_defaultprobe', {}));

  assert.strictEqual(result.ok, false);
  assert.ok(result.missing.some((m) => m.kind === 'form-default-unique' && /also default/.test(m.detail)), JSON.stringify(result.missing));
  assert.ok(calls.some((c) => c.set === 'systemform' && /formid eq form-ops/.test(c.opts.filter) && c.opts.select.includes('isdefault')), 'sibling default proof reads systemform by id');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAppSpec } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');

function specWith(mainForms) {
  return {
    solution: { uniqueName: 'ContosoForms', publisherPrefix: 'contoso' },
    app: { name: 'Forms', ...(mainForms === undefined ? {} : { mainForms }) },
    entities: [{
      schemaName: 'contoso_item', displayName: 'Item', pluralName: 'Items',
      primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [],
    }],
    forms: [{ entity: 'contoso_item', name: 'Summary', layout: 'auto' }],
    views: [], charts: [],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
  };
}

test('app.mainForms accepts a non-empty list per navigation table and an empty map', () => {
  for (const mainForms of [undefined, {}, { CONTOSO_ITEM: ['summary'] }, { contoso_item: ['Information'] }]) {
    const result = validateAppSpec(specWith(mainForms), { profile: 'plan' });
    assert.equal(result.ok, true, result.errors.join('; '));
  }
});

test('app.mainForms rejects malformed maps, lists, duplicate tables and normalized form names', () => {
  for (const profile of ['design', 'plan', 'deploy']) {
    for (const mainForms of [
      null, [], 'Summary', { contoso_item: null }, { contoso_item: 'Summary' }, { contoso_item: [] },
      { contoso_item: [false] }, { contoso_item: [''] }, { contoso_item: ['   '] },
      { contoso_item: ['Summary', 'SUMMARY'] }, { contoso_item: ['Resume', 'R\u00e9sum\u00e9'] },
      { contoso_item: ['Summary'], CONTOSO_ITEM: ['Summary'] },
    ]) {
      const result = validateAppSpec(specWith(mainForms), { profile });
      assert.equal(result.ok, false, `${profile}: ${JSON.stringify(mainForms)} must be refused`);
      assert.match(result.errors.join('; '), /app\.mainForms/);
    }
  }
});

test('app.mainForms keys must name navigation Entity tables, not hidden or merely declared tables', () => {
  const spec = specWith({ task: ['Information'] });
  spec.app.tables = ['task'];
  const result = validateAppSpec(spec, { profile: 'plan' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /app\.mainForms.*task.*sitemap.*contoso_item/);
});

test('app.mainForms rejects ambiguous declared Main names without confusing other form types', () => {
  const spec = specWith({ contoso_item: ['Summary'] });
  spec.forms.push({ entity: 'contoso_item', name: 'SUMMARY', formType: 'QuickView', layout: 'auto' });
  assert.equal(validateAppSpec(spec, { profile: 'plan' }).ok, true);
  spec.forms.push({ entity: 'contoso_item', name: 'S\u00fcmmary', layout: 'auto' });
  const result = validateAppSpec(spec, { profile: 'plan' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /app\.mainForms.*ambiguous.*Main/);
});

test('a declared QuickView does not reject a potentially same-named stock Main form before catalog resolution', () => {
  const spec = specWith({ contoso_item: ['Information'] });
  spec.forms.push({ entity: 'contoso_item', name: 'Information', formType: 'QuickView', layout: 'auto' });
  assert.equal(validateAppSpec(spec, { profile: 'plan' }).ok, true);
});

test('structural validation ignores app.mainForms membership directives', () => {
  assert.equal(validateAppSpec(specWith({ task: [] }), { profile: 'structural' }).ok, true);
});

test('lint warns when the allow-list excludes the explicit default or first ordered Main form', () => {
  const spec = specWith({ contoso_item: ['Information'] });
  spec.forms[0].isDefault = true;
  spec.entities[0].mainFormOrder = ['Summary'];
  const warnings = lintAppSpec(spec).warnings;
  assert.ok(warnings.some((line) => /app\.mainForms.*Summary.*(default|mainFormOrder)/.test(line)), warnings.join('; '));
  spec.app.mainForms.contoso_item = ['SUMMARY'];
  assert.ok(!lintAppSpec(spec).warnings.some((line) => /app\.mainForms.*Summary.*(default|mainFormOrder)/.test(line)));
});

test('app.mainForms alone requires a 2.13 capability-floor lint advisory', () => {
  const spec = specWith({ contoso_item: ['Summary'] });
  assert.ok(lintAppSpec(spec).warnings.some((line) => /minimumPluginVersion.*2\.13\.0/.test(line)));
  spec.minimumPluginVersion = '2.13.0';
  assert.ok(!lintAppSpec(spec).warnings.some((line) => /minimumPluginVersion/.test(line)));
});

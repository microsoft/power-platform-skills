'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAppSpec } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');

function specWith(tables) {
  return {
    solution: { uniqueName: 'ContosoMembership', publisherPrefix: 'contoso' },
    app: { name: 'Membership', ...(tables === undefined ? {} : { tables }) },
    entities: [{
      schemaName: 'account', existing: true, displayName: 'Account',
      primaryAttribute: { schemaName: 'name', displayName: 'Name' }, columns: [],
    }],
    forms: [], views: [], charts: [],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'account', title: 'Accounts' }] }] }] },
  };
}

test('app.tables accepts hidden stock tables without declaring their schema', () => {
  for (const tables of [undefined, [], ['task', 'email'], ['account', 'task']]) {
    const result = validateAppSpec(specWith(tables), { profile: 'plan' });
    assert.equal(result.ok, true, result.errors.join('; '));
  }
});

test('app.tables rejects malformed lists and case-insensitive duplicates in every build profile', () => {
  for (const profile of ['design', 'plan', 'deploy']) {
    for (const tables of [null, 'task', {}, [null], [7], [''], ['   '], ['task', 'TASK']]) {
      const result = validateAppSpec(specWith(tables), { profile });
      assert.equal(result.ok, false, `${profile}: ${JSON.stringify(tables)} must be refused`);
      assert.match(result.errors.join('; '), /app\.tables/);
    }
  }
});

test('structural validation does not block teardown over app.tables directives', () => {
  const result = validateAppSpec(specWith(['task', 'TASK']), { profile: 'structural' });
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('lint warns when app.tables repeats a navigation table', () => {
  const result = lintAppSpec(specWith(['ACCOUNT', 'task']));
  assert.ok(result.warnings.some((line) => /app\.tables.*account.*already in the navigation/i.test(line)), result.warnings.join('; '));
  assert.ok(!result.warnings.some((line) => /task.*already in the navigation/i.test(line)));
});

test('membership fields warn without a 2.13 capability floor and retain the older-version refusal', () => {
  const spec = specWith(['task']);
  for (const floor of [undefined, '2.12.0', '2..13']) {
    if (floor === undefined) delete spec.minimumPluginVersion;
    else spec.minimumPluginVersion = floor;
    assert.ok(lintAppSpec(spec).warnings.some((line) => /minimumPluginVersion.*2\.13\.0/.test(line)), String(floor));
  }
  for (const floor of ['2.13.0', '2.13', '2.14.0', '3.0.0']) {
    spec.minimumPluginVersion = floor;
    assert.ok(!lintAppSpec(spec).warnings.some((line) => /minimumPluginVersion/.test(line)), floor);
  }

  // Simulate an installed 2.12 consumer without modifying either committed manifest.
  const fs = require('node:fs');
  const original = fs.readFileSync;
  const modulePath = require.resolve('../lib/app-spec.js');
  delete require.cache[modulePath];
  fs.readFileSync = function (file, ...args) {
    if (String(file).endsWith('plugin.json')) return '{"version":"2.12.0"}';
    return original.call(this, file, ...args);
  };
  try {
    const older = require('../lib/app-spec.js');
    spec.minimumPluginVersion = '2.13.0';
    const result = older.validateAppSpec(spec, { profile: 'plan' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /requires model-apps 2\.13\.0.*running plugin is 2\.12\.0/);
  } finally {
    fs.readFileSync = original;
    delete require.cache[modulePath];
  }
});

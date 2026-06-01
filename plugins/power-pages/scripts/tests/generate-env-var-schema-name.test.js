const test = require('node:test');
const assert = require('node:assert/strict');

const { generateSchemaName, sanitize } = require('../lib/generate-env-var-schema-name');

test('sanitize replaces non-alphanumeric chars with underscores', () => {
  assert.equal(sanitize('Authentication/Registration/LocalLoginEnabled'),
    'authentication_registration_localloginenabled');
  assert.equal(sanitize('Foo-Bar.Baz'), 'foo_bar_baz');
  assert.equal(sanitize('Foo  Bar'), 'foo_bar', 'multiple spaces should collapse to a single _');
});

test('sanitize collapses runs of non-alphanumeric chars', () => {
  assert.equal(sanitize('Foo//Bar'), 'foo_bar', '`//` should collapse to a single `_`');
  assert.equal(sanitize('Foo---Bar'), 'foo_bar', 'multiple dashes should collapse to one');
});

test('sanitize trims leading/trailing underscores', () => {
  assert.equal(sanitize('/Foo/'), 'foo');
  assert.equal(sanitize('---Foo---'), 'foo');
});

test('sanitize lowercases the result', () => {
  assert.equal(sanitize('LocalLoginEnabled'), 'localloginenabled');
  assert.equal(sanitize('Foo/BAR/Baz'), 'foo_bar_baz');
});

test('sanitize throws on empty or non-string input', () => {
  assert.throws(() => sanitize(''), /non-empty string/);
  assert.throws(() => sanitize(null), /non-empty string/);
  assert.throws(() => sanitize(42), /non-empty string/);
});

test('generateSchemaName builds {prefix}_{sanitized} canonical form', () => {
  const result = generateSchemaName({
    settingName: 'Authentication/Registration/LocalLoginEnabled',
    publisherPrefix: 'ids',
  });
  assert.equal(result.schemaName, 'ids_authentication_registration_localloginenabled');
  assert.equal(result.sanitized, 'authentication_registration_localloginenabled');
});

test('generateSchemaName lowercases the publisher prefix', () => {
  const result = generateSchemaName({
    settingName: 'Foo',
    publisherPrefix: 'IDS',
  });
  assert.equal(result.schemaName, 'ids_foo');
});

test('generateSchemaName strips a trailing underscore from the prefix (defensive)', () => {
  const result = generateSchemaName({
    settingName: 'Foo',
    publisherPrefix: 'ids_',
  });
  assert.equal(result.schemaName, 'ids_foo',
    'callers occasionally pass `prefix_` form; helper should normalize');
});

test('generateSchemaName produces deterministic output for the same input', () => {
  const a = generateSchemaName({ settingName: 'Authentication/OAuth/LinkedIn/ClientId', publisherPrefix: 'ids' });
  const b = generateSchemaName({ settingName: 'Authentication/OAuth/LinkedIn/ClientId', publisherPrefix: 'ids' });
  assert.equal(a.schemaName, b.schemaName);
});

test('generateSchemaName produces same output regardless of input case', () => {
  // setup-solution and configure-env-variables MUST emit the same schema name
  // for the same logical setting; case differences in mspp_sitesettings names
  // must not produce divergent schema names.
  const a = generateSchemaName({ settingName: 'Authentication/Registration/LocalLoginEnabled', publisherPrefix: 'ids' });
  const b = generateSchemaName({ settingName: 'authentication/registration/localloginenabled', publisherPrefix: 'ids' });
  assert.equal(a.schemaName, b.schemaName);
});

test('generateSchemaName throws on missing publisherPrefix', () => {
  assert.throws(
    () => generateSchemaName({ settingName: 'Foo' }),
    /publisherPrefix must be a non-empty string/,
  );
  assert.throws(
    () => generateSchemaName({ settingName: 'Foo', publisherPrefix: '' }),
    /publisherPrefix must be a non-empty string/,
  );
});

test('generateSchemaName throws when settingName sanitizes to empty (e.g. all symbols)', () => {
  assert.throws(
    () => generateSchemaName({ settingName: '///---', publisherPrefix: 'ids' }),
    /sanitized to an empty string/,
  );
});

test('generateSchemaName handles real-world site setting names from the docs', () => {
  // Sample names from solution-api-patterns.md and live IdeaSphere snapshots —
  // verify the canonical rule produces sensible output for each.
  const cases = [
    {
      input: 'Authentication/OpenIdConnect/AAD/ClientSecret',
      prefix: 'ids',
      expected: 'ids_authentication_openidconnect_aad_clientsecret',
    },
    {
      input: 'Authentication/Registration/LocalLoginEnabled',
      prefix: 'ids',
      expected: 'ids_authentication_registration_localloginenabled',
    },
    {
      input: 'AzureAD/LoginNonce',
      prefix: 'ids',
      expected: 'ids_azuread_loginnonce',
    },
    {
      input: 'AdminPassword',
      prefix: 'cr',
      expected: 'cr_adminpassword',
    },
  ];
  for (const c of cases) {
    const r = generateSchemaName({ settingName: c.input, publisherPrefix: c.prefix });
    assert.equal(r.schemaName, c.expected, `Schema name for "${c.input}" should be "${c.expected}"`);
  }
});

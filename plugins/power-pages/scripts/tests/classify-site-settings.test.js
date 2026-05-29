const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classify,
  bulkClassify,
  autoClassifyCredential,
  CREDENTIAL_REGEX,
  AUTH_PREFIX_REGEX,
  CREDENTIAL_SECRET_REGEX,
  CREDENTIAL_STRING_REGEX,
} = require('../lib/classify-site-settings');

// ── Regex constants — exported so a future change can be verified. ─────────────

test('CREDENTIAL_REGEX matches all the documented credential-style names', () => {
  // Each of these should be classified as credential (Tier 1).
  for (const name of [
    'Authentication/OpenIdConnect/Microsoft/ClientSecret',
    'Authentication/OAuth/Twitter/ConsumerKey',
    'Authentication/OAuth/Twitter/ConsumerSecret',
    'Authentication/OAuth/LinkedIn/ClientId',
    'AzureAD/AppSecret',
    'Some/Path/AppKey',
    'Some/Path/ApiKey',
    'AdminPassword',
  ]) {
    assert.ok(CREDENTIAL_REGEX.test(name), `${name} should match CREDENTIAL_REGEX`);
  }
});

test('CREDENTIAL_REGEX is case-insensitive', () => {
  assert.ok(CREDENTIAL_REGEX.test('CLIENTSECRET'));
  assert.ok(CREDENTIAL_REGEX.test('clientsecret'));
});

test('AUTH_PREFIX_REGEX matches Authentication/ and AzureAD/ prefixes only', () => {
  assert.ok(AUTH_PREFIX_REGEX.test('Authentication/OpenAuth/Foo'));
  assert.ok(AUTH_PREFIX_REGEX.test('AzureAD/Foo'));
  assert.ok(!AUTH_PREFIX_REGEX.test('Search/Enabled'));
  assert.ok(!AUTH_PREFIX_REGEX.test('Bootstrap/Theme'));
  assert.ok(!AUTH_PREFIX_REGEX.test('PortalAuth/Foo'),
    'PortalAuth must not match — only the documented prefixes count');
});

test('CREDENTIAL_SECRET_REGEX matches Secret/Password/ApiKey/AppKey but not Id/ConsumerKey', () => {
  for (const name of [
    'Authentication/OpenIdConnect/Microsoft/ClientSecret',
    'AzureAD/AppSecret',
    'AdminPassword',
    'Service/AppKey',
    'Service/ApiKey',
  ]) {
    assert.ok(CREDENTIAL_SECRET_REGEX.test(name), `${name} should match CREDENTIAL_SECRET_REGEX`);
  }
  // ClientId / ConsumerKey alone should NOT match the Secret pattern.
  // (ConsumerKey has "Key" in it but the regex requires "ApiKey" or "AppKey" specifically.)
  assert.ok(!CREDENTIAL_SECRET_REGEX.test('Authentication/OAuth/LinkedIn/ClientId'));
  assert.ok(!CREDENTIAL_SECRET_REGEX.test('Authentication/OAuth/Twitter/ConsumerKey'));
});

test('CREDENTIAL_STRING_REGEX matches Id/ConsumerKey patterns', () => {
  for (const name of [
    'Authentication/OAuth/LinkedIn/ClientId',
    'Authentication/OAuth/Twitter/ConsumerKey',
    'AzureAD/TenantId',
    'Some/AppId',
  ]) {
    assert.ok(CREDENTIAL_STRING_REGEX.test(name), `${name} should match CREDENTIAL_STRING_REGEX`);
  }
});

// ── classify() — single-setting tier mapping ──────────────────────────────────

test('classify routes credential-style names to tier=credential', () => {
  assert.equal(classify({ name: 'Authentication/OpenIdConnect/Microsoft/ClientSecret', value: 'xyz' }).tier, 'credential');
  assert.equal(classify({ name: 'Authentication/OAuth/Twitter/ConsumerKey', value: 'abc' }).tier, 'credential');
  assert.equal(classify({ name: 'AdminPassword', value: 'p' }).tier, 'credential');
});

test('classify routes Authentication/AzureAD names with values to authValue', () => {
  assert.equal(classify({ name: 'Authentication/Registration/LocalLoginEnabled', value: 'true' }).tier, 'authValue');
  assert.equal(classify({ name: 'AzureAD/SomeFlag', value: 'on' }).tier, 'authValue');
});

test('classify routes Authentication/AzureAD names with empty values to authNoValue', () => {
  for (const value of [null, '', '  ', undefined]) {
    assert.equal(
      classify({ name: 'Authentication/Registration/SomethingEmpty', value }).tier,
      'authNoValue',
      `value=${JSON.stringify(value)} should be authNoValue`,
    );
  }
});

test('classify routes everything else to keepAsIs', () => {
  assert.equal(classify({ name: 'Search/Enabled', value: 'true' }).tier, 'keepAsIs');
  assert.equal(classify({ name: 'Bootstrap/Theme', value: 'dark' }).tier, 'keepAsIs');
  assert.equal(classify({ name: 'WebApi/contact/fields', value: 'fullname' }).tier, 'keepAsIs');
});

test('classify does NOT route credential-style names to authNoValue even when value is empty', () => {
  // Tier 1 takes precedence over Tier 2 — credential-style names always need
  // a per-credential decision regardless of whether dev has a value yet.
  assert.equal(classify({ name: 'Authentication/OAuth/LinkedIn/ClientSecret', value: '' }).tier, 'credential');
});

test('classify throws on missing or invalid input', () => {
  assert.throws(() => classify(null), /setting\.name must be a string/);
  assert.throws(() => classify({}), /setting\.name must be a string/);
  assert.throws(() => classify({ name: 42 }), /setting\.name must be a string/);
});

// ── bulkClassify() — array → four-bucket shape ────────────────────────────────

test('bulkClassify produces the four-bucket shape used by plan-alm SITE_SETTINGS_DATA', () => {
  const settings = [
    { name: 'Search/Enabled', value: 'true' },
    { name: 'Authentication/Registration/LocalLoginEnabled', value: 'true' },
    { name: 'Authentication/Registration/EmptyFlag', value: '' },
    { name: 'Authentication/OAuth/LinkedIn/ClientSecret', value: 'xxx' },
    { name: 'Authentication/OAuth/Twitter/ConsumerKey', value: 'xyz' },
  ];
  const result = bulkClassify(settings);
  assert.deepEqual(result.keepAsIs, [{ name: 'Search/Enabled' }]);
  assert.equal(result.authNoValue.length, 1);
  assert.equal(result.authNoValue[0].name, 'Authentication/Registration/EmptyFlag');
  assert.equal(result.promoteToEnvVar.length, 1);
  assert.equal(result.promoteToEnvVar[0].name, 'Authentication/Registration/LocalLoginEnabled');
  assert.equal(result.credentialNeedsDecision.length, 2);
  assert.ok(result.credentialNeedsDecision.some((s) => s.name.endsWith('ClientSecret')));
  assert.ok(result.credentialNeedsDecision.some((s) => s.name.endsWith('ConsumerKey')));
});

test('bulkClassify ignores entries without a name field', () => {
  const result = bulkClassify([
    null,
    { value: 'orphaned' },
    { name: 'Foo', value: 'bar' },
  ]);
  assert.equal(result.keepAsIs.length, 1);
  assert.equal(result.keepAsIs[0].name, 'Foo');
});

test('bulkClassify throws when input is not an array', () => {
  assert.throws(() => bulkClassify('not-an-array'), /must be an array/);
});

test('bulkClassify normalizes missing values to null in the output buckets', () => {
  const result = bulkClassify([
    { name: 'Authentication/OAuth/LinkedIn/ClientSecret' /* no value field */ },
  ]);
  assert.equal(result.credentialNeedsDecision[0].value, null);
});

// ── autoClassifyCredential() — Secret-vs-String default for the bulk prompt ──

test('autoClassifyCredential defaults names with Secret/Password/ApiKey/AppKey to Secret env var', () => {
  for (const name of [
    'Authentication/OpenIdConnect/Microsoft/ClientSecret',
    'AzureAD/AppSecret',
    'Service/ApiKey',
    'Service/AppKey',
    'AdminPassword',
  ]) {
    const r = autoClassifyCredential(name);
    assert.equal(r.default, 'secret', `${name} should default to Secret env var`);
  }
});

test('autoClassifyCredential defaults names with Id/ConsumerKey (and not Secret) to String env var', () => {
  for (const name of [
    'Authentication/OAuth/LinkedIn/ClientId',
    'Authentication/OAuth/Twitter/ConsumerKey',
    'AzureAD/TenantId',
  ]) {
    const r = autoClassifyCredential(name);
    assert.equal(r.default, 'string', `${name} should default to String env var`);
  }
});

test('autoClassifyCredential falls back to Secret for names that match neither pattern', () => {
  const r = autoClassifyCredential('Authentication/Custom/UnknownToken');
  assert.equal(r.default, 'secret', 'unknown credential names should default to Secret (defensive)');
  assert.match(r.reason, /defensive/i);
});

test('autoClassifyCredential prefers Secret when both patterns could match', () => {
  // "ClientSecret" contains both "Id" (no — the Id regex looks for "Id" as substring;
  // "Client" has no "Id", but "AppId" or "ClientId" would). Verify the Secret check
  // happens first so a name like "AppIdSecret" routes to Secret, not String.
  const r = autoClassifyCredential('Service/AppIdSecret');
  assert.equal(r.default, 'secret',
    'A name matching both regexes must route to Secret — Secret check must run first');
});

test('autoClassifyCredential throws on non-string input', () => {
  assert.throws(() => autoClassifyCredential(null), /must be a string/);
  assert.throws(() => autoClassifyCredential(42), /must be a string/);
});

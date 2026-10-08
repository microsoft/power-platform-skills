'use strict';
const test = require('node:test');

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const helpersPath = path.join(__dirname, '..', 'lib', 'validation-helpers.js');


test('validateDataverseApiPath accepts valid Dataverse API paths', () => {
  const { validateDataverseApiPath } = require(helpersPath);
  const base = 'https://org.crm.dynamics.com';

  assert.equal(validateDataverseApiPath('accounts', base), `${base}/api/data/v9.2/accounts`);
  assert.equal(validateDataverseApiPath('accounts(00000000-0000-0000-0000-000000000000)', base), `${base}/api/data/v9.2/accounts(00000000-0000-0000-0000-000000000000)`);
  assert.equal(validateDataverseApiPath('accounts?$select=name&$top=5', base), `${base}/api/data/v9.2/accounts?$select=name&$top=5`);
  assert.equal(validateDataverseApiPath('accounts?$filter=name eq \'a%26b\'', base), `${base}/api/data/v9.2/accounts?$filter=name%20eq%20%27a%26b%27`);
  assert.equal(validateDataverseApiPath('contacts(123)/account_primary_contact', base), `${base}/api/data/v9.2/contacts(123)/account_primary_contact`);
  assert.equal(validateDataverseApiPath("EntityDefinitions(LogicalName='account')/Attributes", base), `${base}/api/data/v9.2/EntityDefinitions(LogicalName='account')/Attributes`);
  assert.equal(validateDataverseApiPath('$batch', base), `${base}/api/data/v9.2/$batch`);
  assert.equal(validateDataverseApiPath('accounts?$filter=url eq \'https://evil.com/x\'', base), `${base}/api/data/v9.2/accounts?$filter=url%20eq%20%27https://evil.com/x%27`);
  assert.equal(validateDataverseApiPath('accounts?$filter=path eq \'../admin\'', base), `${base}/api/data/v9.2/accounts?$filter=path%20eq%20%27../admin%27`);
  assert.equal(validateDataverseApiPath('accounts/', base), `${base}/api/data/v9.2/accounts/`);
  assert.equal(validateDataverseApiPath('/accounts', base), `${base}/api/data/v9.2/accounts`);
});

test('validateDataverseApiPath accepts localhost http', () => {
  const { validateDataverseApiPath } = require(helpersPath);
  const base = 'http://127.0.0.1:40057';
  assert.equal(validateDataverseApiPath('accounts', base, { allowLoopback: true }), `${base}/api/data/v9.2/accounts`);
});



test('validateDataverseEnvironmentUrl accepts localhost http when allowLoopback is true', () => {
  const { validateDataverseEnvironmentUrl } = require(helpersPath);
  const base = 'http://127.0.0.1:40057';
  assert.equal(validateDataverseEnvironmentUrl(base, 'test', { allowLoopback: true }), base);
});

test('validateDataverseApiPath rejects path traversal and out-of-scope paths', () => {
  const { validateDataverseApiPath } = require(helpersPath);
  const base = 'https://org.crm.dynamics.com';

  assert.throws(() => validateDataverseApiPath('../../admin', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('..\\..\\admin', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('../v9.1/accounts', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('v9.2/../../x', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('%2e%2e/%2e%2e/admin', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('..%2fadmin', base), /encoded path separators are not allowed/);
  assert.throws(() => validateDataverseApiPath('..%5cadmin', base), /encoded path separators are not allowed/);
  assert.throws(() => validateDataverseApiPath('EntityDefinitions%2f..%2f..%2fadmin', base), /encoded path separators are not allowed/);
  assert.throws(() => validateDataverseApiPath('https://evil.com/x', base), /resolves to a different origin/);
  assert.throws(() => validateDataverseApiPath('//evil.com/x', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('///evil.com/x', base), /resolves to a different origin/);
  assert.throws(() => validateDataverseApiPath('https://user:pass@evil.com/x', base), /resolves to a different origin/);
  assert.throws(() => validateDataverseApiPath('http://org.crm.dynamics.com/x', base), /resolves to a different origin/);
  assert.throws(() => validateDataverseApiPath('accounts#x', base), /fragments/);
  assert.throws(() => validateDataverseApiPath('accounts\t', base), /control characters/);
  assert.throws(() => validateDataverseApiPath('accounts\r\n', base), /control characters/);
  assert.throws(() => validateDataverseApiPath('', base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath('   ', base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath(null, base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath(undefined, base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath([], base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath('a'.repeat(9001), base), /maximum length/);
});

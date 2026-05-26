const test = require('node:test');
const assert = require('node:assert/strict');

const { discoverComponentTypes, resolveComponentType } = require('../lib/discover-component-types');

test('discoverComponentTypes throws when --envUrl is missing', async () => {
  await assert.rejects(
    () => discoverComponentTypes({ websiteRecordId: 'site-id', token: 'tok' }),
    /--envUrl is required/
  );
});

test('discoverComponentTypes throws when --websiteRecordId is missing', async () => {
  await assert.rejects(
    () => discoverComponentTypes({ envUrl: 'https://org.crm.dynamics.com', token: 'tok' }),
    /--websiteRecordId is required/
  );
});

test('discoverComponentTypes throws when website record not found in solutioncomponents', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ value: [] }),
  });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => discoverComponentTypes({
      envUrl: 'https://org.crm.dynamics.com',
      websiteRecordId: 'site-id',
      token: 'fake',
    }),
    /not found in solutioncomponents/
  );
});

test('discoverComponentTypes returns websiteComponentType on success', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let callCount = 0;
  helpers.makeRequest = async ({ url }) => {
    callCount++;
    // All queries return the same componenttype for simplicity
    return {
      statusCode: 200,
      body: JSON.stringify({ value: [{ componenttype: 10374 }] }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await discoverComponentTypes({
    envUrl: 'https://org.crm.dynamics.com',
    websiteRecordId: 'site-id',
    token: 'fake',
  });

  assert.equal(result.websiteComponentType, 10374);
  // subComponentType and siteLanguageComponentType should be absent
  assert.equal(result.subComponentType, undefined);
  assert.equal(result.siteLanguageComponentType, undefined);
});

test('discoverComponentTypes returns subComponentType when powerpageComponentId provided', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const typeMap = { 'site-id': 10374, 'comp-id': 10373 };
  helpers.makeRequest = async ({ url }) => {
    const id = Object.keys(typeMap).find(k => url.includes(k));
    const ct = id ? typeMap[id] : 10373;
    return {
      statusCode: 200,
      body: JSON.stringify({ value: [{ componenttype: ct }] }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await discoverComponentTypes({
    envUrl: 'https://org.crm.dynamics.com',
    websiteRecordId: 'site-id',
    powerpageComponentId: 'comp-id',
    token: 'fake',
  });

  assert.equal(result.websiteComponentType, 10374);
  assert.equal(result.subComponentType, 10373);
});

test('resolveComponentType returns null when solutioncomponents returns empty value', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ value: [] }),
  });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await resolveComponentType('https://org.crm.dynamics.com', 'fake-token', 'unknown-id');
  assert.equal(result, null);
});

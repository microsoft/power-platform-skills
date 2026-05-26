const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for check-env-host-binding.js
// Network calls are mocked via module-level replacement on helpers.makeRequest.

const { checkEnvHostBinding } = require('../lib/check-env-host-binding');

test('returns { bound: false, hostEnvId: null } when SettingValue is empty', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: '' }) });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await checkEnvHostBinding({ envUrl: 'https://org.crm.dynamics.com', token: 'fake' });
  assert.equal(result.bound, false);
  assert.equal(result.hostEnvId, null);
});

test('returns { bound: false, hostEnvId: null } when SettingValue is whitespace', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: '   ' }) });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await checkEnvHostBinding({ envUrl: 'https://org.crm.dynamics.com', token: 'fake' });
  assert.equal(result.bound, false);
  assert.equal(result.hostEnvId, null);
});

test('returns { bound: true, hostEnvId } when SettingValue is a GUID', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ SettingValue: '0817fd3d-a664-e99a-a758-dd9dc03ceb01' }),
  });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await checkEnvHostBinding({ envUrl: 'https://org.crm.dynamics.com', token: 'fake' });
  assert.equal(result.bound, true);
  assert.equal(result.hostEnvId, '0817fd3d-a664-e99a-a758-dd9dc03ceb01');
});

test('trims whitespace from SettingValue', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ SettingValue: '  abc-123  ' }),
  });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await checkEnvHostBinding({ envUrl: 'https://org.crm.dynamics.com', token: 'fake' });
  assert.equal(result.bound, true);
  assert.equal(result.hostEnvId, 'abc-123');
});

test('strips trailing slashes from envUrl', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let captured = null;
  helpers.makeRequest = async (args) => {
    captured = args.url;
    return { statusCode: 200, body: JSON.stringify({ SettingValue: '' }) };
  };
  t.after(() => { helpers.makeRequest = orig; });

  await checkEnvHostBinding({ envUrl: 'https://org.crm.dynamics.com////', token: 'fake' });
  assert.equal(captured, 'https://org.crm.dynamics.com/api/data/v9.0/GetOrgDbOrgSetting');
});

test('treats 404 as not bound (mirrors UI behavior on missing action)', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 404, body: 'Not Found' });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await checkEnvHostBinding({ envUrl: 'https://org.crm.dynamics.com', token: 'fake' });
  assert.equal(result.bound, false);
  assert.equal(result.hostEnvId, null);
});

test('throws on unexpected non-2xx status', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 500, body: 'Internal Server Error' });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => checkEnvHostBinding({ envUrl: 'https://org.crm.dynamics.com', token: 'fake' }),
    /unexpected status 500/,
  );
});

test('throws when --envUrl is missing', async () => {
  await assert.rejects(
    () => checkEnvHostBinding({ token: 'fake' }),
    /--envUrl is required/,
  );
});

test('throws when --token is missing', async () => {
  await assert.rejects(
    () => checkEnvHostBinding({ envUrl: 'https://org.crm.dynamics.com' }),
    /--token is required/,
  );
});

test('throws on transport error', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ error: 'ECONNREFUSED' });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => checkEnvHostBinding({ envUrl: 'https://org.crm.dynamics.com', token: 'fake' }),
    /GetOrgDbOrgSetting request failed/,
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { linkSiteSettingToEnvVar } = require('../lib/link-site-setting-to-env-var');

test('linkSiteSettingToEnvVar throws when required args are missing', async () => {
  await assert.rejects(
    () => linkSiteSettingToEnvVar({ envUrl: 'https://org.crm.dynamics.com', token: 'tok' }),
    /--siteSettingId.*--definitionId.*--schemaName/
  );
});

test('linkSiteSettingToEnvVar uses v9.0 API endpoint (not v9.2)', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const urls = [];
  helpers.makeRequest = async ({ url }) => {
    urls.push(url);
    // PATCH → 204; GET verify → 200 with matching values
    if (url.includes('mspp_sitesettings')) {
      if (urls.filter(u => u.includes('mspp_sitesettings')).length === 1) {
        return { statusCode: 204, body: '' };
      }
      // Verify GET
      return {
        statusCode: 200,
        body: JSON.stringify({ mspp_source: 1, _mspp_environmentvariable_value: 'def-id-abc' }),
      };
    }
    return { statusCode: 200, body: '{}' };
  };
  t.after(() => { helpers.makeRequest = orig; });

  await linkSiteSettingToEnvVar({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    siteSettingId: 'setting-id-001',
    definitionId: 'def-id-abc',
    schemaName: 'con_MySecret',
  });

  const patchUrl = urls.find(u => u.includes('v9.0'));
  assert.ok(patchUrl, 'PATCH must use v9.0 API');
  assert.ok(patchUrl.includes('mspp_sitesettings'), 'PATCH must target mspp_sitesettings');
});

test('linkSiteSettingToEnvVar throws on non-204 PATCH response', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 400,
    body: JSON.stringify({ error: { message: 'Bad Request' } }),
  });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => linkSiteSettingToEnvVar({
      envUrl: 'https://org.crm.dynamics.com',
      token: 'fake',
      siteSettingId: 'setting-id',
      definitionId: 'def-id',
      schemaName: 'con_MySecret',
    }),
    /PATCH mspp_sitesettings failed/
  );
});

test('linkSiteSettingToEnvVar returns verified:true when GET confirms link', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let patchDone = false;
  helpers.makeRequest = async ({ url, method }) => {
    if (!patchDone && (method === 'PATCH' || url.includes('v9.0'))) {
      patchDone = true;
      return { statusCode: 204, body: '' };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ mspp_source: 1, _mspp_environmentvariable_value: 'def-id-verify' }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await linkSiteSettingToEnvVar({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    siteSettingId: 'setting-id-002',
    definitionId: 'def-id-verify',
    schemaName: 'con_MySecret',
  });

  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
});

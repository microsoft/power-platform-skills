const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyHostReadiness, compareVersions, PIPELINES_SOLUTION_UNIQUE_NAME } = require('../lib/verify-host-readiness');

// Mock helper that responds based on URL pattern.
function makeMockResponder(routes) {
  return async (args) => {
    const url = args.url;
    for (const r of routes) {
      if (r.match(url)) return r.respond(args);
    }
    return { statusCode: 599, body: 'no mock for ' + url };
  };
}

test('compareVersions exported and works', () => {
  assert.equal(compareVersions('9.0.0.0', '9.0.0.0'), 0);
  assert.equal(compareVersions('9.0.0.0', '9.0.0.1'), -1);
  assert.equal(compareVersions('9.1.0.0', '9.0.99.99'), 1);
  assert.equal(compareVersions('9.1.2026034.260325188', '9.1.2026034.260325187'), 1);
  assert.equal(compareVersions('1.0', '1.0.0.0'), 0);
  assert.equal(compareVersions(null, '1.0'), -1);
  assert.equal(compareVersions('1.0', null), 1);
});

test('PIPELINES_SOLUTION_UNIQUE_NAME constant matches recon finding', () => {
  assert.equal(PIPELINES_SOLUTION_UNIQUE_NAME, 'msdyn_AppDeploymentAnchor');
});

test('returns ready: true when WhoAmI + solutions both succeed and Pipelines solution found', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = makeMockResponder([
    {
      match: (u) => u.includes('/WhoAmI'),
      respond: () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'user-1', BusinessUnitId: 'bu-1' }) }),
    },
    {
      match: (u) => u.includes('/solutions'),
      respond: () => ({
        statusCode: 200,
        body: JSON.stringify({ value: [{ uniquename: 'msdyn_AppDeploymentAnchor', version: '9.1.2026034.260325188' }] }),
      }),
    },
  ]);
  t.after(() => { helpers.makeRequest = orig; });

  const result = await verifyHostReadiness({ hostEnvUrl: 'https://h.crm.dynamics.com', hostToken: 'fake' });
  assert.equal(result.ready, true);
  assert.equal(result.pipelinesSolutionVersion, '9.1.2026034.260325188');
  assert.equal(result.checks.whoami.ok, true);
  assert.equal(result.checks.whoami.userId, 'user-1');
  assert.equal(result.checks.solutions.ok, true);
  assert.equal(result.checks.solutions.found, true);
  assert.equal(result.warnings.length, 0);
});

test('returns ready: false when Pipelines solution not installed', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = makeMockResponder([
    { match: (u) => u.includes('/WhoAmI'), respond: () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'user-1' }) }) },
    { match: (u) => u.includes('/solutions'), respond: () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }) },
  ]);
  t.after(() => { helpers.makeRequest = orig; });

  const result = await verifyHostReadiness({ hostEnvUrl: 'https://h.crm.dynamics.com', hostToken: 'fake' });
  assert.equal(result.ready, false);
  assert.equal(result.pipelinesSolutionVersion, null);
  assert.equal(result.checks.solutions.ok, true);
  assert.equal(result.checks.solutions.found, false);
});

test('returns ready: false when WhoAmI fails', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = makeMockResponder([
    { match: (u) => u.includes('/WhoAmI'), respond: () => ({ statusCode: 401, body: 'unauthorized' }) },
    {
      match: (u) => u.includes('/solutions'),
      respond: () => ({ statusCode: 200, body: JSON.stringify({ value: [{ version: '9.1' }] }) }),
    },
  ]);
  t.after(() => { helpers.makeRequest = orig; });

  const result = await verifyHostReadiness({ hostEnvUrl: 'https://h.crm.dynamics.com', hostToken: 'fake' });
  assert.equal(result.ready, false);
  assert.equal(result.checks.whoami.ok, false);
  assert.equal(result.checks.whoami.statusCode, 401);
});

test('skipWhoAmI bypasses the WhoAmI call and marks check as skipped: true', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let whoamiCalled = false;
  helpers.makeRequest = async (args) => {
    if (args.url.includes('/WhoAmI')) {
      whoamiCalled = true;
      return { statusCode: 500, body: 'should not be called' };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [{ version: '9.1' }] }) };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await verifyHostReadiness({ hostEnvUrl: 'https://h.crm.dynamics.com', hostToken: 'fake', skipWhoAmI: true });
  assert.equal(whoamiCalled, false);
  assert.equal(result.ready, true);
  assert.equal(result.checks.whoami.ok, true);
  assert.equal(result.checks.whoami.skipped, true);
});

test('emits version-skew warning when version is below minPipelinesVersion', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = makeMockResponder([
    { match: (u) => u.includes('/WhoAmI'), respond: () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u' }) }) },
    {
      match: (u) => u.includes('/solutions'),
      respond: () => ({ statusCode: 200, body: JSON.stringify({ value: [{ version: '9.0.0.0' }] }) }),
    },
  ]);
  t.after(() => { helpers.makeRequest = orig; });

  const result = await verifyHostReadiness({
    hostEnvUrl: 'https://h.crm.dynamics.com',
    hostToken: 'fake',
    minPipelinesVersion: '9.1.0.0',
  });
  assert.equal(result.ready, true); // still ready — warning only
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /below recommended minimum 9\.1\.0\.0/);
});

test('treats 404 on /solutions as not-a-host (Dataverse missing)', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = makeMockResponder([
    { match: (u) => u.includes('/WhoAmI'), respond: () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u' }) }) },
    { match: (u) => u.includes('/solutions'), respond: () => ({ statusCode: 404, body: 'not found' }) },
  ]);
  t.after(() => { helpers.makeRequest = orig; });

  const result = await verifyHostReadiness({ hostEnvUrl: 'https://h.crm.dynamics.com', hostToken: 'fake' });
  assert.equal(result.ready, false);
  assert.equal(result.checks.solutions.ok, false);
  assert.equal(result.checks.solutions.statusCode, 404);
});

test('throws when --hostEnvUrl is missing', async () => {
  await assert.rejects(() => verifyHostReadiness({ hostToken: 'fake' }), /--hostEnvUrl is required/);
});

test('throws when --hostToken is missing', async () => {
  await assert.rejects(() => verifyHostReadiness({ hostEnvUrl: 'https://h' }), /--hostToken is required/);
});

test('strips trailing slashes from hostEnvUrl', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const capturedUrls = [];
  helpers.makeRequest = async (args) => {
    capturedUrls.push(args.url);
    if (args.url.includes('/WhoAmI')) return { statusCode: 200, body: JSON.stringify({ UserId: 'u' }) };
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  };
  t.after(() => { helpers.makeRequest = orig; });

  await verifyHostReadiness({ hostEnvUrl: 'https://h.crm.dynamics.com////', hostToken: 'fake' });
  assert.ok(capturedUrls[0].startsWith('https://h.crm.dynamics.com/api/data/v9.0/WhoAmI'));
});

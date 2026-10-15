'use strict';
// lib/sdk-first.js — the rule connections, connector metadata and deployment settings share: read through the SDK; ask pac only where the SDK
// REFUSES (a typed code that says its route does not serve this); throw everything else with the SDK's own code. Driven here with a stand-in SDK
// module so each branch can be forced; tests/connectivity-real-bundle.test.js drives the real bundle through the same function.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { sdkFirst, connectivity, connectivityRefusal, connectivityCloudOf, connectivityRouteRefusal, connectivityPreflight, powerAppsPreflight, CONNECTIVITY_REFUSALS } = require('../lib/sdk-first.js');
const { SdkError, ConnectionError, InvalidArgumentError, withCleanupWarnings, readCleanupWarnings } = require('../lib/maker-sdk.js');
const { PowerAppsClientError, TOKEN_UNAVAILABLE, URL_REFUSED } = require('../lib/power-apps-service-client.js');

const ENV = 'https://contoso.crm.dynamics.com';
const err = (code, message = `${code} message`, extra = {}) => Object.assign(new Error(message), { code }, extra);
// What the SDK itself throws: an `SdkError` of the bundle, carrying a code.
const sdkError = (code, message = `${code} message`) => new SdkError(code, message);

// A stand-in for lib/maker-sdk.js that records every SDK it makes and whether its workspace directory existed when it was made.
function stubSdkModule({ throwOnCreate } = {}) {
  const made = [];
  return {
    made,
    module: {
      createNodeWorkspaceStorage: (dir) => ({ dir }),
      createMakerSdk: (cfg) => {
        made.push({ cfg, dir: cfg.workspaceStorage.dir, existedWhenMade: fs.existsSync(cfg.workspaceStorage.dir) });
        if (throwOnCreate) throw throwOnCreate;
        return { marker: 'sdk', cfg };
      },
    },
  };
}

const noPreflight = { preflight: undefined };

// --- which failures are refusals -------------------------------------------------------------------------------------------------

test('the refusals are exactly the SDK\'s "this route does not serve this" codes, and this plugin\'s own "no Power Apps token"', () => {
  assert.deepStrictEqual([...CONNECTIVITY_REFUSALS].sort(), [
    'CONNECTIVITY_CLOUD_UNSUPPORTED',
    'CONNECTIVITY_ENVIRONMENT_UNVERIFIED',
    'CONNECTIVITY_NOT_CONFIGURED',
    'CONNECTIVITY_ROUTE_DECOMMISSIONED',
    'CONNECTIVITY_UNAUTHORIZED',
    'CONNECTOR_SWAGGER_UNSUPPORTED',
    'POWER_APPS_TOKEN_UNAVAILABLE',
  ]);
});

test('each refusal the SDK raises is answered with its own code and its own words', () => {
  for (const code of CONNECTIVITY_REFUSALS.filter((c) => c !== TOKEN_UNAVAILABLE)) {
    assert.deepStrictEqual(connectivityRefusal(sdkError(code, `words of ${code}`)), { code, message: `words of ${code}` }, code);
  }
  // The plugin's own code is not one the SDK raises: as an error's own code it is nobody's refusal (it arrives wrapped, below).
  assert.strictEqual(connectivityRefusal(sdkError(TOKEN_UNAVAILABLE)), null);
  assert.strictEqual(connectivityRefusal(err(TOKEN_UNAVAILABLE)), null);
});

test('a 401 or 403 from a connectivity route — the SDK\'s CONNECTIVITY_UNAUTHORIZED — is a refusal that keeps the SDK\'s words; the ConnectionError of the same status, which is Dataverse\'s, is a failure', () => {
  // The SDK's own text (api/connectivityShared.ts connectivityUnauthorized): the status, the service's code and inner code, and what it advises.
  const words = "A connectivity request was refused with HTTP 403 (AuthorizationFailed; TokenNotAllowed): the token's audience, scopes, expiry, or access was rejected. Supply a valid token for this route, or fall back to pac.";
  const refusal = connectivityRefusal(sdkError('CONNECTIVITY_UNAUTHORIZED', words));
  assert.deepStrictEqual(refusal, { code: 'CONNECTIVITY_UNAUTHORIZED', message: words });
  for (const status of [401, 403]) {
    assert.strictEqual(connectivityRefusal(new ConnectionError('https://contoso.crm.dynamics.com/api/data/v9.0/RetrieveCurrentOrganization', status, 'denied')), null, `HTTP ${status} from Dataverse`);
  }
  // Only the SDK's own error counts, as for every other code: a plain Error or an object that carries the code is nobody's refusal.
  assert.strictEqual(connectivityRefusal(err('CONNECTIVITY_UNAUTHORIZED')), null);
  assert.strictEqual(connectivityRefusal({ code: 'CONNECTIVITY_UNAUTHORIZED', message: words }), null);
});

test('a refusal the Power Apps client raised arrives wrapped in the SDK\'s ConnectionError: the code and the words are the original\'s', () => {
  const original = new PowerAppsClientError(TOKEN_UNAVAILABLE, 'Could not get an Azure CLI token for the Power Apps service: Azure CLI (`az`) is not on PATH.');
  const wrapped = new ConnectionError('https://api.bap.microsoft.com/x', 0, original.message, original);
  assert.deepStrictEqual(connectivityRefusal(wrapped), { code: TOKEN_UNAVAILABLE, message: original.message });
});

test('only what the SDK RAISED is a refusal: an HTTP response body that carries a refusal\'s code is data from the network, and stays a failure', () => {
  // The SDK's ConnectionError keeps the response body as its `cause`; a service that answers 403 with a body naming a refusal's code is not the SDK refusing its route. (Such a
  // ConnectionError is what a failed Dataverse call is — the org read; the 401 and 403 of the two connectivity routes are the SDK's own CONNECTIVITY_UNAUTHORIZED instead.)
  for (const code of [...CONNECTIVITY_REFUSALS]) {
    const forged = new ConnectionError('https://api.bap.microsoft.com/x', 403, 'service denied this request', { code, message: 'service denied this request' });
    assert.strictEqual(connectivityRefusal(forged), null, `403 with a body of ${code}`);
    for (const status of [400, 401, 404, 410, 429, 500, 503]) {
      assert.strictEqual(connectivityRefusal(new ConnectionError('https://api.bap.microsoft.com/x', status, 'm', { error: { code }, code, message: code })), null, `${status} with a body of ${code}`);
    }
  }
  // Wrapped as the token refusal is — a transport failure (status 0), the plugin's own client error, the exact code — and in no other way.
  const real = new PowerAppsClientError(TOKEN_UNAVAILABLE, 'no token');
  assert.ok(connectivityRefusal(new ConnectionError('u', 0, 'no token', real)));
  assert.strictEqual(connectivityRefusal(new ConnectionError('u', 401, 'no token', real)), null, 'an HTTP status is not a transport failure');
  assert.strictEqual(connectivityRefusal(new ConnectionError('u', 0, 'no token', { code: TOKEN_UNAVAILABLE, message: 'no token' })), null, 'a body, not the client\'s error');
  assert.strictEqual(connectivityRefusal(new ConnectionError('u', 0, 'no token', err(TOKEN_UNAVAILABLE, 'no token'))), null, 'a plain Error that carries the code is not the client\'s');
  assert.strictEqual(connectivityRefusal(new ConnectionError('u', 0, 'refused', new PowerAppsClientError(URL_REFUSED, 'refused'))), null, 'the client\'s other errors are failures');
  assert.strictEqual(connectivityRefusal(new ConnectionError('u', 0, 'no cause')), null);
  assert.strictEqual(connectivityRefusal(new ConnectionError('u', 0, 'm', null)), null);
  // An error that is not the SDK's — a plain Error, an object, anything — is not a refusal, whatever code it carries.
  for (const code of CONNECTIVITY_REFUSALS) {
    assert.strictEqual(connectivityRefusal(err(code)), null, `a plain Error with ${code}`);
    assert.strictEqual(connectivityRefusal({ code, message: 'm' }), null, `an object with ${code}`);
  }
  // A forged ConnectionError-shaped object is not an SdkError either.
  assert.strictEqual(connectivityRefusal(Object.assign(new Error('m'), { code: 'CONNECTION_ERROR', statusCode: 0, cause: real })), null);
});

test('every other failure is NOT a refusal — a route that serves and fails, an unreadable answer, a bad argument, a wrapped transport error', () => {
  for (const code of ['CONNECTIVITY_RESPONSE_UNREADABLE', 'CONNECTOR_OPERATION_NOT_FOUND', 'CONNECTOR_SCHEMA_TOO_LARGE', 'INVALID_ARGUMENT', 'VERSION_CONFLICT', 'ENVIRONMENT_LANGUAGES_UNREADABLE', 'SOLUTION_STAGING_FAILED']) {
    assert.strictEqual(connectivityRefusal(sdkError(code)), null, code);
  }
  assert.strictEqual(connectivityRefusal(new InvalidArgumentError('bad')), null);
  for (const status of [0, 401, 403, 404, 429, 500, 503]) {
    assert.strictEqual(connectivityRefusal(new ConnectionError('u', status, `HTTP ${status}`)), null, `HTTP ${status}`);
  }
  // A transport failure carries the transport's own error as its cause; its code is not a refusal's.
  assert.strictEqual(connectivityRefusal(new ConnectionError('u', 0, 'reset', err('ECONNRESET'))), null);
  assert.strictEqual(connectivityRefusal(new Error('a plain error')), null);
  for (const odd of [null, undefined, 'POWER_APPS_TOKEN_UNAVAILABLE', 42, {}, { code: 7 }]) assert.strictEqual(connectivityRefusal(odd), null, String(odd));
  // A code that only looks like one: the match is exact.
  assert.strictEqual(connectivityRefusal(sdkError('CONNECTIVITY_ROUTE_DECOMMISSIONED_X')), null);
  assert.strictEqual(connectivityRefusal(sdkError('connectivity_route_decommissioned')), null);
});

// --- the token check --------------------------------------------------------------------------------------------------------------

test('both tokens are read side by side, so a cold Azure CLI is not waited for twice', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = {
    getAuthTokenAsync: async (env) => { order.push(`dataverse:start:${env}`); await gate; order.push('dataverse:end'); return 'a'; },
    getPowerAppsTokenAsync: async () => { order.push('powerapps:start'); await gate; order.push('powerapps:end'); return 'b'; },
  };
  const pending = powerAppsPreflight(ENV, deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(order, [`dataverse:start:${ENV}`, 'powerapps:start'], 'both reads started before either answered');
  release();
  assert.strictEqual(await pending, null, 'a Power Apps token: nothing to refuse');
});

test('no Power Apps token is a refusal — whatever the Dataverse token did — with the reason the token code gives', async () => {
  const deps = {
    getAuthTokenAsync: async () => 'dataverse-token',
    getPowerAppsTokenAsync: async () => null,
    powerAppsTokenFailureMessage: () => 'Could not get an Azure CLI token for the Power Apps service: Azure CLI (`az`) is not on PATH.',
  };
  assert.deepStrictEqual(await powerAppsPreflight(ENV, deps), { code: 'POWER_APPS_TOKEN_UNAVAILABLE', message: deps.powerAppsTokenFailureMessage() });
  // The Dataverse token failing is not this check's business: the SDK's first request says so, loudly.
  assert.strictEqual(await powerAppsPreflight(ENV, { ...deps, getAuthTokenAsync: async () => null, getPowerAppsTokenAsync: async () => 'b' }), null);
});

test('the connectivity preflight asks the host first: outside the Public cloud it refuses at once and reads NO token; in the Public cloud it goes on to the token check', async () => {
  const reads = [];
  const deps = {
    getAuthTokenAsync: async (env) => { reads.push(`dataverse:${env}`); return 'a'; },
    getPowerAppsTokenAsync: async () => { reads.push('powerapps'); return 'b'; },
    powerAppsTokenFailureMessage: () => 'no token',
  };
  const test = await connectivityPreflight('https://contoso.crmtest.dynamics.com', deps);
  assert.strictEqual(test.code, 'CONNECTIVITY_NOT_CONFIGURED');
  assert.strictEqual((await connectivityPreflight('https://contoso.crm9.dynamics.com', deps)).code, 'CONNECTIVITY_CLOUD_UNSUPPORTED');
  assert.deepStrictEqual(reads, [], 'no Azure CLI process for an org the SDK would refuse before any request');
  assert.strictEqual(await connectivityPreflight(ENV, deps), null);
  assert.deepStrictEqual([...reads].sort(), [`dataverse:${ENV}`, 'powerapps'], 'a Public org reads both tokens, as before');
  assert.strictEqual((await connectivityPreflight(ENV, { ...deps, getPowerAppsTokenAsync: async () => null })).code, 'POWER_APPS_TOKEN_UNAVAILABLE', 'and a Public org with no Power Apps token is still that refusal');
});

test('an org outside the Public cloud is refused from its host, with the code the SDK would give — NOT_CONFIGURED for Test, CLOUD_UNSUPPORTED for the rest — and a Public org is not', () => {
  assert.strictEqual(connectivityRouteRefusal(ENV), null);
  assert.strictEqual(connectivityRouteRefusal('https://contoso.crm4.dynamics.com'), null);
  const testCloud = connectivityRouteRefusal('https://contoso.crmtest.dynamics.com');
  assert.strictEqual(testCloud.code, 'CONNECTIVITY_NOT_CONFIGURED');
  assert.match(testCloud.message, /Test cloud[\s\S]*Power Platform API[\s\S]*Azure CLI's token[\s\S]*pac reads them\. Nothing was requested\.$/);
  for (const host of ['https://contoso.crm9.dynamics.com', 'https://contoso.crm.microsoftdynamics.us', 'https://contoso.crm.appsplatform.us', 'https://contoso.crm.dynamics.cn', 'https://contoso.example.com']) {
    const refusal = connectivityRouteRefusal(host);
    assert.strictEqual(refusal.code, 'CONNECTIVITY_CLOUD_UNSUPPORTED', host);
    assert.match(refusal.message, /GCC[\s\S]*pac reads them\. Nothing was requested\.$/, host);
  }
  // The result is printed as the fallback, so each call gives a fresh object: nothing done to one reaches the next.
  const first = connectivityRouteRefusal('https://contoso.crmtest.dynamics.com');
  first.code = 'changed';
  assert.strictEqual(connectivityRouteRefusal('https://contoso.crmtest.dynamics.com').code, 'CONNECTIVITY_NOT_CONFIGURED');
  // The rule is the host's: what it is given that is not a URL is in no cloud.
  for (const odd of ['', 'contoso', null, undefined, 42]) assert.strictEqual(connectivityRouteRefusal(odd).code, 'CONNECTIVITY_CLOUD_UNSUPPORTED', String(odd));
  assert.strictEqual(connectivityCloudOf('https://contoso.crmtest.dynamics.com'), 'Test');
  assert.strictEqual(connectivityCloudOf(ENV), 'Public');
});

test('the connectivity plan asks the factory for connectivity, and carries the refusals and the route and token checks', () => {
  assert.deepStrictEqual({ ...connectivity.sdkOptions }, { connectivity: true });
  assert.strictEqual(connectivity.refusal, connectivityRefusal);
  assert.strictEqual(connectivity.preflight, connectivityPreflight);
  assert.ok(Object.isFrozen(connectivity) && Object.isFrozen(connectivity.sdkOptions), 'a script cannot change the shared plan');
});

// --- sdkFirst ---------------------------------------------------------------------------------------------------------------------

test('an SDK that answers is the answer: no pac, and the throwaway workspace is there for the read and gone after it', async () => {
  const { made, module } = stubSdkModule();
  let pacAsked = false;
  const result = await sdkFirst(ENV, {
    ...noPreflight,
    refusal: () => null,
    fromSdk: async (sdk) => {
      assert.strictEqual(fs.existsSync(made[0].dir), true, 'the workspace exists while the SDK reads');
      return { read: sdk.marker };
    },
    fromPac: async () => { pacAsked = true; },
  }, { sdkModule: module, httpClient: { marker: 'client' } });
  assert.deepStrictEqual(result, { source: 'sdk', value: { read: 'sdk' } });
  assert.strictEqual(pacAsked, false);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(made[0].existedWhenMade, true, 'the directory is made before the SDK is');
  assert.strictEqual(made[0].cfg.instanceUrl, ENV);
  assert.deepStrictEqual(made[0].cfg.httpClient, { marker: 'client' });
  assert.strictEqual(fs.existsSync(made[0].dir), false, 'removed once the read ends');
});

test('the SDK is made with the plan\'s options, and the org client the plan names unless a seam is given', async () => {
  const a = stubSdkModule();
  await sdkFirst(ENV, { ...connectivity, preflight: undefined, fromSdk: async () => 1, fromPac: async () => 2 }, { sdkModule: a.module });
  assert.strictEqual(a.made[0].cfg.connectivity, true, 'connectivity is the factory\'s option, asked for by the plan');
  assert.strictEqual(typeof a.made[0].cfg.httpClient.get, 'function', 'by default the plugin\'s az-token client');

  const b = stubSdkModule();
  const planClient = { marker: 'plan' };
  await sdkFirst(ENV, { ...noPreflight, refusal: () => null, httpClient: (env) => ({ ...planClient, env }), fromSdk: async () => 1, fromPac: async () => 2 }, { sdkModule: b.module });
  assert.deepStrictEqual(b.made[0].cfg.httpClient, { marker: 'plan', env: ENV });

  const c = stubSdkModule();
  await sdkFirst(ENV, { ...noPreflight, refusal: () => null, httpClient: () => planClient, fromSdk: async () => 1, fromPac: async () => 2 }, { sdkModule: c.module, httpClient: { marker: 'seam' } });
  assert.deepStrictEqual(c.made[0].cfg.httpClient, { marker: 'seam' }, 'a test\'s seam wins');
  assert.strictEqual('connectivity' in c.made[0].cfg, false, 'a plan that does not ask for connectivity does not get it');
});

test('a refusal is answered by pac, with the refusal as the fallback — and pac runs after the workspace is gone', async () => {
  const { made, module } = stubSdkModule();
  const refusal = { code: 'CONNECTIVITY_ROUTE_DECOMMISSIONED', message: 'the service has been switched off' };
  let seenByPac;
  const result = await sdkFirst(ENV, {
    ...noPreflight,
    refusal: (error) => (error.code === refusal.code ? refusal : null),
    fromSdk: async () => { throw err(refusal.code); },
    fromPac: async (why) => {
      seenByPac = { why, workspaceGone: !fs.existsSync(made[0].dir) };
      return ['from pac'];
    },
  }, { sdkModule: module, httpClient: {} });
  assert.deepStrictEqual(result, { source: 'pac', value: ['from pac'], fallback: refusal });
  assert.deepStrictEqual(seenByPac, { why: refusal, workspaceGone: true });
});

test('a failure that is not a refusal is thrown as it is, pac is never asked, and the workspace is still removed', async () => {
  for (const failure of [
    err('CONNECTION_ERROR', 'HTTP 403 from https://api.bap.microsoft.com/x: forbidden', { statusCode: 403 }),
    err('CONNECTION_ERROR', 'HTTP 503', { statusCode: 503 }),
    err('CONNECTIVITY_RESPONSE_UNREADABLE'),
    err('CONNECTOR_OPERATION_NOT_FOUND'),
    new Error('plain'),
  ]) {
    const { made, module } = stubSdkModule();
    let pacAsked = false;
    await assert.rejects(
      sdkFirst(ENV, { ...connectivity, preflight: undefined, fromSdk: async () => { throw failure; }, fromPac: async () => { pacAsked = true; } }, { sdkModule: module, httpClient: {} }),
      (thrown) => { assert.strictEqual(thrown, failure, 'the very error the SDK threw'); return true; }
    );
    assert.strictEqual(pacAsked, false, failure.message);
    assert.strictEqual(fs.existsSync(made[0].dir), false, 'removed although the read failed');
  }
});

test('a failure while the SDK is being made is a failure of the read, and the workspace is removed then too', async () => {
  const boom = err('WORKSPACE_ORG_MISMATCH');
  const { made, module } = stubSdkModule({ throwOnCreate: boom });
  await assert.rejects(sdkFirst(ENV, { ...noPreflight, refusal: () => null, fromSdk: async () => 1, fromPac: async () => 2 }, { sdkModule: module, httpClient: {} }), (thrown) => thrown === boom);
  assert.strictEqual(fs.existsSync(made[0].dir), false);
});

test('a refusal of the token check skips the SDK altogether: no workspace, no SDK, no org read — pac answers', async () => {
  const { made, module } = stubSdkModule();
  const refusal = { code: 'POWER_APPS_TOKEN_UNAVAILABLE', message: 'no az' };
  const result = await sdkFirst(ENV, {
    refusal: connectivityRefusal,
    preflight: async (env) => { assert.strictEqual(env, ENV); return refusal; },
    fromSdk: async () => { throw new Error('the SDK must not be asked'); },
    fromPac: async (why) => ({ why }),
  }, { sdkModule: module });
  assert.deepStrictEqual(result, { source: 'pac', value: { why: refusal }, fallback: refusal });
  assert.deepStrictEqual(made, []);
});

test('with the connectivity plan an org outside the Public cloud is answered by pac at once: no token read, no workspace, no SDK', async () => {
  const { made, module } = stubSdkModule();
  const reads = [];
  for (const [env, code] of [['https://contoso.crmtest.dynamics.com', 'CONNECTIVITY_NOT_CONFIGURED'], ['https://contoso.crm9.dynamics.com', 'CONNECTIVITY_CLOUD_UNSUPPORTED']]) {
    const result = await sdkFirst(env, {
      ...connectivity,
      fromSdk: async () => { throw new Error('the SDK must not be asked'); },
      fromPac: async (why) => ({ why }),
    }, {
      sdkModule: module,
      getAuthTokenAsync: async () => { reads.push('dataverse'); return 'a'; },
      getPowerAppsTokenAsync: async () => { reads.push('powerapps'); return 'b'; },
    });
    assert.strictEqual(result.source, 'pac', env);
    assert.strictEqual(result.fallback.code, code, env);
    assert.deepStrictEqual(result.value.why, result.fallback, 'pac is told why it is asked');
  }
  assert.deepStrictEqual(made, [], 'no SDK was made, so no workspace was');
  assert.deepStrictEqual(reads, [], 'and no Azure CLI token was read');
});

test('a Public org goes on as before: both tokens are read, the SDK is made for it, and what it answers is the answer', async () => {
  const { made, module } = stubSdkModule();
  const reads = [];
  const result = await sdkFirst(ENV, { ...connectivity, fromSdk: async (sdk) => sdk.marker, fromPac: async () => { throw new Error('pac must not be asked'); } }, {
    sdkModule: module,
    httpClient: {},
    getAuthTokenAsync: async () => { reads.push('dataverse'); return 'a'; },
    getPowerAppsTokenAsync: async () => { reads.push('powerapps'); return 'b'; },
  });
  assert.deepStrictEqual(result, { source: 'sdk', value: 'sdk' });
  assert.deepStrictEqual([...reads].sort(), ['dataverse', 'powerapps']);
  assert.strictEqual(made.length, 1);
});

test('a failure of pac is the caller\'s: it is thrown, whatever the SDK refused', async () => {
  const { module } = stubSdkModule();
  const pacFailure = new Error('pac could not run');
  await assert.rejects(
    sdkFirst(ENV, { refusal: connectivityRefusal, fromSdk: async () => { throw sdkError('CONNECTIVITY_CLOUD_UNSUPPORTED'); }, fromPac: async () => { throw pacFailure; } }, { sdkModule: module, httpClient: {} }),
    (thrown) => thrown === pacFailure
  );
});

test('what the SDK could not clean up before it refused — its cleanup warnings — is carried to the answer of pac, as `warnings`, and the answer is still pac\'s', async () => {
  const { module } = stubSdkModule();
  const refusal = { code: 'SOLUTION_STAGING_UNREADABLE', message: 'the staging reply could not be read' };
  const stagedCopy = 'The staged copy of the package (stagesolutionupload 33333333-3333-4333-8333-333333333333) could not be deleted: HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.0/stagesolutionuploads(33333333-3333-4333-8333-333333333333): denied.';
  const refused = withCleanupWarnings(err(refusal.code), [stagedCopy, 'another note']);
  const result = await sdkFirst(ENV, {
    ...noPreflight,
    refusal: (error) => (error === refused ? refusal : null),
    fromSdk: async () => { throw refused; },
    fromPac: async () => ['from pac'],
  }, { sdkModule: module, httpClient: {} });
  assert.deepStrictEqual(result, { source: 'pac', value: ['from pac'], fallback: refusal, warnings: [stagedCopy, 'another note'] });
  // A copy: what the caller does with the list is not done to the SDK's own.
  result.warnings.push('added by the caller');
  assert.deepStrictEqual(readCleanupWarnings(refused), [stagedCopy, 'another note']);
});

test('and a failure of pac carries them too — the error it throws is the very one pac raised, with the SDK\'s warnings attached the way the SDK attaches them, after any of its own', async () => {
  const { module } = stubSdkModule();
  const refusal = { code: 'SOLUTION_STAGING_UNREADABLE', message: 'unreadable' };
  const pacFailure = withCleanupWarnings(new Error('pac could not run'), ['a note pac\'s failure already had']);
  await assert.rejects(
    sdkFirst(ENV, {
      ...noPreflight,
      refusal: () => refusal,
      fromSdk: async () => { throw withCleanupWarnings(err(refusal.code), ['the staged copy stays']); },
      fromPac: async () => { throw pacFailure; },
    }, { sdkModule: module, httpClient: {} }),
    (thrown) => {
      assert.strictEqual(thrown, pacFailure, 'not a new error');
      assert.deepStrictEqual(readCleanupWarnings(thrown), ['a note pac\'s failure already had', 'the staged copy stays']);
      return true;
    }
  );
  // A failure that is not an object cannot carry them, and is thrown as it is.
  await assert.rejects(
    sdkFirst(ENV, { ...noPreflight, refusal: () => refusal, fromSdk: async () => { throw withCleanupWarnings(err(refusal.code), ['x']); }, fromPac: async () => { throw 'pac said no'; } }, { sdkModule: module, httpClient: {} }),
    (thrown) => thrown === 'pac said no'
  );
});

test('a refusal with nothing to clean up changes nothing: the answer has no `warnings`, and the error pac raises is not touched — so is a refusal made before any SDK existed', async () => {
  const { module } = stubSdkModule();
  const refusal = { code: 'SOLUTION_STAGING_UNREADABLE', message: 'unreadable' };
  for (const refused of [err(refusal.code), withCleanupWarnings(err(refusal.code), [])]) {
    const answered = await sdkFirst(ENV, { ...noPreflight, refusal: () => refusal, fromSdk: async () => { throw refused; }, fromPac: async () => 1 }, { sdkModule: module, httpClient: {} });
    assert.deepStrictEqual(answered, { source: 'pac', value: 1, fallback: refusal });
    const pacFailure = new Error('pac failed');
    await assert.rejects(sdkFirst(ENV, { ...noPreflight, refusal: () => refusal, fromSdk: async () => { throw refused; }, fromPac: async () => { throw pacFailure; } }, { sdkModule: module, httpClient: {} }), (thrown) => {
      assert.strictEqual(thrown, pacFailure);
      assert.strictEqual(readCleanupWarnings(thrown), undefined, 'nothing was attached');
      return true;
    });
  }
  const preflight = await sdkFirst(ENV, { refusal: connectivityRefusal, preflight: async () => refusal, fromSdk: async () => { throw new Error('no SDK'); }, fromPac: async () => 2 }, { sdkModule: module });
  assert.deepStrictEqual(preflight, { source: 'pac', value: 2, fallback: refusal });
});

test('with the real rule, a response body that carries a refusal\'s code does not send the read to pac — the SDK\'s ConnectionError is thrown as it is', async () => {
  const { module } = stubSdkModule();
  const forged = new ConnectionError('https://api.bap.microsoft.com/x', 403, 'service denied this request', { code: 'CONNECTIVITY_CLOUD_UNSUPPORTED', message: 'service denied this request' });
  let pacAsked = false;
  await assert.rejects(
    sdkFirst(ENV, { ...connectivity, preflight: undefined, fromSdk: async () => { throw forged; }, fromPac: async () => { pacAsked = true; return []; } }, { sdkModule: module, httpClient: {} }),
    (thrown) => thrown === forged
  );
  assert.strictEqual(pacAsked, false);
});

test('the workspace is a directory under the OS temp folder with a stable prefix, so a leftover is recognisable', async () => {
  const { made, module } = stubSdkModule();
  await sdkFirst(ENV, { ...noPreflight, refusal: () => null, fromSdk: async () => 1, fromPac: async () => 2 }, { sdkModule: module, httpClient: {} });
  assert.match(require('node:path').basename(made[0].dir), /^sdk-first-/);
  assert.ok(made[0].dir.startsWith(require('node:os').tmpdir()));
});

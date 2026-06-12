const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listEnvsViaPac,
  resolveEnvByIdViaPac,
  deriveInstanceApiUrl,
  mapPacTypeToSku,
  pacToBapEnv,
  runPacAdminList,
  checkPacAuth,
} = require('../lib/pac-bap-shim');

const SAMPLE_PAC_OUTPUT = `Connected as admin@example.onmicrosoft.com

Listing all environments from your tenant...

Listing environment groups from your tenant...
[{"EnvironmentId":"9f930375-571f-ee07-8b8f-d4a9e317c292","EnvironmentUrl":"https://org5fbe4359.crm5.dynamics.com/","OrganizationId":"d1cf0045-de42-f111-b31f-002248ed6f86","DisplayName":"Stage-1","GroupName":"-","Type":"Developer","DomainName":null,"Version":null},{"EnvironmentId":"6c93b05a-a876-e6b1-955b-f024128c5b97","EnvironmentUrl":"https://org4f3774bf.crm5.dynamics.com/","OrganizationId":"0c41fd24-ea42-f111-b31d-002248eb7d9b","DisplayName":"Stage-2","GroupName":"-","Type":"Developer","DomainName":null,"Version":null}]
`;

function fakeExec(stdout) {
  return async () => ({ stdout, stderr: '' });
}

function fakeExecError(message) {
  return async () => { throw new Error(message); };
}

test('deriveInstanceApiUrl: handles standard crmN domains', () => {
  assert.equal(deriveInstanceApiUrl('https://org5fbe4359.crm5.dynamics.com/'), 'https://org5fbe4359.api.crm5.dynamics.com');
  assert.equal(deriveInstanceApiUrl('https://contoso.crm.dynamics.com'), 'https://contoso.api.crm.dynamics.com');
  assert.equal(deriveInstanceApiUrl('https://contoso.crm9.dynamics.com/'), 'https://contoso.api.crm9.dynamics.com');
});

test('deriveInstanceApiUrl: handles trailing slashes consistently', () => {
  assert.equal(deriveInstanceApiUrl('https://x.crm.dynamics.com//'), 'https://x.api.crm.dynamics.com');
});

test('deriveInstanceApiUrl: passes through non-standard hosts (gov clouds etc)', () => {
  assert.equal(deriveInstanceApiUrl('https://contoso.crm.appsplatform.us/'), 'https://contoso.crm.appsplatform.us');
});

test('deriveInstanceApiUrl: returns null for null input', () => {
  assert.equal(deriveInstanceApiUrl(null), null);
  assert.equal(deriveInstanceApiUrl(''), null);
});

test('mapPacTypeToSku: passes through known values', () => {
  assert.equal(mapPacTypeToSku('Developer'), 'Developer');
  assert.equal(mapPacTypeToSku('Production'), 'Production');
  assert.equal(mapPacTypeToSku('Sandbox'), 'Sandbox');
  assert.equal(mapPacTypeToSku('Default'), 'Default');
  assert.equal(mapPacTypeToSku('Trial'), 'Trial');
  assert.equal(mapPacTypeToSku(null), null);
});

test('pacToBapEnv: maps full record', () => {
  const pac = {
    EnvironmentId: 'env-1',
    EnvironmentUrl: 'https://org5fbe4359.crm5.dynamics.com/',
    OrganizationId: 'org-1',
    DisplayName: 'Stage-1',
    Type: 'Developer',
    DomainName: 'org5fbe4359',
    Version: '9.2.0',
  };
  const bap = pacToBapEnv(pac);
  assert.equal(bap.name, 'env-1');
  assert.equal(bap.properties.displayName, 'Stage-1');
  assert.equal(bap.properties.environmentSku, 'Developer');
  assert.equal(bap.properties.linkedEnvironmentMetadata.resourceId, 'org-1');
  assert.equal(bap.properties.linkedEnvironmentMetadata.instanceUrl, 'https://org5fbe4359.crm5.dynamics.com/');
  assert.equal(bap.properties.linkedEnvironmentMetadata.instanceApiUrl, 'https://org5fbe4359.api.crm5.dynamics.com');
  assert.equal(bap.properties.linkedEnvironmentMetadata.domainName, 'org5fbe4359');
  assert.equal(bap.properties.linkedEnvironmentMetadata.version, '9.2.0');
  assert.equal(bap.properties.tenantId, null); // not provided by PAC
  assert.equal(bap.properties.permissions, null);
});

test('pacToBapEnv: handles null/missing fields gracefully', () => {
  const bap = pacToBapEnv({ EnvironmentId: 'e1' });
  assert.equal(bap.name, 'e1');
  assert.equal(bap.properties.displayName, null);
  assert.equal(bap.properties.environmentSku, null);
  assert.equal(bap.properties.linkedEnvironmentMetadata.instanceUrl, null);
});

test('pacToBapEnv: returns null for null input', () => {
  assert.equal(pacToBapEnv(null), null);
});

test('runPacAdminList: parses normal output with header prose', async () => {
  const envs = await runPacAdminList(fakeExec(SAMPLE_PAC_OUTPUT));
  assert.equal(envs.length, 2);
  assert.equal(envs[0].DisplayName, 'Stage-1');
  assert.equal(envs[1].DisplayName, 'Stage-2');
});

test('runPacAdminList: throws on non-zero exit (exec error)', async () => {
  await assert.rejects(
    () => runPacAdminList(fakeExecError('Process exited with code 1: not signed in')),
    /pac admin list failed.*not signed in/,
  );
});

test('runPacAdminList: throws when output has no JSON array', async () => {
  await assert.rejects(
    () => runPacAdminList(fakeExec('Connected as user\n\nNothing here.\n')),
    /no JSON array/,
  );
});

test('runPacAdminList: throws on malformed JSON', async () => {
  await assert.rejects(
    () => runPacAdminList(fakeExec('Connected as user\n[{"bad": json')),
    /Failed to parse pac admin list JSON/,
  );
});

test('listEnvsViaPac: returns BAP-shaped array', async () => {
  const envs = await listEnvsViaPac({ execImpl: fakeExec(SAMPLE_PAC_OUTPUT) });
  assert.equal(envs.length, 2);
  assert.equal(envs[0].name, '9f930375-571f-ee07-8b8f-d4a9e317c292');
  assert.equal(envs[0].properties.displayName, 'Stage-1');
  assert.equal(envs[0].properties.environmentSku, 'Developer');
  assert.equal(envs[0].properties.linkedEnvironmentMetadata.instanceUrl, 'https://org5fbe4359.crm5.dynamics.com/');
  assert.equal(envs[0].properties.linkedEnvironmentMetadata.instanceApiUrl, 'https://org5fbe4359.api.crm5.dynamics.com');
});

test('resolveEnvByIdViaPac: returns matching env', async () => {
  const env = await resolveEnvByIdViaPac({
    envId: '6c93b05a-a876-e6b1-955b-f024128c5b97',
    execImpl: fakeExec(SAMPLE_PAC_OUTPUT),
  });
  assert.ok(env);
  assert.equal(env.properties.displayName, 'Stage-2');
  assert.equal(env.properties.linkedEnvironmentMetadata.instanceUrl, 'https://org4f3774bf.crm5.dynamics.com/');
});

test('resolveEnvByIdViaPac: case-insensitive id matching', async () => {
  const env = await resolveEnvByIdViaPac({
    envId: '9F930375-571F-EE07-8B8F-D4A9E317C292', // upper-case
    execImpl: fakeExec(SAMPLE_PAC_OUTPUT),
  });
  assert.ok(env);
  assert.equal(env.properties.displayName, 'Stage-1');
});

test('resolveEnvByIdViaPac: returns null for non-existent id', async () => {
  const env = await resolveEnvByIdViaPac({
    envId: '00000000-0000-0000-0000-000000000000',
    execImpl: fakeExec(SAMPLE_PAC_OUTPUT),
  });
  assert.equal(env, null);
});

test('resolveEnvByIdViaPac: throws when envId is missing', async () => {
  await assert.rejects(
    () => resolveEnvByIdViaPac({ execImpl: fakeExec(SAMPLE_PAC_OUTPUT) }),
    /envId is required/,
  );
});

test('checkPacAuth: detects signed-in user', async () => {
  const result = await checkPacAuth(fakeExec('Microsoft PowerPlatform CLI\nConnected as alice@example.com\n'));
  assert.equal(result.ok, true);
  assert.equal(result.user, 'alice@example.com');
});

test('checkPacAuth: returns ok when output has no Connected line but exec succeeded', async () => {
  const result = await checkPacAuth(fakeExec('Some other PAC output\n'));
  assert.equal(result.ok, true);
  assert.equal(result.user, null);
});

test('checkPacAuth: returns ok=false on exec error', async () => {
  const result = await checkPacAuth(fakeExecError('No active auth profile'));
  assert.equal(result.ok, false);
  assert.match(result.error, /No active auth profile/);
});

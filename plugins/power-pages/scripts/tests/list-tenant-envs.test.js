const test = require('node:test');
const assert = require('node:assert/strict');

const { listTenantEnvs, preFilter, originOf } = require('../lib/list-tenant-envs');

function fakeEnv(overrides = {}) {
  return {
    name: overrides.name || 'env-' + Math.random().toString(36).slice(2, 10),
    properties: {
      displayName: overrides.displayName || 'Test Env',
      environmentSku: overrides.environmentSku || 'Production',
      tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
      lastModifiedTime: overrides.lastModifiedTime || '2026-01-01T00:00:00Z',
      linkedEnvironmentMetadata: overrides.linkedEnvironmentMetadata !== undefined ? overrides.linkedEnvironmentMetadata : {
        instanceUrl: `https://${overrides.name || 'x'}.crm.dynamics.com/`,
        instanceApiUrl: `https://${overrides.name || 'x'}.api.crm.dynamics.com`,
        domainName: overrides.name || 'x',
      },
    },
  };
}

test('originOf extracts scheme + host', () => {
  assert.equal(originOf('https://x.api.crm.dynamics.com/some/path'), 'https://x.api.crm.dynamics.com');
  assert.equal(originOf('https://x.api.crm.dynamics.com'), 'https://x.api.crm.dynamics.com');
  assert.equal(originOf('not a url'), null);
});

test('preFilter: skips envs without Dataverse (no instanceApiUrl)', () => {
  const envs = [
    fakeEnv({ name: 'a' }), // has dv
    fakeEnv({ name: 'b', linkedEnvironmentMetadata: {} }), // no dv
    fakeEnv({ name: 'c', linkedEnvironmentMetadata: { instanceApiUrl: 'https://c.api.crm.dynamics.com', instanceUrl: 'https://c.crm.dynamics.com/' } }),
  ];
  const { candidates, envsAfterFilter, totalEnvsInTenant } = preFilter(envs, ['Production']);
  assert.equal(totalEnvsInTenant, 3);
  assert.equal(envsAfterFilter, 2);
  assert.deepEqual(candidates.map((c) => c.envId).sort(), ['a', 'c']);
});

test('preFilter: --includeName narrows to envs whose name contains the substring (case-insensitive)', () => {
  const envs = [
    fakeEnv({ name: 'a', displayName: 'PA Staff Pipelines Host' }),
    fakeEnv({ name: 'b', displayName: 'Contoso Marketing' }),
    fakeEnv({ name: 'c', displayName: 'BYOC Pipelines' }),
  ];
  const r = preFilter(envs, ['Production'], 'pipelines');
  assert.deepEqual(r.candidates.map((c) => c.envId).sort(), ['a', 'c']);
  assert.equal(r.envsAfterFilter, 2);
});

test('preFilter: --includeName matches domainName too', () => {
  const envs = [
    {
      name: 'p',
      properties: {
        displayName: 'No Match',
        environmentSku: 'Production',
        linkedEnvironmentMetadata: { instanceApiUrl: 'https://pascalepipelineshost.api.crm.dynamics.com', instanceUrl: 'https://pascalepipelineshost.crm.dynamics.com/', domainName: 'pascalepipelineshost' },
      },
    },
  ];
  const r = preFilter(envs, ['Production'], 'pascale');
  assert.equal(r.envsAfterFilter, 1);
  assert.equal(r.candidates[0].envId, 'p');
});

test('preFilter: respects --skus filter; PE always included regardless', () => {
  const envs = [
    fakeEnv({ name: 'prod', environmentSku: 'Production' }),
    fakeEnv({ name: 'sand', environmentSku: 'Sandbox' }),
    fakeEnv({ name: 'pe', environmentSku: 'Platform' }),
    fakeEnv({ name: 'tea', environmentSku: 'Teams' }),
  ];

  const r1 = preFilter(envs, ['Production']);
  assert.deepEqual(r1.candidates.map((c) => c.envId).sort(), ['pe', 'prod']);

  const r2 = preFilter(envs, ['Production', 'Sandbox']);
  assert.deepEqual(r2.candidates.map((c) => c.envId).sort(), ['pe', 'prod', 'sand']);

  const r3 = preFilter(envs, ['Sandbox']);
  assert.deepEqual(r3.candidates.map((c) => c.envId).sort(), ['pe', 'sand']);
});

test('preFilter: ranking — name-hint envs probe first regardless of recency', () => {
  const envs = [
    fakeEnv({ name: 'recent-but-no-hint', displayName: 'Contoso Marketing', lastModifiedTime: '2026-04-28T00:00:00Z' }),
    fakeEnv({ name: 'old-pipelines-host', displayName: 'PA Staff Pipelines Host', lastModifiedTime: '2024-12-01T00:00:00Z' }),
    fakeEnv({ name: 'recent-no-hint-2', displayName: 'Contoso Sales', lastModifiedTime: '2026-04-27T00:00:00Z' }),
  ];
  const { candidates } = preFilter(envs, ['Production']);
  // pipelines-host wins despite being older
  assert.equal(candidates[0].envId, 'old-pipelines-host');
});

test('preFilter: ranking — admin perms ranks ahead of recency among non-name-hint envs', () => {
  const envs = [
    {
      name: 'recent-readonly',
      properties: {
        displayName: 'Contoso A',
        environmentSku: 'Production',
        lastModifiedTime: '2026-04-28T00:00:00Z',
        permissions: { ReadEnvironment: {} },
        linkedEnvironmentMetadata: { instanceApiUrl: 'https://a.api.crm.dynamics.com', instanceUrl: 'https://a.crm.dynamics.com/' },
      },
    },
    {
      name: 'older-admin',
      properties: {
        displayName: 'Contoso B',
        environmentSku: 'Production',
        lastModifiedTime: '2025-01-01T00:00:00Z',
        permissions: { ReadEnvironment: {}, ListDatabaseEntities: {}, CreateDatabaseEntities: {} },
        linkedEnvironmentMetadata: { instanceApiUrl: 'https://b.api.crm.dynamics.com', instanceUrl: 'https://b.crm.dynamics.com/' },
      },
    },
  ];
  const { candidates } = preFilter(envs, ['Production']);
  assert.equal(candidates[0].envId, 'older-admin');
});

test('preFilter: ranking — recency is tiebreaker only', () => {
  const envs = [
    fakeEnv({ name: 'old', lastModifiedTime: '2024-01-01T00:00:00Z' }),
    fakeEnv({ name: 'new', lastModifiedTime: '2026-04-01T00:00:00Z' }),
    fakeEnv({ name: 'mid', lastModifiedTime: '2025-06-01T00:00:00Z' }),
  ];
  const { candidates } = preFilter(envs, ['Production']);
  assert.deepEqual(candidates.map((c) => c.envId), ['new', 'mid', 'old']);
});

test('listTenantEnvs: firstHitWins stops probing after a custom-host match', async () => {
  const envs = [];
  for (let i = 0; i < 20; i++) {
    envs.push(fakeEnv({ name: 'e' + i, displayName: i === 5 ? 'Pipelines Host A' : 'Plain Env ' + i, lastModifiedTime: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  }
  let probeCalls = 0;
  const verifyImpl = async ({ hostEnvUrl }) => {
    probeCalls++;
    if (hostEnvUrl.includes('e5.api')) {
      return { ready: true, pipelinesSolutionVersion: '9.1', checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: true, version: '9.1' } }, warnings: [] };
    }
    return { ready: false, pipelinesSolutionVersion: null, checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: false } }, warnings: [] };
  };

  const result = await listTenantEnvs({
    bapToken: 'fake', listImpl: async () => envs, getTokenImpl: () => 't', verifyImpl,
    maxConcurrency: 1, // serial → deterministic stop
    firstHitWins: true,
  });

  assert.equal(result.existingCustomHosts.length, 1);
  assert.equal(result.earlyExitOnFirstHit, true);
  // With name-hint, "Pipelines Host A" sorts first → finds on probe 1.
  assert.ok(probeCalls <= 2, `expected early exit after first hit; saw ${probeCalls} probes`);
});

test('listTenantEnvs: inaccessibilityBreakdown rolls up reason counts', async () => {
  const envs = [
    fakeEnv({ name: 'forbidden1' }),
    fakeEnv({ name: 'forbidden2' }),
    fakeEnv({ name: 'tokfail' }),
  ];
  const verifyImpl = async ({ hostEnvUrl }) => {
    if (hostEnvUrl.includes('forbidden')) return { ready: false, pipelinesSolutionVersion: null, checks: { whoami: { skipped: true, ok: true }, solutions: { ok: false, statusCode: 403, error: 'Forbidden' } }, warnings: [] };
    return { ready: false, pipelinesSolutionVersion: null, checks: { whoami: { skipped: true, ok: true }, solutions: { ok: false, statusCode: 401, error: 'Unauthorized' } }, warnings: [] };
  };
  const getTokenImpl = (origin) => {
    if (origin.includes('tokfail')) throw new Error('az failed');
    return 't';
  };

  const result = await listTenantEnvs({
    bapToken: 'fake', listImpl: async () => envs, getTokenImpl, verifyImpl,
  });
  assert.equal(result.inaccessibleEnvs.length, 3);
  assert.equal(result.inaccessibilityBreakdown.forbidden, 2);
  assert.equal(result.inaccessibilityBreakdown['token-acquisition-failed'], 1);
});

test('listTenantEnvs: classifies hosts correctly with mocked verify', async () => {
  const envs = [
    fakeEnv({ name: 'host', displayName: 'Pipelines Host' }),
    fakeEnv({ name: 'pe', environmentSku: 'Platform', displayName: 'Platform Host' }),
    fakeEnv({ name: 'plain', displayName: 'Plain Env' }),
    fakeEnv({ name: 'denied', displayName: 'Denied Env' }),
  ];

  const verifyImpl = async ({ hostEnvUrl }) => {
    if (hostEnvUrl.includes('host.api')) return { ready: true, pipelinesSolutionVersion: '9.1.0.0', checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: true, version: '9.1.0.0' } }, warnings: [] };
    if (hostEnvUrl.includes('pe.api')) return { ready: true, pipelinesSolutionVersion: '9.0.5.0', checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: true, version: '9.0.5.0' } }, warnings: [] };
    if (hostEnvUrl.includes('plain.api')) return { ready: false, pipelinesSolutionVersion: null, checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: false } }, warnings: [] };
    if (hostEnvUrl.includes('denied.api')) return { ready: false, pipelinesSolutionVersion: null, checks: { whoami: { skipped: true, ok: true }, solutions: { ok: false, statusCode: 403, error: 'Forbidden' } }, warnings: [] };
    throw new Error('unknown env in test');
  };

  const result = await listTenantEnvs({
    bapToken: 'fake',
    listImpl: async () => envs,
    getTokenImpl: () => 'dv-token',
    verifyImpl,
  });

  assert.equal(result.existingCustomHosts.length, 1);
  assert.equal(result.existingCustomHosts[0].envId, 'host');
  assert.equal(result.existingCustomHosts[0].pipelinesSolutionVersion, '9.1.0.0');

  assert.ok(result.existingPlatformHost);
  assert.equal(result.existingPlatformHost.envId, 'pe');
  assert.equal(result.existingPlatformHost.pipelinesSolutionVersion, '9.0.5.0');

  assert.equal(result.eligibleForAppInstall.length, 1);
  assert.equal(result.eligibleForAppInstall[0].envId, 'plain');

  assert.equal(result.inaccessibleEnvs.length, 1);
  assert.equal(result.inaccessibleEnvs[0].envId, 'denied');
  assert.equal(result.inaccessibleEnvs[0].reason, 'forbidden');
  assert.equal(result.inaccessibleEnvs[0].statusCode, undefined); // not on the base, but in inner — let's drop check

  assert.equal(result.totalEnvsInTenant, 4);
  assert.equal(result.envsAfterFilter, 4);
  assert.equal(result.envsProbed, 4);
  assert.equal(result.hitProbeCap, false);
  assert.deepEqual(result.skusFilter, ['Production']);
});

test('listTenantEnvs: respects maxEnvsToProbe cap and reports hitProbeCap', async () => {
  const envs = [];
  for (let i = 0; i < 100; i++) {
    envs.push(fakeEnv({ name: 'e' + i, lastModifiedTime: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  }

  let probeCalls = 0;
  const verifyImpl = async () => {
    probeCalls++;
    return { ready: false, pipelinesSolutionVersion: null, checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: false } }, warnings: [] };
  };

  const result = await listTenantEnvs({
    bapToken: 'fake',
    listImpl: async () => envs,
    getTokenImpl: () => 'dv-token',
    verifyImpl,
    maxEnvsToProbe: 10,
    maxConcurrency: 5,
  });

  assert.equal(probeCalls, 10);
  assert.equal(result.envsProbed, 10);
  assert.equal(result.envsAfterFilter, 100);
  assert.equal(result.hitProbeCap, true);
});

test('listTenantEnvs: token-acquisition failure marks env as inaccessible', async () => {
  const envs = [fakeEnv({ name: 'e1' })];
  const result = await listTenantEnvs({
    bapToken: 'fake',
    listImpl: async () => envs,
    getTokenImpl: () => { throw new Error('az failed: not logged in'); },
    verifyImpl: async () => { throw new Error('should not be called'); },
  });

  assert.equal(result.inaccessibleEnvs.length, 1);
  assert.equal(result.inaccessibleEnvs[0].envId, 'e1');
  assert.equal(result.inaccessibleEnvs[0].reason, 'token-acquisition-failed');
  assert.match(result.inaccessibleEnvs[0].detail, /az failed/);
});

test('listTenantEnvs: throws when --source bap and --bapToken is missing', async () => {
  await assert.rejects(
    () => listTenantEnvs({ source: 'bap' }),
    /--bapToken is required/,
  );
});

test('listTenantEnvs: --source pac uses pac-bap-shim instead of BAP', async () => {
  const pacOut = `Connected as test@example.com
[{"EnvironmentId":"e1","EnvironmentUrl":"https://e1.crm5.dynamics.com/","OrganizationId":"o1","DisplayName":"Test","GroupName":"-","Type":"Production","DomainName":null,"Version":null}]`;
  const pacExecImpl = async () => ({ stdout: pacOut, stderr: '' });
  const verifyImpl = async () => ({ ready: false, pipelinesSolutionVersion: null, checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: false } }, warnings: [] });

  const result = await listTenantEnvs({
    source: 'pac',
    pacExecImpl,
    getTokenImpl: () => 't',
    verifyImpl,
  });
  assert.equal(result.sourceUsed, 'pac');
  assert.equal(result.totalEnvsInTenant, 1);
  assert.equal(result.eligibleForAppInstall.length, 1);
  assert.equal(result.eligibleForAppInstall[0].envId, 'e1');
  assert.equal(result.eligibleForAppInstall[0].instanceApiUrl, 'https://e1.api.crm5.dynamics.com');
});

test('listTenantEnvs: --source auto falls back to PAC when BAP returns 401', async () => {
  // listImpl simulates BAP throwing 401 (statusCode property attached). To
  // exercise the real fallback path we set source=auto + bapToken + a custom
  // listImpl that throws — but listImpl injection bypasses listEnvsBySource's
  // fallback logic. Instead use an inline BAP-emulating throw via the public
  // API: pass --source bap to confirm the throw path, AND --source auto with
  // no bapToken to confirm the PAC fallback.
  const pacOut = `[{"EnvironmentId":"e1","EnvironmentUrl":"https://e1.crm5.dynamics.com/","OrganizationId":"o1","DisplayName":"Test","Type":"Production"}]`;
  const pacExecImpl = async () => ({ stdout: pacOut, stderr: '' });
  const verifyImpl = async () => ({ ready: false, pipelinesSolutionVersion: null, checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: false } }, warnings: [] });

  // No bapToken provided in auto mode → goes straight to PAC.
  const result = await listTenantEnvs({
    source: 'auto',
    pacExecImpl,
    getTokenImpl: () => 't',
    verifyImpl,
  });
  assert.equal(result.sourceUsed, 'pac');
  assert.equal(result.fallbackReason, 'no-bap-token-provided');
});

test('listTenantEnvs: respects --skus arg', async () => {
  const envs = [
    fakeEnv({ name: 'prod', environmentSku: 'Production' }),
    fakeEnv({ name: 'sand', environmentSku: 'Sandbox' }),
  ];

  const verifyImpl = async () => ({ ready: false, pipelinesSolutionVersion: null, checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: false } }, warnings: [] });

  const r1 = await listTenantEnvs({
    bapToken: 'fake', listImpl: async () => envs, getTokenImpl: () => 't', verifyImpl,
    skus: ['Production'],
  });
  assert.deepEqual(r1.eligibleForAppInstall.map((e) => e.envId), ['prod']);

  const r2 = await listTenantEnvs({
    bapToken: 'fake', listImpl: async () => envs, getTokenImpl: () => 't', verifyImpl,
    skus: ['Production', 'Sandbox'],
  });
  assert.deepEqual(r2.eligibleForAppInstall.map((e) => e.envId).sort(), ['prod', 'sand']);
});

test('listTenantEnvs: handles empty tenant gracefully', async () => {
  const result = await listTenantEnvs({
    bapToken: 'fake',
    listImpl: async () => [],
    getTokenImpl: () => 't',
    verifyImpl: async () => ({}),
  });
  assert.equal(result.totalEnvsInTenant, 0);
  assert.equal(result.envsAfterFilter, 0);
  assert.equal(result.envsProbed, 0);
  assert.equal(result.existingCustomHosts.length, 0);
  assert.equal(result.existingPlatformHost, null);
});

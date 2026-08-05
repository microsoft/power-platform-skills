'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePacTenantId,
  tenantIdFromToken,
  validateCliTenantAlignment,
} = require('../lib/cli-tenant-alignment');
const { parseArgs, run } = require('../validate-cli-tenant-alignment');

const TENANT_A = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const TENANT_B = '11111111-2222-3333-4444-555555555555';

function fakeJwt(tenantId) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ tid: tenantId })).toString('base64url'),
    '',
  ].join('.');
}

function fakeExecFile({ pacTenant = TENANT_A, azTenant = TENANT_A } = {}) {
  return (command, args) => {
    if (command === 'pac' && args.join(' ') === 'auth who') {
      return `Connected as user@contoso.com\nTenant ID:    ${pacTenant}\n`;
    }
    if (command === 'az' && args.join(' ') === 'account show --query tenantId -o tsv') {
      return `${azTenant}\n`;
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
}

test('parsePacTenantId extracts Tenant ID from PAC auth output', () => {
  assert.equal(parsePacTenantId(`User: u\nTenant ID:    ${TENANT_A}\n`), TENANT_A);
  assert.equal(parsePacTenantId(`Tenant: ${TENANT_A}`), TENANT_A);
  assert.equal(parsePacTenantId('Tenant ID: not-a-guid'), null);
});

test('tenantIdFromToken extracts tid from an Azure CLI access token', () => {
  assert.equal(tenantIdFromToken(fakeJwt(TENANT_A)), TENANT_A);
  assert.equal(tenantIdFromToken('not.jwt'), null);
});

test('validateCliTenantAlignment succeeds when PAC, Azure account, and token tenants match', () => {
  assert.deepEqual(validateCliTenantAlignment({
    envUrl: 'https://org.crm.dynamics.com',
    token: fakeJwt(TENANT_A),
  }, {
    execFile: fakeExecFile(),
  }), {
    ok: true,
    pacTenantId: TENANT_A,
    azTenantId: TENANT_A,
    tokenTenantId: TENANT_A,
    mismatches: [],
    error: null,
  });
});

test('validateCliTenantAlignment blocks when PAC and Azure tenants differ', () => {
  const result = validateCliTenantAlignment({
    envUrl: 'https://org.crm.dynamics.com',
    token: fakeJwt(TENANT_A),
  }, {
    execFile: fakeExecFile({ pacTenant: TENANT_B, azTenant: TENANT_A }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, ['pac-vs-az', 'pac-vs-token']);
  assert.match(result.error, /different tenants/i);
});

test('run requires either an environment URL or token and passes CLI args through', () => {
  assert.deepEqual(parseArgs(['--envUrl', 'https://org.crm.dynamics.com', '--token', 't']), {
    envUrl: 'https://org.crm.dynamics.com',
    token: 't',
  });
  assert.equal(run([]).ok, false);
  assert.equal(run(['--token', fakeJwt(TENANT_A)], { execFile: fakeExecFile() }).ok, true);
});

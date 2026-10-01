'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  CONNECTOR_PERMISSIONS,
  REQUIRED_PERMISSIONS,
  analyzeApplication,
  graphUrl,
  listAvailableApplications,
  parseArgs,
  rankRegistrations,
} = require('../discover-app-registrations');

function applicationWith(access) {
  return {
    appId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    displayName: 'Field Service',
    signInAudience: 'AzureADMultipleOrgs',
    requiredResourceAccess: access,
  };
}

function completeRequiredResources({ includeConnectors = false } = {}) {
  const definitions = includeConnectors
    ? [...REQUIRED_PERMISSIONS, ...CONNECTOR_PERMISSIONS]
    : REQUIRED_PERMISSIONS;
  const resources = [];
  for (const permission of definitions) {
    let resource = resources.find(
      ({ resourceAppId }) => resourceAppId === permission.resourceAppId,
    );
    if (!resource) {
      resource = { resourceAppId: permission.resourceAppId, resourceAccess: [] };
      resources.push(resource);
    }
    resource.resourceAccess.push({ id: permission.permissionId, type: 'Scope' });
  }
  return resources;
}

test('parses tenant and optional client identifiers', () => {
  assert.deepEqual(parseArgs([
    '--tenant-id', 'tenant-id',
    '--client-id', 'client-id',
  ]), {
    tenantId: 'tenant-id',
    clientId: 'client-id',
    includeConnectors: false,
    help: false,
  });
  assert.equal(parseArgs(['--include-connectors']).includeConnectors, true);
  assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
});

test('builds encoded Graph URLs without shell interpolation', () => {
  const url = graphUrl('/applications', {
    $filter: "appId eq 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'",
    $select: 'appId,requiredResourceAccess',
  });
  assert.equal(
    url,
    'https://graph.microsoft.com/v1.0/applications?%24filter=appId+eq+%27aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa%27&%24select=appId%2CrequiredResourceAccess',
  );
});

test('lists every tenant-visible registration across Graph pages instead of owned apps only', () => {
  const requested = [];
  const pages = [
    {
      value: [{ appId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/applications?page=2',
    },
    { value: [{ appId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }] },
  ];
  const applications = listAvailableApplications('', (url) => {
    requested.push(url);
    return pages.shift();
  });

  assert.equal(applications.length, 2);
  assert.match(requested[0], /^https:\/\/graph\.microsoft\.com\/v1\.0\/applications\?/);
  assert.doesNotMatch(requested[0], /ownedObjects/);
  assert.equal(requested[1], 'https://graph.microsoft.com/v1.0/applications?page=2');
});

test('filters a specific client ID at Graph instead of downloading the tenant list', () => {
  const clientId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  let requested;
  listAvailableApplications(clientId, (url) => {
    requested = url;
    return { value: [] };
  });
  assert.match(requested, /%24filter=appId\+eq\+%27aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa%27/);
});

test('baseline requires Dataverse impersonation and PowerApps.Apps.Read', () => {
  const result = analyzeApplication(applicationWith(completeRequiredResources()));
  assert.equal(REQUIRED_PERMISSIONS.length, 2);
  assert.equal(result.passesRequiredPermissions, true);
  assert.deepEqual(result.missingRequiredPermissions, []);
  assert.equal(result.permissionProfile, 'native-runtime');
  assert.equal(result.connectorPermissionsRequired, false);
  assert.equal(result.powerPlatformApi.configuredScopeCount, 1);
  assert.equal(result.powerPlatformApi.requiredScopeCount, 1);
  assert.equal(result.wrapVerificationRequired, true);
});

test('baseline fails when a delegated scope is missing or configured as an app role', () => {
  const resources = completeRequiredResources();
  resources[0].resourceAccess[0].type = 'Role';
  const result = analyzeApplication(applicationWith(resources));

  assert.equal(result.passesRequiredPermissions, false);
  assert.equal(result.missingRequiredPermissions.length, 1);
  assert.match(result.missingRequiredPermissions[0], /^Dynamics CRM\//);
});

test('connector scopes are required only when connector checking is enabled', () => {
  const baselineResources = completeRequiredResources();
  const baselineResult = analyzeApplication(applicationWith(baselineResources));
  const connectorResult = analyzeApplication(applicationWith(baselineResources), {
    includeConnectors: true,
  });

  assert.equal(CONNECTOR_PERMISSIONS.length, 5);
  assert.equal(baselineResult.passesRequiredPermissions, true);
  assert.equal(connectorResult.passesRequiredPermissions, false);
  assert.equal(connectorResult.connectorPermissionsRequired, true);
  assert.deepEqual(connectorResult.missingRequiredPermissions, [
    'Azure API Connections/Runtime.All',
    'Power Platform API/Connectivity.Connectors.Read',
    'Power Platform API/Connectivity.Connections.Read',
    'Power Platform API/Connectivity.Connections.Write',
    'Power Platform API/Connectivity.Connections.UserConsent',
  ]);
  assert.equal(connectorResult.powerPlatformApi.requiredScopeCount, 5);
  assert.equal(connectorResult.powerPlatformApi.configuredScopeCount, 1);
});

test('connector profile passes with all native runtime connector scopes', () => {
  const result = analyzeApplication(
    applicationWith(completeRequiredResources({ includeConnectors: true })),
    { includeConnectors: true },
  );

  assert.equal(result.passesRequiredPermissions, true);
  assert.deepEqual(result.missingRequiredPermissions, []);
  assert.equal(result.powerPlatformApi.requiredScopeCount, 5);
  assert.equal(result.powerPlatformApi.configuredScopeCount, 5);
});

test('ranks passing registrations before failing registrations, then by name', () => {
  const ranked = rankRegistrations([
    {
      displayName: 'Zulu failing',
      clientId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      passesRequiredPermissions: false,
    },
    {
      displayName: 'Beta passing',
      clientId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      passesRequiredPermissions: true,
    },
    {
      displayName: 'Alpha failing',
      clientId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      passesRequiredPermissions: false,
    },
    {
      displayName: 'Alpha passing',
      clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      passesRequiredPermissions: true,
    },
  ]);

  assert.deepEqual(ranked.map(({ displayName }) => displayName), [
    'Alpha passing',
    'Beta passing',
    'Alpha failing',
    'Zulu failing',
  ]);
});

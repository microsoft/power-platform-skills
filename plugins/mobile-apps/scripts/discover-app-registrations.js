#!/usr/bin/env node

const { execFileSync } = require('child_process');

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const POWER_PLATFORM_API_APP_ID = '8578e004-a5c6-46e7-913e-12f58912df43';
const REQUIRED_PERMISSIONS = Object.freeze([
  {
    resourceAppId: '00000007-0000-0000-c000-000000000000',
    resourceName: 'Dynamics CRM',
    permissionName: 'user_impersonation',
    permissionId: '78ce3f0f-a1ce-49c2-8cde-64b5c0896db4',
  },
  {
    resourceAppId: POWER_PLATFORM_API_APP_ID,
    resourceName: 'Power Platform API',
    permissionName: 'PowerApps.Apps.Read',
    permissionId: '5322d31f-39c1-4756-9c92-ae069c366b70',
  },
]);
const CONNECTOR_PERMISSIONS = Object.freeze([
  {
    resourceAppId: 'fe053c5f-3692-4f14-aef2-ee34fc081cae',
    resourceName: 'Azure API Connections',
    permissionName: 'Runtime.All',
    permissionId: '6c3012bf-22c1-4bb5-959b-dff738314144',
  },
  {
    resourceAppId: POWER_PLATFORM_API_APP_ID,
    resourceName: 'Power Platform API',
    permissionName: 'Connectivity.Connectors.Read',
    permissionId: '41e78a9d-569c-4929-ad5e-5ab23eeb83f4',
  },
  {
    resourceAppId: POWER_PLATFORM_API_APP_ID,
    resourceName: 'Power Platform API',
    permissionName: 'Connectivity.Connections.Read',
    permissionId: 'd0ac573f-48ce-4693-88c1-8fa719eb8b45',
  },
  {
    resourceAppId: POWER_PLATFORM_API_APP_ID,
    resourceName: 'Power Platform API',
    permissionName: 'Connectivity.Connections.Write',
    permissionId: '5d973cb3-b843-4baf-bc35-646ccb9181ce',
  },
  {
    resourceAppId: POWER_PLATFORM_API_APP_ID,
    resourceName: 'Power Platform API',
    permissionName: 'Connectivity.Connections.UserConsent',
    permissionId: 'f0d8fd94-fdad-465b-b174-c37a1470196b',
  },
]);
// Permission IDs are the stable contract in an Entra application manifest. Display
// names can change or be unavailable in a tenant, so the pass/fail check must not
// resolve names dynamically or weaken to "any scope for this resource."

function parseArgs(argv) {
  const options = {
    tenantId: '',
    clientId: '',
    includeConnectors: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--tenant-id') {
      options.tenantId = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--client-id') {
      options.clientId = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--include-connectors') {
      options.includeConnectors = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function runAzJson(args, timeout = 30000) {
  let stdout;
  try {
    stdout = execFileSync('az', args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(`Azure CLI command failed${detail ? `: ${detail}` : '.'}`);
  }

  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('Azure CLI returned invalid JSON.');
  }
}

function graphUrl(path, query = {}) {
  const url = new URL(`${GRAPH_ROOT}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function graphGet(url) {
  return runAzJson(['rest', '--method', 'get', '--url', url, '--output', 'json']);
}

function listAvailableApplications(clientId = '', request = graphGet) {
  // `/applications` returns every app registration the signed-in identity is allowed
  // to read in this tenant, unlike `/me/ownedObjects`, which silently hides apps the
  // user can select but does not personally own. Graph pages large directories.
  const query = {
    $select: 'id,appId,displayName,requiredResourceAccess,signInAudience',
    $top: '100',
  };
  if (clientId) query.$filter = `appId eq '${clientId}'`;
  let nextLink = graphUrl('/applications', query);
  const applications = [];
  while (nextLink) {
    const page = request(nextLink);
    if (!Array.isArray(page.value)) throw new Error('Microsoft Graph returned an invalid applications page.');
    applications.push(...page.value);
    nextLink = typeof page['@odata.nextLink'] === 'string' ? page['@odata.nextLink'] : '';
  }
  return applications;
}

function configuredResourceAccess(application, resourceAppId) {
  return (application.requiredResourceAccess || []).find(
    (entry) => String(entry.resourceAppId).toLowerCase() === resourceAppId.toLowerCase(),
  );
}

function analyzeApplication(application, { includeConnectors = false } = {}) {
  const requiredDefinitions = includeConnectors
    ? [...REQUIRED_PERMISSIONS, ...CONNECTOR_PERMISSIONS]
    : REQUIRED_PERMISSIONS;
  const permissions = requiredDefinitions.map((definition) => {
    const configuredResource = configuredResourceAccess(application, definition.resourceAppId);
    const configured = Boolean(configuredResource?.resourceAccess?.some(
      (access) => access.type === 'Scope'
        && String(access.id).toLowerCase() === definition.permissionId.toLowerCase(),
    ));
    return {
      resourceAppId: definition.resourceAppId,
      resourceName: definition.resourceName,
      permissionName: definition.permissionName,
      permissionId: definition.permissionId,
      configured,
    };
  });
  const missingRequiredPermissions = permissions
    .filter((permission) => !permission.configured)
    .map((permission) => `${permission.resourceName}/${permission.permissionName}`);
  const powerPlatformApiPermissions = permissions.filter(
    (permission) => permission.resourceAppId === POWER_PLATFORM_API_APP_ID,
  );

  return {
    displayName: application.displayName || '(unnamed registration)',
    clientId: application.appId,
    signInAudience: application.signInAudience || null,
    passesRequiredPermissions: missingRequiredPermissions.length === 0,
    missingRequiredPermissions,
    permissions,
    permissionProfile: 'native-runtime',
    connectorPermissionsRequired: includeConnectors,
    powerPlatformApi: {
      resourceAppId: POWER_PLATFORM_API_APP_ID,
      configuredScopeCount: powerPlatformApiPermissions.filter(
        (permission) => permission.configured,
      ).length,
      requiredScopeCount: powerPlatformApiPermissions.length,
      missingScopeIds: powerPlatformApiPermissions
        .filter((permission) => !permission.configured)
        .map((permission) => permission.permissionId),
    },
    wrapVerificationRequired: true,
  };
}

function rankRegistrations(registrations) {
  return [...registrations].sort((left, right) => (
    Number(right.passesRequiredPermissions) - Number(left.passesRequiredPermissions)
    || left.displayName.localeCompare(right.displayName)
    || left.clientId.localeCompare(right.clientId)
  ));
}

function discover(options) {
  if (!GUID_PATTERN.test(options.tenantId)) throw new Error('--tenant-id must be a GUID.');
  if (options.clientId && !GUID_PATTERN.test(options.clientId)) throw new Error('--client-id must be a GUID.');

  const account = runAzJson(['account', 'show', '--output', 'json']);
  if (String(account.tenantId).toLowerCase() !== options.tenantId.toLowerCase()) {
    throw new Error(
      `Azure CLI is signed in to tenant ${account.tenantId || '(unknown)'}, not ${options.tenantId}. `
      + `Run az login --tenant ${options.tenantId} and retry.`,
    );
  }

  const applications = listAvailableApplications(options.clientId);
  const registrations = rankRegistrations(applications.map(
    (application) => analyzeApplication(application, {
      includeConnectors: options.includeConnectors,
    }),
  ));
  const requiredPermissionCount = REQUIRED_PERMISSIONS.length
    + (options.includeConnectors ? CONNECTOR_PERMISSIONS.length : 0);

  return {
    tenantId: options.tenantId,
    scope: 'tenant app registrations readable by the signed-in Azure CLI user',
    registrations,
    verification: {
      profile: 'native-runtime',
      connectorPermissionsRequired: options.includeConnectors,
      requiredPermissionCount,
      wrapPageIsFinalAuthority: true,
      documentation: 'https://learn.microsoft.com/power-platform/admin/programmability-permission-reference',
    },
  };
}

function usage() {
  return 'Usage: node scripts/discover-app-registrations.js --tenant-id <tenant-guid> [--client-id <client-guid>] [--include-connectors]\n';
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.tenantId) throw new Error('Missing required --tenant-id.');
  process.stdout.write(`${JSON.stringify(discover(options), null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CONNECTOR_PERMISSIONS,
  POWER_PLATFORM_API_APP_ID,
  REQUIRED_PERMISSIONS,
  analyzeApplication,
  discover,
  graphUrl,
  listAvailableApplications,
  parseArgs,
  rankRegistrations,
};

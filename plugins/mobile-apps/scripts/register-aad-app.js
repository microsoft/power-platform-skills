#!/usr/bin/env node
'use strict';

/**
 * Creates an Azure AD app registration with all permissions required for
 * Power Apps Wrap, then prints the result as JSON to stdout.
 *
 *  Step 1 — Create the app registration (POST /v1.0/applications)
 *    Permissions (requiredResourceAccess): all 7 resources, always included
 *      • Dynamics CRM          user_impersonation  (00000007-0000-0000-c000-000000000000)
 *      • Azure API Connections  user_impersonation  (fe053c5f-3692-4f14-aef2-ee34fc081cae)
 *      • Microsoft Graph        User.Read           (00000003-0000-0000-c000-000000000000)
 *      • Power Apps Service     user_impersonation  (475226c6-020e-4fb2-8a90-7a972cbfc1d4)
 *      • MS Mobile Management   user_impersonation  (0a5f63c0-b750-4f38-a71c-4fc0d58b89e2)
 *      • Power BI Service       user_impersonation  (00000009-0000-0000-c000-000000000000)
 *      • PPAPI (Prod)           [24 scope IDs — required by power-apps-native-host runtime]
 *    signInAudience: AzureADMultipleOrgs
 *    redirectUris: fixed default URIs (nativeclient + PreviewApp iOS)
 *
 *  Step 2 — Create service principal for the new app (POST /v1.0/servicePrincipals)
 *
 *  Step 3 — Ensure resource service principals exist in the tenant
 *    Checks and auto-creates SPs for all 7 resource apps.
 *    Azure API Connections SP is critical — aborts if it cannot be created.
 *
 *  Step 4 — Admin consent  (manual — requires tenant admin via Azure portal)
 *
 * Usage:
 *   node scripts/register-aad-app.js --name "My Wrap App"
 *
 * Output: JSON to stdout, progress logs to stderr.
 *
 * Prerequisites:
 *   az login  (account must have permission to create app registrations in the tenant)
 */

'use strict';

const https = require('https');
const { execSync } = require('child_process');

// ── Wrap required resources (sourced from RegisterAppStepStore.tsx) ────────────

// The 6 core resource app IDs + scope IDs checked by the wizard
const CORE_RESOURCES = [
  {
    name: 'Dynamics CRM',
    resourceAppId: '00000007-0000-0000-c000-000000000000',
    resourceAccess: [{ id: '78ce3f0f-a1ce-49c2-8cde-64b5c0896db4', type: 'Scope' }],
    critical: false,
  },
  {
    name: 'Azure API Connections',
    resourceAppId: 'fe053c5f-3692-4f14-aef2-ee34fc081cae',
    resourceAccess: [{ id: '6c3012bf-22c1-4bb5-959b-dff738314144', type: 'Scope' }],
    critical: true, // wizard bails out if this SP cannot be created
  },
  {
    name: 'Microsoft Graph (User.Read)',
    resourceAppId: '00000003-0000-0000-c000-000000000000',
    resourceAccess: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' }],
    critical: false,
  },
  {
    name: 'Power Apps Service',
    resourceAppId: '475226c6-020e-4fb2-8a90-7a972cbfc1d4',
    resourceAccess: [{ id: '0eb56b90-a7b5-43b5-9402-8137a8083e90', type: 'Scope' }],
    critical: false,
  },
  {
    name: 'Microsoft Mobile Management',
    resourceAppId: '0a5f63c0-b750-4f38-a71c-4fc0d58b89e2',
    resourceAccess: [{ id: '3c7192af-9629-4473-9276-d35e4e4b36c5', type: 'Scope' }],
    critical: false,
  },
  {
    name: 'Power BI Service',
    resourceAppId: '00000009-0000-0000-c000-000000000000',
    resourceAccess: [{ id: '2448370f-f988-42cd-909c-6528efd67c1a', type: 'Scope' }],
    critical: false,
  },
];

// PPAPI resource app IDs and their full scope lists (from RegisterAppStepStore.tsx)
const PPAPI_RESOURCES = {
  prod: {
    name: 'PPAPI (Prod)',
    resourceAppId: '8578e004-a5c6-46e7-913e-12f58912df43',
    critical: false,
    scopeIds: [
      '93a122bb-4b78-4381-a234-56cc6b12dc79',
      '5706ecf7-3ec3-4f46-bc4d-3f213eaf9e83',
      'd0ac573f-48ce-4693-88c1-8fa719eb8b45',
      '5d973cb3-b843-4baf-bc35-646ccb9181ce',
      '41e78a9d-569c-4929-ad5e-5ab23eeb83f4',
      '8e6a1f92-c0f7-4b84-8aa8-1ab4bdfb1c82',
      '41bb9ec4-1ba0-4536-b469-f8dc3b02abb5',
      'a8f38225-01d8-4d6c-962c-53ab897cfa70',
      'a823b91a-e2a1-4e30-9774-6a2c607d61e1',
      'f6be418f-126f-41ee-8599-fd653c4fd4fc',
      '5322d31f-39c1-4756-9c92-ae069c366b70',
      'bc0f8bfd-277e-4548-88d6-add96cd6209d',
      '6e5259c8-1c30-4927-96de-00aa515f1d98',
      'b72fcf5c-70a7-45de-a482-9fc6411646ad',
      '762d250e-a713-4079-ac67-30f85d0fd5ee',
      '49887474-fb04-4916-ba2b-3452315c266e',
      '40a08765-3f68-414c-9bb9-f44e9c57f2e3',
      '1c17c0a7-fe36-40f5-8156-b1161ce468f8',
      'a135f485-d023-45a2-af8c-300720efec39',
      '2d1ddb2f-e258-4d9d-8cdc-b864dce9c8ca',
      'e828b84c-0172-4479-b0fe-45d39c6ffacc',
      '85ec5ebb-3c50-4385-9990-3612a141e9d0',
      'fac2c0a9-0721-490f-bb20-17a798946dc4',
      '34f9c3cb-0c9a-434a-af8e-e01cc25cfb4c',
    ],
  },
};

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (!args.length || args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

function flag(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? true;
}

const appName = flag('--name');

// Always redirect progress logs to stderr so stdout contains only the final JSON.
const _origLog = console.log;
console.log = (...a) => console.error(...a);

if (!appName) {
  console.error('Error: --name <app name> is required.');
  process.exit(1);
}

// ── Fixed redirect URIs ───────────────────────────────────────────────────────

// Always register the legacy nativeclient URI and the default iOS dev-player URI.
const redirectUris = [
  'https://login.microsoftonline.com/common/oauth2/nativeclient',
  'msauth.com.microsoft.PreviewApp://auth',
];

// ── Build required resources ──────────────────────────────────────────────────

// All 7 resources are always included.
const activeResources = [
  ...CORE_RESOURCES,
  {
    name: PPAPI_RESOURCES.prod.name,
    resourceAppId: PPAPI_RESOURCES.prod.resourceAppId,
    resourceAccess: PPAPI_RESOURCES.prod.scopeIds.map((id) => ({ id, type: 'Scope' })),
    critical: PPAPI_RESOURCES.prod.critical,
  },
];

// Strip the `name` / `critical` meta fields before sending to Graph.
const requiredResourceAccess = activeResources.map(({ resourceAppId, resourceAccess }) => ({
  resourceAppId,
  resourceAccess,
}));

// ── Auth: get MS Graph token via Azure CLI ────────────────────────────────────

function getGraphToken() {
  // MS Graph resource ID
  const GRAPH_RESOURCE = '00000003-0000-0000-c000-000000000000';
  try {
    const raw = execSync(
      `az account get-access-token --resource ${GRAPH_RESOURCE} --output json`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 }
    ).toString().trim();
    const parsed = JSON.parse(raw);
    if (parsed.accessToken) return parsed.accessToken;
  } catch {
    // session expired or az not installed
  }

  // Trigger interactive login
  console.log('\nAzure CLI session expired or not found. Opening browser login (az login)…');
  try {
    execSync('az config set core.login_experience_v2=off', { stdio: 'pipe' });
  } catch { /* older CLI — ignore */ }

  try {
    execSync('az login', { stdio: 'inherit', timeout: 120000 });
  } catch (err) {
    if ((err.message || '').includes('command not found')) {
      console.error('\nAzure CLI (az) not found. Install it from https://aka.ms/installazurecli');
      process.exit(1);
    }
    console.error('\naz login failed or was cancelled.');
    process.exit(1);
  }

  const raw = execSync(
    `az account get-access-token --resource ${GRAPH_RESOURCE} --output json`,
    { stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 }
  ).toString().trim();
  const parsed = JSON.parse(raw);
  if (!parsed.accessToken) {
    console.error('Failed to obtain access token after login.');
    process.exit(1);
  }
  return parsed.accessToken;
}

// ── Graph HTTP helper ─────────────────────────────────────────────────────────

function graphRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(
      {
        hostname: 'graph.microsoft.com',
        port: 443,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            let detail = text;
            try {
              detail = JSON.parse(text)?.error?.message || text;
            } catch { /* use raw */ }
            const err = new Error(`HTTP ${res.statusCode} ${method} ${path}\n${detail}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          try { resolve(text ? JSON.parse(text) : null); }
          catch { resolve(text); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// (No helpers needed for create-only mode.)

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const token = getGraphToken();

  // ─── Step 1: Create the app registration ────────────────────────────────────
  console.log(`\nStep 1/3  Creating app registration "${appName}"…`);

  let app;
  try {
    app = await graphRequest('POST', '/v1.0/applications', token, {
      displayName: appName,
      signInAudience: 'AzureADMultipleOrgs',
      publicClient: { redirectUris },
      requiredResourceAccess,
    });
  } catch (err) {
    if (err.statusCode === 401) {
      console.error('\n401 Unauthorized — token rejected. Re-run after `az login`.');
    } else {
      console.error('\nFailed to create app registration:', err.message);
    }
    process.exit(1);
  }

  const objectId = app.id;
  const clientId = app.appId;
  console.log(`  ✓ App created  (clientId: ${clientId})`);

  // ─── Step 2: Ensure service principal exists for this app ───────────────────
  console.log('Step 2/3  Verifying service principal for this app…');
  let appSpExists = false;
  try {
    await graphRequest('GET', `/v1.0/servicePrincipals(appId='${clientId}')`, token);
    appSpExists = true;
    console.log('  ✓ Service principal already exists.');
  } catch (err) {
    if (err.statusCode !== 404 && err.statusCode !== 400) {
      console.warn(`  ⚠ Unexpected error checking SP: ${err.message}`);
    }
  }
  if (!appSpExists) {
    try {
      await graphRequest('POST', '/v1.0/servicePrincipals', token, { appId: clientId });
      console.log('  ✓ Service principal created.');
    } catch (err) {
      if (err.statusCode === 409) {
        console.log('  ✓ Service principal already exists.');
      } else {
        console.warn(`  ⚠ Could not create service principal: ${err.message}`);
        console.warn('    Grant admin consent manually in the Azure portal.');
      }
    }
  }

  // ─── Step 3: Ensure resource service principals exist ───────────────────────
  console.log('Step 3/3  Verifying resource service principals…');

  const resourceSPs = activeResources.map((r) => ({
    name: r.name,
    appId: r.resourceAppId,
    critical: r.critical,
  }));

  const spResults = [];
  for (const sp of resourceSPs) {
    let exists = false;
    try {
      await graphRequest('GET', `/v1.0/servicePrincipals(appId='${sp.appId}')`, token);
      exists = true;
    } catch (err) {
      if (err.statusCode !== 404 && err.statusCode !== 400) {
        console.warn(`  ⚠ Unexpected error checking SP for ${sp.name}: ${err.message}`);
      }
    }

    if (exists) {
      console.log(`  ✓ ${sp.name} — SP exists`);
      spResults.push({ ...sp, ok: true });
      continue;
    }

    console.log(`  + ${sp.name} — SP not found, creating…`);
    let created = false;
    try {
      await graphRequest('POST', '/v1.0/servicePrincipals', token, { appId: sp.appId });
      created = true;
      console.log(`  ✓ ${sp.name} — SP created`);
    } catch (err) {
      if (err.statusCode === 403) {
        console.warn(
          `  ⚠ ${sp.name} — SP creation requires tenant admin permissions.\n` +
            '    Ask a tenant admin to consent to this app in the Azure portal.'
        );
      } else if (err.statusCode === 409) {
        created = true;
        console.log(`  ✓ ${sp.name} — SP already exists (concurrent creation)`);
      } else {
        console.warn(`  ⚠ ${sp.name} — failed to create SP: ${err.message}`);
      }
    }

    if (!created && sp.critical) {
      console.error(
        `\nFatal: Could not create the service principal for "${sp.name}" (${sp.appId}).\n` +
          'This SP is required by the Wrap wizard. Ask a tenant admin to create it.'
      );
      process.exit(1);
    }

    spResults.push({ ...sp, ok: created });
  }

  // ─── Step 4 reminder: admin consent ─────────────────────────────────────────
  // Must be completed manually by a tenant admin in the Azure portal.

  // ─── Output JSON ─────────────────────────────────────────────────────────────
  const result = {
    displayName: app.displayName,
    objectId,
    clientId,
    signInAudience: app.signInAudience,
    redirectUris,
    permissionsConfigured: activeResources.map((r) => ({
      name: r.name,
      resourceAppId: r.resourceAppId,
      scopeCount: r.resourceAccess.length,
    })),
    resourceServicePrincipals: spResults.map(({ name, appId, ok }) => ({ name, appId, ok })),
  };

  _origLog(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});

// ── Usage ─────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
Usage:
  node scripts/register-aad-app.js --name "<App Display Name>"

What the script does:
  Step 1  POST /v1.0/applications  — creates the app with all 7 permissions
  Step 2  POST /v1.0/servicePrincipals  — creates the SP for the new app
  Step 3  Checks and auto-creates SPs for each resource app (Dynamics CRM,
          Azure API Connections, Graph, Power Apps, Mobile Mgmt, Power BI,
          PPAPI prod). Azure API Connections is critical.
  Step 4  Admin consent — must be granted manually by a tenant admin.

Default redirect URIs (always registered):
  https://login.microsoftonline.com/common/oauth2/nativeclient
  msauth.com.microsoft.PreviewApp://auth

Output: JSON to stdout, progress to stderr.

Prerequisites:
  az login   (account must have permission to create app registrations)

Example:
  node scripts/register-aad-app.js --name "Field Service Mobile"
  node scripts/register-aad-app.js --name "My App" | jq .clientId
`);
}

#!/usr/bin/env node

// Links an mspp_sitesetting record to an environmentvariabledefinition via OData PATCH.
// Uses the v9.0 API (not v9.2) with specific headers required by the Power Pages Management app.
//
// HAR-confirmed pattern: Must use v9.0, not v9.2. Navigation property is "EnvironmentValue"
// (not "mspp_environmentvariable"). Headers "if-match: *" and "clienthost: Browser" are required
// — omitting them causes 400. This pattern was validated against a live environment.
//
// Usage: node link-site-setting-to-env-var.js
//          --envUrl <url> --token <token>
//          --siteSettingId <guid>
//          --definitionId <guid>
//          --schemaName <name>
//
// Output (JSON to stdout):
//   { "ok": true, "verified": true, "siteSettingId": "...", "definitionId": "..." }
//
// Exit 0 on success, exit 1 on failure.

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { envUrl: null, token: null, siteSettingId: null, definitionId: null, schemaName: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) result.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    else if (args[i] === '--siteSettingId' && args[i + 1]) result.siteSettingId = args[++i];
    else if (args[i] === '--definitionId' && args[i + 1]) result.definitionId = args[++i];
    else if (args[i] === '--schemaName' && args[i + 1]) result.schemaName = args[++i];
  }

  return result;
}

async function linkSiteSettingToEnvVar({ envUrl, token, siteSettingId, definitionId, schemaName }) {
  if (!envUrl || !siteSettingId || !definitionId || !schemaName) {
    throw new Error('--envUrl, --siteSettingId, --definitionId, and --schemaName are all required');
  }

  const resolvedToken = token || getAuthToken(envUrl);
  if (!resolvedToken) throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');

  // CRITICAL: Must use v9.0 API (not v9.2). Navigation property is "EnvironmentValue".
  // Headers "if-match: *" and "clienthost: Browser" are required by the PP Management app endpoint.
  const body = JSON.stringify({
    mspp_envvar_schema: schemaName,
    'EnvironmentValue@odata.bind': `/environmentvariabledefinitions(${definitionId})`,
    'EnvironmentValue@OData.Community.Display.V1.FormattedValue': schemaName,
    mspp_source: 1,
  });

  const res = await helpers.makeRequest({
    url: `${envUrl}/api/data/v9.0/mspp_sitesettings(${siteSettingId})`,
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${resolvedToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'if-match': '*',
      clienthost: 'Browser',
      'x-ms-app-name': 'mspp_PowerPageManagement',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    body,
    timeout: 30000,
  });

  if (res.error) throw new Error(`API request failed: ${res.error}`);

  if (res.statusCode !== 204 && res.statusCode !== 200) {
    throw new Error(
      `PATCH mspp_sitesettings failed (${res.statusCode}): ${res.body}\n` +
      'Hint: Check that siteSettingId and definitionId are valid GUIDs and that v9.0 API is used.'
    );
  }

  // Verify the link was applied
  const verifyUrl = new URL(`${envUrl}/api/data/v9.2/mspp_sitesettings(${siteSettingId})`);
  verifyUrl.searchParams.set('$select', 'mspp_source,_mspp_environmentvariable_value,mspp_envvar_schema');

  const verifyRes = await helpers.makeRequest({
    url: verifyUrl.toString(),
    headers: {
      Authorization: `Bearer ${resolvedToken}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    timeout: 15000,
  });

  let verified = false;
  if (verifyRes.statusCode === 200) {
    try {
      const data = JSON.parse(verifyRes.body);
      verified =
        data.mspp_source === 1 &&
        data._mspp_environmentvariable_value === definitionId;
    } catch {}
  }

  return { ok: true, verified, siteSettingId, definitionId };
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);

  linkSiteSettingToEnvVar(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { linkSiteSettingToEnvVar };

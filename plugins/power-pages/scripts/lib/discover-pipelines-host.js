#!/usr/bin/env node

// Discovers the tenant-level default Power Platform Pipelines host environment URL.
//
// Calls RetrieveSetting on the dev/source environment to find the host:
//   POST {envUrl}/api/data/v9.1/RetrieveSetting
//   Body: { "SettingName": "DefaultCustomPipelinesHostEnvForTenant", "CallerObjectId": "{userId}" }
//
// Usage: node discover-pipelines-host.js --envUrl <url> --token <token> --userId <userId>
//
// Output (JSON to stdout):
//   { "found": true, "hostEnvUrl": "https://..." }
//   { "found": false, "hostEnvUrl": null }
//
// Exit 0 on success (including "not found"), exit 1 on error (stderr).

'use strict';

const helpers = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  let envUrl = null;
  let token = null;
  let userId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
    else if (args[i] === '--userId' && args[i + 1]) userId = args[++i];
  }

  return { envUrl, token, userId };
}

async function discoverPipelinesHost({ envUrl, token, userId } = {}) {
  if (!envUrl) {
    throw new Error('--envUrl is required');
  }
  if (!token) {
    throw new Error('--token is required');
  }
  if (!userId) {
    throw new Error('--userId is required');
  }

  const cleanEnvUrl = envUrl.replace(/\/+$/, '');

  const body = JSON.stringify({
    SettingName: 'DefaultCustomPipelinesHostEnvForTenant',
    CallerObjectId: userId,
  });

  const res = await helpers.makeRequest({
    url: `${cleanEnvUrl}/api/data/v9.1/RetrieveSetting`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body,
    timeout: 15000,
  });

  if (res.error) {
    throw new Error(`RetrieveSetting request failed: ${res.error}`);
  }

  // 404 means setting not found or not supported — treat as not configured
  if (res.statusCode === 404) {
    return { found: false, hostEnvUrl: null };
  }

  if (res.statusCode !== 200) {
    throw new Error(`RetrieveSetting returned unexpected status ${res.statusCode}: ${res.body}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`Failed to parse RetrieveSetting response: ${e.message}`);
  }

  const settingValue = data.SettingValue || data.settingvalue || null;

  if (!settingValue || settingValue.trim() === '') {
    return { found: false, hostEnvUrl: null };
  }

  return { found: true, hostEnvUrl: settingValue.trim() };
}

// CLI entry point
if (require.main === module) {
  const { envUrl, token, userId } = parseArgs(process.argv);

  discoverPipelinesHost({ envUrl, token, userId })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { discoverPipelinesHost };

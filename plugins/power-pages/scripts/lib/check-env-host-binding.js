#!/usr/bin/env node

// Checks whether a Dataverse environment is bound to a Power Platform Pipelines host
// via the org-db setting `ProjectHostEnvironmentId`. Mirrors `useGetOrgDbOrgSetting`
// from ProjectHostProvider.tsx — same setting name the Pipelines UI reads.
//
//   POST {envUrl}/api/data/v9.0/GetOrgDbOrgSetting
//   Body: { "SettingName": "ProjectHostEnvironmentId" }
//
// Empty or whitespace SettingValue → not bound.
// Non-empty SettingValue → bound; returns the env GUID (BAP environment "name" / id).
//
// Usage: node check-env-host-binding.js --envUrl <url> --token <token>
//
// Output (JSON to stdout):
//   { "bound": false, "hostEnvId": null }
//   { "bound": true,  "hostEnvId": "<guid>" }
//
// Exit 0 on success (including "not bound"), exit 1 on error (stderr).

'use strict';

const helpers = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  let envUrl = null;
  let token = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
  }

  return { envUrl, token };
}

async function checkEnvHostBinding({ envUrl, token } = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!token) throw new Error('--token is required');

  const cleanEnvUrl = envUrl.replace(/\/+$/, '');

  const body = JSON.stringify({ SettingName: 'ProjectHostEnvironmentId' });

  const res = await helpers.makeRequest({
    url: `${cleanEnvUrl}/api/data/v9.0/GetOrgDbOrgSetting`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-Version': '4.0',
      'OData-MaxVersion': '4.0',
    },
    body,
    timeout: 15000,
  });

  if (res.error) {
    throw new Error(`GetOrgDbOrgSetting request failed: ${res.error}`);
  }

  // 404 → action not registered or env unreachable; treat as "not bound" to mirror
  // ProjectHostProvider.tsx behavior on missing setting.
  if (res.statusCode === 404) {
    return { bound: false, hostEnvId: null };
  }

  if (res.statusCode !== 200) {
    throw new Error(`GetOrgDbOrgSetting returned unexpected status ${res.statusCode}: ${res.body}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`Failed to parse GetOrgDbOrgSetting response: ${e.message}`);
  }

  const settingValue = data.SettingValue || data.settingvalue || null;

  if (!settingValue || settingValue.trim() === '') {
    return { bound: false, hostEnvId: null };
  }

  return { bound: true, hostEnvId: settingValue.trim() };
}

if (require.main === module) {
  const { envUrl, token } = parseArgs(process.argv);

  checkEnvHostBinding({ envUrl, token })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { checkEnvHostBinding };

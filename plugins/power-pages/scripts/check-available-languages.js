#!/usr/bin/env node
'use strict';

const { makeRequest } = require('./lib/validation-helpers');
const { formatJsonResult } = require('./lib/template-cli-args');

const REQUIRED_EN_US_LCID = 1033;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--envUrl') args.envUrl = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
  }
  return args;
}

async function checkAvailableLanguages({ envUrl, token, request = makeRequest } = {}) {
  if (!envUrl) {
    return { ok: false, error: 'Missing --envUrl.' };
  }
  if (!token) {
    return { ok: false, error: 'Missing --token.' };
  }

  const normalizedEnvUrl = envUrl.replace(/\/+$/, '');
  const res = await request({
    url: `${normalizedEnvUrl}/api/data/v9.2/RetrieveAvailableLanguages`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    timeout: 30000,
  });

  if (res.error) {
    return { ok: false, error: `RetrieveAvailableLanguages request failed: ${res.error}` };
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      ok: false,
      error: `RetrieveAvailableLanguages returned HTTP ${res.statusCode}: ${(res.body || '').slice(0, 400)}`,
    };
  }

  let payload;
  try {
    payload = JSON.parse(res.body || '{}');
  } catch (err) {
    return { ok: false, error: `RetrieveAvailableLanguages returned invalid JSON: ${err.message}` };
  }

  // Dataverse returns available language LCIDs as:
  //   { "LocaleIds": [1033, 1036, ...] }
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrieveavailablelanguages
  // Importing the starter templates is blocked unless en-US (1033) is present because
  // the template solutions are authored against en-US metadata.
  if (!Array.isArray(payload.LocaleIds)) {
    return { ok: false, error: 'RetrieveAvailableLanguages response did not include a LocaleIds array.' };
  }

  const localeIds = payload.LocaleIds.filter((id) => Number.isInteger(id));
  return {
    ok: true,
    hasEnUs: localeIds.includes(REQUIRED_EN_US_LCID),
    requiredLocaleId: REQUIRED_EN_US_LCID,
    localeIds,
  };
}

async function main() {
  const result = await checkAvailableLanguages(parseArgs());
  process.stdout.write(formatJsonResult(result));
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write(formatJsonResult({ ok: false, error: err.message }));
    process.exit(0);
  });
}

module.exports = {
  REQUIRED_EN_US_LCID,
  checkAvailableLanguages,
  parseArgs,
};

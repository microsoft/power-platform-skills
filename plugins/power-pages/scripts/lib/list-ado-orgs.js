#!/usr/bin/env node

// Lists Azure DevOps organizations the supplied token can access.
// Used by git-configure discovery flows (Phase 4) before project/repo selection.
//
// Output (JSON to stdout):
//   { "ok": true, "memberId": "<guid>", "count": 1, "orgs": [{ "accountId": "<guid>", "accountName": "org", "accountUri": "https://..." }] }
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null }
//
// Usage:
//   node list-ado-orgs.js --token <bearer-or-pat> [--profileEndpoint <url>] [--accountsEndpoint <url>]

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');
const { resolveAdoToken } = require('./resolve-ado-token');

const API_VERSION = '7.1';
const PROFILE_ENDPOINT = `https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=${API_VERSION}`;
const ACCOUNTS_ENDPOINT = `https://app.vssps.visualstudio.com/_apis/accounts?api-version=${API_VERSION}`;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { token: null, tokenFile: null, profileEndpoint: null, accountsEndpoint: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
    else if (args[i] === '--profileEndpoint' && args[i + 1]) out.profileEndpoint = args[++i];
    else if (args[i] === '--accountsEndpoint' && args[i + 1]) out.accountsEndpoint = args[++i];
  }
  return out;
}

function failure(statusCode, error, hint = null) {
  return { ok: false, statusCode: statusCode == null ? null : statusCode, error, hint };
}

function parseJson(res, context) {
  try { return { ok: true, body: JSON.parse(res.body || '{}') }; }
  catch (e) { return { ok: false, error: `Failed to parse ${context}: ${e.message}` }; }
}

function errorMessage(res) {
  if (!res) return 'No response';
  if (res.error) return res.error;
  try { return JSON.parse(res.body || '{}').message || `HTTP ${res.statusCode}`; }
  catch { return `HTTP ${res.statusCode}`; }
}

function hintForStatus(statusCode, step) {
  if (statusCode === 401) {
    return step === 'profile'
      ? 'Token rejected by ADO Profile API. If using a PAT, confirm "User Profile (read)" scope. If using OAuth, the bearer token needs `vso.profile` scope (default for az-minted ADO tokens).'
      : 'Token rejected by ADO Accounts API. Confirm the token belongs to the same signed-in user and includes ADO profile/account access.';
  }
  if (statusCode === 404 && step === 'accounts') {
    return 'Profile returned no associated organizations. Has the user signed in to dev.azure.com at least once?';
  }
  return null;
}

async function listAdoOrgs(options = {}) {
  const { token, tokenFile } = options;
  const request = typeof options._makeRequestImpl === 'function' ? options._makeRequestImpl : makeRequest;
  const tokenResult = resolveAdoToken({ token, tokenFile, env: process.env });
  if (!tokenResult.ok) return failure(null, tokenResult.error);

  const { header: authHeader } = buildAuthHeader(tokenResult.token);
  const profileUrl = options.profileEndpoint || PROFILE_ENDPOINT;
  const profileRes = await request({ url: profileUrl, method: 'GET', headers: { Authorization: authHeader, Accept: 'application/json' } });
  if (profileRes && profileRes.error) return failure(null, profileRes.error);
  if (!profileRes || profileRes.statusCode !== 200) {
    const sc = profileRes && profileRes.statusCode;
    return failure(sc || null, errorMessage(profileRes), hintForStatus(sc, 'profile'));
  }
  const parsedProfile = parseJson(profileRes, 'profile response');
  if (!parsedProfile.ok) return failure(200, parsedProfile.error);
  const memberId = parsedProfile.body && parsedProfile.body.id;
  if (!GUID_RE.test(String(memberId || ''))) return failure(200, 'Profile response id is missing or is not a GUID.', null);

  const baseAccounts = options.accountsEndpoint || ACCOUNTS_ENDPOINT;
  const sep = baseAccounts.includes('?') ? '&' : '?';
  const accountsUrl = `${baseAccounts}${sep}memberId=${encodeURIComponent(memberId)}`;
  const accountsRes = await request({ url: accountsUrl, method: 'GET', headers: { Authorization: authHeader, Accept: 'application/json' } });
  if (accountsRes && accountsRes.error) return failure(null, accountsRes.error);
  if (!accountsRes || accountsRes.statusCode !== 200) {
    const sc = accountsRes && accountsRes.statusCode;
    return failure(sc || null, errorMessage(accountsRes), hintForStatus(sc, 'accounts'));
  }
  const parsedAccounts = parseJson(accountsRes, 'accounts response');
  if (!parsedAccounts.ok) return failure(200, parsedAccounts.error);
  if (!Array.isArray(parsedAccounts.body.value)) return failure(200, 'Accounts response missing value array.', null);

  const orgs = parsedAccounts.body.value.map((a) => ({
    accountId: a.accountId || null,
    accountName: a.accountName || null,
    accountUri: a.accountUri || null,
  }));
  return { ok: true, memberId, count: orgs.length, orgs };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  listAdoOrgs(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('list-ado-orgs: ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
}

module.exports = { listAdoOrgs, API_VERSION, PROFILE_ENDPOINT, ACCOUNTS_ENDPOINT, GUID_RE };

#!/usr/bin/env node

// Discovers unmanaged Dataverse solutions that are candidates for enabling
// source-control integration after a Power Platform environment is Git-bound.
//
// System solutions and known Microsoft/system publisher prefixes are filtered
// out by default so skills can present a safe picker to users.
//
// Output (JSON to stdout):
//   { "ok": true, "envUrl": "https://...", "count": 1, "solutions": [{ "solutionId": "<guid>", "uniqueName": "foo", "friendlyName": "Foo", "version": "1.0.0.0", "modifiedOn": "<date>", "publisherPrefix": "abc" }] }
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null }
//
// Usage:
//   node discover-enableable-solutions.js --envUrl <url> [--token <bearer>] [--includeAllPrefixes]

'use strict';

const { makeRequest, getAuthToken } = require('./validation-helpers');

const API_VERSION = 'v9.0';
const SYSTEM_SOLUTION_RE = /^(Default|Active|System|Cdsbase|crmbaseschema|ConnectionRoles)$/i;
const DEFAULT_SYSTEM_PREFIXES = ['cr', 'msdyn', 'msft', 'sample'];
const MICROSOFT_DEFAULT_PUBLISHER = 'MicrosoftDefault';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, includeAllPrefixes: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--includeAllPrefixes') out.includeAllPrefixes = true;
  }
  return out;
}
function failure(statusCode, error, hint = null) { return { ok: false, statusCode: statusCode == null ? null : statusCode, error, hint }; }
function errorMessage(res) { try { const b = JSON.parse(res.body || '{}'); return (b.error && b.error.message) || b.message || `HTTP ${res.statusCode}`; } catch { return res && res.error ? res.error : `HTTP ${res && res.statusCode}`; } }
function hintForStatus(sc) {
  if (sc === 401) return 'Dataverse token rejected. Run `az login` if expired.';
  if (sc === 404) return 'Dataverse environment not found or the solutions endpoint is unavailable.';
  return null;
}
function normalizeEnvUrl(envUrl) { return String(envUrl || '').replace(/\/+$/, ''); }
function isSystemSolution(solution, includeAllPrefixes = false, systemPrefixes = DEFAULT_SYSTEM_PREFIXES) {
  const uniqueName = solution.uniquename || solution.uniqueName || '';
  if (SYSTEM_SOLUTION_RE.test(uniqueName)) return true;
  const publisher = solution.publisherid || {};
  if (publisher.uniquename === MICROSOFT_DEFAULT_PUBLISHER) return true;
  const prefix = String(publisher.customizationprefix || solution.publisherPrefix || '').toLowerCase();
  if (!includeAllPrefixes && systemPrefixes.map((p) => p.toLowerCase()).includes(prefix)) return true;
  return false;
}

async function discoverEnableableSolutions(options = {}) {
  const { envUrl } = options;
  const request = typeof options._makeRequestImpl === 'function' ? options._makeRequestImpl : makeRequest;
  const getToken = typeof options._getTokenImpl === 'function' ? options._getTokenImpl : getAuthToken;
  if (!envUrl) return failure(null, '--envUrl is required');
  const normalizedEnv = normalizeEnvUrl(envUrl);
  const token = options.token || getToken(normalizedEnv);
  if (!token) return failure(null, 'Dataverse token is required. Pass --token or run `az login` first.', 'Dataverse token rejected. Run `az login` if expired.');
  const query =
    '$filter=ismanaged eq false and isvisible eq true and enabledforsourcecontrolintegration eq false' +
    '&$select=solutionid,uniquename,friendlyname,version,modifiedon,_publisherid_value' +
    '&$expand=publisherid($select=customizationprefix,uniquename)' +
    '&$orderby=modifiedon desc';
  const url = `${normalizedEnv}/api/data/${API_VERSION}/solutions?${query}`;
  const res = await request({ url, method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res && res.error) return failure(null, res.error);
  if (!res || res.statusCode !== 200) return failure(res && res.statusCode || null, errorMessage(res), hintForStatus(res && res.statusCode));
  let body;
  try { body = JSON.parse(res.body || '{}'); } catch (e) { return failure(200, 'Failed to parse solutions response: ' + e.message); }
  if (!Array.isArray(body.value)) return failure(200, 'Solutions response missing value array.');
  const solutions = body.value
    .filter((s) => !isSystemSolution(s, !!options.includeAllPrefixes, options.systemPrefixes || DEFAULT_SYSTEM_PREFIXES))
    .map((s) => ({
      solutionId: s.solutionid || null,
      uniqueName: s.uniquename || null,
      friendlyName: s.friendlyname || null,
      version: s.version || null,
      modifiedOn: s.modifiedon || null,
      publisherPrefix: s.publisherid && s.publisherid.customizationprefix || null,
    }));
  return { ok: true, envUrl: normalizedEnv, count: solutions.length, solutions };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  discoverEnableableSolutions(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('discover-enableable-solutions: ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
}
module.exports = { discoverEnableableSolutions, isSystemSolution, API_VERSION, SYSTEM_SOLUTION_RE, DEFAULT_SYSTEM_PREFIXES, MICROSOFT_DEFAULT_PUBLISHER };

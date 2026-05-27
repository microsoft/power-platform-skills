'use strict';

// Core logic for the `check-solution-installed` CLI, exposed as a function so
// the unit tests can mock `helpers.makeRequest` without spawning a subprocess
// or hitting the network.
//
// The CLI wrapper at scripts/check-solution-installed.js just resolves env
// URL + auth token and calls checkSolutionInstalled below.

const helpers = require('./validation-helpers');

const UNIQUE_NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * Validates and normalizes a Dataverse environment URL before it is passed
 * to anything that interpolates it into a shell command (notably
 * helpers.getAuthToken, which calls `az account get-access-token --resource
 * "${url}"` via execSync). Returns the URL's `origin` only (scheme + host +
 * optional port) so path, query, fragment, and userinfo are all stripped.
 *
 * Throws on:
 *   - non-string / empty input
 *   - input that `new URL()` can't parse
 *   - non-https protocol (Dataverse refuses http and we don't want file: etc.)
 *   - URLs with embedded userinfo (https://user:pass@host) — credentials in
 *     URLs are a smell and can confuse downstream tooling
 *
 * The normalized origin is safe to interpolate into a shell command because
 * URL.origin only contains scheme, host, and port — characters that the
 * URL spec disallows from carrying shell metacharacters.
 *
 * @param {unknown} envUrl
 * @returns {string} sanitized origin, e.g. "https://contoso.crm.dynamics.com"
 * @throws Error with a human-readable message on rejection
 */
function sanitizeEnvUrl(envUrl) {
  if (typeof envUrl !== 'string' || envUrl.trim() === '') {
    throw new Error('envUrl must be a non-empty string.');
  }

  let parsed;
  try {
    parsed = new URL(envUrl);
  } catch {
    throw new Error(`envUrl is not a valid URL: "${envUrl}".`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`envUrl must use https (got "${parsed.protocol}").`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('envUrl must not contain userinfo (username/password). Authentication uses the Azure CLI token, not credentials in the URL.');
  }

  // url.origin is the scheme + host + port — no path, no query, no fragment.
  // For "https://contoso.crm.dynamics.com:443/api/data/v9.2/?x=1#anchor"
  // it returns "https://contoso.crm.dynamics.com:443".
  return parsed.origin;
}

/**
 * @typedef {Object} CheckResult
 * @property {boolean} installed
 * @property {string}  solutionName
 * @property {string|null} [version]
 */

/**
 * Queries the Dataverse `solutions` table for a row matching the given
 * uniquename. The presence of a row means the solution is installed.
 *
 * @param {Object} options
 * @param {string} options.envUrl       — Dataverse environment URL (no trailing slash)
 * @param {string} options.token        — Azure CLI bearer token
 * @param {string} options.solutionName — solution unique name (alphanumeric + underscore)
 * @returns {Promise<CheckResult>}
 * @throws Error with a human-readable message on infrastructure failure
 *         (network error, 401/403, non-200, malformed JSON, etc.)
 */
async function checkSolutionInstalled({ envUrl, token, solutionName } = {}) {
  if (!envUrl) throw new Error('envUrl is required');
  if (!token) throw new Error('token is required');
  if (!solutionName) throw new Error('solutionName is required');
  if (!UNIQUE_NAME_RE.test(solutionName)) {
    throw new Error(`Invalid solution unique name: "${solutionName}". Expected alphanumeric + underscore.`);
  }

  const filter = `uniquename eq '${solutionName}'`;
  const url = `${envUrl}/api/data/v9.2/solutions?$filter=${encodeURIComponent(filter)}&$select=uniquename,version&$top=1`;

  const res = await helpers.makeRequest({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
  });

  if (res.error) {
    throw new Error(`Solution query failed: ${res.error}`);
  }

  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new Error(
      `Authentication / authorization failed (${res.statusCode}) querying solutions table. ` +
      'Either the token is expired (run `az login`) or the signed-in user lacks Read permission on the solutions table.'
    );
  }

  if (res.statusCode !== 200) {
    throw new Error(`Unexpected response (${res.statusCode}): ${res.body}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error(`Failed to parse Dataverse response as JSON: ${res.body}`);
  }

  const row = Array.isArray(data.value) && data.value.length > 0 ? data.value[0] : null;
  if (row) {
    return { installed: true, solutionName, version: row.version || null };
  }
  return { installed: false, solutionName };
}

module.exports = { checkSolutionInstalled, sanitizeEnvUrl, UNIQUE_NAME_RE };

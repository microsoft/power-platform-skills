#!/usr/bin/env node

// Shared helpers for talking to the Dataverse Web API from model-apps scripts.
// Uses Azure CLI (`az account get-access-token`) for auth — same MSAL cache that pac CLI uses.
// All operation scripts (provision-entities.js, provision-solution.js, etc.) import from this module.

const { execFileSync } = require('child_process');
// Shared with the App Spec + CLI so the provisioned-language probe and the validator cannot disagree
// about what counts as an LCID. app-spec.js does not require this module, so there is no cycle.
const { normalizeLanguageCode } = require('./app-spec.js');

/**
 * Gets an Azure CLI access token for the given Dataverse environment URL.
 * Returns null if `az` is missing, the user isn't logged in, or the resource is unreachable.
 * @param {string} envUrl - e.g. "https://contoso.crm.dynamics.com"
 * @returns {string|null}
 */
function getAuthToken(envUrl) {
  try {
    const out = execFileSync(
      'az',
      ['account', 'get-access-token', '--resource', envUrl, '--query', 'accessToken', '-o', 'tsv'],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Makes a raw HTTPS request and resolves with `{ statusCode, body, headers? }` or `{ error }`.
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method='GET']
 * @param {object} [options.headers={}]
 * @param {string} [options.body=null]
 * @param {boolean} [options.includeHeaders=false]
 * @param {number} [options.timeout=60000]
 * @returns {Promise<{statusCode: number, body: string, headers?: object} | {error: string}>}
 */
function makeRequest({ url, method = 'GET', headers = {}, body = null, includeHeaders = false, timeout = 60000 }) {
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method,
        headers,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const result = { statusCode: res.statusCode, body: data };
          if (includeHeaders) result.headers = res.headers;
          resolve(result);
        });
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Request timed out' });
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Makes a Dataverse Web API request with built-in auth, retry, and JSON handling.
 * Retries up to 2 times: refreshes token on 401, backs off on 429/500/502/503.
 * @param {string} envUrl - Dataverse environment URL (no trailing slash needed)
 * @param {string} method - GET, POST, PATCH, DELETE
 * @param {string} apiPath - Path after /api/data/v9.2/ (e.g. "EntityDefinitions")
 * @param {object|string|null} [body=null] - Request body (object → JSON.stringify)
 * @param {object} [opts={}]
 * @param {boolean} [opts.includeHeaders=false] - Include response headers in result
 * @param {object} [opts.extraHeaders={}] - Extra request headers (e.g. Prefer)
 * @param {number} [opts.timeout=60000]
 * @returns {Promise<{status: number, data: any, headers?: object}>}
 */
async function dataverseRequest(envUrl, method, apiPath, body = null, opts = {}) {
  const cleanUrl = envUrl.replace(/\/+$/, '');
  const url = `${cleanUrl}/api/data/v9.2/${apiPath}`;
  const bodyStr = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const { includeHeaders = false, extraHeaders = {}, timeout = 60000 } = opts;

  let token = getAuthToken(cleanUrl);
  if (!token) {
    throw new Error(`Failed to get Azure CLI token for ${cleanUrl}. Run 'az login' first.`);
  }

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      ...extraHeaders,
    };
    if (bodyStr) headers['Content-Type'] = 'application/json; charset=utf-8';

    const res = await makeRequest({ url, method, headers, body: bodyStr, includeHeaders, timeout });

    if (res.error) {
      if (attempt < maxRetries) continue;
      throw new Error(`Request failed: ${res.error}`);
    }

    if (res.statusCode === 401 && attempt < maxRetries) {
      token = getAuthToken(cleanUrl);
      if (!token) throw new Error("Token refresh failed. Run 'az login' again.");
      continue;
    }

    if ([429, 500, 502, 503].includes(res.statusCode) && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }

    let data = null;
    if (res.body) {
      try { data = JSON.parse(res.body); } catch { data = res.body; }
    }
    const out = { status: res.statusCode, data };
    if (includeHeaders) out.headers = res.headers;
    return out;
  }
  throw new Error('Unreachable retry loop');
}

/**
 * Throws if the response is not 2xx. Returns the response untouched on success.
 * Pulls Dataverse's structured error message out of `data.error.message` when present.
 */
function ensureOk(res, context) {
  if (res.status >= 200 && res.status < 300) return res;
  const msg = res?.data?.error?.message || (typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
  throw new Error(`${context} failed: HTTP ${res.status} — ${msg}`);
}

/**
 * Builds a Dataverse verbose Label object.
 * @param {string} text
 * @param {number} [lang=1033]
 */
function label(text, lang = 1033) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.Label',
    LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: lang }],
  };
}

/**
 * Standard RequiredLevel block.
 * @param {'None'|'ApplicationRequired'|'Recommended'|'SystemRequired'} level
 */
function requiredLevel(level = 'None') {
  return {
    Value: level,
    CanBeChanged: true,
    ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings',
  };
}

/**
 * Discovers the publisher prefix for the default solution in this env.
 * Falls back to "new" if the query fails.
 * @param {string} envUrl
 * @returns {Promise<string>}
 */
async function getDefaultPublisherPrefix(envUrl) {
  try {
    const res = await dataverseRequest(
      envUrl,
      'GET',
      "solutions?$select=uniquename&$filter=uniquename eq 'Default'&$expand=publisherid($select=customizationprefix)&$top=1"
    );
    const prefix = res?.data?.value?.[0]?.publisherid?.customizationprefix;
    return prefix || 'new';
  } catch {
    return 'new';
  }
}

/**
 * The set of LCIDs this organization actually has provisioned.
 *
 * `RetrieveProvisionedLanguages` is an unbound OData *function*, so it is not something the maker SDK
 * models — this is the sanctioned `dataverseRequest` hatch (see the "Dataverse Access From Scripts"
 * policy), the same class of read as `WhoAmI`.
 * See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrieveprovisionedlanguages
 *
 * Fail-soft by design: this is a *diagnostic* used to turn a silently-ignored language override into
 * a clear message, so every failure mode resolves to `null` ("unknown") rather than throwing. A build
 * must never break because the diagnostic could not run.
 *
 * @param {string} envUrl
 * @param {Function} [request=dataverseRequest] injectable transport, so the status gate below is
 *   testable without a network or a live org
 * @returns {Promise<number[]|null>} provisioned LCIDs, or null when they could not be determined
 */
async function readProvisionedLanguages(envUrl, request = dataverseRequest) {
  try {
    const res = await request(envUrl, 'GET', 'RetrieveProvisionedLanguages');
    // `dataverseRequest` has TWO failure surfaces and both must land on null:
    //   * an HTTP response, including 4xx/5xx, is RESOLVED as { status, data } — it does not throw.
    //     Without this status gate an error envelope would parse as "zero languages provisioned",
    //     indistinguishable from a real empty list, and would reject every otherwise-valid LCID.
    //   * token acquisition, transport, and retry exhaustion THROW — handled by the catch below,
    //     which is why that catch is load-bearing rather than defensive padding.
    if (!res || res.status < 200 || res.status >= 300) return null;
    // Live-verified shape:
    //   { "@odata.context": ".../$metadata#Microsoft.Dynamics.CRM.RetrieveProvisionedLanguagesResponse",
    //     "RetrieveProvisionedLanguages": [1033] }
    const list = res.data && res.data.RetrieveProvisionedLanguages;
    if (!Array.isArray(list)) return null;
    // Parse with the SAME normalizer the App Spec and the CLI flag use, rather than `Number()`.
    // `Number()` coerces far too much and every one of these previously produced a plausible LCID:
    //   [null] -> 0      [true] -> 1        [[1033]] -> 1033      ['1e3'] -> 1000      [''] -> 0
    // `normalizeLanguageCode` accepts only a real integer or a digits-only string (app-spec.js), so
    // the probe and the validator cannot disagree about what an LCID is.
    //
    // ALL-OR-NOTHING on purpose. `checkProvisioned` treats any non-empty list as COMPLETE and
    // authoritative (entity-provision.js), so silently dropping the elements we could not parse would
    // hand it a SHORTER list and make it reject languages the organization may well have. A payload
    // we do not fully understand is "unknown" — null — not "here is the subset I liked".
    const lcids = [];
    for (const raw of list) {
      const lcid = normalizeLanguageCode(raw);
      if (!lcid) return null;
      lcids.push(lcid);
    }
    // An org always has at least its base language, so an empty array is a payload we did not
    // understand too — "unknown", not "zero languages provisioned" (which would reject every LCID).
    return lcids.length ? lcids : null;
  } catch {
    return null;
  }
}

/**
 * The organization's base language (LCID), read at transport level.
 *
 * Needed *before* the maker SDK exists: `MakerSdkOptions.languageCode` is a construction-time
 * option, but the SDK's own `queryRecords` is the usual way to read `organization.languagecode` —
 * a chicken-and-egg the transport hatch resolves. Same class of read as `WhoAmI`.
 *
 * Fail-soft, for the same reason as {@link readProvisionedLanguages}: a caller that cannot learn the
 * base language must fall back and say so, not fail the build.
 *
 * @param {string} envUrl
 * @param {Function} [request=dataverseRequest] injectable transport for tests
 * @returns {Promise<number|null>} the base LCID, or null when it could not be determined
 */
async function readOrgLanguageCode(envUrl, request = dataverseRequest) {
  try {
    const res = await request(envUrl, 'GET', 'organizations?$select=languagecode&$top=1');
    // Status-gated for the same reason as readProvisionedLanguages: dataverseRequest resolves
    // { status, data } for every HTTP response, so an error envelope would otherwise read as
    // "no rows" and silently become the 1033 fallback.
    if (!res || res.status < 200 || res.status >= 300) return null;
    // Shape: { "@odata.context": "...", "value": [ { "organizationid": "...", "languagecode": 1033 } ] }
    // NOTE the plural entity SET name: the singular 'organization' 404s on the Web API.
    const row = res.data && Array.isArray(res.data.value) ? res.data.value[0] : null;
    const lcid = row && Number(row.languagecode);
    return Number.isInteger(lcid) && lcid > 0 && lcid <= 65535 ? lcid : null;
  } catch {
    return null;
  }
}

/**
 * Parses CLI args. Accepts both space-separated (`--flag value`) and
 * equals-separated (`--flag=value`) forms, plus bare boolean flags (`--bool`).
 *   <positional> [--flag value] [--flag=value] [--bool]
 * Returns { positional: [...], flags: { key: value } }. Repeated --flag overwrites.
 * For `--flag=value`, only the first `=` is treated as the separator so values
 * containing `=` (e.g. OData filters) are preserved.
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[body] = true;
      } else {
        flags[body] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/**
 * Read a flag that has both kebab-case and camelCase spellings, rejecting a conflicting pair.
 *
 * `flags[kebab] ?? flags[camel]` silently prefers one and discards the other, which is the wrong
 * answer when the two disagree — the user passed both and believes one is in effect, so guessing
 * either way produces a build they did not ask for with no indication why.
 *
 * Comparison is on the TRIMMED string. Surrounding whitespace in a shell argument is never
 * meaningful (`--language-code " 1031"` and `--languageCode 1031` are the same request), so
 * treating it as a conflict would reject a pair the user got right.
 *
 * Value-domain equivalence is deliberately NOT collapsed: `1031` and `01031` stay a conflict even
 * though both normalize to the same LCID downstream. This helper is domain-agnostic — it has no way
 * to know whether a caller's flag is a number, a name, or an id where `007` differs from `7` — and
 * the two outcomes are not symmetric. A false conflict is a loud error the user fixes in seconds; a
 * wrong guess is a silent, wrong build. So it errs toward the loud one.
 */
function readAliasedFlag(flags, kebab, camel) {
  const a = flags[kebab];
  const b = flags[camel];
  const same = (x, y) => String(x).trim() === String(y).trim();
  if (a !== undefined && b !== undefined && !same(a, b)) {
    throw new Error(`--${kebab} '${a}' and --${camel} '${b}' disagree — pass only one`);
  }
  return a !== undefined ? a : b;
}

/** Reads a JSON value either inline or from a file via @path syntax. */
function readJsonArg(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  if (raw.startsWith('@')) {
    const fs = require('fs');
    return JSON.parse(fs.readFileSync(raw.slice(1), 'utf8'));
  }
  return JSON.parse(raw);
}

/**
 * Writes a result to stdout and exits.
 *   ok=true → JSON payload to stdout, exit 0
 *   ok=false + Error → message to stderr, exit 1
 *   ok=false + object → JSON payload to stdout (caller can parse partial-failure
 *                       details like `errors: [...]`), short note to stderr, exit 1
 *   ok=false + string → string to stderr, exit 1
 */
function emitResult(ok, payload) {
  if (ok) {
    process.stdout.write(JSON.stringify(payload) + '\n');
    process.exit(0);
  }
  if (payload instanceof Error) {
    process.stderr.write(payload.message + '\n');
  } else if (payload !== null && typeof payload === 'object') {
    // Partial failure (e.g., bulk insert with some errors). Emit the structured
    // payload to stdout so callers can parse `errors`, and exit 1 so shells
    // still treat it as a failure.
    process.stdout.write(JSON.stringify(payload) + '\n');
    const n = Array.isArray(payload.errors) ? payload.errors.length : 'unknown';
    process.stderr.write(`Operation completed with ${n} error(s); see stdout JSON\n`);
  } else {
    process.stderr.write(String(payload) + '\n');
  }
  process.exit(1);
}

module.exports = {
  getAuthToken,
  makeRequest,
  dataverseRequest,
  ensureOk,
  label,
  requiredLevel,
  getDefaultPublisherPrefix,
  readProvisionedLanguages,
  readOrgLanguageCode,
  parseArgs,
  readAliasedFlag,
  readJsonArg,
  emitResult,
};

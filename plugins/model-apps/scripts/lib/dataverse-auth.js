#!/usr/bin/env node

// Shared helpers for talking to the Dataverse Web API from model-apps scripts.
// Uses Azure CLI (`az account get-access-token`) for auth — same MSAL cache that pac CLI uses.
// All operation scripts (create-table.js, add-column.js, etc.) import from this module.

const { execFileSync } = require('child_process');

/**
 * Gets an Azure CLI access token for the given Dataverse environment URL.
 * Returns null if `az` is missing, the user isn't logged in, or the resource is unreachable.
 * @param {string} envUrl - e.g. "https://aurorabapenv4ab3f.crmtest.dynamics.com"
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
  parseArgs,
  readJsonArg,
  emitResult,
};

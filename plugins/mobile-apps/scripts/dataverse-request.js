#!/usr/bin/env node

// General-purpose Dataverse OData API request script with built-in auth and retry.
// Usage: node dataverse-request.js <envUrl> <method> <apiPath> [--body <json>]
//
// Arguments:
//   envUrl   - Dataverse environment URL (e.g., https://org123.crm.dynamics.com)
//   method   - HTTP method: GET, POST, PUT, PATCH, DELETE, BATCH-RECORDS, or BATCH-METADATA
//   apiPath  - API path after /api/data/v9.2/ (e.g., "EntityDefinitions?$filter=...")
//              For BATCH-RECORDS mode, this is treated as a label (e.g. "Tier 0") for logging only.
//
// Options:
//   --body <json>      Request body as JSON string
//   --include-headers  Include response headers in output (for OData-EntityId etc.)
//   --solution <name>  Sets MSCRM.SolutionUniqueName header (target metadata at a solution)
//   --tenant-id <id>   Uses the resolved environment tenant without shell-global state
//
// BATCH-RECORDS mode (record-level inserts only — NEVER use for metadata writes):
//   node dataverse-request.js <envUrl> BATCH-RECORDS <label> --operations '<json>' [--concurrency 5] [--solution <name>] [--tenant-id <id>]
//
//   --operations '<json>'   Required. JSON array of operations:
//                           [{ "index": 0, "entitySet": "cr3e9_jobsites", "body": { ... } }, ...]
//   --concurrency <N>       Optional. Max parallel inflight requests. Default 5; auto-downgrades to 3 on first 429.
//
//   Output: { "status": 200, "data": [ { "index": N, "status": ..., "recordId": "<guid>", "error": "..." }, ... ] }
//   Per-operation results preserve input index. Failures DO NOT abort the batch — caller decides what to do.
//
//   USE FOR: record inserts via /add-sample-data (no Dataverse metadata lock)
//   DO NOT USE FOR: EntityDefinitions / Attributes / RelationshipDefinitions POSTs — those serialize via the
//   metadata lock server-side; parallel calls return 429 / MetadataLockHeldException.
//
// BATCH-METADATA mode (strictly sequential metadata operations in one process):
//   node dataverse-request.js <envUrl> BATCH-METADATA <label> --operations '<json>' --tenant-id <id>
//     [--journal <path> --manifest-hash <sha256> --reconciliation-hash <sha256>
//      --manifest-file <validated-manifest.json>
//      --manifest-operations '<complete-json-array>']
//     [--continue-on-error]
//
//   Operations:
//   [{ "index": 0, "method": "POST", "apiPath": "EntityDefinitions", "body": { ... } }, ...]
//
//   This is NOT an OData $batch and never runs writes concurrently. It reuses one
//   token and Node process while preserving operation order and metadata-lock safety.
//
// Output (JSON to stdout):
//   Success: { "status": 200, "data": { ... } }
//   With headers: { "status": 200, "data": { ... }, "headers": { ... } }
//   Error: { "status": 401, "error": "..." }
//
// Exit codes:
//   0 - Request completed (check status field for HTTP result)
//   1 - Fatal error (no token, invalid args, network failure after retries)

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const READ_REQUEST_TIMEOUT_MS = 30000;
const MUTATION_REQUEST_TIMEOUT_MS = 120000;

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

function retryAfterDelayMs(retryAfter, fallbackMs, nowMs = Date.now()) {
  const safeFallback = Number.isFinite(fallbackMs) && fallbackMs >= 0
    ? fallbackMs
    : 30000;
  if (retryAfter == null || String(retryAfter).trim() === '') return safeFallback;
  const normalized = String(retryAfter).trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const delaySeconds = Number(normalized);
    return Number.isFinite(delaySeconds) && delaySeconds >= 0
      ? Math.ceil(delaySeconds * 1000)
      : safeFallback;
  }
  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - nowMs)
    : safeFallback;
}

function isMutationMethod(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

function isMetadataApiPath(apiPath) {
  return /^(EntityDefinitions|RelationshipDefinitions|GlobalOptionSetDefinitions|PublishXml)(?:\b|\(|\/|\?)/i
    .test(String(apiPath || ''));
}

function metadataRequestIdentity(apiPath) {
  const value = String(apiPath || '');
  const tableMatch = value.match(/EntityDefinitions\(LogicalName='([^']+)'\)/i);
  const typedMatch = value.match(/Attributes\/Microsoft\.Dynamics\.CRM\.([A-Za-z]+AttributeMetadata)/i);
  let category = 'other';
  if (/^EntityDefinitions\(LogicalName='[^']+'\)\?/i.test(value)
    && /\$expand=Attributes\(/i.test(value)) category = 'combined-base-metadata';
  else if (/^EntityDefinitions\?/i.test(value)) category = 'table-inventory';
  else if (/\/ManyToOneRelationships\?/i.test(value)) category = 'many-to-one';
  else if (/\/OneToManyRelationships\?/i.test(value)) category = 'one-to-many';
  else if (/\/ManyToManyRelationships\?/i.test(value)) category = 'many-to-many';
  else if (/\/Keys\?/i.test(value)) category = 'alternate-keys';
  else if (/LookupAttributeMetadata/i.test(value)) category = 'lookup-metadata';
  else if (typedMatch) category = 'typed-attribute-metadata';
  else if (/\/Attributes\?/i.test(value)) category = 'attributes';
  else if (/\/Attributes\(/i.test(value)) category = 'computed-attribute-metadata';
  return {
    category,
    table: tableMatch?.[1] || null,
    metadataType: typedMatch?.[1] || null,
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    process.stderr.write(
      'Usage: node dataverse-request.js <envUrl> <method> <apiPath> [--body <json>] [--include-headers] [--solution <uniqueName>] [--tenant-id <id>]\n' +
      '       node dataverse-request.js <envUrl> BATCH-RECORDS <label> --operations <json> [--concurrency 5] [--solution <name>] [--tenant-id <id>]\n' +
      '       node dataverse-request.js <envUrl> BATCH-METADATA <label> --operations <json> [--solution <name>] [--tenant-id <id>] [--journal <path> --manifest-file <validated-manifest.json> --manifest-hash <sha256> --reconciliation-hash <sha256> --manifest-operations <complete-json-array>] [--continue-on-error]\n'
    );
    process.exit(1);
  }

  const envUrl = args[0].replace(/\/+$/, '');
  const method = args[1].toUpperCase();
  const apiPath = args[2];
  let body = null;
  let includeHeaders = false;
  let solution = null;
  let operations = null;
  let concurrency = 5;
  let tenantId = null;
  let continueOnError = false;
  let journal = null;
  let manifestHash = null;
  let reconciliationHash = null;
  let manifestOperations = null;
  let manifestFile = null;

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--body' && args[i + 1]) {
      body = args[++i];
    } else if (args[i] === '--include-headers') {
      includeHeaders = true;
    } else if (args[i] === '--solution' && args[i + 1]) {
      solution = args[++i];
    } else if (args[i] === '--operations' && args[i + 1]) {
      operations = args[++i];
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 20) concurrency = n;
    } else if (args[i] === '--tenant-id' && args[i + 1]) {
      tenantId = args[++i];
    } else if (args[i] === '--continue-on-error') {
      continueOnError = true;
    } else if (args[i] === '--journal' && args[i + 1]) {
      journal = args[++i];
    } else if (args[i] === '--manifest-hash' && args[i + 1]) {
      manifestHash = args[++i];
    } else if (args[i] === '--reconciliation-hash' && args[i + 1]) {
      reconciliationHash = args[++i];
    } else if (args[i] === '--manifest-operations' && args[i + 1]) {
      manifestOperations = args[++i];
    } else if (args[i] === '--manifest-file' && args[i + 1]) {
      manifestFile = args[++i];
    }
  }

  return {
    envUrl,
    method,
    apiPath,
    body,
    includeHeaders,
    solution,
    operations,
    concurrency,
    tenantId,
    continueOnError,
    journal,
    manifestHash,
    reconciliationHash,
    manifestOperations,
    manifestFile,
  };
}

async function doRequest(envUrl, method, apiPath, body, token, includeHeaders, solution) {
  const url = `${envUrl}/api/data/v9.2/${apiPath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  if (solution) {
    headers['MSCRM.SolutionUniqueName'] = solution;
  }

  const res = await makeRequest({
    url,
    method,
    headers,
    body,
    includeHeaders,
    timeout: isMutationMethod(method)
      ? MUTATION_REQUEST_TIMEOUT_MS
      : READ_REQUEST_TIMEOUT_MS,
  });

  return res;
}

function createDataverseRequestExecutor({
  environmentUrl,
  tenantId,
  solution = null,
  getToken = getAuthToken,
  sendRequest = doRequest,
  onTelemetry = null,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  nowMs = () => Date.now(),
}) {
  const envUrl = String(environmentUrl || '').replace(/\/+$/, '');
  if (!envUrl) throw new Error('environmentUrl is required');

  let token = null;
  let tokenPromise = null;
  let refreshPromise = null;
  const rateLimitListeners = new Set();
  const authStats = { tokenAcquisitionCount: 0, tokenRefreshCount: 0 };
  async function ensureToken() {
    if (token) return { token, acquired: false };
    let acquired = false;
    if (!tokenPromise) {
      authStats.tokenAcquisitionCount += 1;
      acquired = true;
      tokenPromise = Promise.resolve(getToken(envUrl, tenantId));
    }
    const pendingToken = tokenPromise;
    try {
      token = await pendingToken;
    } finally {
      if (tokenPromise === pendingToken) tokenPromise = null;
    }
    if (!token) {
      throw new Error('Failed to get Azure CLI token. Run `az login` first.');
    }
    return { token, acquired };
  }

  async function refreshToken(staleToken) {
    if (token && staleToken && token !== staleToken) {
      return { token, refreshedByCaller: false };
    }
    let refreshedByCaller = false;
    if (!refreshPromise) {
      authStats.tokenRefreshCount += 1;
      refreshedByCaller = true;
      refreshPromise = Promise.resolve(getToken(envUrl, tenantId))
        .then((refreshed) => {
          if (refreshed) token = refreshed;
          return refreshed;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    const refreshed = await refreshPromise;
    return { token: refreshed, refreshedByCaller };
  }

  const execute = async (method, apiPath, body = null, includeHeaders = false) => {
    const startedAt = nowMs();
    const ensured = await ensureToken();
    let requestRefreshCount = 0;
    let bodyString = null;
    if (body !== null && body !== undefined) {
      bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const executed = await runOneMetadataOperation(
      envUrl,
      String(method || '').toUpperCase(),
      apiPath,
      bodyString,
      ensured.token,
      includeHeaders,
      solution,
      tenantId,
      async (_environmentUrl, _tenantId, staleToken) => {
        const refreshed = await refreshToken(staleToken);
        if (refreshed.refreshedByCaller) requestRefreshCount += 1;
        return refreshed.token;
      },
      sendRequest,
      {
        nowMs,
        sleep,
        onRateLimited: (event) => {
          for (const listener of rateLimitListeners) {
            try {
              listener(event);
            } catch {
              // Backpressure observers must not change request behavior.
            }
          }
        },
      },
    );
    if (typeof onTelemetry === 'function') {
      const identity = metadataRequestIdentity(apiPath);
      try {
        onTelemetry({
          method: String(method || '').toUpperCase(),
          ...identity,
          status: executed.status,
          durationMs: Math.max(0, nowMs() - startedAt),
          responseBytes: executed.responseBytes || 0,
          attempts: executed.attempts || 1,
          retryCount: executed.retryCount || 0,
          rateLimited: Boolean(executed.rateLimited),
          tokenAcquisitionCount: ensured.acquired ? 1 : 0,
          tokenRefreshCount: requestRefreshCount,
        });
      } catch {
        // Telemetry must never change request behavior.
      }
    }
    return {
      status: executed.status,
      data: executed.data,
      headers: executed.headers,
      error: executed.error,
      rateLimited: executed.rateLimited,
    };
  };
  execute.getAuthStats = () => ({ ...authStats });
  execute.onRateLimited = (listener) => {
    if (typeof listener !== 'function') throw new Error('rate-limit listener must be a function');
    rateLimitListeners.add(listener);
    return () => rateLimitListeners.delete(listener);
  };
  return execute;
}

async function main() {
  const {
    envUrl,
    method,
    apiPath,
    body,
    includeHeaders,
    solution,
    operations,
    concurrency,
    tenantId,
    continueOnError,
    journal,
    manifestHash,
    reconciliationHash,
    manifestOperations,
    manifestFile,
  } = parseArgs();

  let token = await getAuthToken(envUrl, tenantId);
  if (!token) {
    process.stderr.write('Failed to get Azure CLI token. Run `az login` first.\n');
    process.exit(1);
  }

  // BATCH-RECORDS mode: parallel record inserts with concurrency cap. Single Node process,
  // ordered results, adaptive concurrency on 429. Used by /add-sample-data Step 5.
  if (method === 'BATCH-RECORDS') {
    if (!operations) {
      process.stderr.write('BATCH-RECORDS requires --operations <json-array>\n');
      process.exit(1);
    }
    let ops;
    try {
      ops = JSON.parse(operations);
    } catch (e) {
      process.stderr.write(`--operations is not valid JSON: ${e.message}\n`);
      process.exit(1);
    }
    if (!Array.isArray(ops)) {
      process.stderr.write('--operations must be a JSON array\n');
      process.exit(1);
    }

    const results = await runBatch(envUrl, ops, token, solution, concurrency, tenantId);
    console.log(JSON.stringify({ status: 200, data: results }));
    return;
  }

  if (method === 'BATCH-METADATA') {
    if (!operations) {
      process.stderr.write('BATCH-METADATA requires --operations <json-array>\n');
      process.exit(1);
    }
    let ops;
    try {
      ops = JSON.parse(operations);
    } catch (e) {
      process.stderr.write(`--operations is not valid JSON: ${e.message}\n`);
      process.exit(1);
    }
    if (!Array.isArray(ops)) {
      process.stderr.write('--operations must be a JSON array\n');
      process.exit(1);
    }
    let allManifestOperations = ops;
    let manifest = null;
    if (manifestOperations) {
      try {
        allManifestOperations = JSON.parse(manifestOperations);
      } catch (error) {
        process.stderr.write(`--manifest-operations is not valid JSON: ${error.message}\n`);
        process.exit(1);
      }
    }
    if (!Array.isArray(allManifestOperations)) {
      process.stderr.write('--manifest-operations must be a JSON array\n');
      process.exit(1);
    }
    if (manifestFile) {
      try {
        manifest = JSON.parse(fs.readFileSync(path.resolve(manifestFile), 'utf8'));
      } catch (error) {
        process.stderr.write(`--manifest-file could not be read: ${error.message}\n`);
        process.exit(1);
      }
    }

    const result = await runMetadataBatch(
      envUrl,
      ops,
      token,
      solution,
      tenantId,
      continueOnError,
      {
        journalPath: journal,
        manifestHash,
        reconciliationHash,
        allOperations: allManifestOperations,
        manifest,
      },
    );
    console.log(JSON.stringify({ status: result.failed ? 207 : 200, data: result.results }));
    return;
  }

  const maxRetries = 4;
  let wasRateLimited = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await doRequest(envUrl, method, apiPath, body, token, true, solution);

    if (res.error) {
      if (isMutationMethod(method) && isMetadataApiPath(apiPath)) {
        console.log(JSON.stringify({
          status: 0,
          error: res.error,
          uncertain_metadata_mutation: true,
        }));
        return;
      }
      if (attempt < maxRetries) continue;
      process.stderr.write(`Request failed: ${res.error}\n`);
      process.exit(1);
    }

    // Retry on 401 with token refresh
    if (res.statusCode === 401 && attempt < maxRetries) {
      token = await getAuthToken(envUrl, tenantId);
      if (!token) {
        process.stderr.write('Token refresh failed. Run `az login` again.\n');
        process.exit(1);
      }
      continue;
    }

    // Retry on 429 — honour Retry-After header if present, else 30s backoff
    if (res.statusCode === 429 && attempt < maxRetries) {
      const delayMs = retryAfterDelayMs(res.headers?.['retry-after'], 30000);
      process.stderr.write(`429 rate-limited — waiting ${delayMs / 1000}s before retry ${attempt + 1}/${maxRetries}\n`);
      wasRateLimited = true;
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    // Retry on transient server errors
    if ([500, 502, 503].includes(res.statusCode) && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    // Parse response body
    let data = null;
    if (res.body) {
      try {
        data = JSON.parse(res.body);
      } catch {
        data = res.body;
      }
    }

    const output = { status: res.statusCode, data };
    if (includeHeaders && res.headers) {
      output.headers = res.headers;
    }
    if (wasRateLimited) {
      output.rate_limited_during_request = true;
    }
    console.log(JSON.stringify(output));
    return;
  }
}

// Match common Dataverse "already exists" / duplicate signals across both
// EntityDefinitions and data-row create paths.
function looksLikeDuplicate(data) {
  if (!data) return false;
  const err = data.error || data;
  const msg = (err.message || err.Message || '').toLowerCase();
  const code = (err.code || err.errorcode || '').toString().toLowerCase();

  const messageMatches = [
    'already exists',
    'duplicate',
    'not unique',
    'same name exists',
    'object with same name exists in solution',
    'cannot insert duplicate key',
    'an item with the same key has already been added',
    'duplicaterecord',
  ].some((needle) => msg.includes(needle));

  const codeMatches = [
    '0x80040237', // DuplicateRecord
    '0x80060888', // SchemaName already in use
    '0x80044363', // schema name is not unique
    '0x80060890', // object with same name exists in solution
    '0x8004f00d', // duplicate attribute
  ].some((needle) => code.includes(needle));

  return messageMatches || codeMatches;
}

// BATCH-RECORDS: parallel record-create with concurrency cap. Adaptive — drops cap on first 429.
// Returns ordered array of { index, status, recordId?, error? } matching input ops by `index`.
//
// USE FOR: record inserts (no metadata lock). DO NOT USE FOR: metadata writes — they serialize via
// the Dataverse metadata lock server-side and parallel calls return 429 / MetadataLockHeldException.
async function runBatch(envUrl, ops, token, solution, initialCap, tenantId) {
  // Normalize input: every op gets a deterministic slot. Honour caller-supplied `index` if present
  // (so caller can correlate results to its own row identity), otherwise use position-in-array.
  const normalized = ops.map((op, i) => ({
    ...op,
    index: typeof op.index === 'number' ? op.index : i,
    _slot: i,
  }));
  const results = new Array(normalized.length);
  let inflight = 0;
  let nextIndex = 0;
  let cap = initialCap;
  let firstThrottleSeen = false;

  return new Promise((resolve) => {
    const tryDispatch = () => {
      while (inflight < cap && nextIndex < normalized.length) {
        const op = normalized[nextIndex++];
        inflight++;
        runOneOperation(envUrl, op, token, solution, tenantId)
          .then((result) => {
            results[op._slot] = { ...result, index: op.index };
            // Adaptive cap: drop to 3 on first 429 we see, to ease pressure
            if (!firstThrottleSeen && result.status === 429) {
              firstThrottleSeen = true;
              cap = Math.min(cap, 3);
            }
          })
          .catch((err) => {
            results[op._slot] = { index: op.index, status: 0, error: String(err) };
          })
          .finally(() => {
            inflight--;
            if (inflight === 0 && nextIndex >= normalized.length) {
              resolve(results);
            } else {
              tryDispatch();
            }
          });
      }
    };
    if (normalized.length === 0) {
      resolve(results);
      return;
    }
    tryDispatch();
  });
}

// Runs a single record-create POST with full retry semantics (matches the single-op main() loop).
// Returns { index, status, recordId?, error? }.
async function runOneOperation(envUrl, op, initialToken, solution, tenantId) {
  const { index, entitySet, body } = op;
  if (!entitySet || !body) {
    return { index, status: 0, error: 'Operation missing entitySet or body' };
  }

  let token = initialToken;
  const maxRetries = 4;
  let bodyStr;
  try {
    bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  } catch (e) {
    return { index, status: 0, error: `Body serialize failed: ${e.message}` };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await doRequest(envUrl, 'POST', entitySet, bodyStr, token, true, solution);

    if (res.error) {
      if (attempt < maxRetries) continue;
      return { index, status: 0, error: res.error };
    }

    if (res.statusCode === 401 && attempt < maxRetries) {
      const refreshed = await getAuthToken(envUrl, tenantId);
      if (refreshed) {
        token = refreshed;
        continue;
      }
      return { index, status: 401, error: 'Token refresh failed' };
    }

    if (res.statusCode === 429 && attempt < maxRetries) {
      const delayMs = retryAfterDelayMs(res.headers?.['retry-after'], 5000);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    if ([500, 502, 503].includes(res.statusCode) && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    let data = null;
    if (res.body) {
      try {
        data = JSON.parse(res.body);
      } catch {
        data = res.body;
      }
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      // Parse OData-EntityId header for the new record's GUID
      const entityIdHeader = res.headers?.['odata-entityid'] || res.headers?.['OData-EntityId'];
      const recordId = entityIdHeader ? extractGuid(entityIdHeader) : null;
      return { index, status: res.statusCode, recordId };
    }

    // Non-success terminal status — return the error for caller to handle
    const errMsg =
      (data && (data.error?.message || data.Message || data.error?.Message)) ||
      `HTTP ${res.statusCode}`;
    return { index, status: res.statusCode, error: errMsg };
  }

  return { index, status: 0, error: 'Exhausted retries' };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
  ).join(',')}}`;
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce((result, key) => {
      result[key] = stableClone(value[key]);
      return result;
    }, {});
}

function manifestStableJson(value) {
  return `${JSON.stringify(stableClone(value), null, 2)}\n`;
}

function operationFingerprint(operation, defaultSolution = null) {
  return crypto.createHash('sha256').update(stableJson({
    id: operation.id || null,
    method: String(operation.method || '').toUpperCase(),
    apiPath: operation.apiPath,
    body: operation.body ?? null,
    solution: operation.solution || defaultSolution || null,
  })).digest('hex');
}

function validateJournalOperations(operations, defaultSolution = null) {
  if (!Array.isArray(operations)) {
    throw new Error('complete manifest operations must be an array');
  }
  const fingerprints = new Set();
  for (const [position, operation] of operations.entries()) {
    if (!Number.isInteger(operation?.index) || operation.index !== position) {
      throw new Error(
        'complete manifest operation indexes must be unique and ordered from zero',
      );
    }
    const fingerprint = operationFingerprint(operation, defaultSolution);
    if (fingerprints.has(fingerprint)) {
      throw new Error(
        `complete manifest contains duplicate stable operation identity at index ${position}`,
      );
    }
    fingerprints.add(fingerprint);
  }
  return fingerprints;
}

function validateManifestExecutionBinding({
  manifest,
  manifestHash,
  selectedOperations,
  completeOperations,
  defaultSolution,
  environmentUrl,
  reconciliationHash,
  journal,
  checkPredecessors = true,
}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('--manifest-file is required for journaled manifest execution');
  }
  const withoutIntegrity = { ...manifest };
  delete withoutIntegrity.integritySha256;
  const computedHash = crypto.createHash('sha256')
    .update(manifestStableJson(withoutIntegrity))
    .digest('hex');
  if (manifest.integritySha256 !== computedHash || manifestHash !== computedHash) {
    throw new Error('manifest execution binding hash does not match manifest content');
  }
  if (String(manifest.binding?.reconciliationSha256 || '') !== reconciliationHash
    || String(manifest.binding?.solutionUniqueName || '') !== String(defaultSolution || '')
    || String(manifest.binding?.environmentUrl || '').replace(/\/+$/, '').toLowerCase()
      !== String(environmentUrl || '').replace(/\/+$/, '').toLowerCase()) {
    throw new Error('manifest execution context binding does not match request context');
  }
  if (manifest.executable !== true
    || manifest.execution?.executor !== 'BATCH-METADATA'
    || manifest.execution?.parallelWrites !== false
    || manifest.execution?.odataBatch !== false) {
    throw new Error('manifest is not executable by sequential BATCH-METADATA');
  }
  const expectedPhases = [
    'tableCreates',
    'extensions',
    'relationships',
    'alternateKeys',
    'publish',
  ];
  const phases = manifest.execution?.phases;
  if (!Array.isArray(phases)
    || phases.map((phase) => phase.name).join(',') !== expectedPhases.join(',')) {
    throw new Error('manifest execution phases are missing or out of order');
  }
  const flattened = phases.flatMap((phase) => (
    (phase.operations || []).map((operation) => {
      if (operation.phase !== phase.name) {
        throw new Error(`manifest operation ${operation.id} has an invalid phase binding`);
      }
      return operation;
    })
  ));
  validateJournalOperations(flattened, defaultSolution);
  if (stableJson(completeOperations) !== stableJson(flattened)) {
    throw new Error('--manifest-operations does not exactly match the bound manifest');
  }

  let selectedPhaseIndex = -1;
  for (const [phaseIndex, phase] of phases.entries()) {
    if (stableJson(selectedOperations) === stableJson(phase.operations || [])) {
      selectedPhaseIndex = phaseIndex;
      break;
    }
  }
  if (selectedOperations.length === 0 && flattened.length === 0) {
    selectedPhaseIndex = 0;
  }
  if (selectedPhaseIndex < 0) {
    throw new Error('selected operations are not an exact manifest phase');
  }
  if (checkPredecessors) {
    const predecessors = phases
      .slice(0, selectedPhaseIndex)
      .flatMap((phase) => phase.operations || []);
    for (const predecessor of predecessors) {
      const fingerprint = operationFingerprint(predecessor, defaultSolution);
      if (!journal?.completed?.[fingerprint]) {
        throw new Error(
          `manifest predecessor ${predecessor.id} is not journal-complete`,
        );
      }
    }
  }
  return { flattened, selectedPhaseIndex };
}

function atomicWriteJournal(journalPath, journal) {
  const resolved = path.resolve(journalPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${stableJson(journal)}\n`, 'utf8');
    fs.renameSync(temporary, resolved);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function prepareMetadataJournal({
  journalPath,
  environmentUrl,
  solution,
  manifestHash,
  reconciliationHash,
  operations,
}) {
  if (!journalPath) return { journal: null, recoveryResults: [] };
  if (!/^[a-f0-9]{64}$/i.test(String(manifestHash || ''))) {
    throw new Error('--manifest-hash must be a SHA-256 hex value when --journal is used');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(reconciliationHash || ''))) {
    throw new Error(
      '--reconciliation-hash must be a SHA-256 hex value when --journal is used',
    );
  }
  const fingerprints = validateJournalOperations(operations, solution);
  const resolved = path.resolve(journalPath);
  const journal = fs.existsSync(resolved)
    ? JSON.parse(fs.readFileSync(resolved, 'utf8'))
    : {
      schemaVersion: 1,
      binding: {
        environmentUrl: String(environmentUrl).replace(/\/+$/, ''),
        solution: solution || null,
      },
      completed: {},
      recoveries: [],
      inFlight: null,
    };
  if (journal.schemaVersion !== 1
    || String(journal.binding?.environmentUrl || '').replace(/\/+$/, '').toLowerCase()
      !== String(environmentUrl).replace(/\/+$/, '').toLowerCase()
    || (journal.binding?.solution || null) !== (solution || null)
    || !journal.completed
    || typeof journal.completed !== 'object'
    || !Array.isArray(journal.recoveries)) {
    throw new Error('metadata journal is malformed or bound to different execution context');
  }

  const recoveryResults = [];
  if (journal.inFlight) {
    if (journal.inFlight.reconciliationHash === reconciliationHash
      || journal.inFlight.manifestHash === manifestHash) {
      throw new Error(
        'UNCERTAIN_METADATA_OPERATION: fresh bounded reconciliation and regenerated '
        + 'manifest are required before resume',
      );
    }
    const stillRequired = fingerprints.has(journal.inFlight.fingerprint);
    if (journal.inFlight.failure?.collision === true && stillRequired) {
      throw new Error(
        'COLLISION_REQUIRES_REGENERATED_OPERATIONS: revise the structured schema, '
        + 'regenerate aliases/services/all downstream phases, and do not resume the old array',
      );
    }
    const supersededCollision = journal.inFlight.failure?.collision === true
      && !stillRequired;
    const recovery = {
      operationId: journal.inFlight.operationId,
      fingerprint: journal.inFlight.fingerprint,
      priorManifestHash: journal.inFlight.manifestHash,
      priorReconciliationHash: journal.inFlight.reconciliationHash,
      manifestHash,
      reconciliationHash,
      outcome: stillRequired
        ? 'fresh-reconciliation-confirmed-still-required'
        : supersededCollision
          ? 'fresh-reconciliation-confirmed-superseded-collision'
        : 'fresh-reconciliation-confirmed-already-applied-or-superseded',
      reconciledAt: new Date().toISOString(),
    };
    journal.recoveries.push(recovery);
    if (!stillRequired && !supersededCollision) {
      journal.completed[journal.inFlight.fingerprint] = {
        operationId: journal.inFlight.operationId,
        outcome: recovery.outcome,
        completedAt: recovery.reconciledAt,
        manifestHash,
        reconciliationHash,
      };
    }
    if (!stillRequired) {
      recoveryResults.push({
        index: journal.inFlight.index,
        status: 200,
        operationId: journal.inFlight.operationId,
        journalStatus: recovery.outcome,
      });
    }
    journal.inFlight = null;
    atomicWriteJournal(resolved, journal);
  }
  return { journal, recoveryResults };
}

async function runMetadataBatch(
  envUrl,
  ops,
  initialToken,
  defaultSolution,
  tenantId,
  continueOnError,
  journalOptions = {},
) {
  let preparedJournal;
  try {
    if (journalOptions.journalPath) {
      validateManifestExecutionBinding({
        manifest: journalOptions.manifest,
        manifestHash: journalOptions.manifestHash,
        selectedOperations: ops,
        completeOperations: journalOptions.allOperations || ops,
        defaultSolution,
        environmentUrl: envUrl,
        reconciliationHash: journalOptions.reconciliationHash,
        journal: null,
        checkPredecessors: false,
      });
    }
    preparedJournal = prepareMetadataJournal({
      journalPath: journalOptions.journalPath,
      environmentUrl: envUrl,
      solution: defaultSolution,
      manifestHash: journalOptions.manifestHash,
      reconciliationHash: journalOptions.reconciliationHash,
      operations: journalOptions.allOperations || ops,
    });
    if (journalOptions.journalPath) {
      validateManifestExecutionBinding({
        manifest: journalOptions.manifest,
        manifestHash: journalOptions.manifestHash,
        selectedOperations: ops,
        completeOperations: journalOptions.allOperations || ops,
        defaultSolution,
        environmentUrl: envUrl,
        reconciliationHash: journalOptions.reconciliationHash,
        journal: preparedJournal.journal,
      });
    }
  } catch (error) {
    return {
      results: [{ index: -1, status: 0, error: error.message }],
      failed: true,
      token: initialToken,
    };
  }
  const journal = preparedJournal.journal;
  const results = [...preparedJournal.recoveryResults];
  let token = initialToken;
  let failed = false;

  for (let slot = 0; slot < ops.length; slot++) {
    const op = ops[slot] || {};
    const index = typeof op.index === 'number' ? op.index : slot;
    const method = String(op.method || '').toUpperCase();
    const apiPath = op.apiPath;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !apiPath) {
      results.push({ index, status: 0, error: 'Operation requires a valid method and apiPath' });
      failed = true;
      if (!continueOnError) break;
      continue;
    }
    const fingerprint = operationFingerprint(op, defaultSolution);
    if (journal?.completed[fingerprint]) {
      results.push({
        index,
        status: 200,
        operationId: op.id || null,
        journalStatus: 'already-completed',
      });
      continue;
    }

    let body = null;
    if (op.body !== undefined && op.body !== null) {
      try {
        body = typeof op.body === 'string' ? op.body : JSON.stringify(op.body);
      } catch (error) {
        results.push({ index, status: 0, error: `Body serialize failed: ${error.message}` });
        failed = true;
        if (!continueOnError) break;
        continue;
      }
    }

    if (journal) {
      journal.inFlight = {
        index,
        operationId: op.id || null,
        fingerprint,
        manifestHash: journalOptions.manifestHash,
        reconciliationHash: journalOptions.reconciliationHash,
        startedAt: new Date().toISOString(),
      };
      atomicWriteJournal(journalOptions.journalPath, journal);
    }
    const started = Date.now();
    const executed = await runOneMetadataOperation(
      envUrl,
      method,
      apiPath,
      body,
      token,
      Boolean(op.includeHeaders),
      op.solution || defaultSolution,
      tenantId,
    );
    token = executed.token;
    const result = {
      index,
      status: executed.status,
      data: executed.data,
      durationMs: Date.now() - started,
    };
    if (executed.headers) result.headers = executed.headers;
    if (executed.error) result.error = executed.error;
    if (executed.rateLimited) result.rateLimited = true;
    if (executed.uncertain) result.uncertain = true;
    results.push(result);

    if (executed.status >= 200 && executed.status < 300) {
      if (journal) {
        journal.completed[fingerprint] = {
          operationId: op.id || null,
          status: executed.status,
          completedAt: new Date().toISOString(),
          manifestHash: journalOptions.manifestHash,
          reconciliationHash: journalOptions.reconciliationHash,
        };
        journal.inFlight = null;
        atomicWriteJournal(journalOptions.journalPath, journal);
      }
    } else {
      failed = true;
      if (journal) {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          journal.inFlight = null;
        } else {
          journal.inFlight.failure = {
            status: executed.status,
            error: executed.error || null,
            uncertain: Boolean(executed.uncertain),
            collision: looksLikeDuplicate(executed.data)
              || looksLikeDuplicate({ error: { message: executed.error || '' } }),
            recordedAt: new Date().toISOString(),
          };
        }
        atomicWriteJournal(journalOptions.journalPath, journal);
      }
      if (!continueOnError || journal) break;
    }
  }

  return { results, failed, token };
}

async function runOneMetadataOperation(
  envUrl,
  method,
  apiPath,
  body,
  initialToken,
  includeHeaders,
  solution,
  tenantId,
  getToken = getAuthToken,
  sendRequest = doRequest,
  {
    nowMs = () => Date.now(),
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    onRateLimited = () => {},
  } = {},
) {
  let token = initialToken;
  let rateLimited = false;
  const maxRetries = 4;
  let attempts = 0;
  let retryCount = 0;
  let responseBytes = 0;

  function finish(result) {
    return {
      ...result,
      attempts,
      retryCount,
      responseBytes,
    };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Response headers are always needed internally for Retry-After handling.
    // The caller-facing result still honors includeHeaders below.
    const attemptStartedAt = nowMs();
    const res = await sendRequest(envUrl, method, apiPath, body, token, true, solution);
    attempts += 1;
    responseBytes += Buffer.byteLength(String(res.body || ''), 'utf8');
    void attemptStartedAt;
    if (res.error) {
      if (isMutationMethod(method)) {
        return finish({
          status: 0,
          error: res.error,
          token,
          rateLimited,
          uncertain: true,
        });
      }
      if (attempt < maxRetries) {
        retryCount += 1;
        continue;
      }
      return finish({ status: 0, error: res.error, token, rateLimited });
    }

    if (res.statusCode === 401 && attempt < maxRetries) {
      const refreshed = await getToken(envUrl, tenantId, token);
      if (!refreshed) {
        return finish({ status: 401, error: 'Token refresh failed', token, rateLimited });
      }
      token = refreshed;
      retryCount += 1;
      continue;
    }

    if (res.statusCode === 429 && attempt < maxRetries) {
      const delayMs = retryAfterDelayMs(res.headers?.['retry-after'], 30000);
      if (!rateLimited) onRateLimited({ delayMs, attempt: attempt + 1 });
      rateLimited = true;
      retryCount += 1;
      await sleep(delayMs);
      continue;
    }

    if ([500, 502, 503].includes(res.statusCode) && attempt < maxRetries) {
      retryCount += 1;
      await sleep(5000);
      continue;
    }

    let data = null;
    if (res.body) {
      try {
        data = JSON.parse(res.body);
      } catch {
        data = res.body;
      }
    }

    return finish({
      status: res.statusCode,
      data,
      headers: includeHeaders ? res.headers : undefined,
      token,
      rateLimited,
    });
  }

  return finish({ status: 0, error: 'Exhausted retries', token, rateLimited });
}

// Extract the GUID from an OData-EntityId header value, e.g.
//   "https://orgX.crm.dynamics.com/api/data/v9.2/cr3e9_jobsites(7da69e03-...-...)"
// → "7da69e03-...-..."
function extractGuid(headerValue) {
  const m = String(headerValue).match(/\(([0-9a-fA-F-]{36})\)/);
  return m ? m[1] : null;
}

if (require.main === module) main();

module.exports = {
  MUTATION_REQUEST_TIMEOUT_MS,
  READ_REQUEST_TIMEOUT_MS,
  createDataverseRequestExecutor,
  doRequest,
  extractGuid,
  looksLikeDuplicate,
  metadataRequestIdentity,
  operationFingerprint,
  prepareMetadataJournal,
  retryAfterDelayMs,
  runBatch,
  runMetadataBatch,
  runOneMetadataOperation,
  validateManifestExecutionBinding,
  validateJournalOperations,
};

#!/usr/bin/env node

// General-purpose Dataverse OData API request script with built-in auth and retry.
// Usage: node dataverse-request.js <envUrl> <method> <apiPath> [--body <json>]
//
// Arguments:
//   envUrl   - Dataverse environment URL (e.g., https://org123.crm.dynamics.com)
//   method   - HTTP method: GET, POST, PATCH, DELETE, BATCH-RECORDS, or BATCH-METADATA
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
//   node dataverse-request.js <envUrl> BATCH-RECORDS <label> --operations '<json>' [--concurrency 5] [--solution <name>]
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

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    process.stderr.write(
      'Usage: node dataverse-request.js <envUrl> <method> <apiPath> [--body <json>] [--include-headers] [--solution <uniqueName>]\n' +
      '       node dataverse-request.js <envUrl> BATCH-RECORDS <label> --operations <json> [--concurrency 5] [--solution <name>]\n' +
      '       node dataverse-request.js <envUrl> BATCH-METADATA <label> --operations <json> [--solution <name>] [--tenant-id <id>]\n'
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
    timeout: 30000,
  });

  return res;
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

    const result = await runMetadataBatch(
      envUrl,
      ops,
      token,
      solution,
      tenantId,
      continueOnError,
    );
    console.log(JSON.stringify({ status: result.failed ? 207 : 200, data: result.results }));
    return;
  }

  const maxRetries = 4;
  let wasRateLimited = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await doRequest(envUrl, method, apiPath, body, token, includeHeaders, solution);

    if (res.error) {
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
      const retryAfter = res.headers?.['retry-after'];
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 30000;
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

    // Idempotency rescue: a write request that hit 429 may have already been
    // applied server-side before the rate-limit response was emitted. The retry
    // then comes back as a 4xx "already exists" / duplicate. Treat that as
    // success so callers don't see a spurious failure.
    const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH';
    if (
      wasRateLimited &&
      isWrite &&
      res.statusCode >= 400 &&
      res.statusCode < 500 &&
      looksLikeDuplicate(data)
    ) {
      const output = {
        status: 200,
        data,
        note: `Original ${method} likely succeeded before 429 retry; ignoring duplicate/already-exists response (HTTP ${res.statusCode}).`,
        original_status: res.statusCode,
        rate_limited_during_request: true,
      };
      if (includeHeaders && res.headers) output.headers = res.headers;
      console.log(JSON.stringify(output));
      return;
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
    'cannot insert duplicate key',
    'an item with the same key has already been added',
    'duplicaterecord',
  ].some((needle) => msg.includes(needle));

  const codeMatches = [
    '0x80040237', // DuplicateRecord
    '0x80060888', // SchemaName already in use
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
      const retryAfter = res.headers?.['retry-after'];
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
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

async function runMetadataBatch(
  envUrl,
  ops,
  initialToken,
  defaultSolution,
  tenantId,
  continueOnError,
) {
  const results = [];
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
    results.push(result);

    if (executed.status < 200 || executed.status >= 300) {
      failed = true;
      if (!continueOnError) break;
    }
  }

  return { results, failed };
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
) {
  let token = initialToken;
  let rateLimited = false;
  const maxRetries = 4;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Response headers are always needed internally for Retry-After handling.
    // The caller-facing result still honors includeHeaders below.
    const res = await doRequest(envUrl, method, apiPath, body, token, true, solution);
    if (res.error) {
      if (attempt < maxRetries) continue;
      return { status: 0, error: res.error, token, rateLimited };
    }

    if (res.statusCode === 401 && attempt < maxRetries) {
      const refreshed = await getAuthToken(envUrl, tenantId);
      if (!refreshed) {
        return { status: 401, error: 'Token refresh failed', token, rateLimited };
      }
      token = refreshed;
      continue;
    }

    if (res.statusCode === 429 && attempt < maxRetries) {
      const retryAfter = res.headers?.['retry-after'];
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 30000;
      rateLimited = true;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    if ([500, 502, 503].includes(res.statusCode) && attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
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

    return {
      status: res.statusCode,
      data,
      headers: includeHeaders ? res.headers : undefined,
      token,
      rateLimited,
    };
  }

  return { status: 0, error: 'Exhausted retries', token, rateLimited };
}

// Extract the GUID from an OData-EntityId header value, e.g.
//   "https://orgX.crm.dynamics.com/api/data/v9.2/cr3e9_jobsites(7da69e03-...-...)"
// → "7da69e03-...-..."
function extractGuid(headerValue) {
  const m = String(headerValue).match(/\(([0-9a-fA-F-]{36})\)/);
  return m ? m[1] : null;
}

main();

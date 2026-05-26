#!/usr/bin/env node

// Creates one or many records in a Dataverse table via Web API.
// Single record  -> POST /<entitySet>
// Many records   -> OData $batch (multipart/mixed); default 100 per batch, max 1000
//
// Usage:
//   node create-record.js <envUrl> <entitySet> --body <json|@path>
//     [--batch-size 100]    (records per $batch, default 100, max 1000)
//
// <body> may be:
//   - a single JSON object (one record)
//   - a JSON array of objects (bulk — uses $batch)
//
// <entitySet> is the entity SET name (plural collection), e.g. "accounts", "cr69c_candidates".
// Use OData @odata.bind syntax for lookups:
//   {"new_name":"X","new_AccountLookup@odata.bind":"/accounts(GUID)"}
//
// Output (single): { "ok": true, "count": 1, "ids": ["<guid>"] }
// Output (bulk):   { "ok": true, "count": N, "ids": [...], "errors": [{index, status, message}, ...] }
//
// Exit codes: 0 if all succeed, 1 if any error.

const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  readJsonArg,
  emitResult,
  getAuthToken,
  makeRequest,
} = require('./lib/dataverse-auth');

function extractIdFromHeader(headers) {
  if (!headers) return null;
  const loc = headers['odata-entityid'] || headers['OData-EntityId'] || headers.location;
  if (!loc) return null;
  const m = String(loc).match(/\(([0-9a-f-]{36})\)/i);
  return m ? m[1] : null;
}

async function createSingle(envUrl, entitySet, record) {
  const res = await dataverseRequest(envUrl, 'POST', entitySet, record, { includeHeaders: true });
  ensureOk(res, `Create record in ${entitySet}`);
  return extractIdFromHeader(res.headers);
}

function parseBatchResponse(rawBody) {
  // Split into HTTP parts by the "HTTP/1.1 NNN ..." status line.
  // We don't try to parse multipart headers — Dataverse responses always include the
  // status line + headers + blank line + body for each part.
  const parts = rawBody.split(/HTTP\/1\.1 /).slice(1);
  return parts.map((part) => {
    const statusMatch = part.match(/^(\d{3})/);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    // Split header block from body at the first blank line
    const blank = part.indexOf('\r\n\r\n');
    const headers = blank >= 0 ? part.slice(0, blank) : part;
    const body = blank >= 0 ? part.slice(blank + 4) : '';
    // Strip trailing boundary markers
    const cleanBody = body.replace(/\r?\n--[^\r\n]+(--)?\r?\n?$/g, '').trim();
    return { status, headers, body: cleanBody };
  });
}

async function createBatch(envUrl, entitySet, records, batchSize = 100) {
  const cleanUrl = envUrl.replace(/\/+$/, '');
  const all = { ids: [], errors: [] };

  for (let chunkStart = 0; chunkStart < records.length; chunkStart += batchSize) {
    const chunk = records.slice(chunkStart, chunkStart + batchSize);
    const batchId = `batch_${Date.now()}_${chunkStart}`;
    const changesetId = `changeset_${Date.now()}_${chunkStart}`;

    const lines = [];
    lines.push(`--${batchId}`);
    lines.push(`Content-Type: multipart/mixed; boundary=${changesetId}`);
    lines.push('');

    chunk.forEach((record, idx) => {
      const contentId = chunkStart + idx + 1;
      lines.push(`--${changesetId}`);
      lines.push('Content-Type: application/http');
      lines.push('Content-Transfer-Encoding: binary');
      lines.push(`Content-ID: ${contentId}`);
      lines.push('');
      lines.push(`POST ${cleanUrl}/api/data/v9.2/${entitySet} HTTP/1.1`);
      lines.push('Content-Type: application/json; type=entry');
      lines.push('');
      lines.push(JSON.stringify(record));
    });

    lines.push(`--${changesetId}--`);
    lines.push(`--${batchId}--`);
    lines.push('');

    const body = lines.join('\r\n');

    let token = getAuthToken(cleanUrl);
    if (!token) throw new Error("Failed to get Azure CLI token. Run 'az login' first.");

    const res = await makeRequest({
      url: `${cleanUrl}/api/data/v9.2/$batch`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        'Content-Type': `multipart/mixed; boundary=${batchId}`,
      },
      body,
      timeout: 120000,
    });

    if (res.error) throw new Error(`Batch failed: ${res.error}`);
    if (res.statusCode >= 400) {
      throw new Error(`Batch HTTP ${res.statusCode}: ${res.body.slice(0, 500)}`);
    }

    const parts = parseBatchResponse(res.body);
    parts.forEach((part, idx) => {
      if (part.status >= 200 && part.status < 300) {
        const locMatch = part.headers.match(/OData-EntityId:\s*([^\r\n]+)/i);
        const id = locMatch ? (locMatch[1].match(/\(([0-9a-f-]{36})\)/i) || [])[1] : null;
        if (id) all.ids.push(id);
      } else if (part.status > 0) {
        let msg = part.body;
        try { msg = JSON.parse(part.body).error.message; } catch { /* keep raw */ }
        all.errors.push({ index: chunkStart + idx, status: part.status, message: msg });
      }
    });
  }
  return all;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 2 || flags.body === undefined) {
    process.stderr.write(
      'Usage: node create-record.js <envUrl> <entitySet> --body <json|@path> [--batch-size 100]\n'
    );
    process.exit(1);
  }
  const [envUrl, entitySet] = positional;

  // Sanity-check entitySet — must be a plural entity collection name
  // (lowercase letters / digits / underscore, starting with a letter). This
  // prevents an accidental path-segment injection from a malformed input.
  if (!/^[a-z][a-z0-9_]+$/.test(entitySet)) {
    process.stderr.write(
      `<entitySet> must be a Dataverse collection name (lowercase letters, digits, underscores; e.g. "accounts", "cr69c_candidates"). Got "${entitySet}".\n`,
    );
    process.exit(1);
  }

  const parsed = readJsonArg(flags.body);
  const rawBatchSize = flags['batch-size'] === undefined ? 100 : Number(flags['batch-size']);
  if (!Number.isInteger(rawBatchSize) || rawBatchSize < 1 || rawBatchSize > 1000) {
    process.stderr.write(
      `--batch-size must be an integer in [1, 1000] (got "${flags['batch-size']}").\n`,
    );
    process.exit(1);
  }
  const batchSize = rawBatchSize;

  try {
    if (Array.isArray(parsed)) {
      const result = await createBatch(envUrl, entitySet, parsed, batchSize);
      const allOk = result.errors.length === 0;
      emitResult(allOk, {
        ok: allOk,
        count: result.ids.length,
        ids: result.ids,
        errors: result.errors,
      });
    } else {
      const id = await createSingle(envUrl, entitySet, parsed);
      emitResult(true, { ok: true, count: 1, ids: id ? [id] : [] });
    }
  } catch (e) {
    emitResult(false, e);
  }
}

main();

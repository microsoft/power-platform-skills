#!/usr/bin/env node

// Reads the bytes of a Power Pages Web File (powerpagecomponenttype = 3) from
// the Dataverse ENVIRONMENT (OUR side) — used to sniff text-vs-binary content
// before selective-merge routing.
//
// WEB-FILE BYTES LIVE OUTSIDE THE CONTENT ENVELOPE:
//   powerpagecomponent.content for type-3 is { metadata only } — MERGE_FIELDS_BY_TYPE[3] = [].
//   Bytes are stored in one of two places (preferred first):
//
//     (a) PRIMARY  — annotations.documentbody (base64 string), linked by
//                    _objectid_value = componentId  AND
//                    objecttypecode = 'powerpagecomponent'
//                    Confirmed: map-component-to-git-path.js "bytes in annotation"
//
//     (b) FALLBACK — powerpagecomponent.filecontent File column, read via
//                    /api/data/v9.2/powerpagecomponents(<id>)/filecontent/$value
//                    as raw binary octets.
//                    Confirmed: component-type-map.js "filecontent bytes (outside the envelope)"
//
// BINARY-SAFETY GOTCHA:
//   makeRequest() in validation-helpers.js accumulates the HTTP response body
//   with (data += chunk) — this coerces each Buffer chunk to a UTF-8 string.
//   Any byte sequence that is not valid UTF-8 (PNG, JPEG, WOFF, ZIP …) will be
//   corrupted by the coercion.
//
//   PREFER (a): documentbody is already base64 → pure ASCII → makeRequest-safe.
//   For (b):    fetchBinaryFilecontent() below collects raw Buffer chunks and
//               returns Buffer.concat(chunks) — never calls .toString() on the body.

'use strict';

const helpers = require('./validation-helpers');

/**
 * Detect EOL style in a Buffer by scanning raw bytes.
 * @param {Buffer} bytes
 * @returns {'crlf'|'lf'|'mixed'|null}
 *   'crlf'  — every newline is \r\n
 *   'lf'    — every newline is a bare \n
 *   'mixed' — both \r\n and bare \n are present
 *   null    — no newline bytes found
 */
function detectEolStyle(bytes) {
  let hasCrlf = false;
  let hasBareLf = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0D && i + 1 < bytes.length && bytes[i + 1] === 0x0A) {
      hasCrlf = true;
      i++;  // skip the \n that is part of this \r\n pair
    } else if (bytes[i] === 0x0A) {
      hasBareLf = true;
    }
    if (hasCrlf && hasBareLf) return 'mixed';
  }
  if (hasCrlf) return 'crlf';
  if (hasBareLf) return 'lf';
  return null;
}

/**
 * Detect a BOM from the leading bytes of a Buffer.
 * @param {Buffer} bytes
 * @returns {'utf8'|'utf16le'|'utf16be'|null}
 */
function detectBomName(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf8';
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf16le';
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf16be';
  return null;
}

/**
 * Binary-safe HTTP GET for the filecontent/$value endpoint.
 *
 * makeRequest() in validation-helpers buffers responses as UTF-8 strings via
 * (data += chunk), corrupting any non-UTF-8 byte sequence (images, fonts,
 * archives). This function collects raw Buffer chunks instead so the returned
 * buffer is byte-for-byte identical to what Dataverse sent.
 *
 * @param {string} url
 * @param {string} token  Bearer token (Authorization header only — never in URL)
 * @returns {Promise<{ buffer: Buffer, statusCode: number }|{ error: string, statusCode?: number }>}
 */
function fetchBinaryFilecontent(url, token) {
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ error: `Invalid URL: ${e.message}` }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ error: `filecontent/$value returned HTTP ${res.statusCode}`, statusCode: res.statusCode });
          } else {
            resolve({ buffer: Buffer.concat(chunks), statusCode: res.statusCode });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timed out' }); });
    req.end();
  });
}

/**
 * Build the success result object from a Buffer.
 * @param {Buffer} bytes
 * @returns {{ bytes: Buffer, base64: string, eol: string|null, bom: string|null }}
 */
function buildResult(bytes) {
  return {
    bytes,
    base64: bytes.toString('base64'),
    eol: detectEolStyle(bytes),
    bom: detectBomName(bytes),
  };
}

/**
 * Read the bytes of a Power Pages Web File (powerpagecomponenttype = 3) from Dataverse.
 *
 * Strategy:
 *   1. PRIMARY — Query `annotations` for a record linked to the component via
 *      _objectid_value / objecttypecode='powerpagecomponent'. Read `documentbody`
 *      (base64 string). Convert via Buffer.from(b64, 'base64').
 *      This is ASCII→ makeRequest-safe and avoids the UTF-8 corruption gotcha.
 *
 *   2. FALLBACK — If no annotation exists (or annotation has no documentbody),
 *      fetch the `filecontent` File column via
 *      /api/data/v9.2/powerpagecomponents(<id>)/filecontent/$value as raw binary.
 *      Uses fetchBinaryFilecontent() (Buffer chunks, never toString).
 *
 * Never throws — all failures return { error, statusCode? }.
 *
 * @param {object}   opts
 * @param {string}   opts.envUrl        Dataverse environment URL (required)
 * @param {string}   opts.componentId   powerpagecomponent GUID (required)
 * @param {string}  [opts.token]        Bearer token; obtained via Azure CLI if omitted
 * @param {object}  [opts._deps]        Injectable HTTP layer (used by tests — no real network)
 * @param {Function} [opts._deps.makeRequest]    Replaces helpers.makeRequest for the annotation query
 * @param {Function} [opts._deps.httpGetBuffer]  Replaces fetchBinaryFilecontent for filecontent/$value
 * @param {Function} [opts._deps.getAuthToken]   Replaces helpers.getAuthToken
 *
 * @returns {Promise<
 *   { bytes: Buffer, base64: string, eol: 'crlf'|'lf'|'mixed'|null, bom: string|null } |
 *   { error: string, statusCode?: number }
 * >}
 */
async function readWebFileBytes({ envUrl, componentId, token, _deps = {} } = {}) {
  if (!envUrl) return { error: '--envUrl is required' };
  if (!componentId) return { error: '--componentId is required' };

  const tok = token ||
    (_deps.getAuthToken ? _deps.getAuthToken(envUrl) : helpers.getAuthToken(envUrl));
  if (!tok) return { error: 'Could not acquire auth token.' };

  const base = envUrl.replace(/\/+$/, '');
  const doRequest = _deps.makeRequest || helpers.makeRequest;
  const doHttpGetBuffer = _deps.httpGetBuffer || fetchBinaryFilecontent;

  // ── PRIMARY: annotations.documentbody ────────────────────────────────────────
  // Filter: records linked to our component, narrowed by objecttypecode so we
  // don't accidentally hit annotations for a different entity type that happens
  // to share the same GUID (extremely unlikely but defensive).
  const filterStr =
    `_objectid_value eq '${componentId}' and objecttypecode eq 'powerpagecomponent'`;
  const annotUrl =
    `${base}/api/data/v9.2/annotations` +
    `?$filter=${encodeURIComponent(filterStr)}&$select=annotationid,documentbody&$top=1`;

  const annotRes = await doRequest({
    url: annotUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });

  if (!annotRes.error && annotRes.statusCode === 200) {
    let annotData;
    try { annotData = JSON.parse(annotRes.body); } catch { /* fall through */ }
    const row = annotData && Array.isArray(annotData.value) && annotData.value[0];
    if (row && typeof row.documentbody === 'string' && row.documentbody.length > 0) {
      return buildResult(Buffer.from(row.documentbody, 'base64'));
    }
    // 200 but no annotation (or empty documentbody) → fall through to filecontent
  }
  // annotRes.error (network) or non-200 or no annotation → fall through

  // ── FALLBACK: filecontent/$value (binary-safe Buffer read) ───────────────────
  // NOTE: we do NOT use makeRequest here — it buffers as UTF-8 string and
  // corrupts binary payloads. fetchBinaryFilecontent() uses Buffer.concat(chunks).
  const filecontentUrl =
    `${base}/api/data/v9.2/powerpagecomponents(${componentId})/filecontent/$value`;

  const binRes = await doHttpGetBuffer(filecontentUrl, tok);
  if (binRes.error) {
    return binRes.statusCode !== undefined
      ? { error: binRes.error, statusCode: binRes.statusCode }
      : { error: binRes.error };
  }

  return buildResult(binRes.buffer);
}

/**
 * Binary-safe HTTP PATCH for the filecontent/$value endpoint (fallback write path).
 * @param {string} url    The filecontent/$value URL
 * @param {string} token  Bearer token
 * @param {Buffer} buffer Binary bytes to write
 * @returns {Promise<{ ok: true, statusCode: number }|{ error: string, statusCode?: number }>}
 */
function patchBinaryFilecontent(url, token, buffer) {
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ error: `Invalid URL: ${e.message}` }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: 'PATCH',
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': buffer.length,
          'If-Match': '*',
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve({ ok: true, statusCode: res.statusCode });
          } else {
            resolve({ error: `filecontent PATCH returned HTTP ${res.statusCode}`, statusCode: res.statusCode });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timed out' }); });
    req.write(buffer);
    req.end();
  });
}

/**
 * Write back the bytes of a Power Pages Web File (type 3) to Dataverse.
 * Mirrors readWebFileBytes — writes to the SAME entity/column it reads from.
 *
 * Strategy:
 *   1. PRIMARY  — Query `annotations` for the record linked to this component
 *                 (same filter as readWebFileBytes). PATCH annotations(<id>) with
 *                 { documentbody: base64 } (JSON body — makeRequest-safe).
 *
 *   2. FALLBACK — No annotation found → PATCH powerpagecomponents(<id>)/filecontent
 *                 with the raw binary decoded from base64 (Content-Type: octet-stream).
 *
 * Never throws — all failures return { error, statusCode? }.
 *
 * @param {object}   opts
 * @param {string}   opts.envUrl        Dataverse environment URL (required)
 * @param {string}   opts.componentId   powerpagecomponent GUID (required)
 * @param {string}   opts.base64        Base64-encoded bytes to write (required)
 * @param {string}  [opts.token]        Bearer token; obtained via Azure CLI if omitted
 * @param {object}  [opts._deps]        Injectable HTTP layer (used by tests)
 * @param {Function} [opts._deps.makeRequest]       Replaces helpers.makeRequest for annotation ops
 * @param {Function} [opts._deps.httpPatchBuffer]   Replaces patchBinaryFilecontent for filecontent
 * @param {Function} [opts._deps.getAuthToken]      Replaces helpers.getAuthToken
 *
 * @returns {Promise<{ ok: true } | { error: string, statusCode?: number }>}
 */
async function patchWebFileBytes({ envUrl, componentId, base64, token, _deps = {} } = {}) {
  if (!envUrl) return { error: '--envUrl is required' };
  if (!componentId) return { error: '--componentId is required' };
  if (typeof base64 !== 'string') return { error: 'base64 is required' };

  const tok = token ||
    (_deps.getAuthToken ? _deps.getAuthToken(envUrl) : helpers.getAuthToken(envUrl));
  if (!tok) return { error: 'Could not acquire auth token.' };

  const base = envUrl.replace(/\/+$/, '');
  const doRequest = _deps.makeRequest || helpers.makeRequest;
  const doHttpPatchBuffer = _deps.httpPatchBuffer || patchBinaryFilecontent;

  // ── PRIMARY: find the annotation and PATCH its documentbody ─────────────────
  const filterStr =
    `_objectid_value eq '${componentId}' and objecttypecode eq 'powerpagecomponent'`;
  const annotUrl =
    `${base}/api/data/v9.2/annotations` +
    `?$filter=${encodeURIComponent(filterStr)}&$select=annotationid&$top=1`;

  const annotRes = await doRequest({
    url: annotUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });

  if (!annotRes.error && annotRes.statusCode === 200) {
    let annotData;
    try { annotData = JSON.parse(annotRes.body); } catch { /* fall through */ }
    const row = annotData && Array.isArray(annotData.value) && annotData.value[0];
    if (row && row.annotationid) {
      const patchUrl = `${base}/api/data/v9.2/annotations(${row.annotationid})`;
      const patchRes = await doRequest({
        url: patchUrl,
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${tok}`,
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          'Content-Type': 'application/json',
          'If-Match': '*',
        },
        body: JSON.stringify({ documentbody: base64 }),
      });
      if (!patchRes.error && (patchRes.statusCode === 200 || patchRes.statusCode === 204)) {
        return { ok: true };
      }
      if (patchRes.error) return { error: patchRes.error, statusCode: patchRes.statusCode };
      return { error: `annotation PATCH returned HTTP ${patchRes.statusCode}`, statusCode: patchRes.statusCode };
    }
    // No annotation found → fall through to filecontent PATCH
  }

  // ── FALLBACK: PATCH filecontent with raw binary (octet-stream) ───────────────
  const binaryBuffer = Buffer.from(base64, 'base64');
  const filecontentUrl =
    `${base}/api/data/v9.2/powerpagecomponents(${componentId})/filecontent`;

  const binRes = await doHttpPatchBuffer(filecontentUrl, tok, binaryBuffer);
  if (binRes.error) {
    return binRes.statusCode !== undefined
      ? { error: binRes.error, statusCode: binRes.statusCode }
      : { error: binRes.error };
  }
  return { ok: true };
}

// ── CLI entry point ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const opts = {
    envUrl: get('--envUrl'),
    componentId: get('--componentId'),
    token: get('--token'),
  };
  readWebFileBytes(opts)
    .then((r) => {
      // Don't print raw bytes to stdout — print metadata only (base64 length + eol + bom).
      const out = r.error
        ? r
        : { base64Length: r.base64.length, eol: r.eol, bom: r.bom };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    })
    .catch((e) => {
      process.stderr.write('read-web-file-bytes: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { readWebFileBytes, patchWebFileBytes, detectEolStyle, detectBomName, fetchBinaryFilecontent, patchBinaryFilecontent };

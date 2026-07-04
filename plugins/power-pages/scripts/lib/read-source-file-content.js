#!/usr/bin/env node

// Reads the bytes of a Power Pages CODE-SITE SOURCE FILE from the Dataverse
// ENVIRONMENT (the OURS side of the selective-merge conflict flow).
//
// WHY A DEDICATED READER (Bug 2 / Bug 7):
//   Code-site source files are NOT powerpagecomponents. They live in their own
//   table `powerpagessourcefile` (entity set `powerpagessourcefiles`). Two facts
//   surprise callers and are the whole reason this module exists:
//
//   1. componentId == powerpagessourcefileid (the PRIMARY KEY), NOT
//      componentidunique. The Git-integration conflict row's `componentId` is the
//      powerpagessourcefileid, so it can be used directly as the record key here.
//
//   2. The source BYTES live in the `filecontent` File column — read via
//        GET /api/data/v9.2/powerpagessourcefiles(<id>)/filecontent/$value
//      The `content` Memo column is ONLY a small JSON envelope
//        { "filename", "mimetype", "partialurl" }
//      and does NOT contain the bytes. Reading `content` and expecting source is a
//      classic mistake — it yields metadata, never the file.
//
// These files are plain text (`.tsx`/`.ts`/`.css`/`.json`/`.html`/`.scss` …) so the
// merge strategy is always 'text'; we still sniff the bytes (fail-closed to binary
// on ambiguity) so a mislabelled binary asset can't be force-text-merged.
//
// BINARY-SAFETY: the filecontent/$value endpoint is read with the shared
// binary-safe Buffer reader from read-web-file-bytes.js (validation-helpers'
// makeRequest buffers as UTF-8 and would corrupt non-UTF-8 bytes). Reused, not
// duplicated.
//
// Output (resolved):
//   { id, name, partialurl, mergeStrategy: 'text', bytes: <Buffer>, isText, encoding }
//   On error: { error, statusCode? }
//
// Usage:
//   node read-source-file-content.js --envUrl <url> --componentId <powerpagessourcefileid> [--token <dvToken>]

'use strict';

const helpers = require('./validation-helpers');
const { fetchBinaryFilecontent } = require('./read-web-file-bytes');
const { sniffTextOrBinary } = require('./detect-text-or-binary');
const { SOURCEFILE_TYPE } = require('./component-type-map');

const ENTITY_SET = 'powerpagessourcefiles';
const API_VERSION = 'v9.2';
const DEFAULT_FILE_COLUMN = 'filecontent';

// ── Bug 13: Dataverse Metadata-query guardrails ───────────────────────────────
// EntityDefinitions / AttributeMetadata queries have two hard limits that 4xx/5xx
// on real tenants. Both are baked into buildAttributeMetadataUrl() below so any
// metadata DISCOVERY this reader performs is safe:
//
//   • `contains()` is NOT supported on Metadata Entities — it returns HTTP 501
//     (NotImplemented). Use an EXACT `eq` on LogicalName, or fetch the (small)
//     attribute set and filter client-side. Never `$filter=contains(LogicalName,…)`.
//
//   • `MaxLength` is NOT a member of the BASE `AttributeMetadata` type — selecting
//     it on the base type returns HTTP 400 (BadRequest). To read a length you must
//     CAST to the typed metadata, e.g.
//     `Attributes/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength`,
//     or omit it entirely (this reader does not need it).
const META_TYPED_CAST = 'Microsoft.Dynamics.CRM.StringAttributeMetadata';

/**
 * Build a SAFE EntityDefinitions/AttributeMetadata discovery URL for a single
 * entity's attribute(s). Encodes the Bug 13 guardrails: exact `eq` (never
 * `contains()`), and a typed cast whenever MaxLength is requested (never selected
 * on the base AttributeMetadata type).
 *
 * @param {object} opts
 * @param {string} opts.base                 Dataverse env base URL.
 * @param {string} [opts.entityLogicalName]  Default 'powerpagessourcefile'.
 * @param {string} [opts.attributeLogicalName] Narrow to one attribute (exact eq).
 * @param {boolean} [opts.includeMaxLength]   Cast to StringAttributeMetadata + select MaxLength.
 * @returns {string} the metadata query URL
 */
function buildAttributeMetadataUrl({
  base,
  entityLogicalName = 'powerpagessourcefile',
  attributeLogicalName = null,
  includeMaxLength = false,
} = {}) {
  const b = String(base || '').replace(/\/+$/, '');
  // EXACT eq, never contains() — contains() on Metadata Entities returns 501.
  const entityFilter = `LogicalName eq '${String(entityLogicalName).replace(/'/g, "''")}'`;
  // Expand Attributes; when a length is needed, CAST to the typed metadata so
  // MaxLength is selectable without the base-type 400.
  let attrExpand;
  if (includeMaxLength) {
    const inner = attributeLogicalName
      ? `$filter=LogicalName eq '${String(attributeLogicalName).replace(/'/g, "''")}';$select=LogicalName,MaxLength`
      : `$select=LogicalName,MaxLength`;
    attrExpand = `Attributes/${META_TYPED_CAST}(${inner})`;
  } else {
    const inner = attributeLogicalName
      ? `$filter=LogicalName eq '${String(attributeLogicalName).replace(/'/g, "''")}';$select=LogicalName,AttributeType`
      : `$select=LogicalName,AttributeType`;
    attrExpand = `Attributes(${inner})`;
  }
  return `${b}/api/data/${API_VERSION}/EntityDefinitions` +
    `?$filter=${encodeURIComponent(entityFilter)}` +
    `&$select=LogicalName,EntitySetName` +
    `&$expand=${attrExpand}`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, componentId: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--componentId' && args[i + 1]) out.componentId = args[++i];
  }
  return out;
}

/**
 * Parse the `content` envelope of a powerpagessourcefile row. This column holds
 * ONLY { filename, mimetype, partialurl } metadata — never the bytes.
 * @param {string|null} rawContent
 * @returns {{ filename: string|null, mimetype: string|null, partialurl: string|null }}
 */
function parseContentEnvelope(rawContent) {
  const out = { filename: null, mimetype: null, partialurl: null };
  if (!rawContent || typeof rawContent !== 'string') return out;
  try {
    const env = JSON.parse(rawContent);
    if (env && typeof env === 'object') {
      out.filename = env.filename != null ? String(env.filename) : null;
      out.mimetype = env.mimetype != null ? String(env.mimetype) : null;
      out.partialurl = env.partialurl != null ? String(env.partialurl) : null;
    }
  } catch (_) { /* leave nulls — envelope absent/garbled */ }
  return out;
}

/**
 * Read a code-site source file's env bytes from powerpagessourcefile.filecontent.
 *
 * @param {object}   opts
 * @param {string}   opts.envUrl        Dataverse environment URL (required).
 * @param {string}   opts.componentId   == powerpagessourcefileid (PRIMARY KEY; required).
 * @param {string}  [opts.token]        Dataverse bearer; acquired via Azure CLI if omitted.
 * @param {object}  [opts._deps]        Injectable HTTP layer (tests — no real network).
 * @param {Function} [opts._deps.makeRequest]    Replaces helpers.makeRequest (metadata GET).
 * @param {Function} [opts._deps.httpGetBuffer]  Replaces fetchBinaryFilecontent (bytes GET).
 * @param {Function} [opts._deps.getAuthToken]   Replaces helpers.getAuthToken.
 * @returns {Promise<
 *   { id, name, partialurl, mimetype, mergeStrategy: 'text', type, bytes: Buffer, base64, isText, encoding } |
 *   { error: string, statusCode?: number }
 * >}
 */
async function readSourceFileContent({ envUrl, componentId, token, _deps = {} } = {}) {
  const url = envUrl || helpers.getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  if (!componentId) return { error: '--componentId (powerpagessourcefileid) is required' };

  const tok = token ||
    (_deps.getAuthToken ? _deps.getAuthToken(url) : helpers.getAuthToken(url));
  if (!tok) return { error: 'Could not acquire auth token.' };

  const base = url.replace(/\/+$/, '');
  const doRequest = _deps.makeRequest || helpers.makeRequest;
  const doHttpGetBuffer = _deps.httpGetBuffer || fetchBinaryFilecontent;

  // 1) Metadata row — name + the { filename, mimetype, partialurl } envelope. The
  //    record key is the powerpagessourcefileid (== the conflict componentId). A
  //    regular entity query (NOT a Metadata Entity query), so $select is safe here.
  const metaUrl =
    `${base}/api/data/${API_VERSION}/${ENTITY_SET}(${componentId})` +
    `?$select=powerpagessourcefileid,name,content`;
  const metaRes = await doRequest({
    url: metaUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });

  let row = null;
  if (!metaRes.error && metaRes.statusCode === 200) {
    try { row = JSON.parse(metaRes.body); } catch { /* fall through; name/partialurl stay null */ }
  } else if (metaRes.statusCode === 404) {
    return { error: 'Source file not found (powerpagessourcefileid).', statusCode: 404 };
  } else if (metaRes.error) {
    return { error: metaRes.error };
  } else {
    let msg = `HTTP ${metaRes.statusCode}`;
    try { msg = JSON.parse(metaRes.body).error.message || msg; } catch {}
    return { error: msg, statusCode: metaRes.statusCode };
  }

  const envelope = parseContentEnvelope(row && row.content);
  const name = (row && row.name) || envelope.filename || null;

  // 2) Bytes — filecontent/$value, read binary-safe (never .toString() on the body).
  const fileUrl = `${base}/api/data/${API_VERSION}/${ENTITY_SET}(${componentId})/${DEFAULT_FILE_COLUMN}/$value`;
  const binRes = await doHttpGetBuffer(fileUrl, tok);
  if (binRes.error) {
    return binRes.statusCode !== undefined
      ? { error: binRes.error, statusCode: binRes.statusCode }
      : { error: binRes.error };
  }
  const bytes = binRes.buffer;
  const sniff = sniffTextOrBinary(bytes);

  return {
    id: componentId,
    name,
    partialurl: envelope.partialurl,
    mimetype: envelope.mimetype,
    type: SOURCEFILE_TYPE,
    mergeStrategy: 'text',
    bytes,
    base64: bytes.toString('base64'),
    isText: !!(sniff && sniff.isText),
    encoding: (sniff && sniff.encoding) || null,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  readSourceFileContent(args)
    .then((r) => {
      // Never print raw bytes — metadata + sniff only.
      const out = r.error ? r : { id: r.id, name: r.name, partialurl: r.partialurl, mergeStrategy: r.mergeStrategy, byteLength: r.bytes.length, isText: r.isText, encoding: r.encoding };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    })
    .catch((e) => {
      process.stderr.write('read-source-file-content: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = {
  readSourceFileContent,
  parseContentEnvelope,
  buildAttributeMetadataUrl,
  ENTITY_SET,
  DEFAULT_FILE_COLUMN,
};

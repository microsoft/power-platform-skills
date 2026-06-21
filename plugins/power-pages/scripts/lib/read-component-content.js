#!/usr/bin/env node

// Reads a Power Pages component's editable source field(s) LIVE from Dataverse —
// the OURS side of the selective-merge conflict flow.
//
// Power Pages site components live in the unified `powerpagecomponent` table.
// The editable content is stored in the `content` column as a JSON-string
// envelope whose shape depends on `powerpagecomponenttype`:
//
//   Web Template (8):    { "source": "<liquid/html>" }
//   Content Snippet (7): { "value": "<html/text>", "type": <int>, ... }
//   Web Page (2):        { ...metadata, "copy": "<html>" }   (copy present only on content pages)
//   Site Setting (9):    { "value": "<scalar|json>", "description"?: "..." }
//   Web File (3):        { ...metadata only }  — file BYTES are NOT here (separate annotation);
//                        web files are binary keep/accept in v1.
//
// This module is the single source of truth for that envelope contract: it both
// EXTRACTS the mergeable field(s) for the diff, and (via `reattachContent`)
// re-wraps a merged field back into the envelope for write-back — so the
// Dataverse metadata (GUIDs, language ids, flags) is preserved untouched.
//
// HAR-confirmed against sri-alm-dev-1 / RetailOS on 2026-06-17 (see POC findings).
//
// Output (JSON to stdout):
//   {
//     id, name, type, typeLabel,
//     mergeStrategy: "text" | "scalar" | "binary",
//     mergeFields: [ { key, value, isText } ],   // editable field(s) to diff/merge
//     envelope: <parsed content object>,         // full parsed envelope (for reattach)
//     raw: "<original content string>"
//   }
//   On error: { error, statusCode? }
//
// Usage:
//   node read-component-content.js --envUrl <url>
//        ( --componentId <powerpagecomponentid>
//        | --componentType <int> --name <name> [--siteId <powerpagesiteid>] )
//        [--token <dvToken>]

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');
const { PPC_TYPE_LABELS } = require('./discover-site-components');

// Editable text field(s) per powerpagecomponenttype. Order matters: the first
// present field is the "primary" merge unit. Empty array ⇒ no text field ⇒
// binary/keep-accept routing (e.g. web files, whose bytes live elsewhere).
const MERGE_FIELDS_BY_TYPE = Object.freeze({
  2: ['copy'],     // Web Page
  3: [],           // Web File — bytes in annotation, not the content envelope
  7: ['value'],    // Content Snippet
  8: ['source'],   // Web Template
  9: ['value'],    // Site Setting
});

const COMPONENT_TYPE_LABEL = PPC_TYPE_LABELS;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, componentId: null, componentType: null, name: null, siteId: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--componentId' && args[i + 1]) out.componentId = args[++i];
    else if (args[i] === '--componentType' && args[i + 1]) out.componentType = parseInt(args[++i], 10);
    else if (args[i] === '--name' && args[i + 1]) out.name = args[++i];
    else if (args[i] === '--siteId' && args[i + 1]) out.siteId = args[++i];
  }
  return out;
}

/**
 * Classify how a single envelope field should be resolved when it conflicts.
 *   - text:   multi-line or JSON-shaped → worth a 3-way text merge
 *   - scalar: a short single-line value → merging is meaningless; keep/accept
 * @param {*} value
 * @returns {"text"|"scalar"}
 */
function classifyFieldValue(value) {
  if (typeof value !== 'string') return 'scalar';
  if (value.includes('\n') || value.includes('\r')) return 'text';
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { JSON.parse(trimmed); return 'text'; } catch { /* not json */ }
  }
  return 'scalar';
}

/**
 * Parse a component's `content` envelope and extract its mergeable field(s).
 *
 * @param {number} type      powerpagecomponenttype
 * @param {string} rawContent  The `content` column string.
 * @returns {{ envelope: object|null, mergeFields: object[], mergeStrategy: string, parseError?: string }}
 */
function extractMergeFields(type, rawContent) {
  let envelope = null;
  if (rawContent) {
    try { envelope = JSON.parse(rawContent); } catch (e) {
      return { envelope: null, mergeFields: [], mergeStrategy: 'binary', parseError: e.message };
    }
  }

  const fieldKeys = MERGE_FIELDS_BY_TYPE[type];
  // Web files (and any type with no declared text field) → binary.
  if (!fieldKeys || fieldKeys.length === 0) {
    return { envelope, mergeFields: [], mergeStrategy: 'binary' };
  }

  const mergeFields = [];
  for (const key of fieldKeys) {
    if (!envelope || !(key in envelope)) continue; // field absent (e.g. web page with no copy)
    const value = envelope[key];
    const kind = classifyFieldValue(value);
    mergeFields.push({ key, value: typeof value === 'string' ? value : String(value), isText: kind === 'text' });
  }

  if (mergeFields.length === 0) {
    // Declared field(s) not present on this instance → nothing text-mergeable.
    return { envelope, mergeFields: [], mergeStrategy: 'binary' };
  }

  // Strategy is text if ANY field is text-worthy; otherwise scalar (keep/accept).
  const mergeStrategy = mergeFields.some((f) => f.isText) ? 'text' : 'scalar';
  return { envelope, mergeFields, mergeStrategy };
}

/**
 * Re-wrap merged field value(s) back into the original envelope, preserving all
 * other metadata, and return the new `content` string ready to PATCH back to
 * `powerpagecomponent.content`. The inverse of extractMergeFields.
 *
 * @param {object} envelope             The original parsed envelope.
 * @param {Object<string,string>} updates  Map of fieldKey → merged value.
 * @returns {string} The new JSON `content` string.
 */
function reattachContent(envelope, updates) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('reattachContent: envelope must be the original parsed object');
  }
  if (!updates || typeof updates !== 'object') {
    throw new Error('reattachContent: updates must be a { fieldKey: value } map');
  }
  const next = { ...envelope };
  for (const [key, value] of Object.entries(updates)) {
    next[key] = value;
  }
  return JSON.stringify(next);
}

async function readComponentContent({ envUrl, token, componentId, componentType, name, siteId } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  if (!componentId && !(Number.isInteger(componentType) && name)) {
    return { error: 'Provide --componentId OR (--componentType and --name).' };
  }

  const select = '$select=powerpagecomponentid,name,powerpagecomponenttype,content';
  let apiUrl;
  if (componentId) {
    apiUrl = `${base}/api/data/v9.2/powerpagecomponents(${componentId})?${select}`;
  } else {
    const filters = [`powerpagecomponenttype eq ${componentType}`, `name eq '${String(name).replace(/'/g, "''")}'`];
    if (siteId) filters.push(`_powerpagesiteid_value eq ${siteId}`);
    apiUrl = `${base}/api/data/v9.2/powerpagecomponents?${select}&$filter=${encodeURIComponent(filters.join(' and '))}&$top=2`;
  }

  const res = await makeRequest({
    url: apiUrl, method: 'GET',
    headers: { Authorization: `Bearer ${tok}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json' },
  });

  if (res.error) return { error: res.error };
  if (res.statusCode === 404) return { error: 'Component not found.', statusCode: 404 };
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg = JSON.parse(res.body).error.message || msg; } catch {}
    return { error: msg, statusCode: res.statusCode };
  }

  let row;
  try {
    const parsed = JSON.parse(res.body);
    row = componentId ? parsed : (parsed.value || [])[0];
  } catch (e) {
    return { error: 'Failed to parse response: ' + e.message };
  }
  if (!row) return { error: 'Component not found.', statusCode: 404 };

  const type = row.powerpagecomponenttype;
  const { envelope, mergeFields, mergeStrategy, parseError } = extractMergeFields(type, row.content);

  return {
    id: row.powerpagecomponentid,
    name: row.name,
    type,
    typeLabel: COMPONENT_TYPE_LABEL[type] || `Unknown (${type})`,
    mergeStrategy,
    mergeFields,
    envelope,
    raw: row.content || null,
    ...(parseError ? { parseError } : {}),
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  readComponentContent(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('read-component-content: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = {
  readComponentContent,
  extractMergeFields,
  reattachContent,
  classifyFieldValue,
  MERGE_FIELDS_BY_TYPE,
};

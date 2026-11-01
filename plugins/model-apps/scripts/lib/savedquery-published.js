'use strict';

// savedquery-published.js — read the saved and the published layer of one view (savedquery) or chart
// (savedqueryvisualization) row, as the layer reader of a managed view or chart group (lib/managed-layer-readers.js).
//
// WHY A VIEW OR CHART IS READ AT ALL. A table publish ships the saved layer of everything on the table. A managed view or
// chart group owes no publish of its own (its publication is the build's table publish, state `not-needed`), but another
// family's managed publish of the same table — a declared form's — would put its saved layer live too. So before that
// publish is sent, the view's or chart's saved layer must be shown equal to its published one (publishManagedScope:
// "any other group a saved layer equal to its published one or to its desired hash").
//
// The two reads (Dataverse Web API, through a client whose `get(path)` answers { status, body } and does not throw on a
// non-2xx status, like lib/sdk-http-client.js):
//   view   saved      GET /savedqueries(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=savedqueryid,name,description,fetchxml,layoutxml
//          published  GET /savedqueries(<id>)?$select=savedqueryid,name,description,fetchxml,layoutxml
//   chart  saved      GET /savedqueryvisualizations(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=savedqueryvisualizationid,name,description,datadescription,presentationdescription
//          published  GET /savedqueryvisualizations(<id>)?$select=savedqueryvisualizationid,name,description,datadescription,presentationdescription
// RetrieveUnpublished answers the row as last saved; a plain retrieve answers the published row.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrieveunpublished
// A row that was created and never published has no published layer: the plain retrieve answers 404 with the Dataverse
// "object does not exist" code, e.g. { "error": { "code": "0x80040217", "message": "savedquery With Id = … Does Not Exist" } }.
// Its published layer reads as NEVER_PUBLISHED_SHA256, which equals no layer hash, so it is never shown safe.

const { normalizeGuid, intentSha256 } = require('./reconcile-common.js');
const { NEVER_PUBLISHED_SHA256, UNVERIFIED } = require('./systemform-published.js');

// Dataverse "Object does not exist" (ObjectDoesNotExist).
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
const NOT_FOUND = '0x80040217';

// The compared fields of each row: the ones a view's or chart's definition is stored in. `description` is optional and may
// be missing or null; every other field must be text.
const TABLES = Object.freeze({
  view: Object.freeze({ collection: 'savedqueries', idField: 'savedqueryid', fields: Object.freeze(['name', 'fetchxml', 'layoutxml']) }),
  chart: Object.freeze({ collection: 'savedqueryvisualizations', idField: 'savedqueryvisualizationid', fields: Object.freeze(['name', 'datadescription', 'presentationdescription']) }),
});

function unverified(message, cause) {
  return Object.assign(new Error(message), { code: UNVERIFIED, ...(cause ? { cause } : {}) });
}

function parsed(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string' || !body.trim()) return null;
  try { return JSON.parse(body); } catch { return null; }
}

// The OData error envelope is { "error": { "code", "message" } }; some surfaces capitalize it as "Error".
function errorCode(body) {
  const b = parsed(body);
  const err = b && (b.error || b.Error);
  return err && typeof err.code === 'string' ? err.code.toLowerCase() : null;
}

const ok = (res) => !!res && Number.isInteger(res.status) && res.status >= 200 && res.status < 300;

function rowOf(t, res, id, layer, family) {
  const row = parsed(res.body);
  if (!row || typeof row !== 'object') throw unverified(`the ${layer} ${family} ${id} answered no row`);
  if (normalizeGuid(row[t.idField]) !== id) throw unverified(`the ${layer} ${family} read answered another row than ${id}`);
  const out = {};
  for (const f of t.fields) {
    if (typeof row[f] !== 'string') throw unverified(`the ${layer} ${family} ${id} answered no ${f}`);
    out[f] = row[f];
  }
  if (row.description !== undefined && row.description !== null && typeof row.description !== 'string') throw unverified(`the ${layer} ${family} ${id} answered a description that is not text`);
  out.description = row.description == null ? null : row.description;
  return out;
}

async function get(client, path, id, layer, family) {
  try {
    return await client.get(path);
  } catch (e) {
    throw unverified(`the ${layer} ${family} ${id} could not be read (${e.code || e.message})`, e);
  }
}

/** The hash of one layer of a view or chart: SHA-256 of the canonical JSON of its compared fields and description. */
function savedQueryLayerSha256(family, layer) {
  const t = TABLES[family];
  const out = { description: layer.description == null ? null : layer.description };
  for (const f of t.fields) out[f] = layer[f];
  return intentSha256(out);
}

/**
 * The layer reader of a managed view or chart group: both layers of the group's root row, as { savedSha256, publishedSha256 }
 * hashed by savedQueryLayerSha256. Throws `managed-publication-unverified` for any answer it cannot prove: a failed read is
 * not evidence that the layers are equal, nor that they differ.
 */
async function readSavedQueryLayers(family, client, group) {
  const t = TABLES[family];
  if (!t) throw unverified(`"${family}" is not a view or chart family`);
  const id = normalizeGuid(group && group.root && group.root.id);
  if (!id) throw unverified(`the managed ${family} has no row id to read`);
  if (!client || typeof client.get !== 'function') throw unverified(`no client to read the ${family} with`);
  const select = `$select=${[t.idField, 'name', 'description', ...t.fields.filter((f) => f !== 'name')].join(',')}`;
  const savedRes = await get(client, `/${t.collection}(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?${select}`, id, 'saved', family);
  if (!ok(savedRes)) throw unverified(`the saved ${family} ${id} could not be read (status ${savedRes && savedRes.status})`);
  const saved = rowOf(t, savedRes, id, 'saved', family);
  const pubRes = await get(client, `/${t.collection}(${id})?${select}`, id, 'published', family);
  if (pubRes && pubRes.status === 404 && errorCode(pubRes.body) === NOT_FOUND) return { savedSha256: savedQueryLayerSha256(family, saved), publishedSha256: NEVER_PUBLISHED_SHA256 };
  if (!ok(pubRes)) throw unverified(`the published ${family} ${id} could not be read (status ${pubRes && pubRes.status})`);
  const published = rowOf(t, pubRes, id, 'published', family);
  return { savedSha256: savedQueryLayerSha256(family, saved), publishedSha256: savedQueryLayerSha256(family, published) };
}

module.exports = { readSavedQueryLayers, savedQueryLayerSha256 };

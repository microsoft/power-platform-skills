'use strict';

// systemform-published.js — read the saved and the published layer of one systemform row (a form or a dashboard)
// and say whether they differ. A managed form or dashboard owes a publish only while they differ: a saved change
// that is already live needs no publish, and a publish of a row whose layers cannot be read is never guessed at.
//
// The two reads (Dataverse Web API, through a client whose `get(path)` answers { status, body } and does not throw
// on a non-2xx status, like lib/sdk-http-client.js):
//   saved      GET /systemforms(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formid,name,description,formxml
//   published  GET /systemforms(<id>)?$select=formid,name,description,formxml
// RetrieveUnpublished answers the row as last saved; a plain retrieve answers the published row.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrieveunpublished
// A row that was created but never published has no published layer: the plain retrieve answers 404 with the
// Dataverse "object does not exist" code, e.g. { "error": { "code": "0x80040217", "message": "systemform With Id = … Does Not Exist" } }.

const { normalizeGuid, intentSha256 } = require('./reconcile-common.js');
const { comparableSavedFormXml } = require('./formxml-layers.js');

const SELECT = '$select=formid,name,description,formxml';
// The root fields a dashboard's support and identity depend on: its systemform `type` (0 a Standard dashboard, 10 an
// interactive one) and its `objecttypecode` ("none" for a global dashboard, a table's logical name otherwise). Read in
// the SAME GET as the content when the caller asks for them, so content and root are one observation.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/systemform
const ROOT_SELECT = `${SELECT},type,objecttypecode`;
// Dataverse "Object does not exist" (ObjectDoesNotExist), the code a 404 for a missing row carries.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
const NOT_FOUND = '0x80040217';
const UNVERIFIED = 'managed-publication-unverified';

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

// A row counts only when it is the row asked for and carries the compared fields as strings. `description` is
// optional on a systemform and may be missing or null; name and formxml may not.
//
// With `rootFields`, the row also carries its `type` and `objecttypecode`. `type` is an OData Int32 option set, e.g.
// "type": 0, but a client that echoes what the SDK sent may hold the string "0"; it must be a whole number either way.
// `objecttypecode` is a logical name, e.g. "objecttypecode": "none"; a row may hold it null, which reads as global.
function rowOf(res, id, layer, rootFields = false) {
  const row = parsed(res.body);
  if (!row || typeof row !== 'object') throw unverified(`the ${layer} systemform ${id} answered no row`);
  if (normalizeGuid(row.formid) !== id) throw unverified(`the ${layer} systemform read answered another row than ${id}`);
  if (typeof row.name !== 'string' || typeof row.formxml !== 'string') throw unverified(`the ${layer} systemform ${id} answered no name or form XML`);
  if (row.description !== undefined && row.description !== null && typeof row.description !== 'string') throw unverified(`the ${layer} systemform ${id} answered a description that is not text`);
  const out = { formid: id, name: row.name, description: row.description == null ? null : row.description, formxml: row.formxml };
  if (!rootFields) return out;
  const type = typeof row.type === 'string' && /^\d+$/.test(row.type) ? Number(row.type) : row.type;
  if (!Number.isInteger(type)) throw unverified(`the ${layer} systemform ${id} answered no form type`);
  if (row.objecttypecode !== undefined && row.objecttypecode !== null && typeof row.objecttypecode !== 'string') throw unverified(`the ${layer} systemform ${id} answered a table that is not a logical name`);
  return { ...out, type, objecttypecode: row.objecttypecode == null ? null : row.objecttypecode };
}

async function get(client, path, id, layer) {
  try {
    return await client.get(path);
  } catch (e) {
    throw unverified(`the ${layer} systemform ${id} could not be read (${e.code || e.message})`, e);
  }
}

/**
 * Read both layers of systemform `id` and compare name, description and formxml — and, with `{ rootFields: true }`,
 * also `type` and `objecttypecode`, read in the same GET of each layer (ROOT_SELECT).
 * Answers { state: 'equal' | 'differs' | 'never-published', saved, published, savedCompared } (published is null when
 * never published). Throws `managed-publication-unverified` for every other answer: a failed read is not evidence that
 * the layers are equal, nor that they differ.
 *
 * `saved` and `published` are the rows as read. What is compared is `savedCompared` — the saved row with the captions
 * of its formxml that the published read cannot carry set aside (lib/formxml-layers.js, comparableSavedFormXml) — with
 * `published` as read. In an organization with a second language provisioned, the saved read carries that language's
 * captions on some labels and the published read carries none, so compared as text no publish could ever be confirmed.
 * NOT COMPARED: a caption in a language the published read does not return and that is not on every label of the saved
 * form (a translation); everything else, a caption in any language the published read returns included, is compared
 * byte for byte. A managed group's publication hash is taken of `savedCompared` (systemFormLayerSha256), so the layer
 * readers below and every caller that records a desired hash compare like with like; in an organization of one
 * language `savedCompared` is the saved row's content unchanged, and so is every hash. `savedCompared` is the
 * publication view only — it decides whether a publish is live, and no certification or binding of content uses it: a
 * declared dashboard's proof that its saved row holds what the build sent reads `saved`, every caption in every
 * language, or a caption with text someone typed in such a language would be certified as the build's
 * (dashboard-reconcile.js proveDashboard).
 */
async function readSystemFormPublication(client, rawId, { rootFields = false } = {}) {
  const id = normalizeGuid(rawId);
  if (!id) throw unverified(`"${rawId}" is not a systemform id`);
  if (!client || typeof client.get !== 'function') throw unverified('no client to read the systemform with');
  const select = rootFields ? ROOT_SELECT : SELECT;
  const savedRes = await get(client, `/systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?${select}`, id, 'saved');
  if (!ok(savedRes)) throw unverified(`the saved systemform ${id} could not be read (status ${savedRes && savedRes.status})`);
  const saved = rowOf(savedRes, id, 'saved', rootFields);
  const pubRes = await get(client, `/systemforms(${id})?${select}`, id, 'published');
  if (pubRes && pubRes.status === 404 && errorCode(pubRes.body) === NOT_FOUND) {
    return { state: 'never-published', saved, published: null, savedCompared: { ...saved, formxml: comparableSavedFormXml(saved.formxml, null) } };
  }
  if (!ok(pubRes)) throw unverified(`the published systemform ${id} could not be read (status ${pubRes && pubRes.status})`);
  const published = rowOf(pubRes, id, 'published', rootFields);
  const savedCompared = { ...saved, formxml: comparableSavedFormXml(saved.formxml, published.formxml) };
  const same = savedCompared.name === published.name && savedCompared.description === published.description && savedCompared.formxml === published.formxml &&
    (!rootFields || (savedCompared.type === published.type && savedCompared.objecttypecode === published.objecttypecode));
  return { state: same ? 'equal' : 'differs', saved, published, savedCompared };
}

/**
 * The hash a managed form's publication is recorded by (its `publication.desiredSha256`) and its layers are compared by:
 * the SHA-256 of the canonical JSON of the compared fields of one layer, `{ name, description, formxml }`.
 * An omitted or null description hashes as null, as rowOf reads it: canonical JSON drops an undefined key, so a feature
 * that hashes its own row without a description would otherwise record a hash no read of that row ever answers, and
 * its debt could never be paid. Empty text stays distinct from null.
 */
function systemFormLayerSha256(layer) {
  return intentSha256({ name: layer.name, description: layer.description == null ? null : layer.description, formxml: layer.formxml });
}

/**
 * The layer hash of a systemform whose root fields are part of what it is — a dashboard: systemFormLayerSha256's fields
 * plus `type` and `objecttypecode`, as read with `{ rootFields: true }`. A change of the row's type or table between
 * the proof and the publish then changes the saved hash, so it is never published under a desired hash taken before.
 */
function systemFormRootLayerSha256(layer) {
  return intentSha256({
    name: layer.name, description: layer.description == null ? null : layer.description, formxml: layer.formxml,
    type: layer.type, objecttypecode: layer.objecttypecode == null ? null : layer.objecttypecode,
  });
}

// What a never-published row's published layer reads as: a hash no layer has, so it equals no desired or saved hash.
const NEVER_PUBLISHED_SHA256 = intentSha256({ neverPublished: true });

// The most cells a caption diagnostic names (form-caption-diagnostics.js MAX_CAPTION_DIFFERENCES), repeated here so
// that the check of its answer does not depend on the module it checks.
const CAPTION_DIFFERENCES_MAX = 8;

// A caption diagnostic answer as plain data, copied field by field, or null for anything else: one to
// CAPTION_DIFFERENCES_MAX entries, each a normalized GUID cell id and a whole-number language code, no pair twice, and a
// non-negative whole omitted count. Nothing of the answer is spread or kept by reference.
function usableCaptionDifferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { entries, omittedCount } = value;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > CAPTION_DIFFERENCES_MAX) return null;
  if (!Number.isSafeInteger(omittedCount) || omittedCount < 0) return null;
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') return null;
    const cellId = e.cellId;
    const languageCode = e.languageCode;
    if (typeof cellId !== 'string' || normalizeGuid(cellId) !== cellId) return null;
    if (!Number.isSafeInteger(languageCode) || languageCode < 1000 || languageCode > 99999) return null;
    const k = `${cellId}\u0000${languageCode}`;
    if (seen.has(k)) return null;
    seen.add(k);
    out.push({ cellId, languageCode });
  }
  return { entries: out, omittedCount };
}

// The caption diagnostic of an ADOPTED managed form whose layers differ (form-caption-diagnostics.js), or null. A form
// the build created is not diagnosed: its captions are the build's own. Only XML text is passed to the helper.
function adoptedFormCaptionDifferences(group, read) {
  if (read.state !== 'differs' || !read.published) return null;
  const root = group && group.root;
  const records = group && Array.isArray(group.records) ? group.records : [];
  const rootRecord = root ? records.find((r) => r && r.kind === root.kind && r.key === root.key) : null;
  if (!rootRecord || rootRecord.origin !== 'adopted') return null;
  const { cellCaptionDifferences } = require('./form-caption-diagnostics.js');
  return usableCaptionDifferences(cellCaptionDifferences(String(read.savedCompared.formxml), String(read.published.formxml)));
}

/**
 * The layer reader of a managed systemform group (lib/managed-layer-readers.js): both layers of the group's root row, as
 * { savedSha256, publishedSha256 } hashed by systemFormLayerSha256. Throws `managed-publication-unverified` as
 * readSystemFormPublication does.
 *
 * For an adopted form whose layers differ, the answer may also carry `captionDifferences` ({ entries: [{ cellId,
 * languageCode }], omittedCount }): the cells whose caption reads differently in the two layers, for the message of a
 * stop. It is a diagnostic, never a proof: no caller decides anything by it, and nothing writes it to the store. It is
 * computed only AFTER the two hashes, in its own guard: a helper that throws, is missing or answers anything unusable
 * leaves the answer exactly the two hashes, so a diagnostic can never change a hash, a read failure or a stop.
 */
async function readSystemFormLayers(client, group) {
  const r = await readSystemFormPublication(client, group && group.root && group.root.id);
  const out = { savedSha256: systemFormLayerSha256(r.savedCompared), publishedSha256: r.published ? systemFormLayerSha256(r.published) : NEVER_PUBLISHED_SHA256 };
  try {
    const captionDifferences = adoptedFormCaptionDifferences(group, r);
    if (captionDifferences) out.captionDifferences = captionDifferences;
  } catch {
    // A diagnostic only: its failure is dropped whole, and the answer stays the two hashes.
  }
  return out;
}

/**
 * The layer reader of a managed dashboard group: readSystemFormLayers with the root fields read and hashed too
 * (systemFormRootLayerSha256), the hash a dashboard group records as its `publication.desiredSha256`.
 */
async function readSystemFormRootLayers(client, group) {
  const r = await readSystemFormPublication(client, group && group.root && group.root.id, { rootFields: true });
  return { savedSha256: systemFormRootLayerSha256(r.savedCompared), publishedSha256: r.published ? systemFormRootLayerSha256(r.published) : NEVER_PUBLISHED_SHA256 };
}

/**
 * Is systemform `id` there at all, in either layer? For resuming a create under its stable id (runManagedFeature's
 * `resumeCreate`): answers 'absent' only when BOTH reads answer 404 with the Dataverse "object does not exist" code
 * (0x80040217), and 'present' when either layer answers the row itself. Every other answer — another status or
 * error code, another row, a read that throws — is `managed-publication-unverified`: a create is never resent on a
 * read that did not show the row missing from both layers.
 *   saved      GET /systemforms(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formid,name,description,formxml
 *   published  GET /systemforms(<id>)?$select=formid,name,description,formxml
 */
async function readSystemFormRootPresence(client, rawId) {
  const id = normalizeGuid(rawId);
  if (!id) throw unverified(`"${rawId}" is not a systemform id`);
  if (!client || typeof client.get !== 'function') throw unverified('no client to read the systemform with');
  const seen = [];
  for (const [layer, p] of [['saved', `/systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?${SELECT}`], ['published', `/systemforms(${id})?${SELECT}`]]) {
    const res = await get(client, p, id, layer);
    if (res && res.status === 404 && errorCode(res.body) === NOT_FOUND) { seen.push(false); continue; }
    if (!ok(res)) throw unverified(`the ${layer} systemform ${id} could not be read (status ${res && res.status})`);
    rowOf(res, id, layer);
    seen.push(true);
  }
  return seen.some(Boolean) ? 'present' : 'absent';
}

module.exports = {
  readSystemFormPublication, readSystemFormLayers, readSystemFormRootLayers, readSystemFormRootPresence,
  systemFormLayerSha256, systemFormRootLayerSha256, NEVER_PUBLISHED_SHA256, UNVERIFIED,
};

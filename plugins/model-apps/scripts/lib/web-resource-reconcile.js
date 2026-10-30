'use strict';
// Declared reconciliation of a web resource's content (`webResources[].reconcile: "declared"`).
//
// Without the opt-in nothing here runs: a web resource that exists by name is reused untouched and the build only SAYS when
// its deployed content differs (sdk-build's web-resources phase). With it, the spec's content is the resource's content:
//   - the row is named by its managed binding first, then by this build's unconfirmed-publication receipt, and only then by
//     its (platform-unique) name — a name or equal bytes never transfer ownership;
//   - a row this spec does not manage yet is DISCLOSED before it is first bound or written, even when its bytes already
//     match: the platform-reported direct dependents of the row (RetrieveDependentComponents) are read completely, and an
//     answer that cannot be read is an unknown outcome with nothing written or bound — an empty list would claim nothing
//     else uses the row, which nobody checked;
//   - content is written with the SDK's updateWebResource, which PATCHes the row, publishes it inline and reads the
//     PUBLISHED bytes back; a new resource is created with createWebResource (unique name, no caller id — the SDK cannot
//     send one — and the id the service acknowledged is the row's id);
//   - when the SDK cannot confirm the publication it throws WEB_RESOURCE_UNVERIFIED with the row id AFTER writing:
//       { code: 'WEB_RESOURCE_UNVERIFIED', id: '<guid>', message: "... was written, but publishing it failed ..." }
//     The id is noted in the build's receipt store (web-resource-records.js) at once, and the next run writes the content
//     again BY THAT ID (never a fresh-name create, never a publish-only shortcut). A receipt wins over byte equality: one
//     published read that matches does not prove the write it stands for was published.
// An `external` resource is shared and never the spec's to write, so declared mode refuses it outright.
//
// Inline publication is the one exception to "publish only after settlement": the SDK publishes inside the write, so a
// failure after it (the creation port's answer, the solution add, the binding) leaves content that may already be live.
// The result says so; nothing claims that publish was undone.
//
// Platform references:
//   unique web-resource names: https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-edit-web-resources
//   RetrieveDependentComponents: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrievedependentcomponents
//   web resource dependency limits (dynamic and relative references are not tracked):
//     https://learn.microsoft.com/power-apps/developer/model-driven-apps/web-resources

const { sha256 } = require('./hash.js');
const { odataLit } = require('./odata.js');
const { collectionRows } = require('./app-components.js');
const { runManagedCreate } = require('./managed-create.js');
const {
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  driftVerdict,
  normalizeGuid,
  PRE_WRITE_CODES,
  rulesOf,
} = require('./reconcile-common.js');

const KIND = 'web-resource';
// Solution component type of a web resource: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solutioncomponent
const WEB_RESOURCE_COMPONENT_TYPE = 61;
// App Spec / SDK type token -> Dataverse webresourcetype code:
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/webresource#webresourcetype-choicesoptions
const WEB_RESOURCE_TYPE_CODE = { html: 1, css: 2, js: 3, xml: 4, png: 5, jpg: 6, gif: 7, xap: 8, xsl: 9, ico: 10, svg: 11, resx: 12 };

const lc = (s) => String(s == null ? '' : s).toLowerCase();

function isDeclaredWebResource(wr) {
  return !!wr && wr.reconcile === 'declared';
}

/** The bytes the SDK sends for `options` (webResourceOpts output). */
function wantedBytes(options) {
  return options.contentBase64 !== undefined ? Buffer.from(String(options.contentBase64), 'base64') : Buffer.from(String(options.content == null ? '' : options.content), 'utf8');
}
const contentOf = (options) => (options.contentBase64 !== undefined ? { contentBase64: options.contentBase64 } : { content: options.content });
const bytesSha = (buf) => sha256(buf.toString('base64'));

function readError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * The reads planning needs, over the SDK's Dataverse client (`provision.dataverse`: `get` answers a non-2xx as a response).
 *   saved(id)     — the row's SAVED layer by id (RetrieveUnpublished: a created row that was never published is there too):
 *                   { state: 'present', id, name, type } | { state: 'absent' } | { state: 'unreadable' }
 *   published(id) — the row's PUBLISHED content by id (a plain read): { state: 'present', content } | absent | unreadable.
 *                   A row with no published layer answers 404 here, so absence is only meaningful with a saved read.
 *   byName(name)  — every row of that name, read completely (paged): { state: 'ok', rows: [{ id, name, type }] } | unreadable.
 * Only the documented "Does Not Exist" 404 (0x80040217) proves a row absent; every other non-2xx proves nothing.
 *   GET /webresourceset(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=webresourceid,name,webresourcetype
 *   { "webresourceid": "…", "name": "contoso_/scripts/form.js", "webresourcetype": 3 }
 */
function webResourceReads(client) {
  const answerOf = async (path) => {
    if (!client || typeof client.get !== 'function') return { state: 'unreadable' };
    let res;
    try { res = await client.get(path); } catch { return { state: 'unreadable' }; }
    const code = res && res.body && res.body.error && res.body.error.code;
    if (res && res.status === 404 && code === '0x80040217') return { state: 'absent' };
    if (!res || res.status < 200 || res.status >= 300 || !res.body || typeof res.body !== 'object') return { state: 'unreadable' };
    return { state: 'ok', body: res.body };
  };
  return {
    async saved(id) {
      const a = await answerOf(`/webresourceset(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=webresourceid,name,webresourcetype`);
      if (a.state !== 'ok') return a;
      const b = a.body;
      if (normalizeGuid(b.webresourceid) !== normalizeGuid(id) || typeof b.name !== 'string' || !Number.isInteger(Number(b.webresourcetype))) return { state: 'unreadable' };
      return { state: 'present', id: normalizeGuid(id), name: b.name, type: Number(b.webresourcetype) };
    },
    async published(id) {
      const a = await answerOf(`/webresourceset(${id})?$select=webresourceid,content`);
      if (a.state !== 'ok') return a;
      // A published row with no content column is unreadable, never "empty": empty content is a real zero-byte value.
      if (normalizeGuid(a.body.webresourceid) !== normalizeGuid(id) || typeof a.body.content !== 'string') return { state: 'unreadable' };
      return { state: 'present', content: a.body.content };
    },
    async byName(name) {
      let rows;
      try {
        rows = await collectionRows(client, `/webresourceset?$select=webresourceid,name,webresourcetype&$filter=name eq '${odataLit(name)}'`, 'web resource lookup', { code: 'WEB_RESOURCE_LOOKUP_UNREADABLE' });
      } catch {
        return { state: 'unreadable' };
      }
      const out = [];
      for (const r of rows) {
        if (!r || typeof r.name !== 'string' || !normalizeGuid(r.webresourceid)) return { state: 'unreadable' };
        // `eq` on a string column is case-insensitive; the name is unique ignoring case.
        if (r.name.toLowerCase() === String(name).toLowerCase()) out.push({ id: normalizeGuid(r.webresourceid), name: r.name, type: Number(r.webresourcetype) });
      }
      return { state: 'ok', rows: out };
    },
  };
}

/**
 * The platform-reported DIRECT dependents of a web resource, read completely:
 *   GET /RetrieveDependentComponents(ObjectId=@p1,ComponentType=@p2)?@p1=<guid>&@p2=61
 *   { "value": [ { "dependentcomponenttype": 60, "dependentcomponentobjectid": "<guid>", … } ], "@odata.nextLink"?: "<same-origin URL>" }
 * Every continuation is followed (collectionRows; an absolute link goes through the client's same-origin `getAbsolute`). A
 * refusal, a missing `value`, a malformed continuation or an entry without a numeric type and a GUID throws
 * WEB_RESOURCE_DEPENDENTS_UNREADABLE — never a shorter list. Entries are deduplicated by (type, id).
 * These are only the dependencies the platform tracks: a script that loads another by a computed or relative path is not one.
 */
function readWebResourceDependents(client) {
  return async (id) => {
    const guid = normalizeGuid(id);
    if (!guid) throw readError('WEB_RESOURCE_DEPENDENTS_UNREADABLE', 'the web resource id is not a GUID');
    const rows = await collectionRows(client, `/RetrieveDependentComponents(ObjectId=@p1,ComponentType=@p2)?@p1=${guid}&@p2=${WEB_RESOURCE_COMPONENT_TYPE}`, 'web resource dependents', { code: 'WEB_RESOURCE_DEPENDENTS_UNREADABLE' });
    const seen = new Map();
    for (const r of rows) {
      const type = r && r.dependentcomponenttype;
      const objectId = normalizeGuid(r && r.dependentcomponentobjectid);
      if (!Number.isInteger(type) || !objectId) throw readError('WEB_RESOURCE_DEPENDENTS_UNREADABLE', 'a dependent entry has no component type or id');
      seen.set(`${type}:${objectId}`, { componentType: type, objectId });
    }
    return [...seen.values()];
  };
}

/** Validate a reader's answer: an array of { componentType: integer, objectId: GUID }, deduplicated. null when it is anything else. */
function normalizedDependents(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Map();
  for (const d of list) {
    const type = d && d.componentType;
    const objectId = normalizeGuid(d && d.objectId);
    if (!Number.isInteger(type) || !objectId) return null;
    seen.set(`${type}:${objectId}`, { componentType: type, objectId });
  }
  return [...seen.values()];
}

function disclosure(list) {
  const byComponentType = {};
  for (const d of list) byComponentType[d.componentType] = (byComponentType[d.componentType] || 0) + 1;
  return {
    count: list.length,
    byComponentType,
    note: 'platform-reported direct dependents only; a script loaded by a computed or relative path is not listed',
  };
}

/**
 * Plan one declared web resource. Reads only (GET); never writes.
 * @param {{ webResource: object, options: object|null, reads: ReturnType<typeof webResourceReads>,
 *           readDependents?: (id: string) => Promise<Array<{componentType: number, objectId: string}>>,
 *           recordedId?: string }} input
 *   options    — webResourceOpts(wr, appDir), or null when the spec's source could not be read;
 *   recordedId — the id this build's receipt store holds for the name (unconfirmed publication), if any.
 */
async function planWebResourceUpdate({ webResource, options, reads, readDependents, recordedId }, ctx = {}) {
  const key = lc(webResource && webResource.name);
  const plan = { key, name: webResource ? String(webResource.name) : '', id: null, action: null, operations: [], refused: [], unknown: [], dependents: undefined, receipt: null };
  const refuse = (code, message) => { plan.refused.push(refusal(key, code, message)); return plan; };
  const unknown = (code, message) => { plan.unknown.push(refusal(key, code, message)); return plan; };
  if (!webResource || !isDeclaredWebResource(webResource)) return refuse('web-resource-spec-invalid', 'the web resource is not declared for reconciliation');
  if (webResource.external === true) return refuse('web-resource-external', 'an external web resource is shared and is never written by a build');
  if (!options) return unknown('web-resource-source-unreadable', 'the spec\'s content could not be read, so it was not compared');
  if (!reads) return unknown('web-resource-lookup-unreadable', 'the web resource could not be read, so nothing was compared');
  const wantType = WEB_RESOURCE_TYPE_CODE[options.type];

  const binding = await lookupBinding(ctx, KIND, key);
  const receipt = recordedId ? normalizeGuid(recordedId) : '';
  if (recordedId && !receipt) return refuse('web-resource-identity-conflict', 'the build\'s record of an unconfirmed publication names no valid row; resolve the local recovery record before rebuilding');
  if (binding && receipt && normalizeGuid(binding.id) !== receipt) {
    return refuse('web-resource-binding-mismatch', 'the build\'s record of an unconfirmed publication names a different row than the one this key is bound to; repair the binding or the record explicitly');
  }
  // Identity before name: the binding, then the receipt. A missing anchored row is never followed by a fresh-name create.
  const anchor = binding ? normalizeGuid(binding.id) : receipt;
  if (anchor) {
    const saved = await reads.saved(anchor);
    if (saved.state === 'unreadable') return unknown('web-resource-identity-unreadable', 'the web resource this key names could not be read, so nothing was compared or written');
    if (saved.state === 'absent') {
      return refuse('web-resource-bound-row-missing', 'the web resource this key is bound to (or this build last wrote) was not found; it is not created again under the same key — repair the binding or the record explicitly');
    }
    if (lc(saved.name) !== key) return refuse('web-resource-identity-conflict', 'the row this key names now has another name; it is not overwritten or adopted');
    if (wantType !== undefined && saved.type !== wantType) return refuse('web-resource-type-mismatch', 'the row this key names has another web-resource type; a declared resource manages content, not its type');
    plan.id = anchor;
  } else {
    const found = await reads.byName(webResource.name);
    if (found.state !== 'ok') return unknown('web-resource-lookup-unreadable', 'the web resource lookup by name could not be read completely, so nothing was created or written');
    if (found.rows.length > 1) return refuse('web-resource-name-ambiguous', 'more than one web resource answers this name; nothing is chosen');
    if (!found.rows.length) {
      plan.action = 'create';
      plan.options = options;
      plan.desiredSha = bytesSha(wantedBytes(options));
      plan.operations.push(operation({ key, kind: KIND, target: null, action: 'create' }));
      return plan;
    }
    const row = found.rows[0];
    if (wantType !== undefined && row.type !== wantType) return refuse('web-resource-type-mismatch', 'the web resource of this name has another type; a declared resource manages content, not its type');
    plan.id = row.id;
  }
  plan.receipt = receipt || null;
  plan.options = options;

  // Disclosure first: a row this spec does not manage yet — equal bytes, an approved adoption and a recovered receipt row
  // included — is never bound or written before its dependents are read completely.
  if (!binding) {
    let list = null;
    if (typeof readDependents === 'function') {
      try { list = normalizedDependents(await readDependents(plan.id)); } catch { list = null; }
    }
    if (!list) {
      plan.dependents = null;
      return unknown('web-resource-dependents-unreadable', 'what else uses this web resource could not be read completely, so it is not adopted, bound or written');
    }
    plan.dependents = disclosure(list);
  }

  const wanted = wantedBytes(options);
  plan.desiredSha = bytesSha(wanted);
  const published = await reads.published(plan.id);
  let live = null;
  if (published.state === 'present') live = Buffer.from(published.content, 'base64');
  else if (!plan.receipt) return unknown('web-resource-content-unreadable', 'the web resource\'s published content could not be read, so it was not compared');
  // A receipt row may have no published layer yet (a create whose publication failed): its bytes are simply not known.
  const liveSha = live ? bytesSha(live) : null;
  plan.approvalFacts = { id: plan.id, publishedSha256: liveSha, desiredSha256: plan.desiredSha, dependents: plan.dependents };
  plan.origin = binding ? binding.origin : 'adopted';
  const adoptionApproved = isAuthorized(ctx.authorizedAdoption, key);
  if (!binding && !adoptionApproved && !(live && live.equals(wanted) && !plan.receipt)) {
    return refuse('web-resource-adoption-not-authorized', 'the web resource exists and is not yet managed by this spec; approve adopting it (see its dependents) first');
  }
  if (wanted.length === 0 && (!live || live.length > 0) && !isAuthorized(ctx.authorizedDestructive, key)) {
    return refuse('web-resource-clear-not-authorized', 'the spec empties a web resource that has content; approve clearing it first');
  }
  if (plan.receipt) {
    // The receipt is this build's own unconfirmed write: it is written again by id whatever one published read shows.
    plan.action = 'rewrite';
    plan.operations.push(operation({ key, kind: KIND, target: plan.id, action: 'rewrite', destructive: true }));
    return plan;
  }
  if (live.equals(wanted)) {
    plan.action = 'noChange';
    // Equal bytes bind only an existing binding or an approved adoption — after the disclosure above.
    plan.bindUnchanged = !!binding || adoptionApproved;
    plan.operations.push(operation({ key, kind: KIND, target: plan.id, action: 'noChange' }));
    return plan;
  }
  if (binding && driftVerdict(binding, liveSha, plan.desiredSha) === 'drift' && !isAuthorized(ctx.authorizedOverwrite, key)) {
    return refuse('web-resource-drift', 'the web resource\'s content was changed outside the spec; refresh the spec or approve the overwrite');
  }
  plan.action = 'update';
  plan.operations.push(operation({ key, kind: KIND, target: plan.id, action: 'update', destructive: true }));
  return plan;
}

/** Note an unconfirmed write in the receipt store; true only when the store says it is on disk. */
function noteReceipt(ctx, name, id) {
  if (!ctx.unconfirmed || typeof ctx.unconfirmed.note !== 'function' || !normalizeGuid(id)) return false;
  try { return ctx.unconfirmed.note(name, normalizeGuid(id)) === true; } catch { return false; }
}

function unconfirmedOutcome(result, ctx, plan, id) {
  const entry = { ...refusal(plan.key, 'web-resource-publication-unconfirmed', 'the content was written but its publication was not confirmed; a run again writes it by id'), id: normalizeGuid(id) || null, possiblyPublished: true };
  result.unknown.push(entry);
  if (!noteReceipt(ctx, plan.name, id)) {
    result.unknown.push(refusal(plan.key, 'web-resource-recovery-record-failed', 'the build could not record the unconfirmed write, so the next run cannot write it again by id; write it again by id once the cause is resolved'));
  }
}

/**
 * Apply a web-resource plan. A plan with a refusal or an unknown writes nothing. The binding in `managedBindings` is a
 * proposal: the build records it only after the row's solution membership is settled (and clears a recovered receipt
 * only after that, through settleWebResourceReceipt).
 */
async function applyWebResourceUpdate(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  const record = (id, origin) => bindingRecord(ctx, { kind: KIND, key: plan.key, id, intentSha256: plan.desiredSha, origin });
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id: plan.id, managed: plan.bindUnchanged === true });
    if (plan.bindUnchanged) result.managedBindings.push(record(plan.id, plan.origin));
    return result;
  }
  if (plan.action === 'create') return applyCreate(plan, sdk, ctx, result, record);
  try {
    await sdk.updateWebResource(plan.id, contentOf(plan.options));
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : '';
    if (code === 'WEB_RESOURCE_UNVERIFIED') unconfirmedOutcome(result, ctx, plan, err.id || plan.id);
    else if (PRE_WRITE_CODES.has(code)) result.refused.push({ ...refusal(plan.key, 'web-resource-rejected', 'the SDK refused the content before anything was sent'), rules: rulesOf(err) });
    else result.unknown.push({ ...refusal(plan.key, 'web-resource-write-unknown', 'the web resource write did not report its outcome; check it'), id: plan.id, possiblyPublished: true });
    return result;
  }
  result.saved.push({ key: plan.key, kind: KIND, id: plan.id, published: true, ...(plan.receipt ? { clearsReceipt: true } : {}) });
  result.managedBindings.push(record(plan.id, plan.origin));
  return result;
}

async function applyCreate(plan, sdk, ctx, result, record) {
  let serverId = '';
  let unverifiedId = '';
  const out = await runManagedCreate(ctx, { kind: KIND, key: plan.key, identity: { name: plan.key, uniqueName: true }, childKeys: [] }, async () => {
    // No caller id: the SDK cannot send one for a web resource, and an id the port allocated is never used for it.
    try {
      const created = await sdk.createWebResource({ ...plan.options });
      serverId = normalizeGuid(created && created.id);
      return serverId ? { outcome: 'saved', code: '', sdkResult: created } : { outcome: 'unknown', code: 'WEB_RESOURCE_ID_MISSING' };
    } catch (err) {
      const code = err && typeof err.code === 'string' ? err.code : '';
      if (code === 'WEB_RESOURCE_UNVERIFIED') {
        unverifiedId = normalizeGuid(err.id);
        return { outcome: 'unknown', code };
      }
      if (PRE_WRITE_CODES.has(code)) return { outcome: 'refused', code, rules: rulesOf(err) };
      return { outcome: 'unknown', code: /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'WRITE_OUTCOME_UNKNOWN' };
    }
  });
  if (unverifiedId) {
    unconfirmedOutcome(result, ctx, plan, unverifiedId);
    return result;
  }
  if (out.status === 'created' && serverId) {
    result.saved.push({ key: plan.key, kind: KIND, id: serverId, created: true, published: true });
    result.managedBindings.push(record(serverId, 'created'));
    return result;
  }
  if (out.status === 'refused' && !serverId) {
    result.refused.push({ ...refusal(plan.key, 'web-resource-rejected', 'the web resource was refused before it was created'), ...(out.rules ? { rules: out.rules } : {}) });
    return result;
  }
  // The SDK may have created and published the row while the port's answer failed or disagreed: possibly written and live.
  result.unknown.push({ ...refusal(plan.key, serverId ? 'creation-settlement-disagreed' : 'web-resource-write-unknown', 'the web resource create did not settle; it may exist and be published — the next run finds it by name and asks before adopting it'), id: serverId || null, possiblyPublished: true });
  return result;
}

/**
 * After the build settled a web resource (solution membership added, binding recorded), clear the receipt the write
 * recovered. The store clears only the entry revision this run read, so a newer receipt another build noted survives.
 */
function settleWebResourceReceipt(ctx, plan, result) {
  const recovered = (result.saved || []).some((s) => s.clearsReceipt === true);
  if (!recovered || (result.refused || []).length || (result.unknown || []).length) return false;
  if (!ctx.unconfirmed || typeof ctx.unconfirmed.clear !== 'function') return false;
  ctx.unconfirmed.clear(plan.name);
  return true;
}

module.exports = {
  KIND,
  WEB_RESOURCE_COMPONENT_TYPE,
  isDeclaredWebResource,
  webResourceReads,
  readWebResourceDependents,
  planWebResourceUpdate,
  applyWebResourceUpdate,
  settleWebResourceReceipt,
};

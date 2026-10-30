'use strict';
// Declared reconciliation for an existing web resource (`webResources[].reconcile: "declared"`).
//
// Without the opt-in, a web resource that exists by name is reused untouched: the build compares its
// deployed content with the spec's and only SAYS when they differ (sdk-build's web-resources phase).
// With it, differing content is written — through the SDK's `updateWebResource`, which publishes the
// row and reads the published content back, byte for byte — and identical content writes nothing
// and publishes nothing.
//
// What stays the build's: finding the row by name, the content bytes (webResourceOpts: inline
// `content` as UTF-8, `contentBase64` as given, or `contentPath` read safely from the app folder),
// and the unconfirmed-publication recovery (lib/web-resource-records.js). When the SDK cannot
// confirm the publication it throws WEB_RESOURCE_UNVERIFIED with the row id AFTER writing:
//   { code: 'WEB_RESOURCE_UNVERIFIED', id: '<guid>', message: "... was written, but publishing it failed ..." }
// That is an unknown outcome, never a refusal or a save; the row is handed to `ctx.unconfirmed.note`
// (the same record the build keeps) so the next run writes it again by id.
//
// An `external` web resource is shared and never the spec's to write, so declared mode is refused
// for it outright. A shared row the spec has not managed before needs adoption approval; the plan
// carries the row's dependent components (type and count only, from `readDependents`) so the
// approval can say what else uses it.

const {
  sha256,
} = require('./hash.js');
const {
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  driftVerdict,
  bindsUnchanged,
  normalizeGuid,
  PRE_WRITE_CODES,
  rulesOf,
} = require('./reconcile-common.js');

const KIND = 'web-resource';
const lc = (s) => String(s == null ? '' : s).toLowerCase();

function isDeclaredWebResource(wr) {
  return !!wr && wr.reconcile === 'declared';
}

/** The bytes the SDK sends for `options` (webResourceOpts output) — the comparison sdk-build's webResourceContentState makes. */
function wantedBytes(options) {
  return options.contentBase64 !== undefined ? Buffer.from(String(options.contentBase64), 'base64') : Buffer.from(String(options.content == null ? '' : options.content), 'utf8');
}
const contentOf = (options) => (options.contentBase64 !== undefined ? { contentBase64: options.contentBase64 } : { content: options.content });
const bytesSha = (buf) => sha256(buf.toString('base64'));

/**
 * Plan one declared web resource the build found by name. GET only (plus `readDependents`, when
 * given, for a row this spec does not manage yet).
 * @param {{ webResource: object, existingId: string, deployed: string|undefined, options: object|null,
 *           readDependents?: (id: string) => Promise<Array<{ componentType: number }>> }} input
 *   deployed — the base64 `content` the build's name read answered (the published layer);
 *   options  — webResourceOpts(wr, appDir), or null when the spec's source could not be read.
 */
async function planWebResourceUpdate({ webResource, existingId, deployed, options, readDependents }, ctx = {}) {
  const key = lc(webResource && webResource.name);
  const plan = { key, name: webResource ? webResource.name : '', id: normalizeGuid(existingId), action: null, operations: [], refused: [], unknown: [] };
  if (!webResource || webResource.external === true) {
    plan.refused.push(refusal(key, 'web-resource-external', 'an external web resource is shared and is never written by a build'));
    return plan;
  }
  if (!plan.id) {
    plan.refused.push(refusal(key, 'web-resource-spec-invalid', 'the web resource was not resolved to a row'));
    return plan;
  }
  if (!options) {
    plan.unknown.push(refusal(key, 'web-resource-source-unreadable', 'the spec\'s content could not be read, so it was not compared'));
    return plan;
  }
  if (typeof deployed !== 'string') {
    plan.unknown.push(refusal(key, 'web-resource-content-unreadable', 'the environment answered no content, so it was not compared'));
    return plan;
  }
  const wanted = wantedBytes(options);
  const live = Buffer.from(deployed, 'base64');
  plan.options = options;
  plan.desiredSha = bytesSha(wanted);
  const binding = await lookupBinding(ctx, KIND, key);
  plan.origin = binding ? binding.origin : 'adopted';
  if (live.equals(wanted)) {
    plan.action = 'noChange';
    plan.bindUnchanged = bindsUnchanged(binding, ctx, key);
    plan.operations.push(operation({ key, kind: KIND, target: plan.id, action: 'noChange' }));
    return plan;
  }
  const verdict = driftVerdict(binding, bytesSha(live), plan.desiredSha);
  if (verdict === 'drift' && !isAuthorized(ctx.authorizedOverwrite, key)) {
    plan.refused.push(refusal(key, 'web-resource-drift', 'the web resource\'s content was changed outside the spec; refresh the spec or approve the overwrite'));
    return plan;
  }
  if (verdict === 'unbound') {
    if (typeof readDependents === 'function') {
      try {
        const deps = await readDependents(plan.id);
        const byType = {};
        for (const d of deps || []) byType[d.componentType] = (byType[d.componentType] || 0) + 1;
        plan.dependents = { count: (deps || []).length, byComponentType: byType };
      } catch {
        plan.dependents = null;
      }
    }
    if (!isAuthorized(ctx.authorizedAdoption, key)) {
      plan.refused.push(refusal(key, 'web-resource-adoption-not-authorized', 'the web resource exists and is not yet managed by this spec; approve adopting it (see its dependents) first'));
      return plan;
    }
  }
  plan.action = 'update';
  // updateWebResource publishes the row itself, so the publication scope is the write's own.
  plan.operations.push(operation({ key, kind: KIND, target: plan.id, action: 'update', destructive: true, publicationScopes: [{ type: KIND, id: plan.id }] }));
  return plan;
}

/** Apply a web-resource plan. A plan with a refusal or an unknown writes nothing. */
async function applyWebResourceUpdate(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  const record = () => bindingRecord(ctx, { kind: KIND, key: plan.key, id: plan.id, intentSha256: plan.desiredSha, origin: plan.origin });
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id: plan.id });
    if (plan.bindUnchanged) result.managedBindings.push(record());
    return result;
  }
  try {
    await sdk.updateWebResource(plan.id, contentOf(plan.options));
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : '';
    if (code === 'WEB_RESOURCE_UNVERIFIED') {
      // Written, publication unconfirmed: keep the build's recovery record so the next run writes
      // it again by id. Not saved (the published content is unproven), not refused (it was written).
      if (ctx.unconfirmed && typeof ctx.unconfirmed.note === 'function') ctx.unconfirmed.note(plan.name, plan.id);
      result.unknown.push({ ...refusal(plan.key, 'web-resource-publication-unconfirmed', 'the content was written but its publication was not confirmed; a run again writes it by id'), id: plan.id });
    } else if (PRE_WRITE_CODES.has(code)) {
      result.refused.push({ ...refusal(plan.key, 'web-resource-rejected', 'the SDK refused the content before anything was sent'), rules: rulesOf(err) });
    } else {
      result.unknown.push(refusal(plan.key, 'web-resource-write-unknown', 'the web resource write did not report its outcome; check it'));
    }
    return result;
  }
  result.saved.push({ key: plan.key, kind: KIND, id: plan.id, published: true });
  result.managedBindings.push(record());
  return result;
}

/** The binding the build records after it creates a declared web resource. */
function createdWebResourceBinding(webResource, id, options, ctx = {}) {
  return bindingRecord(ctx, { kind: KIND, key: lc(webResource.name), id: normalizeGuid(id), intentSha256: bytesSha(wantedBytes(options)), origin: 'created' });
}

module.exports = {
  isDeclaredWebResource,
  planWebResourceUpdate,
  applyWebResourceUpdate,
  createdWebResourceBinding,
};

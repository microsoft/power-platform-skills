'use strict';
// A read-only preview of an artifact push: what pushing each prepared artifact would do, and what would stop it,
// without writing anything — `build-model-app.js --preview-push` on a dry run.
//
// Why a separate, isolated preparation. The bundled SDK's `previewPush(type, id)` answers for an artifact that is in
// ITS workspace with the local edits that would be pushed. The build's own workspace holds the maker's real sync state,
// so previewing there would either preview edits nobody asked about (its dirty list is shared) or leave edits behind
// that a later push would send. So this module makes a throwaway workspace (lib/throwaway-sdk.js), fetches each named
// artifact FRESH into it, applies the prepared typed edits locally (`updateElement`/`addElement`/`removeElement`/
// `moveElement`, or `createArtifact` for one the build would create), and previews exactly that set. Nothing is
// persisted beyond the throwaway folder, which is removed whichever way the run ends.
//
// What it does NOT do:
//   - run the build to prepare: preparing an artifact must not cost a build;
//   - preview a schema create (a table, column or relationship): the artifact preview cannot represent one, so such an
//     item is reported `requiresSchema` and keeps the dry run's own create/reuse answer;
//   - promise anything. `ready` means the push's own pre-write checks passed NOW; the platform's validation of the
//     payload and everything after the first write are not predicted, another writer can move the row a second later,
//     and a `noChange` artifact is still written by an actual push (the SDK supports a no-edit push). It is neither an
//     approval nor a lock.
//
// Transport: every SDK this module makes is given lib/readonly-operations.js's read-only client, so a write attempt —
// a defect of the SDK or of this module — is refused before it is sent and shows up as `writeAttempts > 0`.
//
// Cost: GETs proportional to the prepared artifacts, their dependencies and (with `layers`) one layer read per written
// component. A build without `--preview-push` makes none of them. `gets` counts the GET calls the SDK made through the
// read-only client: a GET the transport retried (a throttle or a transient failure) counts once, so it is the number of
// reads asked for, not the number of HTTP round trips.
//
// Coverage: a plan item with no typed artifact to name, or whose live state the dry run could not read (a schema item
// included), and a prepared artifact a batch preview gave no answer for (`notInBatch`: the batch previews only
// artifacts with local edits), is reported in `notEvaluated` with its reason — never dropped — and `allEvaluated` is
// false while one remains. Failures are reported
// as codes, HTTP statuses and fixed words only (lib/readonly-operations.js findingOf): a service's or the SDK's own
// message can quote a record value.

const fs = require('node:fs');
const { makeTempWorkspace } = require('./temp-workspace.js');
const { GUID_RE, READ_ONLY_WRITE_REFUSED, readOnlyHttpClient, findingOf, publicError, checkClosedObject, isNonEmptyString } = require('./readonly-operations.js');

// The artifact types the SDK's push (and therefore its preview) covers. `genPage` is left out on purpose: a page's
// local copy is made by the page backend (lib/genpage-sdk.js), not by pointer edits, so a prepared page edit here
// would not be the edit the build sends.
const PREVIEW_TYPES = Object.freeze([
  'form', 'view', 'businessRule', 'app', 'command', 'chart', 'dashboard', 'bpf',
  'environmentVariable', 'connectionReference', 'fieldSecurityProfile', 'customApi', 'duplicateRule',
]);
const ITEM_KEYS = ['key', 'type', 'id', 'create', 'edits', 'requiresSchema', 'notEvaluated'];
// Why a plan item is carried as not evaluated instead of previewed: the caller had no typed artifact to name for it
// (`noTypedTarget`), or the dry run could not read its live state (`livePlanUnknown`). It is reported, never dropped:
// a preview that silently left an item out would read as covering it. (A result's `notEvaluated` may also say
// `notInBatch`, which the preview itself finds — see previewPreparedArtifacts; it is not an input reason.)
const NOT_EVALUATED_REASONS = Object.freeze(['noTypedTarget', 'livePlanUnknown']);
// The SDK names a command bar by its table's logical name (`fetchArtifact('command', 'account')`), not by a row GUID:
// the bar is assembled from the table's appaction rows. A Dataverse logical name is lower case, starts with a letter
// and holds letters, digits and underscores (https://learn.microsoft.com/en-us/power-apps/developer/data-platform/entity-metadata).
const COMMAND_ID_RE = /^[a-z][a-z0-9_]{0,127}$/;
const EDIT_OPS = Object.freeze({
  update: ['op', 'pointer', 'value'],
  add: ['op', 'pointer', 'element', 'options'],
  remove: ['op', 'pointer'],
  move: ['op', 'from', 'to', 'options'],
});
const DISCLAIMER = 'A preview reads only. "ready" means the push\'s own checks passed now; it does not approve, lock or guarantee the write, and a "noChange" artifact is still written by an actual push.';

/**
 * Validates prepared items (closed keys, unique keys, canonical GUIDs, known edit ops) before anything is read.
 * @param {unknown} items
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validatePreviewItems(items) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(items)) return { errors: ['preview items must be an array'], warnings };
  const seen = new Set();
  items.forEach((item, i) => {
    const where = `items[${i}]`;
    if (!checkClosedObject(item, ITEM_KEYS, where, errors)) return;
    if (!isNonEmptyString(item.key)) errors.push(`${where}.key must be a non-empty string`);
    else if (seen.has(item.key)) errors.push(`${where}.key "${item.key}" is used twice`);
    else seen.add(item.key);
    if (item.notEvaluated !== undefined) {
      // A key and a reason only: nothing about the item is read or previewed, so nothing else may be given.
      if (!NOT_EVALUATED_REASONS.includes(item.notEvaluated)) errors.push(`${where}.notEvaluated must be one of: ${NOT_EVALUATED_REASONS.join(', ')}`);
      for (const k of ['type', 'id', 'create', 'edits', 'requiresSchema']) if (item[k] !== undefined) errors.push(`${where}.${k} cannot be combined with notEvaluated`);
      return;
    }
    if (item.requiresSchema === true) {
      // A schema step keeps its dry-run answer; nothing else about it is previewed, so nothing else may be given.
      for (const k of ['id', 'create', 'edits']) if (item[k] !== undefined) errors.push(`${where}.${k} cannot be combined with requiresSchema`);
      return;
    }
    if (item.requiresSchema !== undefined && item.requiresSchema !== false) errors.push(`${where}.requiresSchema must be a boolean`);
    if (!PREVIEW_TYPES.includes(item.type)) errors.push(`${where}.type must be one of: ${PREVIEW_TYPES.join(', ')}`);
    const hasId = item.id !== undefined;
    const hasCreate = item.create !== undefined;
    if (hasId === hasCreate) errors.push(`${where} needs exactly one of id (an existing artifact) or create (a definition the build would create)`);
    if (hasId && item.type === 'command') {
      if (!(typeof item.id === 'string' && COMMAND_ID_RE.test(item.id))) errors.push(`${where}.id must be the table logical name of a command bar`);
    } else if (hasId && !(typeof item.id === 'string' && GUID_RE.test(item.id))) errors.push(`${where}.id must be a canonical GUID`);
    if (hasCreate && (!item.create || typeof item.create !== 'object' || Array.isArray(item.create))) errors.push(`${where}.create must be an object`);
    if (item.edits !== undefined) {
      if (!Array.isArray(item.edits)) errors.push(`${where}.edits must be an array`);
      else item.edits.forEach((edit, j) => validateEdit(edit, `${where}.edits[${j}]`, errors));
    }
    if (hasCreate && Array.isArray(item.edits) && item.edits.length) warnings.push(`${where}: edits are applied after the local create`);
  });
  return { errors, warnings };
}

function validateEdit(edit, where, errors) {
  if (!edit || typeof edit !== 'object' || !Object.prototype.hasOwnProperty.call(EDIT_OPS, edit.op)) {
    errors.push(`${where}.op must be one of: ${Object.keys(EDIT_OPS).join(', ')}`);
    return;
  }
  checkClosedObject(edit, EDIT_OPS[edit.op], where, errors);
  const pointers = edit.op === 'move' ? ['from', 'to'] : ['pointer'];
  for (const p of pointers) {
    // JSON Pointer (RFC 6901): '' is the whole document, anything else starts with '/'. A whole-document replace is
    // refused: it would discard the server's bags (fetchBag/layoutBag) the SDK keeps to write the row back faithfully.
    if (typeof edit[p] !== 'string' || !edit[p].startsWith('/')) errors.push(`${where}.${p} must be a JSON Pointer starting with '/'`);
  }
  if (edit.op === 'update' && !Object.prototype.hasOwnProperty.call(edit, 'value')) errors.push(`${where}.value is required`);
  if (edit.op === 'add' && !Object.prototype.hasOwnProperty.call(edit, 'element')) errors.push(`${where}.element is required`);
}

/**
 * Fetches each item fresh into an isolated throwaway workspace and applies its edits locally, through a read-only
 * transport. Returns a handle for previewPreparedArtifacts; call `dispose()` when done (runPushPreview does).
 * @param {object} options
 * @param {string} options.env - Dataverse https origin
 * @param {object} options.httpClient - the SDK HttpClient (wrapped read-only here)
 * @param {Array<object>} options.items - see validatePreviewItems
 * @param {string} [options.solutionUniqueName] - the build's solution, so the preview reports membership/layers against it
 * @param {number} [options.languageCode]
 * @param {object} [options.deps] - test seam: { makerSdk: { createMakerSdk, createNodeWorkspaceStorage } }
 */
async function preparePushPreview({ env, httpClient, items, solutionUniqueName, languageCode, deps = {} }) {
  const { errors } = validatePreviewItems(items);
  if (errors.length) {
    // The errors name item positions, fields and the allowed values — the maker's own input — so they may be printed.
    throw Object.assign(publicError('PREVIEW_ITEMS_INVALID', `push preview: ${errors.join('; ')}`), { errors });
  }
  const ro = readOnlyHttpClient(httpClient);
  const workspaceDir = makeTempWorkspace('push-preview-');
  const handle = {
    prepared: [],
    notPrepared: [],
    requiresSchema: [],
    notEvaluated: [],
    stats: ro.stats,
    sdk: null,
    disposed: false,
    dispose() {
      if (handle.disposed) return;
      handle.disposed = true;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* a leftover throwaway folder is swept by the next run (lib/temp-workspace.js) */ }
    },
  };
  try {
    const { createMakerSdk, createNodeWorkspaceStorage } = deps.makerSdk || require('./maker-sdk.js');
    handle.sdk = createMakerSdk({
      workspaceStorage: createNodeWorkspaceStorage(workspaceDir),
      instanceUrl: env,
      httpClient: ro.client,
      ...(solutionUniqueName ? { solutionUniqueName } : {}),
      ...(languageCode ? { languageCode } : {}),
    });
    // A fresh workspace must be initialised before a fetch lands in it. It reads nothing remote that writes.
    await handle.sdk.initWorkspace();
    for (const item of items) {
      if (item.notEvaluated !== undefined) {
        handle.notEvaluated.push({ key: item.key, reason: item.notEvaluated });
        continue;
      }
      if (item.requiresSchema === true) {
        handle.requiresSchema.push({ key: item.key });
        continue;
      }
      try {
        let id = item.id;
        if (id) {
          await handle.sdk.fetchArtifact(item.type, id);
        } else {
          const created = await handle.sdk.createArtifact(item.type, item.create);
          id = created && created.id;
          if (!id) throw publicError('PREVIEW_CREATE_NO_ID', 'the local create returned no id');
        }
        for (const edit of item.edits || []) await applyEdit(handle.sdk, item.type, id, edit);
        handle.prepared.push({ key: item.key, type: item.type, id: String(id), create: !item.id });
      } catch (err) {
        // A fetch that fails (a deleted row, no read right) or an edit the SDK refuses is a finding about THIS item —
        // never a reason to call the others ready or to stop: they are still previewed.
        handle.notPrepared.push({ key: item.key, type: item.type, ...(item.id ? { id: item.id } : {}), ...findingOf(err, 'PREVIEW_PREPARE_FAILED') });
      }
    }
    return handle;
  } catch (err) {
    handle.dispose();
    throw err;
  }
}

async function applyEdit(sdk, type, id, edit) {
  switch (edit.op) {
    case 'update': return await sdk.updateElement(type, id, edit.pointer, edit.value);
    case 'add': return await sdk.addElement(type, id, edit.pointer, edit.element, edit.options);
    case 'remove': return await sdk.removeElement(type, id, edit.pointer);
    case 'move': return await sdk.moveElement(type, id, edit.from, edit.to, edit.options);
    default: throw publicError('PREVIEW_ITEMS_INVALID', 'unknown edit op');
  }
}

/**
 * Previews the prepared set. `mode: 'each'` (default) previews every prepared artifact, `noChange` ones included;
 * `mode: 'batch'` runs `previewPushAll` — only the dirty ones, with the batch's page-dependency judgment; every prepared
 * artifact it gave no answer for is returned in `notEvaluated` as `notInBatch` — and is
 * refused when the isolated workspace's dirty list holds anything this module did not prepare (it never may: that
 * would be a preview of the shared workspace, which this module never makes).
 * @param {object} handle - from preparePushPreview
 * @param {{ layers?: boolean, mode?: 'each'|'batch' }} [options]
 */
async function previewPreparedArtifacts(handle, { layers = true, mode = 'each' } = {}) {
  if (!handle || !handle.sdk || handle.disposed) throw publicError('PREVIEW_NOT_PREPARED', 'push preview: the prepared workspace is gone');
  const byKey = new Map(handle.prepared.map((p) => [`${p.type}|${String(p.id).toLowerCase()}`, p]));
  const previews = [];
  const notEvaluated = [];
  let sharedRequests = 0;
  if (mode === 'batch') {
    const dirty = await handle.sdk.getDirtyArtifacts();
    const foreign = dirty.filter((d) => !byKey.has(`${d.type}|${String(d.id).toLowerCase()}`));
    if (foreign.length) throw publicError('PREVIEW_WORKSPACE_NOT_ISOLATED', `push preview: the isolated workspace holds ${foreign.length} artifact(s) this preview did not prepare`);
    const all = await handle.sdk.previewPushAll({ layers });
    sharedRequests = all.sharedRequests || 0;
    const answered = new Set();
    for (const p of all.previews) {
      const id = `${p.type}|${String(p.id).toLowerCase()}`;
      answered.add(id);
      previews.push(projectPreview(byKey.get(id), p));
    }
    // The batch previews only DIRTY artifacts, so a prepared artifact with no local edit gets no answer from it — yet
    // an actual push still writes it (and runs its concurrency and pre-write checks). It is reported, never counted
    // as covered.
    for (const prepared of handle.prepared) {
      if (!answered.has(`${prepared.type}|${String(prepared.id).toLowerCase()}`)) notEvaluated.push({ key: prepared.key, reason: 'notInBatch' });
    }
  } else {
    for (const prepared of handle.prepared) {
      try {
        previews.push(projectPreview(prepared, await handle.sdk.previewPush(prepared.type, prepared.id, { layers })));
      } catch (err) {
        // A thrown preview is a DEFECT (the SDK's `PREVIEW_WRITE_REFUSED`/`PREVIEW_PLAN_INCOMPLETE`) or a refusal the
        // push itself throws before preparing. Either way this artifact is not settled: `unknown`, never `ready`.
        previews.push({ key: prepared.key, type: prepared.type, id: prepared.id, action: prepared.create ? 'create' : 'unknown', outcome: 'unknown', refusals: [], warnings: [], notEvaluated: ['preview'], error: findingOf(err, 'PREVIEW_FAILED') });
      }
    }
  }
  return { previews, sharedRequests, notEvaluated };
}

// The SDK's PushPreview, projected to what a maker reads: no local-change VALUES (a pointer and its kind only — a
// filter value or a script body is the maker's data), no tokens (concurrency is its verdict and the guards it compared),
// and a refusal or warning as its code only: the SDK's message can quote the service's text or a value it refused, and
// no scrubbing of free text can be trusted to take every value out (the same rule as findingOf).
function projectPreview(prepared, p) {
  const out = {
    key: prepared ? prepared.key : undefined,
    type: p.type,
    id: p.id,
    action: p.action,
    outcome: p.outcome,
    refusals: (p.refusals || []).map((f) => ({ code: f.code, ...(Array.isArray(f.issues) ? { issues: f.issues.length } : {}) })),
    warnings: (p.warnings || []).map((f) => ({ code: f.code })),
    notEvaluated: [...(p.notEvaluated || [])],
    localChanges: (p.localChanges || []).map((c) => ({ pointer: c.pointer, type: c.type })),
    concurrency: {
      verdict: p.concurrency ? p.concurrency.verdict : 'notEvaluated',
      guards: ((p.concurrency && p.concurrency.observations) || []).map((o) => ({ guard: o.guard, componentName: o.componentName, status: o.status })),
      ...(p.concurrency && Array.isArray(p.concurrency.remoteChanges) ? { remoteChanges: p.concurrency.remoteChanges.map((c) => ({ pointer: c.pointer, type: c.type })) } : {}),
    },
    components: (p.components || []).map((c) => ({
      componentName: c.componentName,
      ...(c.componentId ? { componentId: c.componentId } : {}),
      operation: c.operation,
      layers: layersOf(c.layers),
      ...(typeof c.joinsSolution === 'boolean' ? { joinsSolution: c.joinsSolution } : {}),
    })),
    ...(p.solution ? { solution: { uniqueName: p.solution.uniqueName, status: p.solution.status, appliesToPush: p.solution.appliesToPush } } : {}),
    publication: { byPush: !!(p.publish && p.publish.byPush), ...(p.publish && p.publish.scope ? { scope: p.publish.scope } : {}) },
    requests: p.requests,
  };
  // The SDK says it in its type docs; a maker reading `noChange` must hear it too.
  if (p.action === 'noChange' && p.type !== 'genPage') out.note = 'no local edits, but an actual push still writes this artifact';
  return out;
}

function layersOf(layers) {
  if (!layers) return { status: 'notRead', reason: 'failed' };
  if (layers.status === 'read') {
    return {
      status: 'read',
      hasManagedLayers: !!layers.hasManagedLayers,
      // Top first. `Active` is the unmanaged layer.
      solutions: (layers.layers || []).map((l) => l.solutionName),
    };
  }
  if (layers.status === 'empty') return { status: 'empty' };
  return { status: 'notRead', reason: layers.reason };
}

/** Counts by outcome, plus the items that were not previewed and why. */
function summarizePreview({ previews, notPrepared, requiresSchema, notEvaluated = [] }) {
  const counts = { ready: 0, refused: 0, unknown: 0, requiresSchema: requiresSchema.length, notPrepared: notPrepared.length, notEvaluated: notEvaluated.length };
  for (const p of previews) counts[p.outcome] = (counts[p.outcome] || 0) + 1;
  return counts;
}

/**
 * Prepare, preview and dispose in one call. `ok` is false when any write was attempted (a defect: the result must not
 * be read as a preview) — never because an item was refused or unknown, which are the answers a preview exists to give.
 * `allEvaluated` is true only when every item was answered: none is `notEvaluated` (no typed target, a live state
 * the dry run could not read, or a prepared artifact a batch preview did not answer), none `notPrepared`, no preview
 * `unknown`, and nothing was written. A schema step keeps
 * the dry run's answer and does not make it false.
 */
async function runPushPreview(options) {
  const handle = await preparePushPreview(options);
  try {
    const { previews, sharedRequests, notEvaluated: unanswered } = await previewPreparedArtifacts(handle, { layers: options.layers !== false, mode: options.mode || 'each' });
    const writeAttempts = handle.stats.refusedWrites;
    const notEvaluated = [...handle.notEvaluated, ...unanswered];
    const result = {
      ok: writeAttempts === 0,
      previews,
      notPrepared: handle.notPrepared,
      requiresSchema: handle.requiresSchema.map((r) => ({ ...r, note: 'a schema step: the artifact preview cannot represent it; the dry run\'s create/reuse answer stands' })),
      notEvaluated,
      allEvaluated: writeAttempts === 0 && notEvaluated.length === 0 && handle.notPrepared.length === 0 && previews.every((p) => p.outcome !== 'unknown'),
      summary: summarizePreview({ previews, notPrepared: handle.notPrepared, requiresSchema: handle.requiresSchema, notEvaluated }),
      gets: handle.stats.gets,
      sharedRequests,
      writeAttempts,
      disclaimer: DISCLAIMER,
    };
    if (writeAttempts) result.error = { code: READ_ONLY_WRITE_REFUSED, message: `${writeAttempts} write request(s) were attempted and refused before sending; this preview is not trustworthy`, refused: handle.stats.refused };
    return result;
  } finally {
    handle.dispose();
  }
}

/**
 * Maps dry-run plan items (lib/sdk-build.js annotateLivePlan output: `{ key: { kind, ... }, state }`) to preview items.
 * `resolve(item)` is the caller's — the build knows the artifact ids and the definitions it would send — and returns
 * `{ type, id, edits }`, `{ type, create }`, or null when it has no typed artifact to name. Every item whose live
 * state the dry run could not read (or did not read) — a schema item included — becomes
 * `{ key, notEvaluated: 'livePlanUnknown' }` and is not resolved. Of the rest, schema kinds become `requiresSchema` on
 * a create without asking `resolve` (a KNOWN schema reuse has nothing to preview: the one item left out), and one
 * `resolve` returns null for — or a plan entry with no kind — becomes `{ key, notEvaluated: 'noTypedTarget' }`, so the
 * preview reports it as not evaluated instead of reading as if it covered it. A command bar's `id` is its table's
 * logical name.
 */
function previewItemsFromPlan(planItems, resolve) {
  const SCHEMA_KINDS = new Set(['table', 'column', 'relationship', 'choice', 'globalChoice', 'key']);
  const out = [];
  let n = 0;
  for (const item of planItems || []) {
    const k = item && item.key;
    if (!k || !k.kind) {
      // A plan entry that names no kind cannot be mapped to any artifact; it is still reported, never dropped.
      out.push({ key: `item:${n++}`, notEvaluated: 'noTypedTarget' });
      continue;
    }
    const key = `${k.kind}:${k.entity || ''}:${k.name || n++}`;
    // An unknown (or unread) live state comes first, schema kinds included: only a KNOWN create or reuse can be
    // answered by the dry run, so an unreadable relationship must not fall into the "schema reuse, nothing to
    // preview" case below and vanish.
    if (item.state !== 'create' && item.state !== 'reuse') {
      out.push({ key, notEvaluated: 'livePlanUnknown' });
      continue;
    }
    if (SCHEMA_KINDS.has(k.kind)) {
      if (item.state === 'create') out.push({ key, requiresSchema: true });
      continue;
    }
    const resolved = typeof resolve === 'function' ? resolve(item) : null;
    if (!resolved) {
      out.push({ key, notEvaluated: 'noTypedTarget' });
      continue;
    }
    out.push({ ...resolved, key: resolved.key || key });
  }
  return out;
}

module.exports = {
  PREVIEW_TYPES,
  DISCLAIMER,
  validatePreviewItems,
  preparePushPreview,
  previewPreparedArtifacts,
  runPushPreview,
  summarizePreview,
  previewItemsFromPlan,
};

'use strict';
/**
 * The durable receipt of default (non-protected) configuration creates (#807).
 *
 * WHY. A default build used to create environment variable definitions and values, connection references, Custom APIs with their
 * request parameters and response properties, and duplicate detection rules with their conditions as SDK deep inserts with fresh random
 * ids. An answer lost after the service committed the row left nothing behind: the next build minted another id and created a second
 * row, or carried on past an outcome nobody knew. The closed writer now sends each row as one flat POST at a stable id, and BEFORE it
 * sends anything it saves this receipt in the build workspace: the whole affected root, every preserved child and every new row, each
 * with its public projection and its dispatch state. A build that finds an unfinished unit here stops; recovery only reads the service
 * (lib/configuration-create-recovery.js) and changes nothing but this file.
 *
 * WHAT IS SAVED. `<workspaceDir>/configuration-create-state.v1.json`, one file per workspace:
 *   { schema: 1, environmentFingerprint, solutionUniqueName, appUniqueName, authoringLanguageCode, epoch, revision, units: [
 *       { unitId, attemptId, state: 'open'|'deferred', root: { kind, key, id }, publicIntentSha256, publicPlanSha256,
 *         rows: [{ kind, key, id, parentId, role: 'preserved'|'create', dispatch, public: { <closed scalar fields> }, privateFields }],
 *         publication: null | { dispatch: 'prepared'|'dispatched'|'acknowledged' },
 *         offer: null | { mode, nonceSha256, observedPublicSha256, publicIntentSha256, privateAcknowledgmentRequired } } ] }
 * written as `JSON.stringify(<fixed key order>, null, 2) + '\n'`. A file that is not byte-for-byte that form (a hand edit, a duplicate
 * JSON key, a truncation) is unverifiable and refused, never repaired. No private input (a default value, a value schema, a current
 * value, a secret reference, a connection id) or any hash of one is ever written: `privateFields` names the kind's fixed private
 * columns, nothing more, and the state is copied field by field from what the caller hands in, so a property this module does not know
 * never reaches the disk.
 *
 * Beside it, the explicit way forward from an unreadable receipt (`quarantineUnreadableReceipt`):
 *   configuration-create-state.quarantine.<quarantineId>.json   a tombstone: { schema: 1, quarantineId, state: 'archiving'|'deferred',
 *                                                               dispatch: 'unknown', scope: 'workspace-configuration', archive }
 *   configuration-create-state.unreadable.<quarantineId>.bin    the original bytes, moved aside, never parsed or redacted
 * Any other `configuration-create-state.*` entry, an orphan archive, an `archiving` tombstone, an invalid one, or a tombstone whose
 * archive is not a plain file this user can read is blocking evidence. The archive and a fresh tombstone are installed with an atomic
 * no-replace (a hard link of a complete staged copy), so neither ever overwrites a file that took its name; removing the staged name
 * afterwards is a step of the quarantine, and a continuation finishes it when it was interrupted.
 *
 * FENCING. Every change runs synchronously under the record lease of the state file (lib/record-lease.js; no network I/O inside it),
 * re-reads the file, applies one change, writes it atomically (lib/apply-snapshot-store.js writeFileAtomic) and reads it back. The
 * revision is the compare-and-set; the epoch and the unit's attempt fence a handle: only `prepareCreateUnit` mints a handle, in this
 * process, and a handle whose epoch, attempt or unit record (the unit exactly as the handle last saved it) no longer matches the disk
 * (another writer, a cancellation, a failed write) is refused and dead from then on. Every change clears every saved approval offer.
 *
 * EXPORTS (the interface for the writer and the recovery CLI):
 *   STATE_FILE, QUARANTINE_FILE_PREFIX, ARCHIVE_FILE_PREFIX     the fixed file names
 *   LIMITS                                                    { maxBytes: 16 MiB, maxUnits: 128, maxRows: 4096, maxDepth: 12 }
 *   ROW_KINDS, ROOT_KINDS, FIELD_TYPES                        the closed receipt tags and public field types
 *   CONFIGURATION_CREATE_STOP_CODES                           the 19 stop codes (frozen array)
 *   configurationCreateHalt(code, details?) -> Error          the one halt builder (see below)
 *   validateKindTable(kindTable)                              throws shape-refused for a table that is not the closed contract
 *   createStateContext({ environmentUrl, solutionUniqueName, appUniqueName, authoringLanguageCode }) -> context
 *   sameCreateStateContext(a, b) -> boolean
 *   parseCreateState(bytes, { kindTable? }) -> state           throws state-invalid; kindTable is required once units exist
 *   serializeCreateState(state) -> string
 *   discoverConfigurationCreateState(workspaceDir, { kindTable? }) -> discovery (see the function)
 *   readConfigurationCreateState(workspaceDir, { kindTable? }) -> state | null
 *   withCreateStateTransaction(workspaceDir, { kindTable?, leaseDeps?, transition? }, mutate) -> { state, changed }
 *   prepareCreateUnit(workspaceDir, { kindTable, context, unit, leaseDeps? }) -> handle { unitId, attemptId }
 *   sealCreateRow(handle, rowId), markCreateRowVerified(handle, rowId)
 *   sealNewRulePublication(handle), markNewRulePublicationAcknowledged(handle), completeCreateUnit(handle)
 *   isLiveCreateHandle(handle) -> boolean
 *   prepareResolutionOffer(workspaceDir, { kindTable, context, unitId, mode, observedPublicSha256?, expectedRevision, leaseDeps? })
 *     -> { token, revision, privateAcknowledgmentRequired }
 *   resolveResolutionOffer(workspaceDir, { kindTable, context, unitId, mode, token, observedPublicSha256?, acceptCurrentPrivateState?,
 *     leaseDeps? }) -> { state, removed, deferred }
 *   discoverConfigurationQuarantines(workspaceDir) -> { root, quarantines, orphanArchives }
 *   quarantineUnreadableReceipt(workspaceDir, { kindTable?, acknowledgeUnknownDispatch, quarantineId?, invalidate?, leaseDeps? })
 *     -> { quarantineId, halt }   (halt = the `configuration-create-reconciled` halt, returned, not thrown)
 *   assertConfigurationCreateWorkspaceClearable(workspaceDir, { kindTable? })   throws workspace-in-use
 *
 * THE HALT. `configurationCreateHalt(code, { unitId, rootId, rootKind, reason, nextStep, transition, dispatched })` answers an Error
 * whose `code` is one of the 19 codes, with `retry: 'never'` and `transient: false` (lib/retry-policy.js: a run again cannot change
 * it), and only safe fields: canonical GUID unit/root ids, a known kind tag, and bounded text. `reason` and `nextStep` must be
 * code-controlled sentences; never pass a server body, a raw error message or any private input.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256 } = require('./hash.js');
const { writeFileAtomic, invalidateSnapshot } = require('./apply-snapshot-store.js');
const { withRecordLease } = require('./record-lease.js');
const { environmentFingerprint, workspaceRoot } = require('./page-ownership-records.js');
const { assertPlainFileTarget, unlinkWithRetry } = require('./safe-fs.js');
const { GUID_RE } = require('./creates-identity.js');
const { RETRY } = require('./retry-policy.js');

const STATE_FILE = 'configuration-create-state.v1.json';
const FILE_PREFIX = 'configuration-create-state.';
const QUARANTINE_FILE_PREFIX = 'configuration-create-state.quarantine.';
const ARCHIVE_FILE_PREFIX = 'configuration-create-state.unreadable.';
const LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxUnits: 128, maxRows: 4096, maxDepth: 12 });

// The receipt tags: new LOCAL tags, never passed to the stable-v1 identity functions (those keep their own kind strings).
const ROW_KINDS = Object.freeze(['env-definition', 'env-value', 'connection-reference', 'custom-api', 'api-request', 'api-response', 'duplicate-rule', 'rule-condition']);
const ROOT_KINDS = Object.freeze(['env-definition', 'connection-reference', 'custom-api', 'duplicate-rule']);
const FIELD_TYPES = Object.freeze(['string', 'nullable-string', 'integer', 'nullable-integer', 'boolean', 'guid', 'nullable-guid']);
const ROW_ROLES = Object.freeze(['preserved', 'create']);
const CREATE_DISPATCH = Object.freeze(['prepared', 'dispatched', 'verified']);
const PUBLICATION_DISPATCH = Object.freeze(['prepared', 'dispatched', 'acknowledged']);
const OFFER_MODES = Object.freeze(['accept-current', 'defer', 'cancel-unsent']);
const UNIT_STATES = Object.freeze(['open', 'deferred']);
const TRANSITIONS = Object.freeze(['prepare', 'seal', 'verify', 'publication-seal', 'publication-acknowledge', 'complete', 'offer', 'resolve', 'quarantine', 'transaction']);

// ── Stop codes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Defined ONCE here; the writer, the build guards and the recovery CLI raise them through configurationCreateHalt. Each carries the
// way forward an operator can take; "never" in `retry` means no blind automatic re-run of this invocation, not that no later build may run.
const STOPS = Object.freeze({
  'configuration-create-pending': {
    summary: 'an interrupted configuration create unit in this workspace is not resolved',
    next: 'Run configuration-recovery.js inspect for this app folder, then explicitly accept the current state, complete the recorded missing work at the recorded ids, or defer the unit. This invocation made no service writes.',
  },
  'configuration-create-publication-pending': {
    summary: 'the publication of a newly created duplicate detection rule was not proved',
    next: 'Inspect with configuration-recovery.js (it only reads). Accept the current state if the whole rule is complete and published, wait for an action still in flight, publish it yourself outside recovery, or defer the unit. Nothing is published again automatically.',
  },
  'configuration-create-reconciled': {
    summary: 'the local configuration create state was resolved',
    next: 'Start a fresh build; this is not a successful build. A quarantine stays fenced: omit configuration, or explicitly acknowledge its possible resend for that later build.',
  },
  'configuration-create-mixed-edit': {
    summary: 'configuration additions are mixed with edits, removals or lifecycle changes of existing configuration, or rows are appended to a published duplicate detection rule',
    next: 'Split the change into two builds with the additions first, or unpublish the rule, add the rows and publish it again.',
  },
  'configuration-create-intent-changed': {
    summary: 'the current declaration does not describe the configuration create attempt that was recorded',
    next: 'Inspect the recorded attempt; restore its declaration to resolve it, or defer it. Its recorded ids and projections are not replaced.',
  },
  'configuration-create-context-mismatch': {
    summary: 'the environment, solution, app or authoring language differs from the one the configuration create state was recorded for',
    next: 'Resolve or defer the recorded units with the recorded environment, solution, app and language first. Do not copy or reset the state file to bypass this.',
  },
  'configuration-create-shape-refused': {
    summary: 'this configuration create is not a supported shape, or it does not fit in the saved state',
    next: 'Correct or split the declaration, or use a plugin version that supports it. Nothing falls back to another create path.',
  },
  'configuration-create-graph-unreadable': {
    summary: 'the recorded configuration could not be read completely',
    next: 'Restore read permission or service availability, then inspect again. Nothing was changed and nothing is assumed absent.',
  },
  'configuration-create-identity-conflict': {
    summary: 'a row at a recorded id has another identity or parent than recorded, or a row of the same name exists at another id',
    next: 'Inspect and keep the conflicting row; resolve it outside the plugin or defer the unit. Nothing is relinked, adopted or deleted automatically.',
  },
  'configuration-create-content-conflict': {
    summary: 'the current content of the recorded configuration differs from the recorded projection',
    next: 'Keep the conflicting work; arrange an explicitly authorized change outside recovery, or defer the unit. Recovery never updates a row.',
  },
  'configuration-create-row-missing': {
    summary: 'a recorded configuration row is absent',
    next: 'For a row this plugin was creating, complete it explicitly with a create at the same recorded id, or defer the unit. For a row that existed before, resolve the conflict or defer; it is never recreated automatically.',
  },
  'configuration-create-membership-incomplete': {
    summary: 'the solution membership of a recorded configuration component could not be proved',
    next: 'Restore read access to the membership, or add the recorded component to the solution through normal solution management, then inspect again; otherwise defer the unit.',
  },
  'configuration-create-private-review-required': {
    summary: 'the public state matches, but the private values (defaults, current values, secret references, connections) cannot be proved',
    next: 'Review the current private values in the environment and resolve again with --accept-current-private-state, or defer the unit. A settings file alone is not proof.',
  },
  'configuration-create-approval-stale': {
    summary: 'the approval no longer matches the saved state, the observation or the request',
    next: 'Inspect and prepare again. No service write occurred.',
  },
  'configuration-create-state-invalid': {
    summary: 'the saved configuration create state is missing a counterpart, malformed, an unsupported version, or could not be verified',
    next: 'Keep the file and correct access to it; restore a trustworthy copy if one exists. If none exists, run configuration-recovery.js resolve --resolution quarantine-unreadable --acknowledge-unknown-dispatch to keep its bytes beside an unknown-dispatch marker. Never delete it as a reset; teardown is blocked too.',
  },
  'configuration-create-state-busy': {
    summary: 'another build or recovery may be changing the configuration create state of this workspace',
    next: 'Wait for the other build or recovery of this workspace to finish, then re-run the same command. If none is running, inspect the lock named above and remove it only if it is abandoned; keep the receipt, the archive and the tombstone. Removing the lock neither cancels server work nor authorizes a resend.',
  },
  'configuration-create-persistence-uncertain': {
    summary: 'a configuration create state change could not be saved and verified',
    next: 'Stop. When storage is healthy, inspect the saved state. An earlier saved state is not promised to remain.',
  },
  'configuration-create-quarantined': {
    summary: 'this workspace holds a quarantine of configuration create state whose dispatch is unknown',
    next: 'Build without configuration changes for unrelated work, or run a separate build with --acknowledge-quarantined-configuration naming every quarantine id, accepting that it may resend creates at the same stable ids. Keep the archive and the marker.',
  },
  'configuration-create-workspace-in-use': {
    summary: 'this workspace holds configuration create evidence that teardown and clearing must not erase',
    next: 'Resolve readable units first, or keep or archive this workspace while you handle lost evidence separately. A quarantine is never permission to erase evidence or to tear down.',
  },
});
const CONFIGURATION_CREATE_STOP_CODES = Object.freeze(Object.keys(STOPS));

const TEXT_LIMIT = 600;
const bounded = (s) => (s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT - 3)}...` : s);
const isCanonicalGuid = (v) => typeof v === 'string' && GUID_RE.test(v) && v === v.toLowerCase();
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The one halt builder. See the module header for the fields; unknown codes throw a TypeError (a programming error, not a halt).
 */
function configurationCreateHalt(code, details = {}) {
  const entry = has(STOPS, code) ? STOPS[code] : null;
  if (!entry) throw new TypeError('configurationCreateHalt: unknown stop code');
  const d = isPlainObject(details) ? details : {};
  const unitId = isCanonicalGuid(d.unitId) ? d.unitId : null;
  const rootId = isCanonicalGuid(d.rootId) ? d.rootId : null;
  const rootKind = ROW_KINDS.includes(d.rootKind) ? d.rootKind : null;
  const reason = typeof d.reason === 'string' && d.reason.trim() ? bounded(d.reason.trim()) : null;
  const nextStep = typeof d.nextStep === 'string' && d.nextStep.trim() ? bounded(d.nextStep.trim()) : entry.next;
  const transition = TRANSITIONS.includes(d.transition) ? d.transition : null;
  const dispatched = typeof d.dispatched === 'boolean' ? d.dispatched : null;
  const where = [unitId ? `unit ${unitId}` : null, rootKind, rootId ? `root ${rootId}` : null].filter(Boolean).join(', ');
  let dispatchNote = '';
  if (dispatched === true) dispatchNote = ' This invocation dispatched a create before this stop; its outcome is not known.';
  else if (dispatched === false) dispatchNote = ' This invocation did not dispatch the create this step was preparing.';
  const message = `${code}: ${entry.summary}${where ? ` (${where})` : ''}${reason ? `: ${reason}` : ''}.${dispatchNote} Next step: ${nextStep}`;
  const error = new Error(message);
  error.name = 'ConfigurationCreateHalt';
  error.code = code;
  error.retry = RETRY.NEVER;
  error.transient = false;
  error.unitId = unitId;
  error.rootId = rootId;
  error.rootKind = rootKind;
  error.reason = reason;
  error.nextStep = nextStep;
  if (transition) error.transition = transition;
  if (dispatched !== null) error.dispatched = dispatched;
  return error;
}
const halt = configurationCreateHalt;
const invalidState = (reason, extra = {}) => halt('configuration-create-state-invalid', { reason, ...extra });

// ── The injected kind table ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The plan module owns the closed field maps; this module only holds every receipt row to them. Checked once per table object.
const checkedTables = new WeakSet();
function validateKindTable(kindTable) {
  const refuse = (reason) => { throw halt('configuration-create-shape-refused', { reason: `the configuration kind table ${reason}` }); };
  if (!isPlainObject(kindTable)) refuse('is missing');
  if (checkedTables.has(kindTable)) return kindTable;
  const keys = Object.keys(kindTable);
  if (keys.length !== ROW_KINDS.length || !ROW_KINDS.every((k) => has(kindTable, k))) refuse('does not hold exactly the eight receipt kinds');
  for (const kind of ROW_KINDS) {
    const e = kindTable[kind];
    if (!isPlainObject(e)) refuse(`entry ${kind} is not an object`);
    const ek = Object.keys(e).sort();
    if (ek.join(',') !== 'parentKinds,privateFields,publicFields,root') refuse(`entry ${kind} does not have exactly root, parentKinds, publicFields and privateFields`);
    if (e.root !== ROOT_KINDS.includes(kind)) refuse(`entry ${kind} has the wrong root flag`);
    if (!Array.isArray(e.parentKinds) || !e.parentKinds.every((p) => ROOT_KINDS.includes(p) && p !== kind) || new Set(e.parentKinds).size !== e.parentKinds.length) refuse(`entry ${kind} has invalid parent kinds`);
    if (e.root ? e.parentKinds.length !== 0 : e.parentKinds.length === 0) refuse(`entry ${kind} has parent kinds that do not match its root flag`);
    if (!isPlainObject(e.publicFields) || Object.keys(e.publicFields).length === 0) refuse(`entry ${kind} has no public fields`);
    for (const [name, type] of Object.entries(e.publicFields)) {
      if (!name || !FIELD_TYPES.includes(type)) refuse(`entry ${kind} has a public field with an unknown type`);
    }
    if (!Array.isArray(e.privateFields) || !e.privateFields.every((p) => typeof p === 'string' && p) || new Set(e.privateFields).size !== e.privateFields.length) refuse(`entry ${kind} has invalid private fields`);
    if (e.privateFields.some((p) => has(e.publicFields, p))) refuse(`entry ${kind} lists a field as both public and private`);
  }
  checkedTables.add(kindTable);
  return kindTable;
}

function fieldValueValid(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'nullable-string': return v === null || typeof v === 'string';
    case 'integer': return Number.isSafeInteger(v);
    case 'nullable-integer': return v === null || Number.isSafeInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'guid': return isCanonicalGuid(v);
    case 'nullable-guid': return v === null || isCanonicalGuid(v);
    default: return false;
  }
}

// A public projection, checked against its kind's closed field map and copied in sorted key order (ordinary object order never
// changes the bytes). Throws `fail(reason)` naming only KNOWN field names: an unknown key may itself be anything, so it is never echoed.
function copyPublic(kind, pub, kindTable, fail) {
  const fields = kindTable[kind].publicFields;
  if (!isPlainObject(pub)) throw fail(`the public projection of a ${kind} row is not an object`);
  for (const k of Object.keys(pub)) if (!has(fields, k)) throw fail(`the public projection of a ${kind} row has an unknown field`);
  const out = {};
  for (const name of Object.keys(fields).sort()) {
    if (!has(pub, name)) throw fail(`the public projection of a ${kind} row lacks ${name}`);
    if (!fieldValueValid(fields[name], pub[name])) throw fail(`the public projection of a ${kind} row has an invalid ${name}`);
    out[name] = pub[name];
  }
  return out;
}

// ── Context ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The recorded context of a workspace's creates. The environment is kept only as the origin fingerprint page ownership uses. */
function createStateContext({ environmentUrl, solutionUniqueName, appUniqueName, authoringLanguageCode = null } = {}) {
  let fingerprint;
  try { fingerprint = environmentFingerprint(environmentUrl); } catch {
    throw halt('configuration-create-shape-refused', { reason: 'the environment is not an HTTPS origin without credentials' });
  }
  const context = { environmentFingerprint: fingerprint, solutionUniqueName, appUniqueName, authoringLanguageCode };
  checkContext(context, (reason) => halt('configuration-create-shape-refused', { reason }));
  return Object.freeze(context);
}
function checkContext(c, fail) {
  if (!isPlainObject(c)) throw fail('the configuration create context is missing');
  if (!isSha(c.environmentFingerprint)) throw fail('the environment fingerprint is not a SHA-256');
  if (typeof c.solutionUniqueName !== 'string' || !c.solutionUniqueName.trim()) throw fail('the solution unique name is missing');
  if (typeof c.appUniqueName !== 'string' || !c.appUniqueName.trim()) throw fail('the app unique name is missing');
  if (!(c.authoringLanguageCode === null || Number.isSafeInteger(c.authoringLanguageCode))) throw fail('the authoring language code is not an integer or null');
}
// Dataverse unique names compare without regard to case; the fingerprint and the language code are exact.
function sameCreateStateContext(a, b) {
  return !!a && !!b && a.environmentFingerprint === b.environmentFingerprint
    && String(a.solutionUniqueName).toLowerCase() === String(b.solutionUniqueName).toLowerCase()
    && String(a.appUniqueName).toLowerCase() === String(b.appUniqueName).toLowerCase()
    && (a.authoringLanguageCode === undefined ? null : a.authoringLanguageCode) === (b.authoringLanguageCode === undefined ? null : b.authoringLanguageCode);
}

// ── Strict parse and canonical serialization ─────────────────────────────────────────────────────────────────────────────────────────
// True when `v` nests objects or arrays deeper than `limit`. Iterative and stops at the first value past the limit: a 16 MiB file of
// valid JSON can nest millions of levels (`[[[[...]]]]`), and a recursive walk of that throws an untyped RangeError (stack overflow)
// instead of the typed state-invalid verdict that lets the operator quarantine the file.
function nestsDeeperThan(v, limit) {
  const stack = [[v, 0]];
  while (stack.length > 0) {
    const [x, depth] = stack.pop();
    if (x === null || typeof x !== 'object') continue;
    if (depth + 1 > limit) return true;
    for (const child of Array.isArray(x) ? x : Object.values(x)) if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
  }
  return false;
}
function exactKeys(o, keys) {
  if (!isPlainObject(o)) return false;
  const got = Object.keys(o);
  return got.length === keys.length && keys.every((k) => has(o, k));
}
function finiteNumbersOnly(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v === null || typeof v !== 'object') return true;
  return (Array.isArray(v) ? v : Object.values(v)).every(finiteNumbersOnly);
}

const STATE_KEYS = ['schema', 'environmentFingerprint', 'solutionUniqueName', 'appUniqueName', 'authoringLanguageCode', 'epoch', 'revision', 'units'];
const UNIT_KEYS = ['unitId', 'attemptId', 'state', 'root', 'publicIntentSha256', 'publicPlanSha256', 'rows', 'publication', 'offer'];
const ROW_KEYS = ['kind', 'key', 'id', 'parentId', 'role', 'dispatch', 'public', 'privateFields'];
const OFFER_KEYS = ['mode', 'nonceSha256', 'observedPublicSha256', 'publicIntentSha256', 'privateAcknowledgmentRequired'];
const QUARANTINE_KEYS = ['schema', 'quarantineId', 'state', 'dispatch', 'scope', 'archive'];

const isSensitive = (rows) => rows.some((r) => r.privateFields.length > 0);
const wholePrepared = (unit) => unit.rows.every((r) => r.role !== 'create' || r.dispatch === 'prepared')
  && (!unit.publication || unit.publication.dispatch === 'prepared');

// Checks one row and answers a fresh copy holding only the known fields. `fail(reason)` builds the error to throw.
function copyRow(raw, kindTable, fail, { input = false } = {}) {
  const keys = input ? ROW_KEYS.filter((k) => k !== 'dispatch') : ROW_KEYS;
  if (!exactKeys(raw, keys)) throw fail('a row does not have exactly the receipt row fields');
  if (!ROW_KINDS.includes(raw.kind)) throw fail('a row has an unknown kind');
  const kind = raw.kind;
  if (typeof raw.key !== 'string' || !raw.key) throw fail(`a ${kind} row has no key`);
  if (!isCanonicalGuid(raw.id)) throw fail(`a ${kind} row id is not a canonical GUID`);
  if (!(raw.parentId === null || isCanonicalGuid(raw.parentId))) throw fail(`a ${kind} row parent id is not a canonical GUID`);
  if (!ROW_ROLES.includes(raw.role)) throw fail(`a ${kind} row has an unknown role`);
  let dispatch;
  if (input) dispatch = raw.role === 'create' ? 'prepared' : 'not-applicable';
  else {
    dispatch = raw.dispatch;
    if (raw.role === 'preserved' ? dispatch !== 'not-applicable' : !CREATE_DISPATCH.includes(dispatch)) throw fail(`a ${kind} row has a dispatch state its role does not allow`);
  }
  const expectedPrivate = kindTable[kind].privateFields;
  if (!Array.isArray(raw.privateFields) || raw.privateFields.length !== expectedPrivate.length || !expectedPrivate.every((p, i) => raw.privateFields[i] === p)) {
    throw fail(`a ${kind} row does not carry its kind's fixed private field list`);
  }
  return {
    kind,
    key: raw.key,
    id: raw.id,
    parentId: raw.parentId,
    role: raw.role,
    dispatch,
    public: copyPublic(kind, raw.public, kindTable, fail),
    privateFields: expectedPrivate.slice(),
  };
}

// The parentage of one unit's rows: exactly one root row, the unit's root, with no parent; every other row's parent is a row of the
// same unit of a kind its own kind allows.
function checkUnitRows(unit, kindTable, fail) {
  const byId = new Map();
  const keys = new Set();
  for (const r of unit.rows) {
    if (byId.has(r.id)) throw fail('a unit has duplicate row ids');
    byId.set(r.id, r);
    const k = `${r.kind}\u0000${r.parentId || ''}\u0000${r.key}`;
    if (keys.has(k)) throw fail('a unit has duplicate row keys');
    keys.add(k);
  }
  const roots = unit.rows.filter((r) => kindTable[r.kind].root);
  if (roots.length !== 1) throw fail('a unit does not have exactly one root row');
  const root = roots[0];
  if (root.kind !== unit.root.kind || root.key !== unit.root.key || root.id !== unit.root.id || root.parentId !== null) throw fail('a unit root row does not match its root');
  for (const r of unit.rows) {
    if (r === root) continue;
    const parent = r.parentId === null ? null : byId.get(r.parentId);
    if (!parent || !kindTable[r.kind].parentKinds.includes(parent.kind)) throw fail(`a ${r.kind} row has invalid parentage`);
  }
  if (!unit.rows.some((r) => r.role === 'create')) throw fail('a unit has no create row');
  if (unit.publication) {
    if (unit.root.kind !== 'duplicate-rule' || root.role !== 'create') throw fail('a publication slot belongs only to a newly created duplicate rule');
    if (unit.publication.dispatch !== 'prepared' && !unit.rows.every((r) => r.role !== 'create' || r.dispatch === 'verified')) {
      throw fail('a publication was dispatched before every create row was verified');
    }
  }
}

function copyOffer(raw, unit, fail) {
  if (raw === null) return null;
  if (!exactKeys(raw, OFFER_KEYS)) throw fail('an offer does not have exactly the offer fields');
  if (!OFFER_MODES.includes(raw.mode)) throw fail('an offer has an unknown mode');
  if (!isSha(raw.nonceSha256) || !isSha(raw.publicIntentSha256)) throw fail('an offer hash is not a SHA-256');
  if (raw.publicIntentSha256 !== unit.publicIntentSha256) throw fail('an offer does not match its unit intent');
  if (raw.mode === 'accept-current' ? !isSha(raw.observedPublicSha256) : raw.observedPublicSha256 !== null) throw fail('an offer observation hash does not fit its mode');
  if (typeof raw.privateAcknowledgmentRequired !== 'boolean') throw fail('an offer private acknowledgment flag is not a boolean');
  if (raw.privateAcknowledgmentRequired !== (raw.mode === 'accept-current' && isSensitive(unit.rows))) throw fail('an offer private acknowledgment flag does not fit its unit');
  if (raw.mode === 'cancel-unsent' && !wholePrepared(unit)) throw fail('a cancel offer belongs to a unit that is not wholly prepared');
  if (raw.mode === 'defer' && unit.state !== 'open') throw fail('a defer offer belongs to a unit that is already deferred');
  return { mode: raw.mode, nonceSha256: raw.nonceSha256, observedPublicSha256: raw.observedPublicSha256, publicIntentSha256: raw.publicIntentSha256, privateAcknowledgmentRequired: raw.privateAcknowledgmentRequired };
}

function copyUnit(raw, kindTable, fail) {
  if (!exactKeys(raw, UNIT_KEYS)) throw fail('a unit does not have exactly the unit fields');
  if (!isCanonicalGuid(raw.unitId) || !isCanonicalGuid(raw.attemptId)) throw fail('a unit id or attempt id is not a canonical GUID');
  if (!UNIT_STATES.includes(raw.state)) throw fail('a unit has an unknown state');
  if (!exactKeys(raw.root, ['kind', 'key', 'id']) || !ROOT_KINDS.includes(raw.root.kind) || typeof raw.root.key !== 'string' || !raw.root.key || !isCanonicalGuid(raw.root.id)) {
    throw fail('a unit root is not a root kind, key and canonical id');
  }
  if (!isSha(raw.publicIntentSha256) || !isSha(raw.publicPlanSha256)) throw fail('a unit hash is not a SHA-256');
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) throw fail('a unit has no rows');
  let publication = null;
  if (raw.publication !== null) {
    if (!exactKeys(raw.publication, ['dispatch']) || !PUBLICATION_DISPATCH.includes(raw.publication.dispatch)) throw fail('a unit publication slot is invalid');
    publication = { dispatch: raw.publication.dispatch };
  }
  const unit = {
    unitId: raw.unitId,
    attemptId: raw.attemptId,
    state: raw.state,
    root: { kind: raw.root.kind, key: raw.root.key, id: raw.root.id },
    publicIntentSha256: raw.publicIntentSha256,
    publicPlanSha256: raw.publicPlanSha256,
    rows: raw.rows.map((r) => copyRow(r, kindTable, fail)),
    publication,
    offer: null,
  };
  checkUnitRows(unit, kindTable, fail);
  unit.offer = copyOffer(raw.offer, unit, fail);
  return unit;
}

// Checks a whole state object and answers a copy in canonical form. Shared by the parser and by every transaction's result.
function copyState(raw, kindTable, fail) {
  if (!isPlainObject(raw) || !has(raw, 'schema')) throw fail('the saved state has no schema version');
  if (raw.schema !== 1) throw fail('the saved state has an unsupported schema version');
  if (!exactKeys(raw, STATE_KEYS)) throw fail('the saved state does not have exactly the state fields');
  checkContext(raw, fail);
  if (!isCanonicalGuid(raw.epoch)) throw fail('the saved state epoch is not a canonical GUID');
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) throw fail('the saved state revision is not a nonnegative integer');
  if (!Array.isArray(raw.units)) throw fail('the saved state units are not a list');
  if (raw.units.length > LIMITS.maxUnits) throw fail('the saved state holds more units than the limit');
  if (raw.units.length > 0) {
    // A caller that reads units must supply the plan's table. Without it the units cannot be judged either way: that is a wiring error
    // of the caller, not a verdict that the file is unreadable (which would invite quarantining a valid receipt).
    if (!kindTable) throw halt('configuration-create-shape-refused', { reason: 'no configuration kind table was supplied to read the saved units' });
    validateKindTable(kindTable);
  }
  const units = raw.units.map((u) => copyUnit(u, kindTable, fail));
  let rows = 0;
  const unitIds = new Set();
  const rowIds = new Set();
  const roots = new Set();
  for (const u of units) {
    if (unitIds.has(u.unitId)) throw fail('the saved state has duplicate unit ids');
    unitIds.add(u.unitId);
    for (const k of [`k\u0000${u.root.kind}\u0000${u.root.key}`, `i\u0000${u.root.id}`]) {
      if (roots.has(k)) throw fail('the saved state has duplicate active roots');
      roots.add(k);
    }
    for (const r of u.rows) {
      if (rowIds.has(r.id)) throw fail('the saved state has duplicate row ids');
      rowIds.add(r.id);
    }
    rows += u.rows.length;
  }
  if (rows > LIMITS.maxRows) throw fail('the saved state holds more rows than the limit');
  return {
    schema: 1,
    environmentFingerprint: raw.environmentFingerprint,
    solutionUniqueName: raw.solutionUniqueName,
    appUniqueName: raw.appUniqueName,
    authoringLanguageCode: raw.authoringLanguageCode,
    epoch: raw.epoch,
    revision: raw.revision,
    units,
  };
}

function serializeCreateState(state) { return `${JSON.stringify(state, null, 2)}\n`; }

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Parses raw JSON bytes into a checked value: size before anything, then strict UTF-8, JSON, depth and finite numbers.
function parseJsonStrict(bytes, fail) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  if (buf.length > LIMITS.maxBytes) throw fail('the saved file is larger than 16 MiB');
  let text;
  try { text = UTF8.decode(buf); } catch { throw fail('the saved file is not UTF-8 text'); }
  let raw;
  try { raw = JSON.parse(text); } catch { throw fail('the saved file is not complete JSON'); }
  if (nestsDeeperThan(raw, LIMITS.maxDepth)) throw fail('the saved file nests deeper than the limit');
  // JSON has no NaN or Infinity, but a number literal too large for a double (1e400) parses to Infinity.
  if (!finiteNumbersOnly(raw)) throw fail('the saved file holds a number that is not finite');
  return { raw, buf };
}

/**
 * Parses the saved bytes of the state file. Throws `configuration-create-state-invalid` for anything that is not exactly what this
 * module writes. `kindTable` is required when the state holds units.
 */
function parseCreateState(bytes, { kindTable } = {}) {
  const fail = (reason) => invalidState(reason);
  const { raw, buf } = parseJsonStrict(bytes, fail);
  const state = copyState(raw, kindTable, fail);
  if (!Buffer.from(serializeCreateState(state), 'utf8').equals(buf)) throw fail('the saved file is not in the exact form this plugin writes');
  return deepFreeze(state);
}

function parseQuarantine(bytes, expectedId) {
  const fail = (reason) => invalidState(reason);
  const { raw, buf } = parseJsonStrict(bytes, fail);
  if (!isPlainObject(raw) || raw.schema !== 1) throw fail('a quarantine marker has an unsupported schema version');
  if (!exactKeys(raw, QUARANTINE_KEYS)) throw fail('a quarantine marker does not have exactly the marker fields');
  if (!isCanonicalGuid(raw.quarantineId) || raw.quarantineId !== expectedId) throw fail('a quarantine marker id does not match its file name');
  if (!['archiving', 'deferred'].includes(raw.state) || raw.dispatch !== 'unknown' || raw.scope !== 'workspace-configuration') throw fail('a quarantine marker has an unknown state');
  if (raw.archive !== archiveName(expectedId)) throw fail('a quarantine marker names another archive');
  const q = quarantineRecord(raw.quarantineId, raw.state);
  if (!Buffer.from(serializeQuarantine(q), 'utf8').equals(buf)) throw fail('a quarantine marker is not in the exact form this plugin writes');
  return q;
}
const quarantineRecord = (quarantineId, state) => ({ schema: 1, quarantineId, state, dispatch: 'unknown', scope: 'workspace-configuration', archive: archiveName(quarantineId) });
const serializeQuarantine = (q) => `${JSON.stringify(q, null, 2)}\n`;
const quarantineName = (id) => `${QUARANTINE_FILE_PREFIX}${id}.json`;
const archiveName = (id) => `${ARCHIVE_FILE_PREFIX}${id}.bin`;

// ── Discovery ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The workspace folder, checked by the page-ownership helper (a link or junction at its name is refused). Absent answers null.
function rootOf(workspaceDir, create) {
  try {
    return workspaceRoot(workspaceDir, create);
  } catch {
    throw invalidState('the build workspace folder could not be used safely', { nextStep: 'Make the build workspace a plain folder this user can read and write, then run the command again.' });
  }
}

// Reads one evidence file. Absent answers null; a link, a folder or a file that cannot be read is NEVER "absent" (access denied must not
// read as missing): it answers { error }.
function readEvidence(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { error: 'could not be inspected' };
  }
  if (!st.isFile()) return { error: 'is not a plain file' };
  try { return { bytes: fs.readFileSync(file) }; } catch { return { error: 'could not be read' }; }
}

// The one check of a quarantine archive, shared by both discovery functions and every continuation: a name in the folder listing is
// not evidence. The archive counts only as a plain file (not a folder, link or junction) that this user can open and read; anything
// else, including an access error, is invalid, never absent. Discovery opens it and reads one byte (an archive is the bytes of a file
// of any size, so discovery does not read it all); a continuation that is about to write a marker for it passes `bytes` and reads it
// whole. Answers { status: 'absent' } | { status: 'invalid', reason } | { status: 'valid', bytes? }.
function inspectArchive(file, { bytes = false } = {}) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'absent' };
    return { status: 'invalid', reason: 'the quarantine archive could not be inspected' };
  }
  if (!st.isFile()) return { status: 'invalid', reason: 'the quarantine archive is not a plain file' };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (!fs.fstatSync(fd).isFile()) return { status: 'invalid', reason: 'the quarantine archive is not a plain file' };
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
  } catch {
    return { status: 'invalid', reason: 'the quarantine archive could not be read' };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* the check already has its answer */ }
  }
  if (!bytes) return { status: 'valid' };
  const got = readEvidence(file);
  if (!got || got.error) return { status: 'invalid', reason: 'the quarantine archive could not be read' };
  return { status: 'valid', bytes: got.bytes };
}

// The names this module and its leases leave beside the state file, which are not evidence of their own:
//   configuration-create-state.v1.json.lock            the record lease (lib/record-lease.js)
//   configuration-create-state.v1.json.lock.reclaim    a reclaim claim of that lease (apply-snapshot-store.js acquireLease)
//   <any state, marker or archive name>.<pid>.<time>.<random>.tmp   a temporary file of an atomic write, or the staged copy of a
//                                                                  quarantine file (releaseOwnStagedName); the target is authoritative
//   <marker name>.<pid>.<time>.<random>.tmp.<pid>.<time>.<random>.tmp   the temporary file of the staged copy of a fresh marker
const QUARANTINE_RE = /^configuration-create-state\.quarantine\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const ARCHIVE_RE = /^configuration-create-state\.unreadable\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.bin$/;
const LEASE_RE = /^configuration-create-state\.v1\.json\.lock(?:\.reclaim)?$/;
const TEMP_RE = /^configuration-create-state\.(?:v1\.json|quarantine\.[0-9a-f-]{36}\.json|unreadable\.[0-9a-f-]{36}\.bin)(?:\.\d+\.\d+\.[0-9a-z]*\.tmp){1,2}$/;

function listEvidence(root) {
  let names;
  try { names = fs.readdirSync(root); } catch {
    throw invalidState('the build workspace folder could not be listed', { nextStep: 'Restore read access to the build workspace folder, then run the command again.' });
  }
  return names.filter((n) => n.startsWith(FILE_PREFIX)).sort();
}

// The quarantine part of a listing, shared by both discovery functions: every marker parsed, every archive inspected.
function scanQuarantines(root, names) {
  const markers = new Set();
  const archives = new Set();
  for (const n of names) {
    let m = QUARANTINE_RE.exec(n);
    if (m) markers.add(m[1]);
    m = ARCHIVE_RE.exec(n);
    if (m) archives.add(m[1]);
  }
  const quarantines = [];
  for (const id of [...markers].sort()) {
    const got = readEvidence(path.join(root, quarantineName(id)));
    if (!got || got.error) {
      quarantines.push({ quarantineId: id, status: 'invalid', reason: `a quarantine marker ${got ? got.error : 'vanished while it was read'}` });
      continue;
    }
    try {
      const q = parseQuarantine(got.bytes, id);
      const archive = archives.has(id) && inspectArchive(path.join(root, archiveName(id))).status === 'valid';
      quarantines.push({ quarantineId: id, status: 'valid', state: q.state, archive });
    } catch (e) {
      if (!e || e.code !== 'configuration-create-state-invalid') throw e;
      quarantines.push({ quarantineId: id, status: 'invalid', reason: reasonOf(e) });
    }
  }
  // An orphan archive blocks whatever it is; a continuation inspects it before it writes a marker for it.
  return { quarantines, orphanArchives: [...archives].filter((id) => !markers.has(id)).sort() };
}

/**
 * Finds every piece of configuration create evidence in the workspace, before the current spec is interpreted (a context change must
 * not hide an older receipt). Answers:
 *   { root,                                     the checked workspace folder, or null when it does not exist
 *     sidecar: { status: 'absent' } | { status: 'valid', state } | { status: 'invalid', reason },
 *     quarantines: [{ quarantineId, status: 'valid', state: 'archiving'|'deferred', archive: boolean } | { quarantineId, status: 'invalid', reason }],
 *                                               `archive` is true only for a readable plain-file archive
 *     orphanArchives: [quarantineId],           archive names with no marker, whatever they hold
 *     unknownEntries: number,                   other `configuration-create-state.*` names (never echoed: a name may be anything)
 *     blocking: boolean }                       true for an invalid sidecar or marker, an archiving marker, a marker without a readable
 *                                               plain-file archive, an orphan archive or an unknown entry
 */
function discoverConfigurationCreateState(workspaceDir, { kindTable } = {}) {
  const root = rootOf(workspaceDir, false);
  const empty = { root, sidecar: { status: 'absent' }, quarantines: [], orphanArchives: [], unknownEntries: 0, blocking: false };
  if (!root) return empty;
  const names = listEvidence(root);
  const result = { ...empty, quarantines: [], orphanArchives: [] };
  for (const name of names) {
    if (name === STATE_FILE || LEASE_RE.test(name) || TEMP_RE.test(name) || QUARANTINE_RE.test(name) || ARCHIVE_RE.test(name)) continue;
    result.unknownEntries += 1;
  }
  const side = readEvidence(path.join(root, STATE_FILE));
  if (side && side.error) result.sidecar = { status: 'invalid', reason: `the saved state file ${side.error}` };
  else if (side) {
    try { result.sidecar = { status: 'valid', state: parseCreateState(side.bytes, { kindTable }) }; } catch (e) {
      if (!e || e.code !== 'configuration-create-state-invalid') throw e;
      result.sidecar = { status: 'invalid', reason: reasonOf(e) };
    }
  }
  const { quarantines, orphanArchives } = scanQuarantines(root, names);
  result.quarantines = quarantines;
  result.orphanArchives = orphanArchives;
  result.blocking = result.sidecar.status === 'invalid' || result.unknownEntries > 0 || result.orphanArchives.length > 0
    || result.quarantines.some((q) => q.status === 'invalid' || q.state === 'archiving' || !q.archive);
  return result;
}
const reasonOf = (e) => e.reason || 'the saved file is not valid';

/** The parsed state, or null when there is none. An invalid state file throws `configuration-create-state-invalid`. */
function readConfigurationCreateState(workspaceDir, { kindTable } = {}) {
  const root = rootOf(workspaceDir, false);
  if (!root) return null;
  const got = readEvidence(path.join(root, STATE_FILE));
  if (!got) return null;
  if (got.error) throw invalidState(`the saved state file ${got.error}`);
  return parseCreateState(got.bytes, { kindTable });
}

/** The quarantine part of discovery, for the build guard and the CLI: { root, quarantines, orphanArchives } as discovery answers them. */
function discoverConfigurationQuarantines(workspaceDir) {
  const root = rootOf(workspaceDir, false);
  if (!root) return { root: null, quarantines: [], orphanArchives: [] };
  return { root, ...scanQuarantines(root, listEvidence(root)) };
}

// ── Verified persistence ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Writes `text` to `file` atomically and reads it back. Any failure (the plain-file check, the write, the rename, the read-back, or bytes
// that differ, for instance because the writer's redaction changed them) is `configuration-create-persistence-uncertain`: what is on the
// disk now is not known, so nothing that depends on it may happen.
function writeVerified(file, text, transition, extra = {}) {
  const uncertain = (reason) => halt('configuration-create-persistence-uncertain', { reason, transition, ...extra });
  try { assertPlainFileTarget(file); } catch { throw uncertain('the saved file is not a plain file that can be replaced'); }
  try { writeFileAtomic(file, text); } catch { throw uncertain('the saved file could not be written and renamed into place'); }
  let back;
  try { back = fs.readFileSync(file); } catch { throw uncertain('the saved file could not be read back'); }
  if (!back.equals(Buffer.from(text, 'utf8'))) throw uncertain('the saved file did not read back as written');
}

function busy(root) {
  const lock = path.join(root, `${STATE_FILE}.lock`);
  return halt('configuration-create-state-busy', { reason: `its lock ${lock} is held or could not be created` });
}

// The largest fixed-shape form the state can take before any unit is added or removed again: every unit deferred (the longest unit
// state word: an open unit may be deferred explicitly at any time), every create row dispatched (the longest dispatch word), every
// publication acknowledged, every unit carrying the largest offer, and the largest revision. Admission measures this, and so does every
// later save, so no later transition of an admitted unit can be refused for size.
function worstCaseBytes(state) {
  const worst = JSON.parse(JSON.stringify(state));
  worst.revision = Number.MAX_SAFE_INTEGER;
  const sha = 'f'.repeat(64);
  for (const u of worst.units) {
    u.state = 'deferred';
    for (const r of u.rows) if (r.role === 'create') r.dispatch = 'dispatched';
    if (u.publication) u.publication.dispatch = 'acknowledged';
    u.offer = { mode: 'accept-current', nonceSha256: sha, observedPublicSha256: sha, publicIntentSha256: sha, privateAcknowledgmentRequired: false };
  }
  return Buffer.byteLength(serializeCreateState(worst), 'utf8');
}

/**
 * Runs one synchronous change of the state under its record lease: re-reads the file (an invalid one throws state-invalid), hands
 * `mutate(draft)` a mutable copy with EVERY offer cleared (null when there is no file), and when `mutate` answers a state, checks it as
 * strictly as the parser, bumps the revision, writes it and reads it back. `mutate` answering undefined changes nothing. `mutate` must
 * be synchronous: an answer that is a Promise is refused (the lease would already be released). Answers { state, changed }.
 */
function withCreateStateTransaction(workspaceDir, { kindTable, leaseDeps, transition = 'transaction', dispatched } = {}, mutate) {
  const root = rootOf(workspaceDir, true);
  const file = path.join(root, STATE_FILE);
  const r = withRecordLease(root, STATE_FILE, () => {
    const got = readEvidence(file);
    if (got && got.error) throw invalidState(`the saved state file ${got.error}`);
    const current = got ? parseCreateState(got.bytes, { kindTable }) : null;
    const draft = current ? JSON.parse(JSON.stringify(current)) : null;
    if (draft) for (const u of draft.units) u.offer = null;
    const next = mutate(draft, current);
    if (next && typeof next.then === 'function') throw invalidState('a state change must be synchronous', { transition });
    if (next === undefined) return { state: current, changed: false };
    const checked = copyState({ ...next, revision: (current ? current.revision : 0) + 1 }, kindTable, (reason) => invalidState(`an illegal transition: ${reason}`, { transition }));
    if (worstCaseBytes(checked) > LIMITS.maxBytes) throw halt('configuration-create-shape-refused', { reason: 'the saved state would exceed its size limit', transition });
    writeVerified(file, serializeCreateState(checked), transition, dispatched === undefined ? {} : { dispatched });
    return { state: deepFreeze(checked), changed: true };
  }, leaseDeps);
  if (!r.ok) throw busy(root);
  return r.value;
}

// ── Build handles ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A handle is an empty frozen object made only by prepareCreateUnit; its facts live here. It is the in-process proof that this
// invocation prepared the unit: a receipt read back from disk after a restart never yields one, so no restarted process can resume a row.
const handles = new WeakMap();

function unitIds(u) { return { unitId: u.unitId, rootId: u.root.id, rootKind: u.root.kind }; }
// The handle's compare-and-set on its own unit: the unit as this handle last saved it, offer aside (every change clears offers, and a
// recovery offer alone authorizes nothing). The file revision is the compare-and-set of each change; fencing a handle on its unit
// rather than on the whole file lets one build hold units of several roots, while any change to THIS unit by anyone else (a cancel, a
// defer, a replaced attempt, a rewritten plan hash) still kills it, and so does a new epoch.
const unitRecordOf = (u) => JSON.stringify({ ...u, offer: null });

/**
 * Prepares a unit before anything is sent. `unit` is { root: { kind, key, id }, publicIntentSha256, publicPlanSha256,
 * publicationRequired: boolean, rows: [{ kind, key, id, parentId, role, public, privateFields }] } (no dispatch: create rows start
 * `prepared`, preserved rows `not-applicable`). Refuses an unsupported shape or capacity (shape-refused), another context while units
 * remain (context-mismatch), and a root or row that an existing unit already covers (pending). Answers the live handle.
 */
function prepareCreateUnit(workspaceDir, { kindTable, context, unit, leaseDeps } = {}) {
  validateKindTable(kindTable);
  const shape = (reason) => halt('configuration-create-shape-refused', { reason, transition: 'prepare' });
  checkContext(context, shape);
  if (!exactKeys(unit, ['root', 'publicIntentSha256', 'publicPlanSha256', 'publicationRequired', 'rows'])) throw shape('the unit does not have exactly the prepared unit fields');
  if (typeof unit.publicationRequired !== 'boolean') throw shape('the unit publication requirement is not a boolean');
  if (!Array.isArray(unit.rows) || unit.rows.length === 0) throw shape('the unit has no rows');
  const candidate = {
    unitId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    state: 'open',
    root: isPlainObject(unit.root) ? { kind: unit.root.kind, key: unit.root.key, id: unit.root.id } : unit.root,
    publicIntentSha256: unit.publicIntentSha256,
    publicPlanSha256: unit.publicPlanSha256,
    rows: unit.rows.map((r) => copyRow(r, kindTable, shape, { input: true })),
    publication: unit.publicationRequired ? { dispatch: 'prepared' } : null,
    offer: null,
  };
  copyUnit(candidate, kindTable, shape);
  if (unit.root && !exactKeys(unit.root, ['kind', 'key', 'id'])) throw shape('the unit root does not have exactly kind, key and id');
  if (candidate.rows.length > LIMITS.maxRows) throw shape('the unit has more rows than the limit');
  const { state } = withCreateStateTransaction(workspaceDir, { kindTable, leaseDeps, transition: 'prepare' }, (draft) => {
    let base = draft;
    if (!base || base.units.length === 0) {
      base = { schema: 1, ...pickContext(context), epoch: base && sameCreateStateContext(base, context) ? base.epoch : crypto.randomUUID(), revision: 0, units: [] };
    } else if (!sameCreateStateContext(base, context)) {
      throw halt('configuration-create-context-mismatch', { transition: 'prepare', ...unitIds(base.units[0]) });
    }
    const rowIds = new Set(candidate.rows.map((r) => r.id));
    for (const u of base.units) {
      const sameRoot = (u.root.kind === candidate.root.kind && u.root.key === candidate.root.key) || u.root.id === candidate.root.id;
      if (sameRoot || u.rows.some((r) => rowIds.has(r.id))) {
        throw halt('configuration-create-pending', {
          transition: 'prepare',
          ...unitIds(u),
          reason: u.state === 'deferred' ? 'a deferred unit holds this root or one of its rows' : 'an unresolved unit holds this root or one of its rows',
        });
      }
    }
    const next = { ...base, units: [...base.units, candidate] };
    const rows = next.units.reduce((n, u) => n + u.rows.length, 0);
    if (next.units.length > LIMITS.maxUnits || rows > LIMITS.maxRows || worstCaseBytes(next) > LIMITS.maxBytes) {
      throw shape('the saved state has no room for this unit and its later transitions');
    }
    return next;
  });
  const handle = Object.freeze({ unitId: candidate.unitId, attemptId: candidate.attemptId });
  const saved = state.units.find((u) => u.unitId === candidate.unitId);
  handles.set(handle, { root: rootOf(workspaceDir, false), kindTable, leaseDeps, epoch: state.epoch, unitId: candidate.unitId, attemptId: candidate.attemptId, unitRecord: unitRecordOf(saved), live: true });
  return handle;
}
const pickContext = (c) => ({ environmentFingerprint: c.environmentFingerprint, solutionUniqueName: c.solutionUniqueName, appUniqueName: c.appUniqueName, authoringLanguageCode: c.authoringLanguageCode });

function staleHandle(h, transition) {
  return invalidState('the saved configuration create state changed under this invocation, or this step is not allowed now', {
    transition,
    unitId: h && h.unitId,
    nextStep: 'Stop this invocation and inspect the saved state with configuration-recovery.js inspect.',
  });
}

// Runs one fenced transition of the handle's unit. Any refusal or failure kills the handle: after an unverified or refused step this
// invocation must not send anything else for the unit.
function withHandle(handle, transition, change, { dispatched } = {}) {
  const h = handle && typeof handle === 'object' ? handles.get(handle) : undefined;
  if (!h || !h.live) throw staleHandle(h, transition);
  try {
    const { state } = withCreateStateTransaction(h.root, { kindTable: h.kindTable, leaseDeps: h.leaseDeps, transition, dispatched }, (draft) => {
      if (!draft || draft.epoch !== h.epoch) throw staleHandle(h, transition);
      const unit = draft.units.find((u) => u.unitId === h.unitId);
      if (!unit || unit.attemptId !== h.attemptId || unit.state !== 'open' || unitRecordOf(unit) !== h.unitRecord) throw staleHandle(h, transition);
      const remove = change(unit, () => staleHandle(h, transition));
      if (remove === 'remove') draft.units = draft.units.filter((u) => u !== unit);
      return draft;
    });
    const saved = state.units.find((u) => u.unitId === h.unitId);
    h.unitRecord = saved ? unitRecordOf(saved) : null;
    if (!saved) h.live = false;
    return state;
  } catch (e) {
    h.live = false;
    throw e;
  }
}
function rowOf(unit, rowId, illegal) {
  const row = unit.rows.find((r) => r.id === rowId);
  if (!row || row.role !== 'create') throw illegal();
  return row;
}

function setRow(handle, rowId, from, to, transition, dispatched) {
  withHandle(handle, transition, (unit, illegal) => {
    const row = rowOf(unit, rowId, illegal);
    if (row.dispatch !== from) throw illegal();
    row.dispatch = to;
  }, { dispatched });
}

/** prepared -> dispatched, saved and verified BEFORE the socket call. A failure here means this row was not dispatched. */
function sealCreateRow(handle, rowId) { setRow(handle, rowId, 'prepared', 'dispatched', 'seal', false); }

/** dispatched -> verified, after a direct valid response and an exact public read-back in this same invocation. */
function markCreateRowVerified(handle, rowId) { setRow(handle, rowId, 'dispatched', 'verified', 'verify', true); }

/** All create rows verified and the publication slot prepared -> dispatched, saved and verified before the one action is sent. */
function sealNewRulePublication(handle) {
  withHandle(handle, 'publication-seal', (unit, illegal) => {
    if (!unit.publication || unit.publication.dispatch !== 'prepared') throw illegal();
    if (!unit.rows.every((r) => r.role !== 'create' || r.dispatch === 'verified')) throw illegal();
    unit.publication.dispatch = 'dispatched';
  }, { dispatched: false });
}

/** dispatched -> acknowledged, only on a complete direct 2xx answer to the action in this invocation; never inferred from a read. */
function markNewRulePublicationAcknowledged(handle) {
  withHandle(handle, 'publication-acknowledge', (unit, illegal) => {
    if (!unit.publication || unit.publication.dispatch !== 'dispatched') throw illegal();
    unit.publication.dispatch = 'acknowledged';
  }, { dispatched: true });
}

/** Removes a unit whose every create row is verified and whose publication is absent or acknowledged. The (possibly empty) file stays. */
function completeCreateUnit(handle) {
  withHandle(handle, 'complete', (unit, illegal) => {
    if (!unit.rows.every((r) => r.role !== 'create' || r.dispatch === 'verified')) throw illegal();
    if (unit.publication && unit.publication.dispatch !== 'acknowledged') throw illegal();
    return 'remove';
  }, { dispatched: true });
  handles.get(handle).live = false;
}

function isLiveCreateHandle(handle) {
  const h = handle && typeof handle === 'object' ? handles.get(handle) : undefined;
  return !!h && h.live;
}

// ── Approval offers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A token is `<revision>.<64 hex nonce>`: the revision it was saved at and a random nonce, of which only the SHA-256 is saved. The
// revision changes with every saved change, so any change at all makes every earlier token stale; the one-use rule follows from that.
const TOKEN_RE = /^(\d{1,16})\.([0-9a-f]{64})$/;
function parseToken(token) {
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  if (!m) return null;
  const revision = Number(m[1]);
  return Number.isSafeInteger(revision) ? { revision, nonce: m[2] } : null;
}
function sameDigest(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Whether `token` is the one issued for `offer` while the receipt was at `revision`. Callers use it to refuse a wrong token before any
// side effect; resolveResolutionOffer repeats the check under the lease, where it is authoritative.
function offerTokenMatches(offer, revision, token) {
  const parsed = parseToken(token);
  return Boolean(parsed && offer && parsed.revision === revision && sameDigest(sha256(Buffer.from(parsed.nonce, 'hex')), offer.nonceSha256));
}

/**
 * Saves a one-use offer for `unitId` and answers its token. `expectedRevision` is the revision the caller's observation was based on:
 * any other saved revision is approval-stale. `observedPublicSha256` is required for accept-current (and only for it). Cancel needs a
 * wholly prepared unit (pending otherwise); defer needs an open unit. The private acknowledgment requirement is decided here, from the
 * unit's rows, not by the caller.
 */
function prepareResolutionOffer(workspaceDir, { kindTable, context, unitId, mode, observedPublicSha256 = null, expectedRevision, leaseDeps } = {}) {
  if (!OFFER_MODES.includes(mode)) throw halt('configuration-create-shape-refused', { reason: 'the resolution is not accept-current, defer or cancel-unsent', transition: 'offer' });
  if (mode === 'accept-current' ? !isSha(observedPublicSha256) : observedPublicSha256 !== null) {
    throw halt('configuration-create-shape-refused', { reason: 'the observation hash does not fit the resolution', transition: 'offer' });
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  let required = false;
  const { state } = withCreateStateTransaction(workspaceDir, { kindTable, leaseDeps, transition: 'offer' }, (draft) => {
    const unit = draft && draft.units.find((u) => u.unitId === unitId);
    if (!draft || !unit) throw halt('configuration-create-approval-stale', { unitId, transition: 'offer', reason: 'the unit is no longer in the saved state' });
    if (!sameCreateStateContext(draft, context)) throw halt('configuration-create-context-mismatch', { transition: 'offer', ...unitIds(unit) });
    if (draft.revision !== expectedRevision) throw halt('configuration-create-approval-stale', { transition: 'offer', ...unitIds(unit), reason: 'the saved state changed after it was observed' });
    if (mode === 'cancel-unsent' && !wholePrepared(unit)) {
      throw halt('configuration-create-pending', { transition: 'offer', ...unitIds(unit), reason: 'a row or the publication of this unit may have been dispatched, so it cannot be cancelled', nextStep: 'Inspect it, then accept the current state, complete its recorded missing work, or defer it.' });
    }
    if (mode === 'defer' && unit.state !== 'open') throw halt('configuration-create-approval-stale', { transition: 'offer', ...unitIds(unit), reason: 'the unit is already deferred' });
    required = mode === 'accept-current' && isSensitive(unit.rows);
    unit.offer = { mode, nonceSha256: sha256(Buffer.from(nonce, 'hex')), observedPublicSha256, publicIntentSha256: unit.publicIntentSha256, privateAcknowledgmentRequired: required };
    return draft;
  });
  return { token: `${state.revision}.${nonce}`, revision: state.revision, privateAcknowledgmentRequired: required };
}

/**
 * Uses an offer: the token must match the saved revision and the saved nonce hash, and the mode, the unit, the context and (for
 * accept-current) a FRESH observation hash must match what the offer bound. accept-current and cancel-unsent remove the unit (cancel
 * re-checks that nothing was dispatched); defer marks it deferred. A sensitive unit needs `acceptCurrentPrivateState` for
 * accept-current (private-review-required otherwise). Answers { state, removed, deferred }.
 */
function resolveResolutionOffer(workspaceDir, { kindTable, context, unitId, mode, token, observedPublicSha256 = null, acceptCurrentPrivateState = false, leaseDeps } = {}) {
  const parsed = parseToken(token);
  let removed = false;
  let deferred = false;
  const { state } = withCreateStateTransaction(workspaceDir, { kindTable, leaseDeps, transition: 'resolve' }, (draft, current) => {
    const unit = draft && draft.units.find((u) => u.unitId === unitId);
    const stale = (reason) => halt('configuration-create-approval-stale', { transition: 'resolve', unitId, ...(unit ? unitIds(unit) : {}), reason });
    if (!draft || !unit) throw stale('the unit is no longer in the saved state');
    if (!sameCreateStateContext(draft, context)) throw halt('configuration-create-context-mismatch', { transition: 'resolve', ...unitIds(unit) });
    const offer = current.units.find((u) => u.unitId === unitId).offer;
    if (!parsed || parsed.revision !== current.revision || !offer) throw stale('the approval token does not belong to the saved state');
    if (!sameDigest(sha256(Buffer.from(parsed.nonce, 'hex')), offer.nonceSha256)) throw stale('the approval token does not belong to the saved state');
    if (offer.mode !== mode) throw stale('the approval was prepared for another resolution');
    if (offer.publicIntentSha256 !== unit.publicIntentSha256) throw stale('the approval was prepared for another intent');
    if (mode === 'accept-current') {
      if (!isSha(observedPublicSha256) || observedPublicSha256 !== offer.observedPublicSha256) throw stale('the current observation differs from the approved one');
      if (offer.privateAcknowledgmentRequired && acceptCurrentPrivateState !== true) throw halt('configuration-create-private-review-required', { transition: 'resolve', ...unitIds(unit) });
      draft.units = draft.units.filter((u) => u !== unit);
      removed = true;
    } else if (mode === 'cancel-unsent') {
      if (!wholePrepared(unit)) throw halt('configuration-create-pending', { transition: 'resolve', ...unitIds(unit), reason: 'a row or the publication of this unit may have been dispatched, so it cannot be cancelled' });
      draft.units = draft.units.filter((u) => u !== unit);
      removed = true;
    } else {
      if (unit.state !== 'open') throw stale('the unit is already deferred');
      unit.state = 'deferred';
      deferred = true;
    }
    return draft;
  });
  return { state, removed, deferred };
}

// ── Quarantine ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Puts the complete, fsynced file `staged` at `dest` ONLY while `dest` does not exist, and atomically: a hard link fails with EEXIST when
// the name is taken (NTFS and POSIX alike), where a rename would silently replace whatever took the name after any check. The record
// lease serializes this plugin's writers, but not a sync client, a backup restore or a person, so the no-replace must be the operation
// itself. A file system without hard links (FAT, some network shares: EPERM, ENOTSUP, EXDEV) is refused, never answered with a
// replacing rename.
//
// Removing the staged name afterwards is a step of the protocol, not housekeeping: until it is gone the installed file has two names,
// and the plain-file guard (safe-fs.js assertPlainFileTarget) rightly refuses to replace a hard-linked file, so a marker whose staged
// name stayed could never be changed from `archiving` to `deferred`. The removal is retried as a Windows lock needs (a scanner holds a
// file it has just seen written); a name that still stays throws `stagedNameKept`, and the caller halts with the continuation that
// removes it (releaseOwnStagedName), which is also what a crash between the link and the removal needs.
// See: https://nodejs.org/api/fs.html#fslinksyncexistingpath-newpath
function installNoReplace(staged, dest) {
  fs.linkSync(staged, dest);
  try { unlinkWithRetry(fs, staged); } catch { throw Object.assign(new Error('the staged name could not be removed'), { stagedNameKept: true }); }
}
const stagedName = (file) => `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The halt of an install whose file is in place but whose staged name stayed: nothing is lost, and the continuation finishes it.
const stagedNameKept = (id) => halt('configuration-create-persistence-uncertain', {
  transition: 'quarantine',
  reason: 'a quarantine file was installed, but its staged copy could not be removed',
  nextStep: `Once the build workspace files can be changed again, finish the quarantine with --quarantine-id ${id}; it removes the staged copy only when it is the same file.`,
});

// The continuation's half of the link-before-unlink boundary of installNoReplace: removes the staged name that an interrupted install
// of `<root>/<fileName>` left, and only that one. A sibling is removed only when ALL of this holds:
//   - its name is the protocol's staged name of exactly this file (stagedName: `<fileName>.<pid>.<ms>.<random>.tmp`, one suffix), and
//     it is the only such name that is the same file;
//   - it is the same file as `fileName` (the same device and file id, read with `bigint`: a Windows file id is 64 bits), and the file
//     has exactly these two names. A file id alone is not proof: Windows does not guarantee it unique on ReFS
//     (https://learn.microsoft.com/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information), and a file system that gives no
//     id (0) cannot say, so the bytes must match too and a third name of any kind leaves everything as it is.
// Anything else is left alone: another hard link is somebody's, a temporary file of a write is a different file, and the plain-file
// guard then refuses the later replacement as it should. Removing a name of a file that keeps its other name loses no byte.
function releaseOwnStagedName(root, fileName) {
  const uncertain = (reason) => halt('configuration-create-persistence-uncertain', { transition: 'quarantine', reason });
  const dest = path.join(root, fileName);
  let target;
  try { target = fs.lstatSync(dest, { bigint: true }); } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw uncertain('a quarantine file could not be inspected');
  }
  if (!target.isFile() || target.nlink !== 2n || target.ino === 0n) return;
  let names;
  try { names = fs.readdirSync(root); } catch { throw uncertain('the build workspace folder could not be listed'); }
  const pattern = new RegExp(`^${escapeRegExp(fileName)}\\.\\d+\\.\\d+\\.[0-9a-z]*\\.tmp$`);
  const same = [];
  for (const n of names) {
    if (!pattern.test(n)) continue;
    let st;
    try { st = fs.lstatSync(path.join(root, n), { bigint: true }); } catch { continue; }
    if (st.isFile() && st.nlink === 2n && st.dev === target.dev && st.ino === target.ino) same.push(n);
  }
  if (same.length !== 1) return;
  const staged = path.join(root, same[0]);
  let sameBytes;
  try { sameBytes = fs.readFileSync(staged).equals(fs.readFileSync(dest)); } catch { throw uncertain('a staged quarantine copy could not be read'); }
  if (!sameBytes) return;
  try { unlinkWithRetry(fs, staged); } catch { throw uncertain('a staged quarantine copy could not be removed'); }
}

// A fresh marker (`exclusive`) is staged under a temporary name and installed without replacing anything, so a marker with a fresh id
// that somebody else wrote is never overwritten; the later state change of a marker this call owns replaces it under the lease.
function writeMarker(root, id, stateWord, { exclusive }) {
  const file = path.join(root, quarantineName(id));
  const text = serializeQuarantine(quarantineRecord(id, stateWord));
  if (!exclusive) {
    writeVerified(file, text, 'quarantine');
    return;
  }
  const uncertain = (reason) => halt('configuration-create-persistence-uncertain', { transition: 'quarantine', reason });
  const staged = stagedName(file);
  try {
    writeFileAtomic(staged, text);
    installNoReplace(staged, file);
  } catch (e) {
    if (e && e.stagedNameKept) throw stagedNameKept(id);
    try { fs.unlinkSync(staged); } catch { /* best effort: a staged copy that was never installed is not evidence (TEMP_RE) */ }
    throw uncertain(e && e.code === 'EEXIST' ? 'a quarantine marker with a fresh id already exists' : 'a quarantine marker could not be created without replacing a file');
  }
  let back;
  try { back = fs.readFileSync(file); } catch { throw uncertain('the saved file could not be read back'); }
  if (!back.equals(Buffer.from(text, 'utf8'))) throw uncertain('the saved file did not read back as written');
}

function readBytes(file) {
  try { return fs.readFileSync(file); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw invalidState('a quarantine file could not be read', { transition: 'quarantine', nextStep: 'Restore read and write access to the build workspace files, then run the same command again.' });
  }
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// The archive of an id, checked as discovery checks it and read whole. Absent answers null; anything but a readable plain file is
// invalid evidence that stays in place.
function verifiedArchive(root, id) {
  const got = inspectArchive(path.join(root, archiveName(id)), { bytes: true });
  if (got.status === 'absent') return null;
  if (got.status !== 'valid') {
    throw invalidState(got.reason, { transition: 'quarantine', nextStep: 'Keep the marker and the archive name as they are; restore the archive as a plain file this user can read, or keep this workspace for manual handling.' });
  }
  return got.bytes;
}

// Moves the original state file to the archive name without overwriting anything: copy it to a temporary sibling (exclusive), fsync,
// compare its bytes with the original, install the copy at the archive name with an atomic no-replace (installNoReplace), compare
// again, then remove the original. The bytes are never parsed, redacted or hashed into any record. A crash at any point leaves the
// original, the archive, or both, beside the `archiving` marker, and a continuation finishes it.
function moveToArchive(root, id) {
  const original = path.join(root, STATE_FILE);
  const archive = path.join(root, archiveName(id));
  const uncertain = (reason) => halt('configuration-create-persistence-uncertain', { transition: 'quarantine', reason });
  const before = readBytes(original);
  if (!before) throw invalidState('the unreadable state file vanished before it was archived', { transition: 'quarantine' });
  const tmp = stagedName(archive);
  try {
    fs.copyFileSync(original, tmp, fs.constants.COPYFILE_EXCL);
    fsyncFile(tmp);
    if (!fs.readFileSync(tmp).equals(before)) throw new Error('copy differs');
    installNoReplace(tmp, archive);
  } catch (e) {
    if (e && e.stagedNameKept) throw stagedNameKept(id);
    try { fs.unlinkSync(tmp); } catch { /* best effort: a copy that was never installed is not evidence (TEMP_RE) */ }
    throw uncertain('the unreadable state file could not be copied to its archive without replacing a file');
  }
  finishMove(root, id, before);
}
// The archive holds the original's bytes: remove the original. Bytes that differ are conflicting copies; both are kept.
function finishMove(root, id, expected) {
  const original = path.join(root, STATE_FILE);
  const now = readBytes(original);
  const kept = verifiedArchive(root, id);
  if (!kept) throw halt('configuration-create-persistence-uncertain', { transition: 'quarantine', reason: 'the archive could not be read back' });
  if (now && (!now.equals(kept) || (expected && !expected.equals(kept)))) {
    throw invalidState('the state file and its archive differ; both are kept', { transition: 'quarantine', nextStep: 'Compare the two files yourself and keep the trustworthy one; nothing was overwritten or deleted.' });
  }
  if (now) {
    try { fs.unlinkSync(original); } catch { throw halt('configuration-create-persistence-uncertain', { transition: 'quarantine', reason: 'the original state file could not be removed after it was archived' }); }
  }
}

/**
 * The explicit, local-only way forward from an unreadable receipt (no service call, no SDK). Requires
 * `acknowledgeUnknownDispatch: true`. Without `quarantineId`: the state file must be invalid; under the record lease it invalidates the
 * apply snapshot (fail-closed), saves an `archiving` marker with a fresh local id, moves the original bytes to the archive, and saves
 * the marker `deferred`. With `quarantineId`: finishes that id's interrupted quarantine after checking its files, or restores the
 * missing marker of an orphan archive. Answers { quarantineId, halt } with the `configuration-create-reconciled` halt.
 * `invalidate(root)` replaces the snapshot invalidation for tests; it answers { ok, reason }.
 */
function quarantineUnreadableReceipt(workspaceDir, { kindTable, acknowledgeUnknownDispatch, quarantineId, invalidate, leaseDeps } = {}) {
  if (acknowledgeUnknownDispatch !== true) {
    throw invalidState('quarantining an unreadable state needs an explicit acknowledgment that its dispatch is unknown', { transition: 'quarantine', nextStep: 'Run the quarantine again with --acknowledge-unknown-dispatch if no trustworthy copy of the state file exists.' });
  }
  if (quarantineId !== undefined && quarantineId !== null && !isCanonicalGuid(String(quarantineId).toLowerCase())) {
    throw halt('configuration-create-approval-stale', { transition: 'quarantine', reason: 'the quarantine id is not a GUID' });
  }
  const id = quarantineId ? String(quarantineId).toLowerCase() : null;
  const root = rootOf(workspaceDir, false);
  if (!root) throw halt('configuration-create-approval-stale', { transition: 'quarantine', reason: 'there is no build workspace to quarantine' });
  const invalidateFn = typeof invalidate === 'function' ? invalidate : (dir) => invalidateSnapshot(dir);
  const invalidated = () => {
    let res;
    try { res = invalidateFn(root); } catch { res = { ok: false }; }
    if (!res || res.ok !== true) throw halt('configuration-create-persistence-uncertain', { transition: 'quarantine', reason: 'the apply snapshot could not be invalidated' });
  };
  const r = withRecordLease(root, STATE_FILE, () => {
    const found = discoverConfigurationCreateState(root, { kindTable });
    if (!id) {
      const archiving = found.quarantines.find((q) => q.status === 'valid' && q.state === 'archiving');
      if (archiving) throw invalidState('an earlier quarantine was interrupted', { transition: 'quarantine', nextStep: `Finish it with --quarantine-id ${archiving.quarantineId}.` });
      if (found.sidecar.status === 'valid') {
        if (found.sidecar.state.units.length > 0) throw halt('configuration-create-pending', { transition: 'quarantine', ...unitIds(found.sidecar.state.units[0]), reason: 'the saved state is readable', nextStep: 'Inspect and resolve its units instead of quarantining it.' });
        throw halt('configuration-create-approval-stale', { transition: 'quarantine', reason: 'the saved state is readable and holds no unit' });
      }
      if (found.sidecar.status === 'absent') throw halt('configuration-create-approval-stale', { transition: 'quarantine', reason: 'there is no saved state to quarantine' });
      const original = path.join(root, STATE_FILE);
      try { assertPlainFileTarget(original); } catch {
        throw invalidState('the state file is not a plain file', { transition: 'quarantine', nextStep: 'Restore it as a plain file this user can read, then run the same command again.' });
      }
      if (!readBytes(original)) throw invalidState('the unreadable state file vanished', { transition: 'quarantine' });
      invalidated();
      const fresh = crypto.randomUUID();
      writeMarker(root, fresh, 'archiving', { exclusive: true });
      moveToArchive(root, fresh);
      writeMarker(root, fresh, 'deferred', { exclusive: false });
      return fresh;
    }
    const marker = found.quarantines.find((q) => q.quarantineId === id);
    if (!marker) {
      if (!found.orphanArchives.includes(id)) throw halt('configuration-create-approval-stale', { transition: 'quarantine', reason: 'no quarantine or archive with that id exists' });
      releaseOwnStagedName(root, archiveName(id));
      // An archive name alone is not an archive: read it whole as a plain file before its marker says it is deferred.
      if (!verifiedArchive(root, id)) throw invalidState('the archive of that quarantine vanished', { transition: 'quarantine' });
      invalidated();
      writeMarker(root, id, 'deferred', { exclusive: true });
      return id;
    }
    if (marker.status !== 'valid') throw invalidState('that quarantine marker is invalid', { transition: 'quarantine', nextStep: 'Keep the marker and its archive; restore a trustworthy copy of the marker or keep this workspace for manual handling.' });
    // An install interrupted between its link and the removal of the staged name (a lock, a crash) left the marker or the archive
    // with a second, staged name; the plain-file guard would refuse every later change of that marker.
    releaseOwnStagedName(root, quarantineName(id));
    releaseOwnStagedName(root, archiveName(id));
    const original = path.join(root, STATE_FILE);
    if (marker.state === 'deferred') {
      if (!verifiedArchive(root, id)) throw invalidState('the archive of that quarantine is missing', { transition: 'quarantine' });
      return id;
    }
    if (found.sidecar.status === 'valid' && found.sidecar.state.units.length > 0) {
      throw halt('configuration-create-pending', { transition: 'quarantine', ...unitIds(found.sidecar.state.units[0]), reason: 'a readable saved state is present again', nextStep: 'Inspect and resolve its units; keep the quarantine marker and archive.' });
    }
    const haveArchive = !!verifiedArchive(root, id);
    invalidated();
    const haveOriginal = !!readBytes(original);
    if (haveOriginal && !haveArchive) moveToArchive(root, id);
    else if (haveArchive) finishMove(root, id, null);
    else throw invalidState('neither the state file nor its archive is present', { transition: 'quarantine', nextStep: 'Restore the archive or the state file from a backup, then run the same command again.' });
    writeMarker(root, id, 'deferred', { exclusive: false });
    return id;
  }, leaseDeps);
  if (!r.ok) throw busy(root);
  return { quarantineId: r.value, halt: halt('configuration-create-reconciled', { transition: 'quarantine', reason: `quarantine ${r.value} is deferred with its dispatch unknown` }) };
}

/**
 * Teardown and `--clear-workspace` refuse (workspace-in-use) while the workspace holds any unit (open or deferred), an invalid or
 * unreadable state, a quarantine marker or archive, or an unknown `configuration-create-state.*` entry. An absent state, or a valid one
 * with no unit, is clearable. A quarantine acknowledgment of a build is never permission here.
 */
function assertConfigurationCreateWorkspaceClearable(workspaceDir, { kindTable } = {}) {
  let found;
  try { found = discoverConfigurationCreateState(workspaceDir, { kindTable }); } catch (e) {
    // An unreadable state, or saved units this caller cannot judge without the kind table, are evidence all the same: never clearable.
    if (e && (e.code === 'configuration-create-state-invalid' || e.code === 'configuration-create-shape-refused')) {
      throw halt('configuration-create-workspace-in-use', { reason: 'the configuration create evidence could not be read' });
    }
    throw e;
  }
  const inUse = [];
  if (found.sidecar.status === 'invalid') inUse.push('an unreadable configuration create state');
  if (found.sidecar.status === 'valid' && found.sidecar.state.units.length > 0) inUse.push(`${found.sidecar.state.units.length} configuration create unit(s)`);
  if (found.quarantines.length > 0) inUse.push(`${found.quarantines.length} quarantine marker(s)`);
  if (found.orphanArchives.length > 0) inUse.push(`${found.orphanArchives.length} quarantine archive(s) without a marker`);
  if (found.unknownEntries > 0) inUse.push(`${found.unknownEntries} unknown configuration create entr${found.unknownEntries === 1 ? 'y' : 'ies'}`);
  if (inUse.length > 0) {
    const first = found.sidecar.status === 'valid' && found.sidecar.state.units[0];
    throw halt('configuration-create-workspace-in-use', { reason: `it holds ${inUse.join(', ')}`, ...(first ? unitIds(first) : {}) });
  }
}

module.exports = {
  STATE_FILE,
  QUARANTINE_FILE_PREFIX,
  ARCHIVE_FILE_PREFIX,
  LIMITS,
  ROW_KINDS,
  ROOT_KINDS,
  FIELD_TYPES,
  CONFIGURATION_CREATE_STOP_CODES,
  configurationCreateHalt,
  validateKindTable,
  createStateContext,
  sameCreateStateContext,
  parseCreateState,
  serializeCreateState,
  discoverConfigurationCreateState,
  readConfigurationCreateState,
  discoverConfigurationQuarantines,
  withCreateStateTransaction,
  prepareCreateUnit,
  sealCreateRow,
  markCreateRowVerified,
  sealNewRulePublication,
  markNewRulePublicationAcknowledged,
  completeCreateUnit,
  isLiveCreateHandle,
  prepareResolutionOffer,
  resolveResolutionOffer,
  offerTokenMatches,
  quarantineUnreadableReceipt,
  assertConfigurationCreateWorkspaceClearable,
  // For the recovery module: the closed public-projection check and the canonical GUID test it shares.
  copyPublicProjection: (kind, pub, kindTable, fail) => copyPublic(kind, pub, validateKindTable(kindTable), fail),
  isCanonicalGuid,
};

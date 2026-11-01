'use strict';
// The managed binding store: the one local file that records which service rows a build manages for a declared form,
// dashboard, business rule or process flow, as whole groups (a root and every child the build placed under it).
//
// WHY A GROUP, AND WHY AN ATTEMPT. A declared form is one root row plus children (sections, cells, controls) that only
// mean something together. Recording them one by one (reconcile-common.js createFeatureSettlement, which records each
// binding in its own write) leaves a window where the file holds the old root and only part of the new children; a
// later build would then trust a set the service never had. Here a group is replaced whole, in one atomic write, and
// only after a fresh read proved it. Before anything is sent, an ATTEMPT is written: what the build is about to do and
// what the result must look like (`expected`). A build that dies after the service accepted the change and before the
// group was committed leaves that attempt behind; the next build must prove `expected` against a fresh read before it
// may use, replace or publish anything under that root. While an attempt is pending, `lookup` refuses to answer, so an
// older root can never authorize a plan that ignores an interrupted change.
//
// FAIL CLOSED. A missing file is an empty store (it is not evidence that nothing was ever sent). A file that cannot be
// read whole and valid — corrupt JSON, a foreign header, an unexpected key, a link or hard-link alias, an over-size file
// — is `managed-binding-store-unreadable`: the build stops before a protected write, and the file is never replaced
// with an empty store. One invalid group makes only that group unusable (`managed-binding-group-invalid`); it is kept
// on disk exactly as it was.
//
// WRITES. Every change takes the record lease (record-lease.js), rereads the file from disk, applies one change, and
// replaces the file atomically (apply-snapshot-store.js writeFileAtomic), then reads it back and compares the canonical
// hash: the writer redacts token-shaped text, and a write that changed an authoritative field must fail, not report
// success. Unlike the recovery hints that use the same lease, a lease that cannot be taken is fatal here
// (`managed-binding-store-busy`). Writes happen only inside a build step, never from an exit handler.
//
// Nothing in the shipped build calls this module yet: a build whose spec has no managed feature never opens it.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, normalizeGuid } = require('./reconcile-common.js');
const { environmentFingerprint, workspaceRoot } = require('./page-ownership-records.js');
const { writeFileAtomic } = require('./apply-snapshot-store.js');
const { withRecordLease } = require('./record-lease.js');

const PREFIX = 'managed-bindings.';
const SCHEMA_VERSION = 1;
// Four times the dashboard-creation record's limit (dashboard-creation-records.js MAX_BYTES), because this file holds
// each group's canonical declaration. A larger file is refused, never truncated.
const MAX_BYTES = 4 * (1 << 20);

const CODES = Object.freeze({
  unreadable: 'managed-binding-store-unreadable',
  groupInvalid: 'managed-binding-group-invalid',
  busy: 'managed-binding-store-busy',
  conflict: 'managed-binding-generation-conflict',
  pending: 'managed-settlement-pending',
  writeFailed: 'managed-binding-write-failed',
  notSettled: 'managed-not-settled',
  completion: 'create-completion-required',
});

const FAMILIES = ['form', 'dashboard', 'rule', 'bpf', 'view', 'chart'];
// Forms and dashboards are rows of one table (systemform), rules and process flows of another (workflow): a root id
// may be bound once per table, whichever family claims it.
const NAMESPACE = { form: 'systemform', dashboard: 'systemform', rule: 'workflow', bpf: 'workflow', view: 'savedquery', chart: 'savedqueryvisualization' };
// The binding kind of each family's root record. It is the kind the create catalog (lib/creates-catalog.js) hands a
// feature, so a feature records its root under the same spelling it was given: a business rule's group family is the
// short `rule`, but its root is a `business-rule` binding, never a `rule` one.
const ROOT_KIND = Object.freeze({ form: 'form', dashboard: 'dashboard', rule: 'business-rule', bpf: 'bpf', view: 'view', chart: 'chart' });
const PUBLISHING = new Set(['form', 'dashboard', 'view', 'chart']);
const PUBLICATION_STATES = new Set(['not-needed', 'owed', 'dispatching', 'unconfirmed', 'confirmed']);
const EFFECT_STATES = new Set(['definitely-unsent', 'dispatching', 'unconfirmed', 'confirmed']);
const UNCERTAIN = new Set(['dispatching', 'unconfirmed']);
const PHASES = new Set(['prepared', 'sending', 'saved', 'state-pending', 'membership-pending']);
const EFFECTS = new Set(['create', 'body', 'state']);
// What each family may keep as consumer state. Anything else (raw formxml, raw WFOM or XAML, tokens, service errors,
// environment URLs) is refused, so a careless consumer cannot turn the store into a copy of the service.
const CONSUMER_KEYS = {
  form: ['declaration', 'children', 'proofSchema'],
  dashboard: ['declaration', 'tiles', 'seedIds'],
  rule: ['declaration', 'slots'],
  bpf: ['declaration', 'stages'],
  view: ['baseline'],
  chart: ['baseline'],
};
// The fixed control id of a form's timeline; it repeats on every form that has one, so it is not a physical alias.
const NOTES_CONTROL = 'notescontrol';
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;
const groupId = (family, key) => `${family}\u0000${key}`;
const newToken = () => crypto.randomUUID();

function storeError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

// A schema check that names the first thing wrong. `where` is a path such as `groups[2].records[0]`.
function invalid(where, why) {
  return storeError(CODES.unreadable, `${where}: ${why}`);
}
function closedKeys(obj, allowed, where) {
  if (!isObj(obj)) throw invalid(where, 'is not an object');
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw invalid(where, `has an unexpected key "${k}"`);
}
function hashOrNull(v, where, nullable = true) {
  if (v === null && nullable) return;
  if (typeof v !== 'string' || !HEX64.test(v)) throw invalid(where, 'is not a sha256');
}
function tokenField(v, where, nullable = false) {
  if (v === null && nullable) return;
  if (!nonempty(v) || v.length > 128) throw invalid(where, 'is not a token');
}
function guidField(v, where) {
  if (typeof v !== 'string' || normalizeGuid(v) !== v) throw invalid(where, 'is not a lowercase GUID');
}

function validateScope(scope, where) {
  if (!isObj(scope)) throw invalid(where, 'is not a scope');
  if (scope.type === 'table') {
    closedKeys(scope, ['type', 'table'], where);
    if (!/^[a-z0-9_]+$/.test(String(scope.table))) throw invalid(where, 'names no table');
  } else if (scope.type === 'dashboard') {
    closedKeys(scope, ['type', 'id'], where);
    guidField(scope.id, `${where}.id`);
  } else {
    throw invalid(where, 'is not a table or dashboard scope');
  }
}

// Strings that would make the store a copy of service content or a credential carrier.
const XML_DOCUMENT = /^\s*<[A-Za-z?!][\s\S]*>\s*$/;
const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/;
const ENVIRONMENT_URL = /https?:\/\/[^\s"']*\.(?:dynamics|crm\d*\.dynamics)\.com/i;
function validateConsumerValue(value, where) {
  if (typeof value === 'string') {
    if (XML_DOCUMENT.test(value)) throw invalid(where, 'holds raw markup');
    if (JWT.test(value)) throw invalid(where, 'holds a token');
    if (ENVIRONMENT_URL.test(value)) throw invalid(where, 'holds an environment URL');
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => validateConsumerValue(v, `${where}[${i}]`)); return; }
  if (isObj(value)) { for (const [k, v] of Object.entries(value)) validateConsumerValue(v, `${where}.${k}`); return; }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  throw invalid(where, 'holds a value JSON cannot keep');
}

function validateRoot(root, family, key, where) {
  closedKeys(root, ['kind', 'key', 'id'], where);
  if (!nonempty(root.kind) || root.key !== key) throw invalid(where, 'is not this group\'s root');
  guidField(root.id, `${where}.id`);
  if (root.kind !== ROOT_KIND[family]) throw invalid(where, `is a ${root.kind} root, and a ${family} group's root is a ${ROOT_KIND[family]}`);
}

// The proof a committed group keeps. Every field is required: the saved, semantic and preservation hashes are never
// null, because a group that cannot show them was not proved; the child-set hash is null only for a group that
// expects no child (a business rule, a form whose declaration places no control).
const PROOF_KEYS = ['savedSha256', 'semanticSha256', 'preservationSha256', 'expectedChildrenSha256'];
function validateProof(proof, where) {
  closedKeys(proof, PROOF_KEYS, where);
  for (const k of PROOF_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(proof, k)) throw invalid(where, `has no ${k}`);
    hashOrNull(proof[k], `${where}.${k}`, k === 'expectedChildrenSha256');
  }
}

function validateRecord(rec, header, where) {
  closedKeys(rec, ['formatVersion', 'appUniqueName', 'environmentFingerprint', 'kind', 'key', 'id', 'intentSha256', 'origin', 'parentKey', 'partsSha256'], where);
  if (rec.formatVersion !== 1) throw invalid(where, 'has an unknown format');
  if (rec.appUniqueName !== header.appUniqueName || rec.environmentFingerprint !== header.environmentFingerprint) throw invalid(where, 'belongs to another app or environment');
  if (!nonempty(rec.kind) || !nonempty(rec.key)) throw invalid(where, 'has no kind or key');
  // A rule's body is proved by its whole projection, not by node records: a node id the bundle replaces on every
  // read cannot be a binding.
  if (rec.kind === 'business-rule-node') throw invalid(where, 'binds a business-rule node');
  if (!nonempty(rec.id) || rec.id.length > 200 || /[<>]/.test(rec.id)) throw invalid(where, 'has no usable id');
  hashOrNull(rec.intentSha256, `${where}.intentSha256`, false);
  if (rec.origin !== 'created' && rec.origin !== 'adopted') throw invalid(where, 'has an origin other than created or adopted');
  if (rec.parentKey !== undefined && !nonempty(rec.parentKey)) throw invalid(where, 'has an empty parentKey');
  if (rec.partsSha256 !== undefined) {
    if (!isObj(rec.partsSha256)) throw invalid(where, 'has unreadable partsSha256');
    for (const [k, v] of Object.entries(rec.partsSha256)) hashOrNull(v, `${where}.partsSha256.${k}`, false);
  }
}

function validateRecords(records, root, header, where) {
  if (!Array.isArray(records)) throw invalid(where, 'is not a list');
  const keys = new Set();
  const ids = new Set();
  records.forEach((rec, i) => {
    validateRecord(rec, header, `${where}[${i}]`);
    const k = `${rec.kind}\u0000${rec.key}`;
    if (keys.has(k)) throw invalid(`${where}[${i}]`, 'repeats a (kind, key) of this group');
    keys.add(k);
    const id = rec.id.toLowerCase();
    if (id !== NOTES_CONTROL && ids.has(id)) throw invalid(`${where}[${i}]`, 'repeats an id of this group');
    ids.add(id);
    if (rec.kind === root.kind && rec.key === root.key && rec.id !== root.id) throw invalid(`${where}[${i}]`, 'binds the root to another id');
  });
  const recordKeys = new Set(records.map((r) => r.key));
  records.forEach((rec, i) => {
    if (rec.parentKey !== undefined && !recordKeys.has(rec.parentKey)) throw invalid(`${where}[${i}]`, 'names a parent this group does not hold');
  });
}

function validatePublication(pub, family, where, { attempt = false } = {}) {
  if (!PUBLISHING.has(family)) {
    if (pub !== null) throw invalid(where, 'is set for a family that is not published');
    return;
  }
  if (attempt) {
    if (pub === null) return;
    closedKeys(pub, ['scope', 'state'], where);
    if (pub.state !== 'owed') throw invalid(where, 'is not owed');
  } else {
    closedKeys(pub, ['scope', 'state', 'desiredSha256', 'dispatchToken'], where);
    if (!PUBLICATION_STATES.has(pub.state)) throw invalid(where, 'has an unknown state');
    hashOrNull(pub.desiredSha256, `${where}.desiredSha256`);
    // A dispatch token is written only in the branch that actually sends, so it exists exactly when a send may have run.
    const sent = pub.state === 'dispatching' || pub.state === 'unconfirmed' || pub.state === 'confirmed';
    if (sent) tokenField(pub.dispatchToken, `${where}.dispatchToken`); else if (pub.dispatchToken !== null) throw invalid(where, 'carries a dispatch token it never sent');
  }
  validateScope(pub.scope, `${where}.scope`);
  if (family === 'dashboard' && pub.scope.type !== 'dashboard') throw invalid(where, 'publishes a dashboard as a table');
  if (family !== 'dashboard' && pub.scope.type !== 'table') throw invalid(where, 'publishes a table artifact as a dashboard');
}

function validateExpected(exp, where) {
  closedKeys(exp, ['proofVersion', 'proofSchema', 'rootId', 'baseProofSha256', 'sentProjectionSha256', 'preservationSha256', 'baseObservation', 'children'], where);
  if (exp.proofVersion !== 1) throw invalid(where, 'has an unknown proof version');
  if (!nonempty(exp.proofSchema)) throw invalid(where, 'names no proof schema');
  guidField(exp.rootId, `${where}.rootId`);
  hashOrNull(exp.baseProofSha256, `${where}.baseProofSha256`);
  hashOrNull(exp.sentProjectionSha256, `${where}.sentProjectionSha256`, false);
  hashOrNull(exp.preservationSha256, `${where}.preservationSha256`, false);
  if (exp.baseObservation !== null) {
    closedKeys(exp.baseObservation, ['rowVersion', 'savedSha256'], `${where}.baseObservation`);
    if (exp.baseObservation.rowVersion !== null && !nonempty(exp.baseObservation.rowVersion)) throw invalid(`${where}.baseObservation`, 'has an empty row version');
    hashOrNull(exp.baseObservation.savedSha256, `${where}.baseObservation.savedSha256`);
  }
  if (!Array.isArray(exp.children)) throw invalid(where, 'has no child list');
  const seen = new Set();
  exp.children.forEach((c, i) => {
    const w = `${where}.children[${i}]`;
    closedKeys(c, ['kind', 'key', 'namespaceParentId', 'id', 'associationSha256'], w);
    if (!nonempty(c.kind) || !nonempty(c.key) || !nonempty(c.id)) throw invalid(w, 'is incomplete');
    if (c.kind === 'business-rule-node') throw invalid(w, 'expects a business-rule node');
    guidField(c.namespaceParentId, `${w}.namespaceParentId`);
    hashOrNull(c.associationSha256, `${w}.associationSha256`, false);
    const k = `${c.kind}\u0000${c.key}`;
    if (seen.has(k)) throw invalid(w, 'repeats a (kind, key)');
    seen.add(k);
  });
}

function validateGroup(g, header, where) {
  closedKeys(g, ['family', 'key', 'generation', 'previousGeneration', 'root', 'proofSchema', 'records', 'proof', 'consumerState', 'publication'], where);
  tokenField(g.generation, `${where}.generation`);
  tokenField(g.previousGeneration, `${where}.previousGeneration`, true);
  validateRoot(g.root, g.family, g.key, `${where}.root`);
  if (!nonempty(g.proofSchema)) throw invalid(where, 'names no proof schema');
  validateRecords(g.records, g.root, header, `${where}.records`);
  if (!g.records.some((r) => r.kind === g.root.kind && r.key === g.root.key)) throw invalid(where, 'holds no record of its root');
  validateProof(g.proof, `${where}.proof`);
  closedKeys(g.consumerState, CONSUMER_KEYS[g.family], `${where}.consumerState`);
  validateConsumerValue(g.consumerState, `${where}.consumerState`);
  validatePublication(g.publication, g.family, `${where}.publication`);
}

function validateAttempt(a, where) {
  closedKeys(a, ['family', 'key', 'token', 'baseGeneration', 'phase', 'root', 'knownScopes', 'declarationSha256', 'expected', 'acknowledgedRoot', 'savedObservation', 'publication', 'sendWindow'], where);
  tokenField(a.token, `${where}.token`);
  tokenField(a.baseGeneration, `${where}.baseGeneration`, true);
  if (!PHASES.has(a.phase)) throw invalid(where, 'has an unknown phase');
  validateRoot(a.root, a.family, a.key, `${where}.root`);
  if (!Array.isArray(a.knownScopes)) throw invalid(where, 'has no known scopes');
  a.knownScopes.forEach((s, i) => validateScope(s, `${where}.knownScopes[${i}]`));
  hashOrNull(a.declarationSha256, `${where}.declarationSha256`, false);
  // Only a prepared attempt may lack `expected`: nothing is sent before it is written (markSending).
  if (a.expected === null) {
    if (a.phase !== 'prepared') throw invalid(where, 'was sent without an expected proof');
  } else {
    validateExpected(a.expected, `${where}.expected`);
    if (a.expected.rootId !== a.root.id) throw invalid(where, 'expects another root');
  }
  if (typeof a.acknowledgedRoot !== 'boolean') throw invalid(where, 'has no acknowledged-root flag');
  if (a.savedObservation !== null) {
    closedKeys(a.savedObservation, ['phase', 'proof', 'acknowledgedRoot'], `${where}.savedObservation`);
    if (!PHASES.has(a.savedObservation.phase) || typeof a.savedObservation.acknowledgedRoot !== 'boolean') throw invalid(`${where}.savedObservation`, 'is incomplete');
    validateConsumerValue(a.savedObservation.proof, `${where}.savedObservation.proof`);
  }
  validatePublication(a.publication, a.family, `${where}.publication`, { attempt: true });
  // The send window (markSending with an observer; lib/managed-feature-contract.js createAttemptSendObserver). Absent on
  // an attempt sent without one — nothing then says what reached the service, and recovery only proves.
  //   { possible: 0, notStarted: 2 }  possible: mutations that reached the transport in the attempt's windows and were not
  //                                   answered by a not-started rejection (sent, answer pending or lost, or applied);
  //                                   notStarted: those the service answered with one.
  if (a.sendWindow !== undefined) {
    closedKeys(a.sendWindow, ['possible', 'notStarted'], `${where}.sendWindow`);
    for (const k of ['possible', 'notStarted']) if (!Number.isSafeInteger(a.sendWindow[k]) || a.sendWindow[k] < 0) throw invalid(`${where}.sendWindow.${k}`, 'is not a count');
    if (a.phase === 'prepared') throw invalid(where, 'has a send window but was never marked sending');
  }
}

// The frozen workflow mutation shapes (lib/workflow-effect-context.js classifies requests into them), with the method
// each is sent with and the effects it may carry.
const REQUEST_SHAPES = Object.freeze({
  'rule-create': Object.freeze({ method: 'POST', effects: Object.freeze(['create']) }),
  'rule-update': Object.freeze({ method: 'POST', effects: Object.freeze(['body']) }),
  'bpf-create': Object.freeze({ method: 'POST', effects: Object.freeze(['create']) }),
  'workflow-patch': Object.freeze({ method: 'PATCH', effects: Object.freeze(['body', 'state']) }),
});

function validateEffect(e, where) {
  closedKeys(e, ['token', 'attemptToken', 'baseGeneration', 'family', 'key', 'rowId', 'effect', 'request', 'desiredSha256', 'desiredState', 'expectedVersion', 'state', 'dispatchToken'], where);
  tokenField(e.token, `${where}.token`);
  tokenField(e.attemptToken, `${where}.attemptToken`);
  tokenField(e.baseGeneration, `${where}.baseGeneration`, true);
  if (e.family !== 'rule' && e.family !== 'bpf') throw invalid(where, 'is not a workflow family');
  if (!nonempty(e.key)) throw invalid(where, 'has no key');
  guidField(e.rowId, `${where}.rowId`);
  if (!EFFECTS.has(e.effect)) throw invalid(where, 'has an unknown effect');
  closedKeys(e.request, ['method', 'shape'], `${where}.request`);
  const shape = REQUEST_SHAPES[e.request.shape];
  if (!shape || shape.method !== e.request.method || !shape.effects.includes(e.effect)) throw invalid(`${where}.request`, 'is not a supported request shape for this effect');
  if ((e.request.shape === 'rule-create' || e.request.shape === 'rule-update') && e.family !== 'rule') throw invalid(`${where}.request`, 'is a rule request for another family');
  if (e.request.shape === 'bpf-create' && e.family !== 'bpf') throw invalid(`${where}.request`, 'is a process-flow request for another family');
  // A create or body effect is identified by the body it sends; a state effect by the state it asks for, and only that.
  if (e.effect === 'state') {
    if (e.desiredSha256 !== null) throw invalid(where, 'is a state effect with a body hash');
    if (!nonempty(e.desiredState)) throw invalid(where, 'is a state effect without a desired state');
  } else {
    hashOrNull(e.desiredSha256, `${where}.desiredSha256`, false);
    if (e.desiredState !== null) throw invalid(where, 'sets a desired state on a body or create effect');
  }
  // A create has no prior row, so it has no version to send; an edit of an existing row may carry one.
  if (e.effect === 'create' && e.expectedVersion !== null) throw invalid(where, 'is a create with a row version');
  if (e.expectedVersion !== null && !nonempty(e.expectedVersion)) throw invalid(where, 'has an empty row version');
  if (!EFFECT_STATES.has(e.state)) throw invalid(where, 'has an unknown state');
  if (e.state === 'definitely-unsent') { if (e.dispatchToken !== null) throw invalid(where, 'carries a dispatch token it never sent'); } else tokenField(e.dispatchToken, `${where}.dispatchToken`);
}

/**
 * Parse and validate the text of a store file. Returns { envelope, invalidGroups: Map(groupId -> message) }.
 * Throws `managed-binding-store-unreadable` for anything wrong outside one group.
 */
function parseEnvelope(text, expect) {
  let data;
  try {
    // JSON.parse accepts CRLF and LF alike; a BOM is the one prefix a Windows editor may add.
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (e) {
    throw storeError(CODES.unreadable, `the managed binding store is not valid JSON (${e.message})`);
  }
  closedKeys(data, ['schemaVersion', 'environmentFingerprint', 'appUniqueName', 'solutionUniqueName', 'revision', 'groups', 'attempts', 'workflowEffects'], 'the managed binding store');
  if (data.schemaVersion !== SCHEMA_VERSION) throw invalid('the managed binding store', `has schema version ${data.schemaVersion}, not ${SCHEMA_VERSION}`);
  if (data.environmentFingerprint !== expect.environmentFingerprint || data.appUniqueName !== expect.appUniqueName || data.solutionUniqueName !== expect.solutionUniqueName) {
    throw invalid('the managed binding store', 'belongs to another environment, app or solution');
  }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw invalid('the managed binding store', 'has no revision');
  for (const list of ['groups', 'attempts', 'workflowEffects']) if (!Array.isArray(data[list])) throw invalid('the managed binding store', `has no ${list} list`);

  const header = { appUniqueName: data.appUniqueName, environmentFingerprint: data.environmentFingerprint };
  const invalidGroups = new Map();
  const identity = (x, where) => {
    if (!isObj(x) || !FAMILIES.includes(x.family) || !nonempty(x.key)) throw invalid(where, 'has no family and key');
    return groupId(x.family, x.key);
  };
  const markInvalid = (id, e) => { if (!invalidGroups.has(id)) invalidGroups.set(id, e.message); };
  const groupIds = new Set();
  data.groups.forEach((g, i) => {
    const id = identity(g, `groups[${i}]`);
    if (groupIds.has(id)) throw invalid(`groups[${i}]`, 'repeats a group');
    groupIds.add(id);
    try { validateGroup(g, header, `groups[${i}]`); } catch (e) { markInvalid(id, e); }
  });
  const attemptIds = new Set();
  const attemptTokens = new Map();
  data.attempts.forEach((a, i) => {
    const id = identity(a, `attempts[${i}]`);
    // One attempt per group: a second would mean two different intents both waiting to be proved.
    if (attemptIds.has(id)) throw invalid(`attempts[${i}]`, 'repeats an attempt for one group');
    attemptIds.add(id);
    try {
      validateAttempt(a, `attempts[${i}]`);
      if (attemptTokens.has(a.token)) throw invalid(`attempts[${i}]`, 'repeats an attempt token');
      attemptTokens.set(a.token, a);
      const committed = data.groups.find((g) => groupId(g.family, g.key) === id);
      if ((committed ? committed.generation : null) !== a.baseGeneration) throw invalid(`attempts[${i}]`, 'is based on a generation the group does not have');
    } catch (e) { markInvalid(id, e); }
  });
  const effectTokens = new Set();
  data.workflowEffects.forEach((e, i) => {
    const where = `workflowEffects[${i}]`;
    const id = identity(e, where);
    // Ownership is checked for the whole file, not one group: an effect whose owner does not resolve, whose generation
    // differs from its owner's, or whose token repeats could settle another row's outcome, so the store is unreadable.
    if (isObj(e) && effectTokens.has(e.token)) throw invalid(where, 'repeats an effect token');
    if (isObj(e)) effectTokens.add(e.token);
    const owner = isObj(e) ? attemptTokens.get(e.attemptToken) : null;
    if (!owner || owner.family !== e.family || owner.key !== e.key) throw invalid(where, 'names no pending attempt of its group');
    if (owner.baseGeneration !== e.baseGeneration) throw invalid(where, 'names another generation than its attempt');
    // An effect changes its own attempt's row and no other: an attempt for one workflow cannot carry, and later settle
    // or block, a write of another.
    if (!isObj(owner.root) || typeof e.rowId !== 'string' || e.rowId !== owner.root.id) throw invalid(where, 'changes another row than its attempt\'s root');
    try {
      validateEffect(e, where);
      // An edit of a row the store already binds is an existing-row edit, and must say which version it edits.
      const bound = data.groups.find((g) => groupId(g.family, g.key) === id);
      if (e.effect !== 'create' && bound && bound.root.id === e.rowId && e.expectedVersion === null) throw invalid(where, 'edits an existing row without its version');
    } catch (err) { markInvalid(id, err); }
  });
  // Two roots that are one physical row would let two groups claim it: refuse the whole file, since neither group can
  // be trusted over the other. Attempts count too (a pending create may already hold the id).
  const rootOwner = new Map();
  const claim = (x, where) => {
    if (!isObj(x.root) || typeof x.root.id !== 'string') return;
    const k = `${NAMESPACE[x.family]}\u0000${x.root.id.toLowerCase()}`;
    const owner = rootOwner.get(k);
    const id = groupId(x.family, x.key);
    if (owner && owner !== id) throw invalid(where, `binds the ${NAMESPACE[x.family]} row ${x.root.id} that another group binds`);
    rootOwner.set(k, id);
  };
  data.groups.forEach((g, i) => claim(g, `groups[${i}]`));
  data.attempts.forEach((a, i) => claim(a, `attempts[${i}]`));
  return { envelope: data, invalidGroups };
}

function storeFileName(fp, appUniqueName, solutionUniqueName) {
  return `${PREFIX}${sha256(JSON.stringify([fp, String(appUniqueName).toLowerCase(), String(solutionUniqueName).toLowerCase()]))}.json`;
}

function resolveContext({ workspaceDir, environment, appUniqueName, solutionUniqueName }) {
  if (!nonempty(appUniqueName) || !nonempty(solutionUniqueName)) throw storeError(CODES.notSettled, 'the managed binding store needs the app and solution unique names');
  const fp = environmentFingerprint(environment);
  const root = workspaceRoot(workspaceDir, false);
  const file = storeFileName(fp, appUniqueName, solutionUniqueName);
  return { fp, root, file, full: root ? path.join(root, file) : null, expect: { environmentFingerprint: fp, appUniqueName, solutionUniqueName } };
}

/** Read the store file: null when it is absent, the parsed state otherwise. Throws for anything unsafe or invalid. */
function readStoreFile(ctx) {
  if (!ctx.full) return null;
  let st;
  try { st = fs.lstatSync(ctx.full); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw storeError(CODES.unreadable, `the managed binding store ${ctx.file} could not be inspected (${e.code || e.message})`);
  }
  // The file is the authority for rows the build may change: it must be the file that was named, not a link to
  // another (a symbolic link, a junction) or one of several names of the same file (a hard link).
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) throw storeError(CODES.unreadable, `the managed binding store ${ctx.file} is not a plain file`);
  if (st.size > MAX_BYTES) throw storeError(CODES.unreadable, `the managed binding store ${ctx.file} is larger than ${MAX_BYTES} bytes`);
  let text;
  try { text = fs.readFileSync(ctx.full, 'utf8'); } catch (e) {
    throw storeError(CODES.unreadable, `the managed binding store ${ctx.file} could not be read (${e.code || e.message})`);
  }
  const parsed = parseEnvelope(text, ctx.expect);
  return { ...parsed, sha256: sha256(canonicalJson(parsed.envelope)) };
}

function emptyEnvelope(expect) {
  return { schemaVersion: SCHEMA_VERSION, ...expect, revision: 0, groups: [], attempts: [], workflowEffects: [] };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); }
  return value;
}
const clone = (v) => JSON.parse(JSON.stringify(v));

function unitsOf(envelope, invalidGroups) {
  const units = new Map();
  const unit = (family, key) => {
    const id = groupId(family, key);
    if (!units.has(id)) units.set(id, { family, key, group: null, attempt: null, effects: [], invalid: invalidGroups.get(id) || null });
    return units.get(id);
  };
  for (const g of envelope.groups) unit(g.family, g.key).group = g;
  for (const a of envelope.attempts) unit(a.family, a.key).attempt = a;
  for (const e of envelope.workflowEffects) unit(e.family, e.key).effects.push(e);
  for (const id of invalidGroups.keys()) { const [family, key] = id.split('\u0000'); unit(family, key); }
  return [...units.values()];
}

function scopeKey(s) { return s.type === 'table' ? `table:${s.table}` : `dashboard:${s.id}`; }
function addScope(list, s) { if (s && !list.some((x) => scopeKey(x) === scopeKey(s))) list.push({ ...s }); }

/**
 * The one classification of a persisted group, used by the build's initializer and by the settlement wrapper alike.
 * Input: one unit of the store — { family, key, group, attempt, effects, invalid } (see `units` of a snapshot).
 * Result: { kind, targets: { scopes, ids }, token? } where `kind` is
 *   'corrupt'   the group failed validation: its overlap is withheld for this invocation;
 *   'uncertain' a publication or workflow effect may have been sent (dispatching/unconfirmed): withheld until a fresh
 *               proof confirms it without sending; `token` is the dispatch token;
 *   'hold'      an attempt is pending: withheld under the attempt's token until that attempt is proved and committed;
 *   'eligible'  a committed group owes a publication that was definitely not sent: no hold, one scoped publish allowed;
 *   'settled'   a committed group with nothing owed: no hold, no publish.
 * Healthy records install nothing, and eligible debt never gets a synthetic hold that nothing could release.
 */
function classifyPersisted(unit) {
  const scopes = [];
  const ids = [];
  const pushId = (id) => { if (typeof id === 'string' && !ids.includes(id.toLowerCase())) ids.push(id.toLowerCase()); };
  const { group, attempt, effects = [] } = unit || {};
  if (isObj(group)) {
    if (isObj(group.publication) && isObj(group.publication.scope)) addScope(scopes, group.publication.scope);
    if (isObj(group.root)) pushId(group.root.id);
  }
  if (isObj(attempt)) {
    for (const s of Array.isArray(attempt.knownScopes) ? attempt.knownScopes : []) if (isObj(s)) addScope(scopes, s);
    if (isObj(attempt.publication) && isObj(attempt.publication.scope)) addScope(scopes, attempt.publication.scope);
    if (isObj(attempt.root)) pushId(attempt.root.id);
  }
  for (const e of effects) if (isObj(e)) pushId(e.rowId);
  if (unit && unit.family === 'dashboard') for (const id of ids) addScope(scopes, { type: 'dashboard', id });
  const targets = { scopes, ids };
  if (unit && unit.invalid) return { kind: 'corrupt', targets };
  const uncertainEffect = effects.find((e) => UNCERTAIN.has(e.state));
  if (uncertainEffect) return { kind: 'uncertain', targets, token: uncertainEffect.dispatchToken };
  if (group && group.publication && UNCERTAIN.has(group.publication.state)) return { kind: 'uncertain', targets, token: group.publication.dispatchToken };
  if (attempt) return { kind: 'hold', targets, token: attempt.token };
  if (group && group.publication && group.publication.state === 'owed') return { kind: 'eligible', targets };
  return { kind: 'settled', targets };
}

function snapshotOf(state) {
  const envelope = deepFreeze(clone(state.envelope));
  const invalidGroups = new Map(state.invalidGroups);
  return Object.freeze({
    revision: envelope.revision,
    envelope,
    invalidGroups,
    units: () => unitsOf(envelope, invalidGroups),
  });
}

/**
 * Read-only discovery for a publishing or app-writing invocation. Never creates or changes the file.
 * Answers { absent: true } when there is no store, or { loaded: snapshot, debt: [{ family, key, ...classification }] }
 * listing every group that is not settled. Throws `managed-binding-store-unreadable` for a store it cannot trust.
 */
function discoverManagedStore(args) {
  const ctx = resolveContext(args);
  const state = readStoreFile(ctx);
  if (!state) return { absent: true };
  const loaded = snapshotOf(state);
  const debt = [];
  for (const unit of loaded.units()) {
    const c = classifyPersisted(unit);
    if (c.kind !== 'settled') debt.push({ family: unit.family, key: unit.key, ...c });
  }
  return { loaded, debt };
}

/**
 * Open the store of one environment, app and solution in a workspace. Nothing is created until the first write.
 * `barrier` (lib/publication-barrier.js) receives the scope registrations, holds and quarantines the handle forwards.
 * `deps`, for tests: `writeFileAtomic(path, text)` and `lease` (the record-lease.js deps).
 */
function openManagedBindings({ workspaceDir, environment, appUniqueName, solutionUniqueName, barrier = null, deps = {} }) {
  const ctx = resolveContext({ workspaceDir, environment, appUniqueName, solutionUniqueName });
  const write = typeof deps.writeFileAtomic === 'function' ? deps.writeFileAtomic : writeFileAtomic;
  let state = readStoreFile(ctx) || { envelope: emptyEnvelope(ctx.expect), invalidGroups: new Map(), sha256: null };

  const unitOf = (st, family, key) => unitsOf(st.envelope, st.invalidGroups).find((u) => u.family === family && u.key === key)
    || { family, key, group: null, attempt: null, effects: [], invalid: null };
  const usable = (unit) => {
    if (unit.invalid) throw storeError(CODES.groupInvalid, `the managed group ${unit.family} "${unit.key}" is not usable: ${unit.invalid}`);
    return unit;
  };
  const needBarrier = () => {
    if (!barrier) throw storeError(CODES.notSettled, 'the managed binding store was opened without the publication barrier');
    return barrier;
  };

  // One change: take the lease, reread the disk, apply `change` to a copy, write, reread and compare.
  function mutate(change) {
    const root = workspaceRoot(workspaceDir, true);
    const full = path.join(root, ctx.file);
    // A workspace created after the store was opened: later reads (refresh) must look at the file this write makes.
    ctx.root = root;
    ctx.full = full;
    const lease = withRecordLease(root, ctx.file, () => {
      const disk = readStoreFile({ ...ctx, root, full }) || { envelope: emptyEnvelope(ctx.expect), invalidGroups: new Map() };
      const next = clone(disk.envelope);
      const answer = change(next, disk);
      if (answer && typeof answer.then === 'function') throw storeError(CODES.notSettled, 'a managed binding change must be synchronous');
      next.revision = disk.envelope.revision + 1;
      const text = `${JSON.stringify(next, null, 2)}\n`;
      // Validate in memory before anything touches the disk: an invalid group may stay as it was, never become one.
      const checked = parseEnvelope(text, ctx.expect);
      for (const id of checked.invalidGroups.keys()) {
        if (!disk.invalidGroups.has(id)) throw storeError(CODES.groupInvalid, `a managed binding change would make ${id.replace('\u0000', ' ')} invalid: ${checked.invalidGroups.get(id)}`);
      }
      const wanted = sha256(canonicalJson(checked.envelope));
      try { write(full, text); } catch (e) {
        throw storeError(CODES.writeFailed, `the managed binding store could not be written (${e.code || e.message})`, { cause: e });
      }
      // Reopen and compare: the atomic writer redacts token-shaped text, so a write that changed an authoritative
      // field is a failure, and so is a file this process cannot read back. Never conclude the old file is intact.
      let reread;
      try { reread = readStoreFile({ ...ctx, root, full }); } catch (e) {
        throw storeError(CODES.writeFailed, `the managed binding store did not reopen clean after the write (${e.message})`, { cause: e });
      }
      if (!reread || reread.sha256 !== wanted) throw storeError(CODES.writeFailed, 'the managed binding store did not read back what was written');
      return { reread, answer };
    }, deps.lease);
    if (!lease.ok) throw storeError(CODES.busy, `the managed binding store is busy: ${lease.reason}`);
    state = lease.value.reread;
    return lease.value.answer;
  }

  const findAttempt = (env, token) => env.attempts.find((a) => a.token === token);
  const requireAttempt = (env, disk, token) => {
    const a = findAttempt(env, token);
    if (!a) throw storeError(CODES.conflict, 'the managed attempt is no longer pending in the store');
    usable(unitOf(disk, a.family, a.key));
    return a;
  };

  const handle = {
    get file() { return ctx.full; },
    snapshot() { return snapshotOf(state); },
    /** Re-read the file (another process may have changed it). */
    refresh() {
      state = readStoreFile(ctx) || { envelope: emptyEnvelope(ctx.expect), invalidGroups: new Map(), sha256: null };
      return snapshotOf(state);
    },
    lookup(kind, key) {
      // Which group a record belongs to is the caller's business: any group that holds (kind, key) answers, but only
      // when that group has no pending attempt — an older root must not authorize a plan past an interrupted change.
      for (const unit of unitsOf(state.envelope, state.invalidGroups)) {
        const rec = unit.group && !unit.invalid ? unit.group.records.find((r) => r.kind === kind && r.key === key) : null;
        const isRoot = unit.attempt && unit.attempt.root.kind === kind && unit.attempt.root.key === key;
        if (!rec && !isRoot && !(unit.invalid && unit.key === key)) continue;
        usable(unit);
        if (unit.attempt) throw storeError(CODES.pending, `the managed ${unit.family} "${unit.key}" has an attempt that must be proved first`);
        if (rec) return clone(rec);
      }
      return null;
    },
    readGroup(family, key) {
      const unit = usable(unitOf(state, family, key));
      return { committed: unit.group ? clone(unit.group) : null, pending: unit.attempt ? clone(unit.attempt) : null, effects: clone(unit.effects) };
    },
    prepareAttempt({ family, key, baseGeneration = null, revision, root, expected = null, knownScopes = [], declarationSha256, publication = null }) {
      const token = newToken();
      mutate((env, disk) => {
        if (revision !== undefined && revision !== disk.envelope.revision) throw storeError(CODES.conflict, `the managed binding store changed since the plan was made (revision ${disk.envelope.revision}, plan ${revision})`);
        const unit = usable(unitOf(disk, family, key));
        if (unit.attempt) throw storeError(CODES.pending, `the managed ${family} "${key}" already has a pending attempt`);
        if ((unit.group ? unit.group.generation : null) !== baseGeneration) throw storeError(CODES.conflict, `the managed ${family} "${key}" changed since the plan was made`);
        env.attempts.push({
          family, key, token, baseGeneration, phase: expected ? 'sending' : 'prepared', root, knownScopes, declarationSha256, expected,
          acknowledgedRoot: false, savedObservation: null, publication,
        });
      });
      return token;
    },
    /**
     * Persist the complete expected proof before the push. A failure here means the push is not sent. `observed`: the
     * caller sends this attempt's mutations through a send observer (createAttemptSendObserver), so the same write that
     * marks a prepared attempt sending arms its send window at zero. Only then: an attempt already sending keeps the
     * window it has, or none — a send that was not observed is never shown unsent afterwards.
     */
    markSending(token, expected, { observed = false } = {}) {
      mutate((env, disk) => {
        const a = requireAttempt(env, disk, token);
        if (a.expected !== null && canonicalJson(a.expected) !== canonicalJson(expected)) {
          throw storeError(CODES.completion, 'a sent attempt keeps the expected proof it was sent with');
        }
        a.expected = expected;
        if (a.phase === 'prepared') {
          a.phase = 'sending';
          if (observed === true) a.sendWindow = { possible: 0, notStarted: 0 };
        }
      });
    },
    /**
     * The send observer, synchronously before a mutation leaves the transport inside the attempt's window: count it as
     * possibly applied. A throw (the attempt is gone, the store cannot be written) leaves the request unsent. An attempt
     * with no window (sent unobserved) is left as it is: nothing it could say would make it provable.
     */
    noteAttemptDispatch(token) {
      mutate((env, disk) => {
        const a = requireAttempt(env, disk, token);
        if (a.sendWindow) a.sendWindow.possible += 1;
      });
    },
    /**
     * The send observer, after the service answered one counted mutation with a rejection that says it was not carried
     * out (lib/managed-feature-contract.js notStartedAnswer): move it from possible to notStarted. Nothing else lowers
     * `possible`, so a lost answer, a crash or a failed write here leaves the attempt possibly sent.
     */
    noteAttemptNotStarted(token) {
      mutate((env, disk) => {
        const a = requireAttempt(env, disk, token);
        if (!a.sendWindow || a.sendWindow.possible < 1) throw storeError(CODES.notSettled, 'the managed attempt has no counted send to answer');
        a.sendWindow.possible -= 1;
        a.sendWindow.notStarted += 1;
      });
    },
    noteSaved(token, { proof, acknowledgedRoot = false, phase = 'saved' } = {}) {
      if (phase !== 'saved' && phase !== 'state-pending' && phase !== 'membership-pending') throw storeError(CODES.notSettled, `noteSaved cannot move an attempt to ${phase}`);
      mutate((env, disk) => {
        const a = requireAttempt(env, disk, token);
        if (!a.expected) throw storeError(CODES.notSettled, 'an attempt cannot be saved before it was sent');
        // An acknowledged create is never forgotten by a later observation that lost the answer.
        a.acknowledgedRoot = a.acknowledgedRoot || acknowledgedRoot === true;
        a.savedObservation = { phase, proof: proof === undefined ? null : proof, acknowledgedRoot: a.acknowledgedRoot };
        a.phase = phase;
      });
    },
    /**
     * Replace the whole group of the attempt `token` with the observed complete set, remove the attempt, and bump the
     * revision — one atomic write. Records the old group held that this set omits are kept (removing a declaration
     * never forgets a row). A record whose id differs from the one the group or the expected proof holds, or an
     * expected child the set lacks, is `create-completion-required`: no substitute is bound.
     */
    commitGroup({ token, baseGeneration, records, proof, consumerState, publication = null, proofSchema }) {
      // The proposal is checked whole before anything else: a list that repeats a (kind, key) or an id must be refused,
      // not folded into a map where the last record silently wins, and a proof must carry every field it promises.
      try {
        if (!Array.isArray(records)) throw invalid('the proposed records', 'is not a list');
        const keys = new Set();
        const ids = new Set();
        records.forEach((rec, i) => {
          const where = `the proposed records[${i}]`;
          validateRecord(rec, ctx.expect, where);
          const k = `${rec.kind}\u0000${rec.key}`;
          if (keys.has(k)) throw invalid(where, `repeats ${rec.kind} "${rec.key}"`);
          keys.add(k);
          const id = rec.id.toLowerCase();
          if (id !== NOTES_CONTROL && ids.has(id)) throw invalid(where, `repeats the id ${rec.id}`);
          ids.add(id);
        });
        validateProof(proof, 'the proposed proof');
      } catch (e) {
        throw storeError(CODES.groupInvalid, `a managed group commit was refused before it was written: ${e.message}`);
      }
      let committed;
      mutate((env, disk) => {
        const a = requireAttempt(env, disk, token);
        if (a.baseGeneration !== baseGeneration) throw storeError(CODES.conflict, 'the managed attempt is based on another generation');
        if (!a.expected) throw storeError(CODES.notSettled, 'an attempt that was never sent has nothing to commit');
        const effects = env.workflowEffects.filter((e) => e.attemptToken === token);
        // Every workflow effect this attempt owns retires in this same write, so none must still be open: an effect
        // that may have reached the server must be proved first. The refusal leaves the attempt and its effects as
        // they are, and no other attempt's effects are read or touched.
        if (effects.some((e) => e.state !== 'confirmed')) throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" has a workflow effect that is not confirmed`);
        const old = env.groups.find((g) => g.family === a.family && g.key === a.key) || null;
        const merged = [];
        const byKey = new Map();
        for (const rec of records || []) byKey.set(`${rec.kind}\u0000${rec.key}`, rec);
        for (const rec of old ? old.records : []) {
          const k = `${rec.kind}\u0000${rec.key}`;
          const next = byKey.get(k);
          if (!next) { merged.push(rec); continue; }
          if (String(next.id).toLowerCase() !== String(rec.id).toLowerCase()) {
            throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" would bind ${rec.kind} "${rec.key}" to another row than it holds`);
          }
          merged.push({ ...next, origin: rec.origin === 'adopted' ? 'adopted' : next.origin });
          byKey.delete(k);
        }
        const acknowledged = a.acknowledgedRoot || !!(a.savedObservation && a.savedObservation.acknowledgedRoot);
        for (const rec of byKey.values()) {
          // A new record claims `created` only on this attempt's acknowledged create; a lost answer needs adoption.
          if (rec.origin === 'created' && !acknowledged) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" cannot record ${rec.kind} "${rec.key}" as created without an acknowledged create`);
          // A child the group did not hold before is bound only when the expected proof, persisted before the send,
          // named it under that id: an observation cannot add a binding the attempt never said it would make.
          const isRoot = rec.kind === a.root.kind && rec.key === a.root.key;
          const planned = isRoot || a.expected.children.some((c) => c.kind === rec.kind && c.key === rec.key && String(c.id).toLowerCase() === String(rec.id).toLowerCase());
          if (!planned) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" would bind ${rec.kind} "${rec.key}", which its expected proof does not name`);
          merged.push(rec);
        }
        const rootRec = merged.find((r) => r.kind === a.root.kind && r.key === a.root.key);
        if (!rootRec || String(rootRec.id).toLowerCase() !== a.root.id) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" root was not observed under its expected id`);
        for (const child of a.expected.children) {
          const got = merged.find((r) => r.kind === child.kind && r.key === child.key);
          if (!got || String(got.id).toLowerCase() !== String(child.id).toLowerCase()) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" lacks the expected ${child.kind} "${child.key}"`);
        }
        // Uncertainty about an earlier publish survives the commit; only a fresh proof (confirmPublished) ends it.
        let pub = publication;
        if (old && old.publication && UNCERTAIN.has(old.publication.state)) pub = old.publication;
        committed = {
          family: a.family, key: a.key, generation: newToken(), previousGeneration: old ? old.generation : null,
          root: a.root, proofSchema: proofSchema || a.expected.proofSchema, records: merged, proof, consumerState, publication: pub,
        };
        env.groups = env.groups.filter((g) => g !== old);
        env.groups.push(committed);
        env.attempts = env.attempts.filter((x) => x !== a);
        env.workflowEffects = env.workflowEffects.filter((e) => e.attemptToken !== token);
      });
      return clone(committed);
    },
    /** Mark the owed publication of `groups` dispatching under `token`, immediately before the one send. */
    markPublishDispatch({ groups, scope, token }) {
      tokenField(token, 'the dispatch token');
      mutate((env, disk) => {
        for (const { family, key } of groups) {
          const unit = usable(unitOf(disk, family, key));
          if (unit.attempt) throw storeError(CODES.pending, `the managed ${family} "${key}" has a pending attempt`);
          const g = env.groups.find((x) => x.family === family && x.key === key);
          if (!g || !g.publication || g.publication.state !== 'owed' || g.publication.dispatchToken !== null) throw storeError(CODES.notSettled, `the managed ${family} "${key}" owes no unsent publication`);
          if (scopeKey(g.publication.scope) !== scopeKey(scope)) throw storeError(CODES.notSettled, `the managed ${family} "${key}" is published in another scope`);
          g.publication.state = 'dispatching';
          g.publication.dispatchToken = token;
        }
      });
    },
    /**
     * After the send: 'definite-no-start' returns the debt to owed; 'unconfirmed' keeps it uncertain. A debt of the send
     * that a fresh read already confirmed (confirmUncertainPublication, while this send's answer was outstanding) stays
     * confirmed: an outcome that arrives later is not evidence against a read that proved the layer live.
     */
    notePublishOutcome({ token, outcome }) {
      if (outcome !== 'definite-no-start' && outcome !== 'unconfirmed') throw storeError(CODES.notSettled, `unknown publish outcome ${outcome}`);
      mutate((env) => {
        const owned = env.groups.filter((g) => g.publication && g.publication.dispatchToken === token);
        if (!owned.length) throw storeError(CODES.notSettled, 'no publication was dispatched under this token');
        for (const g of owned) {
          if (g.publication.state === 'confirmed') continue;
          if (outcome === 'definite-no-start') { g.publication.state = 'owed'; g.publication.dispatchToken = null; } else g.publication.state = 'unconfirmed';
        }
      });
    },
    /**
     * A fresh published read equals what was owed: end the debt without sending. `token` is the dispatch token the
     * debt carries (null for debt that was never sent, which becomes not-needed). `proof.publishedSha256` must equal
     * the debt's desired hash when it has one; a group may carry its own `publishedSha256`, which wins, so the groups
     * of one send are confirmed in one atomic write. A group may also name the `generation` its read was judged
     * against: a group committed again since then is `managed-binding-generation-conflict`, and nothing is confirmed.
     */
    confirmPublished({ groups, token = null, proof = {} }) {
      mutate((env) => {
        for (const entry of groups) {
          const { family, key } = entry;
          const published = typeof entry.publishedSha256 === 'string' ? entry.publishedSha256 : proof.publishedSha256;
          const g = env.groups.find((x) => x.family === family && x.key === key);
          if (!g || !g.publication) throw storeError(CODES.notSettled, `the managed ${family} "${key}" has no publication`);
          if (entry.generation !== undefined && g.generation !== entry.generation) throw storeError(CODES.conflict, `the managed ${family} "${key}" was committed again since its published layer was read`);
          if (g.publication.dispatchToken !== token) throw storeError(CODES.notSettled, `the managed ${family} "${key}" publication carries another dispatch token`);
          if (g.publication.desiredSha256 && published !== g.publication.desiredSha256) throw storeError(CODES.notSettled, `the managed ${family} "${key}" published layer does not equal what was owed`);
          if (g.publication.state === 'owed') g.publication.state = 'not-needed';
          else if (UNCERTAIN.has(g.publication.state)) g.publication.state = 'confirmed';
        }
      });
    },
    /**
     * Retire the attempt `token` when its record proves no protected mutation started: phase `prepared`, never marked
     * sending, no expected proof, no acknowledgement or saved observation, and every workflow effect it owns still
     * definitely-unsent with no dispatch token. Under the record lease the file is reread, and the attempt must still be
     * based on `baseGeneration`, which must still be the group's generation. One write removes only that attempt and
     * the effects it owns; the committed group, its publication debt and every other attempt and effect stay. Then,
     * and only after the write, its own hold ends — a quarantine or an uncertain-send block is never cleared.
     * A `sending` attempt is never retired (it may have reached the service; runManagedFeature recovers or resumes it),
     * and a later read that finds nothing is not evidence that nothing started: `managed-settlement-pending`.
     * Answers { retired: true, effects } (the count of effect records removed with it).
     */
    retireUnsentAttempt({ token, baseGeneration } = {}) {
      if (typeof token !== 'string' || !token) throw storeError(CODES.notSettled, 'retireUnsentAttempt needs the attempt token');
      if (baseGeneration === undefined) throw storeError(CODES.notSettled, 'retireUnsentAttempt needs the generation the attempt was based on');
      let removed = 0;
      mutate((env, disk) => {
        const a = requireAttempt(env, disk, token);
        if (a.baseGeneration !== baseGeneration) throw storeError(CODES.conflict, 'the managed attempt is based on another generation');
        const g = env.groups.find((x) => x.family === a.family && x.key === a.key);
        if ((g ? g.generation : null) !== baseGeneration) throw storeError(CODES.conflict, `the managed ${a.family} "${a.key}" changed since the attempt was prepared`);
        if (a.phase !== 'prepared' || a.expected !== null || a.acknowledgedRoot || a.savedObservation !== null) {
          throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" attempt may have been sent; it is recovered, never retired`);
        }
        const owned = env.workflowEffects.filter((e) => e.attemptToken === token);
        if (owned.some((e) => e.state !== 'definitely-unsent' || e.dispatchToken !== null)) {
          throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" attempt has a workflow effect that may have been sent`);
        }
        removed = owned.length;
        env.attempts = env.attempts.filter((x) => x !== a);
        env.workflowEffects = env.workflowEffects.filter((e) => e.attemptToken !== token);
      });
      // The write is durable and read back (mutate): only now may the attempt's own hold end. A store opened without the
      // barrier has no hold to end; the caller releases its own.
      if (barrier) barrier.release(token);
      return { retired: true, effects: removed };
    },
    /**
     * Persist one workflow effect as definitely-unsent; it must belong to the pending attempt `attemptToken`.
     * The same effect asked for again by the same attempt (every field that says what it is equal), while its record is
     * still definitely-unsent with no dispatch token, answers that record instead of a second one: it never started, so
     * a resumed create or a continued attempt (recoverManagedAttempt) sends it under its own token. Any other unsettled
     * effect of the same kind on the row is refused.
     */
    recordWorkflowEffect(effect) {
      const request = isObj(effect.request) ? { method: String(effect.request.method || '').toUpperCase(), shape: effect.request.shape } : effect.request;
      const rec = {
        token: newToken(), attemptToken: effect.attemptToken, baseGeneration: effect.baseGeneration === undefined ? null : effect.baseGeneration,
        family: effect.family, key: effect.key, rowId: normalizeGuid(effect.rowId) || effect.rowId, effect: effect.effect, request,
        desiredSha256: effect.desiredSha256 === undefined ? null : effect.desiredSha256, desiredState: effect.desiredState === undefined ? null : effect.desiredState,
        expectedVersion: effect.expectedVersion === undefined ? null : effect.expectedVersion, state: 'definitely-unsent', dispatchToken: null,
      };
      const same = (e) => canonicalJson([e.attemptToken, e.baseGeneration, e.family, e.key, e.rowId, e.effect, e.request, e.desiredSha256, e.desiredState, e.expectedVersion])
        === canonicalJson([rec.attemptToken, rec.baseGeneration, rec.family, rec.key, rec.rowId, rec.effect, rec.request, rec.desiredSha256, rec.desiredState, rec.expectedVersion]);
      let reused = null;
      mutate((env, disk) => {
        const a = requireAttempt(env, disk, rec.attemptToken);
        if (a.family !== rec.family || a.key !== rec.key) throw storeError(CODES.notSettled, 'a workflow effect must belong to its own attempt');
        if (a.baseGeneration !== rec.baseGeneration) throw storeError(CODES.conflict, 'a workflow effect must name its attempt\'s generation');
        if (rec.rowId !== a.root.id) throw storeError(CODES.notSettled, `a workflow effect changes its attempt's own row ${a.root.id}, not ${rec.rowId}`);
        const open = env.workflowEffects.filter((e) => e.rowId === rec.rowId && e.effect === rec.effect && e.state !== 'confirmed');
        if (open.length === 1 && open[0].state === 'definitely-unsent' && open[0].dispatchToken === null && same(open[0])) { reused = clone(open[0]); return; }
        if (open.length) throw storeError(CODES.pending, `the workflow row ${rec.rowId} already has an unsettled ${rec.effect} effect`);
        env.workflowEffects.push(rec);
      });
      return reused || clone(rec);
    },
    markEffectDispatching(token, dispatchToken) {
      tokenField(dispatchToken, 'the dispatch token');
      mutate((env) => {
        const e = env.workflowEffects.find((x) => x.token === token);
        if (!e || e.state !== 'definitely-unsent') throw storeError(CODES.notSettled, 'the workflow effect is not waiting to be sent');
        e.state = 'dispatching';
        e.dispatchToken = dispatchToken;
      });
    },
    noteEffectOutcome(token, outcome) {
      if (outcome !== 'definite-no-start' && outcome !== 'unconfirmed') throw storeError(CODES.notSettled, `unknown effect outcome ${outcome}`);
      mutate((env) => {
        const e = env.workflowEffects.find((x) => x.token === token);
        if (!e || !UNCERTAIN.has(e.state)) throw storeError(CODES.notSettled, 'the workflow effect was not dispatched');
        if (outcome === 'definite-no-start') { e.state = 'definitely-unsent'; e.dispatchToken = null; } else e.state = 'unconfirmed';
      });
    },
    /** A fresh read proved the effect's desired body (create, body) or state on its row: confirm it without sending again. */
    confirmEffect(token, { observedSha256, observedState } = {}) {
      mutate((env) => {
        const e = env.workflowEffects.find((x) => x.token === token);
        if (!e || e.state === 'definitely-unsent') throw storeError(CODES.notSettled, 'the workflow effect was not dispatched');
        const proved = e.effect === 'state' ? observedState === e.desiredState : observedSha256 === e.desiredSha256;
        if (!proved) throw storeError(CODES.notSettled, 'the observed workflow row does not prove the effect');
        e.state = 'confirmed';
      });
    },
    // The barrier operations, forwarded so one handle carries the whole contract of a managed feature.
    registerKnown(scopes, ids) { return needBarrier().registerKnown(scopes, ids); },
    hold(token, scopes, ids, label) { return needBarrier().hold(token, scopes, ids, label); },
    release(token) { return needBarrier().release(token); },
    quarantine(scopes, ids, label) { return needBarrier().quarantine(scopes, ids, label); },
    allowScope(scope, path) { return needBarrier().allowScope(scope, path); },
    blockScope(scope, label) { return needBarrier().blockScope(scope, label); },
    withSendPermit(permit, fn) { return needBarrier().withSendPermit(permit, fn); },
  };
  return handle;
}

/**
 * The only opener a build uses. Reuses `existing` (a handle the CLI already opened) instead of opening a second writer.
 * Discovery is read-only: a missing file creates nothing and installs nothing. An existing file is classified unit by
 * unit with classifyPersisted, and the barrier gets: every target registered; a token-owned hold for a pending attempt
 * (released only by the recovery of that attempt); a block for the rest of this invocation for uncertain and corrupt
 * groups. A settled group or eligible debt installs nothing. Answers { store, debt, absent }.
 */
function openManagedContext({ workspaceDir, environment, appUniqueName, solutionUniqueName, existing = null, barrier = null, deps } = {}) {
  if (existing) return existing;
  const found = discoverManagedStore({ workspaceDir, environment, appUniqueName, solutionUniqueName });
  const store = openManagedBindings({ workspaceDir, environment, appUniqueName, solutionUniqueName, barrier, deps });
  const debt = found.absent ? [] : found.debt;
  if (barrier) {
    for (const d of debt) {
      const { scopes, ids } = d.targets;
      barrier.registerKnown(scopes, ids);
      const label = `managed ${d.family} "${d.key}"`;
      if (d.kind === 'hold') barrier.hold(d.token, scopes, ids, `${label} (an earlier change is not yet proved)`);
      else if (d.kind === 'uncertain') barrier.quarantine(scopes, ids, `${label} (a publish or workflow change may have been sent and is not yet confirmed)`);
      else if (d.kind === 'corrupt') {
        // A group whose targets cannot be read cannot be fenced by scope: nothing it may cover can be shown safe.
        if (!scopes.length) throw storeError(CODES.unreadable, `${label} is not usable and names no scope the build could withhold`);
        barrier.quarantine(scopes, ids, `${label} (its stored record is not usable)`);
      }
    }
  }
  return { store, debt, absent: !!found.absent };
}

/**
 * What verify and download may read: the committed, usable groups and their declarations. Pending and invalid groups
 * are listed apart and are not verified. Pure: it reads the snapshot it is given and never writes.
 */
function managedManifestView(snapshot) {
  const view = { revision: snapshot ? snapshot.revision : 0, groups: [], pending: [], invalid: [] };
  if (!snapshot) return view;
  for (const unit of snapshot.units()) {
    if (unit.invalid) { view.invalid.push({ family: unit.family, key: unit.key, reason: unit.invalid }); continue; }
    if (unit.attempt) { view.pending.push({ family: unit.family, key: unit.key, code: CODES.pending }); continue; }
    if (!unit.group) continue;
    const g = unit.group;
    view.groups.push({
      family: g.family, key: g.key, generation: g.generation, root: clone(g.root), proofSchema: g.proofSchema,
      records: clone(g.records), proof: clone(g.proof),
      declaration: g.consumerState && g.consumerState.declaration !== undefined ? clone(g.consumerState.declaration) : undefined,
    });
  }
  return view;
}

module.exports = {
  PREFIX,
  MAX_BYTES,
  CODES,
  FAMILIES,
  ROOT_KIND,
  storeFileName,
  parseEnvelope,
  classifyPersisted,
  discoverManagedStore,
  openManagedBindings,
  openManagedContext,
  managedManifestView,
  REQUEST_SHAPES,
};

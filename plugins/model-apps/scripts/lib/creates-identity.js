'use strict';
// Stable create identities: the id a supported create is sent with, RECOMPUTED from the spec every time it is needed and never stored.
//
// Why recomputed: an answer to a create can be lost after the row committed (a dropped connection, a write timeout). A build that mints
// a random id again on its next run cannot recognise that row, so it creates a second one. An id computed from what the spec says —
// the solution, the table or app, the kind of artifact and its key — is the same in every process, workspace and machine, so the next
// run asks the server for THAT id before it looks anything up by name, and a re-send of the create meets the same primary key. Nothing
// is written to disk to make this work, so nothing can be lost, stale or forged.
//
// The algorithm is FROZEN (version 1). tests/creates-identity.test.js pins exact UUIDs for every scope, kind and child kind: a change to
// any byte of the input array, the namespace or a canonicalisation rule changes those UUIDs, which would silently re-key every artifact
// already created with the old ones. A future algorithm must be a new version beside this one, never an edit of it.
//
//   root  = UUIDv5(NAMESPACE, UTF-8(JSON.stringify(['model-apps.create', 1, scopeKind, ...scopeParts, kind, ...keyParts])))
//   child = UUIDv5(actualParentId, UTF-8(JSON.stringify(['child', 1, childKind, ...childKeyParts])))
//
// A fixed-order JSON array is the input so that no delimiter can be smuggled into a part ('a|b' + 'c' vs 'a' + 'b|c') and so that the
// order of an object's members cannot change it. The input deliberately holds NO environment, tenant, principal, secret, value or
// content, path, time, attempt counter or random salt: the same spec must give the same id everywhere it is built, and an id must not
// carry anything that is not already in the spec.
//
// A predictable id is not a secret, a receipt or ownership: anyone who can read the spec can compute it. Finding a row at it proves only
// that a row is there; whether this build may change or delete that row is decided by the consumer's own ownership rules.
//
// UUID version 5 (SHA-1 name-based) is the standard construction for this: https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-5
// SHA-1 here is a naming hash, not authentication. Dataverse accepts a client-supplied primary key on create:
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-table-row#setting-the-primary-key-value

const { createHash } = require('node:crypto');
const { dashboardNameKey } = require('./app-spec.js');

const ALGORITHM_VERSION = 1;
const ACTIVATION_VALUE = 'stable-v1';

// RFC 9562 §6.6: the predefined URL namespace.
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const NAMESPACE_URL = 'https://github.com/microsoft/power-platform-skills/model-apps/create-identity/v1';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The typed stop every identity refusal carries. `transient: false` is what retry-policy.js reads as "a run again cannot change this"
// (its rule 1), so an identity stop never starts another whole-build attempt.
class CreateIdentityError extends Error {
  constructor(code, message, { create, cause, detail } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CreateIdentityError';
    this.code = code;
    this.transient = false;
    if (create !== undefined) this.create = create;
    if (detail !== undefined) this.detail = detail;
  }
}

// The closed set of stop codes (each exits the build with 1; none is retried):
//   create-identity-invalid       a bad scope, key, activation value or unsupported version, found before anything is sent
//   create-identity-conflict      the saved row's context or content is incompatible, or a different-id row holds the name
//   create-identity-unverified    a saved read could not establish what is there (denied, malformed, partial, failed page)
//   create-completion-required    the identity was found or sent, but its parent, children or state are not proven complete
//   create-ownership-required     the row exists, and the change it needs is not this build's to make
//   create-identity-unsupported   the kind, or the SDK's caller-id contract it needs, is not available
//   create-outcome-unknown        a surfaced ambiguous primary write with no identity to resolve it by; never sent again automatically
const CREATE_STOP_CODES = Object.freeze([
  'create-identity-invalid',
  'create-identity-conflict',
  'create-identity-unverified',
  'create-completion-required',
  'create-ownership-required',
  'create-identity-unsupported',
  'create-outcome-unknown',
]);

function createStop(code, message, extra) {
  if (!CREATE_STOP_CODES.includes(code)) throw new TypeError(`createStop: unknown code '${code}'`);
  return new CreateIdentityError(code, message, extra);
}

function invalid(message, extra) {
  return new CreateIdentityError('create-identity-invalid', message, extra);
}

function guidBytes(guid) {
  if (typeof guid !== 'string' || !GUID_RE.test(guid)) throw invalid(`create identity: '${guid}' is not a GUID`);
  return Buffer.from(guid.replace(/-/g, ''), 'hex');
}

function formatGuid(bytes) {
  const h = Buffer.from(bytes).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// RFC 9562 §5.5: SHA-1 over namespace bytes then name bytes; the first 16 bytes, version nibble 5, variant bits 10.
function uuidV5(namespace, name) {
  const hash = createHash('sha1').update(guidBytes(namespace)).update(Buffer.isBuffer(name) ? name : Buffer.from(String(name), 'utf8')).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatGuid(bytes);
}

const NAMESPACE = uuidV5(URL_NAMESPACE, NAMESPACE_URL);

// ---- canonical key parts --------------------------------------------------------------------------------------------------------
// The caller decides WHICH rule a part follows, by building it with one of these; the identity functions accept only their output
// (strings and integers), so a part can never be canonicalised twice or by the wrong rule.

// A logical, schema or unique name (table, column, solution, app, custom API, variable schema name): ASCII-lowercased, because
// Dataverse compares these case-insensitively. Surrounding whitespace is REJECTED rather than trimmed — an invalid name must fail the
// spec's validation, not be silently repaired into some other artifact's identity.
const IDENTIFIER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
function identifierPart(value, what = 'name') {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) throw invalid(`create identity: ${what} '${value}' is not a valid logical name`);
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// A display name of an artifact Dataverse looks up by name (a view, form, chart or dashboard without an explicit key): the same
// measured folding the build's name lookups use (app-spec.js dashboardNameKey — case, accents, widths, trailing spaces), so two
// names the server treats as one artifact give one identity. Not a generic trim/lowercase/NFC.
function nameKeyPart(value, what = 'name') {
  if (typeof value !== 'string' || !value) throw invalid(`create identity: ${what} must be a non-empty string`);
  const key = dashboardNameKey(value);
  if (!key) throw invalid(`create identity: ${what} '${value}' has no characters that identify it`);
  return key;
}

// An explicit stable key a new feature declaration carries: the validator's output, byte for byte. No second trim, case or Unicode
// conversion — the spec's duplicate-key validation applies this same function, so what it calls distinct stays distinct here.
function stableKeyPart(value, what = 'key') {
  if (typeof value !== 'string' || !value) throw invalid(`create identity: ${what} must be a non-empty string`);
  return value;
}

// A validated subtype (a query type, a form type, a dashboard scope): kept as the integer or enum string it is.
function subtypePart(value, what = 'subtype') {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(value)) return value;
  throw invalid(`create identity: ${what} '${value}' is not a subtype`);
}

// An absent entity of a global (scope-wide) artifact, such as a dashboard that is not bound to a table.
function entityOrEmptyPart(value) {
  return value === undefined || value === null || value === '' ? '' : identifierPart(value, 'table');
}

// ---- the registry of scopes and kinds --------------------------------------------------------------------------------------------

const SCOPE_KINDS = Object.freeze({
  solution: Object.freeze(['solution']),
  table: Object.freeze(['solution', 'table']),
  app: Object.freeze(['solution', 'app']),
});

// Root kind → its scope(s) and the arity of its key. `min`/`max` count key parts after the scope.
const ROOT_KINDS = Object.freeze({
  view: Object.freeze({ scopes: ['table'], min: 2, max: 2 }), // [queryType, key]
  form: Object.freeze({ scopes: ['table'], min: 2, max: 2 }), // [formType, key]
  chart: Object.freeze({ scopes: ['table'], min: 1, max: 1 }),
  dashboard: Object.freeze({ scopes: ['solution'], min: 3, max: 3 }), // [scopeType, entityOrEmpty, key]
  businessRule: Object.freeze({ scopes: ['table'], min: 1, max: 1 }),
  bpf: Object.freeze({ scopes: ['table'], min: 1, max: 1 }),
  // The app's unique name is already in its scope and is not repeated.
  app: Object.freeze({ scopes: ['app'], min: 0, max: 0 }),
  // [context, location, ...ancestorKeys, controlKey]; a table-context command is table-scoped, an app-context one app-scoped.
  appaction: Object.freeze({ scopes: ['table', 'app'], min: 3, max: 16 }),
  genPage: Object.freeze({ scopes: ['app'], min: 1, max: 1 }),
  fieldSecurityProfile: Object.freeze({ scopes: ['solution'], min: 1, max: 1 }),
  environmentVariable: Object.freeze({ scopes: ['solution'], min: 1, max: 1 }),
  connectionReference: Object.freeze({ scopes: ['solution'], min: 1, max: 1 }),
  customApi: Object.freeze({ scopes: ['solution'], min: 1, max: 1 }),
  duplicateRule: Object.freeze({ scopes: ['solution'], min: 1, max: 1 }),
});

const CHILD_KINDS = Object.freeze({
  sitemap: Object.freeze({ min: 0, max: 0 }),
  fieldPermission: Object.freeze({ min: 2, max: 2 }), // [table, column]
  environmentVariableValue: Object.freeze({ min: 1, max: 1 }), // ['value']
  customApiRequestParameter: Object.freeze({ min: 1, max: 1 }), // [lower uniqueName]
  customApiResponseProperty: Object.freeze({ min: 1, max: 1 }), // [lower uniqueName]
  duplicateRuleCondition: Object.freeze({ min: 1, max: 1 }), // [condition.key bytes]
  bpfStage: Object.freeze({ min: 1, max: 1 }), // [stageKey]
  bpfStep: Object.freeze({ min: 2, max: 2 }), // [stageKey, stepKey]
  // The ids a declared form or dashboard keeps inside its saved document (creates-catalog.js reserveChildren decides each part and
  // its canonical rule). Added beside the kinds above: no existing kind's input bytes change, so no id already created moves.
  formTab: Object.freeze({ min: 1, max: 1 }), // [tabKey]
  formSection: Object.freeze({ min: 2, max: 2 }), // [tabKey, sectionKey]
  formCell: Object.freeze({ min: 2, max: 2 }), // [formKey, field logical name]
  formControl: Object.freeze({ min: 2, max: 2 }), // [formKey, field logical name]
  formHostSection: Object.freeze({ min: 2, max: 2 }), // [hostClass, hostKey]
  formHostCell: Object.freeze({ min: 2, max: 2 }), // [hostClass, hostKey]
  formHostControl: Object.freeze({ min: 2, max: 2 }), // [hostClass, hostKey]
  formSpacer: Object.freeze({ min: 1, max: 1 }), // [spacerSlot]
  dashboardSeedTab: Object.freeze({ min: 1, max: 1 }), // ['seed-tab']
  dashboardSeedSection: Object.freeze({ min: 1, max: 1 }), // ['seed-section']
  dashboardCell: Object.freeze({ min: 2, max: 2 }), // [tileKey, 'cell']
  dashboardControl: Object.freeze({ min: 2, max: 2 }), // [tileKey, 'control']
});

function isPart(p) {
  return (typeof p === 'string' && p.length > 0) || p === '' || (Number.isSafeInteger(p) && p >= 0);
}

function checkParts(parts, { min, max }, what) {
  if (!Array.isArray(parts)) throw invalid(`create identity: ${what} must be an array`);
  if (parts.length < min || parts.length > max) throw invalid(`create identity: ${what} has ${parts.length} part(s); expected ${min === max ? min : `${min}–${max}`}`);
  if (!parts.every(isPart)) throw invalid(`create identity: every part of ${what} must be a string or a non-negative integer`);
}

// Validates a root identity spec — { scope: { kind, solution, table?, app? }, kind, keyParts } — and answers its canonical scope parts.
// The scope's names are canonicalised here (they are always logical/unique names); keyParts must already be canonical.
function validateCreateIdentitySpec(spec) {
  if (!spec || typeof spec !== 'object') throw invalid('create identity: the spec must be an object');
  const rule = Object.prototype.hasOwnProperty.call(ROOT_KINDS, spec.kind) ? ROOT_KINDS[spec.kind] : undefined;
  if (!rule) throw new CreateIdentityError('create-identity-unsupported', `create identity: '${spec.kind}' is not a kind with a stable identity`);
  const scope = spec.scope;
  if (!scope || typeof scope !== 'object' || !Object.prototype.hasOwnProperty.call(SCOPE_KINDS, scope.kind)) throw invalid(`create identity: ${spec.kind} has no scope`);
  if (!rule.scopes.includes(scope.kind)) throw invalid(`create identity: ${spec.kind} is not ${scope.kind}-scoped`);
  const scopeParts = SCOPE_KINDS[scope.kind].map((field) => identifierPart(scope[field], `${scope.kind} scope ${field}`));
  checkParts(spec.keyParts, rule, `the key of ${spec.kind}`);
  return { scopeKind: scope.kind, scopeParts, kind: spec.kind, keyParts: spec.keyParts.slice() };
}

function rootInput(spec) {
  const v = validateCreateIdentitySpec(spec);
  return ['model-apps.create', ALGORITHM_VERSION, v.scopeKind, ...v.scopeParts, v.kind, ...v.keyParts];
}

function stableCreateIdV1(spec) {
  return uuidV5(NAMESPACE, Buffer.from(JSON.stringify(rootInput(spec)), 'utf8'));
}

// A child is derived under its ACTUAL parent id — an established, imported or legacy parent's real id included — never under a
// hypothetical derived replacement of it.
function stableChildIdV1(actualParentId, childKind, childKeyParts) {
  if (typeof actualParentId !== 'string' || !GUID_RE.test(actualParentId)) throw invalid(`create identity: the parent id '${actualParentId}' is not a GUID`);
  const rule = Object.prototype.hasOwnProperty.call(CHILD_KINDS, childKind) ? CHILD_KINDS[childKind] : undefined;
  if (!rule) throw new CreateIdentityError('create-identity-unsupported', `create identity: '${childKind}' is not a child kind with a stable identity`);
  checkParts(childKeyParts, rule, `the key of ${childKind}`);
  const input = ['child', ALGORITHM_VERSION, childKind, ...childKeyParts];
  return uuidV5(actualParentId.toLowerCase(), Buffer.from(JSON.stringify(input), 'utf8'));
}

// The optional root spec field that turns protection on for every supported factory: absent is legacy, and present must be EXACTLY
// 'stable-v1' — null, a boolean, an object or an unknown version is an error, never read as "off" or "on".
function readCreateIdentityMode(appSpec) {
  if (!appSpec || typeof appSpec !== 'object' || !Object.prototype.hasOwnProperty.call(appSpec, 'createIdentity')) return 'legacy';
  if (appSpec.createIdentity === ACTIVATION_VALUE) return ACTIVATION_VALUE;
  throw invalid(`createIdentity must be "${ACTIVATION_VALUE}" or absent; got ${JSON.stringify(appSpec.createIdentity)}`);
}

module.exports = {
  ALGORITHM_VERSION,
  ACTIVATION_VALUE,
  NAMESPACE,
  NAMESPACE_URL,
  URL_NAMESPACE,
  ROOT_KINDS,
  CHILD_KINDS,
  SCOPE_KINDS,
  CreateIdentityError,
  CREATE_STOP_CODES,
  createStop,
  GUID_RE,
  uuidV5,
  identifierPart,
  nameKeyPart,
  stableKeyPart,
  subtypePart,
  entityOrEmptyPart,
  validateCreateIdentitySpec,
  stableCreateIdV1,
  stableChildIdV1,
  readCreateIdentityMode,
};

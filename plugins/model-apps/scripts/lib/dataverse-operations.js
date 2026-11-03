'use strict';
// The reviewed catalogue of BUILT-IN Dataverse operations a generative page may bind: exactly WhoAmI and RetrieveVersion.
//
// WHY A FIXED CATALOGUE, AND WHAT IT DOES NOT CLAIM. Custom API discovery (list-custom-apis.js) reads the `customapi` table, and these two are
// not rows of it: they are messages the platform defines, described only in the service's $metadata document (many megabytes — about 19.6 MB was
// measured on one environment), and even that document would not prove that the page's player supports a call or that the signed-in user may make
// it. So nothing here asks an environment anything. The two entries were checked against their documented contracts, and every answer says what
// was NOT checked: the environment, the player runtime and the user's privileges (VERIFICATION). Listing an operation is an offer, not a check
// that the environment has it — a page's first call can still answer 404 — and growing the set is a reviewed code change, never a setting.
//   WhoAmI           https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/whoami
//                    -> WhoAmIResponse { BusinessUnitId, UserId, OrganizationId: Edm.Guid }
//   RetrieveVersion  https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveversion
//                    -> RetrieveVersionResponse { Version: Edm.String }
// Both are unbound Functions with no parameters. "Function" (a GET) is not what admits them: CalculateRollupField and
// IncrementKnowledgeArticleViewCount are Functions too, and they change data. They were admitted because each only retrieves the caller's identity
// or the server's version. Actions, record- and set-bound operations and every other message stay out (references/dataverse-operations.md says why).
//
// WHY ONLY FOUR KEYS LEAVE THIS MODULE FOR A PAGE. A page's `actionBindings` entry is the wire object toActionBinding builds:
//   { "name": "WhoAmI", "isFunction": true, "displayName": "Current Dataverse identity", "parameterKinds": {} }
// A descriptor carries more (`bindingType`, `parameters`, `response`, `outputPrivacy`, `invocation`, `requiresExplicitSelection`), and a page
// list that holds a key outside the documented binding properties is left out of an App Spec WHOLE, with its unrelated Custom API entries
// (lib/page-bindings.js, statableBindings). So a descriptor is never spread onto the wire, and the wire entry is built from the catalogue's own
// values, never from the object a caller handed in.
//
// Recognition is not gated by the "dataverse-operations" feature flag: a download or a rebuild classifies a carried binding by name whatever the
// flag says, and neither authors one. The flag gates OFFERING the catalogue (list-dataverse-operations.js) and authoring new bindings.
const { isDeepStrictEqual } = require('node:util');

// The catalogue's own revision, not the plugin's version: it changes only when the set or a contract changes.
const CATALOGUE_VERSION = 1;

// Freezes `value` and everything under it, so no caller can widen or alter what a later caller reads.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const VERIFICATION = deepFreeze({ mode: 'catalogue-only', environment: 'not-checked', runtime: 'not-checked', privileges: 'not-checked' });

// The descriptors, in catalogue order. `parameters: []` is "no inputs" — unlike a Custom API's empty `parameterKinds`, which can sit beside
// lookup inputs (list-custom-apis.js lookupParameters) — and `parameterKinds: {}` is the wire map that says the same. `outputPrivacy` names what
// a result reveals: WhoAmI answers the signed-in user's identifiers, so a page shows them only as the maker-requested feature, never logs them.
const OPERATIONS = deepFreeze([
  {
    name: 'WhoAmI',
    displayName: 'Current Dataverse identity',
    isFunction: true,
    bindingType: 'Global',
    parameters: [],
    parameterKinds: {},
    response: {
      typeName: 'Microsoft.Dynamics.CRM.WhoAmIResponse',
      properties: { BusinessUnitId: 'Edm.Guid', UserId: 'Edm.Guid', OrganizationId: 'Edm.Guid' },
    },
    outputPrivacy: 'identity',
    invocation: 'user-triggered',
    requiresExplicitSelection: true,
  },
  {
    name: 'RetrieveVersion',
    displayName: 'Dataverse server version',
    isFunction: true,
    bindingType: 'Global',
    parameters: [],
    parameterKinds: {},
    response: {
      typeName: 'Microsoft.Dynamics.CRM.RetrieveVersionResponse',
      properties: { Version: 'Edm.String' },
    },
    outputPrivacy: 'service-version',
    invocation: 'user-triggered',
    requiresExplicitSelection: true,
  },
]);

const CATALOGUE = deepFreeze({ catalogueVersion: CATALOGUE_VERSION, verification: VERIFICATION, operations: OPERATIONS });
const REVIEWED_OPERATION_NAMES = deepFreeze(OPERATIONS.map((operation) => operation.name));
// A Map, not an object: a name is looked up as data, so `__proto__`, `constructor` or `toString` finds nothing rather than an inherited member.
const BY_NAME = new Map(OPERATIONS.map((operation) => [operation.name, operation]));

// The authoring codes and their fixed sentences. They are what an authoring step says when it refuses; none is a player `error.code`, none
// restricts the Custom API path, and none quotes the text it refused (a name a maker typed can be anything).
const AUTHORING_CODES = deepFreeze({
  not_in_catalogue: 'Only WhoAmI and RetrieveVersion are offered by this feature. Other Dataverse operations require separately reviewed support.',
  invalid_operation_contract: 'The selected built-in operation must be an explicitly declared, unbound Function with no inputs.',
  duplicate_operation: 'Select each built-in operation once; duplicate bindings are not supported.',
  selection_required: 'Select a built-in operation explicitly before generating its binding or call.',
  explicit_trigger_required: 'This version supports user-triggered built-in operation calls only.',
  catalogue_unavailable: 'The built-in operation catalogue could not be read. No built-in operations were offered.',
});

function authoringError(code) {
  const error = new Error(AUTHORING_CODES[code]);
  error.code = code;
  return error;
}

const isPlainEntry = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The frozen descriptor of a reviewed operation, for an EXACT name only — no case, prefix, namespace or display-name folding — or null.
 * @param {unknown} name
 * @returns {object|null}
 */
function getReviewedDataverseOperation(name) {
  return typeof name === 'string' ? BY_NAME.get(name) || null : null;
}

/**
 * The whole catalogue, frozen: { catalogueVersion, verification, operations: [WhoAmI, RetrieveVersion] }. A caller passes the authoring gate
 * before it offers any of it.
 */
function getDataverseOperationCatalogue() {
  return CATALOGUE;
}

/**
 * The `actionBindings` wire entry of a reviewed operation: a fresh object of exactly four keys, built from the catalogue. It accepts only a
 * descriptor structurally equal to the current canonical one — an altered descriptor is refused, not repaired — and throws an Error with a
 * fixed `code` and message otherwise. It checks no gate and no selection: its caller must already hold an enabled gate and the maker's
 * affirmative selection of this operation. Discovery never calls it.
 */
function toActionBinding(descriptor) {
  if (!isPlainEntry(descriptor)) throw authoringError('invalid_operation_contract');
  const canonical = getReviewedDataverseOperation(descriptor.name);
  if (!canonical) throw authoringError('not_in_catalogue');
  if (!isDeepStrictEqual(descriptor, canonical)) throw authoringError('invalid_operation_contract');
  return { name: canonical.name, isFunction: canonical.isFunction, displayName: canonical.displayName, parameterKinds: {} };
}

/**
 * Whether `entry` is a NEWLY AUTHORED wire row of a reviewed operation: exactly the four keys toActionBinding gives it, with the catalogue's
 * values — `isFunction: true`, no bound target, no inputs, no other property. { ok: true } or { ok: false, code, message }. It is not used to
 * judge or repair a binding a page already holds: a preserved or downloaded entry stays as it is.
 */
function validateReviewedDataverseBinding(entry) {
  if (!isPlainEntry(entry)) return refusal('invalid_operation_contract');
  const canonical = getReviewedDataverseOperation(entry.name);
  if (!canonical) return refusal('not_in_catalogue');
  return isDeepStrictEqual(entry, toActionBinding(canonical)) ? { ok: true } : refusal('invalid_operation_contract');
}

function refusal(code) {
  return { ok: false, code, message: AUTHORING_CODES[code] };
}

module.exports = {
  CATALOGUE_VERSION,
  REVIEWED_OPERATION_NAMES,
  AUTHORING_CODES,
  getReviewedDataverseOperation,
  getDataverseOperationCatalogue,
  toActionBinding,
  validateReviewedDataverseBinding,
};

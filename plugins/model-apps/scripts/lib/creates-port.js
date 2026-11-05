'use strict';
// The create ports with stable identities, both with the same call shape as the plain pass-through (lib/creates-passthrough.js),
//   await creates.run({ kind, key, identity, childKeys }, async ({ id, childIds }) => actualSdkResult)
// so a call site needs no change when the build hands it one of them instead.
//
// Two ports live here:
//   - createCompositeCreatesPort / createCompositePortForSpec (below): the port a build hands its declared helpers. It protects the
//     exact (kind, key) declarations of a validated catalog (creates-catalog.js) — views and charts under `createIdentity:
//     "stable-v1"`, and declared forms, dashboards, business rules and process flows — reserves their child ids before execute,
//     and reads the helper's checked answer through interpretCompositePush. Everything it does not declare is the pass-through.
//   - createCreatesPort (`mode: 'stable'`): the single-row port, described next. Its aggregate (creates-capabilities.js allocates)
//     still refuses every kind that writes child rows; the composite port is the only way a declared aggregate gets stable ids.
//
// What the single-row port does for a PROTECTED kind (one the spec turns protection on for, see `protectedKinds`):
//   - it allocates the row's id from the plan's validated intent catalog (creates-capabilities.js intentFor → creates-identity.js), so
//     the same spec gives the same id in every process — nothing is recorded, nothing can be lost. A kind whose create also writes
//     child rows is never protected in this release (creates-capabilities.js allocates): a parent's binding is no authority over a
//     row at a child's derived id, so children keep the plain pass-through;
//   - it checks the call against that intent: an unknown kind or key, or child keys that are not exactly the intent's, refuse before
//     anything is sent (create-identity-invalid / -unsupported);
//   - it calls `execute` EXACTLY once — no retry, no import, no adoption, no read that authorises a write;
//   - it reads the SDK's answer, the push result: `saved` with the same id is `created` (the root's receipt — never the aggregate's
//     completion); the SDK's native exact adoption (`adoptedExisting`) is `matched` (observation, never ownership); an empty, malformed
//     or other-id answer stops; a push that failed BY VALUE (`saved: false` with an error) is thrown as that error, exactly as a thrown
//     one, so both reach the consumer's single post-failure inspection by id the same way.
// Every error keeps its identity (the same object, with its code, cause and retry signals) and gains a `createAttempt` record of the
// ids it was sent with, so the consumer can inspect the saved row by id; the port itself never inspects, adopts or sends again.
//
// What it deliberately does NOT do: it is not a physical fence (the HTTP client may still re-send the same request, with the same ids),
// it keeps no journal or marker, and a row found present BEFORE the create is not its business — the consumer resolves a protected
// target by id before any name and handles a present row on its own exact-id path, without
// calling run at all.
//
// For a kind that is NOT protected (every kind, when the spec does not set createIdentity and declares no new feature), the port is
// the plain pass-through, unchanged: random ids, one call, every failure rethrown as is.

const { createPassthroughCreates } = require('./creates-passthrough.js');
const { stableCreateIdV1, stableChildIdV1, createStop, GUID_RE, readCreateIdentityMode } = require('./creates-identity.js');
const { capabilityFor, allocates, isKnownCreateKind } = require('./creates-capabilities.js');
const {
  createIntentCatalog: createIntentCatalogV2, reserveChildren, routeIntent, compositeCapability, isIntentCatalog,
} = require('./creates-catalog.js');

const lowerGuid = (v) => (typeof v === 'string' ? v.replace(/^\{|\}$/g, '').toLowerCase() : '');

// The validated per-plan catalog: intent (creates-capabilities.js intentFor) → its ids. Two intents that would share a root id, or
// two children of one intent that would share an id, are refused here, before any create is sent.
function createIntentCatalog(intents = []) {
  const byKey = new Map();
  const byId = new Map();
  for (const intent of intents) {
    const slot = `${intent.kind}\u0000${intent.key}`;
    if (byKey.has(slot)) throw createStop('create-identity-invalid', `creates: ${intent.kind} '${intent.key}' is planned twice`);
    if (intent.boundId !== undefined && !GUID_RE.test(String(intent.boundId))) throw createStop('create-identity-invalid', `creates: the established id of ${intent.kind} '${intent.key}' is not a GUID`);
    const id = intent.boundId !== undefined ? lowerGuid(intent.boundId) : stableCreateIdV1({ scope: intent.scope, kind: intent.kind, keyParts: intent.keyParts });
    const other = byId.get(id);
    if (other) throw createStop('create-identity-invalid', `creates: ${intent.kind} '${intent.key}' and ${other.kind} '${other.key}' are one artifact (identity ${id}); give them distinct keys`);
    byId.set(id, intent);
    const childIds = {};
    const seen = new Map();
    for (const [locator, c] of Object.entries(intent.children || {})) {
      const childId = stableChildIdV1(id, c.childKind, c.keyParts);
      if (seen.has(childId)) throw createStop('create-identity-invalid', `creates: ${intent.kind} '${intent.key}' has two children that are one row ('${seen.get(childId)}' and '${locator}')`);
      seen.set(childId, locator);
      childIds[locator] = childId;
    }
    byKey.set(slot, Object.freeze({ intent, id, childIds: Object.freeze(childIds) }));
  }
  return {
    get(kind, key) { return byKey.get(`${kind}\u0000${key}`); },
    size: byKey.size,
  };
}

// Whether a failure is evidence that the PRIMARY write may have reached the server — the only failures that route to the consumer's
// single saved-id inspection. Two kinds of evidence, read through the cause chain:
//   - the SDK's ARTIFACT_ALREADY_EXISTS: the create met a row at its own id (a re-send of a write whose first answer was lost, inside
//     one execute, or a row an earlier run created);
//   - an answer the plugin's HTTP client marked as following an earlier ambiguous send of the same request (sdk-http-client.js
//     HTTP_SEND_HISTORY: `{ sends, earlierAmbiguous }` on the failure's answer body).
// Anything else — a refusal, a failed preparatory read, a validation error — is NOT evidence of dispatch and is rethrown untouched.
const HTTP_SEND_HISTORY = Symbol.for('power-platform-skills.http-send-history');
const ALREADY_EXISTS = 'ARTIFACT_ALREADY_EXISTS';
const sendHistoryOf = (o) => (o && typeof o === 'object' ? o[HTTP_SEND_HISTORY] : undefined);
function primaryDispatchEvidence(error) {
  let e = error;
  for (let depth = 0; e && typeof e === 'object' && depth < 8; depth += 1) {
    if (e.code === ALREADY_EXISTS) return 'already-exists';
    // The marked answer body is carried on the failure itself (`body`, `answer`, `response.body`) or IS a link of the cause chain:
    // the SDK's CONNECTION_ERROR sets the client's thrown answer (the marked body, sdk-http-client.js) directly as its `cause`.
    for (const holder of [e, e.body, e.answer, e.response && e.response.body]) {
      const history = sendHistoryOf(holder);
      if (history && history.earlierAmbiguous === true) return 'ambiguous-dispatch';
    }
    e = e.cause;
  }
  return null;
}

function annotate(error, attempt) {
  if (error && (typeof error === 'object' || typeof error === 'function') && Object.isExtensible(error)) {
    try {
      Object.defineProperty(error, 'createAttempt', { value: attempt, enumerable: false, configurable: true, writable: true });
      return error;
    } catch { /* fall through to a wrapper */ }
  }
  const wrapped = new Error(`create of ${attempt.kind} '${attempt.key}' failed`, { cause: error });
  Object.defineProperty(wrapped, 'createAttempt', { value: attempt, enumerable: false, configurable: true, writable: true });
  return wrapped;
}

// The SDK's push result (types/common PushResult): { type, id, saved, adoptedExisting?, error?, warnings? }.
function interpretPushResult(result, id, descriptor, attempt) {
  const create = { kind: attempt.kind, key: attempt.key, id };
  if (!result || typeof result !== 'object') {
    throw createStop('create-identity-unverified', `the create of ${attempt.kind} '${attempt.key}' answered nothing the build can read; no replacement was created`, { create });
  }
  // The same reading as the build's pushFailed (entity-provision.js): an adoption counts only as the boolean the SDK sets, with no
  // error beside it; every other `saved: false` is a failure by value.
  if (result.saved === false && !(result.adoptedExisting === true && !result.error)) {
    const failure = result.error instanceof Error ? result.error : Object.assign(new Error(`the create of ${attempt.kind} '${attempt.key}' was not saved`), { result });
    throw annotate(failure, { ...attempt, evidence: primaryDispatchEvidence(failure) });
  }
  const answered = lowerGuid(result.id);
  if (!GUID_RE.test(answered)) throw createStop('create-identity-unverified', `the create of ${attempt.kind} '${attempt.key}' answered no id; no replacement was created`, { create });
  if (answered !== id) {
    throw createStop('create-identity-conflict', `the create of ${attempt.kind} '${attempt.key}' answered the id ${answered}, not ${id}; no replacement was created`, { create });
  }
  if (result.adoptedExisting === true) {
    if (!descriptor.native) throw createStop('create-identity-conflict', `the SDK adopted an existing ${attempt.kind} '${attempt.key}', which it does not do for this kind`, { create });
    return { outcome: 'matched', evidence: 'sdk-adopted-exact' };
  }
  if (result.saved === true) return { outcome: 'created', evidence: 'sdk-acknowledged' };
  throw createStop('create-identity-unverified', `the create of ${attempt.kind} '${attempt.key}' answered neither saved nor adopted; no replacement was created`, { create });
}

function projectTheme(result, descriptor) {
  const out = {};
  for (const f of descriptor.resultFields) if (Object.prototype.hasOwnProperty.call(result, f)) out[f] = result[f];
  return out;
}

// Whether a setter's failure may have followed its write reaching the server: a failure that marks itself transient anywhere in its
// cause chain, one the build's retry policy judges transient (a transport blip, a 5xx/429), or one with dispatch evidence. The policy
// is required lazily: it loads the HTTP client, and only a stable port that runs a setter needs it.
function maySetterHaveBeenSent(error) {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 8; e = e.cause, depth += 1) if (e.transient === true) return true;
  if (primaryDispatchEvidence(error) !== null) return true;
  const { judgeFailure } = require('./retry-policy.js');
  return judgeFailure(error).transient === true;
}

function validateRequest(request, execute) {
  const { kind, key, childKeys = [] } = request || {};
  if (typeof kind !== 'string' || !kind) throw new TypeError('creates.run: kind must be a non-empty string');
  if (typeof key !== 'string' || !key) throw new TypeError('creates.run: key must be a non-empty string');
  if (!Array.isArray(childKeys) || childKeys.some((k) => typeof k !== 'string' || !k)) throw new TypeError('creates.run: childKeys must be an array of non-empty strings');
  if (new Set(childKeys).size !== childKeys.length) throw new TypeError('creates.run: childKeys must be unique');
  if (typeof execute !== 'function') throw new TypeError('creates.run: execute must be a function');
  return { kind, key, childKeys };
}

// mode: 'passthrough' — every kind is the plain pass-through (the build without createIdentity and without new feature declarations);
//       'stable'      — the kinds in `protectedKinds` are allocated from `intents`; any other kind is the plain pass-through.
function createCreatesPort({ mode = 'passthrough', protectedKinds = [], intents = [], newId } = {}) {
  const passthrough = createPassthroughCreates(newId === undefined ? {} : { newId });
  if (mode === 'passthrough') {
    return { mode, run: passthrough.run, protects: () => false, identityFor: () => null };
  }
  if (mode !== 'stable') throw createStop('create-identity-invalid', `creates: unknown port mode '${mode}'`);
  const protectedSet = new Set(protectedKinds);
  for (const kind of protectedSet) {
    const d = capabilityFor(kind);
    if (!(d.semantic || allocates(kind))) throw createStop('create-identity-unsupported', `creates: ${kind} cannot be protected in this release${d.gate ? ` — ${d.gate}` : ''}`);
  }
  const catalog = createIntentCatalog(intents);
  for (const intent of intents) {
    if (!protectedSet.has(intent.kind)) throw createStop('create-identity-invalid', `creates: ${intent.kind} '${intent.key}' is planned but its kind is not protected`);
  }
  const entryFor = (kind, key) => {
    const entry = catalog.get(kind, key);
    if (!entry) throw createStop('create-identity-invalid', `creates: ${kind} '${key}' is not in the plan`, { create: { kind, key } });
    return entry;
  };

  async function run(request, execute) {
    const { kind, key, childKeys } = validateRequest(request, execute);
    if (!protectedSet.has(kind)) {
      // A stable port knows every kind the build may send; a name it does not know (a typo, a wrong case) would otherwise pass
      // as an unprotected create with a random id. A child kind is never protected in this release (no protected kind has children,
      // creates-capabilities.js allocates), so a child row is always the plain pass-through, exactly as before.
      if (!isKnownCreateKind(kind)) throw createStop('create-identity-unsupported', `creates: '${kind}' is not a kind this build knows how to create`, { create: { kind, key } });
      return passthrough.run(request, execute);
    }
    const descriptor = capabilityFor(kind);
    if (descriptor.semantic) return runSetter(kind, key, descriptor, execute);
    const entry = entryFor(kind, key);
    const expected = Object.keys(entry.childIds);
    if (childKeys.length !== expected.length || childKeys.some((k) => !Object.prototype.hasOwnProperty.call(entry.childIds, k))) {
      throw createStop('create-identity-invalid', `creates: ${kind} '${key}' was called with children [${childKeys.join(', ')}], not the planned [${expected.join(', ')}]`, { create: { kind, key, id: entry.id } });
    }
    const id = entry.id;
    const childIds = Object.fromEntries(childKeys.map((k) => [k, entry.childIds[k]]));
    const attempt = { kind, key, id, childIds };
    let result;
    try {
      // Exactly once. A failure keeps its own identity (code, cause, retry signals) and gains the ids it was sent with.
      result = await execute({ id, childIds: { ...childIds } });
    } catch (error) {
      throw annotate(error, { ...attempt, evidence: primaryDispatchEvidence(error) });
    }
    const { outcome, evidence } = interpretPushResult(result, id, descriptor, attempt);
    return { outcome, id, childIds, ids: { id, childIds }, result, evidence };
  }

  // A semantic setter (appTheme): executed once, with no id. It is keyed by the app and its setting definition, so its answer must
  // say what happened to that row — the SDK's SetAppThemeResult.outcome, one of the descriptor's `outcomes` — or it is an unknown
  // outcome. A failure that may have been sent (transient by the build's retry policy, or with dispatch evidence) is an unknown
  // outcome too: running again would send it again. A refusal is rethrown as the same object. The result is not a creation receipt
  // and grants no deletion authority: no id is ever projected from it.
  async function runSetter(kind, key, descriptor, execute) {
    const create = { kind, key };
    let result;
    try {
      result = await execute({ id: null, childIds: {} });
    } catch (error) {
      if (maySetterHaveBeenSent(error)) {
        throw createStop('create-outcome-unknown', `the ${kind} setter failed after it may have been sent; whether it changed the setting is not known, and it is not sent again automatically`, { create, cause: error });
      }
      throw error;
    }
    const plain = result && typeof result === 'object' && !Array.isArray(result) && Object.getPrototypeOf(result) === Object.prototype;
    const outcome = plain && Object.prototype.hasOwnProperty.call(result, 'outcome') ? result.outcome : undefined;
    if (!descriptor.outcomes.includes(outcome)) {
      throw createStop('create-outcome-unknown', `the ${kind} setter answered no outcome the build can read; it is not sent again automatically`, { create });
    }
    return { outcome: 'applied', id: null, childIds: {}, ids: { id: null, childIds: {} }, result: projectTheme(result, descriptor), evidence: 'sdk-acknowledged' };
  }

  return {
    mode,
    run,
    protects: (kind) => protectedSet.has(kind),
    // The ids a protected create WOULD be sent with — pure, for the consumer's read-by-id-before-name resolution. null when unprotected.
    identityFor(kind, key) {
      if (!protectedSet.has(kind) || capabilityFor(kind).semantic) return null;
      const entry = entryFor(kind, key);
      return { id: entry.id, childIds: { ...entry.childIds } };
    },
  };
}

// The port the build hands its phases, decided by the spec alone:
//   - createIdentity absent and no new-feature intents → mode 'passthrough': byte-for-byte the plain pass-through, so a spec without
//     the option keeps every request, body, output, count and exit it had;
//   - createIdentity "stable-v1" → the `shippedKinds` (the kinds whose call sites this release routes through the port) are protected;
//   - new feature declarations (`featureKinds`) are protected at their own port even without the root field — and only they.
// `intents` is the plan's catalog (creates-capabilities.js intentFor) for every protected create the plan may send.
function createCreatesPortForSpec(spec, { intents = [], shippedKinds = [], featureKinds = [], newId } = {}) {
  const mode = readCreateIdentityMode(spec);
  // Turning a kind on that this release cannot protect is refused whatever the spec declares, so a gated kind added to either list
  // stops the build before any request instead of silently staying on the plain path for one spec and failing for the next.
  for (const kind of [...shippedKinds, ...featureKinds]) {
    const d = capabilityFor(kind);
    if (!(d.semantic || allocates(kind))) throw createStop('create-identity-unsupported', `creates: ${kind} cannot be protected in this release${d.gate ? ` — ${d.gate}` : ''}`);
  }
  const kinds = new Set(featureKinds.filter((k) => intents.some((i) => i.kind === k) || capabilityFor(k).semantic));
  if (mode !== 'legacy') for (const k of shippedKinds) kinds.add(k);
  if (!kinds.size) return createCreatesPort({ mode: 'passthrough', newId });
  return createCreatesPort({ mode: 'stable', protectedKinds: [...kinds], intents: intents.filter((i) => kinds.has(i.kind)), newId });
}

// ---- the composite port: declared creates of a catalog (creates-catalog.js) ------------------------------------------------------

// A code a caller may act on: the SDK's upper-case codes (VALIDATION_ERROR, PUSH_NOT_SAVED, ...) and this plugin's lower-case
// stop codes (create-identity-conflict, creation-*, view-*). Anything else, or a code that is too long to be a code, is dropped
// for the default, so a message can never travel as a code.
const CODE_RE = /^(?:[A-Z][A-Z0-9_]{2,63}|[a-z][a-z0-9-]{2,63})$/;
const keepCode = (code, fallback) => (typeof code === 'string' && CODE_RE.test(code) ? code : fallback);

// The SDK's raw push result (types/common PushResult: { type, id, saved, adoptedExisting?, error? }) read as the checked shape the
// composite bridge takes. The same reading as entity-provision.js pushFailed: an adoption counts only as the boolean the SDK sets
// with no error beside it, and every other `saved: false` is the SDK refusing the push by value.
function checkedOfRaw(raw) {
  if (raw.saved === true) return { outcome: 'saved', id: raw.id, sdkResult: raw };
  if (raw.adoptedExisting === true && !raw.error) return { outcome: 'matched', id: raw.id, sdkResult: raw };
  return { outcome: 'refused', code: keepCode(raw.error && raw.error.code, 'PUSH_NOT_SAVED'), sdkResult: raw };
}

/**
 * Read what a declared create's execute answered, for the composite port only. `checked` is the reconcile helpers' checked push
 * ({ outcome: 'saved'|'matched'|'refused'|'unknown', code?, id?, sdkResult?, rules? }) or the SDK's raw push result; `attempt` is
 * { kind, key, id, childIds }, the ids the create was sent with.
 *   saved, with the attempt's id        -> created   (the root's receipt; the caller still proves its children)
 *   matched, or the SDK's exact adoption -> matched   (an observation that the row is at this id; never an adopted receipt)
 *   refused                              -> refused   (its code unchanged; nothing was saved)
 *   saved or matched with no usable id   -> unknown   create-identity-unverified
 *   saved or matched with another id     -> unknown   create-identity-conflict
 *   anything else                        -> unknown   with its own code, else WRITE_OUTCOME_UNKNOWN
 * Lower-case codes survive (the old bridge kept only upper-case ones), and `sdkResult` is never dropped. No `origin` is set here:
 * a create's origin is the helper's to record from what it proves.
 */
function interpretCompositePush(checked, attempt) {
  const id = lowerGuid(attempt && attempt.id);
  const childIds = { ...((attempt && attempt.childIds) || {}) };
  if (!checked || typeof checked !== 'object') return { outcome: 'unknown', id, childIds, code: 'create-identity-unverified' };
  const c = typeof checked.outcome === 'string' ? checked : typeof checked.saved === 'boolean' ? checkedOfRaw(checked) : checked;
  const extra = c.sdkResult !== undefined ? { sdkResult: c.sdkResult } : {};
  const nativeMatch = c.outcome === 'matched' || (c.outcome === 'saved' && c.sdkResult && c.sdkResult.adoptedExisting === true && !c.sdkResult.error);
  if (c.outcome === 'saved' || nativeMatch) {
    const answered = lowerGuid(c.id !== undefined ? c.id : c.sdkResult && c.sdkResult.id);
    if (!GUID_RE.test(answered)) return { outcome: 'unknown', id, childIds, code: 'create-identity-unverified', ...extra };
    if (answered !== id) return { outcome: 'unknown', id, childIds, code: 'create-identity-conflict', answeredId: answered, ...extra };
    if (nativeMatch) return { outcome: 'matched', id, childIds, code: '', evidence: 'native-match', ...extra };
    return { outcome: 'created', id, childIds, code: '', evidence: 'sdk-acknowledged', ...extra };
  }
  if (c.outcome === 'refused') {
    return { outcome: 'refused', id, childIds, code: keepCode(c.code, 'PUSH_NOT_SAVED'), ...extra, ...(Array.isArray(c.rules) ? { rules: c.rules.slice() } : {}) };
  }
  return { outcome: 'unknown', id, childIds, code: keepCode(c.code, 'WRITE_OUTCOME_UNKNOWN'), ...extra };
}

/**
 * The port for a plan's declared creates. Same call shape as every port:
 *   await creates.run({ kind, key, childKeys?, children?, actualRootId? }, async ({ id, childIds }) => checked)
 * A request the catalog declares (routeIntent 'composite') is sent with its stable ids; any other request — a legacy sibling of a
 * declared kind, a configuration or command create, an app theme — is the plain pass-through, exactly as without this port.
 *
 * For a declared create the port:
 *   - reserves the root id (actualRootId wins over the derived id) and every child in `children` (creates-catalog.js
 *     reserveChildren) BEFORE execute; a `childKeys` entry that is not a reserved child is create-identity-unsupported, so a write
 *     never starts with part of its graph;
 *   - calls `onAttempt({ kind, key, id, childIds })` before execute, so the caller can record the attempt (the ids it is about to
 *     send) first; a failure there sends nothing;
 *   - throws every stop it makes before execute (the reservation, a child it does not reserve, onAttempt) with `preSend: true`:
 *     the one certificate that nothing was sent. A throw from execute never carries it;
 *   - calls `execute` exactly once — no retry, no read, no adoption;
 *   - answers interpretCompositePush(checked); a throw is rethrown as the same object, annotated with `createAttempt`.
 * It protects a (kind, key) only, never a whole kind: `protects(kind)` without a key is false.
 */
function markPreSend(error) {
  const err = error instanceof Error ? error : Object.assign(new Error(String(error)), { code: 'create-identity-invalid' });
  try {
    Object.defineProperty(err, 'preSend', { value: true, enumerable: false, configurable: true });
  } catch { /* a frozen error cannot be certified, so it is reported as an unknown outcome */ }
  return err;
}

function createCompositeCreatesPort({ catalog, newId, onAttempt } = {}) {
  if (!isIntentCatalog(catalog)) throw createStop('create-identity-invalid', 'creates: the composite port needs a catalog from creates-catalog.js createIntentCatalog');
  if (onAttempt !== undefined && typeof onAttempt !== 'function') throw new TypeError('creates port: onAttempt must be a function');
  const passthrough = createPassthroughCreates(newId === undefined ? {} : { newId });

  async function run(request, execute) {
    const { kind, key, childKeys } = validateRequest(request, execute);
    if (routeIntent({ kind, key }, { catalog }) !== 'composite') return passthrough.run(request, execute);
    let id;
    let childIds;
    let attempt;
    try {
      const reserved = reserveChildren(kind, key, { catalog, actualRootId: request.actualRootId, children: request.children || [] });
      for (const k of childKeys) {
        if (!Object.prototype.hasOwnProperty.call(reserved.childIds, k)) {
          throw createStop('create-identity-unsupported', `creates: ${kind} '${key}' asked for the child '${k}', which its declaration does not reserve`, { create: { kind, key, id: reserved.rootId } });
        }
      }
      id = reserved.rootId;
      childIds = { ...reserved.childIds };
      attempt = Object.freeze({ kind, key, id, childIds: Object.freeze({ ...childIds }) });
      if (onAttempt) await onAttempt(attempt);
    } catch (error) {
      // Certified pre-send: execute has not been called, so nothing of this create left the process. The flag, not the
      // error's code, is what lets a caller report it as a refusal (reconcile-common.js createThroughPort): a code can be
      // reused by a later step that runs after the send.
      throw markPreSend(error);
    }
    let checked;
    try {
      checked = await execute({ id, childIds: { ...childIds } });
    } catch (error) {
      throw annotate(error, { kind, key, id, childIds: { ...childIds }, evidence: primaryDispatchEvidence(error) });
    }
    return interpretCompositePush(checked, attempt);
  }

  return {
    mode: 'composite',
    run,
    catalog,
    protects: (kind, key) => key !== undefined && catalog.has(kind, key),
    // The root id a declared create WOULD be sent with — pure, for a read by id before any name lookup. null when undeclared.
    identityFor(kind, key) {
      if (!catalog.has(kind, key)) return null;
      return { id: catalog.identityFor(kind, key).id, childIds: {} };
    },
  };
}

/**
 * The composite port a build hands its declared helpers, decided by the spec alone:
 *   - no `createIdentity` and no declared feature intent -> the plain pass-through, byte for byte;
 *   - `createIdentity: "stable-v1"` -> the `shippedKinds` (views and charts) are protected for the intents the plan declares;
 *   - a declared feature (`featureKinds`) is protected with or without the root field, and only for its own intents.
 * A kind listed in either list that the composite port does not support is refused before any request
 * (create-identity-unsupported), whatever the spec declares.
 */
function createCompositePortForSpec(spec, { intents = [], shippedKinds = [], featureKinds = [], newId, onAttempt } = {}) {
  const mode = readCreateIdentityMode(spec);
  for (const kind of [...shippedKinds, ...featureKinds]) compositeCapability(kind);
  const kinds = new Set(featureKinds.filter((k) => intents.some((i) => i && i.catalogKind === k)));
  if (mode !== 'legacy') for (const k of shippedKinds) kinds.add(k);
  const active = intents.filter((i) => i && kinds.has(i.catalogKind));
  if (!active.length) return createCreatesPort({ mode: 'passthrough', newId });
  return createCompositeCreatesPort({ catalog: createIntentCatalogV2(active), newId, onAttempt });
}

module.exports = {
  markPreSend,
  createCreatesPort,
  createCreatesPortForSpec,
  createIntentCatalog,
  primaryDispatchEvidence,
  interpretPushResult,
  interpretCompositePush,
  createCompositeCreatesPort,
  createCompositePortForSpec,
  ALREADY_EXISTS,
};

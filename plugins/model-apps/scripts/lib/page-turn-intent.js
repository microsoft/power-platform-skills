'use strict';
// The COMPLETE intended request a caller-held page turn id (`turnId`) is bound to, normalized and hashed — pure: no file system, no network.
//
// A turn id names one intended edit of a generative page. The SDK derives the ids of the turn's two message rows from it (GenPageAdapter), so a send a later run repeats
// under the same id addresses the same message rows, and the SDK leaves out a message it finds already recorded (or refuses one recorded with other text). That dedupes the
// CONVERSATION only. Everything else a write does — the source, the name, the data sources, the model, the binding lists, whether a stated binding list is merged into the
// page's entries or replaces them, whether the page is published, the receipt that can skip a publish, the compiler, and (for an upload) the solution and app effects — is
// bound here: the caller's store keeps one record per turn id (lib/page-turn-store.js), and any later use of the id that asks for anything else is refused before a write.
//
// Two digests make up the record, because not every input is known before the page is read:
//   requestSha256          what the caller asked for, before any read: the content, the binding mode, the message POLICY (an explicit prompt, or "the default"), publication,
//                          the publish receipt, the compiler, the scope and (upload) the effect policy. The page id is NOT in it, so a create retried with the id its first
//                          attempt returned is the same request.
//   effectiveInputsSha256  what is actually sent once the defaults are resolved: the prompt and reply text the turn records (an update's default prompt is made from the
//                          page's name, read from the server) and, for an upload, the resolved navigation title, tables and language.
//   intentSha256           domain + requestSha256 + pageId + effectiveInputsSha256: the one value the record is checked by.
//
// The record proves the REQUEST, not that anything was sent or committed, not ownership of the page, not approval and not a lock: the page's version tokens, the upload's
// lease and its base marker stay what protects a page from another writer. Equal requests can still compile differently against changed live metadata.
const { sha256 } = require('./hash.js');
const { genpageError, sourceText, dataSourcesOf, bindingOf } = require('./page-content.js');

const TURN_RECORD_FORMAT = 2;
const TURN_REQUEST_DOMAIN = 'genpage-turn-request/2';
const TURN_INTENT_DOMAIN = 'genpage-turn-intent/2';
const OPERATIONS = Object.freeze(['create', 'update', 'upload-create', 'upload-update']);
const HEX64_RE = /^[0-9a-f]{64}$/;
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CANONICAL_GUID_RE = new RegExp(`^${GUID}$`);
// A turn id as the SDK takes it: a GUID in any letter case, with or without braces (GenPageAdapter `normalizeGuid`); kept lower case without braces here, which is also the
// name of its record file.
const TURN_ID_RE = new RegExp(`^(?:\\{(${GUID})\\}|(${GUID}))$`, 'i');

// The words every refusal of a record that cannot establish the original request ends with. An earlier attempt under the id may have been an unfinished create, and a new id
// minted just to get past this refusal could create the page a second time — so the advice is to look first.
const MIGRATION_ADVICE = 'This turn record cannot establish the complete original request. Nothing was changed by this attempt. Keep the record and inspect the page and any unfinished create before starting a new approved edit with a new turn ID. Do not use a new ID merely to retry an unresolved create.';

// Only `undefined` means "no turn id": a caller that meant to pass one and lost it (null, '', blanks) must not silently get the default identity.
function normalizeTurnId(value) {
  if (value === undefined) return undefined;
  const m = typeof value === 'string' ? TURN_ID_RE.exec(value.trim()) : null;
  if (!m) {
    throw genpageError(`${JSON.stringify(value === undefined ? null : value) || String(value)} is not a turn id: give a GUID (for example 6f1c2a4e-9b3d-47a1-b85c-0e2f7d914a63), or leave the turn id out. Nothing was changed.`, { code: 'GENPAGE_TURN_ID_INVALID', outcome: 'nothing' });
  }
  return (m[1] || m[2]).toLowerCase();
}

const argumentError = (message) => genpageError(`${message}. Nothing was changed.`, { code: 'GENPAGE_ARGUMENT_INVALID', outcome: 'nothing' });
const incompleteError = (turnId, detail) => genpageError(`the record of turn ${turnId} is not a complete turn record (${detail}). ${MIGRATION_ADVICE}`, { code: 'GENPAGE_TURN_STATE_INCOMPLETE', outcome: 'nothing', turnId });

// A deep, frozen copy of a value JSON can carry EXACTLY. `JSON.stringify` drops or rewrites what it cannot say (an `undefined` member, a hole in an array, a function,
// NaN, a getter's current value, a Map), so a hash of its text could name two different writes alike; each of those is refused instead. The copy — not the caller's
// object — is what is hashed AND what is sent, so a caller that changes its object while the write awaits cannot send something other than what was bound.
const MAX_JSON_DEPTH = 64;
function strictJsonCopy(value, label, seen = new Set(), depth = 0) {
  const refuse = (why) => { throw genpageError(`${label} ${why}, so it cannot be bound to a turn exactly. Nothing was changed.`, { code: 'GENPAGE_BINDING_INVALID', outcome: 'nothing' }); };
  if (depth > MAX_JSON_DEPTH) refuse(`is nested deeper than ${MAX_JSON_DEPTH} levels`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('holds a number JSON cannot carry');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') refuse(`holds a ${typeof value}`);
  if (seen.has(value)) refuse('refers to itself');
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) refuse('has a symbol key');
  const valueOf = (key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d)) refuse(`has an accessor at ${String(key)}`);
    return d.value;
  };
  let out;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) refuse('is an array of an unsupported kind');
    if (keys.length !== value.length + 1) refuse('is a sparse array or carries extra properties');
    out = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) refuse('is a sparse array');
      out.push(strictJsonCopy(valueOf(String(i)), label, seen, depth + 1));
    }
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) refuse('holds an object that is not plain JSON');
    out = {};
    for (const key of keys) {
      if (!Object.getOwnPropertyDescriptor(value, key).enumerable) refuse(`has a hidden property ${key}`);
      // defineProperty, not assignment: a member named "__proto__" must stay a member.
      Object.defineProperty(out, key, { value: strictJsonCopy(valueOf(key), label, seen, depth + 1), enumerable: true, writable: false, configurable: false });
    }
  }
  seen.delete(value);
  return Object.freeze(out);
}

// Canonical JSON of a strict value: object keys sorted, arrays and strings exactly as they are.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

// An input the caller left out and one it gave are different requests (an update with no data-source list keeps the page's own; `[]` clears it), so absence is tagged.
const tagged = (value) => (value === undefined ? { present: false } : { present: true, value });

// The environment a turn is scoped to, as a hash of its HTTPS origin — read from the URL the backend was made for, with no call to the service.
function environmentFingerprint(environment) {
  let url;
  try {
    url = new URL(String(environment));
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw argumentError(`a turn id needs the environment as a plain https:// address, and ${JSON.stringify(String(environment))} is not one`);
  }
  return sha256(`${TURN_REQUEST_DOMAIN}\nenvironment\n${url.origin.toLowerCase()}`);
}

const guidOrNull = (value, what) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !CANONICAL_GUID_RE.test(value.toLowerCase())) throw argumentError(`${what} must be a GUID (got ${JSON.stringify(value)})`);
  return value.toLowerCase();
};

// The effects of a whole upload (lib genpage-upload.js) beyond the page: the solution it joins, whether a changed deployed page may be overwritten, and the navigation
// placement or view pin. A CLOSED shape, built by the upload from its own frozen plan; it is bound, never acted on here and never handed to the SDK, and it grants no
// permission. Each default the upload resolves (title, tables, language) is given as `{ explicit, value }`: the request binds the policy, the effective inputs the value.
//   { operation: 'upload-create' | 'upload-update', appId: GUID | null, solution: string | null, overwriteDeployed: boolean,
//     navigation: null | { operation: 'place' | 'pin-views', title, tables, language, publication: 'draft' | 'publish' } }
const CONTEXT_KEYS = ['appId', 'navigation', 'operation', 'overwriteDeployed', 'solution'];
const NAVIGATION_KEYS = ['language', 'operation', 'publication', 'tables', 'title'];
function closedKeys(value, keys, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw argumentError(`${what} must be an object`);
  const own = Reflect.ownKeys(value).map(String).sort();
  if (own.join(',') !== keys.join(',')) throw argumentError(`${what} must have exactly the members ${keys.join(', ')} (got ${own.join(', ') || 'none'})`);
}
function resolvedOf(value, what, check) {
  if (value === null) return null;
  closedKeys(value, ['explicit', 'value'], what);
  if (typeof value.explicit !== 'boolean') throw argumentError(`${what}.explicit must be true or false`);
  return { explicit: value.explicit, value: check(value.value) };
}
function turnContextOf(context, operation) {
  if (context === undefined || context === null) return undefined;
  closedKeys(context, CONTEXT_KEYS, 'turnContext');
  const side = operation === 'create' ? 'upload-create' : 'upload-update';
  if (context.operation !== side) throw argumentError(`turnContext.operation must be '${side}' for a page ${operation} (got ${JSON.stringify(context.operation)})`);
  const appId = guidOrNull(context.appId, 'turnContext.appId');
  if (context.solution !== null && (typeof context.solution !== 'string' || !context.solution.trim())) throw argumentError('turnContext.solution must be a solution unique name or null');
  if (typeof context.overwriteDeployed !== 'boolean') throw argumentError('turnContext.overwriteDeployed must be true or false');
  let navigation = null;
  if (context.navigation !== null) {
    const nav = context.navigation;
    closedKeys(nav, NAVIGATION_KEYS, 'turnContext.navigation');
    if (!appId) throw argumentError('turnContext.navigation needs turnContext.appId');
    if (!['place', 'pin-views'].includes(nav.operation)) throw argumentError(`turnContext.navigation.operation must be 'place' or 'pin-views' (got ${JSON.stringify(nav.operation)})`);
    if (!['draft', 'publish'].includes(nav.publication)) throw argumentError(`turnContext.navigation.publication must be 'draft' or 'publish' (got ${JSON.stringify(nav.publication)})`);
    const placing = nav.operation === 'place';
    if (placing ? (nav.title === null || nav.language === null) : (nav.title !== null || nav.language !== null)) {
      throw argumentError("turnContext.navigation has a title and a language when it places the page ('place'), and neither when it pins views only ('pin-views')");
    }
    navigation = {
      appId,
      operation: nav.operation,
      title: resolvedOf(nav.title, 'turnContext.navigation.title', (v) => { if (typeof v !== 'string' || !v.trim()) throw argumentError('turnContext.navigation.title.value must be text'); return v; }),
      tables: resolvedOf(nav.tables, 'turnContext.navigation.tables', (v) => { if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) throw argumentError('turnContext.navigation.tables.value must be a list of table names'); return dataSourcesOf(v); }),
      language: resolvedOf(nav.language, 'turnContext.navigation.language', (v) => { if (!Number.isInteger(v) || v <= 0) throw argumentError('turnContext.navigation.language.value must be an LCID'); return v; }),
      publication: nav.publication,
    };
    if (navigation.tables === null) throw argumentError('turnContext.navigation.tables must be given');
  }
  return strictJsonCopy({ operation: context.operation, appId, solution: context.solution, overwriteDeployed: context.overwriteDeployed, navigation }, 'turnContext');
}

// The policy part of a resolved default (request) and its value (effective inputs).
const policyOf = (resolved) => (resolved === null ? null : resolved.explicit ? { explicit: true, value: resolved.value } : { explicit: false });
const valueOf = (resolved) => (resolved === null ? null : resolved.value);

// The caller's create/update arguments, normalized ONCE as the write normalizes them, deep-copied and frozen, plus the request they make.
//   operation    'create' | 'update' (the core verb; an upload says which of its own it is in `args.turnContext`)
//   environment  the URL the backend was made for
//   pageId       an update's page id (a create's explicit one is `args.pageId`); never part of requestSha256
//   compilerIdentity  { kind: 'bundled', … } | { kind: 'host', value } — what compiles the page
// Returns { operation, request, requestSha256, contentSha256, environmentFingerprint, explicitPageId, args } where `args` is the frozen normalized argument object the
// write continues with — the same values that were hashed.
function normalizeTurnRequest({ operation, environment, args = {}, compilerIdentity }) {
  if (operation !== 'create' && operation !== 'update') throw argumentError(`unknown page operation ${JSON.stringify(operation)}`);
  const creating = operation === 'create';
  const source = sourceText(args.source);
  const blankName = args.name === undefined || args.name === null || !String(args.name).trim();
  const name = blankName ? (creating ? 'Generative page' : undefined) : String(args.name);
  const listed = dataSourcesOf(args.dataSources);
  const dataSources = creating ? (listed || []) : listed;
  const model = args.model ? String(args.model) : undefined;
  const copyOf = (value, label) => {
    const list = bindingOf(value, label);
    return list === undefined ? undefined : strictJsonCopy(list, label);
  };
  const connectorBindings = copyOf(args.connectorBindings, 'connectorBindings');
  const actionBindings = copyOf(args.actionBindings, 'actionBindings');
  if (args.specBindings !== undefined && typeof args.specBindings !== 'boolean') throw argumentError(`specBindings must be true or false (got ${JSON.stringify(args.specBindings)})`);
  const specBindings = args.specBindings === true;
  if (args.publish !== undefined && typeof args.publish !== 'boolean') throw argumentError(`publish must be true or false (got ${JSON.stringify(args.publish)})`);
  const draft = args.publish === false;
  const receipt = args.publishedFingerprint;
  if (receipt !== undefined && receipt !== null && typeof receipt !== 'string') throw argumentError('publishedFingerprint must be the text of a fingerprint');
  const publishedFingerprint = typeof receipt === 'string' ? receipt : undefined;
  // turnOf's own rule: a prompt that is not blank is recorded exactly as given (it is NOT trimmed); a blank one is replaced by the default made from the page's name.
  const prompt = args.prompt && String(args.prompt).trim() ? String(args.prompt) : undefined;
  // Only an omitted (or null) reply takes the default; an explicit empty one records none.
  const agentMessage = args.agentMessage === undefined || args.agentMessage === null ? undefined : String(args.agentMessage);
  if (!compilerIdentity || typeof compilerIdentity !== 'object') throw argumentError('a turn needs the identity of the compiler');
  const context = turnContextOf(args.turnContext, operation);
  const scope = {
    environmentFingerprint: environmentFingerprint(environment),
    appId: context ? context.appId : null,
    solutionUniqueName: context ? context.solution : null,
  };
  const content = { source, name: tagged(name), dataSources: tagged(dataSources), model: tagged(model), connectorBindings: tagged(connectorBindings), actionBindings: tagged(actionBindings) };
  const request = strictJsonCopy({
    version: TURN_RECORD_FORMAT,
    operation: context ? context.operation : operation,
    scope,
    content,
    bindingMode: specBindings ? 'spec-merge' : 'replace',
    messages: { prompt: prompt === undefined ? { policy: 'default' } : { policy: 'explicit', value: prompt }, agentMessage: agentMessage === undefined ? { policy: 'default' } : { policy: 'explicit', value: agentMessage } },
    publication: draft ? 'draft' : 'publish',
    publishedFingerprint: tagged(publishedFingerprint),
    compilerIdentity: strictJsonCopy(compilerIdentity, 'the compiler identity'),
    effects: context
      ? {
        solution: context.solution,
        overwriteDeployed: context.overwriteDeployed,
        navigation: context.navigation && { ...context.navigation, title: policyOf(context.navigation.title), tables: policyOf(context.navigation.tables), language: policyOf(context.navigation.language) },
      }
      : { kind: 'none' },
  }, 'the turn request');
  const explicitPageId = creating && args.pageId !== undefined && args.pageId !== null ? String(args.pageId) : undefined;
  // The arguments the write goes on with: the normalized intent fields, and the members that are not part of the intent (callbacks, evidence, a source file name for
  // messages, the throttle budget) passed on as they were.
  const normalized = Object.freeze({
    ...pick(args, ['caller', 'appId', 'sourceFile', 'runtimeEvidence', 'throttle', 'beforeSend', 'sentBefore']),
    source, name, dataSources, model, connectorBindings, actionBindings, specBindings, publish: !draft, publishedFingerprint, prompt, agentMessage,
    ...(explicitPageId !== undefined ? { pageId: explicitPageId } : {}),
  });
  return Object.freeze({
    operation: request.operation,
    request,
    requestSha256: hashTurnRequest(request),
    contentSha256: sha256(`${TURN_REQUEST_DOMAIN}\ncontent\n${canonicalJson(request.content)}`),
    environmentFingerprint: scope.environmentFingerprint,
    explicitPageId,
    specBindings,
    context,
    args: normalized,
  });
}
function pick(args, keys) {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

const hashTurnRequest = (request) => sha256(`${TURN_REQUEST_DOMAIN}\n${canonicalJson(request)}`);

// What is actually sent once the defaults are resolved: the turn's two messages exactly as the SDK records them, and an upload's resolved navigation values.
function hashEffectiveInputs({ turn, context }) {
  const effective = strictJsonCopy({
    messages: { prompt: String(turn.prompt), agentMessage: tagged(turn.agentMessage === undefined ? undefined : String(turn.agentMessage)) },
    effects: context && context.navigation
      ? { navigation: { title: valueOf(context.navigation.title), tables: valueOf(context.navigation.tables), language: valueOf(context.navigation.language) } }
      : null,
  }, 'the effective turn inputs');
  return sha256(`${TURN_INTENT_DOMAIN}\neffective\n${canonicalJson(effective)}`);
}

function finalTurnIntent({ requestSha256, pageId, effectiveInputsSha256 }) {
  return sha256(`${TURN_INTENT_DOMAIN}\n${requestSha256}\n${String(pageId).toLowerCase()}\n${effectiveInputsSha256}`);
}

const RECORD_KEYS = ['formatVersion', 'intentVersion', 'turnId', 'operation', 'environmentFingerprint', 'pageId', 'requestSha256', 'effectiveInputsSha256', 'intentSha256'];

function makeTurnRecord({ turnId, operation, environmentFingerprint: environment, pageId, requestSha256, effectiveInputsSha256 }) {
  const fields = { turnId, operation, environmentFingerprint: environment, pageId: String(pageId).toLowerCase(), requestSha256, effectiveInputsSha256 };
  return validateTurnRecord({ formatVersion: TURN_RECORD_FORMAT, intentVersion: TURN_INTENT_DOMAIN, ...fields, intentSha256: finalTurnIntent(fields) }, turnId);
}

// A record as a store hands it back (the file store's, or a host's own adapter's), held to the closed v2 shape and its own digest. Anything else — a record of the
// earlier format (which held no binding mode, publication, scope or effects), a member missing or unknown, a value of the wrong form, a digest that does not add up —
// cannot establish the original request, and is NEVER read as a free id: GENPAGE_TURN_STATE_INCOMPLETE, nothing changed, the record left as it is.
function validateTurnRecord(record, turnId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw incompleteError(turnId, 'it is not a JSON object');
  if (record.formatVersion === 1) throw incompleteError(turnId, 'it was written in format 1, which does not record the binding mode, publication, scope or effects of the request');
  if (record.formatVersion !== TURN_RECORD_FORMAT) throw incompleteError(turnId, `format ${JSON.stringify(record.formatVersion)} is not one this tool reads`);
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...RECORD_KEYS].sort().join(',')) throw incompleteError(turnId, `its members are ${keys.join(', ')}`);
  if (record.intentVersion !== TURN_INTENT_DOMAIN) throw incompleteError(turnId, `intent version ${JSON.stringify(record.intentVersion)}`);
  if (record.turnId !== turnId) throw incompleteError(turnId, `it names turn ${JSON.stringify(record.turnId)}`);
  if (!OPERATIONS.includes(record.operation)) throw incompleteError(turnId, `operation ${JSON.stringify(record.operation)}`);
  if (typeof record.pageId !== 'string' || !CANONICAL_GUID_RE.test(record.pageId)) throw incompleteError(turnId, `page id ${JSON.stringify(record.pageId)}`);
  for (const key of ['environmentFingerprint', 'requestSha256', 'effectiveInputsSha256', 'intentSha256']) {
    if (typeof record[key] !== 'string' || !HEX64_RE.test(record[key])) throw incompleteError(turnId, `${key} is not a lower-case SHA-256`);
  }
  if (finalTurnIntent(record) !== record.intentSha256) throw incompleteError(turnId, 'its intent digest does not match its request, page and inputs');
  const out = {};
  for (const key of RECORD_KEYS) out[key] = record[key];
  return Object.freeze(out);
}

// What differs between two complete records of one turn id, in words, or '' when they are the same request.
function turnDifference(held, mine) {
  if (held.operation !== mine.operation) return `it was bound to a page ${held.operation}, and this is a page ${mine.operation}`;
  if (held.environmentFingerprint !== mine.environmentFingerprint) return 'it was bound in another environment';
  if (held.pageId !== mine.pageId) return `it was bound to page ${held.pageId}`;
  if (held.requestSha256 !== mine.requestSha256) return 'it was bound to other content, binding mode, messages, publication, receipt, compiler or effects';
  if (held.effectiveInputsSha256 !== mine.effectiveInputsSha256) return 'it was bound to other resolved messages or effects (a default, such as the prompt made from the page\'s name, is no longer the same)';
  return held.intentSha256 === mine.intentSha256 ? '' : 'its intent differs';
}

module.exports = {
  TURN_RECORD_FORMAT, TURN_REQUEST_DOMAIN, TURN_INTENT_DOMAIN, MIGRATION_ADVICE,
  normalizeTurnId, normalizeTurnRequest, hashTurnRequest, incompleteRecord: incompleteError, hashEffectiveInputs, finalTurnIntent, makeTurnRecord, validateTurnRecord, turnDifference,
  strictJsonCopy, canonicalJson, environmentFingerprint,
};

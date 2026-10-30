'use strict';
// app.theme (Preview): the strict read policy for the SDK's app theme reads.
//
// The bundled SDK's theme reads are permissive in ways that lose evidence, and the bundle is vendored and never edited:
//   - its setting-definition read drops a row with no `uniquename` and lets a second row of one name overwrite the first;
//   - its setting-row read accepts a definition id the read did not ask for, and turns a value that is not text into '';
//   - its web resource lookup by name takes the FIRST matching row of the FIRST page and reads a match with no id as
//     "no such resource" — so a lookup that says "absent" can hide a real row.
// A build that turns such a read into a write (set the theme, keep a version, add a member) must never act on a row it
// could not place. So the answers are judged here, at the HTTP client the SDK is given, BEFORE the SDK filters them:
// every returned row is placed against what the read asked for, or the read fails with APP_THEME_READ_INCOMPLETE and the
// operation's outcome is unknown. Nothing is guessed, and a row is never dropped to make an answer fit.
//
// Scope. The policy judges an answer only while a theme operation of THIS client is running: `withThemeReadScope` opens a
// scope (AsyncLocalStorage, so it follows the operation's own awaits and nothing else), and a read made outside every
// scope — any other feature's read, through the same client — is passed through untouched. Inside a scope only the read
// shapes the SDK's theme code sends (listed at READ_SHAPES) are judged; every other request is the client's own.
//
// Pages. A judged collection is read to its end here, through the original client: every `@odata.nextLink` is followed
// (same origin and API root only, never a link seen before, at most MAX_PAGES pages), every page must carry a `value`
// list, and a page that says more rows exist without a link is incomplete. The SDK is handed ONE answer: the first
// page's status and headers with every row, and no continuation — so it never reads a partial set as a whole one. These
// continuation GETs are the only requests the policy adds; it never changes or adds a write.
//
// Writes. While a scope is open the policy also COUNTS the writes sent through the client (it never changes one). A
// failed operation with zero writes has authoritative no-write evidence; one with any write may have saved part of its
// work, so lib/app-theme.js reports it unknown rather than guessing which part.
//
// Collection answers: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query-data-web-api
// Paging: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results

const { AsyncLocalStorage } = require('node:async_hooks');

const READ_INCOMPLETE = 'APP_THEME_READ_INCOMPLETE';
const IDENTITY_UNPROVEN = 'APP_THEME_IDENTITY_UNPROVEN';
const MAX_PAGES = 40;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THEME_SETTING = 'CustomThemeDefinition';
const HEADER_SETTING = 'OverrideAppHeaderColor';
const MORE_RECORDS = '@Microsoft.Dynamics.CRM.morerecords';
const NEXT_LINK = '@odata.nextLink';
// Marks set by this module: on a guarded client (its guard token), on an SDK whose client is guarded, on a failure it raised.
const GUARD_TOKEN = Symbol.for('model-apps.app-theme-read-guard');
const SDK_GUARD = Symbol.for('model-apps.app-theme-read-guarded-sdk');
const INCOMPLETE = Symbol.for('model-apps.app-theme-read-incomplete');
const WRITE_METHODS = new Set(['post', 'patch', 'put', 'delete', 'postRaw', 'patchRaw']);

const storage = new AsyncLocalStorage();
const isGuid = (value) => typeof value === 'string' && GUID.test(value);
const lower = (value) => String(value).toLowerCase();
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const defaultError = (code, message) => Object.assign(new Error(message), { code });

// The read shapes the SDK's theme code sends (AppThemeApi in the vendored bundle), as the transport sees them: the full
// URL, its query percent-encoded once. `path` is the part after the API root (`/api/data/v9.2`), compared ignoring case;
// `select` is the exact `$select`. Examples (decoded):
//   app          /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,uniquename,name&$filter=appmoduleid eq <app>
//   definitions  /settingdefinitions?$select=settingdefinitionid,uniquename,displayname&$filter=uniquename eq 'CustomThemeDefinition' or uniquename eq 'OverrideAppHeaderColor'
//   plain        /appsettings?$select=appsettingid,value,_settingdefinitionid_value&$filter=_parentappmoduleid_value eq <app> and (_settingdefinitionid_value eq <def> or …)
//   unpublished  /appsettings/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appsettingid,value,componentstate,_settingdefinitionid_value&$filter=<as plain>
//   resource     /webresourceset?$select=webresourceid,name,webresourcetype[,content]&$filter=name eq '<name, a quote doubled>'
//   publisher    /publishers?$select=publisherid&$filter=customizationprefix eq '<prefix>'
//   setting      /RetrieveSetting(SettingName='CustomThemeDefinition'[,AppUniqueName='<app unique name>'])
//   type         /solutioncomponentdefinitions?$select=solutioncomponenttype,primaryentityname&$filter=primaryentityname eq 'appsetting'
//   members      /solutioncomponents?$select=objectid,componenttype&$filter=_solutionid_value eq <solution> and (objectid eq <id> or …)
const UNPUBLISHED = '/microsoft.dynamics.crm.retrieveunpublishedmultiple()';
function shapeOf(path, select) {
  const p = lower(path);
  if (p === `/appmodules${UNPUBLISHED}` && select === 'appmoduleid,uniquename,name') return 'app';
  if (p === '/settingdefinitions' && /^settingdefinitionid,uniquename(,displayname)?$/.test(select || '')) return 'definitions';
  if (p === '/appsettings' && select === 'appsettingid,value,_settingdefinitionid_value') return 'plain';
  if (p === `/appsettings${UNPUBLISHED}` && select === 'appsettingid,value,componentstate,_settingdefinitionid_value') return 'unpublished';
  if (p === '/webresourceset' && /^webresourceid,name,webresourcetype(,content)?$/.test(select || '')) return 'resource';
  if (p === '/publishers' && select === 'publisherid') return 'publisher';
  if (/^\/retrievesetting\(/.test(p)) return 'setting';
  if (p === '/solutioncomponentdefinitions' && select === 'solutioncomponenttype,primaryentityname') return 'type';
  if (p === '/solutioncomponents' && select === 'objectid,componenttype') return 'members';
  return null;
}

const OPERATION = {
  app: 'app lookup', definitions: 'theme setting definition', plain: 'published theme setting', unpublished: 'unpublished theme setting',
  resource: 'web resource lookup', publisher: 'publisher lookup', setting: 'resolved setting', type: 'setting component type', members: 'solution membership',
};

function incomplete(guard, scope, shape, reason) {
  if (scope && !scope.incomplete) scope.incomplete = { operation: OPERATION[shape] || shape };
  // The words name the read and what was wrong with its ANSWER, never the URL, a row's values or the body: a value can
  // be anything a maker stored, and an answer is not for a message.
  const error = guard.makeError(READ_INCOMPLETE, `app.theme: the ${OPERATION[shape] || 'theme'} read ${reason}; nothing is concluded from it, so the app theme's state is unknown.`);
  Object.defineProperty(error, INCOMPLETE, { value: true });
  return error;
}

// Split a full URL the SDK sends into its API root (`https://<host>/api/data/v9.2`), the path after it and its query.
function partsOf(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const match = /^(\/api\/data\/v\d+(?:\.\d+)?)(\/.*)$/i.exec(parsed.pathname);
  if (!match) return null;
  let path;
  try { path = decodeURIComponent(match[2]); } catch { return null; }
  return { origin: parsed.origin, root: lower(match[1]), path, select: parsed.searchParams.get('$select'), filter: parsed.searchParams.get('$filter') || '' };
}

const quoted = (re, text) => [...String(text).matchAll(re)].map((m) => m[1].replace(/''/g, "'"));
const guids = (re, text) => [...String(text).matchAll(re)].map((m) => lower(m[1]));

// Every row of a judged collection, all pages, or an `incomplete` failure. `first` is the SDK's own first answer.
async function allRows(guard, scope, shape, url, options, first) {
  const start = partsOf(url);
  const seen = new Set([url]);
  const rows = [];
  let response = first;
  for (let page = 1; ; page += 1) {
    const body = response && response.body;
    if (!isObject(body) || !Array.isArray(body.value)) throw incomplete(guard, scope, shape, 'answered a page with no list of rows');
    rows.push(...body.value);
    const link = body[NEXT_LINK];
    if (link === undefined || link === null) {
      const more = body[MORE_RECORDS];
      if (more === undefined || more === null || more === false) return rows;
      throw incomplete(guard, scope, shape, 'said more rows exist but gave no link to them');
    }
    if (typeof link !== 'string' || !link) throw incomplete(guard, scope, shape, 'answered a malformed continuation link');
    const next = partsOf(link);
    // The link is response-controlled and the client signs every request it sends, so it must stay on this instance and
    // under the same API root (getAbsolute in the SDK asserts the origin; the API root is checked here as well).
    if (!next || next.origin !== start.origin || next.root !== start.root) throw incomplete(guard, scope, shape, 'answered a continuation link off this environment\'s API');
    if (seen.has(link)) throw incomplete(guard, scope, shape, 'answered a continuation link it had already given (a cycle)');
    if (page >= MAX_PAGES) throw incomplete(guard, scope, shape, `needed more than ${MAX_PAGES} pages`);
    seen.add(link);
    response = await guard.client.get(link, options);
    if (!response || !(response.status >= 200 && response.status < 300)) throw incomplete(guard, scope, shape, 'failed on a later page');
  }
}

// The judgement of each shape's rows: a reason string when a row cannot be placed, null when every row is placed.
function judgeRows(shape, rows, parts, scope) {
  const { filter } = parts;
  if (rows.some((row) => !isObject(row))) return 'answered a row that is not an object';
  if (shape === 'app') {
    const wanted = guids(/appmoduleid eq \{?([0-9a-f-]{36})\}?/gi, filter);
    if (wanted.length !== 1) return 'asked for no single app';
    if (scope.appId && wanted[0] !== scope.appId) return 'asked for another app than this operation\'s';
    if (rows.length > 1) return 'answered more than one app';
    if (rows.some((row) => !isGuid(row.appmoduleid) || lower(row.appmoduleid) !== wanted[0] || typeof row.uniquename !== 'string' || !row.uniquename)) return 'answered an app row that is not the app it asked for';
    return null;
  }
  if (shape === 'definitions') {
    const wanted = new Set(quoted(/uniquename eq '((?:[^']|'')*)'/g, filter));
    const names = new Set();
    const ids = new Set();
    for (const row of rows) {
      if (!isGuid(row.settingdefinitionid)) return 'answered a definition with no id';
      if (typeof row.uniquename !== 'string' || !wanted.has(row.uniquename)) return 'answered a definition it did not ask for';
      if (names.has(row.uniquename) || ids.has(lower(row.settingdefinitionid))) return 'answered one definition twice';
      names.add(row.uniquename);
      ids.add(lower(row.settingdefinitionid));
    }
    for (const row of rows) scope.definitions.set(row.uniquename, lower(row.settingdefinitionid));
    return null;
  }
  if (shape === 'plain' || shape === 'unpublished') {
    const app = guids(/_parentappmoduleid_value eq \{?([0-9a-f-]{36})\}?/gi, filter);
    const defs = new Set(guids(/_settingdefinitionid_value eq \{?([0-9a-f-]{36})\}?/gi, filter));
    if (app.length !== 1 || !defs.size) return 'asked for no single app and setting';
    if (scope.appId && app[0] !== scope.appId) return 'asked for another app than this operation\'s';
    const known = new Set(scope.definitions.values());
    const byDef = new Map();
    for (const row of rows) {
      if (!isGuid(row.appsettingid)) return 'answered a setting row with no id';
      const def = isGuid(row._settingdefinitionid_value) ? lower(row._settingdefinitionid_value) : null;
      if (!def || !defs.has(def) || (known.size && !known.has(def))) return 'answered a setting row of a definition it did not ask for';
      if (row._parentappmoduleid_value !== undefined && (!isGuid(row._parentappmoduleid_value) || lower(row._parentappmoduleid_value) !== app[0])) return 'answered a setting row of another app';
      if (typeof row.value !== 'string') return 'answered a setting value that is not text';
      if (shape === 'unpublished' && row.componentstate !== 0 && row.componentstate !== 1) return 'answered a setting row in a state it cannot place';
      if (byDef.has(def)) return 'answered two rows for one setting';
      byDef.set(def, { id: lower(row.appsettingid), value: row.value, componentstate: row.componentstate });
    }
    // The two projections are read one after the other (plain, then unpublished) for one filter; the pair is judged
    // when the second arrives. Supported pairs per setting, as Dataverse keeps one row per app and setting:
    //   plain only                 a published row whose removal is pending its app publish
    //   unpublished (state 1) only a draft row never published
    //   both, one id, state 0      a published row, with the SAME value in both
    //   both, one id, state 1      a published row with a draft over it
    // Anything else (an unpublished row in state 0 with no published layer, two ids, a state-0 pair of two values) is a
    // shape this build cannot place, so it is unknown, never read as one of the above.
    // https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appsetting
    const pairKey = `${app[0]}|${[...defs].sort().join(',')}`;
    if (shape === 'plain') { scope.plain.set(pairKey, byDef); return null; }
    const plain = scope.plain.get(pairKey);
    if (!plain) return null;
    scope.plain.delete(pairKey);
    for (const def of defs) {
      const p = plain.get(def);
      const u = byDef.get(def);
      if (!u) continue;
      if (!p) { if (u.componentstate !== 1) return 'answered an unpublished row with no published layer in a state it cannot place'; continue; }
      if (p.id !== u.id) return 'answered the two layers of one setting with different row ids';
      if (u.componentstate === 0 && p.value !== u.value) return 'answered a published row whose two projections differ';
    }
    return null;
  }
  if (shape === 'resource') {
    const names = quoted(/name eq '((?:[^']|'')*)'/g, filter);
    if (names.length !== 1) return 'asked for no single name';
    const withContent = /,content$/.test(parts.select);
    for (const row of rows) {
      if (typeof row.name !== 'string' || lower(row.name) !== lower(names[0])) return 'answered a resource of another name';
      if (!isGuid(row.webresourceid)) return 'answered a resource with no id';
      if (typeof row.webresourcetype !== 'number' || !Number.isInteger(row.webresourcetype)) return 'answered a resource with no type';
      if (withContent && typeof row.content !== 'string') return 'answered a resource with no content';
    }
    // A web resource name is unique ignoring case, so more than one row cannot be placed (it is not "the first one").
    if (rows.length > 1) return 'answered more than one resource of one name';
    return null;
  }
  if (shape === 'publisher') {
    if (rows.some((row) => !isGuid(row.publisherid))) return 'answered a publisher with no id';
    return null;
  }
  if (shape === 'type') {
    if (rows.length !== 1) return 'answered no single component type';
    const type = rows[0].solutioncomponenttype;
    if (!Number.isInteger(type) || type <= 0 || rows[0].primaryentityname !== 'appsetting') return 'answered a component type it cannot place';
    return null;
  }
  if (shape === 'members') {
    const wanted = new Set(guids(/objectid eq \{?([0-9a-f-]{36})\}?/gi, filter));
    if (!wanted.size || guids(/_solutionid_value eq \{?([0-9a-f-]{36})\}?/gi, filter).length !== 1) return 'asked for no single solution and members';
    for (const row of rows) {
      if (!isGuid(row.objectid) || !wanted.has(lower(row.objectid))) return 'answered a member it did not ask for';
      if (!Number.isInteger(row.componenttype)) return 'answered a member with no component type';
    }
    return null;
  }
  return null;
}

// RetrieveSetting answers one object, not a collection:
//   { "SettingDetail": { "Name": "CustomThemeDefinition", "Value": "\"\"", "DataType": 1 } }
// https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrievesetting
function judgeSetting(body) {
  if (!isObject(body) || !isObject(body.SettingDetail)) return 'answered no setting detail';
  if (typeof body.SettingDetail.Value !== 'string') return 'answered a setting value that is not text';
  if (!Number.isInteger(body.SettingDetail.DataType)) return 'answered a setting with no data type';
  return null;
}

/**
 * `httpClient` with the theme read policy: while a scope of this guard is open (withThemeReadScope), each judged read's
 * answer is read to its end and every row placed, or `get` throws `makeError('APP_THEME_READ_INCOMPLETE', message)`;
 * writes are counted on the scope. Outside every scope the client is used as it is. Every other member runs on the
 * client itself (a delegating Proxy, as lib/collection-answers.js's guard is), so a client with private state works.
 */
function guardAppThemeReads(httpClient, makeError = defaultError) {
  if (!httpClient || typeof httpClient.get !== 'function') return httpClient;
  if (httpClient[GUARD_TOKEN]) return httpClient;
  const token = { name: 'app-theme-read-guard' };
  const guard = { client: httpClient, makeError };
  const active = () => { const scope = storage.getStore(); return scope && scope.token === token ? scope : null; };
  const get = async (url, options) => {
    const scope = active();
    const response = await httpClient.get(url, options);
    if (!scope) return response;
    const parts = partsOf(url);
    const shape = parts ? shapeOf(parts.path, parts.select) : null;
    // A status the SDK reports (a 403's words, a 404) stays the SDK's to report: only a 2xx answer is judged.
    if (!shape || !response || !(response.status >= 200 && response.status < 300)) return response;
    scope.reads += 1;
    if (shape === 'setting') {
      const reason = judgeSetting(response.body);
      if (reason) throw incomplete(guard, scope, shape, reason);
      return response;
    }
    const rows = await allRows(guard, scope, shape, url, options, response);
    const reason = judgeRows(shape, rows, parts, scope);
    if (reason) throw incomplete(guard, scope, shape, reason);
    const body = { ...response.body, value: rows };
    delete body[NEXT_LINK];
    delete body[MORE_RECORDS];
    return { ...response, body };
  };
  const counted = (key, method) => (...args) => {
    const scope = active();
    if (scope) scope.writes += 1;
    return method.apply(httpClient, args);
  };
  return new Proxy({}, {
    get: (_, key) => {
      if (key === 'get') return get;
      if (key === GUARD_TOKEN) return token;
      const value = httpClient[key];
      if (typeof value !== 'function') return value;
      return WRITE_METHODS.has(key) ? counted(key, value) : value.bind(httpClient);
    },
    has: (_, key) => key === 'get' || key === GUARD_TOKEN || key in httpClient,
  });
}

/** Mark `sdk` as made over `guardedClient` (the client guardAppThemeReads returned), so a theme operation may run on it. */
function markThemeReadGuarded(sdk, guardedClient) {
  const token = guardedClient && guardedClient[GUARD_TOKEN];
  if (!token) throw new TypeError('markThemeReadGuarded: the client is not one guardAppThemeReads returned');
  Object.defineProperty(sdk, SDK_GUARD, { value: token, configurable: false, enumerable: false, writable: false });
  return sdk;
}

const isThemeReadGuarded = (sdk) => Boolean(sdk && sdk[SDK_GUARD]);

/** Refuse an SDK whose reads are not under this policy: a theme operation on it could act on a row it cannot place. */
function assertThemeReadGuard(sdk, makeError = defaultError) {
  if (isThemeReadGuarded(sdk)) return;
  throw makeError(READ_INCOMPLETE, 'app.theme: this SDK was not made with the strict theme reads (themeReads), so a theme read cannot be proven complete; nothing was read or written.');
}

/**
 * Run `work(scope)` with the theme read policy of `sdk`'s client active for it, and for nothing else. `descriptor.appId`
 * is the one app the operation's reads may name. A scope already open for the same guard is reused (an operation's
 * nested step), so writes are counted once. `scope.writes` counts writes sent while it is open; `scope.incomplete` is
 * set by the first read that could not be placed, even when the SDK turned that failure into a warning.
 */
function withThemeReadScope(sdk, descriptor, work) {
  const token = sdk && sdk[SDK_GUARD];
  if (!token) throw new TypeError('withThemeReadScope: the SDK is not marked as guarded (markThemeReadGuarded)');
  const open = storage.getStore();
  if (open && open.token === token) return work(open);
  const appId = descriptor && isGuid(descriptor.appId) ? lower(descriptor.appId) : null;
  const scope = { token, appId, definitions: new Map(), plain: new Map(), writes: 0, reads: 0, incomplete: null };
  return storage.run(scope, () => work(scope));
}

/** Whether `error` (or one of its causes) is a read this policy could not place. */
function isReadIncomplete(error) {
  let at = error;
  for (let depth = 0; at && typeof at === 'object' && depth < 8; depth += 1) {
    if (at[INCOMPLETE] || at.code === READ_INCOMPLETE) return true;
    at = at.cause;
  }
  return false;
}

// The query the SDK writes, percent-encoded once (its odataQuery), so a read made here has the shape the policy judges.
const query = (params) => `?${params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`;
const succeeded = (response) => response && response.status >= 200 && response.status < 300;

// The key the theme's semantic identity rests on: Dataverse keeps the app's setting row unique on
//   componentstate + overwritetime + parentappmoduleid + settingdefinitionid
// (the layer-qualified key; observed answer shape:
//   { "value": [ { "LogicalName": "uniquerelationshipattribute",
//                  "KeyAttributes": ["componentstate","overwritetime","parentappmoduleid","settingdefinitionid"],
//                  "EntityKeyIndexStatus": "Active" } ] }).
// Without it Active, "the app's theme row" is not one row, so nothing is written. Read once per client; never created or
// changed here. https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/entitykeymetadata
const KEY_ATTRIBUTES = ['componentstate', 'overwritetime', 'parentappmoduleid', 'settingdefinitionid'];
const provenKeys = new WeakMap();
async function assertThemeIdentityConstraint(client, makeError = defaultError) {
  if (!client || typeof client.get !== 'function') throw makeError(IDENTITY_UNPROVEN, 'app.theme: no client to read the setting row key with; nothing was written.');
  if (provenKeys.get(client) === true) return;
  const unproven = (why) => makeError(IDENTITY_UNPROVEN, `app.theme: the app setting row's unique key ${why}, so the app's theme row is not proven to be one row; nothing was written.`);
  let response;
  try {
    response = await client.get(`/EntityDefinitions(LogicalName='appsetting')/Keys${query([['$select', 'LogicalName,KeyAttributes,EntityKeyIndexStatus']])}`);
  } catch (error) {
    throw Object.assign(unproven('could not be read'), { cause: error });
  }
  const body = response && response.body;
  if (!succeeded(response) || !isObject(body) || !Array.isArray(body.value) || body[NEXT_LINK] !== undefined) throw unproven('could not be read');
  const wanted = [...KEY_ATTRIBUTES].sort().join(',');
  const active = body.value.some((key) => isObject(key) && key.EntityKeyIndexStatus === 'Active' && Array.isArray(key.KeyAttributes)
    && key.KeyAttributes.every((name) => typeof name === 'string') && [...key.KeyAttributes].map(lower).sort().join(',') === wanted);
  if (!active) throw unproven('is not an active key over componentstate, overwritetime, parentappmoduleid and settingdefinitionid');
  provenKeys.set(client, true);
}

async function readCollection(client, path, makeError, what) {
  const response = await client.get(path);
  const body = response && response.body;
  // Inside a scope the policy has already read every page and dropped the continuation; one still present means the read
  // was not judged, so its first page is not the whole answer.
  if (!succeeded(response) || !isObject(body) || !Array.isArray(body.value) || body[NEXT_LINK] !== undefined || (body[MORE_RECORDS] !== undefined && body[MORE_RECORDS] !== false)) {
    throw makeError(READ_INCOMPLETE, `app.theme: the ${what} read could not be read; nothing is concluded from it.`);
  }
  return body.value;
}

/**
 * Where the app's theme setting row is NOW, read the way the SDK reads it (definition, then both projections; three
 * GETs, judged by the policy when run inside a scope). An OBSERVATION for a membership check or a re-read, never a record
 * of what anyone created: the id names whichever row holds the app's theme at this moment.
 *   { definitionId, state: 'absent'|'draft'|'published'|'publishedWithDraft'|'removalPending', settingId, latestValue,
 *     matches }   `matches` — the latest value is `expectedVersionName` (always true when none is expected)
 */
async function readThemeSettingIdentity(client, appId, expectedVersionName, makeError = defaultError) {
  if (!isGuid(appId)) throw makeError(READ_INCOMPLETE, 'app.theme: the app id is not a GUID; nothing is concluded.');
  const app = lower(appId);
  const definitions = await readCollection(client, `/settingdefinitions${query([['$select', 'settingdefinitionid,uniquename,displayname'], ['$filter', `uniquename eq '${THEME_SETTING}'`]])}`, makeError, 'theme setting definition');
  const theme = definitions.filter((row) => isObject(row) && row.uniquename === THEME_SETTING && isGuid(row.settingdefinitionid));
  if (theme.length !== 1 || definitions.length !== 1) throw makeError(READ_INCOMPLETE, 'app.theme: the theme setting definition did not read back as one definition; nothing is concluded.');
  const definitionId = lower(theme[0].settingdefinitionid);
  const filter = `_parentappmoduleid_value eq ${app} and (_settingdefinitionid_value eq ${definitionId})`;
  const plain = await readCollection(client, `/appsettings${query([['$select', 'appsettingid,value,_settingdefinitionid_value'], ['$filter', filter]])}`, makeError, 'published theme setting');
  const unpublished = await readCollection(client, `/appsettings/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()${query([['$select', 'appsettingid,value,componentstate,_settingdefinitionid_value'], ['$filter', filter]])}`, makeError, 'unpublished theme setting');
  const placed = (rows) => rows.length <= 1 && rows.every((row) => isObject(row) && isGuid(row.appsettingid) && typeof row.value === 'string');
  if (!placed(plain) || !placed(unpublished)) throw makeError(READ_INCOMPLETE, 'app.theme: the app\'s theme setting row did not read back as one row; nothing is concluded.');
  const [p] = plain;
  const [u] = unpublished;
  const state = !p ? (u ? 'draft' : 'absent') : !u ? 'removalPending' : u.componentstate === 1 ? 'publishedWithDraft' : 'published';
  const latestValue = state === 'absent' || state === 'removalPending' ? undefined : (u || p).value;
  const settingId = state === 'absent' || state === 'removalPending' ? null : lower((u || p).appsettingid);
  const matches = expectedVersionName === undefined || expectedVersionName === null ? true : latestValue === expectedVersionName;
  return { definitionId, state, settingId, latestValue, matches };
}

module.exports = {
  guardAppThemeReads,
  markThemeReadGuarded,
  isThemeReadGuarded,
  assertThemeReadGuard,
  withThemeReadScope,
  isReadIncomplete,
  assertThemeIdentityConstraint,
  readThemeSettingIdentity,
  READ_INCOMPLETE,
  IDENTITY_UNPROVEN,
  MAX_PAGES,
  THEME_SETTING,
  HEADER_SETTING,
  KEY_ATTRIBUTES,
};

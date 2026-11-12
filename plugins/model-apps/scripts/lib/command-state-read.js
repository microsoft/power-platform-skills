'use strict';
// Reads of the modern command buttons (`appaction` rows) of an app's tables, and the one strict reading of a row that says whether its
// `hidden` / `isdisabled` state is something a row-state edit may touch. Read-only: nothing here writes.
//
// Every read goes through a reader with `get(path)`, `getAbsolute(url)` and `apiUrl(path)` — lib/command-state-transport.js — so the same
// collection reader the build uses for an app's components (`collectionRows`, lib/app-components.js) reads every page, follows every
// continuation on the same origin and refuses an answer that is no list. A read that fails is an error, never a shorter list: a button that a
// failed page left out cannot be told from a button that is not there.
//
// The rows are the platform's, read with the columns of ROW_SELECT (lib/command-state-contract.js). A row is answered as, e.g.
//   { "@odata.etag": "W/\"4893215\"", "appactionid": "1d6b4b1e-...", "name": "contoso_Escalate!1a2b", "uniquename": "contoso_Escalate!1a2b",
//     "buttonlabeltext": "Escalate", "context": 1, "contextvalue": "contoso_project", "_contextentity_value": "8f2c...", "_appmoduleid_value": null,
//     "location": 0, "type": 0, "origin": 0, "statecode": 0, "statuscode": 1, "ismanaged": false,
//     "iscustomizable": { "Value": true, "CanBeChanged": true, "ManagedPropertyLogicalName": "iscustomizableanddeletable" },
//     "_parentappactionid_value": null, "hidden": false, "isdisabled": false, "visibilitytype": null, "visibilityformulacomponentlibrary": null,
//     "_visibilityformulacomponentlibraryid_value": null, "visibilityformulacomponentname": null, "visibilityformulafunctionname": null,
//     "onclickeventtype": 2 }
// The choice values are the public ones: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appaction
// Scope: `_appmoduleid_value` null is a TABLE-scoped command (every app that shows the table renders it), an app id an APP-scoped one —
// https://learn.microsoft.com/power-apps/maker/model-driven-apps/commanding-scopes

const { collectionRows, currentAppLayer, appComponentRows, tableRefs, TABLE_NAME } = require('./app-components.js');
const { odataLit } = require('./odata.js');
const { compareText } = require('./compare-text.js');
const {
  BAR_BY_LOCATION, UNSUPPORTED_BAR, ROW_VERSION, ROW_SELECT, REASONS, CommandStateError, guidOf, normalizeCommandStates, SPEC_FLAG, serviceAnswerText,
} = require('./command-state-contract.js');

const CONTEXT_UNVERIFIED = 'command-state-context-unverified';
const ROW_UNREADABLE = 'command-state-row-unreadable';
const VERSION_UNAVAILABLE = 'command-state-version-unavailable';
// The platform's "does not exist" for a record: { "error": { "code": "0x80040217", "message": "appaction With Id = ... Does Not Exist" } }
// Only a 404 that carries it proves a row is gone; any other 404 (a wrong path, a proxy) proves nothing.
const NOT_FOUND = '0x80040217';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (row, key) => Object.prototype.hasOwnProperty.call(row, key);

// The `code` of a Dataverse error answer — { "error": { "code": "0x80040217" } }, spelled `Error` by some surfaces — in lower case. It is
// compared, never said: what is said of an answer is serviceAnswerText's (lib/command-state-contract.js), which checks the code's shape.
function errorCode(body) {
  const envelope = isObject(body) ? (body.error || body.Error) : null;
  return isObject(envelope) && typeof envelope.code === 'string' ? envelope.code.toLowerCase() : '';
}

// What this feature says of a read that was refused or got no answer: its status and Dataverse error code, or, with no answer at all, the
// system error code (ECONNRESET) — serviceAnswerText, never the service's own text. The shared reader (collectionRows, lib/app-components.js)
// copies the service's `message` and the URL it read into the error it throws; it is left as it is, so a build without `commandStates` prints
// what it always printed, and this feature reads the facts from the answer instead (watched, below).
const failureOf = (answer) => ({ status: answer && answer.status, dataverseCode: errorCode(answer && answer.body) });
// An error this feature did not word, said by its status and system code; one of its own (a CommandStateError) keeps its words, which are
// serviceAnswerText's or fixed text.
function readFailureText(error) {
  if (error instanceof CommandStateError) return error.message;
  return serviceAnswerText({ status: error && error.statusCode, systemCode: error && error.code });
}

// The shared reader's complaints about an answer it WAS given (a 2xx), e.g.
//   "the modern commands of table 'contoso_ticket': repeated @odata.nextLink"
//   "the component list holds 1 row it cannot place: row 1 has an objectid that is no GUID ("<up to 40 characters of the service's value>")"
// read as the problem they name and the field they name, never copied: the second one quotes the service's value. A complaint not listed
// here is said as `unexpected`.
const SHARED_COMPLAINTS = [
  [/: repeated @odata\.nextLink$/, { problem: 'repeated-link' }],
  [/: malformed @odata\.nextLink$/, { problem: 'malformed-link', field: '@odata.nextLink' }],
  [/no readable result set$/, { problem: 'not-a-list', field: 'value' }],
  [/it cannot place: row \d+ is not a record/, { problem: 'not-a-record' }],
  [/it cannot place: row \d+ has (no objectid|an objectid that is no GUID)/, { problem: 'unplaceable', field: 'objectid' }],
  [/it cannot place: row \d+ (says no component type|has component type)/, { problem: 'unplaceable', field: 'componenttype' }],
  [/could not be resolved to a MetadataId \+ EntitySetName$/, { problem: 'malformed-field', field: ['MetadataId', 'EntitySetName'] }],
  [/^no single current layer among \d+ app row\(s\)$/, { problem: 'layer-ambiguous' }],
  // The transport's own refusal of a continuation, which currentAppLayer turns into a reason like any other error.
  [/^command-state transport: the next-page link pointed outside the expected API and was not followed$/, { problem: 'link-outside' }],
];
function complaintOf(text) {
  const found = SHARED_COMPLAINTS.find(([pattern]) => pattern.test(String(text)));
  return found ? found[1] : { problem: 'unexpected' };
}

// The reader, watched: the last read that was refused or got no answer, so a failure is said from its status and code rather than from the
// message the shared reader made of the service's text. Everything else is the reader's own (`apiUrl` and the rest, by prototype).
function watched(reader) {
  const watch = Object.create(reader);
  watch.failure = null;
  const seen = (answer) => {
    if (!answer || !(answer.status >= 200 && answer.status < 300)) watch.failure = failureOf(answer);
    return answer;
  };
  const thrown = (error) => {
    if (!(error instanceof CommandStateError)) watch.failure = { status: error && error.statusCode, systemCode: error && error.code };
    throw error;
  };
  for (const method of ['get', 'getAbsolute']) {
    // The transport is frozen, so its methods are read-only on the prototype and are shadowed by definition, not assignment.
    if (typeof reader[method] === 'function') {
      Object.defineProperty(watch, method, { value: (...args) => Promise.resolve().then(() => reader[method](...args)).then(seen, thrown) });
    }
  }
  return watch;
}

// Runs a read whose failure must carry this feature's code; a CommandStateError (the transport's refusal of a continuation) keeps its own.
// `run` is given the reader, watched. Every other failure is said as `<what>: <serviceAnswerText>`: a read that was refused or got no answer
// by its status and codes, a complaint about an answer that came by the problem it names (complaintOf).
async function as(code, what, reader, run) {
  const watch = watched(reader);
  try {
    return await run(watch);
  } catch (error) {
    if (error instanceof CommandStateError) throw error;
    const failure = watch.failure || (error && Number.isInteger(error.statusCode) ? { status: error.statusCode } : null);
    throw new CommandStateError(code, `${what}: ${serviceAnswerText(failure || complaintOf(error && error.message))}`);
  }
}

/**
 * Who the app is, which tables it holds, and whether the table of commands keeps row versions — everything a row is judged against.
 *   1. GET /appmodules?$select=appmoduleid,uniquename&$filter=uniquename eq '<name>'         every page; exactly one app
 *   2. its current saved layer (currentAppLayer)                                             one layer, never both unioned
 *   3. GET /appmodulecomponents?...componenttype eq 1  (appComponentRows, strict)             the complete list of its tables
 *   4. the tables: each named one by logical name (tableRefs), or, when none is named, each table component by its metadata id
 *   5. GET /EntityDefinitions(LogicalName='appaction')?$select=IsOptimisticConcurrencyEnabled
 * @param {object} reader - lib/command-state-transport.js
 * @param {{ appUniqueName: string, entities?: string[] }} args - no entities: every table of the app
 * @returns {Promise<{ appId: string, appUniqueName: string, appModuleIdUnique: string, optimisticConcurrency: boolean,
 *   tables: Map<string, { entity: string, metadataId: string, inApp: boolean }> }>}
 */
async function resolveCommandStateContext(reader, { appUniqueName, entities } = {}) {
  if (typeof appUniqueName !== 'string' || !appUniqueName.trim()) throw new CommandStateError(CONTEXT_UNVERIFIED, 'an app unique name is required');
  const apps = await as(CONTEXT_UNVERIFIED, `app '${appUniqueName}'`, reader, (r) => collectionRows(r,
    `/appmodules?$select=appmoduleid,uniquename&$filter=uniquename eq '${odataLit(appUniqueName)}'`, `app '${appUniqueName}'`, { code: CONTEXT_UNVERIFIED }));
  const appIds = apps.map((row) => (isObject(row) ? guidOf(row.appmoduleid) : null));
  if (appIds.some((id) => !id)) throw new CommandStateError(CONTEXT_UNVERIFIED, `app '${appUniqueName}': a row has no readable app id`);
  if (apps.length !== 1) {
    throw new CommandStateError(CONTEXT_UNVERIFIED, apps.length
      ? `app '${appUniqueName}': ${apps.length} published apps answer to this unique name`
      : `app '${appUniqueName}': no published app has this unique name`);
  }
  const appId = appIds[0];
  // currentAppLayer answers a failed read with the shared reader's message (layer.reason), which can quote the service: the watched reader says
  // a refused read from its status and code, and any other reason is read as the problem it names (complaintOf), never copied.
  const layerReader = watched(reader);
  const layer = await currentAppLayer(layerReader, appId);
  if (!layer.ok) {
    const failure = layerReader.failure || (Number.isInteger(layer.status) ? { status: layer.status } : complaintOf(layer.reason));
    throw new CommandStateError(CONTEXT_UNVERIFIED, `app '${appUniqueName}': its current layer could not be read: ${serviceAnswerText(failure)}`);
  }
  const components = await as(CONTEXT_UNVERIFIED, `app '${appUniqueName}': its tables`, reader, (r) => appComponentRows(r, layer.appModuleIdUnique, 1, { strict: true }));
  const memberIds = new Set(components.map((row) => guidOf(row.objectid)));

  const tables = new Map();
  if (Array.isArray(entities) && entities.length) {
    const names = [...new Set(entities.map((name) => String(name).toLowerCase()))];
    for (const name of names) {
      if (!TABLE_NAME.test(name)) throw new CommandStateError(CONTEXT_UNVERIFIED, `'${name}' is not a table's logical name`);
    }
    const refs = await as(CONTEXT_UNVERIFIED, `the tables ${names.join(', ')}`, reader, (r) => tableRefs(r, names));
    for (const name of names.sort(compareText)) {
      const { metadataId } = refs.get(name);
      tables.set(name, { entity: name, metadataId, inApp: memberIds.has(metadataId) });
    }
  } else {
    for (const metadataId of [...memberIds].sort()) {
      const what = `app '${appUniqueName}': table component ${metadataId}`;
      const answer = await as(CONTEXT_UNVERIFIED, what, reader, (r) => r.get(`/EntityDefinitions(${metadataId})?$select=LogicalName,MetadataId`));
      const answered = answer && answer.status >= 200 && answer.status < 300;
      const body = answered ? answer.body : undefined;
      let problem = null;
      if (!answered) problem = failureOf(answer);
      else if (!isObject(body)) problem = { problem: 'not-a-record' };
      else if (typeof body.LogicalName !== 'string' || !TABLE_NAME.test(body.LogicalName)) problem = { problem: 'malformed-field', field: 'LogicalName' };
      else if (guidOf(body.MetadataId) !== metadataId) problem = { problem: 'malformed-field', field: 'MetadataId' };
      if (problem) throw new CommandStateError(CONTEXT_UNVERIFIED, `${what} could not be resolved to a table: ${serviceAnswerText(problem)}`);
      tables.set(body.LogicalName, { entity: body.LogicalName, metadataId, inApp: true });
    }
  }

  // A row version exists only where the table keeps one: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api
  // Missing, not a boolean, or unreadable is no answer, never "on".
  const concurrency = await as(VERSION_UNAVAILABLE, 'whether the command table keeps row versions', reader, (r) => r.get("/EntityDefinitions(LogicalName='appaction')?$select=IsOptimisticConcurrencyEnabled"));
  const answered = concurrency && concurrency.status >= 200 && concurrency.status < 300;
  const flag = answered && isObject(concurrency.body) ? concurrency.body.IsOptimisticConcurrencyEnabled : undefined;
  if (typeof flag !== 'boolean') {
    const problem = answered ? { problem: 'malformed-field', field: 'IsOptimisticConcurrencyEnabled' } : failureOf(concurrency);
    throw new CommandStateError(VERSION_UNAVAILABLE, `whether the command table keeps row versions could not be read: ${serviceAnswerText(problem)}`);
  }
  return {
    appId, appUniqueName, appModuleIdUnique: layer.appModuleIdUnique, optimisticConcurrency: flag,
    tables: new Map([...tables].sort(([a], [b]) => compareText(a, b))),
  };
}

/**
 * One row, by its id:
 *   GET /appactions(<rowId>)?$select=<ROW_SELECT>
 * @returns {Promise<{ found: true, body: object } | { found: false }>} not found only for a 404 with the platform's "does not exist" code
 */
async function readCommandStateRow(reader, rowId) {
  const id = guidOf(rowId);
  if (!id || id !== rowId) throw new CommandStateError(ROW_UNREADABLE, `'${rowId}' is not a row id`);
  let answer;
  try {
    answer = await reader.get(`/appactions(${id})?$select=${ROW_SELECT.join(',')}`);
  } catch (error) {
    if (error instanceof CommandStateError) throw error;
    throw new CommandStateError(ROW_UNREADABLE, `command row ${id} could not be read: ${readFailureText(error)}`);
  }
  const status = answer && answer.status;
  if (status === 404 && errorCode(answer.body) === NOT_FOUND) return { found: false };
  if (!(status >= 200 && status < 300)) {
    throw new CommandStateError(ROW_UNREADABLE, `command row ${id} could not be read: ${serviceAnswerText(failureOf(answer))}`);
  }
  if (!isObject(answer.body)) throw new CommandStateError(ROW_UNREADABLE, `command row ${id} could not be read: ${serviceAnswerText({ problem: 'not-a-record' })}`);
  return { found: true, body: answer.body };
}

/**
 * What a row is, and every reason it is not a candidate for a row-state edit — none means it is one. Every column of ROW_SELECT must be in the
 * answer, of its kind: a missing column, a number spelled as text and a null where a number or a true/false belongs are each `shape-unreadable`
 * (or `flags-unreadable` for the two flags), never a default. `details` name the columns, never a value the platform sent.
 * @param {object} body - the row as the platform answered it
 * @param {object} expect
 * @param {string} [expect.rowId]       the row asked for
 * @param {string} [expect.entity]      the table's logical name
 * @param {string} [expect.metadataId]  the table's metadata id
 * @param {string} [expect.appId]       the app
 * @param {boolean} [expect.inApp]      false: the table is not one of the app's
 * @param {number} [expect.location]    the declared bar's number
 * @param {boolean} [expect.optimisticConcurrency]  false: the table of commands keeps no row versions
 * @param {boolean} [expect.requireVersion]  the answer must carry a usable row version
 */
function decodeCommandStateRow(body, expect = {}) {
  if (!isObject(body)) throw new CommandStateError(ROW_UNREADABLE, 'a command row is not a record');
  const reasons = new Set();
  const details = [];
  const bad = (field, why) => { reasons.add('shape-unreadable'); details.push(`${field} ${why}`); };
  for (const key of ROW_SELECT) if (!has(body, key)) bad(key, 'is missing');
  const int = (key) => {
    if (!has(body, key)) return null;
    if (Number.isInteger(body[key])) return body[key];
    bad(key, 'is not a whole number');
    return null;
  };
  const text = (key) => {
    if (!has(body, key) || body[key] === null) return null;
    if (typeof body[key] === 'string') return body[key];
    bad(key, 'is not text');
    return null;
  };
  // A lookup's value: null, or a GUID.
  const ref = (key) => {
    if (!has(body, key) || body[key] === null) return null;
    const id = guidOf(body[key]);
    if (!id) bad(key, 'is not a GUID');
    return id;
  };

  const rowId = guidOf(body.appactionid);
  if (has(body, 'appactionid') && !rowId) bad('appactionid', 'is not a GUID');
  if (expect.rowId && rowId && rowId !== expect.rowId) reasons.add('id-mismatch');

  const caption = text('buttonlabeltext');
  const name = text('name');
  const uniqueName = text('uniquename');

  const context = int('context');
  if (context !== null && context !== 1) reasons.add('context-not-table');
  const contextValue = text('contextvalue');
  const entity = contextValue === null ? null : contextValue.toLowerCase();
  const contextEntity = ref('_contextentity_value');
  if (expect.entity !== undefined && entity !== expect.entity) reasons.add('context-mismatch');
  if (expect.metadataId !== undefined && has(body, '_contextentity_value') && contextEntity !== expect.metadataId) reasons.add('context-mismatch');
  if (expect.inApp === false) reasons.add('table-not-in-app');

  const location = int('location');
  const bar = location !== null && has(BAR_BY_LOCATION, location) ? BAR_BY_LOCATION[location] : UNSUPPORTED_BAR;
  if (location !== null && bar === UNSUPPORTED_BAR) reasons.add('location-unsupported');
  if (expect.location !== undefined && location !== null && location !== expect.location) reasons.add('location-mismatch');

  // Only a table-scoped row (`_appmoduleid_value` present and null) is a candidate. A row scoped to an app — this app's own included — is not:
  // how an app-scoped row and its table-scoped siblings render together has not been measured, so it is refused, never widened to a broader edit.
  const owner = ref('_appmoduleid_value');
  let scope = 'unknown';
  if (has(body, '_appmoduleid_value')) {
    if (body._appmoduleid_value === null) scope = 'table';
    else if (owner && expect.appId !== undefined) scope = owner === expect.appId ? 'app' : 'other-app';
    else if (owner) scope = 'app';
  }
  if (scope === 'app' || scope === 'other-app') reasons.add('app-scoped');

  const type = int('type');
  if (type !== null && type !== 0) reasons.add('not-standard-button');
  const parentId = ref('_parentappactionid_value');
  if (parentId) reasons.add('nested');
  const origin = int('origin');
  if (origin !== null && origin !== 0) reasons.add('not-default-origin');
  const statecode = int('statecode');
  const statuscode = int('statuscode');
  if (statecode !== null && statuscode !== null && !(statecode === 0 && statuscode === 1)) reasons.add('inactive');

  let managed = null;
  if (has(body, 'ismanaged')) {
    if (typeof body.ismanaged === 'boolean') managed = body.ismanaged;
    else bad('ismanaged', 'is not true or false');
  }
  if (managed === true) reasons.add('managed');
  // A managed property is { "Value": true, "CanBeChanged": ..., "ManagedPropertyLogicalName": ... }; only Value says what it is.
  let customizable = null;
  if (has(body, 'iscustomizable')) {
    if (isObject(body.iscustomizable) && typeof body.iscustomizable.Value === 'boolean') customizable = body.iscustomizable.Value;
    else bad('iscustomizable', 'is not a managed property with a true or false Value');
  }
  if (customizable === false) reasons.add('not-customizable');

  const flag = (key) => {
    if (has(body, key) && typeof body[key] === 'boolean') return body[key];
    reasons.add('flags-unreadable');
    if (has(body, key)) details.push(`${key} is not true or false`);
    return null;
  };
  const hidden = flag('hidden');
  const disabled = flag('isdisabled');

  // Static visibility is `visibilitytype` PRESENT and null or 0, with every formula column present and null or empty. Null is what the
  // platform stores on the buttons a plain `commands[]` build writes (measured: every such row), so it is accepted here — but only as a
  // present null: a missing column stays unreadable, and 1 (Power Fx), 2 (classic rules), -1 or a number spelled as text never pass.
  // The feature never writes `visibilitytype`, not even to turn this null into 0.
  let visibilityType = null;
  if (has(body, 'visibilitytype') && body.visibilitytype !== null) {
    visibilityType = int('visibilitytype');
    if (visibilityType !== null && visibilityType !== 0) reasons.add('visibility-formula');
  }
  const formulaLibraryId = body._visibilityformulacomponentlibraryid_value === '' ? null : ref('_visibilityformulacomponentlibraryid_value');
  if (formulaLibraryId) reasons.add('visibility-formula');
  for (const key of ['visibilityformulacomponentlibrary', 'visibilityformulacomponentname', 'visibilityformulafunctionname']) {
    const value = text(key);
    if (value !== null && value !== '') reasons.add('visibility-formula');
  }
  const onClickType = int('onclickeventtype');
  if (onClickType === 1) reasons.add('formula-action');
  else if (onClickType !== null && onClickType !== 0 && onClickType !== 2) bad('onclickeventtype', 'is not a known kind of action');

  const etag = body['@odata.etag'];
  const version = typeof etag === 'string' && ROW_VERSION.test(etag) ? etag : null;
  if (expect.optimisticConcurrency === false) reasons.add('version-unavailable');
  if (expect.requireVersion && !version) reasons.add('version-unavailable');

  const ordered = REASONS.filter((reason) => reasons.has(reason));
  return {
    eligible: ordered.length === 0,
    reasons: ordered,
    details,
    row: {
      rowId, entity, contextEntityId: contextEntity, location, bar, caption, name, uniqueName, scope, appId: owner,
      type, origin, parentId, statecode, statuscode, managed, customizable, hidden, disabled, visibilityType, onClickType, version,
    },
  };
}

const captionKey = (caption) => (typeof caption === 'string' ? caption.trim().toLowerCase() : null);

/**
 * Every modern command bound to each table of the context, decoded, with why it is or is not a candidate. A row the platform answers more than
 * once, or an answer that is not a record, makes the whole read fail: the list must be complete to say "this is every button".
 *   GET /appactions?$select=<ROW_SELECT>&$filter=contextvalue eq '<table>'      every page, per table
 * `contextvalue` is the column download-model-app.js's command inventory and the teardown read a table's commands by.
 * @param {object} reader
 * @param {Awaited<ReturnType<typeof resolveCommandStateContext>>} context
 * @param {{ location?: number }} [filter] - keep the rows of one bar
 * @returns {Promise<object[]>} sorted by table, bar number, caption (unlabelled last), row id
 */
async function listCommandStateRows(reader, context, { location } = {}) {
  const out = [];
  const seen = new Set();
  for (const table of context.tables.values()) {
    const rows = await as(ROW_UNREADABLE, `the modern commands of table '${table.entity}'`, reader, (r) => collectionRows(r,
      `/appactions?$select=${ROW_SELECT.join(',')}&$filter=contextvalue eq '${odataLit(table.entity)}'`,
      `the modern commands of table '${table.entity}'`, { code: ROW_UNREADABLE }));
    for (const body of rows) {
      if (!isObject(body)) throw new CommandStateError(ROW_UNREADABLE, `the modern commands of table '${table.entity}': an answer row is not a record`);
      const decoded = decodeCommandStateRow(body, {
        entity: table.entity, metadataId: table.metadataId, appId: context.appId, inApp: table.inApp, optimisticConcurrency: context.optimisticConcurrency,
      });
      const id = decoded.row.rowId;
      if (id) {
        if (seen.has(id)) throw new CommandStateError(ROW_UNREADABLE, `the modern commands of table '${table.entity}': row ${id} was answered twice`);
        seen.add(id);
      }
      if (location !== undefined && decoded.row.location !== location) continue;
      out.push({ table: table.entity, ...decoded });
    }
  }
  // Two buttons with the same caption on one bar of one table are each named by their row id, and neither is picked for the other.
  const byCaption = new Map();
  for (const item of out) {
    const key = captionKey(item.row.caption);
    if (key === null) continue;
    const group = `${item.table}\u0000${item.row.location}\u0000${key}`;
    if (!byCaption.has(group)) byCaption.set(group, []);
    byCaption.get(group).push(item);
  }
  for (const group of byCaption.values()) {
    if (group.length < 2) continue;
    for (const item of group) item.sameCaption = group.filter((other) => other !== item).map((other) => other.row.rowId);
  }
  const nullLast = (a, b, compare) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : compare(a, b));
  out.sort((a, b) => compareText(a.table, b.table)
    || nullLast(a.row.location, b.row.location, (x, y) => x - y)
    || nullLast(a.row.caption, b.row.caption, compareText)
    || nullLast(a.row.rowId, b.row.rowId, compareText));
  return out;
}

// The reasons that say a row is not the one declared, or cannot be read as it — each fails the check. The others (managed, a formula, no row
// version, ...) say only that a build would refuse to write the row; they do not change what its stored flags are.
const NOT_THE_DECLARED_ROW = new Set([
  'shape-unreadable', 'flags-unreadable', 'id-mismatch', 'context-not-table', 'context-mismatch', 'table-not-in-app',
  'location-unsupported', 'location-mismatch', 'app-scoped',
]);
const STORED_ONLY = 'stored flags of the exact row; how the button renders is not checked';

/**
 * Whether each declared `commandStates[]` entry holds in the environment: its row exists, is the table-scoped row of the declared table and bar
 * in this app, and stores every flag the entry declares. A flag the entry leaves out is not checked. Read only: no approval is needed.
 * Anything that cannot be read fails the entry's check — never a pass, never left out.
 * @param {object} reader - lib/command-state-transport.js
 * @param {object} spec
 * @returns {Promise<Array<{ name: string, present: boolean, detail: string }>>} one per declared entry, in spec order
 */
async function verifyCommandStates(reader, spec) {
  const states = normalizeCommandStates(spec);
  if (!states.length) return [];
  const nameOf = (s) => `${s.entity} ${s.bar} row ${s.rowId}`;
  let context;
  try {
    context = await resolveCommandStateContext(reader, {
      appUniqueName: spec && spec.app && spec.app.uniqueName, entities: [...new Set(states.map((s) => s.entity))],
    });
  } catch (error) {
    return states.map((s) => ({ name: nameOf(s), present: false, detail: `could not be read: ${readFailureText(error)}` }));
  }
  const out = [];
  for (const s of states) {
    let failure = null;
    let flags = '';
    try {
      const read = await readCommandStateRow(reader, s.rowId);
      if (!read.found) {
        failure = 'the row does not exist';
      } else {
        const table = context.tables.get(s.entity);
        const decoded = decodeCommandStateRow(read.body, {
          rowId: s.rowId, entity: s.entity, metadataId: table.metadataId, appId: context.appId, inApp: table.inApp, location: s.location,
        });
        const wrong = decoded.reasons.filter((reason) => NOT_THE_DECLARED_ROW.has(reason));
        if (wrong.length) {
          failure = `not the declared row: ${wrong.join(', ')}${decoded.details.length ? ` (${decoded.details.join('; ')})` : ''}`;
        } else {
          // `desired` is by column name (hidden, isdisabled); the decoded row and the spec say `disabled`.
          const stored = (wire) => decoded.row[SPEC_FLAG[wire]];
          const differ = Object.keys(s.desired).filter((wire) => stored(wire) !== s.desired[wire]);
          flags = Object.keys(s.desired).map((wire) => `${SPEC_FLAG[wire]} ${stored(wire)}`).join(', ');
          if (differ.length) failure = differ.map((wire) => `${SPEC_FLAG[wire]} is ${stored(wire)}, declared ${s.desired[wire]}`).join('; ');
        }
      }
    } catch (error) {
      failure = `could not be read: ${readFailureText(error)}`;
    }
    out.push({ name: nameOf(s), present: !failure, detail: failure ? `${failure} (${STORED_ONLY})` : `${flags} (${STORED_ONLY})` });
  }
  return out;
}

module.exports = {
  resolveCommandStateContext, readCommandStateRow, decodeCommandStateRow, listCommandStateRows, verifyCommandStates, errorCode, NOT_FOUND,
  readFailureText,
};

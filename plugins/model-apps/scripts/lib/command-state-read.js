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
//     "_parentappactionid_value": null, "hidden": false, "isdisabled": false, "visibilitytype": 0, "visibilityformulacomponentlibrary": null,
//     "_visibilityformulacomponentlibraryid_value": null, "visibilityformulacomponentname": null, "visibilityformulafunctionname": null,
//     "onclickeventtype": 2 }
// The choice values are the public ones: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appaction
// Scope: `_appmoduleid_value` null is a TABLE-scoped command (every app that shows the table renders it), an app id an APP-scoped one —
// https://learn.microsoft.com/power-apps/maker/model-driven-apps/commanding-scopes

const { collectionRows, currentAppLayer, appComponentRows, tableRefs, TABLE_NAME } = require('./app-components.js');
const { odataLit } = require('./odata.js');
const { compareText } = require('./compare-text.js');
const {
  BAR_BY_LOCATION, UNSUPPORTED_BAR, ROW_VERSION, ROW_SELECT, REASONS, CommandStateError, guidOf,
} = require('./command-state-contract.js');

const CONTEXT_UNVERIFIED = 'command-state-context-unverified';
const ROW_UNREADABLE = 'command-state-row-unreadable';
const VERSION_UNAVAILABLE = 'command-state-version-unavailable';
// The platform's "does not exist" for a record: { "error": { "code": "0x80040217", "message": "appaction With Id = ... Does Not Exist" } }
// Only a 404 that carries it proves a row is gone; any other 404 (a wrong path, a proxy) proves nothing.
const NOT_FOUND = '0x80040217';

const reasonOf = (error) => String((error && error.message) || error || 'read failed');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (row, key) => Object.prototype.hasOwnProperty.call(row, key);

// The `code` of a Dataverse error answer — { "error": { "code": "0x80040217" } }, spelled `Error` by some surfaces — in lower case.
function errorCode(body) {
  const envelope = isObject(body) ? (body.error || body.Error) : null;
  return isObject(envelope) && typeof envelope.code === 'string' ? envelope.code.toLowerCase() : '';
}

// Runs a read whose failure must carry this feature's code; an error that already has one keeps it.
async function as(code, run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CommandStateError) throw error;
    throw new CommandStateError(code, reasonOf(error));
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
  const apps = await as(CONTEXT_UNVERIFIED, () => collectionRows(reader,
    `/appmodules?$select=appmoduleid,uniquename&$filter=uniquename eq '${odataLit(appUniqueName)}'`, `app '${appUniqueName}'`, { code: CONTEXT_UNVERIFIED }));
  const appIds = apps.map((row) => (isObject(row) ? guidOf(row.appmoduleid) : null));
  if (appIds.some((id) => !id)) throw new CommandStateError(CONTEXT_UNVERIFIED, `app '${appUniqueName}': a row has no readable app id`);
  if (apps.length !== 1) {
    throw new CommandStateError(CONTEXT_UNVERIFIED, apps.length
      ? `app '${appUniqueName}': ${apps.length} published apps answer to this unique name`
      : `app '${appUniqueName}': no published app has this unique name`);
  }
  const appId = appIds[0];
  const layer = await currentAppLayer(reader, appId);
  if (!layer.ok) throw new CommandStateError(CONTEXT_UNVERIFIED, `app '${appUniqueName}': its current layer could not be read: ${layer.reason}`);
  const components = await as(CONTEXT_UNVERIFIED, () => appComponentRows(reader, layer.appModuleIdUnique, 1, { strict: true }));
  const memberIds = new Set(components.map((row) => guidOf(row.objectid)));

  const tables = new Map();
  if (Array.isArray(entities) && entities.length) {
    const names = [...new Set(entities.map((name) => String(name).toLowerCase()))];
    for (const name of names) {
      if (!TABLE_NAME.test(name)) throw new CommandStateError(CONTEXT_UNVERIFIED, `'${name}' is not a table's logical name`);
    }
    const refs = await as(CONTEXT_UNVERIFIED, () => tableRefs(reader, names));
    for (const name of names.sort(compareText)) {
      const { metadataId } = refs.get(name);
      tables.set(name, { entity: name, metadataId, inApp: memberIds.has(metadataId) });
    }
  } else {
    for (const metadataId of [...memberIds].sort()) {
      const answer = await as(CONTEXT_UNVERIFIED, () => reader.get(`/EntityDefinitions(${metadataId})?$select=LogicalName,MetadataId`));
      const body = answer && answer.body;
      if (!answer || answer.status < 200 || answer.status >= 300 || !isObject(body)
        || typeof body.LogicalName !== 'string' || !TABLE_NAME.test(body.LogicalName) || guidOf(body.MetadataId) !== metadataId) {
        throw new CommandStateError(CONTEXT_UNVERIFIED, `app '${appUniqueName}': table component ${metadataId} could not be resolved to a table (HTTP ${answer && answer.status})`);
      }
      tables.set(body.LogicalName, { entity: body.LogicalName, metadataId, inApp: true });
    }
  }

  // A row version exists only where the table keeps one: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api
  // Missing, not a boolean, or unreadable is no answer, never "on".
  const concurrency = await as(VERSION_UNAVAILABLE, () => reader.get("/EntityDefinitions(LogicalName='appaction')?$select=IsOptimisticConcurrencyEnabled"));
  const flag = concurrency && concurrency.status >= 200 && concurrency.status < 300 && isObject(concurrency.body) ? concurrency.body.IsOptimisticConcurrencyEnabled : undefined;
  if (typeof flag !== 'boolean') {
    throw new CommandStateError(VERSION_UNAVAILABLE, `whether the command table keeps row versions could not be read (HTTP ${concurrency && concurrency.status})`);
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
    throw new CommandStateError(ROW_UNREADABLE, `command row ${id} could not be read: ${reasonOf(error)}`);
  }
  const status = answer && answer.status;
  if (status === 404 && errorCode(answer.body) === NOT_FOUND) return { found: false };
  if (!(status >= 200 && status < 300) || !isObject(answer.body)) {
    throw new CommandStateError(ROW_UNREADABLE, `command row ${id} could not be read (HTTP ${status})`);
  }
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
 * @param {'app'|'table'} [expect.scope] the declared scope
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

  const owner = ref('_appmoduleid_value');
  let scope = 'unknown';
  if (has(body, '_appmoduleid_value')) {
    if (body._appmoduleid_value === null) scope = 'table';
    else if (owner && expect.appId !== undefined) scope = owner === expect.appId ? 'app' : 'other-app';
    else if (owner) scope = 'app';
  }
  if (scope === 'other-app') reasons.add('other-app');
  if (expect.scope !== undefined && (scope === 'app' || scope === 'table') && scope !== expect.scope) reasons.add('scope-mismatch');

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

  const visibilityType = int('visibilitytype');
  if (visibilityType !== null && visibilityType !== 0) reasons.add('visibility-formula');
  const formulaLibraryId = ref('_visibilityformulacomponentlibraryid_value');
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
    const rows = await as(ROW_UNREADABLE, () => collectionRows(reader,
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

module.exports = { resolveCommandStateContext, readCommandStateRow, decodeCommandStateRow, listCommandStateRows, errorCode, NOT_FOUND };

'use strict';
// The tables a spec names, the one PublishXml that publishes them, and the read of which of their forms, views and charts are saved but not
// published. The build (sdk-build.js) uses them twice:
//   * before it writes or publishes the app, it publishes every table the spec names (publishTablesBeforeApp);
//   * a build that stops before its publish phase says what the spec's tables still hold saved and not published (settleOwedPublishes).
// Both go through the raw client the build already uses for table metadata (`provision.dataverse`): the SDK's artifact publish names a table
// only through a form, view or chart it holds in its workspace, and a table the spec only names has none.
const { collectionRows } = require('./app-components.js');
const { sitemapEntityTables } = require('./app-spec.js');
const { odataLit } = require('./odata.js');

// What Dataverse accepts as a table's logical name: lower case letters, digits and underscores, not starting with a digit. The names go into an
// XML body, so one that is not shaped like this is left out rather than sent: the platform has no table by that name.
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

// Every table the spec names, as lower-case logical names, each once, in the order the spec gives them: the tables it declares (`existing` ones
// too: the build reuses them), then whatever its forms, views, charts, `app.tables` and navigation name that it does not declare. A spec that
// passed validation names no other table than the ones it declares, except in `app.tables`; the rest is kept for a spec that did not.
function specTables(spec) {
  const out = [];
  const seen = new Set();
  const add = (name) => {
    const logical = typeof name === 'string' ? name.trim().toLowerCase() : '';
    if (!TABLE_NAME.test(logical) || seen.has(logical)) return;
    seen.add(logical);
    out.push(logical);
  };
  const s = spec && typeof spec === 'object' ? spec : {};
  const each = (list, pick) => { if (Array.isArray(list)) for (const item of list) if (item && typeof item === 'object') add(pick(item)); };
  each(s.entities, (e) => e.schemaName);
  each(s.forms, (f) => f.entity);
  each(s.views, (v) => v.entity);
  each(s.charts, (c) => c.entity);
  if (s.app && Array.isArray(s.app.tables)) for (const name of s.app.tables) add(name);
  try {
    for (const name of sitemapEntityTables(s)) add(name);
  } catch { /* the navigation of a spec that never passed validation can be any shape; this also runs where a build has halted, and must not throw */ }
  return out;
}

// `a, b and 3 more`: at most `max` names, then how many were left out. For a message, where a spec of fifty tables must not print fifty names.
function tableList(names, max) {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

const xmlText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Publish `tables` in ONE request. Dataverse's PublishXml takes the tables as entity elements:
//   POST /PublishXml  { ParameterXml: "<importexportxml><entities><entity>contoso_task</entity><entity>contoso_note</entity></entities></importexportxml>" }
// https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/publishxml
// A table's publish ships every pending customization on it (the SDK warns of this as ENTITY_ENVELOPE_ALSO_SHIPS_UNRELATED_UNPUBLISHED_CHANGES), so
// naming a table publishes what anyone saved on it, not only what the build did.
//
// Reported by value, never thrown: the callers publish what a maker saved or what a label repair changed, none of which may stop a build. The
// client answers `{ status, body }` and does not throw on an HTTP error (lib/sdk-http-client.js); a transport failure, after its own resends,
// does throw. A refusal's platform text, when it gives one, is kept: `{ "error": { "code": "0x80040217", "message": "..." } }`.
async function publishTablesXml(client, tables) {
  const names = Array.isArray(tables) ? tables : [];
  if (!names.length) return { ok: true };
  if (!client || typeof client.post !== 'function') return { ok: false, reason: 'no client to publish with' };
  try {
    const response = await client.post('/PublishXml', {
      ParameterXml: `<importexportxml><entities>${names.map((t) => `<entity>${xmlText(t)}</entity>`).join('')}</entities></importexportxml>`,
    });
    if (response && response.status >= 200 && response.status < 300) return { ok: true };
    const said = response && response.body && response.body.error && response.body.error.message;
    return { ok: false, reason: `PublishXml answered HTTP ${response && response.status}${typeof said === 'string' && said ? `: ${said}` : ''}` };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

// The three kinds of record a table's publish ships that this plugin builds, with the collection that holds each, its id and name columns and
// the column that names its table (the same ones app-components.js reads for an app's components).
const LAYERED = [
  { kind: 'view', label: 'the saved views', collection: 'savedqueries', idField: 'savedqueryid', tableField: 'returnedtypecode' },
  { kind: 'form', label: 'the saved forms', collection: 'systemforms', idField: 'formid', tableField: 'objecttypecode' },
  { kind: 'chart', label: 'the saved charts', collection: 'savedqueryvisualizations', idField: 'savedqueryvisualizationid', tableField: 'primaryentitytypecode' },
];
// `$filter` terms per request. A spec of dozens of tables must not become one URL a gateway refuses; the apps' reads chunk their filters the same way.
const TABLES_PER_READ = 20;
// A record's `componentstate`: 0 Published, 1 Unpublished, 2 Deleted, 3 Deleted Unpublished. A saved edit or a record never published is 1, a
// deletion nobody published is 3, and 2 is a deletion that is live.
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/savedquery (the same choice on systemform and savedqueryvisualization)
const UNPUBLISHED = 1;
const DELETED_UNPUBLISHED = 3;
// A reason is shown in a warning; the platform's own text can run to a page.
const MAX_REASON = 300;

// The message `collectionRows` makes of a refused read carries the request's whole URL, and with twenty tables in `$filter` that is a
// kilometre of text before the platform's own words, which are what a reader needs and what a cut would drop:
//   the saved views: HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.0/savedqueries/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=savedqueryid,name,returnedtypecode,componentstate&$filter=returnedtypecode eq 'contoso_task' or returnedtypecode eq 'contoso_note': <the platform's message>
// The label says which read it was, so the URL goes; what is left is `the saved views: HTTP 400: <the platform's message>`. The query has no colon
// in it (the names in `$filter` are logical names), so it ends at the first `: ` after it, which is where the platform's message starts.
const reasonWithoutUrl = (message) => message.replace(/ from (?:https?:\/\/[^?\s]*|\/[^?\s]*)(?:\?[^:]*)?(?=: |$)/, '');

// Which forms, views and charts on `tables` are saved but not published: the SAVED layer of each collection, which the platform answers with a
// `componentstate` for every record:
//   GET /savedqueries/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=savedqueryid,name,returnedtypecode,componentstate&$filter=returnedtypecode eq 'contoso_task' or returnedtypecode eq 'contoso_note'
//   { "value": [ { "savedqueryid": "11111111-...", "name": "Open Tasks", "returnedtypecode": "contoso_task", "componentstate": 1 } ] }
// The function is bound to these three collections and composable with `$select` and `$filter`:
// https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublishedmultiple
// A record with a saved edit may be answered once (state 1) or in both layers (a state 0 row and a state 1 row, as `currentLayerRows` documents
// for apps), so a record is listed when ANY of its rows is not published, once.
//
// `{ ok: true, byTable }`: the tables of `tables` that hold something, in the order given, each with its records (`{ kind, name, deleted? }`,
// views then forms then charts, by name). `{ ok: false, reason }` when any read failed or answered something that cannot be relied on, and then
// NO list: a partial one would read as the whole. In particular a row that carries no state says nothing about what is published, and is
// an unreadable answer, not an empty one.
async function readSavedNotPublished(client, tables) {
  const wanted = [...new Set((Array.isArray(tables) ? tables : []).map((t) => String(t).toLowerCase()))];
  if (!wanted.length) return { ok: true, byTable: new Map() };
  if (!client || typeof client.get !== 'function') return { ok: false, reason: 'no client to read with' };
  const found = new Map(wanted.map((table) => [table, new Map()]));
  try {
    for (const layer of LAYERED) {
      for (let start = 0; start < wanted.length; start += TABLES_PER_READ) {
        const filter = wanted.slice(start, start + TABLES_PER_READ).map((table) => `${layer.tableField} eq '${odataLit(table)}'`).join(' or ');
        const rows = await collectionRows(client,
          `/${layer.collection}/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${layer.idField},name,${layer.tableField},componentstate&$filter=${filter}`,
          layer.label);
        for (const row of rows) {
          const state = row && row.componentstate;
          if (state === undefined || state === null) throw new Error(`${layer.label}: the answer names no saved or published state (componentstate), so what is published cannot be told`);
          const table = String(row[layer.tableField] || '').toLowerCase();
          if (!found.has(table) || (Number(state) !== UNPUBLISHED && Number(state) !== DELETED_UNPUBLISHED)) continue;
          const id = String(row[layer.idField] || '').toLowerCase();
          const name = typeof row.name === 'string' && row.name ? row.name : (id || `${layer.kind} without a name`);
          found.get(table).set(`${layer.kind}:${id || name}`, { kind: layer.kind, name, ...(Number(state) === DELETED_UNPUBLISHED ? { deleted: true } : {}) });
        }
      }
    }
  } catch (e) {
    const reason = reasonWithoutUrl(String((e && e.message) || e));
    return { ok: false, reason: reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}\u2026` : reason };
  }
  const kindOrder = LAYERED.map((layer) => layer.kind);
  const byTable = new Map();
  for (const [table, records] of found) {
    if (!records.size) continue;
    byTable.set(table, [...records.values()].sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }
  return { ok: true, byTable };
}

// How much of a list a message carries: six records to a table, ten tables, twenty table names.
const MAX_RECORDS = 6;
const MAX_TABLES = 10;
const MAX_NAMES = 20;

// The sentence a halted build adds when it stopped before its publish phase: what `read` found saved and not published on the spec's tables, or
// — when it could not read — that it could not, with the tables to publish. `null` when there is nothing to say: nothing is saved and
// unpublished. It names forms, views and charts only, and says so: a column or a command saved and not published is not read here.
function describeSavedNotPublished(read, tables) {
  if (!read) return null;
  const names = [...new Set((Array.isArray(tables) ? tables : []).map((t) => String(t)))];
  if (!read.ok) {
    if (!names.length) return null;
    return `which forms, views and charts on the spec's tables are saved but not published could not be read (${read.reason}). Run the build again with --publish, or publish these tables in Power Apps: ${tableList(names, MAX_NAMES)}.`;
  }
  if (!read.byTable || !read.byTable.size) return null;
  const records = (list) => {
    const shown = list.map((r) => `${r.kind} ${r.name}${r.deleted ? ' (deleted)' : ''}`);
    return tableList(shown, MAX_RECORDS);
  };
  const entries = [...read.byTable];
  const listed = entries.slice(0, MAX_TABLES).map(([table, list]) => `${table}: ${records(list)}`).join('; ');
  const left = entries.length - MAX_TABLES;
  return `forms, views and charts saved but not published on the spec's tables \u2014 ${listed}${left > 0 ? `; and ${left} more table${left === 1 ? '' : 's'}` : ''}. `
    + "Run the build again with --publish, or publish those tables in Power Apps: a table's publish ships everything saved on it, whoever saved it. Columns and other kinds of change were not read.";
}

module.exports = { specTables, tableList, publishTablesXml, readSavedNotPublished, describeSavedNotPublished };

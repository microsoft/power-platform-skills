'use strict';
// The tables a spec names, the tables the build publishes before the app, the one PublishXml that publishes tables, and the read of which forms, views and
// charts of the spec's tables are saved but not published. The build (sdk-build.js) uses them twice:
//   * before it writes or publishes the app, it publishes the tables it changed and the ones the app is PROVEN to hold a form or chart of
//     (publishTablesBeforeApp; preAppTables says which, and readAppFormChartTables is the proof);
//   * a build that stops before its publish phase says what ALL the spec's tables still hold saved and not published (settleOwedPublishes; specTables
//     is the list it reads). That read changes nothing, so it can be as wide as the spec; the publish above cannot.
// A table's publish ships everything saved on that table, whoever saved it, so the two lists are deliberately not the same list: a table the spec only
// declares, a lookup column's target, a table only a page reads and one the app only lists in its navigation are read and reported but never published,
// because nothing says the app holds a form or a chart of them.
// Both go through the raw client the build already uses for table metadata (`provision.dataverse`): the SDK's artifact publish names a table only through
// a form, view or chart it holds in its workspace, and a table the build did not change has none.
const { collectionRows, readAppComponentInventory } = require('./app-components.js');
const { sitemapEntityTables } = require('./app-spec.js');
const { odataLit } = require('./odata.js');

// What Dataverse accepts as a table's logical name: lower case letters, digits and underscores, not starting with a digit. The names go into an
// XML body, so one that is not shaped like this is left out rather than sent: the platform has no table by that name.
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

// Lower-case logical names, each once, in the order given; a name that cannot be a table's is left out. `add` and `list` of one collection.
function namesCollector() {
  const out = [];
  const seen = new Set();
  return {
    add: (name) => {
      const logical = typeof name === 'string' ? name.trim().toLowerCase() : '';
      if (!TABLE_NAME.test(logical) || seen.has(logical)) return;
      seen.add(logical);
      out.push(logical);
    },
    list: () => out,
  };
}
// The tables of a spec's sections, each section on its own: the spec may be any shape (a halted build reads it too, and a spec that never passed
// validation can hold anything), so each is guarded and none throws.
const objectsOf = (list) => (Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : []);
const declaredTables = (s) => objectsOf(s.entities).map((e) => e.schemaName);
// The tables of the forms, views and charts the spec authors, kind by kind in that order.
const authoredTables = (s) => [...objectsOf(s.forms), ...objectsOf(s.views), ...objectsOf(s.charts)].map((a) => a.entity);
const pinnedTables = (s) => (s.app && Array.isArray(s.app.tables) ? s.app.tables : []);
function navigationTables(s) {
  try {
    return sitemapEntityTables(s);
  } catch {
    return []; // the navigation of a spec that never passed validation can be any shape; this also runs where a build has halted, and must not throw
  }
}
// A page's data sources: tables the page reads, and whose default public view the pages phase pins into the app. Validation only LINTS one that is
// not declared in `entities` (a standard table is fine), so a valid spec can name a table here and nowhere else.
const pageDataSources = (s) => objectsOf(s.pages).flatMap((p) => (Array.isArray(p.dataSources) ? p.dataSources : []));
const specObject = (spec) => (spec && typeof spec === 'object' ? spec : {});

// Every table the spec names, as lower-case logical names, each once, in the order the spec gives them: the tables it declares (`existing` ones
// too: the build reuses them), then whatever its forms, views, charts, `app.tables`, navigation and pages' data sources name that it does not
// declare. A spec that passed validation names no other table than the ones it declares, except in `app.tables` and in a page's `dataSources`.
// This is what a halted build READS, and it is as wide as the spec on purpose: that read changes nothing. It is not what the build publishes
// (preAppTables): naming a table in the spec says nothing about what the app holds of it.
function specTables(spec) {
  const s = specObject(spec);
  const collected = namesCollector();
  for (const name of [...declaredTables(s), ...authoredTables(s), ...pinnedTables(s), ...navigationTables(s), ...pageDataSources(s)]) collected.add(name);
  return collected.list();
}

// The tables the build publishes before the app:
//   reconciled  the tables whose existing views and forms the build reconciled (the tables the SDK's own publish of them covered before)
//   charted     the tables of the charts the build wrote: a created chart, or a description it PATCHed
//   held        the tables whose forms or charts the app holds on the server (readAppFormChartTables), when that read was complete; omit it otherwise
// Without `held` this is exactly what the build changed, which is also what it publishes when the app is new (it holds nothing on the server yet) or
// when what it holds could not be proven. The spec decides none of it: what the app holds is what its component list says, whether or not the spec names
// the table, and a table the spec only names (declared, a lookup column's target, a page's data source, a navigation entry) is not the app's to publish.
// In name order: the reconciles finish in no fixed order, and the same request every run is easier to compare and to assert.
function preAppTables({ reconciled = [], charted = [], held } = {}) {
  const names = namesCollector();
  for (const name of [...reconciled, ...charted, ...(held instanceof Set ? held : [])]) names.add(name);
  return names.list().sort();
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
// What a warning shows of a failure: without the request's URL, and cut where the platform's own text runs to a page.
const clipReason = (message) => {
  const reason = reasonWithoutUrl(String(message));
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}\u2026` : reason;
};

// A record's `componentstate` as a number, or null when it is not one of the four states. A number or a numeric string is read, and nothing else:
// `true` and `''` would otherwise be 1 and 0 to `Number()`, and a record read as published because its state is unreadable is the one error this
// read must not make.
function stateOf(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
  if (typeof value === 'string' && /^\s*[0-3]\s*$/.test(value)) return Number(value);
  return null;
}
const shown = (value) => (typeof value === 'string' ? `'${value.slice(0, 40)}'` : String(JSON.stringify(value)).slice(0, 40));

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
// NO list: a partial one would read as the whole. A row the read cannot place is such an answer, not a record that is published: one that carries
// no state, or a state that is none of the four, or no id (two records of one name would collapse into one), or no table (it may be the very one a
// reader is asking about). The three collections are read one after the other, so a bad row in the last one makes the first one's list unreadable too.
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
          const code = stateOf(state);
          if (code === null) throw new Error(`${layer.label}: a record carries componentstate ${shown(state)}, which is not a saved or published state`);
          const tableValue = row[layer.tableField];
          if (typeof tableValue !== 'string' || !tableValue.trim()) throw new Error(`${layer.label}: a record has no ${layer.tableField}, so the table it belongs to cannot be told`);
          const idValue = row[layer.idField];
          if (typeof idValue !== 'string' || !idValue.trim()) throw new Error(`${layer.label}: a record has no ${layer.idField}, so it cannot be told from another`);
          const table = tableValue.trim().toLowerCase();
          if (!found.has(table) || (code !== UNPUBLISHED && code !== DELETED_UNPUBLISHED)) continue;
          const id = idValue.trim().toLowerCase();
          const name = typeof row.name === 'string' && row.name ? row.name : id;
          found.get(table).set(`${layer.kind}:${id}`, { kind: layer.kind, name, ...(code === DELETED_UNPUBLISHED ? { deleted: true } : {}) });
        }
      }
    }
  } catch (e) {
    return { ok: false, reason: clipReason((e && e.message) || e) };
  }
  const kindOrder = LAYERED.map((layer) => layer.kind);
  const byTable = new Map();
  for (const [table, records] of found) {
    if (!records.size) continue;
    byTable.set(table, [...records.values()].sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }
  return { ok: true, byTable };
}

// The component types whose tables prove the app holds a FORM or a CHART of a table: 60 and 59 (app-components.js APP_COMPONENT_ENTITY_SOURCES). A table
// component (1) says the app lists the table, and a view (26) says it holds a view of it; neither says a form or a chart of the table is in the app. A
// page's pinned default view is a view, a navigation entry a table component, and the app's publish is only known to leave a saved form label out
// (measured), with a chart's description the open question; so only these two count. It also keeps the read cheap: a table component costs one
// metadata read each, which an app of fifty tables would pay serially on every build.
const FORM_COMPONENT = 60;
const CHART_COMPONENT = 59;

// The tables whose forms or charts an EXISTING app holds, read from its current (saved) layer on the server: its component list, and the table of each
// form and chart in it (app-components.js readAppComponentInventory, the read the download makes, narrowed to these two types and required to identify
// every component):
//   { ok: true, tables: Set<lower-case logical name>, forms: Set<...> }   `forms` are the tables the app holds a FORM of; `tables` adds the charts'
//   { ok: false, reason }                                                  something could not be read or identified, and then NO tables
// Complete or nothing: a list that left out a table the app holds a form of would let the build publish less than it should without saying so, and a
// partial list handed back would invite a caller to treat it as the whole. The component list names ids; one that no lookup answers for (a stale
// component, a record the caller may not read, a form never published, which a plain read does not answer) is such a hole.
// Never throws: a build that cannot tell what the app holds publishes only what it changed, and says so (describeUnreadAppComponents).
async function readAppFormChartTables(sdk, appId) {
  const none = (reason) => ({ ok: false, reason });
  if (!appId) return none('the app has no id to read its components by');
  if (!sdk || !sdk.dataverse || typeof sdk.dataverse.get !== 'function') return none('no client to read the app with');
  try {
    const inventory = await readAppComponentInventory(sdk, appId, { componentTypes: [FORM_COMPONENT, CHART_COMPONENT], requireIdentified: true });
    // The layer's own reason when the app could not be found at all; otherwise the first of the notes about what could not be read or identified.
    const reason = !inventory.layer.ok ? inventory.layer.reason : (inventory.notes[0] && inventory.notes[0].reason);
    if (reason) return none(clipReason(reason));
    const lowerCased = (names) => new Set([...(names || [])].map((name) => String(name).toLowerCase()));
    const forms = lowerCased(inventory.assetTablesByType.get(FORM_COMPONENT));
    return { ok: true, tables: new Set([...forms, ...lowerCased(inventory.assetTablesByType.get(CHART_COMPONENT))]), forms };
  } catch (e) {
    return none(clipReason((e && e.message) || e));
  }
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

// What the form-label risk is, as the build has measured it (sdk-build.js, publishReconciledTables): a PublishXml that names only the app, sent after a form's
// label change was saved and before its table's own publish, leaves the label unpublished, and a later publish of the table does not release it. The
// measurement is of FORM labels; nothing is claimed here for anything else, and the recovery says "may" because a re-save has not been measured.
const LABEL_RISK = 'a label someone saved on a form there and did not publish may stay unpublished once the app is published (Dataverse leaves it out of the '
  + 'published form, and a later publish of the table does not release it, as measured for forms), so it may have to be saved again and then published with its table before the app.';

// The warning for the one PublishXml before the app being refused, for the tables the SDK's own publish of the reconciled ones does not cover (a
// refusal of THAT halts the build, so it never gets here). The build goes on, so the warning says what that leaves open, plainly:
//   reason   why the request failed, as publishTablesXml reports it
//   tables   the tables the request named that nothing else published
//   saved    Map<table, names[]> of what THIS build saved on a table (`view Open Tickets`, `chart By Area`): what it created, or a chart whose description it wrote
//   described  Map<table, Set<chart name>> of the charts whose DESCRIPTION this build wrote, which a name in `saved` reads the same as a created chart
//   forms    Set<table> of the tables the app is PROVEN to hold a form of (readAppFormChartTables), when that was read
// The concerns are independent and a table can carry both: what this build saved goes out with the build's final publish, after the app's own (nothing is
// claimed for a chart's description: whether the app's publish holds it back has not been measured), and a form the app holds on the table may have a
// label somebody else saved and never published, which carries the measured risk. A table is not "this build's" or "somebody else's": the chart this
// build wrote and the form a maker saved can be on the same one, and each is said.
function describePreAppRefusal({ reason, tables, saved, described, forms } = {}) {
  const names = [...new Set((Array.isArray(tables) ? tables : []).map((t) => String(t)))];
  if (!names.length) return null;
  const savedOn = saved instanceof Map ? saved : new Map();
  const describedOn = described instanceof Map ? described : new Map();
  const formsOn = forms instanceof Set ? forms : new Set();
  const itemsOf = (table) => [...(savedOn.get(table) || [])].map((item) => (/^chart /.test(item) && describedOn.has(table) && describedOn.get(table).has(item.slice(6)) ? `the description of ${item}` : item));
  const own = names.filter((table) => itemsOf(table).length);
  const labelled = names.filter((table) => formsOn.has(table));
  const many = names.length > 1;
  const parts = [`could not publish ${many ? 'tables' : 'table'} ${tableList(names, MAX_NAMES)} before the app (${reason}), so the app's publish will come first and the protection the build gives what is saved on ${many ? 'them' : 'it'} did not apply.`];
  if (own.length) {
    const listed = own.map((table) => `${tableList(itemsOf(table), MAX_RECORDS)} on ${table}`).join('; ');
    const several = own.flatMap(itemsOf).length > 1;
    const chart = own.some((table) => itemsOf(table).some((item) => /chart /.test(item)));
    parts.push(`This build saved ${listed}; ${several ? 'they go' : 'it goes'} out with the build's final publish, after the app's.`
      + `${chart ? " Whether the app's publish holds back a chart's description saved before it has not been measured." : ''}`);
  }
  if (labelled.length) parts.push(`The app holds forms of ${tableList(labelled, MAX_NAMES)}: ${LABEL_RISK}`);
  parts.push(`Publish ${many ? 'those tables' : 'that table'} in Power Apps before the app is next published, or run the build again once the cause is cleared: it sends this request first again.`);
  return parts.join(' ');
}

// The warning for what the app holds not being readable, or not identifiable (readAppFormChartTables answered `ok: false`): only what the build changed
// was published before the app's own publish, which is the safe side — a table's publish ships what anyone saved on it, so a table not PROVEN to be the
// app's is not published on a guess. It says which proof failed and that a build that can read it covers those tables, and what the risk is for a table
// whose forms the app does hold. It names no table and tells nobody to publish one: it cannot say which tables the app holds, which is the point.
function describeUnreadAppComponents({ reason } = {}) {
  return `could not tell which tables the forms and charts the app already holds belong to (${reason}), so only the tables this build changed were published before the app's own publish. `
    + 'Any other table the app holds a form or chart of was not published first: a label someone saved on a form there and did not publish may stay unpublished once the app is published '
    + '(Dataverse leaves it out of the published form, and a later publish of the table does not release it, as measured for forms), so one that does not show may have to be saved again. '
    + "Run the build again once the cause is cleared: it then publishes the tables whose forms or charts the app holds before the app's own publish.";
}

module.exports = {
  specTables, preAppTables, tableList, publishTablesXml, readSavedNotPublished, describeSavedNotPublished,
  readAppFormChartTables, describePreAppRefusal, describeUnreadAppComponents,
};

'use strict';

// App membership is independent of navigation. These reads use the app's layer key, not its row id:
// appmodulecomponent.objectid is a MetadataId for type 1 and a systemform id for type 60.
// The SDK exposes the Main-form write directive, but not component/layer inventory or table
// references; its cached fetchEntityMetadata projection cannot supply these membership reads.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodulecomponent
const { odataLit } = require('./odata.js');
const { dashboardNameKey, FORM_GUID_RE, formIdentityKey, compareVersions, isPluginVersion, APP_MEMBERSHIP_MIN_VERSION } = require('./app-spec.js');
const { isMainForm } = require('./form-order.js');
const { compareText } = require('./compare-text.js');

const guidKey = (id) => String(id || '').replace(/^\{|\}$/g, '').toLowerCase();
const reasonOf = (error) => String((error && error.message) || error || 'read failed');
const APP_COMPONENT_ENTITY_SOURCES = [
  { componentType: 26, set: 'savedquery', collection: 'savedqueries', idField: 'savedqueryid', entityField: 'returnedtypecode' },
  { componentType: 59, set: 'savedqueryvisualization', collection: 'savedqueryvisualizations', idField: 'savedqueryvisualizationid', entityField: 'primaryentitytypecode' },
  { componentType: 60, set: 'systemform', collection: 'systemforms', idField: 'formid', entityField: 'objecttypecode' },
];

// What Dataverse accepts as a table's logical name: lower case letters, digits and underscores, not starting with a digit. A table name goes into an XML body
// (a table's PublishXml: lib/table-publish.js), so one that is not shaped like this is left out rather than sent: the platform has no table by that name. An
// answer that names a table of a component in any other shape is not a table either, and a read that must be complete does not take it for one.
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function componentError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status) error.statusCode = status;
  return error;
}

function requireGuid(id, label) {
  const key = guidKey(id);
  if (!FORM_GUID_RE.test(key)) throw componentError('APP_COMPONENT_ID_INVALID', `${label} is not a GUID: '${id}'`);
  return key;
}

// Reads a collection page by page: { "value": [ ... ], "@odata.nextLink": "<URL>" }. A refusal, an answer that is no list, a link that is no link and a page
// that repeats are each an error, never a shorter list: the callers prove things from the rows that come back, and a missing row cannot be told from a missing page.
//   path     below the API root, e.g. `/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid`
//   label    what is being read, for a message
//   options.code  the `code` of the error thrown (default APP_COMPONENTS_UNVERIFIED), for a caller whose own callers know another vocabulary
async function collectionRows(client, path, label, { code = 'APP_COMPONENTS_UNVERIFIED' } = {}) {
  const rows = [];
  const seen = new Set();
  while (path) {
    if (seen.has(path)) throw componentError(code, `${label}: repeated @odata.nextLink`);
    seen.add(path);
    // The continuation the platform gives is ABSOLUTE and on the same origin:
    //   "@odata.nextLink": "https://contoso.crm.dynamics.com/api/data/v9.0/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=...&$skiptoken=..."
    // The SDK client's `get` puts the API root in front of whatever it is given, which would make that
    // `/api/data/v9.0/https://contoso.crm.dynamics.com/api/data/v9.0/...` (HTTP 404), so such a link goes through its `getAbsolute` — which also refuses a link to another origin.
    // A client without it (a test fake) is handed the link as it was.
    const absolute = /^https?:/i.test(path);
    const response = absolute && typeof client.getAbsolute === 'function' ? await client.getAbsolute(path) : await client.get(path);
    if (!response || response.status < 200 || response.status >= 300) {
      // The platform's own words, as the SDK reports its reads: { "error": { "code": "0x80040220", "message": "The user is not a member of the organization." } }
      const errorBody = response && response.body;
      const reason = errorBody && errorBody.error && typeof errorBody.error.message === 'string' ? errorBody.error.message : '';
      const url = !absolute && typeof client.apiUrl === 'function' ? client.apiUrl(path) : path;
      throw componentError(code, `${label}: HTTP ${response && response.status} from ${url}${reason ? `: ${reason}` : ''}`, response && response.status);
    }
    // Dataverse collections are { value: [...], "@odata.nextLink": "<API URL>" }; an absent/malformed
    // value or continuation is not an empty collection, and cannot prove a complete membership read.
    const body = response.body;
    if (!body || !Array.isArray(body.value)) throw componentError(code, `${label}: no readable result set`);
    rows.push(...body.value);
    const next = body['@odata.nextLink'];
    if (next !== undefined && (typeof next !== 'string' || !next)) {
      throw componentError(code, `${label}: malformed @odata.nextLink`);
    }
    path = next;
  }
  return rows;
}

// The rows of ONE record that are its current layer: the only row, or — when a pending edit makes the platform answer with both layers — the authored one
// (componentstate 1, Unpublished: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appmodule). Anything other than exactly
// one is for the caller to refuse: it does not say which layer is current.
function currentLayerRows(rows) {
  return rows.length === 1 ? rows : rows.filter((row) => row && Number(row.componentstate) === 1);
}

// The one row a LISTING shows for a record: its current layer when the rows say which it is, else the first row. A list shows what it cannot place exactly rather
// than hide it, where currentLayerRows leaves the doubt to a caller that must not guess. `rows` are the rows of ONE record.
function currentLayerRow(rows) {
  return currentLayerRows(rows)[0] || rows[0];
}

// How many page ids one read names. The SDK's own check of the pages a sitemap opens reads 50 at a time, so the filter stays a URL.
const PAGE_LOOKUP_CHUNK = 50;

// The generative pages `ids` in the SAVED layer — the current one, a page that was never published included — as Map<id (lower case), the rows the platform answered for it>: one row, or two when a
// pending edit makes it answer with both layers (`currentLayerRow` picks the one an author sees). An id that no row answers to is not in the map, and a caller that needs one to exist says so.
// A plain read of the `uxagentproject` collection answers the PUBLISHED layer only, so a page that was created and never published — a build killed after the create change set, a publish that was
// refused and never finished, a create nobody published — is "not found" by it. A caller that decides whether a page exists, or what to delete, must read this layer:
//   GET /uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=uxagentprojectid,name,componentstate&$filter=uxagentprojectid eq 4444… or uxagentprojectid eq 5555…
//   { "value": [ { "uxagentprojectid": "44444444-…", "name": "Overview", "componentstate": 0 } ] }       (componentstate 0 Published, 1 Unpublished: a never-published page has this one row, with 1)
// A read that fails, an answer that is no list, and a row with no page id are each an error, never a shorter map: the callers prove things from the rows that come back (see collectionRows).
async function savedPageRows(client, ids, { label = 'the generative pages', code } = {}) {
  const wanted = [...new Set(ids.map((id) => guidKey(id)))];
  const rowsById = new Map();
  for (let at = 0; at < wanted.length; at += PAGE_LOOKUP_CHUNK) {
    const filter = wanted.slice(at, at + PAGE_LOOKUP_CHUNK).map((id) => `uxagentprojectid eq ${requireGuid(id, 'page id')}`).join(' or ');
    const rows = await collectionRows(client,
      `/uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=uxagentprojectid,name,componentstate&$filter=${filter}`,
      label, code ? { code } : undefined);
    for (const row of rows) {
      const id = row && typeof row.uxagentprojectid === 'string' ? guidKey(row.uxagentprojectid) : '';
      if (!FORM_GUID_RE.test(id)) throw componentError(code || 'APP_COMPONENTS_UNVERIFIED', `${label}: a row has no readable page id`);
      if (!rowsById.has(id)) rowsById.set(id, []);
      rowsById.get(id).push(row);
    }
  }
  return rowsById;
}

async function currentAppLayer(client, appId) {
  try {
    const rows = await collectionRows(client,
      `/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,appmoduleidunique,componentstate&$filter=appmoduleid eq ${requireGuid(appId, 'app id')}`,
      `current layer of app '${appId}'`);
    // Measured: a pending write creates a NEW layer key; the published key still addresses the old
    // rows. Never union the layers or cache this key across AddAppComponents or PublishXml.
    const current = currentLayerRows(rows);
    if (current.length !== 1 || !current[0] || !FORM_GUID_RE.test(guidKey(current[0].appmoduleidunique))) {
      return { ok: false, reason: `no single current layer among ${rows.length} app row(s)` };
    }
    return { ok: true, appModuleIdUnique: guidKey(current[0].appmoduleidunique) };
  } catch (error) {
    return { ok: false, reason: reasonOf(error), status: error.statusCode };
  }
}

async function publishedAppLayer(sdk, { appId, appUnique } = {}) {
  const filter = appUnique !== undefined ? `uniquename eq '${odataLit(appUnique)}'` : `appmoduleid eq ${appId}`;
  const rows = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'appmoduleidunique'], filter, top: 1 });
  const row = rows && rows[0];
  if (!row || !row.appmoduleidunique) return { ok: false, reason: `published app '${appUnique || appId}' could not be resolved` };
  return { ok: true, appId: row.appmoduleid, appModuleIdUnique: guidKey(row.appmoduleidunique) };
}

async function appComponentRows(reader, appModuleIdUnique, componentType, opts = {}) {
  const parent = guidKey(appModuleIdUnique);
  const filter = `_appmoduleidunique_value eq ${parent} and componenttype eq ${componentType}`;
  const rows = typeof reader.queryRecords === 'function'
    ? await reader.queryRecords('appmodulecomponent', {
      select: ['objectid', 'componenttype'], filter,
      ...(opts.top ? { top: opts.top } : { paginate: true }),
    })
    : await collectionRows(reader,
      `/appmodulecomponents?$select=objectid,componenttype&$filter=_appmoduleidunique_value eq ${requireGuid(parent, 'app layer id')} and componenttype eq ${componentType}`,
      `app component type ${componentType}`);
  if (!Array.isArray(rows)) throw componentError('APP_COMPONENTS_UNVERIFIED', 'app components returned no readable result set');
  return rows.filter((row) => row && (row.componenttype === undefined || Number(row.componenttype) === componentType));
}

async function tableMetadata(client, logical, select, { allowMissing = false } = {}) {
  const response = await client.get(`/EntityDefinitions(LogicalName='${odataLit(logical)}')?$select=${select}`);
  if (allowMissing && response && response.status === 404) return null;
  if (!response || response.status < 200 || response.status >= 300 || !response.body) {
    throw componentError('APP_TABLE_UNRESOLVED', `could not resolve table '${logical}' (HTTP ${response && response.status})`, response && response.status);
  }
  return response.body;
}

async function tableRefs(client, logicalNames) {
  const refs = new Map();
  for (const name of logicalNames || []) {
    const logical = String(name).toLowerCase();
    if (refs.has(logical)) continue;
    const row = await tableMetadata(client, logical, 'MetadataId,EntitySetName');
    if (!FORM_GUID_RE.test(guidKey(row.MetadataId)) || typeof row.EntitySetName !== 'string' || !row.EntitySetName) {
      throw componentError('APP_TABLE_UNRESOLVED', `table '${logical}' could not be resolved to a MetadataId + EntitySetName`);
    }
    refs.set(logical, { metadataId: guidKey(row.MetadataId), entitySetName: row.EntitySetName });
  }
  return refs;
}

async function tableComponentIds(client, appModuleIdUnique) {
  const rows = await appComponentRows(client, appModuleIdUnique, 1);
  return new Set(rows.map((row) => requireGuid(row.objectid, 'table component objectid')));
}

async function pinAppTables(client, appId, logicalNames, { refs: resolvedRefs } = {}) {
  if (!logicalNames || !logicalNames.length) return { added: [], already: [] };
  const refs = resolvedRefs || await tableRefs(client, logicalNames);
  const readIds = async () => {
    const layer = await currentAppLayer(client, appId);
    if (!layer.ok) throw componentError('APP_COMPONENTS_UNVERIFIED', `cannot prove app '${appId}' tables: ${layer.reason}`, layer.status);
    return tableComponentIds(client, layer.appModuleIdUnique);
  };
  const before = await readIds();
  const added = [...refs].filter(([, ref]) => !before.has(ref.metadataId)).map(([table]) => table);
  const already = [...refs.keys()].filter((table) => !added.includes(table));
  if (!added.length) return { added, already };
  // Mirror the SDK's reference shape: the ENTITY SET chooses the table, including abstract tables.
  // An instance of Microsoft.Dynamics.CRM.entity pins the metadata table itself (AB#6612527).
  const response = await client.post('/AddAppComponents', {
    AppId: requireGuid(appId, 'app id'),
    Components: added.map((table) => {
      const ref = refs.get(table);
      return { '@odata.id': `${ref.entitySetName}(${ref.metadataId})` };
    }),
  });
  if (!response || response.status < 200 || response.status >= 300) {
    throw componentError('APP_TABLES_NOT_PINNED', `AddAppComponents for app '${appId}' returned HTTP ${response && response.status}`, response && response.status);
  }
  const after = await readIds();
  const missing = [...refs].filter(([, ref]) => !after.has(ref.metadataId)).map(([table]) => table);
  if (missing.length) {
    throw componentError('APP_TABLES_NOT_PINNED', `app '${appId}': table(s) ${missing.join(', ')} are still missing after AddAppComponents; re-run the build`);
  }
  return { added, already };
}

async function publishAppComponents(client, appId) {
  const id = requireGuid(appId, 'app id');
  // A fresh SDK create already publishes before the plugin can pin hidden tables. Publish that
  // newly proven layer too, even without --publish, or a page-less create leaves its pins pending.
  // https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/publishxml
  const response = await client.post('/PublishXml', {
    ParameterXml: `<importexportxml><appmodules><appmodule>${id}</appmodule></appmodules></importexportxml>`,
  });
  if (!response || response.status < 200 || response.status >= 300) {
    throw componentError('APP_TABLES_NOT_PUBLISHED', `app '${id}' tables were pinned but publishing returned HTTP ${response && response.status}; re-run the build`, response && response.status);
  }
}

function appComponentsFor(created, mainFormsByTable) {
  return {
    forms: Object.entries(created.forms || {}).filter(([table, id]) => id
      && (!mainFormsByTable || !mainFormsByTable[table.toLowerCase()] || mainFormsByTable[table.toLowerCase()].map(guidKey).includes(guidKey(id))))
      .map(([, id]) => id),
    views: Object.values(created.views || {}).filter(Boolean),
    charts: Object.values(created.charts || {}).filter(Boolean),
    ...(mainFormsByTable === undefined ? {} : { mainFormsByTable }),
  };
}

async function applyAppMainForms(provision, appId, mainFormsByTable) {
  if (mainFormsByTable === undefined) return;
  const artifact = await provision.getArtifact('app', appId) || {};
  const components = { ...(artifact.components || {}), mainFormsByTable };
  const allowed = new Set(Object.values(mainFormsByTable).flat().map(guidKey));
  const candidates = (components.forms || []).filter((id) => !allowed.has(guidKey(id)));
  if (candidates.length && Object.keys(mainFormsByTable).length) {
    const classified = await classifyFormIds(provision.dataverse, candidates);
    if (classified.unclassified.length) {
      throw componentError('APP_MAIN_FORMS_UNVERIFIED', `cannot classify explicit form pin(s) ${classified.unclassified.join(', ')} before applying the Main-form list`);
    }
    const excluded = new Set(classified.rows.filter((row) => row.type === 2
      && mainFormsByTable[row.objecttypecode.toLowerCase()] && !allowed.has(guidKey(row.formid))).map((row) => guidKey(row.formid)));
    components.forms = components.forms.filter((id) => !excluded.has(guidKey(id)));
  }
  // A fetch never reconstructs this directive. Add a missing top-level components object through
  // the SDK's root addElement; otherwise a later push would silently re-add every active Main form.
  if (artifact.components === undefined) await provision.addElement('app', appId, '', { components });
  else await provision.updateElement('app', appId, '/components', components);
}

async function explainAppPushWarnings(client, pushed, appName) {
  if (!pushed || !Array.isArray(pushed.warnings) || !pushed.warnings.length) return pushed;
  const warnings = [];
  for (const warning of pushed.warnings) {
    // SDK update warnings have this stable shape:
    //   Main-form components outside the allow-list remain for table 'account': [<id>, <id>].
    // Only that diagnostic is translated; all other partial-push warnings remain verbatim.
    const extras = /^Main-form components outside the allow-list remain for table '([^']+)': \[([^\]]*)\]\./.exec(warning);
    if (!extras) { warnings.push(warning); continue; }
    const ids = extras[2].split(',').map((id) => id.trim()).filter(Boolean);
    let names = ids;
    let unreadable = '';
    try {
      const classified = await classifyFormIds(client, ids);
      const byId = new Map(classified.rows.map((row) => [guidKey(row.formid), row.name || row.formid]));
      names = ids.map((id) => byId.get(guidKey(id)) || id);
      if (classified.unclassified.length) unreadable = ` Some form names could not be read (${classified.unclassified.join(', ')}).`;
    } catch (error) {
      // The push already committed: a failed name lookup cannot turn it into a failed push, but the
      // diagnostic must keep its ids and name the failed read rather than presenting a clean result.
      unreadable = ` Form names could not be read (${reasonOf(error)}).`;
    }
    warnings.push(`app '${appName}' already offers Main form(s) ${names.map((name) => `'${name}'`).join(', ')} of ${extras[1]}; `
      + `a list stops new forms being added but cannot remove forms an existing app already offers \u2014 remove them in Maker `
      + `(app designer -> ${extras[1]} -> Forms) or list them. Runtime form availability has not been verified.${unreadable}`);
  }
  return { ...pushed, warnings };
}

async function mainFormCatalog(client, table) {
  // Keep inactive Main forms in the catalog to distinguish "inactive" from "missing" and detect
  // ambiguous names. Main=2, active=1; dashboards are type 0 and never Main members.
  // https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/systemform
  return collectionRows(client,
    `/systemforms?$select=formid,name,formactivationstate&$filter=objecttypecode eq '${odataLit(table)}' and type eq 2`,
    `Main forms of '${table}'`);
}

async function resolveMainForms(client, spec, createdFormIds = {}) {
  const directive = spec.app && spec.app.mainForms;
  if (directive === undefined) return undefined;
  const resolved = {};
  for (const [rawTable, names] of Object.entries(directive)) {
    const table = rawTable.toLowerCase();
    let catalog;
    const forms = (spec.forms || []).filter((form) => form && String(form.entity || '').toLowerCase() === table);
    const ids = [];
    for (const name of names) {
      const matches = forms.filter((form) => isMainForm(form) && dashboardNameKey(form.name) === dashboardNameKey(name));
      if (matches.length > 1) throw componentError('APP_MAIN_FORM_AMBIGUOUS', `Main form '${name}' of ${table} is ambiguous among the declared Main forms`);
      const created = matches.length === 1 && createdFormIds[formIdentityKey(matches[0])];
      const knownId = created ? requireGuid(created, `Main form '${name}' of ${table}`) : null;
      if (!catalog) catalog = await mainFormCatalog(client, table);
      const named = catalog.filter((form) => dashboardNameKey(form.name) === dashboardNameKey(name));
      const active = named.filter((form) => Number(form.formactivationstate) === 1);
      const activeIds = new Set(active.map((form) => requireGuid(form.formid, `Main form '${name}' of ${table}`)));
      const knownRow = knownId && catalog.find((form) => form && guidKey(form.formid) === knownId);
      if (knownRow && Number(knownRow.formactivationstate) !== 1) {
        throw componentError('APP_MAIN_FORM_INACTIVE', `Main form '${name}' of ${table} is inactive`);
      }
      // Verify and download address this directive by NAME, so a formId cannot bypass ambiguity.
      // A just-created/reused id may not be visible in the catalog yet; count it once as well, or
      // metadata lag could make an unrelated same-named Main form look like the only candidate.
      if (knownId) activeIds.add(knownId);
      if (activeIds.size > 1) throw componentError('APP_MAIN_FORM_AMBIGUOUS', `Main form '${name}' of ${table} is ambiguous among its active Main forms`);
      if (activeIds.size === 1) {
        ids.push([...activeIds][0]);
      } else if (named.length) {
        throw componentError('APP_MAIN_FORM_INACTIVE', `Main form '${name}' of ${table} is inactive`);
      } else {
        const other = forms.find((form) => !isMainForm(form) && dashboardNameKey(form.name) === dashboardNameKey(name));
        throw componentError('APP_MAIN_FORM_NOT_FOUND', other
          ? `form '${name}' of ${table} is declared as ${other.formType}, and no active Main form with that name was found`
          : `Main form '${name}' of ${table} not found`);
      }
    }
    resolved[table] = [...new Set(ids)];
  }
  return resolved;
}

async function classifyFormIds(client, ids) {
  const unique = [...new Set(ids.map((id) => requireGuid(id, 'form component objectid')))];
  const rows = [];
  for (let start = 0; start < unique.length; start += 50) {
    rows.push(...await collectionRows(client,
      `/systemforms?$select=formid,name,type,objecttypecode&$filter=${unique.slice(start, start + 50).map((id) => `formid eq ${id}`).join(' or ')}`,
      'classifying app form components'));
  }
  const classified = rows.filter((row) => row && typeof row.type === 'number' && typeof row.formid === 'string'
    && (row.type !== 2 || (typeof row.objecttypecode === 'string' && row.objecttypecode !== '')));
  const found = new Set(classified.map((row) => guidKey(row.formid)));
  const formNames = Object.fromEntries(rows.filter((row) => row && typeof row.formid === 'string'
    && typeof row.name === 'string' && row.name.trim()).map((row) => [guidKey(row.formid), row.name]));
  return { rows: classified, formNames, unclassified: unique.filter((id) => !found.has(id)) };
}

async function readMainFormMembership(client, appModuleIdUnique, tables) {
  try {
    const components = await appComponentRows(client, appModuleIdUnique, 60);
    const classified = await classifyFormIds(client, components.map((row) => row.objectid));
    if (classified.unclassified.length) return { kind: 'inconclusive', reason: `form component(s) ${classified.unclassified.join(', ')} could not be classified` };
    const mains = classified.rows.filter((row) => row.type === 2);
    return {
      kind: 'read',
      formNames: Object.fromEntries(classified.rows.map((row) => [guidKey(row.formid), row.name || row.formid])),
      tables: Object.entries(tables).map(([rawTable, allowedIds]) => {
        const table = rawTable.toLowerCase();
        const allowed = allowedIds.map(guidKey);
        const members = [...new Set(mains.filter((row) => row.objecttypecode.toLowerCase() === table).map((row) => guidKey(row.formid)))];
        return { table, members, extras: members.filter((id) => !allowed.includes(id)), missing: allowed.filter((id) => !members.includes(id)) };
      }),
    };
  } catch (error) {
    return { kind: 'inconclusive', reason: reasonOf(error) };
  }
}

async function appMainFormsFor(sdk, appUnique, tables) {
  try {
    const layer = await publishedAppLayer(sdk, { appUnique });
    if (!layer.ok) return { kind: 'inconclusive', reason: layer.reason };
    const resolved = await resolveMainForms(sdk.dataverse, { app: { mainForms: tables } });
    const result = await readMainFormMembership(sdk.dataverse, layer.appModuleIdUnique, resolved);
    if (result.kind !== 'read') return result;
    const requestedNames = {};
    for (const [table, names] of Object.entries(tables)) {
      (resolved[table.toLowerCase()] || []).forEach((id, index) => { requestedNames[id] = names[index]; });
    }
    return { ...result, formNames: { ...requestedNames, ...result.formNames } };
  } catch (error) {
    return { kind: 'inconclusive', reason: reasonOf(error) };
  }
}

// How `requireIdentified` reads the answer to the lookup of the tables of one component type's records. The component list names ids and the proof is per id, so
// a row counts for an id the list asked about and for no other: a row with no readable id, or for an id nobody asked about, says nothing of this app and is left out
// before it can add a table. A row for an id that was asked about has to name its table in a shape a table can have, or `none` (a dashboard's: it names no table);
// a value that is neither ('   ', 12345, 'two words') is an answer that cannot be relied on, and so are two rows of one id that name different tables: a record has
// one table, and the platform answers it twice only for its other layer, with the same table. Neither lets a table in, and either keeps the read from being complete.
//   { "value": [ { "formid": "33333333-0000-4000-8000-000000000012", "objecttypecode": "contoso_item" } ] }
function strictAssetAnswers(askedAbout, source) {
  const asked = new Set(askedAbout);
  const answered = new Map(); // id -> the table its rows name (`none` for a dashboard)
  const conflicting = new Set(); // ids whose rows name different tables
  const unusable = new Map(); // id -> the value that names its table, as answered, when no table can be named so
  const list = (ids) => `${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` and ${ids.length - 3} more` : ''}`;
  return {
    add(row) {
      const given = row && typeof row === 'object' ? row[source.idField] : undefined;
      const id = typeof given === 'string' ? guidKey(given) : '';
      if (!asked.has(id)) return;
      const value = row[source.entityField];
      // Nothing named at all: the row answers nothing about this id, as if the platform had sent none.
      if (value === undefined || value === null || value === '') return;
      const table = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (table !== 'none' && !TABLE_NAME.test(table)) { unusable.set(id, value); return; }
      if (!answered.has(id)) answered.set(id, table);
      else if (answered.get(id) !== table) conflicting.add(id);
    },
    // `tables`: those of the ids whose rows all agree on one table. `problem`: what keeps the answer from being complete, or undefined.
    outcome() {
      const tables = new Set();
      for (const [id, table] of answered) if (table !== 'none' && !conflicting.has(id) && !unusable.has(id)) tables.add(table);
      const missing = [...asked].filter((id) => !answered.has(id) && !unusable.has(id));
      const reasons = [];
      if (missing.length) reasons.push(`no ${source.set} record answered for ${list(missing)}`);
      if (unusable.size) reasons.push(`the ${source.set} answer for ${list([...unusable.keys()])} names no usable table (${String(JSON.stringify([...unusable.values()][0])).slice(0, 40)})`);
      if (conflicting.size) reasons.push(`the ${source.set} answer for ${list([...conflicting])} names more than one table`);
      return { tables, problem: reasons.length ? reasons.join('; ') : undefined };
    },
  };
}

// What an app holds, from the server's CURRENT (saved) layer of it: its table components (resolved to logical names), and the tables of the views, forms and charts
// it holds, resolved through the collection of each. The download builds its spec from this; the build's publish before the app reads the form and chart
// components of it (table-publish.js readAppFormChartTables).
//   options.componentTypes     read only these component types (1 table, 26 view, 59 chart, 60 form); all four when omitted. A table component costs one
//                              metadata read EACH, and a view lookup one read per 20 views, so a caller that does not use them does not pay for them.
//   options.requireIdentified  also note an asset component whose table the lookup did not answer for, and read the answer strictly (strictAssetAnswers). Each component
//                              id must come back as a row of its own that names a table (a dashboard's is `none`); an id with no row (a stale component, a record the caller
//                              may not read) or a row with no id or no table is a hole in the inventory, and a caller that proves something from what the inventory does hold
//                              must not read it as complete. Off by default: the download reports what it has always reported.
//   options.savedLayer         look the records up in their SAVED layer (RetrieveUnpublishedMultiple) instead of the published one a plain read answers. The component
//                              list is the saved layer's (above), so a component a maker added in the designer and never published is in it, and a plain read of the record
//                              does not answer for it: the saved layer does, with the table it belongs to. Off by default, as the download reads it.
//                                GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode&$filter=formid eq 33333333-… or formid eq 44444444-…
//                              The function is bound to these collections and composable with `$select` and `$filter`:
//                              https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublishedmultiple
async function readAppComponentInventory(sdk, appId, { componentTypes, requireIdentified = false, savedLayer = false } = {}) {
  const inventory = {
    layer: { ok: false, reason: 'app id is missing' }, components: new Map(), componentProblems: new Map(),
    tables: new Map(), logicalNames: [], assetTables: [], assetTablesByType: new Map(), notes: [],
  };
  if (!appId) return inventory;
  try {
    // Download is an edit snapshot of SERVER-CURRENT state: the vendored appApi.get reads both
    // appmodules and sitemaps through RetrieveUnpublishedMultiple. A published inventory paired
    // with that draft navigation would silently lose its Main restrictions and hidden members.
    inventory.layer = await currentAppLayer(sdk.dataverse, appId);
  } catch (error) {
    inventory.layer = { ok: false, reason: reasonOf(error) };
  }
  if (!inventory.layer.ok) {
    inventory.notes.push({ kind: 'tables', reason: `app component inventory could not be read (${inventory.layer.reason})` });
    return inventory;
  }
  const assetTables = new Set();
  const everyType = [1, ...APP_COMPONENT_ENTITY_SOURCES.map((source) => source.componentType)];
  for (const componentType of everyType.filter((type) => !componentTypes || componentTypes.includes(type))) {
    let components;
    try {
      components = await appComponentRows(sdk, inventory.layer.appModuleIdUnique, componentType);
      inventory.components.set(componentType, components);
    } catch (error) {
      inventory.componentProblems.set(componentType, reasonOf(error));
      inventory.notes.push({ kind: 'tables', reason: `app component type ${componentType} could not be read (${reasonOf(error)})` });
      continue;
    }
    const ids = [...new Set(components.map((row) => guidKey(row.objectid)).filter(Boolean))];
    if (components.some((row) => !row.objectid)) {
      inventory.notes.push({ kind: 'tables', reason: `an app component of type ${componentType} has no objectid and could not be recovered` });
    }
    if (componentType === 1) {
      for (const id of ids) {
        try {
          // A type-1 objectid identifies table METADATA, not a record. The response is e.g.
          // { "LogicalName": "task", "IsCustomEntity": false }; select both so hidden stock membership
          // never adopts another solution's columns/schema.
          const response = await sdk.dataverse.get(`/EntityDefinitions(${requireGuid(id, 'table MetadataId')})?$select=LogicalName,IsCustomEntity`);
          if (!response || response.status < 200 || response.status >= 300 || !response.body || typeof response.body.LogicalName !== 'string' || !response.body.LogicalName) {
            throw componentError('APP_TABLE_UNRESOLVED', response && response.status === 404
              ? `table component ${id} no longer exists (HTTP 404)`
              : `table component ${id} could not be resolved (HTTP ${response && response.status})`, response && response.status);
          }
          const logical = response.body.LogicalName.toLowerCase();
          if (logical === 'entity') {
            inventory.notes.push({ kind: 'tables', id, reason: `the 'entity' placeholder component ${id} is corruption, not an app table; it was omitted` });
            continue;
          }
          inventory.tables.set(logical, { metadataId: id, isCustomEntity: response.body.IsCustomEntity });
        } catch (error) {
          inventory.notes.push({ kind: 'tables', id, reason: reasonOf(error) });
        }
      }
      continue;
    }
    const source = APP_COMPONENT_ENTITY_SOURCES.find((candidate) => candidate.componentType === componentType);
    const tablesOfType = new Set();
    inventory.assetTablesByType.set(componentType, tablesOfType);
    const strict = requireIdentified ? strictAssetAnswers(ids, source) : null;
    try {
      for (let start = 0; start < ids.length; start += 20) {
        const filter = ids.slice(start, start + 20).map((id) => `${source.idField} eq ${requireGuid(id, 'asset component objectid')}`).join(' or ');
        const rows = savedLayer
          ? await collectionRows(sdk.dataverse, `/${source.collection}/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${source.idField},${source.entityField}&$filter=${filter}`,
            `the saved ${source.set} records of the app's components`)
          : await sdk.queryRecords(source.set, { select: [source.idField, source.entityField], filter, paginate: true });
        if (!Array.isArray(rows)) throw componentError('APP_COMPONENTS_UNVERIFIED', `${source.set} returned no readable result set`);
        for (const row of rows) {
          if (strict) { strict.add(row); continue; }
          const logical = row && row[source.entityField] ? String(row[source.entityField]).toLowerCase() : '';
          if (logical && logical !== 'none') { assetTables.add(logical); tablesOfType.add(logical); }
        }
      }
      if (strict) {
        const { tables, problem } = strict.outcome();
        for (const table of tables) { assetTables.add(table); tablesOfType.add(table); }
        if (problem) inventory.notes.push({ kind: 'tables', reason: `tables derived from app component type ${componentType} could not be fully identified (${problem})` });
      }
    } catch (error) {
      inventory.notes.push({ kind: 'tables', reason: `tables derived from app component type ${componentType} could not be read (${reasonOf(error)})` });
    }
  }
  inventory.assetTables = [...assetTables];
  inventory.logicalNames = [...new Set([...inventory.tables.keys(), ...assetTables])];
  return inventory;
}

async function appComponentEntities(sdk, appId, warn = (message) => process.stderr.write(`WARNING: ${message}\n`)) {
  const inventory = await readAppComponentInventory(sdk, appId);
  for (const note of inventory.notes) warn(note.reason);
  return inventory.logicalNames;
}

async function downloadAppMainForms(client, appModuleIdUnique, tables, { components, componentError: readError } = {}) {
  const mainForms = {};
  const notes = [];
  if (!tables.length) return { mainForms, notes };
  let classified;
  try {
    if (readError) throw componentError('APP_COMPONENTS_UNVERIFIED', readError);
    const rows = components || await appComponentRows(client, appModuleIdUnique, 60);
    const ids = [];
    for (const row of rows) {
      const id = guidKey(row.objectid);
      // A damaged row can be { componenttype: 60 } or carry a non-GUID objectid. Download keeps
      // the encodable active subset and names the loss; build/verify classification still fails closed.
      if (FORM_GUID_RE.test(id)) ids.push(id);
      else notes.push({ kind: 'mainForms', ...(id ? { id } : {}),
        reason: `form component ${id ? `objectid '${id}' is not a GUID` : 'has no readable objectid'}; its Main-form membership cannot be carried forward` });
    }
    classified = await classifyFormIds(client, ids);
  } catch (error) {
    notes.push({ kind: 'mainForms', reason: `Main-form membership could not be read (${reasonOf(error)}); no app.mainForms list was recovered` });
    return { mainForms, notes };
  }
  for (const id of classified.unclassified) {
    const name = classified.formNames[id];
    notes.push({ kind: 'mainForms', id, ...(name ? { name } : {}),
      reason: `form component ${name ? `'${name}' (${id})` : id} could not be classified; its Main-form membership cannot be carried forward` });
  }
  for (const table of [...tables].sort()) {
    let catalog;
    try {
      catalog = await mainFormCatalog(client, table);
      if (catalog.some((row) => !row || !FORM_GUID_RE.test(guidKey(row.formid)) || ![0, 1].includes(Number(row.formactivationstate)))) {
        throw componentError('APP_COMPONENTS_UNVERIFIED', 'the Main-form catalog contains a missing id or activation state');
      }
    } catch (error) {
      notes.push({ kind: 'mainForms', table, reason: `Main forms of ${table} could not be read (${reasonOf(error)}); no app.mainForms list was recovered` });
      continue;
    }
    const byId = new Map(catalog.map((row) => [guidKey(row.formid), row]));
    const active = new Map([...byId].filter(([, row]) => Number(row.formactivationstate) === 1));
    const memberRows = classified.rows.filter((row) => row.type === 2 && row.objecttypecode.toLowerCase() === table);
    const memberIds = new Set(memberRows.map((row) => guidKey(row.formid)));
    for (const row of memberRows) {
      const id = guidKey(row.formid);
      if (!active.has(id)) {
        notes.push({ kind: 'mainForms', table, id, name: row.name || id,
          reason: `Main form '${row.name || id}' of ${table} is ${byId.has(id) ? 'inactive' : 'not in the Main catalog'}; its membership cannot be carried forward` });
      }
    }
    // Inactive/unclassifiable pins must not erase an otherwise encodable ACTIVE restriction.
    // An app with zero Main members offers every form (measured), so an empty allow-list is never emitted.
    const members = [...active].filter(([id]) => memberIds.has(id)).map(([, row]) => row);
    if (!members.length) {
      notes.push({ kind: 'mainForms', table, reason: `${table} has no active Main member; app.mainForms is omitted because an empty list would offer all forms` });
      continue;
    }
    if (members.length === active.size) continue;
    const ambiguous = members.filter((member) => typeof member.name !== 'string' || !member.name.trim()
      || catalog.filter((row) => dashboardNameKey(row.name) === dashboardNameKey(member.name)).length !== 1);
    if (ambiguous.length) {
      // Named in code-unit order, not the order the catalog query answered in, which Dataverse does not fix: two downloads of one app must say
      // the same, and the note's text is part of what is reported (notRoundTripped.appMembership, stderr).
      const named = ambiguous.map((row) => `'${row.name || row.formid}'`).sort(compareText);
      notes.push({ kind: 'mainForms', table,
        reason: `ambiguous or unreadable Main form name(s) ${named.join(', ')} of ${table}; app.mainForms cannot address them by name` });
      continue;
    }
    // The download's `app.mainForms` list: by code units, not `localeCompare`, so two downloads of one app list the same names in
    // the same order on every machine (compare-text.js).
    mainForms[table] = members.map((row) => row.name).sort(compareText);
  }
  return { mainForms, notes };
}

function setAppMembershipFloor(spec, priorFloor) {
  if (!spec || !spec.app || (spec.app.tables === undefined && spec.app.mainForms === undefined)) return spec;
  let floor = APP_MEMBERSHIP_MIN_VERSION;
  for (const candidate of [spec.minimumPluginVersion, priorFloor]) {
    if (isPluginVersion(candidate) && compareVersions(candidate, floor) > 0) floor = candidate;
  }
  spec.minimumPluginVersion = floor;
  return spec;
}

// Resolve only the SPEC's wanted names, so a foreign/deleted component cannot make verification
// unbounded or turn an unrelated opaque id into a whole-answer failure. A 404 is absence, not unreadable.
async function appEntityComponentsFor(sdk, appUnique, wanted) {
  try {
    const layer = await publishedAppLayer(sdk, { appUnique });
    if (!layer.ok) return layer;
    const rows = await appComponentRows(sdk, layer.appModuleIdUnique, 1);
    const ids = new Set(rows.map((row) => guidKey(row.objectid)).filter(Boolean));
    const metadataId = async (logical) => {
      const row = await tableMetadata(sdk.dataverse, logical, 'MetadataId', { allowMissing: true });
      if (!row) return null;
      if (!row.MetadataId) throw componentError('APP_TABLE_UNRESOLVED', `could not resolve table '${logical}' (no MetadataId)`);
      return guidKey(row.MetadataId);
    };
    const present = [];
    for (const logical of wanted || []) {
      const id = await metadataId(logical);
      if (id && ids.has(id)) present.push(logical);
    }
    const entityId = await metadataId('entity');
    return { ok: true, present, placeholder: !!(entityId && ids.has(entityId)) };
  } catch (error) {
    return { ok: false, reason: reasonOf(error).slice(0, 200) };
  }
}

module.exports = {
  currentAppLayer, currentLayerRows, currentLayerRow, savedPageRows, publishedAppLayer, appComponentRows, collectionRows, tableRefs, tableComponentIds, pinAppTables,
  publishAppComponents, appComponentsFor, applyAppMainForms, explainAppPushWarnings,
  resolveMainForms, readMainFormMembership, appMainFormsFor, appEntityComponentsFor,
  APP_COMPONENT_ENTITY_SOURCES, TABLE_NAME, readAppComponentInventory, appComponentEntities, downloadAppMainForms, setAppMembershipFloor,
};

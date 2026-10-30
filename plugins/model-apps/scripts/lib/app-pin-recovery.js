'use strict';

// Bounded recovery after an app push whose component pin has an UNKNOWN outcome.
//
// On an update push the SDK saves the header and the navigation, then pins the app's components. When it can, it sends
// the pin as ONE change set (a guarded PATCH {}, AddAppComponents, an echo PATCH {}), so the pin either committed as a
// whole or not at all. When the change set's answer is lost (a dropped connection, an unreadable response) the SDK does
// not re-send it and reports, in PushResult.warnings:
//   APP_PIN_OUTCOME_UNKNOWN: App '<app id>': the change set adding its components was sent, but <reason>; it may have
//   committed, and nothing was re-sent. The app token held is kept — …
// Before this helper the build reported that warning and moved on, so a lost pin left the app without some of its
// components until the NEXT build. Here the build settles it in the same run, with at most ONE more push:
//   1. re-fetch the app (overwrite), so a concurrent header/navigation change is kept and no stale copy is replayed;
//   2. read the app's CURRENT-layer membership completely and compare it with the components this push intended;
//   3. all present  -> nothing is written (the original committed);
//      some missing -> re-apply the Main-form directives and declared pins to the fresh copy and push ONCE, through the
//                      caller's own app writer (the same SDK, so exact-membership and pre-app table publication hold);
//   4. re-read; a second unknown answer, a refusal or a component still missing is an incomplete result, never a loop.
// A read that cannot be completed writes nothing: the result is incomplete, and the caller makes the build nonzero.
//
// The intent is RECORDED before the first push (pinIntentOf), separately from the header/navigation, because a fetch
// carries neither Main-form directive nor any explicit pin: they would otherwise be lost by step 1.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addappcomponents

const { collectionRows, currentAppLayer, tableRefs, applyAppMainForms, pinDeclaredArtifacts } = require('./app-components.js');
const { entityTablesOfSiteMap } = require('./genpage-sdk.js');
const { odataLit } = require('./odata.js');
const { FORM_GUID_RE } = require('./app-spec.js');

const guidKey = (id) => String(id || '').replace(/^\{|\}$/g, '').toLowerCase();
const listOf = (value) => (Array.isArray(value) ? value : []);
const idsOf = (value) => [...new Set(listOf(value).map(guidKey).filter((id) => FORM_GUID_RE.test(id)))];

// AddAppComponents membership types (appmodulecomponent.componenttype): 1 table (objectid = MetadataId), 26 view,
// 59 chart, 60 form or dashboard. The same `type:objectid` key the SDK's own pin gate compares.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodulecomponent
const TYPE = { table: 1, view: 26, chart: 59, form: 60 };

function recoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The SDK's warning for THIS app, anchored at the start: only APP_PIN_OUTCOME_UNKNOWN triggers recovery. The other pin
// notices (APP_PIN_REBASE_REQUIRED, APP_PIN_TOKEN_UNCONFIRMED, APP_PIN_ECHO_MISSING) say the action was acknowledged or
// refused, so they stay reported as they are and never become a retry.
const OUTCOME_UNKNOWN = /^APP_PIN_OUTCOME_UNKNOWN: App '([^']+)':/;

function pinWarningOf(pushed, appId) {
  if (!pushed || !Array.isArray(pushed.warnings)) return null;
  const want = guidKey(appId);
  for (const warning of pushed.warnings) {
    const match = typeof warning === 'string' ? OUTCOME_UNKNOWN.exec(warning) : null;
    if (match && guidKey(match[1]) === want) return warning;
  }
  return null;
}

// The DashBoard entries of a navigation: the SDK pins each one as a component (AppAdapter.toApiPayload), e.g.
//   { id: 'sub_0_0_1', type: 'DashBoard', dashboardId: '44444444-0000-4000-8000-000000000020', title: 'Overview' }
function siteMapDashboards(siteMap) {
  const ids = [];
  for (const area of listOf(siteMap && siteMap.areas)) {
    for (const group of listOf(area && area.groups)) {
      for (const sub of listOf(group && group.subAreas)) {
        if (sub && sub.type === 'DashBoard' && sub.dashboardId) ids.push(sub.dashboardId);
      }
    }
  }
  return ids;
}

// What one push of the app `artifact` (the SDK's App artifact, AFTER the Main-form directives and declared pins were
// applied to it) asks the server to hold. Only plain data: no header, no navigation, no token, so it can never be
// replayed as a stale artifact.
function pinIntentOf(artifact) {
  const components = (artifact && artifact.components) || {};
  const mainFormsByTable = components.mainFormsByTable && typeof components.mainFormsByTable === 'object'
    ? Object.fromEntries(Object.entries(components.mainFormsByTable).map(([table, ids]) => [table.toLowerCase(), idsOf(ids)]))
    : undefined;
  return {
    tables: entityTablesOfSiteMap(artifact && artifact.siteMap),
    forms: idsOf(components.forms),
    views: idsOf(components.views),
    charts: idsOf(components.charts),
    dashboards: idsOf([...listOf(components.dashboards), ...siteMapDashboards(artifact && artifact.siteMap)]),
    ...(mainFormsByTable ? { mainFormsByTable } : {}),
    ...(components.mainFormsOnUpdate === 'exact' ? { mainFormsOnUpdate: 'exact' } : {}),
  };
}

// Every row of an enumeration must name its record by GUID. These reads say what the app is EXPECTED to hold, so a row
// that cannot be placed is never dropped: dropping it would shrink the expectation, and a lost pin of that component would
// read as complete. A well-formed empty `value: []` is a valid answer (the table has none).
//   { "value": [ { "savedqueryid": "66666666-…" }, {}, { "savedqueryid": "not-a-guid" }, null ] }   <- rows 2, 3 and 4 refuse
async function idsRead(client, path, key, label) {
  const rows = await collectionRows(client, path, label, { code: 'APP_PIN_UNCONFIRMED' });
  return rows.map((row, index) => {
    const id = row && typeof row === 'object' && !Array.isArray(row) && typeof row[key] === 'string' ? guidKey(row[key]) : '';
    if (!FORM_GUID_RE.test(id)) throw recoveryError('APP_PIN_UNCONFIRMED', `the ${label} hold a row it cannot place (row ${index + 1})`);
    return id;
  });
}

// The membership keys the intent stands for. The SDK expands every navigation table into its active Main forms (or the
// table's allow-list), its public views and its charts (AppApi enumerateEntityAssets), so those are read here with the
// SAME filters: a key the plan would add and this set left out would let a lost pin pass as complete.
//   systemforms               objecttypecode eq '<t>' and type eq 2 and formactivationstate eq 1
//   savedqueries              returnedtypecode eq '<t>' and querytype eq 0 and statecode eq 0
//   savedqueryvisualizations  primaryentitytypecode eq '<t>'
async function intendedKeys(client, intent) {
  const keys = new Set();
  const add = (type, ids) => ids.forEach((id) => keys.add(`${type}:${guidKey(id)}`));
  const refs = await tableRefs(client, intent.tables);
  for (const table of intent.tables) {
    add(TYPE.table, [refs.get(table).metadataId]);
    const lit = odataLit(table);
    const allowList = intent.mainFormsByTable && intent.mainFormsByTable[table];
    add(TYPE.form, allowList || await idsRead(client,
      `/systemforms?$select=formid&$filter=objecttypecode eq '${lit}' and type eq 2 and formactivationstate eq 1`, 'formid', `Main forms of '${table}'`));
    add(TYPE.view, await idsRead(client,
      `/savedqueries?$select=savedqueryid&$filter=returnedtypecode eq '${lit}' and querytype eq 0 and statecode eq 0`, 'savedqueryid', `views of '${table}'`));
    add(TYPE.chart, await idsRead(client,
      `/savedqueryvisualizations?$select=savedqueryvisualizationid&$filter=primaryentitytypecode eq '${lit}'`, 'savedqueryvisualizationid', `charts of '${table}'`));
  }
  add(TYPE.form, intent.forms);
  add(TYPE.form, intent.dashboards);
  add(TYPE.view, intent.views);
  add(TYPE.chart, intent.charts);
  return keys;
}

// The app's CURRENT-layer membership, every component type, every page — the published layer alone would miss a pin
// that is saved but not yet published. A row with no GUID object id or a non-integer type makes the read incomplete
// rather than shorter (the same rule as the SDK's pin gate):
//   GET /appmodulecomponents?$select=objectid,componenttype&$filter=_appmoduleidunique_value eq <layer>
//   { "value": [ { "objectid": "11111111-…", "componenttype": 1 }, { "objectid": "{22222222-…}", "componenttype": 60 } ] }
async function currentMembership(client, appId) {
  const layer = await currentAppLayer(client, appId);
  if (!layer.ok) throw recoveryError('APP_PIN_UNCONFIRMED', `the app's current layer could not be read (${layer.reason})`);
  const rows = await collectionRows(client,
    `/appmodulecomponents?$select=objectid,componenttype&$filter=_appmoduleidunique_value eq ${layer.appModuleIdUnique}`,
    'app components', { code: 'APP_PIN_UNCONFIRMED' });
  const present = new Set();
  for (const row of rows) {
    const id = guidKey(row && row.objectid);
    if (!FORM_GUID_RE.test(id) || !Number.isInteger(row.componenttype)) {
      throw recoveryError('APP_PIN_UNCONFIRMED', 'the app component list holds a row it cannot place');
    }
    present.add(`${row.componenttype}:${id}`);
  }
  return present;
}

async function missingKeys(client, appId, intent) {
  const wanted = await intendedKeys(client, intent);
  const present = await currentMembership(client, appId);
  return [...wanted].filter((key) => !present.has(key)).sort();
}

const reasonOf = (error) => String((error && error.code) || (error && error.message) || error || 'failed');

// Settle an outcome-unknown pin. `push` is the caller's own app writer for an existing app (the build's appWriters.push
// re-sending the fresh copy), so pre-app table publication, Main-form directives and the exact-membership guard all hold.
// Answers { outcome, pushed, missing, error? }:
//   none       no APP_PIN_OUTCOME_UNKNOWN for this app: nothing was read or written
//   confirmed  every intended component is present: no second push
//   repaired   one more push added what was missing, and a re-read proves it
//   incomplete a read failed, the second push was refused or answered unknown again, or a component is still missing:
//              `error` (code APP_PIN_UNCONFIRMED) for the caller to report as a partial, nonzero result
async function reconcileUnconfirmedPin({ provision, appId, intent, pushed, push }) {
  const trigger = pinWarningOf(pushed, appId);
  if (!trigger) return { outcome: 'none', pushed, missing: [] };
  const keep = (warnings, line) => ({ ...pushed, warnings: listOf(warnings).filter((w) => w !== trigger).concat(line ? [line] : []) });
  const incomplete = (why, missing = [], last = pushed) => {
    const error = recoveryError('APP_PIN_UNCONFIRMED',
      `app '${appId}': whether its components were pinned could not be established (${why}); nothing more was sent. Re-run the build to finish the app's membership.`);
    return { outcome: 'incomplete', pushed: { ...last, warnings: listOf(last && last.warnings).concat([error.message]) }, missing, error };
  };
  if (!intent || !Array.isArray(intent.tables)) return incomplete('the intended components were not recorded before the push');
  let missing;
  try {
    // overwrite: the workspace copy may hold the push's own token, which the lost change set may have moved; a fresh
    // copy is the server's, with any concurrent header or navigation change, and nothing local is replayed.
    await provision.fetchArtifact('app', appId, { overwrite: true });
    missing = await missingKeys(provision.dataverse, appId, intent);
  } catch (error) {
    return incomplete(reasonOf(error));
  }
  if (!missing.length) {
    return { outcome: 'confirmed', pushed: keep(pushed.warnings, `app '${appId}': its component pin's answer was lost, but every intended component is present; nothing was re-sent.`), missing };
  }
  let second;
  try {
    await applyAppMainForms(provision, appId, intent.mainFormsByTable, { mainFormsOnUpdate: intent.mainFormsOnUpdate });
    await pinDeclaredArtifacts(provision, appId, { forms: intent.forms, views: intent.views, charts: intent.charts, dashboards: intent.dashboards });
    second = await push();
  } catch (error) {
    return incomplete(`the repair push failed: ${reasonOf(error)}`, missing);
  }
  if (!second || second.saved === false) return incomplete(`the repair push was refused: ${reasonOf(second && second.error)}`, missing, second || pushed);
  if (pinWarningOf(second, appId)) return incomplete('the repair push\'s pin answer was lost too', missing, second);
  let still;
  try {
    still = await missingKeys(provision.dataverse, appId, intent);
  } catch (error) {
    return incomplete(`the membership re-read failed: ${reasonOf(error)}`, missing, second);
  }
  if (still.length) return incomplete(`${still.length} component(s) are still missing after one repair push`, still, second);
  return {
    outcome: 'repaired',
    pushed: { ...second, warnings: listOf(pushed.warnings).filter((w) => w !== trigger).concat(listOf(second.warnings),
      [`app '${appId}': its component pin's answer was lost and ${missing.length} component(s) were missing; one more push added them.`]) },
    missing,
  };
}

module.exports = { pinWarningOf, pinIntentOf, reconcileUnconfirmedPin, OUTCOME_UNKNOWN };

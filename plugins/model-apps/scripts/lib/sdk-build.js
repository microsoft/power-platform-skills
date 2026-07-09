'use strict';
// SDK build engine: turn a validated App Spec into ordered @maker-studio/cds-maker-sdk
// calls, emitting granular progress events the orchestrator narrates. Deterministic and
// IDEMPOTENT — every table/column/relationship/solution is checked-then-created, so new,
// existing, and mixed environments all work (create-table is automatically optional).
// All Dataverse access goes through the SDK (findTables/findColumns/fetchEntityMetadata for
// discovery, create* for writes), so the workspace ends up holding the metadata for reuse.
//
// Phases (ordered): solution · data-model · sample-data · views · charts · forms · app-shell
//   · publish.  Select a subset with opts.phases (see resolvePhases).
// emit(event): { phase, status:'start'|'ok'|'skip'|'error', label, n, total, detail? }
// On an SDK error, throws a BuildHalt the orchestrator can gate on (AskUserQuestion).

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  relationshipSchemaName,
  manyToManyFor,
  manyToManySchemaName,
} = require('./app-spec.js');
const { topoOrderEntities, entityByLogical } = require('./_graph.js');
const {
  makeRunner,
  makeEntitySetResolver,
  provisionSolution,
  provisionDataModel,
  provisionSampleData,
  BuildHalt: _BuildHalt,
  SDK_COLUMN_TYPE: _SDK_COLUMN_TYPE,
} = require('./entity-provision.js');
const { makeGenpageCli } = require('./genpage-cli.js');
const { selectSummaryTables } = require('./ai-candidates.js');
const { buildPromptSpec } = require('./ai-prompt.js');
const { odataLit } = require('./odata.js');

// Re-export from entity-provision so the export surface stays unchanged
const BuildHalt = _BuildHalt;
const SDK_COLUMN_TYPE = _SDK_COLUMN_TYPE;

// Standard field control classId (Dataverse picks the widget by attribute type) and the
// classic Notes/timeline control classId.
const STD_FIELD_CLASS_ID = '4273EDBD-AC1D-40d3-9FB2-095C621B552D';
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E';
const COMPONENT_TYPE = { view: 26, chart: 59, form: 60, dashboard: 60, webResource: 61, sitemap: 62, app: 80 };

// Web-resource kinds (App Spec `type`) -> SDK createWebResource `type` token. The SDK maps
// the token to the Dataverse webresourcetype code (js=3, html=1, css=2, …).
const WEB_RESOURCE_KINDS = new Set(['js', 'html', 'css', 'xml', 'png', 'jpg', 'gif', 'xsl', 'ico', 'svg', 'resx']);
// Form-event kinds the SDK can wire (addFormEventHandler).
const FORM_EVENTS = new Set(['onload', 'onsave', 'onchange']);

const PHASES = ['solution', 'data-model', 'sample-data', 'web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'publish'];

// Map a dashboard tile (App Spec) to the SDK's AddDashboardTileOptions. chart/list tiles resolve
// the underlying view (savedqueryid) — and the chart its visualization id — from what the build
// already created; the target entity is derived from the referenced view. iframe/webresource tiles
// carry a url / web-resource name.
function dashboardTileOpts(spec, tile, result) {
  const viewEntity = (name) => { const v = (spec.views || []).find((x) => x.name === name); return v && v.entity.toLowerCase(); };
  const span = (o) => { if (tile.colspan) o.colspan = tile.colspan; if (tile.rowspan) o.rowspan = tile.rowspan; return o; };
  // ID passthrough (round-tripped dashboards): a tile may carry the deployed view/chart ids + entity
  // directly, so it binds to the EXISTING views/charts without re-declaring them in views[]/charts[].
  const targetEntity = tile.entity ? tile.entity.toLowerCase() : viewEntity(tile.view);
  if (tile.type === 'chart') {
    return span({ type: 'chart', name: tile.name || tile.chart, targetEntity,
      viewId: tile.viewId || result.created.views[tile.view], visualizationId: tile.visualizationId || result.created.charts[tile.chart] });
  }
  if (tile.type === 'list') {
    return span({ type: 'list', name: tile.name || tile.view, targetEntity, viewId: tile.viewId || result.created.views[tile.view] });
  }
  if (tile.type === 'iframe') return span({ type: 'iframe', name: tile.name, url: tile.url });
  return span({ type: 'webresource', name: tile.name, webResourceName: tile.webResource });
}

// Command-bar locations (CommandBarJson.location). MainTab = the entity's form/grid command bar.
const COMMAND_LOCATIONS = new Set(['MainTab', 'HomeTab', 'ContextualTab']);

// Build one command control: a button, or a flyout/split-button carrying nested `children`. Each
// control gets a GUID `id` with `command` set to the same id (the appactionid). A button with a
// `library` + `function` gets a functional JS on-click action bound to the created web resource;
// `hidden`/`disabled` set static visibility. A flyout/split container (type FlyoutAnchor|SplitButton)
// carries `children` instead of an action — the SDK's CommandAdapter synthesizes the required
// intervening Group between a flyout and its buttons (Dataverse forbids a button parented directly
// to a flyout). Throws if a referenced web resource wasn't created.
function buildCommandControl(c, webResources) {
  const id = randomUUID();
  const type = c.type || 'Button';
  const control = { id, type, label: c.label, command: id };
  if (c.icon) control.icon = c.icon;
  if (c.library && c.function) {
    const wrId = webResources[c.library];
    if (!wrId) throw new Error(`command "${c.label}" references web resource '${c.library}' which wasn't created — declare it in webResources[] and don't skip the web-resources phase`);
    control.action = { type: 'javascript', webResourceId: wrId, functionName: c.function };
    if (c.parameters !== undefined) control.action.parameters = c.parameters;
  }
  if (c.hidden) control.hidden = true;
  if (c.disabled) control.disabled = true;
  if ((type === 'FlyoutAnchor' || type === 'SplitButton') && Array.isArray(c.children)) {
    control.children = c.children.map((ch) => buildCommandControl(ch, webResources));
  }
  return control;
}

// Build a command (modern command-bar) artifact for one entity's buttons. Controls are emitted as
// LOOSE controls in a single empty-title group per location (id '' — not a real appaction, so the
// adapter emits its controls directly). A control may be a flyout/split button carrying `children`:
// that works because the adapter parents the synthesized intervening group to the flyout control.
// TITLED groups are intentionally NOT emitted — a from-scratch titled group is a Group appaction
// that needs a parent command-bar row the adapter doesn't synthesize (Dataverse 400 "Group button
// must have parentappactionid", confirmed live on a fresh entity), so grouping stays deferred.
function commandDef(entityLogical, cmds, webResources) {
  const byLocation = new Map(); // location -> controls[]
  for (const c of cmds) {
    const location = c.location || 'MainTab';
    if (!byLocation.has(location)) byLocation.set(location, []);
    byLocation.get(location).push(buildCommandControl(c, webResources));
  }
  const commandBars = [...byLocation.entries()].map(([location, controls]) => ({
    location,
    groups: [{ id: '', title: '', controls }],
  }));
  return { entityLogicalName: entityLogical, commandBars };
}

// Group an entity's commands (keyed by lowercased entity logical name).
function commandsByEntity(spec) {
  const byEntity = {};
  for (const c of spec.commands || []) {
    const k = String(c.entity).toLowerCase();
    (byEntity[k] = byEntity[k] || []).push(c);
  }
  return byEntity;
}

/** Resolve --only/--skip/--from/--to into the ordered set of phases to run. */
function resolvePhases({ only, skip, from, to } = {}) {
  let active = PHASES.slice();
  if (from) { const i = active.indexOf(from); if (i >= 0) active = active.slice(i); }
  if (to) { const i = active.indexOf(to); if (i >= 0) active = active.slice(0, i + 1); }
  const onlySet = only && new Set([].concat(only));
  const skipSet = skip && new Set([].concat(skip));
  return active.filter((p) => (!onlySet || onlySet.has(p)) && (!skipSet || !skipSet.has(p)));
}

// Resolve a view-filter value: a Choice/MultiChoice label becomes its option int; everything
// else (raw ints, strings, ISO dates) passes through. No-value operators omit the value entirely.
function resolveFilterValue(spec, entityLogical, attr, val) {
  if (typeof val !== 'string') return val;
  const e = entityByLogical(spec, entityLogical);
  const c = e && (e.columns || []).find((x) => x.schemaName.toLowerCase() === String(attr).toLowerCase());
  if (c && (c.type === 'Choice' || c.type === 'MultiChoice') && Array.isArray(c.options)) {
    const i = c.options.indexOf(val);
    if (i >= 0) return 100000000 + i;
  }
  return val;
}

function primaryNameOf(spec, logical) {
  const e = entityByLogical(spec, logical);
  return e ? e.primaryAttribute.schemaName.toLowerCase() : `${String(logical).toLowerCase()}name`;
}

// Map an App Spec web resource to SDK createWebResource options. Content comes from inline
// `content` (text), `contentBase64`, or a `contentPath` read relative to the app folder.
function webResourceOpts(wr, appDir) {
  const o = { name: wr.name, displayName: wr.displayName || wr.name, type: String(wr.type || 'js').toLowerCase() };
  if (wr.description) o.description = wr.description;
  if (wr.contentBase64 !== undefined) o.contentBase64 = wr.contentBase64;
  else if (wr.content !== undefined) o.content = wr.content;
  else if (wr.contentPath) o.content = fs.readFileSync(path.isAbsolute(wr.contentPath) ? wr.contentPath : path.join(appDir || '.', wr.contentPath), 'utf8');
  else o.content = '';
  return o;
}

// Map an App Spec form event to SDK addFormEventHandler options.
function formEventOpts(ev) {
  const o = { event: ev.event, libraryName: ev.library, functionName: ev.function,
    enabled: ev.enabled !== false, passExecutionContext: ev.passExecutionContext !== false };
  if (ev.attribute) o.attribute = String(ev.attribute).toLowerCase();
  if (ev.parameters !== undefined) o.parameters = ev.parameters;
  return o;
}

// --- the ordered plan (dry-run + totals) -----------------------------------------------
function planFor(spec, opts) {
  const has = (p) => !opts.phases || opts.phases.includes(p);
  const items = [];
  const sol = spec.solution;
  if (has('solution')) items.push({ phase: 'solution', label: `solution ${sol.uniqueName} (publisher ${sol.publisherPrefix})` });
  if (has('data-model')) {
    for (const gc of spec.globalChoices || []) items.push({ phase: 'data-model', label: `global choice ${gc.name}` });
    for (const e of spec.entities) {
      items.push({ phase: 'data-model', label: `table ${e.schemaName} ("${e.displayName}")` });
      for (const c of e.columns || []) {
        if (SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer') items.push({ phase: 'data-model', label: `column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})` });
      }
      for (const sr of e.statusReasons || []) items.push({ phase: 'data-model', label: `status reason ${e.schemaName}: ${sr.label}` });
      for (const k of e.alternateKeys || []) items.push({ phase: 'data-model', label: `alt key ${e.schemaName}.${k.schemaName}` });
    }
    for (const r of spec.relationships || []) {
      if (r.type === 'OneToMany') items.push({ phase: 'data-model', label: `relationship 1:N ${r.referenced}->${r.referencing}` });
      else if (r.type === 'ManyToMany') items.push({ phase: 'data-model', label: `relationship N:N ${r.entity1}<->${r.entity2}` });
    }
  }
  if (has('sample-data') && opts.sampleData) {
    for (const e of spec.entities) { const n = sampleRecordsFor(spec, e).length; if (n) items.push({ phase: 'sample-data', label: `${n} sample record(s) -> ${e.schemaName}` }); }
  }
  if (has('web-resources')) for (const wr of spec.webResources || []) items.push({ phase: 'web-resources', label: `web resource ${wr.name} (${wr.type || 'js'})` });
  if (has('web-resources')) for (const e of spec.entities || []) if (e.icon || e.vectorIcon) items.push({ phase: 'web-resources', label: `table icon for ${e.schemaName.toLowerCase()}` });
  if (has('views')) for (const v of spec.views || []) items.push({ phase: 'views', label: `view "${v.name}" for ${v.entity}` });
  if (has('views')) for (const e of spec.entities || []) if (enrichesDefaultViews(spec, e)) items.push({ phase: 'views', label: `enrich default views for ${e.schemaName.toLowerCase()}` });
  if (has('charts')) for (const c of spec.charts || []) items.push({ phase: 'charts', label: `chart "${c.name}" (${c.chartType}) for ${c.entity}` });
  if (has('forms')) for (const f of spec.forms || []) {
    const ft = f.formType || 'Main';
    const subs = (f.subgrids || []).map((s) => s.childEntity).join(', ');
    items.push({ phase: 'forms', label: `${ft === 'Main' ? 'form' : `${ft} form`} for ${f.entity}${subs ? ` (sub-grids: ${subs})` : ''}` });
    if ((f.events || []).length) items.push({ phase: 'forms', label: `wire ${f.events.length} event handler(s) on ${f.entity}` });
    if ((f.quickViews || []).length) items.push({ phase: 'forms', label: `place ${f.quickViews.length} quick-view(s) on ${f.entity}` });
  }
  if (has('commands')) for (const [entity, cmds] of Object.entries(commandsByEntity(spec))) items.push({ phase: 'commands', label: `command bar for ${entity} (${cmds.length} button(s))` });
  if (has('dashboards')) for (const d of spec.dashboards || []) items.push({ phase: 'dashboards', label: `dashboard "${d.name}" (${(d.tiles || []).length} tile(s))` });
  if (has('app-shell')) items.push({ phase: 'app-shell', label: `app module "${spec.app.name}" + sitemap` });
  if (has('app-shell') && !(spec.app && spec.app.icon)) items.push({ phase: 'app-shell', label: `app icon (generated) ${appUniqueName(spec)}_icon` });
  if (has('pages')) for (const p of spec.pages || []) items.push({ phase: 'pages', label: `page "${p.name}"` });
  if (has('pages') && (spec.pages || []).length && appHasPageSubareas(spec)) items.push({ phase: 'pages', label: 'finalize sitemap (genpage subareas)' });
  if (has('ai-features') && spec.ai !== undefined && spec.ai !== null) {
    items.push({ phase: 'ai-features', label: 'enable app AI features' });
    if (!(spec.ai.summaries && spec.ai.summaries.default === 'off')) {
      for (const logical of selectSummaryTables(spec)) {
        items.push({ phase: 'ai-features', label: `row summary for ${logical}` });
      }
    }
  }
  if (has('publish') && opts.publish) items.push({ phase: 'publish', label: 'publish customizations' });
  return items;
}

// --- phase builders (pure: spec -> SDK payloads) ---------------------------------------
// Build a saved-query def. `v.filters[]` adds rich conditions ({ attr, op, value?/values? });
// no-value operators (eq-userid, this-week, null, …) omit the value, and in/not-in expand to a
// nested or/and group of eq/ne (the SDK's filter serializer is single-value per condition).
// Resolve the savedquery id a form sub-grid should embed. Preference order:
//   1. the view the sub-grid explicitly names (a custom view we built),
//   2. any custom view we built for the child entity,
//   3. the child entity's DEFAULT public view (Dataverse auto-creates one per table) — this is
//      what makes a sub-grid on an entity with no bespoke view (a common N:N case) work.
// Returns undefined only when even the default view can't be found (caller then skips the grid).
async function subgridViewId(provision, createdViews, spec, sg, childLogical) {
  if (sg.view && createdViews[sg.view]) return createdViews[sg.view];
  const cv = (spec.views || []).find((v) => v.entity.toLowerCase() === childLogical);
  if (cv && createdViews[cv.name]) return createdViews[cv.name];
  const rows = await provision.queryRecords('savedquery', {
    select: ['savedqueryid', 'isdefault'],
    filter: `returnedtypecode eq '${childLogical}' and querytype eq 0`,
    top: 20,
  });
  const def = (rows || []).find((r) => r.isdefault) || (rows || [])[0];
  return def && def.savedqueryid;
}

function viewDef(spec, v) {
  const entityLogical = v.entity.toLowerCase();
  const cols = (v.columns && v.columns.length ? v.columns : [primaryNameOf(spec, entityLogical)]).map((name, i) => ({ name: String(name).toLowerCase(), width: 100, order: i }));
  const conditions = [];
  const groups = [];
  if (v.activeOnly !== false) conditions.push({ attribute: 'statecode', operator: 'eq', value: '0' });
  for (const f of v.filters || []) {
    const attr = String(f.attr).toLowerCase();
    const op = f.op || 'eq';
    if (op === 'in' || op === 'not-in') {
      const subOp = op === 'in' ? 'eq' : 'ne';
      const vals = (f.values || []).map((x) => resolveFilterValue(spec, entityLogical, attr, x));
      groups.push({ type: op === 'in' ? 'or' : 'and', conditions: vals.map((x) => ({ attribute: attr, operator: subOp, value: String(x) })), groups: [] });
    } else {
      const cond = { attribute: attr, operator: op };
      if (f.value !== undefined) cond.value = String(resolveFilterValue(spec, entityLogical, attr, f.value));
      conditions.push(cond);
    }
  }
  return { name: v.name, description: '', entityLogicalName: entityLogical, queryType: 0, isDefault: false, columns: cols,
    filters: { type: 'and', conditions, groups },
    sort: (v.sort || []).map((s) => ({ attribute: String(s.attr).toLowerCase(), descending: s.dir === 'desc' })) };
}

// Pick a "good" default-view column set: the primary name column plus up to DEFAULT_VIEW_MAX_EXTRA
// meaningful declared columns (in declared order), skipping wide/opaque types that read poorly in a
// grid. Used to enrich the auto-generated "Active/Inactive <Entity>" views (which ship with only
// the primary column).
const DEFAULT_VIEW_MAX_EXTRA = 6;
const DEFAULT_VIEW_SKIP_TYPES = new Set(['Memo', 'File', 'Image']);
function defaultViewColumns(spec, entity) {
  const primary = entity.primaryAttribute.schemaName.toLowerCase();
  const picked = [{ name: primary, width: 300, order: 0 }];
  for (const c of entity.columns || []) {
    if (picked.length > DEFAULT_VIEW_MAX_EXTRA) break;
    const logical = c.schemaName.toLowerCase();
    if (logical === primary) continue;
    if (DEFAULT_VIEW_SKIP_TYPES.has(c.type)) continue;
    picked.push({ name: logical, width: 150, order: picked.length });
  }
  return picked;
}
// True when a table has enough declared columns to make enriching its default views worthwhile
// (opt out per-entity with enrichDefaultViews:false).
function enrichesDefaultViews(spec, entity) {
  return !!entity && entity.enrichDefaultViews !== false && defaultViewColumns(spec, entity).length >= 2;
}

// The (entity, name) identity query that finds an already-built artifact so a re-run or a
// retry-after-partial-failure REUSES it instead of creating a duplicate. These artifact types
// (savedquery/savedqueryvisualization/systemform) are otherwise always-create — the root of the
// "16 copies of everything" duplication. Returns null for types without a stable identity query.
function artifactIdentityQuery(type, def) {
  const name = odataLit(def.name);
  const entity = odataLit(def.entityLogicalName);
  switch (type) {
    case 'view': return { set: 'savedquery', idField: 'savedqueryid', filter: `returnedtypecode eq '${entity}' and name eq '${name}'` };
    case 'chart': return { set: 'savedqueryvisualization', idField: 'savedqueryvisualizationid', filter: `primaryentitytypecode eq '${entity}' and name eq '${name}'` };
    case 'form': return { set: 'systemform', idField: 'formid', filter: `objecttypecode eq '${entity}' and name eq '${name}'` };
    // The app is keyed by its (deterministic) unique name. Reusing it on a re-run avoids a duplicate
    // appmodule (Dataverse 400s on a duplicate uniquename). NOTE: reuse does not re-push the sitemap,
    // so a genuine app EDIT must go through the download->hydrate->update flow, not a bare re-run.
    case 'app': return { set: 'appmodule', idField: 'appmoduleid', filter: `uniquename eq '${odataLit(def.uniqueName)}'` };
    default: return null;
  }
}

function chartDef(spec, ch) {  const entityLogical = ch.entity.toLowerCase();
  return { name: ch.name, description: '', entityLogicalName: entityLogical, chartType: ch.chartType, isDefault: false,
    series: [{ attribute: `${entityLogical}id`, aggregate: ch.measure || 'count' }],
    categories: [{ attribute: String(ch.groupBy).toLowerCase() }], presentation: { showLegend: true, title: ch.name } };
}

function fieldCell(logical, label, required) {
  return { visible: true, colspan: 1, rowspan: 1,
    control: { id: logical, classId: STD_FIELD_CLASS_ID, fieldName: logical, type: 'standard', isRequired: !!required, isReadOnly: false, label, showLabel: true, parameters: {} } };
}
function notesCell() {
  return { visible: true, colspan: 1, rowspan: 1,
    control: { id: 'notescontrol', classId: NOTES_CLASS_ID, fieldName: null, type: 'notes', isRequired: false, isReadOnly: false, label: 'Notes', showLabel: false, parameters: {} } };
}
// Arrange field cells into `columns` cells-per-row.
function rowsFromCells(cells, columns) {
  const cols = Math.max(1, Math.min(4, columns || 1));
  const rows = [];
  for (let i = 0; i < cells.length; i += cols) rows.push({ cells: cells.slice(i, i + cols) });
  return rows;
}

// Build a Main-form definition. Honors explicit `tabs`/`sections`/`columns` from the spec;
// otherwise lays the primary + scalar columns into a "General" section (2-column when the
// table is field-heavy). Adds a Notes section when the form/entity opts in.
function formDef(spec, f) {
  const entityLogical = f.entity.toLowerCase();
  const entity = entityByLogical(spec, entityLogical);
  const labelFor = (logical) => {
    if (entity && logical === entity.primaryAttribute.schemaName.toLowerCase()) return entity.primaryAttribute.displayName || 'Name';
    const c = entity && (entity.columns || []).find((x) => x.schemaName.toLowerCase() === logical);
    return (c && (c.displayName || c.schemaName)) || logical;
  };
  const requiredFor = (logical) => {
    if (entity && logical === entity.primaryAttribute.schemaName.toLowerCase()) return true;
    const c = entity && (entity.columns || []).find((x) => x.schemaName.toLowerCase() === logical);
    return !!(c && c.required === true);
  };

  let tabs;
  const formType = f.formType || 'Main';
  // Quick Create forms must use single-column sections — Dataverse rejects a multi-column
  // (columns="11"/"111") quick-create section with "Columns in a section must be set to '1'".
  const maxCols = formType === 'QuickCreate' ? 1 : 4;
  const explicit = Array.isArray(f.tabs) || f.layout === 'explicit';
  if (explicit && Array.isArray(f.tabs)) {
    // Honor the authored layout verbatim.
    tabs = f.tabs.map((t, ti) => ({
      name: t.name || `tab_${ti}`, label: t.label || 'General', expanded: true, visible: true,
      sections: (t.sections || []).map((s, si) => {
        const cells = (s.fields || []).map((fl) => { const lg = String(fl).toLowerCase(); return fieldCell(lg, labelFor(lg), requiredFor(lg)); });
        const secCols = Math.min(s.columns || 1, maxCols);
        return { name: s.name || `section_${ti}_${si}`, label: s.label || 'Details', visible: true, showLabel: s.showLabel !== false, columns: secCols, rows: rowsFromCells(cells, secCols) };
      }),
    }));
  } else {
    // Auto: primary + every scalar column. 2-column when field-heavy (> 6), else 1.
    const cells = [];
    if (entity) {
      cells.push(fieldCell(entity.primaryAttribute.schemaName.toLowerCase(), entity.primaryAttribute.displayName || 'Name', true));
      for (const c of entity.columns || []) { if (!SDK_COLUMN_TYPE[c.type || 'Text']) continue; cells.push(fieldCell(c.schemaName.toLowerCase(), c.displayName || c.schemaName, c.required === true)); }
    }
    const columns = Math.min(cells.length > 6 ? 2 : 1, maxCols);
    tabs = [{ name: 'tab_general', label: 'General', expanded: true, visible: true,
      sections: [{ name: 'section_general', label: 'General', visible: true, showLabel: false, columns, rows: rowsFromCells(cells, columns) }] }];
  }

  // Notes section (opt-in: form.notes or entity.hasNotes) — Main forms only; quick-create /
  // quick-view forms don't host the activity timeline.
  const wantNotes = formType === 'Main' && (f.notes === true || (entity && entity.hasNotes === true));
  if (wantNotes) {
    tabs[0].sections.push({ name: 'section_notes', label: 'Notes', visible: true, showLabel: true, columns: 1, rows: [{ cells: [notesCell()] }] });
  }

  return { entityLogicalName: entityLogical, name: f.name || `${f.entity} form`, formType, status: 'Active', tabs };
}

// The app module's uniquename, derived deterministically from the publisher prefix + app name
// (same rule the builder writes with). Shared with the teardown engine so it can resolve the
// deployed app by uniquename rather than a collision-prone display name.
function appUniqueName(spec) {
  const sol = spec.solution;
  return `${sol.publisherPrefix}_${spec.app.name}`.replace(/[^a-z0-9_]/gi, '').toLowerCase();
}

// A simple, self-contained default app-tile icon (SVG) — a rounded square with the app's initial.
// Generated INTO the app's solution so the app never depends on an arbitrary external/managed icon
// (which fails to import into an environment where that managed solution isn't installed).
function defaultAppIconSvg(appName) {
  const letter = (String(appName || 'A').trim()[0] || 'A').toUpperCase().replace(/[<>&"']/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">` +
    `<rect width="44" height="44" rx="8" fill="#0F6CBD"/>` +
    `<text x="22" y="30" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="600" text-anchor="middle" fill="#ffffff">${letter}</text>` +
    `</svg>`;
}

// Resolve the app's tile-icon web resource id, ensuring it lives IN this solution. Uses
// spec.app.icon (a declared web resource) when set; otherwise generates a default SVG icon named
// `<appUniqueName>_icon` and adds it to the solution (idempotent — reused by name on a re-run).
// Returns the web-resource id, or undefined if it can't be resolved (the SDK then falls back).
async function ensureAppIcon(spec, created, deps) {
  const { provision, sol, runner } = deps;
  const findByName = async (name) => {
    const rows = await provision.queryRecords('webresource', { select: ['webresourceid'], filter: `name eq '${odataLit(name)}'`, top: 1 });
    return rows && rows[0] && rows[0].webresourceid;
  };
  if (spec.app && spec.app.icon) {
    // An explicit author icon — created this run (in webResources) or already present by name.
    return (created.webResources && created.webResources[spec.app.icon]) || (await findByName(spec.app.icon)) || undefined;
  }
  const name = `${appUniqueName(spec)}_icon`;
  const existing = await findByName(name);
  if (existing) {
    created.webResources[name] = existing;
    return existing;
  }
  let id;
  await runner.run('app-shell', `app icon (generated) ${name}`, async () => {
    const r = await provision.createWebResource({ name, displayName: `${spec.app.name} Icon`, type: 'svg', content: defaultAppIconSvg(spec.app.name) });
    id = r.id;
    created.webResources[name] = r.id;
    await provision.addSolutionComponent({ componentId: r.id, componentType: COMPONENT_TYPE.webResource, solutionUniqueName: sol.uniqueName });
    return name;
  });
  return id;
}

// Add the app's sitemap (componenttype 62) to the solution. Adding the app module alone leaves the
// sitemap only in the Default solution, so the app's own solution is incomplete on export. Resolve
// the sitemap by its unique name (== the app's unique name) and add it. Best-effort + idempotent:
// a re-add of an already-present component is tolerated so this never fails an otherwise-good build.
async function ensureSitemapInSolution(provision, sol, appUnique) {
  try {
    const rows = await provision.queryRecords('sitemap', { select: ['sitemapid'], filter: `sitemapnameunique eq '${odataLit(appUnique)}'`, top: 1 });
    const sitemapId = rows && rows[0] && rows[0].sitemapid;
    if (!sitemapId) return;
    await provision.addSolutionComponent({ componentId: sitemapId, componentType: COMPONENT_TYPE.sitemap, solutionUniqueName: sol.uniqueName });
  } catch { /* best-effort — the app + its sitemap already exist; a component-pin hiccup must not fail the build */ }
}

// True when any sitemap subarea targets a generative page — the app must then be created first
// (app_early) and its sitemap rewritten after the pages phase resolves the genPageIds.
function appHasPageSubareas(spec) {  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    for (const g of a.groups || []) {
      for (const s of g.subAreas || []) if (s && s.page) return true;
    }
  }
  return false;
}

function appDef(spec, result, opts = {}) {
  const sol = spec.solution;
  const uniqueName = appUniqueName(spec);
  // A subarea is an Entity (table) by default, a DashBoard (a built dashboard, by name — the SDK
  // auto-pins its dashboardId as an app component so the nav actually includes it), or a URL.
  const subAreaJson = (s, id) => {
    const base = { id, title: s.title,
      ...(s.icon ? { icon: String(s.icon).toLowerCase() } : {}),
      ...(s.vectorIcon ? { vectorIcon: s.vectorIcon } : {}) };
    if (s.dashboard) {
      const dashboardId = (result.dashboards || {})[s.dashboard];
      if (!dashboardId) throw new Error(`sitemap subarea "${s.title}" references dashboard '${s.dashboard}' which wasn't built — declare it in dashboards[] and don't skip the dashboards phase`);
      return { ...base, type: 'DashBoard', dashboardId };
    }
    if (s.page) {
      const genPageId = (result.pages || {})[s.page];
      if (!genPageId) {
        // During the initial app-create (app_early) pages aren't uploaded yet — omit the subarea;
        // the pages phase rewrites the sitemap once the genPageIds exist. A genuinely-missing page
        // (finalize/edit time) still throws.
        if (opts.omitUnbuiltPages) return null;
        throw new Error(`sitemap subarea "${s.title}" references page '${s.page}' which wasn't built — declare it in pages[] and don't skip the pages phase`);
      }
      return { ...base, type: 'GenPage', genPageId };
    }
    if (s.url) return { ...base, type: 'URL', url: s.url };
    return { ...base, type: 'Entity', entity: s.entity && s.entity.toLowerCase() };
  };
  const areas = (spec.appShell.areas || []).map((a, ai) => ({ id: `area_${ai}`, title: a.label,
    ...(a.icon ? { icon: String(a.icon).toLowerCase() } : {}),
    ...(a.vectorIcon ? { vectorIcon: a.vectorIcon } : {}),
    groups: (a.groups || []).map((g, gi) => ({ id: `group_${ai}_${gi}`, title: g.label,
      subAreas: (g.subAreas || []).map((s, si) => subAreaJson(s, `sub_${ai}_${gi}_${si}`)).filter(Boolean) })) }));
  return { name: spec.app.name, uniqueName, description: spec.app.description || '', siteMap: { areas },
    ...(opts.iconWebResourceId ? { iconWebResourceId: opts.iconWebResourceId } : {}),
    components: { forms: Object.values(result.forms || {}).filter(Boolean), views: Object.values(result.views || {}).filter(Boolean), charts: Object.values(result.charts || {}).filter(Boolean) } };
}

// --- orchestrator ----------------------------------------------------------------------
async function runSdkBuild(spec, opts = {}) {
  const { sdk, apply = false, sampleData = false, publish = false } = opts;
  const emit = opts.emit || (() => undefined);
  // Header-less client for solution lifecycle + artifact pushes (Dataverse rejects the
  // MSCRM.SolutionUniqueName header on createSolution and on savedquery/systemform/appmodule
  // creates); metadata + records keep the header-ful `sdk`. Reads (find*/fetch*) ignore the
  // header, so either client works for discovery.
  const provision = opts.provisionSdk || sdk;
  const phases = opts.phases || PHASES;
  const has = (p) => phases.includes(p);
  const concurrency = opts.concurrency || 4;
  const plan = planFor(spec, { sampleData, publish, phases });

  if (!apply) {
    plan.forEach((p, i) => emit({ phase: p.phase, status: 'skip', label: p.label, n: i + 1, total: plan.length }));
    return { ok: true, dryRun: true, plan: plan.map((p) => p.label) };
  }

  const result = { ok: true, created: { entities: {}, relationships: {}, records: {}, webResources: {}, views: {}, charts: {}, forms: {}, commands: {}, dashboards: {}, pages: {}, ai: { appFeatures: null, summaries: {} }, app: null } };
  const runner = makeRunner({ emit, total: plan.length });
  const sol = spec.solution;

  // 1. Solution (idempotent; header-less provisioning client).
  if (has('solution')) await provisionSolution({ sdk, provision, runner, solution: sol });

  // 2. Data model — idempotent. Discover existing tables/columns/relationships via the SDK
  //    (find*/fetch*), then create only what's missing. Captures entitySetName for every
  //    entity (fresh -> createTable result, existing -> findTables hit).
  let dataModel = { entities: {}, globalChoiceIds: {}, statusReasonValues: {}, columns: {}, relationships: [] };
  if (has('data-model')) {
    dataModel = await provisionDataModel({ sdk, provision, runner, spec, apply });
    Object.assign(result.created.entities, dataModel.entities);
  }

  // entity-set resolver: fresh tables cached above; existing ones via fetchEntityMetadata.
  const entitySetFor = makeEntitySetResolver({ spec, entities: dataModel.entities, provision });

  // 3. Sample data (opt-in): topological, $parent -> @odata.bind on the lookup nav prop.
  if (has('sample-data') && sampleData) {
    const sd = await provisionSampleData({ sdk, provision, runner, spec, dataModel });
    Object.assign(result.created.records, sd.records);
  }

  // 3b. Web resources (opt-in via spec.webResources) — JS/HTML/CSS shipped for form logic.
  //     Idempotent: an existing web resource of the same name is reused (and assumed already
  //     in the solution). Built before forms so a form event handler can bind its library.
  if (has('web-resources')) {
    for (const wr of spec.webResources || []) {
      const existing = await provision.queryRecords('webresource', { select: ['webresourceid'], filter: `name eq '${wr.name}'`, top: 1 });
      if (existing && existing[0] && existing[0].webresourceid) {
        result.created.webResources[wr.name] = existing[0].webresourceid;
        runner.skip('web-resources', `web resource ${wr.name} (exists — reuse)`);
        continue;
      }
      await runner.run('web-resources', `web resource ${wr.name} (${wr.type || 'js'})`, async () => {
        const r = await provision.createWebResource(webResourceOpts(wr, opts.appDir));
        result.created.webResources[wr.name] = r.id;
        await provision.addSolutionComponent({ componentId: r.id, componentType: COMPONENT_TYPE.webResource, solutionUniqueName: sol.uniqueName });
      });
    }
    // 3c. Table icons — set each entity's OWN icon to a declared web resource (SVG -> IconVectorName
    //     for the modern designer/nav; raster -> IconMediumName). Runs here (after web resources
    //     exist) so the referenced web resource is present + published before we point the table at
    //     it. Skipped for a table not built/reused this run, or an icon whose web resource wasn't
    //     created/reused (e.g. its phase was skipped) — with a clear message rather than a hard fail.
    const builtWrNames = new Set(Object.keys(result.created.webResources).map((n) => n.toLowerCase()));
    for (const e of spec.entities || []) {
      if (!e.icon && !e.vectorIcon) continue;
      const logical = e.schemaName.toLowerCase();
      if (!result.created.entities[logical] && !result.created.entities[e.schemaName]) {
        runner.skip('web-resources', `table icon for ${logical} (table not built this run)`);
        continue;
      }
      const missing = [e.vectorIcon, e.icon].filter((n) => n && !builtWrNames.has(String(n).toLowerCase()));
      if (missing.length) {
        runner.skip('web-resources', `table icon for ${logical} (web resource ${missing.join(', ')} not built this run)`);
        continue;
      }
      await runner.run('web-resources', `table icon for ${logical}`, async () => {
        await provision.setEntityIcon(logical, { vector: e.vectorIcon || undefined, medium: e.icon || undefined });
        return `${[e.vectorIcon && `vector=${e.vectorIcon}`, e.icon && `raster=${e.icon}`].filter(Boolean).join(', ')}`;
      });
    }
  }

  // helper: create an artifact header-less, push, add to the solution.
  const buildArtifact = (type, def) => runner.run(`${type}s`, `${type} "${def.name}"`, async () => {
    // Idempotency: if an artifact with this (entity, name) identity already exists (a re-run or a
    // retry after a partial failure), reuse it instead of creating a duplicate.
    // Deduplicated kinds: view, chart, form (by name+entity). The app module is handled separately
    // in the app-shell phase (an existing app is re-synced, not just reused — see below).
    let identity = null;
    if (type === 'view' || type === 'chart' || type === 'form') identity = { name: def.name, entity: def.entityLogicalName };
    if (identity) {
      const existingId = await provision.findArtifact(type, identity);
      if (existingId) return existingId;
    }
    const art = provision.createArtifact(type, def);
    if (type === 'form' && def.__subgrids) for (const sg of def.__subgrids) provision.addSubGrid(art.id, sg);
    const pushed = await provision.pushArtifact(type, art.id);
    await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE[type], solutionUniqueName: sol.uniqueName });
    return pushed.id;
  });

  // 4. Views (independent -> parallel).
  if (has('views')) {
    const ids = await runner.mapLimit(spec.views || [], concurrency, (v) => buildArtifact('view', viewDef(spec, v)));
    (spec.views || []).forEach((v, i) => { result.created.views[v.name] = ids[i]; });
  }

  // 4b. Enrich the auto-generated default "Active/Inactive <Entity>" system views (Dataverse ships
  // them with only the primary column). One step per enrichable entity; opt out per-entity with
  // enrichDefaultViews:false. Author-declared views (also querytype 0) are excluded by id; the SDK
  // owns the default-view resolution + fetch/setViewColumns/push/publish mechanics.
  if (has('views')) {
    const authorViewIds = Object.values(result.created.views || {}).filter(Boolean);
    for (const e of spec.entities || []) {
      if (!enrichesDefaultViews(spec, e)) continue;
      const logical = e.schemaName.toLowerCase();
      const cols = defaultViewColumns(spec, e);
      await runner.run('views', `enrich default views for ${logical}`, async () => {
        const { updated } = await provision.enrichDefaultViews(logical, cols, { excludeViewIds: authorViewIds });
        return updated;
      });
    }
  }

  // 5. Charts (independent -> parallel; built before forms so a form could reference one).
  if (has('charts')) {
    const charts = spec.charts || [];
    const ids = await runner.mapLimit(charts, concurrency, (c) => buildArtifact('chart', chartDef(spec, c)));
    charts.forEach((c, i) => { result.created.charts[c.name] = ids[i]; });
  }

  // 6. Forms (independent -> parallel; sub-grids reference the child view ids built above).
  //    A form with `events[]` then gets its JS handlers wired: fetch the pushed form (to
  //    retain its formxml), inject onload/onsave/onchange handlers, push + publish.
  if (has('forms')) {
    const defs = await Promise.all((spec.forms || []).map(async (f) => {
      const def = formDef(spec, f);
      const subs = [];
      for (const sg of (f.subgrids || [])) {
        // A sub-grid can hang off a 1:N (child has the lookup) or an N:N (intersect) relationship.
        const oneToMany = relationshipFor(spec, f.entity, sg.childEntity);
        const nn = oneToMany ? null : manyToManyFor(spec, f.entity, sg.childEntity);
        if (!oneToMany && !nn) continue;
        const relationshipName = oneToMany ? relationshipSchemaName(oneToMany, spec.solution && spec.solution.publisherPrefix) : manyToManySchemaName(nn, spec.solution && spec.solution.publisherPrefix);
        const childLogical = sg.childEntity.toLowerCase();
        const viewId = await subgridViewId(provision, result.created.views, spec, sg, childLogical);
        // Every sub-grid needs a concrete view id (the SDK embeds it in the control XML). If the
        // child entity has neither an explicit nor a built view AND no default public view can be
        // found, skip the sub-grid rather than crash the whole forms phase.
        if (!viewId) { runner.skip('forms', `sub-grid ${sg.label || sg.childEntity} on ${f.entity} (no resolvable view — skipped)`); continue; }
        subs.push({ entity: childLogical, relationshipName, viewId, label: sg.label || sg.childEntity });
      }
      def.__subgrids = subs;
      return { f, def };
    }));
    const ids = await runner.mapLimit(defs, concurrency, async (d) => {
      const id = await buildArtifact('form', d.def);
      const events = (d.f.events || []).filter((ev) => FORM_EVENTS.has(ev.event) && ev.library && ev.function);
      if (events.length) {
        await runner.run('forms', `wire ${events.length} event handler(s) on ${d.f.entity}`, async () => {
          await provision.fetchArtifact('form', id);
          for (const ev of events) provision.addFormEventHandler(id, formEventOpts(ev));
          await provision.pushArtifact('form', id);
          await provision.publishArtifact('form', id);
        });
      }
      return id;
    });
    // Key the entity's MAIN form by entity (the app wires one form per entity below); quick-create
    // / quick-view forms are still built + added to the solution, just not the entity's app form.
    defs.forEach((d, i) => { if ((d.f.formType || 'Main') === 'Main') result.created.forms[d.f.entity.toLowerCase()] = ids[i]; });
    // Quick-view placement: embed a built QuickView form onto a host form via a lookup column
    // (addQuickViewControl), referencing the quick-view form by name. Runs after ALL forms are
    // built so a host can reference a QuickView form created concurrently. The control renders
    // from plain formxml (no <controlDescriptions>), so it persists via push + publish.
    const formIdByName = {};
    defs.forEach((d, i) => { if (d.f.name) formIdByName[d.f.name] = ids[i]; });
    for (let i = 0; i < defs.length; i++) {
      const f = defs[i].f;
      const qvs = (f.quickViews || []).filter((q) => q && q.lookup && q.targetEntity && q.form);
      if (!qvs.length) continue;
      const hostId = ids[i];
      await runner.run('forms', `place ${qvs.length} quick-view(s) on ${f.entity}`, async () => {
        await provision.fetchArtifact('form', hostId);
        for (const qv of qvs) {
          const qvFormId = formIdByName[qv.form];
          if (!qvFormId) throw new Error(`form "${f.name || f.entity}" quick-view references form '${qv.form}' which wasn't built — declare it in forms[] with formType: "QuickView" and a matching name`);
          provision.addQuickViewControl(hostId, { lookupFieldName: String(qv.lookup).toLowerCase(), targetEntity: String(qv.targetEntity).toLowerCase(), quickViewFormId: qvFormId, label: qv.label, sectionName: qv.section, displayAsCard: qv.displayAsCard });
        }
        await provision.pushArtifact('form', hostId);
        await provision.publishArtifact('form', hostId);
      });
    }
  }

  // 6b. Commands (modern command-bar buttons). One command artifact per entity; a button with a
  //     library+function gets a functional JS on-click action bound to the created web resource.
  //     Pushed via the workspace-owning `provision` client (the appaction lands in the Default
  //     solution — it's not a standard solution-component type — but is entity-scoped so it shows
  //     on the entity's command bar in the app regardless).
  if (has('commands')) {
    for (const [entityLogical, cmds] of Object.entries(commandsByEntity(spec))) {
      await runner.run('commands', `command bar for ${entityLogical} (${cmds.length} button(s))`, async () => {
        const def = commandDef(entityLogical, cmds, result.created.webResources);
        const art = provision.createArtifact('command', def);
        const pushed = await provision.pushArtifact('command', art.id);
        result.created.commands[entityLogical] = pushed.id;
      });
    }
  }

  // 6c. Dashboards. createArtifact('dashboard') seeds a dashboard; addDashboardTile synthesizes
  //     each chart/list/iframe/webresource tile (referencing the views/charts already built), then
  //     push + add to the solution (systemform, component type 60). Global (no entity); placement in
  //     the app sitemap is manual for now.
  if (has('dashboards')) {
    for (const dash of spec.dashboards || []) {
      await runner.run('dashboards', `dashboard "${dash.name}" (${(dash.tiles || []).length} tile(s))`, async () => {
        const art = provision.createArtifact('dashboard', { name: dash.name });
        for (const tile of dash.tiles || []) provision.addDashboardTile(art.id, dashboardTileOpts(spec, tile, result));
        const pushed = await provision.pushArtifact('dashboard', art.id);
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.dashboard, solutionUniqueName: sol.uniqueName });
        result.created.dashboards[dash.name] = pushed.id;
      });
    }
  }

  // 7. App module + sitemap. When the app has generative-page subareas, create it WITHOUT them
  //    (they can't resolve until pages upload); the pages phase then rewrites the sitemap.
  //    For an app that ALREADY exists (edit flow / retry), its sitemap + components are write-once
  //    on create, so a plain reuse would silently drop requested subarea add/rename/reorder edits.
  //    Fetch it into this session's workspace (also required before push/publish on a cross-session
  //    edit) and rewrite the sitemap + components from the current spec so edits land idempotently.
  if (has('app-shell')) {
    // Self-contained app-tile icon: a web resource IN this solution (default generated, or the
    // author's spec.app.icon). Resolved BEFORE appDef so the id is embedded at create time — the
    // reliable path (an appmodule's webresourceid is effectively write-once). This replaces the
    // SDK's arbitrary external/managed icon fallback that broke import into a fresh environment.
    const iconWebResourceId = await ensureAppIcon(spec, result.created, { provision, sol, runner });
    const def = appDef(spec, result.created, { omitUnbuiltPages: true, iconWebResourceId });
    result.created.app = await runner.run('app-shell', `app "${def.name}"`, async () => {
      const existingId = await provision.findArtifact('app', { uniqueName: def.uniqueName });
      if (existingId) {
        await provision.fetchArtifact('app', existingId);
        provision.setAppDefinition(existingId, { siteMap: def.siteMap, components: def.components });
        await provision.pushArtifact('app', existingId);
        // Page-backed apps get their authoritative sitemap (incl. GenPage subareas) + publish from
        // the pages finalizer below; publish here only when there are no page subareas to wait for.
        if (!appHasPageSubareas(spec)) await provision.publishArtifact('app', existingId);
        await ensureSitemapInSolution(provision, sol, def.uniqueName);
        return existingId;
      }
      const art = provision.createArtifact('app', def);
      const pushed = await provision.pushArtifact('app', art.id);
      await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.app, solutionUniqueName: sol.uniqueName });
      // The app module and its sitemap are DISTINCT solution components — adding the appmodule does
      // NOT pull the sitemap in (it lands only in the Default solution), so export/import from the
      // app's own solution would be incomplete. Add the sitemap (componenttype 62) explicitly.
      await ensureSitemapInSolution(provision, sol, def.uniqueName);
      return pushed.id;
    });
  }

  // 7b. Pages (generative pages). The app now exists, so upload each page's content via pac
  //     (WITHOUT --add-to-sitemap — the SDK owns the sitemap), then rewrite the app's sitemap once
  //     to include the GenPage subareas. Existing pages (matched by name) update in place.
  if (has('pages') && (spec.pages || []).length) {
    const genpageCli = opts.genpageCli || makeGenpageCli(opts.env);
    let existingByName = new Map();
    try {
      const existing = await genpageCli.list({ appId: result.created.app });
      existingByName = new Map((existing || []).filter((p) => p.name).map((p) => [p.name, p.pageId]));
    } catch { existingByName = new Map(); }
    for (const p of spec.pages) {
      await runner.run('pages', `page "${p.name}"`, async () => {
        const codeFile = path.resolve(opts.appDir || '.', p.codeFile);
        const up = await genpageCli.upload({ appId: result.created.app, pageId: existingByName.get(p.name), codeFile, name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
        result.created.pages[p.name] = up.pageId;
        return up.pageId;
      });
    }
    if (appHasPageSubareas(spec)) {
      await runner.run('pages', 'finalize sitemap (genpage subareas)', async () => {
        await provision.fetchArtifact('app', result.created.app);
        const full = appDef(spec, result.created);
        provision.setAppDefinition(result.created.app, { siteMap: full.siteMap, components: full.components });
        await provision.pushArtifact('app', result.created.app);
        await provision.publishArtifact('app', result.created.app);
        return result.created.app;
      });
    }
  }

  // 7c. AI features (opt-in via spec.ai). Enable app-level agents (gated on admin settings) +
  //     configure per-table row summaries. All AI writes are best-effort-gated: setAppAiFeatures
  //     skips features whose admin gate is off; it never throws.
  if (has('ai-features') && spec.ai !== undefined && spec.ai !== null) {
    const solutionUniqueName = spec.solution && spec.solution.uniqueName;
    const appUnique = appUniqueName(spec);
    const flags = Object.assign({ formFill: true, nlSearch: true, nlChart: true, m365: false }, (spec.ai.appFeatures || {}));
    await runner.run('ai-features', 'enable app AI features', async () => {
      const r = await provision.setAppAiFeatures(appUnique, flags, { solutionUniqueName });
      result.created.ai.appFeatures = r;
      return (r.applied && r.applied.length) ? `applied: ${r.applied.join(', ')}${r.skipped && r.skipped.length ? '; skipped (admin gate off): ' + r.skipped.join(', ') : ''}` : '(none \u2014 admin gate off)';
    });
    const tables = (spec.ai.summaries && spec.ai.summaries.default === 'off') ? [] : selectSummaryTables(spec);
    for (const logical of tables) {
      const ent = (spec.entities || []).find((e) => String(e.schemaName).toLowerCase() === String(logical).toLowerCase());
      if (!ent) continue;
      const override = spec.ai.summaries && spec.ai.summaries.tables && (spec.ai.summaries.tables[logical] || spec.ai.summaries.tables[String(logical).toLowerCase()]);
      await runner.run('ai-features', `row summary for ${logical}`, async () => {
        const promptSpec = buildPromptSpec(ent, { spec, override });
        const res = await provision.configureRowSummary(promptSpec, { solutionUniqueName });
        result.created.ai.summaries[logical] = res;
        return res.modelId;
      });
    }
  }

  // 8. Publish (opt-in). Publish ONE artifact per entity (covers that entity's customizations)
  //    + the app — far fewer PublishXml round-trips than publishing every artifact.
  if (has('publish') && publish) {
    await runner.run('publish', 'publish customizations', async () => {
      const seen = new Set();
      const perEntity = []; // [type, id] — first artifact found per entity
      for (const f of spec.forms || []) { const id = result.created.forms[f.entity.toLowerCase()]; if (id && !seen.has(f.entity.toLowerCase())) { seen.add(f.entity.toLowerCase()); perEntity.push(['form', id]); } }
      for (const v of spec.views || []) { const k = v.entity.toLowerCase(); if (result.created.views[v.name] && !seen.has(k)) { seen.add(k); perEntity.push(['view', result.created.views[v.name]]); } }
      await runner.mapLimit(perEntity, concurrency, ([type, id]) => provision.publishArtifact(type, id));
      if (result.created.app) await provision.publishArtifact('app', result.created.app);
    });
  }

  return result;
}

module.exports = { runSdkBuild, planFor, resolvePhases, PHASES, BuildHalt, SDK_COLUMN_TYPE, viewDef, defaultViewColumns, enrichesDefaultViews, artifactIdentityQuery, chartDef, dashboardTileOpts, formDef, appDef, appUniqueName, commandsByEntity, webResourceOpts, formEventOpts, WEB_RESOURCE_KINDS, FORM_EVENTS };

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
const { topoOrderEntities } = require('./_graph.js');

// App Spec column type -> SDK ColumnType. Lookup is omitted (side effect of a OneToMany
// relationship); Customer is handled specially (createCustomerColumn).
const SDK_COLUMN_TYPE = {
  Text: 'string', Memo: 'memo', Choice: 'choice', MultiChoice: 'multiChoice',
  Boolean: 'boolean', Money: 'money', DateTime: 'dateTime',
  Integer: 'integer', BigInt: 'bigint', Decimal: 'decimal', Double: 'double',
  File: 'file', Image: 'image', AutoNumber: 'autonumber',
};
const REQUIRED = (c) => (c.required === true ? 'ApplicationRequired' : c.required === 'recommended' ? 'Recommended' : 'None');

// Map an App Spec column to SDK CreateColumnOptions. `globalChoiceIds` maps a global-choice
// name -> its metadataId (so a column can bind to a shared option set).
function columnOptions(c, globalChoiceIds) {
  const o = { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, type: SDK_COLUMN_TYPE[c.type || 'Text'], required: REQUIRED(c) };
  switch (c.type) {
    case 'Text': if (c.maxLength) o.maxLength = c.maxLength; if (c.format) o.stringFormat = c.format; break;
    case 'Memo': if (c.maxLength) o.maxLength = c.maxLength; break;
    case 'Integer': case 'BigInt': case 'Decimal': case 'Double': case 'Money':
      if (c.minValue !== undefined) o.minValue = c.minValue;
      if (c.maxValue !== undefined) o.maxValue = c.maxValue;
      if (c.precision !== undefined) o.precision = c.precision; break;
    case 'DateTime': if (c.dateFormat) o.dateFormat = c.dateFormat; break;
    case 'Boolean': if (c.trueLabel) o.trueLabel = c.trueLabel; if (c.falseLabel) o.falseLabel = c.falseLabel; break;
    case 'Choice': case 'MultiChoice':
      if (c.globalChoice && globalChoiceIds[c.globalChoice]) o.globalChoiceMetadataId = globalChoiceIds[c.globalChoice];
      else o.options = choiceOptions(c); break;
    case 'File': case 'Image': if (c.maxSizeKb) o.maxSizeKb = c.maxSizeKb; if (c.type === 'Image' && c.isPrimaryImage) o.isPrimaryImage = true; break;
    case 'AutoNumber': if (c.autoNumberFormat) o.autoNumberFormat = c.autoNumberFormat; break;
  }
  if (c.source === 'Calculated' || c.source === 'Rollup') { o.sourceType = c.source; if (c.formula) o.formulaDefinition = c.formula; }
  return o;
}
const STATE_CODE = { Active: 0, Inactive: 1 };

// Standard field control classId (Dataverse picks the widget by attribute type) and the
// classic Notes/timeline control classId.
const STD_FIELD_CLASS_ID = '4273EDBD-AC1D-40d3-9FB2-095C621B552D';
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E';
const COMPONENT_TYPE = { view: 26, chart: 59, form: 60, dashboard: 60, webResource: 61, app: 80 };

// Web-resource kinds (App Spec `type`) -> SDK createWebResource `type` token. The SDK maps
// the token to the Dataverse webresourcetype code (js=3, html=1, css=2, …).
const WEB_RESOURCE_KINDS = new Set(['js', 'html', 'css', 'xml', 'png', 'jpg', 'gif', 'xsl', 'ico', 'svg', 'resx']);
// Form-event kinds the SDK can wire (addFormEventHandler).
const FORM_EVENTS = new Set(['onload', 'onsave', 'onchange']);

const PHASES = ['solution', 'data-model', 'sample-data', 'web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards', 'app-shell', 'publish'];

// Map a dashboard tile (App Spec) to the SDK's AddDashboardTileOptions. chart/list tiles resolve
// the underlying view (savedqueryid) — and the chart its visualization id — from what the build
// already created; the target entity is derived from the referenced view. iframe/webresource tiles
// carry a url / web-resource name.
function dashboardTileOpts(spec, tile, result) {
  const viewEntity = (name) => { const v = (spec.views || []).find((x) => x.name === name); return v && v.entity.toLowerCase(); };
  const span = (o) => { if (tile.colspan) o.colspan = tile.colspan; if (tile.rowspan) o.rowspan = tile.rowspan; return o; };
  if (tile.type === 'chart') {
    return span({ type: 'chart', name: tile.name || tile.chart, targetEntity: tile.entity ? tile.entity.toLowerCase() : viewEntity(tile.view),
      viewId: result.created.views[tile.view], visualizationId: result.created.charts[tile.chart] });
  }
  if (tile.type === 'list') {
    return span({ type: 'list', name: tile.name || tile.view, targetEntity: tile.entity ? tile.entity.toLowerCase() : viewEntity(tile.view), viewId: result.created.views[tile.view] });
  }
  if (tile.type === 'iframe') return span({ type: 'iframe', name: tile.name, url: tile.url });
  return span({ type: 'webresource', name: tile.name, webResourceName: tile.webResource });
}

// Command-bar locations (CommandBarJson.location). MainTab = the entity's form/grid command bar.
const COMMAND_LOCATIONS = new Set(['MainTab', 'HomeTab', 'ContextualTab']);

// Build a command (modern command-bar) artifact for one entity's buttons. Buttons are emitted as
// LOOSE controls in a single empty-title group per location (a real titled group is a separate
// appaction that needs a parent command-bar row the adapter doesn't synthesize for from-scratch
// commands — Dataverse 400s "Group button must have parentappactionid"). Each control gets a GUID
// id with `command` set to the same id (the appactionid). A button with a `library` + `function`
// gets a functional JS on-click action (resolved to the created web-resource id); `hidden`/`disabled`
// set static visibility. Throws if a referenced web resource wasn't created.
function commandDef(entityLogical, cmds, webResources) {
  const byLocation = new Map(); // location -> controls[]
  for (const c of cmds) {
    const location = c.location || 'MainTab';
    const id = randomUUID();
    const control = { id, type: 'Button', label: c.label, command: id };
    if (c.icon) control.icon = c.icon;
    if (c.library && c.function) {
      const wrId = webResources[c.library];
      if (!wrId) throw new Error(`command "${c.label}" references web resource '${c.library}' which wasn't created — declare it in webResources[] and don't skip the web-resources phase`);
      control.action = { type: 'javascript', webResourceId: wrId, functionName: c.function };
      if (c.parameters !== undefined) control.action.parameters = c.parameters;
    }
    if (c.hidden) control.hidden = true;
    if (c.disabled) control.disabled = true;
    if (!byLocation.has(location)) byLocation.set(location, []);
    byLocation.get(location).push(control);
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

class BuildHalt extends Error {
  constructor(message, { phase, code, recoverable = false, cause } = {}) {
    super(message);
    this.name = 'BuildHalt';
    this.phase = phase;
    this.code = code;
    this.recoverable = recoverable;
    this.cause = cause;
  }
}

// A metadata create that fails because the component already exists (the classic re-run
// case). Dataverse answers 409, or 400 with a duplicate-name message. Used to make
// otherwise non-idempotent creates (e.g. alternate keys — the SDK has no key lister) safe
// to re-run: the build skips instead of halting. Kept deliberately narrow so a genuine
// failure (bad key attribute, etc.) still surfaces.
function isAlreadyExists(err) {
  if (!err) return false;
  const status = err.statusCode || err.status || (err.cause && (err.cause.statusCode || err.cause.status));
  if (status === 409) return true;
  const msg = String((err && err.message) || '').toLowerCase();
  return /already exists|duplicate|with the (?:specified|same) name|a key with/.test(msg);
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

// Bounded-concurrency map — parallelize independent ops without flooding Dataverse (which
// raises SQL-deadlock risk). Preserves input order in the result.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function choiceOptions(col) {
  return (col.options || []).map((label, i) => ({ value: 100000000 + i, label }));
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
function entityByLogical(spec, logical) {
  const l = String(logical).toLowerCase();
  return (spec.entities || []).find((e) => e.schemaName.toLowerCase() === l);
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
  if (has('views')) for (const v of spec.views) items.push({ phase: 'views', label: `view "${v.name}" for ${v.entity}` });
  if (has('charts')) for (const c of spec.charts || []) items.push({ phase: 'charts', label: `chart "${c.name}" (${c.chartType}) for ${c.entity}` });
  if (has('forms')) for (const f of spec.forms) {
    const ft = f.formType || 'Main';
    const subs = (f.subgrids || []).map((s) => s.childEntity).join(', ');
    items.push({ phase: 'forms', label: `${ft === 'Main' ? 'form' : `${ft} form`} for ${f.entity}${subs ? ` (sub-grids: ${subs})` : ''}` });
    if ((f.events || []).length) items.push({ phase: 'forms', label: `wire ${f.events.length} event handler(s) on ${f.entity}` });
  }
  if (has('commands')) for (const [entity, cmds] of Object.entries(commandsByEntity(spec))) items.push({ phase: 'commands', label: `command bar for ${entity} (${cmds.length} button(s))` });
  if (has('dashboards')) for (const d of spec.dashboards || []) items.push({ phase: 'dashboards', label: `dashboard "${d.name}" (${(d.tiles || []).length} tile(s))` });
  if (has('app-shell')) items.push({ phase: 'app-shell', label: `app module "${spec.app.name}" + sitemap` });
  if (has('publish') && opts.publish) items.push({ phase: 'publish', label: 'publish customizations' });
  return items;
}

// --- phase builders (pure: spec -> SDK payloads) ---------------------------------------
// Build a saved-query def. `v.filters[]` adds rich conditions ({ attr, op, value?/values? });
// no-value operators (eq-userid, this-week, null, …) omit the value, and in/not-in expand to a
// nested or/and group of eq/ne (the SDK's filter serializer is single-value per condition).
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

function chartDef(spec, ch) {
  const entityLogical = ch.entity.toLowerCase();
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
  const explicit = Array.isArray(f.tabs) || f.layout === 'explicit';
  if (explicit && Array.isArray(f.tabs)) {
    // Honor the authored layout verbatim.
    tabs = f.tabs.map((t, ti) => ({
      name: t.name || `tab_${ti}`, label: t.label || 'General', expanded: true, visible: true,
      sections: (t.sections || []).map((s, si) => {
        const cells = (s.fields || []).map((fl) => { const lg = String(fl).toLowerCase(); return fieldCell(lg, labelFor(lg), requiredFor(lg)); });
        return { name: s.name || `section_${ti}_${si}`, label: s.label || 'Details', visible: true, showLabel: s.showLabel !== false, columns: s.columns || 1, rows: rowsFromCells(cells, s.columns || 1) };
      }),
    }));
  } else {
    // Auto: primary + every scalar column. 2-column when field-heavy (> 6), else 1.
    const cells = [];
    if (entity) {
      cells.push(fieldCell(entity.primaryAttribute.schemaName.toLowerCase(), entity.primaryAttribute.displayName || 'Name', true));
      for (const c of entity.columns || []) { if (!SDK_COLUMN_TYPE[c.type || 'Text']) continue; cells.push(fieldCell(c.schemaName.toLowerCase(), c.displayName || c.schemaName, c.required === true)); }
    }
    const columns = cells.length > 6 ? 2 : 1;
    tabs = [{ name: 'tab_general', label: 'General', expanded: true, visible: true,
      sections: [{ name: 'section_general', label: 'General', visible: true, showLabel: false, columns, rows: rowsFromCells(cells, columns) }] }];
  }

  const formType = f.formType || 'Main';
  // Notes section (opt-in: form.notes or entity.hasNotes) — Main forms only; quick-create /
  // quick-view forms don't host the activity timeline.
  const wantNotes = formType === 'Main' && (f.notes === true || (entity && entity.hasNotes === true));
  if (wantNotes) {
    tabs[0].sections.push({ name: 'section_notes', label: 'Notes', visible: true, showLabel: true, columns: 1, rows: [{ cells: [notesCell()] }] });
  }

  return { entityLogicalName: entityLogical, name: f.name || `${f.entity} form`, formType, status: 'Active', tabs };
}

function appDef(spec, result) {
  const sol = spec.solution;
  const uniqueName = `${sol.publisherPrefix}_${spec.app.name}`.replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const areas = (spec.appShell.areas || []).map((a, ai) => ({ id: `area_${ai}`, title: a.label,
    groups: (a.groups || []).map((g, gi) => ({ id: `group_${ai}_${gi}`, title: g.label,
      subAreas: (g.subAreas || []).map((s, si) => ({ id: `sub_${ai}_${gi}_${si}`, type: 'Entity', entity: s.entity && s.entity.toLowerCase(), title: s.title })) })) }));
  return { name: spec.app.name, uniqueName, description: spec.app.description || '', siteMap: { areas },
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

  const result = { ok: true, created: { entities: {}, relationships: {}, records: {}, webResources: {}, views: {}, charts: {}, forms: {}, commands: {}, dashboards: {}, app: null } };
  const total = plan.length;
  let n = 0;
  const run = async (phase, label, fn, { recoverable = false, skipIf } = {}) => {
    const myN = (n += 1);
    emit({ phase, status: 'start', label, n: myN, total });
    try {
      const out = await fn();
      emit({ phase, status: 'ok', label, n: myN, total });
      return out;
    } catch (err) {
      // Idempotency escape hatch: a create that fails only because the component already
      // exists is a skip, not a halt (used where the SDK offers no check-first lister).
      if (skipIf && skipIf(err)) { emit({ phase, status: 'skip', label: `${label} (exists)`, n: myN, total }); return undefined; }
      emit({ phase, status: 'error', label, n: myN, total, detail: String((err && err.message) || err) });
      throw new BuildHalt(`${phase} failed: ${(err && err.message) || err}`, { phase, code: (err && err.code) || 'sdk-error', recoverable, cause: err });
    }
  };
  const sol = spec.solution;

  // 1. Solution (idempotent; header-less provisioning client).
  if (has('solution')) {
    await run('solution', `solution ${sol.uniqueName}`, async () => {
      const existing = await provision.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${sol.uniqueName}'`, top: 1 });
      if (existing && existing[0]) return;
      let publisherId;
      const pubs = await provision.queryRecords('publisher', { select: ['publisherid'], filter: `customizationprefix eq '${sol.publisherPrefix}'`, top: 1 });
      if (pubs && pubs[0] && pubs[0].publisherid) publisherId = pubs[0].publisherid;
      else publisherId = (await provision.createPublisher({ uniqueName: `${sol.publisherPrefix}publisher`, friendlyName: `${sol.publisherPrefix} publisher`, prefix: sol.publisherPrefix })).id;
      await provision.createSolution({ uniqueName: sol.uniqueName, friendlyName: sol.displayName || sol.uniqueName, publisherId });
    }, { recoverable: true });
  }

  // 2. Data model — idempotent. Discover existing tables/columns/relationships via the SDK
  //    (find*/fetch*), then create only what's missing. Captures entitySetName for every
  //    entity (fresh -> createTable result, existing -> findTables hit).
  const globalChoiceIds = {};
  const statusReasonValues = {}; // { entityLogical: { label: { value, stateCode } } } — captured for sample data
  if (has('data-model')) {
    // 2a. Global option sets (shared choices) — built before columns that bind to them.
    for (const gc of spec.globalChoices || []) {
      await run('data-model', `global choice ${gc.name}`, async () => {
        try {
          const r = await sdk.createGlobalOptionSet({ name: gc.name, displayName: gc.displayName || gc.name, options: (gc.options || []).map((label, i) => ({ value: 100000000 + i, label })) });
          globalChoiceIds[gc.name] = r.metadataId;
        } catch (e) { /* already exists — a fresh column binding falls back to inline options (idempotent global-choice lookup is a follow-up SDK method) */ }
      });
    }
    // 2b. Tables -> columns (all types + customer) -> status reasons -> alternate keys.
    for (const e of spec.entities) {
      const logical = e.schemaName.toLowerCase();
      const hits = await provision.findTables(e.schemaName, { top: 50 });
      const existingTable = (hits || []).find((t) => t.logicalName === logical);
      let existingCols = new Set();
      if (existingTable) {
        emit({ phase: 'data-model', status: 'skip', label: `table ${e.schemaName} (exists — reuse)`, n: (n += 1), total });
        result.created.entities[e.schemaName] = { logicalName: logical, entitySetName: existingTable.entitySetName };
        existingCols = new Set(((await provision.findColumns(logical)) || []).map((c) => c.logicalName));
      } else {
        await run('data-model', `table ${e.schemaName}`, async () => {
          const createOpts = { schemaName: e.schemaName, displayName: e.displayName, pluralName: e.pluralName || `${e.displayName}s`,
            primaryColumnSchemaName: e.primaryAttribute.schemaName, primaryColumnDisplayName: e.primaryAttribute.displayName || 'Name', hasNotes: e.hasNotes === true };
          // AutoNumber the primary/title column when requested (the order number IS the identity).
          if (e.primaryAttribute.autoNumberFormat) createOpts.primaryColumnAutoNumberFormat = e.primaryAttribute.autoNumberFormat;
          const t = await sdk.createTable(createOpts);
          result.created.entities[e.schemaName] = { logicalName: (t.logicalName || logical), entitySetName: t.entitySetName };
        }, { recoverable: true });
      }
      // columns: every buildable column (all scalar types + Customer; Lookup comes from a
      // relationship). Existing ones emit a skip; missing ones are created (parallel, bounded).
      const buildable = (e.columns || []).filter((c) => SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer');
      for (const c of buildable) if (existingCols.has(c.schemaName.toLowerCase())) emit({ phase: 'data-model', status: 'skip', label: `column ${e.schemaName}.${c.schemaName} (exists)`, n: (n += 1), total });
      const toCreate = buildable.filter((c) => !existingCols.has(c.schemaName.toLowerCase()));
      await mapLimit(toCreate, concurrency, (c) => run('data-model', `column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`,
        () => c.type === 'Customer'
          ? sdk.createCustomerColumn(logical, { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, required: REQUIRED(c) })
          : sdk.createColumn(logical, columnOptions(c, globalChoiceIds))));
      // custom status reasons — capture the option value so sample data can set them. IDEMPOTENT:
      // insertStatusValue itself is not (with no explicit Value, Dataverse auto-assigns a NEW value
      // every call, duplicating the reason on a data-model re-run). So we PIN a deterministic value
      // (publisher range 100000000+i, matching how the engine assigns choice/global option values;
      // authors may override via sr.value) and pass it explicitly: a re-run then hits an already-exists
      // error that skipIf turns into a skip (no duplicate), while the value stays captured for sample
      // data. On a fresh insert we overwrite with the server-returned value (authoritative).
      let srIdx = 0;
      for (const sr of e.statusReasons || []) {
        const stateCode = STATE_CODE[sr.state] !== undefined ? STATE_CODE[sr.state] : 0;
        const pinned = typeof sr.value === 'number' ? sr.value : 100000000 + srIdx;
        srIdx += 1;
        (statusReasonValues[logical] = statusReasonValues[logical] || {})[sr.label] = { value: pinned, stateCode };
        await run('data-model', `status reason ${e.schemaName}: ${sr.label}`, async () => {
          const v = await sdk.insertStatusValue(logical, { label: sr.label, stateCode, color: sr.color, value: pinned });
          statusReasonValues[logical][sr.label] = { value: typeof v === 'number' ? v : pinned, stateCode };
        }, { recoverable: true, skipIf: isAlreadyExists });
      }
      // alternate keys — idempotent: the SDK has no key lister, so a re-run that hits an
      // already-exists error is treated as a skip (not a halt) via skipIf.
      for (const k of e.alternateKeys || []) {
        await run('data-model', `alt key ${e.schemaName}.${k.schemaName}`,
          () => sdk.createAlternateKey(logical, { schemaName: k.schemaName, displayName: k.displayName || k.schemaName, keyAttributes: (k.columns || []).map((x) => x.toLowerCase()) }),
          { recoverable: true, skipIf: isAlreadyExists });
      }
    }
    // 2c. Relationships — 1:N and N:N; skip those already present.
    for (const rel of spec.relationships || []) {
      if (rel.type === 'OneToMany') {
        const schema = relationshipSchemaName(rel);
        let exists = false;
        try { exists = ((await provision.fetchEntityMetadata(rel.referenced.toLowerCase())).relationships || []).some((r) => r.schemaName.toLowerCase() === schema.toLowerCase()); } catch { /* just created */ }
        if (exists) { emit({ phase: 'data-model', status: 'skip', label: `relationship ${schema} (exists)`, n: (n += 1), total }); continue; }
        await run('data-model', `relationship 1:N ${rel.referenced}->${rel.referencing}`, () => sdk.createRelationship({ type: 'OneToMany', schemaName: schema, referencedEntity: rel.referenced.toLowerCase(), referencingEntity: rel.referencing.toLowerCase(), lookupSchemaName: rel.lookup.schemaName, lookupDisplayName: rel.lookup.displayName }));
      } else if (rel.type === 'ManyToMany') {
        const schema = rel.schemaName || `${rel.entity1.toLowerCase()}_${rel.entity2.toLowerCase()}`;
        let exists = false;
        try { exists = ((await provision.fetchEntityMetadata(rel.entity1.toLowerCase())).relationships || []).some((r) => r.schemaName.toLowerCase() === schema.toLowerCase()); } catch { /* just created */ }
        if (exists) { emit({ phase: 'data-model', status: 'skip', label: `relationship ${schema} (exists)`, n: (n += 1), total }); continue; }
        await run('data-model', `relationship N:N ${rel.entity1}<->${rel.entity2}`, () => sdk.createRelationship({ type: 'ManyToMany', schemaName: schema, entity1: rel.entity1.toLowerCase(), entity2: rel.entity2.toLowerCase(), intersectEntityName: rel.intersectEntityName }));
      }
    }
  }

  // entity-set resolver: fresh tables cached above; existing ones via fetchEntityMetadata.
  const entitySetCache = {};
  const entitySetFor = async (logical) => {
    const ent = entityByLogical(spec, logical);
    const cached = ent && result.created.entities[ent.schemaName] && result.created.entities[ent.schemaName].entitySetName;
    if (cached) return cached;
    if (!entitySetCache[logical]) entitySetCache[logical] = (await provision.fetchEntityMetadata(logical)).entitySetName;
    return entitySetCache[logical];
  };

  // 3. Sample data (opt-in): topological, $parent -> @odata.bind on the lookup nav prop.
  if (has('sample-data') && sampleData) {
    const createdByEntity = {};
    for (const e of topoOrderEntities(spec)) {
      const records = sampleRecordsFor(spec, e);
      if (!records.length) continue;
      await run('sample-data', `${records.length} record(s) -> ${e.schemaName}`, async () => {
        const entityLogical = e.schemaName.toLowerCase();
        const resolved = resolveSampleRecords(e, records, spec);
        const bodies = [];
        const matchHit = (parentLogical, match) => (createdByEntity[parentLogical] || []).find((h) => Object.entries(match).every(([k, val]) => { const rk = Object.keys(h.raw).find((x) => x.toLowerCase() === k.toLowerCase()); return rk !== undefined && h.raw[rk] === val; }));
        for (let i = 0; i < resolved.length; i++) {
          const raw = records[i];
          const body = Object.assign({}, resolved[i]);
          delete body.$parent; delete body.$parents; delete body.statusReason;
          // Parent lookups — one (`$parent`) or many (`$parents`, e.g. a junction row binding
          // both sides). Each is bound to its relationship's lookup nav property via @odata.bind.
          const parents = [].concat(raw && raw.$parent ? [raw.$parent] : [], (raw && raw.$parents) || []);
          for (const parent of parents) {
            if (!parent || !parent.entity || !parent.match) continue;
            const parentLogical = parent.entity.toLowerCase();
            const hit = matchHit(parentLogical, parent.match);
            const rel = relationshipFor(spec, parent.entity, e.schemaName);
            if (hit && hit.id && rel) body[`${rel.lookup.schemaName}@odata.bind`] = `/${await entitySetFor(parentLogical)}(${hit.id})`;
          }
          // Custom status reason -> statecode + the captured statuscode option value. The
          // value is captured during the data-model phase (insertStatusValue); if that phase
          // was skipped this run, the value is unknown — halt loudly instead of silently
          // inserting the record with a default status (the live foot-gun behind this guard).
          if (raw && raw.statusReason) {
            const sv = (statusReasonValues[e.schemaName.toLowerCase()] || {})[raw.statusReason];
            if (!sv) throw new Error(`record sets statusReason '${raw.statusReason}' on ${e.schemaName}, but its status value wasn't captured — include the data-model phase (don't --skip data-model) so the custom status reason is created and its option value captured`);
            body.statuscode = sv.value; body.statecode = sv.stateCode;
          }
          bodies.push(body);
        }
        const ids = await sdk.createRecordsBulk(entityLogical, bodies);
        result.created.records[e.schemaName] = ids;
        createdByEntity[entityLogical] = records.map((raw, i) => ({ raw, id: ids[i] })).filter((p) => p.id != null);
      });
    }
  }

  // 3b. Web resources (opt-in via spec.webResources) — JS/HTML/CSS shipped for form logic.
  //     Idempotent: an existing web resource of the same name is reused (and assumed already
  //     in the solution). Built before forms so a form event handler can bind its library.
  if (has('web-resources')) {
    for (const wr of spec.webResources || []) {
      const existing = await provision.queryRecords('webresource', { select: ['webresourceid'], filter: `name eq '${wr.name}'`, top: 1 });
      if (existing && existing[0] && existing[0].webresourceid) {
        result.created.webResources[wr.name] = existing[0].webresourceid;
        emit({ phase: 'web-resources', status: 'skip', label: `web resource ${wr.name} (exists — reuse)`, n: (n += 1), total });
        continue;
      }
      await run('web-resources', `web resource ${wr.name} (${wr.type || 'js'})`, async () => {
        const r = await provision.createWebResource(webResourceOpts(wr, opts.appDir));
        result.created.webResources[wr.name] = r.id;
        await provision.addSolutionComponent({ componentId: r.id, componentType: COMPONENT_TYPE.webResource, solutionUniqueName: sol.uniqueName });
      });
    }
  }

  // helper: create an artifact header-less, push, add to the solution.
  const buildArtifact = (type, def) => run(type === 'app' ? 'app-shell' : `${type}s`, `${type} "${def.name}"`, async () => {
    const art = provision.createArtifact(type, def);
    if (type === 'form' && def.__subgrids) for (const sg of def.__subgrids) provision.addSubGrid(art.id, sg);
    const pushed = await provision.pushArtifact(type, art.id);
    await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE[type], solutionUniqueName: sol.uniqueName });
    return pushed.id;
  });

  // 4. Views (independent -> parallel).
  if (has('views')) {
    const ids = await mapLimit(spec.views, concurrency, (v) => buildArtifact('view', viewDef(spec, v)));
    spec.views.forEach((v, i) => { result.created.views[v.name] = ids[i]; });
  }

  // 5. Charts (independent -> parallel; built before forms so a form could reference one).
  if (has('charts')) {
    const charts = spec.charts || [];
    const ids = await mapLimit(charts, concurrency, (c) => buildArtifact('chart', chartDef(spec, c)));
    charts.forEach((c, i) => { result.created.charts[c.name] = ids[i]; });
  }

  // 6. Forms (independent -> parallel; sub-grids reference the child view ids built above).
  //    A form with `events[]` then gets its JS handlers wired: fetch the pushed form (to
  //    retain its formxml), inject onload/onsave/onchange handlers, push + publish.
  if (has('forms')) {
    const defs = spec.forms.map((f) => {
      const def = formDef(spec, f);
      def.__subgrids = (f.subgrids || []).map((sg) => {
        // A sub-grid can hang off a 1:N (child has the lookup) or an N:N (intersect) relationship.
        const oneToMany = relationshipFor(spec, f.entity, sg.childEntity);
        const nn = oneToMany ? null : manyToManyFor(spec, f.entity, sg.childEntity);
        if (!oneToMany && !nn) return null;
        const relationshipName = oneToMany ? relationshipSchemaName(oneToMany) : manyToManySchemaName(nn);
        const childLogical = sg.childEntity.toLowerCase();
        let viewId = sg.view && result.created.views[sg.view];
        if (!viewId) { const cv = (spec.views || []).find((v) => v.entity.toLowerCase() === childLogical); viewId = cv && result.created.views[cv.name]; }
        return { entity: childLogical, relationshipName, viewId, label: sg.label || sg.childEntity };
      }).filter(Boolean);
      return { f, def };
    });
    const ids = await mapLimit(defs, concurrency, async (d) => {
      const id = await buildArtifact('form', d.def);
      const events = (d.f.events || []).filter((ev) => FORM_EVENTS.has(ev.event) && ev.library && ev.function);
      if (events.length) {
        await run('forms', `wire ${events.length} event handler(s) on ${d.f.entity}`, async () => {
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
  }

  // 6b. Commands (modern command-bar buttons). One command artifact per entity; a button with a
  //     library+function gets a functional JS on-click action bound to the created web resource.
  //     Pushed via the workspace-owning `provision` client (the appaction lands in the Default
  //     solution — it's not a standard solution-component type — but is entity-scoped so it shows
  //     on the entity's command bar in the app regardless).
  if (has('commands')) {
    for (const [entityLogical, cmds] of Object.entries(commandsByEntity(spec))) {
      await run('commands', `command bar for ${entityLogical} (${cmds.length} button(s))`, async () => {
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
      await run('dashboards', `dashboard "${dash.name}" (${(dash.tiles || []).length} tile(s))`, async () => {
        const art = provision.createArtifact('dashboard', { name: dash.name });
        for (const tile of dash.tiles || []) provision.addDashboardTile(art.id, dashboardTileOpts(spec, tile, result));
        const pushed = await provision.pushArtifact('dashboard', art.id);
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.dashboard, solutionUniqueName: sol.uniqueName });
        result.created.dashboards[dash.name] = pushed.id;
      });
    }
  }

  // 7. App module + sitemap.
  if (has('app-shell')) {
    result.created.app = await buildArtifact('app', appDef(spec, result.created));
  }

  // 8. Publish (opt-in). Publish ONE artifact per entity (covers that entity's customizations)
  //    + the app — far fewer PublishXml round-trips than publishing every artifact.
  if (has('publish') && publish) {
    await run('publish', 'publish customizations', async () => {
      const seen = new Set();
      const perEntity = []; // [type, id] — first artifact found per entity
      for (const f of spec.forms) { const id = result.created.forms[f.entity.toLowerCase()]; if (id && !seen.has(f.entity.toLowerCase())) { seen.add(f.entity.toLowerCase()); perEntity.push(['form', id]); } }
      for (const v of spec.views) { const k = v.entity.toLowerCase(); if (result.created.views[v.name] && !seen.has(k)) { seen.add(k); perEntity.push(['view', result.created.views[v.name]]); } }
      await mapLimit(perEntity, concurrency, ([type, id]) => provision.publishArtifact(type, id));
      if (result.created.app) await provision.publishArtifact('app', result.created.app);
    });
  }

  return result;
}

module.exports = { runSdkBuild, planFor, resolvePhases, PHASES, BuildHalt, SDK_COLUMN_TYPE, viewDef, chartDef, formDef, appDef, webResourceOpts, formEventOpts, WEB_RESOURCE_KINDS, FORM_EVENTS };

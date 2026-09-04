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
const { sha256 } = require('./hash.js');
// normalizePageSource: read the page source from the discriminated `source` field (v2) or the
// legacy top-level `codeFile` (pre-migration). PHASES: canonical ordered phase list — imported
// here so the engine and the stage layer can never drift.
const {
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  lookupColumnsFor,
  childRelationshipsFor,
  relationshipSchemaName,
  manyToManyFor,
  manyToManySchemaName,
  normalizePageSource,
  quickCreateEnabledFor,
  isPlatformIconRef,
  FORM_TYPE_CODE,
  FORM_GUID_RE,
  canonicalPersonaName,
  BUSINESS_RULE_VALUELESS_OPERATORS,
} = require('./app-spec.js');
const { PHASES } = require('./stages.js');
const { topoOrderEntities, entityByLogical } = require('./_graph.js');
const {
  makeRunner,
  requireSuccessfulPush,
  reportPartialPush,
  makeEntitySetResolver,
  provisionSolution,
  provisionDataModel,
  provisionSampleData,
  BuildHalt: _BuildHalt,
  SDK_COLUMN_TYPE: _SDK_COLUMN_TYPE,
} = require('./entity-provision.js');
// Pure App Spec -> canonical SDK intent compiler (new form topology + generic-surface intents).
const {
  compileFormIntent,
  formFieldLogicals,
  firstSectionRowsPointer,
  findFieldCellPointer,
  findFieldCellLocation,
  subgridCellIntent,
  subgridSectionIntent,
  quickViewCellIntent,
  formEventsRegionIntent,
  viewColumnsIntent,
  firstColumnSectionsPointer,
} = require('./artifact-intent.js');
const { makeGenpageCli } = require('./genpage-cli.js');
const { manifestResourceName, buildManifest, serializeManifest, parseManifestBase64, reconcilePageIds } = require('./page-manifest.js');
// MEMBERSHIP authority (the app's live sitemap) + the cross-app shared-page scan. fetchSitemap is
// fail-closed & discriminated (C4); fetchAppsForPages is the only way to prove a generative page is not
// shared, since a genpage has no appmodulecomponent row (Imp5 — grounded live probe).
const { fetchSitemap, fetchAppsForPages } = require('./sitemap-pages.js');
// Structural nav oracle — used in the §9 PAGEREF_ scan/parity/resolve pipeline. `extractNavTargets`
// classifies every generative navigateTo pageId at a REAL call site (never a decoy string / comment GUID).
const { extractNavTargets, navReferencedKeys, navMalformedRefs, resolvePageRefs, navTargetParity } = require('./pageref-resolver.js');
const { selectSummaryTables } = require('./ai-candidates.js');
const { AI_APP_SETTING, resolveAiFlags, featureWantValue, sameSettingValue, resolveAppModuleId, proveAppOverride } = require('./ai-app-settings.js');
const { buildPromptSpec } = require('./ai-prompt.js');
const { odataLit } = require('./odata.js');

// Re-export from entity-provision so the export surface stays unchanged
const BuildHalt = _BuildHalt;
const SDK_COLUMN_TYPE = _SDK_COLUMN_TYPE;

// Dataverse control class ids. The vendored bundle does NOT export the SDK's ControlClassId enum, so
// these stable platform GUIDs are pinned here (matching the SDK's
// @maker-studio/cds-designer-models ControlClassIds) and passed as intent to the generic addElement
// surface — the SDK adapter derives a BOUND FIELD's classId from its attribute type (T4), but a
// notes/subgrid/quick-view control's classId IS the intent, so the caller supplies it.
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E'; // ControlClassId.TimelineControl
const SUBGRID_CLASS_ID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B'; // ControlClassId.SubgridControl
const QUICK_VIEW_CLASS_ID = '5C5600E0-1D6E-4205-A272-BE80DA87FD42'; // ControlClassId.QuickViewControl
// Dashboard tile control class ids (DashboardAdapter TILE_CLASS_ID). chart and list share the grid
// control id; ChartGridMode (Chart vs Grid) disambiguates them.
const TILE_CLASS_ID = {
  chart: 'E7A81278-8635-4D9E-8D4D-59480B391C5B',
  list: 'E7A81278-8635-4D9E-8D4D-59480B391C5B',
  iframe: 'FD2A7985-3187-444E-908D-6624B21F69C0',
  webresource: '9FDF5F91-88B1-47F4-AD53-C11EFC01A01D',
};
// Solution component types. `workflow` is 29 — a business rule is a workflow row (category 2), so it
// is added to the solution under that type, not under a bespoke one.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent
const COMPONENT_TYPE = { view: 26, chart: 59, form: 60, dashboard: 60, webResource: 61, sitemap: 62, app: 80, role: 20, workflow: 29 };

// Web-resource kinds (App Spec `type`) -> SDK createWebResource `type` token. The SDK maps
// the token to the Dataverse webresourcetype code (js=3, html=1, css=2, …).
const WEB_RESOURCE_KINDS = new Set(['js', 'html', 'css', 'xml', 'png', 'jpg', 'gif', 'xsl', 'ico', 'svg', 'resx']);
// Form-event kinds the engine can wire (onload/onsave/onchange) via the /bag/c <events> region.
const FORM_EVENTS = new Set(['onload', 'onsave', 'onchange']);

// The ONLY supported way to author a business rule: the bound member the modern business-rule
// designer itself uses. Named here for the warning text so the operator can search for it, and so a
// rename shows up in one place rather than inside a string.
//
// The vendored SDK writes rules through this member or refuses — it no longer compiles a client-side
// WWF XAML substitute. Environments where the member is undeclared therefore cannot host business
// rules at all; that is a platform-side rollout, not something a spec can work around.
const BUSINESS_RULE_MEMBER = 'Microsoft.Dynamics.CRM.CreateProcessWithWfomJson';

// The per-app setting name that turns on the modern ("new look") shell. Verified live against a real
// organization: `settingdefinition` uniquename `NewLookAlwaysOn`, datatype 2 (boolean), default
// "false". See the app-shell phase for why this one rather than the other new-look definitions.
const NEW_LOOK_SETTING = 'NewLookAlwaysOn';
// The Wave 2 header/navigation refresh (public preview) — a DIFFERENT `settingdefinition` from
// NEW_LOOK_SETTING above. Named here only for the warning message; the value encoding (a Number
// tri-state where ON is '2', not '1') lives in the SDK's setHeaderAndNavigationRefresh, which is
// why the plugin does not write this row by hand.
const HEADER_NAV_SETTING = 'HeaderAndNavigationRefresh';

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
      viewId: tile.viewId || result.created.views[`${targetEntity}|${tile.view}`], visualizationId: tile.visualizationId || result.created.charts[tile.chart] });
  }
  if (tile.type === 'list') {
    return span({ type: 'list', name: tile.name || tile.view, targetEntity, viewId: tile.viewId || result.created.views[`${targetEntity}|${tile.view}`] });
  }
  if (tile.type === 'iframe') return span({ type: 'iframe', name: tile.name, url: tile.url });
  return span({ type: 'webresource', name: tile.name, webResourceName: tile.webResource });
}

// Map a resolved dashboard tile (dashboardTileOpts output) to a canonical DashboardComponent for
// addElement('dashboard', id, '/components', …). The adapter mints the cell/control ids and lays the
// grid out from `position`; the caller supplies the classId (chart/list share the grid control id —
// ChartGridMode disambiguates), the `<parameters>` map, and the placement. Tiles stack vertically
// (one per row in the first section). Param keys match the Dataverse control XML; note that a chart
// tile keys its visualization as `VisualizationId`, NOT `ChartId` — see the comment on that line,
// and `lcid-real-bundle.test.js`, which pushes this exact payload through the real bundle.
function dashboardComponent(t, index) {
  const parameters = {};
  if (t.type === 'chart') {
    // `VisualizationId`, NOT `ChartId`. The platform validates dashboard FormXML against a schema
    // that enumerates the legal children of `<parameters>`, and `ChartId` is not one of them:
    //   The element 'parameters' has invalid child element 'ChartId'. List of possible elements
    //   expected: 'ViewId, IsUserView, ... VisualizationId, ...'
    // A chart tile therefore failed the whole dashboards phase with a 400. Caught by a live build;
    // the mock-based test had asserted the wrong name, so the suite agreed with the bug.
    // `download-model-app.js` already reads `VisualizationId`, so this also makes a dashboard
    // round-trip through download -> rebuild instead of losing its chart binding.
    parameters.TargetEntityType = t.targetEntity; parameters.ViewId = t.viewId;
    parameters.VisualizationId = t.visualizationId; parameters.ChartGridMode = 'Chart';
  } else if (t.type === 'list') {
    parameters.TargetEntityType = t.targetEntity; parameters.ViewId = t.viewId;
    parameters.IsUserView = 'false'; parameters.ChartGridMode = 'Grid'; parameters.RecordsPerPage = '10';
  } else if (t.type === 'iframe') {
    parameters.Url = t.url;
  } else {
    parameters.WebResourceName = t.webResourceName;
  }
  return {
    type: t.type, name: t.name || '', classId: TILE_CLASS_ID[t.type] || TILE_CLASS_ID.webresource,
    position: { tabIndex: 0, columnIndex: 0, sectionIndex: 0, rowIndex: index, cellIndex: 0 },
    colspan: t.colspan || 1, rowspan: t.rowspan || 1, parameters,
  };
}

// Command-bar locations (CommandBarJson.location). MainTab = the entity's form/grid command bar.
const COMMAND_LOCATIONS = new Set(['MainTab', 'HomeTab', 'ContextualTab']);

// What a JS command must be handed so its function can do anything.
//
// `onclickeventjavascriptparameters` is a JSON array of `{type,value}` CrmParameter descriptors. When
// it is null the function is invoked with NO arguments — so the near-universal handler shape
// `function doThing(primaryControl) { primaryControl.getAttribute(...) }` throws on its first
// property access and the button silently does nothing. The error surfaces only in the browser
// console, which is exactly how this shipped unnoticed: the build, the server-side state and
// `--verify` all look perfect.
//
// LIVE-MEASURED from the platform's own maker-authored commands on a real org (the numeric codes are
// not documented in the SDK, which passes the string through verbatim):
//   location 0 (form)   -> [{"type":5}]              e.g. AppCommon.KnowledgeArticle…markInternalOpenDialog
//                                                         …discard, …translateArticle — all type 5
//   location 1 (grid)   -> [{"type":12},{"type":24}] e.g. AppCommon.KnowledgeArticle.GridCommandActions.markInternal
//   location 2 (subgrid)-> [{"type":12}]             e.g. …relateCategoryFromSubGridStandard
// So 5 = PrimaryControl, 12 = SelectedControl, 24 = SelectedControlSelectedItemIds.
//
// MainTab is the form command bar (live-verified: our MainTab buttons deploy with `location` 0).
// HomeTab/ContextualTab are mapped to the grid/subgrid shapes by the same correspondence; those two
// are inferred from the classic ribbon meanings rather than live-verified, so an author who needs
// something else can still override with an explicit `parameters` string.
const COMMAND_DEFAULT_PARAMETERS = {
  MainTab: '[{"type":5,"value":null}]',
  ContextualTab: '[{"type":12,"value":null}]',
  HomeTab: '[{"type":12,"value":null},{"type":24,"value":null}]',
};


// control gets a GUID `id` with `command` set to the same id (the appactionid). A button with a
// `library` + `function` gets a functional JS on-click action bound to the created web resource;
// `hidden`/`disabled` set static visibility. A flyout/split container (type FlyoutAnchor|SplitButton)
// carries `children` instead of an action — the SDK's CommandAdapter synthesizes the required
// intervening Group between a flyout and its buttons (Dataverse forbids a button parented directly
// to a flyout). Throws if a referenced web resource wasn't created.
function buildCommandControl(c, webResources, location = 'MainTab') {
  const id = randomUUID();
  const type = c.type || 'Button';
  const control = { id, type, label: c.label, command: id };
  if (c.icon) control.icon = c.icon;
  if (c.library && c.function) {
    const wrId = webResources[c.library];
    if (!wrId) throw new Error(`command "${c.label}" references web resource '${c.library}' which wasn't created — declare it in webResources[] and don't skip the web-resources phase`);
    control.action = { type: 'javascript', webResourceId: wrId, functionName: c.function };
    // Default the parameters when the author did not say. A JS command with none is handed nothing
    // and cannot act on the record — see COMMAND_DEFAULT_PARAMETERS. An explicit value (including
    // an empty string, for a genuinely argument-less function) always wins.
    control.action.parameters = c.parameters !== undefined
      ? c.parameters
      : (COMMAND_DEFAULT_PARAMETERS[location] || COMMAND_DEFAULT_PARAMETERS.MainTab);
  }
  if (c.hidden) control.hidden = true;
  if (c.disabled) control.disabled = true;
  if ((type === 'FlyoutAnchor' || type === 'SplitButton') && Array.isArray(c.children)) {
    // Children live on the same command bar as their anchor, so they inherit its location.
    control.children = c.children.map((ch) => buildCommandControl(ch, webResources, location));
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
    byLocation.get(location).push(buildCommandControl(c, webResources, location));
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

/** Resolve --only/--skip/--from/--to into the ordered set of phases to run. Rejects unknown
 *  phase names (a typo previously ran a surprising/empty subset — from/to indexOf(-1) was a no-op). */
function resolvePhases({ only, skip, from, to } = {}) {
  const known = new Set(PHASES);
  const named = [from, to, ...[].concat(only || []), ...[].concat(skip || [])].filter(Boolean);
  const bad = [...new Set(named.filter((p) => !known.has(p)))];
  if (bad.length) throw new Error(`unknown phase(s): ${bad.join(', ')} (valid: ${PHASES.join(', ')})`);
  let active = PHASES.slice();
  if (from) { const i = active.indexOf(from); active = active.slice(i); }
  if (to) { const i = active.indexOf(to); active = active.slice(0, i + 1); }
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
      if (quickCreateEnabledFor(spec, e)) items.push({ phase: 'data-model', label: `enable quick create on ${e.schemaName.toLowerCase()}` });
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
  if (has('business-rules')) for (const r of spec.businessRules || []) items.push({ phase: 'business-rules', label: `business rule "${r.name}" on ${r.entity}` });
  if (has('commands')) for (const [entity, cmds] of Object.entries(commandsByEntity(spec))) items.push({ phase: 'commands', label: `command bar for ${entity} (${cmds.length} button(s))` });
  if (has('dashboards')) for (const d of spec.dashboards || []) items.push({ phase: 'dashboards', label: `dashboard "${d.name}" (${(d.tiles || []).length} tile(s))` });
  if (has('app-shell')) items.push({ phase: 'app-shell', label: `app module "${spec.app.name}" + sitemap` });
  if (has('app-shell') && !(spec.app && spec.app.icon)) items.push({ phase: 'app-shell', label: `app icon (generated) ${appUniqueName(spec)}_icon` });
  if (has('pages')) for (const p of spec.pages || []) items.push({ phase: 'pages', label: `page "${p.name}"` });
  if (has('pages') && (spec.pages || []).length && appHasCrossPageNav(spec)) items.push({ phase: 'pages', label: 'resolve cross-page navigation' });
  if (has('pages') && (spec.pages || []).length) items.push({ phase: 'pages', label: `page manifest ${appUniqueName(spec)}_pagemanifest` });
  if (has('pages') && (spec.pages || []).length && appHasPageSubareas(spec)) items.push({ phase: 'pages', label: 'finalize sitemap (genpage subareas)' });
  if (has('ai-features') && spec.ai !== undefined && spec.ai !== null) {
    items.push({ phase: 'ai-features', label: 'enable app AI features' });
    // Do NOT short-circuit on `summaries.default === 'off'`. `selectSummaryTables` already implements
    // the documented semantics — `default` is the app-level DEFAULT and `tables[x].enabled: true` is
    // a per-table OVERRIDE that wins over it — and bailing here made that opt-in branch unreachable,
    // silently dropping a summary the author explicitly asked for.
    for (const logical of selectSummaryTables(spec)) {
      items.push({ phase: 'ai-features', label: `row summary for ${logical}` });
    }
  }
  if (has('security')) for (const p of spec.personas || []) {
    const n = (p.jobs || []).length;
    items.push({ phase: 'security', label: `security role "${p.persona}" (${n} job${n === 1 ? '' : 's'})` });
  }
  // Form role assignment is planned under `security` (not `forms`) because it can only run once the
  // roles exist — see the 7b block in the engine for why.
  if (has('security')) for (const f of spec.forms || []) {
    if (f && f.securityRoles) items.push({ phase: 'security', label: `form roles for ${f.name || f.formType || 'Main'} on ${f.entity}` });
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
  // createdViews is keyed by `entity|name` (see the views build step). The sub-grid's view lives on the
  // CHILD entity, so scope the lookup to childLogical to avoid a same-named view on another entity.
  if (sg.view && createdViews[`${childLogical}|${sg.view}`]) return createdViews[`${childLogical}|${sg.view}`];
  const cv = (spec.views || []).find((v) => v.entity.toLowerCase() === childLogical);
  if (cv && createdViews[`${childLogical}|${cv.name}`]) return createdViews[`${childLogical}|${cv.name}`];
  const rows = await provision.queryRecords('savedquery', {
    select: ['savedqueryid', 'isdefault'],
    filter: `returnedtypecode eq '${odataLit(childLogical)}' and querytype eq 0`,
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
  return { name: v.name, description: String(v.description || '').trim(), entityLogicalName: entityLogical, queryType: 0, isDefault: false, columns: cols,
    filters: { type: 'and', conditions, groups },
    sort: (v.sort || []).map((s) => ({ attribute: String(s.attr).toLowerCase(), descending: s.dir === 'desc' })) };
}

// Pick a "good" default-view column set: the primary name column plus up to DEFAULT_VIEW_MAX_EXTRA
// meaningful declared columns (in declared order), skipping wide/opaque types that read poorly in a
// grid. Used to enrich the auto-generated "Active/Inactive <Entity>" views (which ship with only
// the primary column).
//
// #7 (drop "Created On" from enriched default views): this set only ever contains declared spec
// columns (primary + scalars + relationship lookups) — never the stock `createdon`. The vendored
// SDK's enrichDefaultViews REPLACES the view's /columns with this array and then reconciles the
// fetchxml + grid to exactly this set (removing the Dataverse-shipped createdon cell/attribute), so
// the enriched default views ship without Created On. See cds-maker-sdk view serializer f3()/v3().
const DEFAULT_VIEW_MAX_EXTRA = 6;
const DEFAULT_VIEW_SKIP_TYPES = new Set(['Memo', 'File', 'Image']);
function defaultViewColumns(spec, entity, opts = {}) {
  const primary = entity.primaryAttribute.schemaName.toLowerCase();
  const includeLookups = opts.includeLookups !== false;
  // #2 / Gap 6: parent lookups are the key "which parent?" columns and must NOT be truncated by the cap
  // (before, scalars filled the cap first and a lookup-heavy table dropped its parent links). Reserve the
  // lookups' slots up front so scalar columns fill only the REMAINING budget, then always append every
  // lookup. Teardown passes { includeLookups:false } to get the lookup-free reset set (a lookup column on
  // an un-deletable default view would otherwise block the relationship's delete), so no slots are
  // reserved on that path and scalars fill the full cap.
  const lookups = includeLookups ? lookupColumnsFor(spec, entity.schemaName.toLowerCase()) : [];
  const scalarBudget = Math.max(0, DEFAULT_VIEW_MAX_EXTRA - lookups.length);
  const picked = [{ name: primary, width: 300, order: 0 }];
  const chosen = new Set([primary]);
  for (const c of entity.columns || []) {
    if (picked.length - 1 >= scalarBudget) break; // -1: exclude the primary from the extra-column count
    const logical = c.schemaName.toLowerCase();
    if (chosen.has(logical)) continue;
    if (DEFAULT_VIEW_SKIP_TYPES.has(c.type)) continue;
    chosen.add(logical);
    picked.push({ name: logical, width: 150, order: picked.length });
  }
  for (const lk of lookups) {
    if (chosen.has(lk.logical)) continue;
    chosen.add(lk.logical);
    picked.push({ name: lk.logical, width: 150, order: picked.length });
  }
  return picked;
}
// #5: resolve a sub-grid's display TITLE. An explicit `sg.label` wins; otherwise a sub-grid is a LIST
// of children, so the child entity's plural display name reads best ("Tickets"), then its singular
// display name, then the child logical name as a last resort. Pure (no I/O) so the eval harness and
// the forms phase share ONE definition instead of drifting.
function subgridLabel(spec, sg) {
  if (sg.label) return sg.label;
  const child = entityByLogical(spec, String(sg.childEntity || '').toLowerCase());
  return (child && (child.pluralName || child.displayName)) || sg.childEntity;
}
// True when a table has enough declared columns to make enriching its default views worthwhile
// (opt out per-entity with enrichDefaultViews:false).
//
// `existing: true` tables are excluded outright. Enrichment REPLACES the Active/Inactive views'
// column set, and `existing` means "this build did not create this table and cannot prove it owns
// it" — the same reasoning that stops teardown from deleting such a table. Rewriting another app's
// default views is destructive and unrecoverable from here, whereas leaving them alone costs
// nothing. This matters most for a `download -> rebuild` round trip: `download-model-app` flags
// every recovered table `existing: true` precisely because ownership is unprovable.
function enrichesDefaultViews(spec, entity) {
  if (!entity) return false;
  // An `existing: true` table is excluded UNLESS the author explicitly opts in. Enrichment REPLACES
  // the Active/Inactive views' column set, and `existing` means this build did not create the table
  // and cannot prove it owns it — the same reasoning that stops teardown from deleting it. Rewriting
  // another app's default views is destructive and unrecoverable from here. This matters most for a
  // `download -> rebuild` round trip: `download-model-app` flags every recovered table `existing`
  // precisely because ownership is unprovable.
  //
  // `enrichDefaultViews: true` is honoured as a deliberate override, because judging "this reused
  // table really is mine" is exactly the call an author can make and this code cannot.
  if (entity.existing === true && entity.enrichDefaultViews !== true) return false;
  return entity.enrichDefaultViews !== false && defaultViewColumns(spec, entity).length >= 2;
}

// Resolve the id of an EXISTING deployed form to reconcile, disambiguating by TYPE (form names are unique
// only per (entity, type)). Returns the formid, or null when the form isn't deployed yet (→ a fresh create).
// Shared by the build's form phase AND the preflight op-diff discovery so both agree on the target.
//   - `def.formId` set → resolve by id (the escape hatch for the residual same-(entity, type, name)
//     collision, e.g. two Main forms both named "Information"). Validated as a GUID because it is
//     interpolated UNQUOTED into an Edm.Guid OData filter, and confirmed to belong to the same table — so a
//     malformed / stale / foreign id fails loud instead of silently reconciling the wrong form.
//   - else → query systemform by (objecttypecode, name, type eq <code>). A `formType:"Main"` edit thus
//     matches ONLY the Main form; same-named Quick View / Card siblings never block it. >1 match (two forms
//     share entity+type+name) throws an ACTIONABLE error telling the author to pin forms[].formId — we
//     refuse to guess rather than reconcile an arbitrary form (fail-closed).
async function resolveExistingFormId(provision, def) {
  if (def.formId) {
    if (!FORM_GUID_RE.test(String(def.formId))) throw new Error(`form "${def.name}": formId '${def.formId}' is not a valid GUID`);
    const rows = await provision.queryRecords('systemform', { select: ['formid', 'objecttypecode', 'type', 'name'], filter: `formid eq ${def.formId}`, top: 1 });
    const row = rows && rows[0];
    // A pinned id names an EXISTING form to reconcile. If it's ABSENT this is a stale/wrong pin, NOT a
    // create trigger — returning null would drop to the create path and mint a NEW form on EVERY rerun
    // (the pin stays in the spec), silently accumulating duplicate forms (Sol review). Fail loud instead.
    if (!row) throw new Error(`form "${def.name}": pinned formId ${def.formId} does not exist on this environment — remove the pin to create a new form, or correct the id`);
    // The pin must point at the SAME (table, type, name) the spec intends. reconcileForm blindly pushes the
    // spec layout onto whatever id it gets, so a wrong pin (a Quick View id under formType:"Main", a form on
    // another table, or an unrelated form) would CORRUPT that form. The pin's only legitimate use — two
    // forms with identical (entity, type, name) — matches all three, so validating all three never rejects
    // a valid pin, only a mistaken one (Opus + Sol review).
    const wantType = FORM_TYPE_CODE[def.formType || 'Main'];
    if (String(row.objecttypecode).toLowerCase() !== String(def.entityLogicalName).toLowerCase()) {
      throw new Error(`form "${def.name}": formId ${def.formId} belongs to table '${row.objecttypecode}', not '${def.entityLogicalName}'`);
    }
    if (wantType != null && row.type != null && Number(row.type) !== wantType) {
      throw new Error(`form "${def.name}": formId ${def.formId} is a type-${row.type} form but the spec declares formType "${def.formType || 'Main'}" (type ${wantType}) — pin a form of the matching type`);
    }
    if (row.name != null && String(row.name).toLowerCase() !== String(def.name).toLowerCase()) {
      throw new Error(`form "${def.name}": formId ${def.formId} is named '${row.name}', not '${def.name}' — pin the form whose name matches the spec`);
    }
    return String(row.formid);
  }
  const typeCode = FORM_TYPE_CODE[def.formType || 'Main'];
  // A known formType always maps to a code; an unknown one falls back to a name-only match (no worse than
  // the old behavior, and authored formType is lint-constrained to Main/QuickCreate/QuickView anyway).
  const typeFilter = typeCode != null ? ` and type eq ${typeCode}` : '';
  let rows;
  try {
    rows = await provision.queryRecords('systemform', {
      select: ['formid'],
      filter: `objecttypecode eq '${odataLit(def.entityLogicalName)}' and name eq '${odataLit(def.name)}'${typeFilter}`,
      top: 2,
    });
  } catch (err) {
    // A brand-new table isn't in the metadata cache yet, so filtering `objecttypecode eq '<t>'` 400s with
    // "The entity with a name = '<t>' ... was not found in the MetadataCache". A form on a table that does
    // not exist definitionally does not exist, so treat this as NOT FOUND (→ build creates it, preflight
    // has nothing to prune, teardown nothing to delete) — mirroring the SDK findArtifact this replaced,
    // which swallowed it. This must NOT swallow a transient/real failure: re-throw anything else so the
    // fail-closed preflight still refuses to write when it truly can't verify safety.
    // Dataverse error shape: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors#parse-errors-from-the-response
    if (err && /not found in the MetadataCache/i.test(String(err.message || ''))) return null;
    throw err;
  }
  if (!rows || !rows.length) return null;
  if (rows.length > 1) {
    throw new Error(`form "${def.name}" (${def.formType || 'Main'}) on ${def.entityLogicalName}: ${rows.length} forms share this table, type, and name — pin the exact one with forms[].formId (e.g. "${rows[0].formid}")`);
  }
  return String(rows[0].formid);
}

// The identity query that finds an already-built artifact so a re-run or a retry-after-partial-failure
// REUSES it instead of creating a duplicate. These artifact types (savedquery/savedqueryvisualization/
// systemform) are otherwise always-create — the root of the "16 copies of everything" duplication. Forms
// additionally scope by TYPE (see FORM_TYPE_CODE — a name is unique only per (entity, type)). Returns null
// for types without a stable identity query.
function artifactIdentityQuery(type, def) {
  const name = odataLit(def.name);
  const entity = odataLit(def.entityLogicalName);
  switch (type) {
    case 'view': return { set: 'savedquery', idField: 'savedqueryid', filter: `returnedtypecode eq '${entity}' and name eq '${name}'` };
    case 'chart': return { set: 'savedqueryvisualization', idField: 'savedqueryvisualizationid', filter: `primaryentitytypecode eq '${entity}' and name eq '${name}'` };
    case 'form': {
      // Scope by type when the formType is known so a Main-form identity never collides with a same-named
      // Quick View / Card. An unknown/absent formType falls back to name-only (back-compat).
      const t = FORM_TYPE_CODE[def.formType];
      return { set: 'systemform', idField: 'formid', filter: `objecttypecode eq '${entity}' and name eq '${name}'${t != null ? ` and type eq ${t}` : ''}` };
    }
    // The app is keyed by its (deterministic) unique name. Reusing it on a re-run avoids a duplicate
    // appmodule (Dataverse 400s on a duplicate uniquename). NOTE: reuse does not re-push the sitemap,
    // so a genuine app EDIT must go through the download->hydrate->update flow, not a bare re-run.
    case 'app': return { set: 'appmodule', idField: 'appmoduleid', filter: `uniquename eq '${odataLit(def.uniqueName)}'` };
    default: return null;
  }
}

function chartDef(spec, ch) {  const entityLogical = ch.entity.toLowerCase();
  return { name: ch.name, description: String(ch.description || '').trim(), entityLogicalName: entityLogical, chartType: ch.chartType, isDefault: false,
    series: [{ attribute: `${entityLogical}id`, aggregate: ch.measure || 'count' }],
    categories: [{ attribute: String(ch.groupBy).toLowerCase() }], presentation: { showLegend: true, title: ch.name } };
}

// Form intent construction (compileFormIntent), field cells, notes cells, row grouping, and
// formFieldLogicals now live in the pure ./artifact-intent.js compiler (new SDK topology
// tabs[].columns[].sections[]). The engine imports them at the top of this file.

// Build a Main-form definition -> moved to ./artifact-intent.js `compileFormIntent`
// (new SDK topology tabs[].columns[].sections[]; the adapter derives classId/label per T4).


// The ordered field logical names a form places -> moved to ./artifact-intent.js `formFieldLogicals`
// (walks the new tabs[].columns[].sections[] topology).

// The app module's uniquename. A DOWNLOADED/edit spec carries the app's REAL, immutable uniquename in
// `spec.app.uniqueName` — return it VERBATIM so the build's existing-app lookup (findArtifact) AND teardown
// resolve the SAME deployed app even after a display-name RENAME. A Dataverse appmodule uniquename never
// changes once created, so deriving it from the MUTABLE display name would miss the existing app on a
// rebuild and CREATE A DUPLICATE (Sol review). An AUTHORED create-fresh spec has no `app.uniqueName`, so
// derive it deterministically from the publisher prefix + display name — the exact rule the builder creates
// with. Shared with the teardown engine so both agree on the identity.
function appUniqueName(spec) {
  if (spec.app && spec.app.uniqueName) return String(spec.app.uniqueName);
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

// Read the durable page manifest (`<appUnique>_pagemanifest`). Looked up by NAME via queryRecords
// (getWebResource needs the GUID we don't have yet). content is base64; `text` is the decoded serialized
// content, used by persist's content-dedup. Returns a DISCRIMINATED shape (Imp11 / addenda new-2):
//   present:false — the web resource is ABSENT (a fresh app, or never authored pages). manifest is null;
//                   the caller reconciles as "no identity" and creates pages. NOT a corrupt state.
//   present:true  — the web resource EXISTS with non-empty content. manifest is the parsed payload, OR
//                   null when the content fails to parse — a CORRUPT manifest. The caller MUST HALT
//                   fail-closed (`pages-manifest-corrupt`) rather than treat a corrupt payload as "no
//                   identity → recreate", which would orphan the real (still-live) pages.
// An empty/whitespace content row is treated as ABSENT (present:false): there is nothing to parse and
// nothing corrupt, so it must not trigger the corrupt HALT — but we keep `id` so persist reuses the row.
async function readPageManifest(provision, appUnique) {
  const name = manifestResourceName(appUnique);
  const rows = await provision.queryRecords('webresource', { select: ['webresourceid', 'content'], filter: `name eq '${odataLit(name)}'`, top: 1 });
  const wr = rows && rows[0];
  if (!wr) return { id: undefined, manifest: null, text: undefined, present: false };
  const hasContent = typeof wr.content === 'string' && wr.content.length > 0;
  const text = hasContent ? Buffer.from(wr.content, 'base64').toString('utf8') : undefined;
  return { id: wr.webresourceid, manifest: parseManifestBase64(wr.content), text, present: hasContent };
}

// Create or UPDATE the durable page manifest and (idempotently) re-assert its solution membership EVERY
// run (design §7.3). CONTENT-DEDUP: the write is SKIPPED when the manifest already holds exactly `content`
// (== lastContent). Called immediately after EVERY page create (crash-safety, C5) AND once at the end;
// dedup means a single-page first build issues one create + zero updates, an N-new-page first build one
// create + (N-1) updates, and a no-op final persist. Stored as type 'js' (webresourcetype 3): there is no
// 'json' web-resource kind and 'js' round-trips arbitrary text unchanged. Returns { id, content } for the
// next call. Stable 7-arg signature (Tasks 5 + 8).
async function persistPageManifest(provision, spec, keyToId, sol, appUnique, existingId, lastContent) {
  const name = manifestResourceName(appUnique);
  const content = serializeManifest(buildManifest(spec, keyToId));
  let id = existingId;
  if (content !== lastContent) {
    if (id) await provision.updateWebResource(id, { content });
    else { const r = await provision.createWebResource({ name, displayName: `${spec.app.name} Page Manifest`, type: 'js', content }); id = r.id; }
  }
  if (id) await provision.addSolutionComponent({ componentId: id, componentType: COMPONENT_TYPE.webResource, solutionUniqueName: sol.uniqueName });
  return { id, content };
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

// True when any page declares cross-page navigation. Deterministic from the spec, so planFor can plan
// the single "resolve cross-page navigation" step without runtime state.
function appHasCrossPageNav(spec) {
  return ((spec && spec.pages) || []).some((p) => (p.navigatesTo || []).length > 0);
}

// Write a RESOLVED deployment copy of a page's .tsx into the run-scoped staging dir — NEVER over the
// canonical source (a GUID baked into canonical breaks cross-env recreate; design §9 / SDK T5). pac
// genpage upload takes a file PATH, so resolved bytes must exist on disk. The dir is created per RUN
// under <workspace>/.pageref-deploy/<runId>/ and removed in a finally (never leave env GUIDs on disk,
// no sanitized-name cross-run collision). The key is sanitized to a safe filename.
function writeStagingFile(stagingDir, key, code) {
  fs.mkdirSync(stagingDir, { recursive: true });
  const file = path.join(stagingDir, `${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}.tsx`);
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

// SINGLE-MACHINE advisory lockfile over the pages protocol (design §9 / review R2 Critical 3, DESCOPED).
// A courtesy to stop two LOCAL builds of the same app racing to CREATE duplicate pages; correctness does
// NOT depend on it — the convergence spine (fail-closed enumeration + create-absent-first + persist-after-
// each-create) makes any re-run idempotent. Atomic exclusive create picks one winner; if the lock already
// exists we HALT (never steal, no age-reclaim). Release is OWNER-CHECKED: remove only if the file still
// holds OUR exact token. Cross-machine/worktree concurrency for the SAME app is UNSUPPORTED. `deps` = seam.
function acquireAppPagesLease(wsDir, appUnique, deps = {}) {
  const now = deps.now || (() => Date.now());
  fs.mkdirSync(wsDir, { recursive: true });
  const lockPath = path.join(wsDir, `pages-${String(appUnique).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`);
  const token = JSON.stringify({ pid: process.pid, at: now() });
  try {
    fs.writeFileSync(lockPath, token, { flag: 'wx' }); // atomic exclusive create — the OS guarantees one winner
  } catch (e) {
    if (e.code === 'EEXIST') throw new BuildHalt(`another build is deploying pages for '${appUnique}' — refusing a second concurrent pages deploy (would risk duplicate page creation). Retry after it finishes, or delete ${lockPath} if it is stale.`, { phase: 'pages', code: 'pages-locked', recoverable: true });
    throw e;
  }
  // Owner-checked release: never delete a lock a DIFFERENT live build now holds. No age-reclaim/steal.
  return { release: () => { try { if (fs.readFileSync(lockPath, 'utf8') === token) fs.rmSync(lockPath, { force: true }); } catch { /* gone/unreadable — best-effort */ } } };
}

function appDef(spec, result, opts = {}) {
  const sol = spec.solution;
  const uniqueName = appUniqueName(spec);
  // A subarea is an Entity (table) by default, a DashBoard (a built dashboard, by name — the SDK
  // auto-pins its dashboardId as an app component so the nav actually includes it), or a URL.
  const subAreaJson = (s, id) => {
    // Preserve a platform icon path VERBATIM (case-sensitive — an OOB/WebResources path like
    // `/WebResources/.../SitemapIcon/CDSEntity` breaks if lower-cased); lower-case only a BARE local
    // web-resource NAME (Dataverse web-resource names are case-insensitive and the icon lookup
    // lower-cases). This is what lets a downloaded app's entity-subarea icon round-trip unchanged.
    const iconVal = s.icon ? (isPlatformIconRef(s.icon) ? s.icon : String(s.icon).toLowerCase()) : undefined;
    const base = { id, title: s.title, ...(iconVal ? { icon: iconVal } : {}) };
    // Carry a VALID `vectorIcon` on ANY subarea — INCLUDING Entity. Live-probed: the vendored SDK
    // serializes `<SubArea Entity="…" … VectorIcon="/WebResources/<pub>/icons/x.svg">` correctly, and
    // the modern app accepts a path/$webresource VectorIcon on an entity nav entry (the reporter's live
    // app uses one). Previously ALL entity vectorIcons were dropped, silently losing a custom nav icon
    // on every build and breaking the download→build round-trip. We still DROP a BARE Fluent TOKEN on an
    // entity subarea (that specific shape breaks the modern app-designer property pane; validation
    // surfaces it as a warning). Non-entity subareas keep emitting any vectorIcon as before.
    const emitVector = s.vectorIcon && (isPlatformIconRef(s.vectorIcon) || !s.entity);
    const withVector = emitVector ? { ...base, vectorIcon: s.vectorIcon } : base;
    if (s.dashboard) {
      const dashboardId = (result.dashboards || {})[s.dashboard];
      if (!dashboardId) throw new Error(`sitemap subarea "${s.title}" references dashboard '${s.dashboard}' which wasn't built — declare it in dashboards[] and don't skip the dashboards phase`);
      return { ...withVector, type: 'DashBoard', dashboardId };
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
      return { ...withVector, type: 'GenPage', genPageId };
    }
    if (s.url) return { ...withVector, type: 'URL', url: s.url };
    return { ...withVector, type: 'Entity', entity: s.entity && s.entity.toLowerCase() };
  };
  // `appShell` is OPTIONAL to validation (the deploy profile deliberately accepts a spec without
  // one — download and many callers rely on that), but it is NOT optional here: without it there is
  // no sitemap to build. Dereferencing it unguarded produced a bare
  // `Cannot read properties of undefined (reading 'areas')` at this phase, AFTER the solution,
  // tables, columns, views and the generated app icon were already created — a half-built app plus
  // an error naming nothing the author could act on. Fail with the same actionable shape the
  // subarea errors above use.
  if (!spec.appShell || !Array.isArray(spec.appShell.areas)) {
    throw new Error("the spec has no appShell.areas, so the app has no navigation to build — add appShell: { areas: [ { label, groups: [ { label, subAreas: [ { entity: '<table>', title: '<label>' } ] } ] } ] }");
  }
  const areas = (spec.appShell.areas || []).map((a, ai) => ({ id: `area_${ai}`, title: a.label,
    // Same rule as subAreaJson: preserve a platform icon path VERBATIM (case-sensitive OOB/WebResources
    // path); lower-case only a bare local web-resource NAME. Leaving the area icon unconditionally
    // lower-cased would corrupt a round-tripped OOB area icon (now that validation tolerates it).
    ...(a.icon ? { icon: isPlatformIconRef(a.icon) ? a.icon : String(a.icon).toLowerCase() } : {}),
    ...(a.vectorIcon ? { vectorIcon: a.vectorIcon } : {}),
    groups: (a.groups || []).map((g, gi) => ({ id: `group_${ai}_${gi}`, title: g.label,
      subAreas: (g.subAreas || []).map((s, si) => subAreaJson(s, `sub_${ai}_${gi}_${si}`)).filter(Boolean) })) }));
  return { name: spec.app.name, uniqueName, description: spec.app.description || '', siteMap: { areas },
    ...(opts.iconWebResourceId ? { iconWebResourceId: opts.iconWebResourceId } : {}),
    components: { forms: Object.values(result.forms || {}).filter(Boolean), views: Object.values(result.views || {}).filter(Boolean), charts: Object.values(result.charts || {}).filter(Boolean) } };
}

// A business-rule row filter that selects only the DEFINITION, never the platform's activated copy.
//
// LIVE-MEASURED. Activating a business rule makes Dataverse create a SECOND `workflows` row:
//   type=1, parentworkflowid=(none)  -> the definition the author wrote
//   type=2, parentworkflowid=<def>   -> the platform's activated copy of it
// That pair is normal for every activated process, and the vendored SDK's own orphan probe filters
// `category eq 2 and type eq 1` for exactly this reason.
//
// Omitting `type` is not cosmetic: it made the build try to deactivate and delete the activated copy
// (which the platform refuses, 405), emit a false "the SDK created a duplicate" warning, and would
// have made `--verify` fail EVERY active business rule as "duplicated".
//
// category 2 = Business Rule; type 1 = definition, 2 = activated copy.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/workflow
function businessRuleFilter(name, entityLogical) {
  return `category eq 2 and type eq 1 and name eq '${odataLit(name)}' and primaryentity eq '${odataLit(String(entityLogical).toLowerCase())}'`;
}

// The (entity, formType, name) triple the App Spec uses to identify a form. Used to address a form
// from a LATER phase: `forms[].securityRoles` is applied during `security`, because a persona's role
// does not exist until then, and by that point the forms phase has finished and only the entity's
// Main form is reachable through `created.forms`.
//
// `name` is included because one entity may declare several forms of the same type, and the id must
// bind to the form the author annotated rather than to whichever sibling was built last.
function formIdentityKey(f) {
  return `${String(f.entity).toLowerCase()}|${f.formType || 'Main'}|${f.name || ''}`;
}

// Map one App Spec business rule to the SDK's BusinessRuleArtifact shape.
//
// The SDK's condition model is NOT the obvious one, and getting it wrong is SILENT: `updateElement`
// merges unknown keys onto the node, the serializer ignores them, and the push succeeds with a
// workflow object model that references none of the author's columns — a rule that deploys,
// activates, and never fires. So the mapping is explicit and the App Spec shape is validated before
// we get here.
//
//   conditions[] -> rootCondition.clauses[]   (ANDed; `logic: 'AND'`)
//   actions[]    -> rootCondition.trueBranch[]
//
// `valueType` is always `'Value'`: the SDK's other axes (`Field`, `Lookup`, `Expression`, `Clear`)
// need shapes the App Spec does not model, so exposing the name would offer authors a choice they
// cannot use. The App Spec calls the type hint `dataType` rather than the SDK's `valueWorkflowType`,
// because `valueType` already means that other thing here — and note it is currently DECORATIVE:
// measured across every accepted token, on both the condition and the action path, the SDK types
// every literal as String. See BUSINESS_RULE_DATA_TYPES in app-spec.js.
function businessRuleDef(rule) {
  const ids = (prefix) => { let n = 0; return () => `${prefix}${++n}`; };
  const clauseId = ids('c');
  const actionId = ids('a');
  const valueless = (op) => BUSINESS_RULE_VALUELESS_OPERATORS.has(op);
  return {
    name: rule.name,
    entityLogicalName: String(rule.entity).toLowerCase(),
    scope: rule.scope || 'Entity',
    // Omitted when the spec has none, so a rebuild never blanks one added in the maker.
    ...(rule.description ? { description: rule.description } : {}),
    // Draft unless the author asks for Active. A rule is inert until activated, so defaulting to
    // Active is what makes `businessRules[]` do something on the first build.
    status: rule.status || 'Active',
    rootCondition: {
      id: 'r1',
      displayName: rule.name,
      logic: 'AND',
      clauses: (rule.conditions || []).map((c) => ({
        id: clauseId(),
        field: String(c.field).toLowerCase(),
        operator: c.operator,
        valueType: 'Value',
        ...(valueless(c.operator) ? {} : { value: String(c.value), valueWorkflowType: c.dataType || 'String' }),
      })),
      trueBranch: (rule.actions || []).map((a) => {
        const node = { id: actionId(), type: a.type, displayName: a.label || `${a.type} ${a.field}`, field: String(a.field).toLowerCase() };
        if (a.type === 'SetVisibility') node.visible = a.visible;
        else if (a.type === 'LockUnlock') node.lock = a.lock;
        else if (a.type === 'SetBusinessRequired') node.required = a.required;
        else if (a.type === 'SetFieldValue') { node.value = String(a.value); node.valueType = 'Value'; node.valueWorkflowType = a.dataType || 'String'; }
        return node;
      }),
      falseBranch: [],
    },
  };
}

// Map one App Spec persona to the vendored SDK's PersonaRoleSpec (cds-maker-sdk createPersonaRole).
// Pure: spec shape -> SDK shape. Two normalizations:
//   1. `entity` is lower-cased to a Dataverse logical name (the SDK resolves prv* ids from metadata
//      by logical name).
//   2. App-open injection (WHY): the SDK "authors exactly the privileges you declare", so a persona
//      role that only grants table access still cannot OPEN the generated app for a non-admin. Unless
//      the persona opts out (`appAccess:false`), add a read privilege on the `appmodule` table so the
//      role can read the app definition. appmodule is an ORG-owned table, so a valid read depth is
//      Global (`organization`) — a user/BU-scoped read on an org-owned table is not a real depth. The
//      matching app<->role association (which scopes WHICH app appears) is done separately in the
//      security phase via ensureAppAvailableToRole. Both are needed for the app to actually appear.
// The SDK dedupes/unions privileges (max scope wins per entity+access), so an injected appmodule read
// that overlaps an author-declared one is harmless.
function personaRoleSpecFor(persona) {
  const normPriv = (pr) => ({
    entity: String(pr.entity).toLowerCase(),
    access: (pr.access || []).slice(),
    ...(pr.scope ? { scope: pr.scope } : {}),
  });
  const jobs = (persona.jobs || []).map((j) => ({
    name: j.name,
    ...(j.description ? { description: j.description } : {}),
    privileges: (j.privileges || []).map(normPriv),
  }));
  const additional = (persona.additionalPrivileges || []).map(normPriv);
  if (persona.appAccess !== false) {
    additional.push({ entity: 'appmodule', access: ['read'], scope: 'organization' });
  }
  return {
    // Canonical (trimmed) name — the SDK trims before its (name, BU) lookup, so teardown/verify (which
    // key on the same canonical name) and this create call must all agree on the trimmed identity.
    persona: canonicalPersonaName(persona),
    jobs,
    ...(additional.length ? { additionalPrivileges: additional } : {}),
    ...(persona.businessUnitId ? { businessUnitId: persona.businessUnitId } : {}),
    ...(persona.assignTo ? { assignTo: persona.assignTo } : {}),
  };
}

// True when an error from an app<->role `$ref` associate/dissociate means the desired end state already
// holds (associate: the link exists; dissociate: it's already gone), so a re-run is idempotent. Matches
// the vendored SDK's REAL error shapes (verified against scripts/vendor/cds-maker-sdk.cjs), NOT a guessed
// one: a ConnectionError carries `.statusCode` (not `.status`) and the raw Dataverse body on `.cause`
// (its `error.code` is the concrete Dataverse code, e.g. 0x80060891 "duplicate"/0x80040217 "not found");
// a 412 becomes an `SdkError` with code/message `VERSION_CONFLICT`. A bare 400/404 is NOT swallowed
// unless the body/message specifically says duplicate/exists (associate) or not-found (dissociate) — so a
// genuine failure still surfaces. `mode` is 'associate' or 'dissociate'.
function isBenignAssociationError(err, mode) {
  if (!err) return false;
  const status = err.statusCode != null ? err.statusCode : err.status;
  const code = String(err.code || ''); // SdkError code, e.g. 'VERSION_CONFLICT'
  const body = err.cause; // raw Dataverse body on a ConnectionError
  const dvCode = String((body && body.error && body.error.code) || '').toLowerCase();
  const msg = String(err.message || '').toLowerCase();
  if (mode === 'associate') {
    // 412 (precondition) / VERSION_CONFLICT is the "already exists" path; a 400 duplicate carries the
    // duplicate code in the body or an "already exists"/"duplicate" message.
    if (status === 412 || status === 409 || /version_conflict/i.test(code) || /version conflict/.test(msg)) return true;
    return /duplicate|already exists?/.test(msg) || /0x80060891|0x80040237/.test(dvCode) || /duplicate/.test(dvCode);
  }
  // dissociate: a link that is already gone is a 404 / "does not exist" — the desired end state.
  if (status === 404) return true;
  return /does not exist|not found|cannot be found/.test(msg) || /0x80040217/.test(dvCode);
}

// Make the generated app available to a persona role by associating the role to the app module
// (the model-designer "Manage roles" relation). WHY this is required IN ADDITION to the appmodule
// read privilege: prvReadAppModule lets the role read app definitions, but a model-driven app only
// APPEARS for a non-admin when a security role is associated to it (appmoduleroles). Without this the
// persona gets data access but the app never shows in their app list. Idempotent: a re-run re-POSTs the
// same $ref, which Dataverse rejects as a duplicate — swallowed (the link already exists) via the
// SDK-accurate isBenignAssociationError; any other error re-throws. See appmodule N:N `appmoduleroles`:
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule
async function ensureAppAvailableToRole(sdk, appId, roleId) {
  try {
    await sdk.associateRecords('appmodule', appId, { relationshipName: 'appmoduleroles_association', targetEntity: 'role', targetId: roleId });
  } catch (err) {
    if (!isBenignAssociationError(err, 'associate')) throw err;
  }
}

// Reverse of ensureAppAvailableToRole: remove the app<->role association so the app STOPS appearing for
// a persona whose `appAccess` flipped to false. The injected appmodule-read privilege is already removed
// by the role's ReplacePrivileges convergence, but the association is grant-only and would otherwise
// persist — so a role flipped to data-only would still surface the app for a user who has appmodule read
// from any other role. Best-effort + idempotent: a link that's already gone (404) is the desired state.
async function ensureAppNotAvailableToRole(sdk, appId, roleId) {
  if (typeof sdk.disassociateRecords !== 'function') return; // older bundle without dissociate → no-op
  try {
    await sdk.disassociateRecords('appmodule', appId, 'appmoduleroles_association', roleId);
  } catch (err) {
    if (!isBenignAssociationError(err, 'dissociate')) throw err;
  }
}

// Resolve the business unit a persona's role lives in, so role QUERIES (teardown, verify) scope to the
// SAME (name, BU) identity the SDK uses on create (createPersonaRole keys a role by name WITHIN a BU).
// Returns the explicit `businessUnitId`, else the org ROOT business unit (the SDK's own default — a BU
// with no parent), else null when it can't be resolved (caller then falls back to a name-only match:
// best-effort, so a transient BU-lookup failure never blocks teardown/verify). `q` is a queryRecords fn
// (the teardown `sdk` or the verify `read`); `cache` memoizes the root-BU lookup for the run.
async function resolveRoleBusinessUnit(q, businessUnitId, cache = {}) {
  if (businessUnitId && FORM_GUID_RE.test(businessUnitId)) return businessUnitId;
  if (Object.prototype.hasOwnProperty.call(cache, 'rootBu')) return cache.rootBu;
  cache.rootBu = null;
  try {
    if (typeof q === 'function') {
      // Root BU has no parent. Mirrors the vendored SDK's own resolveRootBusinessUnit query.
      const rows = await q('businessunit', { select: ['businessunitid'], filter: '_parentbusinessunitid_value eq null', top: 1 });
      const id = rows && rows[0] && rows[0].businessunitid;
      if (id && FORM_GUID_RE.test(String(id))) cache.rootBu = String(id);
    }
  } catch { /* best-effort: fall back to a name-only match */ }
  return cache.rootBu;
}

// The `_businessunitid_value eq <guid>` OData clause (Edm.Guid is UNQUOTED) that scopes a role query to a
// business unit. Empty string when the BU is unknown (name-only fallback). `bu` is GUID-validated by
// resolveRoleBusinessUnit, so interpolation is injection-safe.
function roleBuClause(bu) {
  return bu && FORM_GUID_RE.test(String(bu)) ? ` and _businessunitid_value eq ${bu}` : '';
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

  const result = { ok: true, created: { entities: {}, relationships: {}, records: {}, webResources: {}, views: {}, charts: {}, forms: {}, formIds: {}, businessRules: {}, commands: {}, dashboards: {}, pages: {}, pageDeployedShas: {}, ai: { appFeatures: null, summaries: {} }, roles: {}, app: null }, skipped: { businessRules: [], aiSummaries: [] } };
  // #changed-only (pages-only fast apply): seed the LIVE app id (discovered by unique name upstream) so the
  // pages phase's `pages-requires-app` guard passes WITHOUT running the app-shell phase in this invocation.
  // The full-build path never sets opts.changedOnly, so result.created.app stays null and app-shell
  // creates/updates it exactly as before — this branch is a no-op (byte-identical) on the normal path.
  if (opts.changedOnly && opts.changedOnly.resolvedAppId) result.created.app = opts.changedOnly.resolvedAppId;
  const runner = makeRunner({ emit, total: plan.length });
  const sol = spec.solution;

  // 1. Solution (idempotent; header-less provisioning client).
  if (has('solution')) await provisionSolution({ sdk, provision, runner, solution: sol });

  // 2. Data model — idempotent. Discover existing tables/columns/relationships via the SDK
  //    (find*/fetch*), then create only what's missing. Captures entitySetName for every
  //    entity (fresh -> createTable result, existing -> findTables hit).
  let dataModel = { entities: {}, globalChoiceIds: {}, statusReasonValues: {}, columns: {}, relationships: [] };
  if (has('data-model')) {
    dataModel = await provisionDataModel({ sdk, provision, runner, spec, apply, languageCode: opts.languageCode, warn: opts.warn, provisionedLanguages: opts.provisionedLanguages, preResolvedLanguageCode: opts.preResolvedLanguageCode });
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
      const existing = await provision.queryRecords('webresource', { select: ['webresourceid'], filter: `name eq '${odataLit(wr.name)}'`, top: 1 });
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

  // --- Form authoring via the SDK's generic surface (addElement/updateElement/removeElement) -------
  // The new SDK removed the per-artifact form mutators; a form is built as canonical intent
  // (./artifact-intent.js) and applied through the generic surface.
  //
  // EVERY read/mutate call below is awaited because the SDK's generic surface is ASYNC as of the
  // upstream "300s cache staleness with async revalidating reads" change: getArtifact, addElement,
  // updateElement, removeElement, moveElement, findElements and queryTree all return Promises now
  // (a read may re-fetch from the server before serving a cached copy). Dropping an `await` here
  // does NOT throw — a Promise is truthy, so the `|| {}` fallbacks stay dormant and the pure
  // helpers below silently see a Promise instead of an artifact (hasSubgrid -> false -> duplicate
  // sub-grid; findFieldCellPointer -> null -> the field is never pruned). That silence is why
  // scripts/tests/sdk-async-surface.test.js scans this file for bare calls.

  // Create a NEW form body: create a MINIMAL form (the adapter seeds one default tab), append each
  // compiled tab (addElement recursively mints cell/section/tab ids — updateElement does NOT, so a
  // coarse whole-tab insert is the adapter-blessed path), then drop the seed tab at index 0. Every
  // intermediate state keeps >=1 tab, so the structural validator never rejects an empty form.
  const createFormShell = async (def) => {
    // `description` is new on forms in this SDK uptake (dashboards, rows in the same systemform
    // table, always had it). Passed only when the spec sets one: omitted on push it is not written,
    // so an existing server-side description survives an edit that did not set one.
    const art = provision.createArtifact('form', { name: def.name, entityLogicalName: def.entityLogicalName, formType: def.formType, status: def.status, ...(def.description ? { description: def.description } : {}) });
    const tabs = def.tabs || [];
    // Sequential (not Promise.all): tab ORDER is the on-form order, and addElement appends.
    for (const tab of tabs) await provision.addElement('form', art.id, '/tabs', tab);
    // Drop the adapter's seed tab (my tabs were appended after it) — but ONLY if I actually added at
    // least one tab, so a degenerate spec with an empty `tabs: []` still leaves the valid seed tab
    // rather than a tab-less form the designer can't open.
    if (tabs.length > 0) await provision.removeElement('form', art.id, '/tabs/0');
    return art.id;
  };

  const normClassId = (id) => String(id || '').replace(/[{}]/g, '').toUpperCase();

  // A form hosts at most one sub-grid per relationship, so a sub-grid's semantic identity is its
  // RelationshipName. Scan the fetched form's controls so a rebuild does not splice a duplicate.
  const hasSubgrid = (formJson, relationshipName) => {
    for (const t of formJson.tabs || []) for (const col of t.columns || []) for (const s of col.sections || []) for (const r of s.rows || []) for (const c of r.cells || []) {
      const ctrl = c.control;
      if (ctrl && normClassId(ctrl.classId) === SUBGRID_CLASS_ID && ctrl.parameters && ctrl.parameters.RelationshipName === relationshipName) return true;
    }
    return false;
  };

  // Add each sub-grid to the form in its OWN full-width (1-column) section (#5), skipping any already
  // present (idempotent rebuild). Re-reads the form between adds so the sections pointer stays valid.
  // A sub-grid used to be spliced as a single cell into the first field section's rows, which rendered
  // it half-width inside a 2-column section; giving it a dedicated section makes the related list span
  // the form. `sg.label` is already resolved to the child's display name by the forms phase.
  const addSubgrids = async (formId, subs) => {
    for (const sg of subs || []) {
      if (hasSubgrid(await provision.getArtifact('form', formId) || {}, sg.relationshipName)) continue;
      const sectionsPtr = firstColumnSectionsPointer(await provision.getArtifact('form', formId) || {});
      if (!sectionsPtr) continue;
      await provision.addElement('form', formId, sectionsPtr, subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: sg.targetEntity, relationshipName: sg.relationshipName, viewId: sg.viewId, label: sg.label }));
    }
  };

  // A quick-view's semantic identity is the lookup field it renders through (one quick-view per lookup).
  const hasQuickView = (formJson, lookupFieldName) => {
    for (const t of formJson.tabs || []) for (const col of t.columns || []) for (const s of col.sections || []) for (const r of s.rows || []) for (const c of r.cells || []) {
      const ctrl = c.control;
      if (ctrl && normClassId(ctrl.classId) === QUICK_VIEW_CLASS_ID && String(ctrl.fieldName || '').toLowerCase() === String(lookupFieldName).toLowerCase()) return true;
    }
    return false;
  };

  // Wire onload/onsave/onchange handlers into the form's root-bag <events> region. First build: the
  // region doesn't exist -> add it whole. Rebuild: MERGE (append only handlers not already present,
  // keyed by event+function+library) so a re-run never duplicates a handler or appends a second
  // <events> root. The adapter mints each handlerUniqueId at serialize (we omit it).
  const wireFormEvents = async (formId, events) => {
    const wanted = (events || []).filter((ev) => FORM_EVENTS.has(ev.event) && ev.library && ev.function);
    if (!wanted.length) return false;
    const form = await provision.getArtifact('form', formId) || {};
    const bagC = (form.bag && form.bag.c) || [];
    const regionIdx = bagC.findIndex((e) => e && e.node && e.node.n === 'events');
    if (regionIdx < 0) {
      const nextI = bagC.reduce((m, e) => Math.max(m, e.i), -1) + 1;
      await provision.addElement('form', formId, '/bag/c', { i: nextI, node: formEventsRegionIntent(wanted) });
      return true;
    }
    // Existing region: append only handlers not already wired.
    const region = bagC[regionIdx].node;
    const attrOf = (node, key) => ((node.a || []).find((a) => a[0] === key) || [])[1];
    const existing = new Set();
    for (const evNode of region.c || []) {
      const handler = (((evNode.c || [])[0] || {}).c || [])[0];
      existing.add(`${attrOf(evNode, 'name')}|${handler && attrOf(handler, 'functionName')}|${handler && attrOf(handler, 'libraryName')}`);
    }
    let added = false;
    for (const ev of wanted) {
      if (existing.has(`${ev.event}|${ev.function}|${ev.library}`)) continue;
      await provision.addElement('form', formId, `/bag/c/${regionIdx}/node/c`, formEventsRegionIntent([ev]).c[0]);
      added = true;
    }
    return added;
  };

  // Reconcile an EXISTING form to the spec: fetch it, ADD any spec field/sub-grid not already placed
  // (semantic identity = bound fieldName / relationship, so a rebuild never duplicates), PRUNE fields
  // an explicit layout dropped, then push (halt on a 412 conflict), publish, and ensure it's a
  // solution component. This is what makes editing a deployed form actually land.

  // Re-assert `readOnly` / `hidden` on fields already placed on a deployed form.
  //
  // Only the ENABLED state is ever written (`isReadOnly: true`, `visible: false`) — never the
  // negation. A spec that omits the flag means "I am not expressing an opinion", not "make it
  // editable/visible", so blanking here would silently undo a lock or a hide a maker applied in the
  // designer on a field the spec merely happens to list.
  //
  // Consequence, documented rather than worked around: turning a flag back OFF through the spec is
  // not supported — remove the field and let the next build re-add it, or clear it in the designer.
  const applyFieldControlOptions = async (formId, def, want, wantCellByLogical) => {
    for (const logical of want) {
      const wantCell = wantCellByLogical[logical];
      if (!wantCell) continue;
      const wantReadOnly = !!(wantCell.control && wantCell.control.isReadOnly);
      const wantHidden = wantCell.visible === false;
      if (!wantReadOnly && !wantHidden) continue; // nothing asserted for this field
      // Re-read per field: each updateElement rewrites the artifact, and a stale pointer would
      // patch whatever now sits at that index.
      const loc = findFieldCellLocation(await provision.getArtifact('form', formId) || {}, logical);
      if (!loc) continue;
      if (wantReadOnly) await provision.updateElement('form', formId, `${loc.cellPointer}/control`, { isReadOnly: true });
      if (wantHidden) await provision.updateElement('form', formId, loc.cellPointer, { visible: false });
    }
  };

  // Resolve a `/tabs/T/columns/C/sections/S/rows/R` pointer to the row object. Deliberately narrow —
  // it exists only so the reconcile can tell whether a cell move emptied the row it came from.
  const jsonPointerRow = (formJson, pointer) => {
    const t = String(pointer).split('/').filter(Boolean);
    // ['tabs', T, 'columns', C, 'sections', S, 'rows', R]
    if (t.length !== 8 || t[0] !== 'tabs' || t[2] !== 'columns' || t[4] !== 'sections' || t[6] !== 'rows') return null;
    const tab = (formJson.tabs || [])[Number(t[1])];
    const col = tab && (tab.columns || [])[Number(t[3])];
    const sec = col && (col.sections || [])[Number(t[5])];
    return (sec && (sec.rows || [])[Number(t[7])]) || null;
  };

  // Move each anchored field so it immediately follows its anchor (`fieldOptions[x].after`).
  //
  // This is the non-destructive alternative to re-declaring a whole form just to move one control
  // (ADO 6651439). It is a no-op when the field is already in place, so a rebuild converges instead
  // of shuffling the form on every run.
  //
  // "Immediately after" is measured in SECTION-FLAT reading order, because a section is a grid: in a
  // 2-column section `[a|b] [c|d]` the order is a, b, c, d. Two mechanics, chosen by whether one can
  // actually reach that position (see the branch comments below) rather than by row shape alone:
  //   * ROW move — the field is alone in its row AND the anchor is the last cell of its row. The
  //     field's row is inserted after the anchor's row, which is flat-adjacent only under that
  //     second condition.
  //   * CELL move — everything else. The cell is spliced into the anchor's own row directly after
  //     it, which always satisfies flat adjacency. The anchor's row then holds one extra cell — an
  //     over-full row for the section's column count. The SDK accepts that (its form validator
  //     imposes no row/cell cardinality rule, only "a cell control must be an object or null"), and
  //     Dataverse accepts the push; how UCI lays the overflow out is NOT verified here. A row
  //     emptied by the move is removed so blank rows cannot accumulate.
  const applyFieldPositions = async (formId, def) => {
    const positions = def.__fieldPositions || {};
    for (const logical of Object.keys(positions)) {
      const anchor = positions[logical];
      // Re-read before every move: moveElement rewrites the artifact and shifts sibling indices.
      const form = await provision.getArtifact('form', formId) || {};
      const from = findFieldCellLocation(form, logical);
      const to = findFieldCellLocation(form, anchor);
      // A missing field or anchor is not an error: the anchor may be a column this build did not
      // create, or the field may have been pruned. Positioning is a layout nicety — never fail a
      // build over it.
      if (!from || !to) continue;

      // "Already in place" is a SECTION-FLAT question, not a row-local one. A section is a grid: in
      // a 2-column section `[a|b] [c|d]` the reading order is a, b, c, d, so a field can sit
      // correctly immediately after its anchor while living in the NEXT row. Testing row adjacency
      // reported such a field as misplaced and moved it on every rebuild — the auto layout switches
      // to 2 columns above 6 fields, so this was the common case, not an edge case.
      if (from.sectionPointer === to.sectionPointer && from.flatIndex === to.flatIndex + 1) continue;

      // Which mechanic can actually SATISFY that check?
      //
      // A ROW move inserts the field's row after the anchor's row, so it lands after the LAST cell
      // of that row. That is flat-adjacent to the anchor only when the anchor IS the last cell in
      // its row — always true in a 1-column section, a coin-flip in a 2-column one. When the anchor
      // sits in a left-hand column the row move overshoots by the rest of the row, the flat check
      // stays false forever, and the reconcile re-issues a no-op move on every single rebuild.
      // So the row move is used only where it can succeed; otherwise the cell is moved into the
      // anchor's own row, directly after it, which always satisfies flat adjacency.
      const anchorIsLastInRow = to.cellIndex === to.rowCellCount - 1;
      if (from.rowCellCount === 1 && anchorIsLastInRow) {
        // moveElement resolves the TARGET ARRAY first, then removes the source, then splices. When
        // both live in the same array the removal shifts every later index down by one, so a target
        // computed against the pre-removal array overshoots by one. Compensate explicitly.
        let index = to.rowIndex + 1;
        if (from.rowsPointer === to.rowsPointer && from.rowIndex < index) index -= 1;
        await provision.moveElement('form', formId, from.rowPointer, to.rowsPointer, { index });
        continue;
      }

      let index = to.cellIndex + 1;
      if (from.cellsPointer === to.cellsPointer && from.cellIndex < index) index -= 1;
      await provision.moveElement('form', formId, from.cellPointer, to.cellsPointer, { index });
      // Moving the only cell out of a row leaves an empty `<row/>`, which renders as a blank line and
      // would accumulate one per anchored field. Row indices are unchanged by a cell move (cells
      // move between rows; the row count does not change), so the source row is still where it was.
      if (from.rowCellCount === 1 && from.rowPointer !== to.rowPointer) {
        const after = await provision.getArtifact('form', formId) || {};
        const stranded = jsonPointerRow(after, from.rowPointer);
        if (stranded && (stranded.cells || []).length === 0) {
          await provision.removeElement('form', formId, from.rowPointer);
        }
      }
    }
  };

  const reconcileForm = async (formId, def) => {
    await provision.fetchArtifact('form', formId);
    // The def's field cells are already push-ready ({ control: { fieldName, isRequired? } }); index by
    // logical so a missing field is re-added with the same intent the create path would emit.
    const wantCellByLogical = {};
    for (const t of def.tabs || []) for (const col of t.columns || []) for (const s of col.sections || []) for (const r of s.rows || []) for (const c of r.cells || []) {
      const fn = c.control && c.control.fieldName;
      if (fn) wantCellByLogical[String(fn).toLowerCase()] = c;
    }
    const want = formFieldLogicals(def);
    const have = new Set(formFieldLogicals(await provision.getArtifact('form', formId) || {}));
    for (const logical of want) {
      if (have.has(logical)) continue; // idempotent: already on the form
      const rowsPtr = firstSectionRowsPointer(await provision.getArtifact('form', formId) || {});
      if (!rowsPtr) break;
      await provision.addElement('form', formId, rowsPtr, { cells: [wantCellByLogical[logical]] });
      have.add(logical);
    }
    await addSubgrids(formId, def.__subgrids);
    // Re-assert per-control attributes (read-only / hidden) on fields that were ALREADY on the form.
    // The add loop above only reaches fields it creates, so without this an author who marks an
    // existing field `readOnly: true` gets a successful build and no change — the same
    // create-only blind spot that made an existing column's RequiredLevel unchangeable.
    //
    // updateElement MERGES when both sides are objects (`{...current, ...patch}`), so patching
    // `/…/control` with `{ isReadOnly: true }` preserves classId, label and every other adapter-derived
    // value. It does NOT mint ids, which is exactly right here — the cell already has one.
    await applyFieldControlOptions(formId, def, want, wantCellByLogical);
    // Reposition any field the spec anchors after another (`fieldOptions[x].after`). Runs AFTER the
    // add/attribute passes so a field created in this same run can be positioned in the same run.
    await applyFieldPositions(formId, def);
    // Prune fields the deployed form carries that the spec's EXPLICIT layout dropped, so editing a
    // form to REMOVE a field lands. Gated to an author-controlled layout (explicit `tabs`); an AUTO
    // layout stays additive (never strip a column a user added in Maker). Never remove the primary.
    // `prune: false` opts out entirely, so a subset of the form can be restyled or reordered without
    // re-declaring every other field just to keep it (ADO 6651439).
    // removeElement is non-idempotent and shifts sibling indices, so re-locate each cell pointer from
    // a fresh read before removing it.
    if (def.__explicitLayout && def.__prune !== false) {
      const wantSet = new Set(want);
      const primary = def.__primaryField ? String(def.__primaryField).toLowerCase() : null;
      for (const logical of formFieldLogicals(await provision.getArtifact('form', formId) || {})) {
        if (wantSet.has(logical) || logical === primary) continue;
        const ptr = findFieldCellPointer(await provision.getArtifact('form', formId) || {}, logical);
        if (ptr) await provision.removeElement('form', formId, ptr);
      }
    }
    requireSuccessfulPush(await provision.pushArtifact('form', formId), `form ${def.name}`, opts.warn);
    reportPartialPush(await provision.publishArtifact('form', formId), `form ${def.name}`, opts.warn);
    await provision.addSolutionComponent({ componentId: formId, componentType: COMPONENT_TYPE.form, solutionUniqueName: sol.uniqueName });
    return formId;
  };

  // Reconcile an EXISTING author view: fetch it, UNION its current columns with the spec's (so a
  // manual column add in Maker is preserved AND the spec's new lookup columns land), set, push,
  // publish. Editing a view's column set (e.g. to surface a parent lookup) now takes effect.
  const reconcileView = async (viewId, def) => {
    await provision.fetchArtifact('view', viewId);
    const current = await provision.getArtifact('view', viewId) || {};
    const have = new Set((current.columns || []).map((c) => String(c.name).toLowerCase()));
    const merged = (current.columns || []).slice();
    for (const col of def.columns || []) {
      const n = String(col.name).toLowerCase();
      if (have.has(n)) continue;
      have.add(n);
      merged.push({ name: n, width: col.width || 100, order: merged.length });
    }
    await provision.updateElement('view', viewId, '/columns', merged);
    // Reconcile the maker-facing description too (#496). Without this, a view's description reached
    // Dataverse only on CREATE — and the most-read view on a table is the platform's auto-generated
    // "Active <Plural>", which already exists, so the build reconciles onto it and the authored
    // description was never written.
    //
    // Two guards, both load-bearing:
    //   * only when the spec EXPLICITLY sets one (`viewDef` emits `description: v.description || ''`,
    //     so an unset description is `''` — writing that would blank text a maker typed in the UI);
    //   * only when it DIFFERS, so an ordinary rebuild issues no extra write.
    // This rides the push below rather than a separate PATCH: the push rewrites `description` from
    // the artifact, so a standalone PATCH would be immediately overwritten by the stale fetched value.
    const wantDescription = typeof def.description === 'string' ? def.description.trim() : '';
    if (wantDescription && wantDescription !== String(current.description || '')) {
      await provision.updateElement('view', viewId, '/description', wantDescription);
    }
    requireSuccessfulPush(await provision.pushArtifact('view', viewId), `view ${def.name}`, opts.warn);
    reportPartialPush(await provision.publishArtifact('view', viewId), `view ${def.name}`, opts.warn);
    await provision.addSolutionComponent({ componentId: viewId, componentType: COMPONENT_TYPE.view, solutionUniqueName: sol.uniqueName });
    return viewId;
  };

  // Gap 2: mark our spec form the entity's DEFAULT main form so the app opens it, not the blank
  // stock "Information" form. Called ONLY for a table THIS build owns (a custom, publisher-prefixed
  // table — see the call-site guard), so it never touches a reused/system table's forms.
  //
  // By default we deliberately do NOT deactivate other main forms. That would be destructive: on a
  // shared system table it disables out-of-box forms env-wide, and on any table it kills legitimate
  // role-based / sibling author forms — and with concurrent form builds the winner is
  // nondeterministic. Marking ours `isdefault` is enough for the app to open it (the stock form
  // stays available in the form switcher). Best-effort — never fail the build over the flag.
  //
  // #6 (opt-in): when a form sets `deactivateOtherMainForms: true`, we ALSO deactivate every OTHER
  // active main form on the entity so only our form ships active (no blank "Information" form
  // competing in the switcher). This is gated to our OWN custom table (call-site) AND the explicit
  // flag, because it is destructive. Teardown's restoreStockMainForm reactivates a stock main form
  // before deleting ours so the table can be torn down — note that is a delete-enabler, NOT a perfect
  // restore of pre-build activation state (a form that was inactive before this build may be left
  // active after teardown).
  const promoteDefaultForm = async (formId, entityLogical, deactivateOthers) => {
    // Deactivating the OTHER main forms is only safe once OUR form is the entity default: if the
    // isdefault promote failed we must NOT deactivate the others, or the entity could be left with its
    // (now-deactivated) stock form still the default and no active default — a bricked form experience.
    let promoted = false;
    try {
      await provision.updateRecord('systemform', formId, { isdefault: true });
      promoted = true;
    } catch {
      /* best-effort — leave promoted=false so we skip the destructive deactivation below */
    }
    if (!deactivateOthers || !promoted) return;
    if (typeof provision.queryRecords !== 'function') return;
    try {
      // Main forms only (systemform.type == 2). Every other ACTIVE main form is deactivated
      // (formactivationstate 1 -> 0); ours is skipped by id. A form already inactive
      // (formactivationstate === 0) is left alone to avoid a redundant write; a row without an
      // explicit state is presumed active and deactivated (the safe assumption).
      // See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/systemform
      const forms = await provision.queryRecords('systemform', {
        select: ['formid', 'formactivationstate'],
        filter: `objecttypecode eq '${odataLit(entityLogical)}' and type eq 2`,
        top: 50,
      });
      for (const f of forms || []) {
        if (String(f.formid) === String(formId)) continue; // never deactivate our own form
        if (f.formactivationstate === 0) continue; // already inactive
        try {
          await provision.updateRecord('systemform', String(f.formid), { formactivationstate: 0 });
        } catch {
          /* best-effort per form */
        }
      }
    } catch {
      /* best-effort */
    }
  };

  // helper: create an artifact — or UPDATE it in place if it already exists — then add to the solution.
  const buildArtifact = (type, def) => runner.run(`${type}s`, `${type} "${def.name}"`, async () => {
    // Update-in-place: editing a deployed spec must land, so a form is reconciled (fields +
    // sub-grids) and a view has its columns reconciled, instead of the artifact being reused
    // unchanged (the old behavior silently dropped every edit while still reporting success).
    if (type === 'form') {
      // Reconcile onto our OWN spec-named form (create it on first build, update it on re-runs) —
      // never onto the entity's stock "Information" form. The stock form can't be deleted (every
      // table must keep one main form), so reconciling onto it would attach the spec's subgrids +
      // parent lookups to an un-deletable form and strand references that block teardown. Gap 2 is
      // instead handled by making our form the entity's default (see promoteDefaultForm below).
      const existingId = await resolveExistingFormId(provision, def);
      if (existingId) return reconcileForm(existingId, def);
    } else if (type === 'view') {
      const existingId = await provision.findArtifact('view', { name: def.name, entity: def.entityLogicalName });
      if (existingId) return reconcileView(existingId, def);
    }
    // A form cannot be created from a full authored definition (the adapter's createDefault
    // serializes authored tabs BEFORE minting ids and throws on the id-less cells); build its body
    // through the generic surface instead (createFormShell), then place sub-grids. Other artifact
    // types (view/chart/command/dashboard/app) still serialize unchanged from a full createArtifact.
    let id;
    if (type === 'form') {
      id = await createFormShell(def);
      await addSubgrids(id, def.__subgrids);
    } else {
      id = provision.createArtifact(type, def).id;
    }
    const pushed = requireSuccessfulPush(await provision.pushArtifact(type, id), `${type} ${def.name}`, opts.warn);
    await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE[type], solutionUniqueName: sol.uniqueName });
    return pushed.id;
  });

  // 4. Views (independent -> parallel).
  if (has('views')) {
    const ids = await runner.mapLimit(spec.views || [], concurrency, (v) => buildArtifact('view', viewDef(spec, v)));
    // Key by `entity|name` (matching identityOf.view + the snapshot canonical id). View names are unique
    // only PER ENTITY, so a name-only key lets a same-named view on another entity OVERWRITE this id and
    // cross-wire dashboards / sub-grids / AI-summaries to the wrong entity's view.
    (spec.views || []).forEach((v, i) => { result.created.views[`${v.entity.toLowerCase()}|${v.name}`] = ids[i]; });
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
  // Chart DEFINITION edits are not applied in place on a rebuild (there is no SDK chart-update
  // path yet), so an existing chart is skipped WITH A REASON rather than silently reported as
  // (re)built — recreate the chart to change it. New charts are created + added to the solution.
  //
  // Charts whose ENTITY should be published at the end. Keyed by entity so one publish covers it,
  // and holding the artifact id because `publishArtifact` requires the artifact to be
  // WORKSPACE-RESIDENT: it goes readRaw -> readLocal, which throws ArtifactNotFoundError rather
  // than lazily fetching. `findArtifact` does NOT populate the workspace, so an existing chart is
  // only publishable once something has created or fetched it. Recording it here — at the two
  // points that actually put it in the workspace — is what keeps phase 8 from handing publish an
  // id it cannot resolve. It is also the right SEMANTICS: publish exactly the entities whose charts
  // this run changed.
  const chartsToPublish = new Map();
  if (has('charts')) {
    const charts = spec.charts || [];
    const ids = await runner.mapLimit(charts, concurrency, async (c) => {
      const def = chartDef(spec, c);
      const existingId = await provision.findArtifact('chart', { name: def.name, entity: def.entityLogicalName });
      if (existingId) {
        // The chart DEFINITION is still not reconciled — but its description is (#496), because a
        // description is the one thing an AI agent inspecting this app later reads, and it reached
        // Dataverse only on create.
        //
        // Written with a direct column PATCH rather than fetch -> updateElement -> pushArtifact,
        // which is what views use. The difference is deliberate: `reconcileView` already pushes an
        // existing view (for columns), so that round trip is proven in production, whereas the chart
        // phase has NEVER pushed an existing chart. A push regenerates `datadescription` and
        // `presentationdescription` from the deserialized model, so it would newly expose every
        // maker-customized chart to a serialize round trip — the same class of risk as #478. A
        // single-column PATCH cannot disturb the chart definition at all.
        //
        // Same two guards as views: only when the spec EXPLICITLY sets a description (chartDef emits
        // `|| ''`, and writing that would blank a maker's text), and only when it DIFFERS.
        const wantDescription = typeof def.description === 'string' ? def.description.trim() : '';
        let reconciled = false;
        if (wantDescription && typeof provision.updateRecord === 'function') {
          try {
            // Read through the SDK's artifact surface, NOT `queryRecords`. Measured live: a chart
            // description PATCH lands on the UNPUBLISHED layer, while a plain/filtered GET returns
            // the PUBLISHED row. Reading the published value would compare across layers — the guard
            // would see a difference on every rebuild and re-issue the identical PATCH forever, which
            // is non-convergence, not a blank. `chartApi.get` uses
            // `Microsoft.Dynamics.CRM.RetrieveUnpublished()`, which is exactly the layer the PATCH
            // writes to. Verified on a live org:
            //   PATCH description -> plain GET: old value | RetrieveUnpublished(): new value
            // fetchArtifact only READS (it populates the local workspace); the chart is still never
            // pushed, so its definition is not exposed to a serialize round trip.
            await provision.fetchArtifact('chart', existingId);
            const current = await provision.getArtifact('chart', existingId) || {};
            if (String(current.description || '') !== wantDescription) {
              await provision.updateRecord('savedqueryvisualization', existingId, { description: wantDescription });
              reconciled = true;
              // The PATCH writes the UNPUBLISHED layer, so the entity must be published for the new
              // text to be served. Safe to queue only here: the fetch above has put the chart in the
              // workspace, which publishArtifact requires.
              chartsToPublish.set(String(def.entityLogicalName || '').toLowerCase(), existingId);
            }
          } catch (err) {
            // Best-effort — a description is an inspection aid and must not fail a build. But it must
            // not be SILENT either: the skip line below says "chart edits aren't applied on rebuild",
            // so an operator whose write was rejected would read that as expected and never look.
            // Silence here would recreate the exact non-convergence #496 exists to remove, one layer
            // down.
            if (typeof opts.warn === 'function') {
              opts.warn(`chart "${def.name}": could not reconcile its description (${(err && err.message) || err}); the deployed chart keeps its previous description.`);
            }
          }
        }
        // The label reports what actually happened, so "description written" and "nothing to do" are
        // not the same line.
        runner.skip('charts', `chart "${def.name}" (exists — ${reconciled ? 'description reconciled; other ' : ''}chart edits aren't applied on rebuild; recreate to change)`);
        // An existing chart the spec claims is still a component of this solution — otherwise it is
        // absent from the exported solution. (It was always visible to TEARDOWN, which resolves
        // charts by name from `spec.charts` rather than by solution membership.) Previously this
        // branch returned without adding it; the create path below and reconcileView both add theirs.
        try {
          await provision.addSolutionComponent({ componentId: existingId, componentType: COMPONENT_TYPE.chart, solutionUniqueName: sol.uniqueName });
        } catch { /* already a component, or not ours to add — never fail a build over it */ }
        return existingId;
      }
      return runner.run('charts', `chart "${def.name}"`, async () => {
        const art = provision.createArtifact('chart', def);
        const pushed = requireSuccessfulPush(await provision.pushArtifact('chart', art.id), `chart ${def.name}`, opts.warn);
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.chart, solutionUniqueName: sol.uniqueName });
        // Created here, so it IS workspace-resident and publishable.
        chartsToPublish.set(String(def.entityLogicalName || '').toLowerCase(), pushed.id);
        return pushed.id;
      });
    });
    charts.forEach((c, i) => { result.created.charts[c.name] = ids[i]; });
  }

  // 6. Forms (independent -> parallel; sub-grids reference the child view ids built above).
  //    A form with `events[]` then gets its JS handlers wired: fetch the pushed form (to
  //    retain its formxml), inject onload/onsave/onchange handlers, push + publish.
  if (has('forms')) {
    const defs = await Promise.all((spec.forms || []).map(async (f) => {
      const def = compileFormIntent(spec, f, { notesClassId: NOTES_CLASS_ID });
      const subs = [];
      // Gap 7: opt-in auto sub-grids. `forms[].autoSubgrids: true` adds a sub-grid for every child
      // relationship of this form's entity (1:N where it's the parent + N:N) that isn't already
      // declared in subgrids[], so a hub table's form lists its children without hand-authoring each.
      const subgridSpecs = [...(f.subgrids || [])];
      if (f.autoSubgrids) {
        const declared = new Set(subgridSpecs.map((s) => String(s.childEntity).toLowerCase()));
        for (const c of childRelationshipsFor(spec, f.entity)) {
          if (!declared.has(c.childEntity)) subgridSpecs.push({ childEntity: c.childEntity });
        }
      }
      for (const sg of subgridSpecs) {
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
        // #5: title the sub-grid with the child's display name, not its logical name. Shared pure
        // helper (subgridLabel) so the eval harness grades the same title the engine writes.
        const gridLabel = subgridLabel(spec, sg);
        subs.push({ targetEntity: childLogical, relationshipName, viewId, label: gridLabel });
      }
      def.__subgrids = subs;
      return { f, def };
    }));
    const ids = await runner.mapLimit(defs, concurrency, async (d) => {
      const id = await buildArtifact('form', d.def);
      // Gap 2: make our main form the entity's default so the app opens it, not the blank stock form.
      // Guarded to a table THIS build OWNS — a custom, publisher-prefixed table that isn't flagged
      // `existing`. A system/reused table (account, systemuser, or anything without our prefix) must
      // never have its default form re-pointed: that's a shared, environment-wide side effect.
      if ((d.f.formType || 'Main') === 'Main') {
        const entSpec = entityByLogical(spec, d.f.entity.toLowerCase());
        const prefix = spec.solution && spec.solution.publisherPrefix;
        const isOwnCustomTable = !!(entSpec && entSpec.existing !== true && prefix &&
          String(entSpec.schemaName).toLowerCase().startsWith(String(prefix).toLowerCase() + '_'));
        if (isOwnCustomTable) await promoteDefaultForm(id, d.f.entity.toLowerCase(), d.f.deactivateOtherMainForms === true);
      }
      const wantedEvents = (d.f.events || []).filter((ev) => FORM_EVENTS.has(ev.event) && ev.library && ev.function);
      if (wantedEvents.length) {
        await runner.run('forms', `wire ${wantedEvents.length} event handler(s) on ${d.f.entity}`, async () => {
          await provision.fetchArtifact('form', id);
          // Merge into the root-bag <events> region (idempotent — a rebuild only pushes if a NEW
          // handler was appended, so re-runs don't duplicate a handler or a second <events> root).
          if (await wireFormEvents(id, wantedEvents)) {
            requireSuccessfulPush(await provision.pushArtifact('form', id), `form ${d.f.name || d.f.entity} events`, opts.warn);
            reportPartialPush(await provision.publishArtifact('form', id), `form ${d.f.name || d.f.entity} events`, opts.warn);
          }
        });
      }
      return id;
    });
    // Key the entity's MAIN form by entity (the app wires one form per entity below); quick-create
    // / quick-view forms are still built + added to the solution, just not the entity's app form.
    defs.forEach((d, i) => { if ((d.f.formType || 'Main') === 'Main') result.created.forms[d.f.entity.toLowerCase()] = ids[i]; });
    // Every form, addressable individually. `created.forms` is keyed by ENTITY and holds only the
    // Main form, which is all the app shell needs — but `forms[].securityRoles` is applied in the
    // SECURITY phase (roles do not exist until then), by which time the forms phase is long over and
    // a non-Main form would be unreachable. Keyed on the same (entity, formType, name) triple the
    // spec uses to identify a form, so the lookup cannot silently bind to a same-named sibling.
    defs.forEach((d, i) => {
      result.created.formIds[formIdentityKey(d.f)] = ids[i];
    });
    // Quick-view placement: embed a built QuickView form onto a host form via a lookup column,
    // added as a canonical quick-view control cell (semantic identity = the lookup field, so a
    // rebuild doesn't duplicate it). Runs after ALL forms are built so a host can reference a
    // QuickView form created concurrently. Placed in the host's first section.
    const formIdByEntityName = {};
    // Only QuickView forms are quick-view targets. Keying ALL forms by (entity, name) let a same-named
    // Main form on the SAME entity OVERWRITE the QuickView entry (order-dependent), embedding the wrong
    // form id — so key QuickView forms only (Sol review).
    defs.forEach((d, i) => { if (d.f.name && (d.f.formType || 'Main') === 'QuickView') formIdByEntityName[`${String(d.f.entity).toLowerCase()}|${d.f.name}`] = ids[i]; });
    for (let i = 0; i < defs.length; i++) {
      const f = defs[i].f;
      const qvs = (f.quickViews || []).filter((q) => q && q.lookup && q.targetEntity && q.form);
      if (!qvs.length) continue;
      const hostId = ids[i];
      await runner.run('forms', `place ${qvs.length} quick-view(s) on ${f.entity}`, async () => {
        await provision.fetchArtifact('form', hostId);
        let changed = false;
        for (const qv of qvs) {
          // A quick-view embeds a QuickView form OF THE TARGET ENTITY — key by (targetEntity, name), not a
          // global name, so two entities with same-named QuickView forms don't cross-wire (Sol review).
          const qvFormId = formIdByEntityName[`${String(qv.targetEntity).toLowerCase()}|${qv.form}`];
          if (!qvFormId) throw new Error(`form "${f.name || f.entity}" quick-view references form '${qv.form}' on '${qv.targetEntity}' which wasn't built — declare it in forms[] with formType: "QuickView", entity "${qv.targetEntity}", and a matching name`);
          const lookup = String(qv.lookup).toLowerCase();
          if (hasQuickView(await provision.getArtifact('form', hostId) || {}, lookup)) continue; // idempotent
          const rowsPtr = firstSectionRowsPointer(await provision.getArtifact('form', hostId) || {});
          if (!rowsPtr) continue;
          await provision.addElement('form', hostId, rowsPtr, { cells: [quickViewCellIntent({ quickViewClassId: QUICK_VIEW_CLASS_ID, lookupFieldName: lookup, targetEntity: String(qv.targetEntity).toLowerCase(), quickViewFormId: qvFormId, label: qv.label })] });
          changed = true;
        }
        if (changed) {
          requireSuccessfulPush(await provision.pushArtifact('form', hostId), `form ${f.name || f.entity} quick-views`, opts.warn);
          reportPartialPush(await provision.publishArtifact('form', hostId), `form ${f.name || f.entity} quick-views`, opts.warn);
        }
      });
    }
  }

  // 6b. Commands (modern command-bar buttons). One command artifact per entity; a button with a
  //     library+function gets a functional JS on-click action bound to the created web resource.
  //     Pushed via the workspace-owning `provision` client (the appaction lands in the Default
  //     solution — it's not a standard solution-component type — but is entity-scoped so it shows
  //     on the entity's command bar in the app regardless).
  // 6b-pre. Business rules. Additive discover-reconcile like charts/commands: a rule is identified by
  // (entity, name), and re-pushing on every rebuild would stack duplicate rules on the table.
  //
  // The SDK writes rules ONLY through the bound `CreateProcessWithWfomJson` member — the same one the
  // modern business-rule designer uses. It used to compile a client-side WWF XAML fallback when that
  // member faulted; that fallback was DELETED upstream because it covered only 4 of the 7 action
  // types and one clause, so it silently narrowed a rule into something the platform would accept but
  // that did not say what the author wrote.
  //
  // The consequence is environment-visible and is handled below: an environment that does not declare
  // the member cannot host business rules AT ALL.
  //
  // MEASURED across a broad sample of environments: only a small minority declare the member, so the
  // gate is the COMMON case, not an edge case. Note also that declaring the member is NOT the same as
  // it working — some environments answer a real push with a server-side `MissingMethodException`,
  // which is a platform defect there rather than anything about the rule. See the
  // `businessRuleApiUnavailable` handling.
  if (has('business-rules')) {
    // Warn ONCE per build, not once per rule: on an environment without the member every rule skips,
    // and N copies of the same paragraph buries the rest of the build output.
    let businessRuleApiWarned = false;
    // A rule is skipped only for this ONE reason; anything else still halts. Matching is on the
    // SDK's documented `code`, never on `err.name` — the bundle is minified, so the class name is a
    // rebuild-unstable string (`Xe`, which is really the base SdkError), and matching it would
    // silently disarm this guard the next time the bundle is rebuilt.
    const businessRuleApiUnavailable = (err) => (err && err.code === 'BUSINESS_RULE_API_UNAVAILABLE'
      ? 'unsupported in this environment'
      : false);
    for (const rule of spec.businessRules || []) {
      const entityLogical = String(rule.entity).toLowerCase();
      const existing = await provision.queryRecords('workflow', {
        select: ['workflowid', 'statecode', 'createdon'],
        // Definition rows only — see businessRuleFilter. Scoped to the entity as well as the name so
        // a same-named rule on a DIFFERENT table is not mistaken for this one.
        filter: businessRuleFilter(rule.name, entityLogical),
        // `top: 50` and ORDERED, not `top: 1`. Two reasons, both measured:
        //  * A previous build (before the SDK's double-write fix) could have left duplicates. With
        //    `top: 1` this branch reused one and skipped the cleanup entirely, so both rules kept
        //    firing forever — the sweep below only ever ran after a fresh create.
        //  * `top: 1` with no ordering returns an ARBITRARY row, so the one adopted as "the" rule
        //    could be the faulted orphan rather than the good one. Oldest-first makes the survivor
        //    deterministic and prefers the row that was committed first.
        orderBy: 'createdon asc',
        top: 50,
      });
      const existingId = existing && existing[0] && existing[0].workflowid;
      if (existingId) {
        // Legacy duplicates: everything beyond the first row is residue from a build that predates
        // the SDK fix. Remove it here as well as on the create path, so a rebuild repairs an org
        // instead of preserving the problem. Best-effort — these rows frequently refuse both
        // deactivate (400 0x80060015) and delete (405 0x80040227), and a failure to clean one must
        // not fail the build; `--verify` reports the surviving duplicates.
        const legacyDupes = (existing || []).slice(1);
        for (const extra of legacyDupes) {
          try { if (extra.statecode === 1) await provision.updateRecord('workflow', extra.workflowid, { statecode: 0, statuscode: 1 }); } catch { /* try the delete anyway */ }
          let removed = false;
          let why = '';
          // Capture the REAL reason instead of asserting one. A 403 (no delete privilege), a 429, or
          // a transport failure look identical to the wedged-row case from the outside, and a warning
          // that names the wrong cause sends the reader to Maker to hand-delete a row they actually
          // lack rights to touch.
          try { await provision.deleteRecord('workflow', extra.workflowid); removed = true; } catch (e) { why = (e && e.message) ? String(e.message).replace(/\s+/g, ' ').slice(0, 200) : String(e); }
          if (typeof opts.warn === 'function') {
            opts.warn(removed
              ? `business rule "${rule.name}": removed a duplicate left by an earlier build (${extra.workflowid})`
              : `business rule "${rule.name}": a duplicate left by an earlier build (${extra.workflowid}) could not be removed (${why}). Only one copy should run — remove it in Maker if the reason above is not transient. See issue #482.`);
          }
        }
        // Reuse — but a rule that EXISTS is not necessarily a rule that RUNS. A deployed rule left in
        // Draft (statecode 0) is inert, and "exists, so skip" would report success over an app whose
        // logic silently does nothing. Live-hit: a rule deactivated out-of-band stayed Draft across a
        // rebuild. So reconcile the one thing that is cheap and safe to converge — its state.
        const wantActive = (rule.status || 'Active') === 'Active';
        const isActive = existing[0].statecode === 1;
        if (wantActive !== isActive) {
          // Converge in BOTH directions. Activating a Draft rule was handled from the start; the
          // reverse was not, so a spec changed to `status: "Draft"` left the deployed rule ACTIVE and
          // still firing — a rebuild that silently ignores the one property it claims to reconcile.
          //
          // Best-effort, NOT a build halt. A rule can be wedged in a state where the platform refuses
          // both activation and deletion ("Invalid operation - You cannot activate or deactivate this
          // business rule") — live-observed on a row the SDK's bound member left behind after faulting
          // during UiData generation (#482). Failing the phase there would make one broken pre-existing
          // rule block the whole app from building, which is worse than an inert rule. The warning
          // says so, and `--verify` reports the rule's real state (see the business-rule block in
          // verify-spec.js).
          const target = wantActive ? { statecode: 1, statuscode: 2 } : { statecode: 0, statuscode: 1 };
          const verb = wantActive ? 'activated' : 'deactivated';
          try {
            await provision.updateRecord('workflow', existingId, target);
            runner.skip('business-rules', `business rule "${rule.name}" on ${rule.entity} (existed in the wrong state — ${verb})`);
          } catch (e) {
            if (typeof opts.warn === 'function') {
              opts.warn(`business rule "${rule.name}" on ${rule.entity} exists but could not be ${verb} (${e && e.message}). It is ${isActive ? 'still running' : 'inert'}. Delete it and rebuild to recreate it cleanly.`);
            }
            runner.skip('business-rules', `business rule "${rule.name}" on ${rule.entity} (exists but could not be ${verb})`);
          }
        } else {
          runner.skip('business-rules', `business rule "${rule.name}" on ${rule.entity} (exists — reuse; rule edits aren't applied on rebuild, recreate to change)`);
        }
        result.created.businessRules[`${entityLogical}|${rule.name}`] = existingId;
        continue;
      }
      await runner.run('business-rules', `business rule "${rule.name}" on ${rule.entity}`, async () => {
        const def = businessRuleDef(rule);
        const art = provision.createArtifact('businessRule', def);
        // The condition tree is a nested object, so it goes on through the generic element surface
        // rather than the create payload — mirroring how the SDK's own workflow test authors one.
        await provision.updateElement('businessRule', art.id, '/rootCondition', def.rootCondition);
        const pushed = requireSuccessfulPush(await provision.pushArtifact('businessRule', art.id), `business rule ${rule.name}`, opts.warn);
        result.created.businessRules[`${entityLogical}|${rule.name}`] = pushed.id;
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.workflow, solutionUniqueName: sol.uniqueName });
        // DE-DUPLICATE — legacy repair only.
        //
        // The SDK USED to fall back to a classic `workflows` row on a qualifying 400, and that
        // fallback assumed the 400 meant "nothing was written". Live measurement showed the platform
        // commits the row and THEN faults generating its UiData, so the fallback wrote a SECOND copy
        // and both fired. Observed as two rows ~5s apart in one run, one server-assigned and one
        // carrying the client-generated id. https://github.com/microsoft/power-platform-skills/issues/482
        //
        // The fallback no longer exists in the vendored SDK — business rules are written through the
        // bound member or not at all — so this sweep can no longer find a duplicate THIS build made.
        // It is KEPT because it still repairs an org that a PREVIOUS build damaged: those rows are
        // already committed and frequently refuse both deactivate and delete, so they will not
        // disappear on their own. On a clean org it costs exactly one query and finds nothing.
        //
        // Scope is deliberately tight: only rules matching THIS rule's exact name and entity, and
        // only ones that are not the id the push returned. That cannot touch a rule this build did
        // not just author.
        const dupes = await provision.queryRecords('workflow', {
          select: ['workflowid', 'statecode'],
          filter: businessRuleFilter(rule.name, entityLogical),
          top: 50,
        });
        const extras = (dupes || []).filter((w) => String(w.workflowid).toLowerCase() !== String(pushed.id).toLowerCase());
        for (const extra of extras) {
          // Deactivate and delete are attempted INDEPENDENTLY. The orphan is often wedged — the
          // platform answers "Invalid operation - You cannot activate or deactivate this business
          // rule" for a row whose UiData generation faulted — and an earlier version wrapped both in
          // one try, so a failed deactivate meant the delete was never even attempted. Deactivation
          // is also asynchronous, so a row that refuses it now may become deletable shortly after.
          try { if (extra.statecode === 1) await provision.updateRecord('workflow', extra.workflowid, { statecode: 0, statuscode: 1 }); } catch { /* try the delete anyway */ }
          let removed = false;
          let why = '';
          // Report the REAL failure rather than asserting the wedged-row cause: a 403, 429 or
          // transport error is indistinguishable from outside, and naming the wrong one misdirects
          // whoever reads the warning.
          try { await provision.deleteRecord('workflow', extra.workflowid); removed = true; } catch (e) { why = (e && e.message) ? String(e.message).replace(/\s+/g, ' ').slice(0, 200) : String(e); }
          if (typeof opts.warn === 'function') {
            opts.warn(removed
              ? `business rule "${rule.name}": removed a duplicate left by an earlier build (${extra.workflowid})`
              : `business rule "${rule.name}": an earlier build left a duplicate (${extra.workflowid}) that could not be removed automatically (${why}). Only one copy should run — remove it in Maker if the reason above is not transient. See issue #482.`);
          }
        }
      }, {
        // An environment that does not declare the bound member cannot host business rules at all.
        // Halting here would abandon a build that has ALREADY created the solution, tables, columns,
        // forms, views and the app — leaving a half-built app and an error 90% of the way through a
        // run, for a cause the operator can do nothing about from here.
        //
        // So this degrades the way `app.newLook` already does for its tenant-gated setting: skip the
        // artifact, say so loudly and specifically, and let the rest of the app build. Nothing wrong
        // is written — the alternative the SDK deleted (compiling a narrowed rule) is precisely what
        // must not happen. The skip is recorded on the result so `--verify` and the run summary can
        // report it rather than implying the rules exist.
        skipIf: (err) => {
          const reason = businessRuleApiUnavailable(err);
          if (!reason) return false;
          result.skipped.businessRules.push(`${entityLogical}|${rule.name}`);
          if (!businessRuleApiWarned && typeof opts.warn === 'function') {
            businessRuleApiWarned = true;
            opts.warn(`business rules were NOT created: this environment does not expose the '${BUSINESS_RULE_MEMBER}' member that the modern business-rule designer uses, so there is no supported way to author them here. Everything else in the app was built normally. Re-run against an environment that exposes the member, or drop businessRules[] from the spec. Detail: ${String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 300)}`);
          }
          return reason;
        },
      });
    }
  }

  if (has('commands')) {
    for (const [entityLogical, cmds] of Object.entries(commandsByEntity(spec))) {
      // Additive discover-reconcile (design §14): one command artifact per entity (identity = entity).
      // Re-pushing the appaction on every rebuild risks a duplicate command bar on the entity, so
      // discover-then-skip like charts/dashboards. Discovery is `resolveArtifact('command', { entity })`
      // (findArtifact has no command kind; the vendored resolveArtifact — what teardown uses to find a
      // per-entity command — does). Button EDITS are not reapplied on a rebuild — recreate to change.
      // Never removes buttons (additive only).
      const existing = await provision.resolveArtifact('command', { entity: entityLogical });
      const existingId = existing && existing[0] && existing[0].id;
      if (existingId) {
        runner.skip('commands', `command bar for ${entityLogical} (exists — reuse; button edits aren't applied on rebuild, recreate to change)`);
        result.created.commands[entityLogical] = existingId;
        continue;
      }
      await runner.run('commands', `command bar for ${entityLogical} (${cmds.length} button(s))`, async () => {
        const def = commandDef(entityLogical, cmds, result.created.webResources);
        const art = provision.createArtifact('command', def);
        const pushed = requireSuccessfulPush(await provision.pushArtifact('command', art.id), `command ${entityLogical}`, opts.warn);
        result.created.commands[entityLogical] = pushed.id;
      });
    }
  }

  // 6c. Dashboards. createArtifact('dashboard') seeds a dashboard; each chart/list/iframe/webresource
  //     tile is added as a canonical component via addElement('/components') (referencing the
  //     views/charts already built), then push + add to the solution (systemform, component type 60).
  //     Global (no entity); placement in the app sitemap is manual for now.
  if (has('dashboards')) {
    for (const dash of spec.dashboards || []) {
      // Additive discover-reconcile (design §14): a dashboard is global (identity = name), so a rebuild
      // or retry must REUSE the existing one instead of createArtifact-ing a duplicate every run (the old
      // behavior). Discovery is `resolveArtifact('dashboard', { name })` — findArtifact does NOT support
      // the dashboard kind (only view/chart/form/app), but the vendored bundle's resolveArtifact does (it
      // is what the teardown engine uses to find dashboards, sdk-teardown.js). Like charts, dashboard TILE
      // EDITS are not reapplied on a rebuild — recreate the dashboard to change it. Never removes tiles.
      const existing = await provision.resolveArtifact('dashboard', { name: dash.name });
      const existingId = existing && existing[0] && existing[0].id;
      if (existingId) {
        runner.skip('dashboards', `dashboard "${dash.name}" (exists — reuse; tile edits aren't applied on rebuild, recreate to change)`);
        result.created.dashboards[dash.name] = existingId;
        continue;
      }
      await runner.run('dashboards', `dashboard "${dash.name}" (${(dash.tiles || []).length} tile(s))`, async () => {
        const art = provision.createArtifact('dashboard', { name: dash.name, ...(dash.description ? { description: dash.description } : {}) });
        // for..of, not forEach: addElement is async, and a forEach callback would fire the adds
        // without awaiting them — the push below could then race an unfinished tile insert.
        const tiles = dash.tiles || [];
        for (let ti = 0; ti < tiles.length; ti++) {
          await provision.addElement('dashboard', art.id, '/components', dashboardComponent(dashboardTileOpts(spec, tiles[ti], result), ti));
        }
        const pushed = requireSuccessfulPush(await provision.pushArtifact('dashboard', art.id), `dashboard ${dash.name}`, opts.warn);
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.dashboard, solutionUniqueName: sol.uniqueName });
        result.created.dashboards[dash.name] = pushed.id;
      });
    }
  }

  // Tracks whether the app-shell phase REUSED an already-deployed app (edit flow / retry) vs created a
  // fresh one. The pages phase needs this for two reasons: (1) the destructive-removal gate must run for
  // an EXISTING app even when the new spec has zero pages (an existing app may still reference live pages
  // the spec dropped — Imp6); (2) for an existing app the sitemap write is DEFERRED entirely to the pages
  // finalizer (below), so the finalizer must run for an existing app regardless of page subareas.
  let appWasExisting = false;

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
        appWasExisting = true;
        await provision.fetchArtifact('app', existingId);
        // Update the nav tree via the generic surface. On push the adapter re-derives the app's
        // ENTITY + DashBoard components from the sitemap, so a sitemap edit's tables and dashboards
        // stay pinned. Explicit forms/views/charts component pins are applied at CREATE only (below):
        // a FETCHED app exposes no `components` path for updateElement, and the generic surface can't
        // add a missing top-level object, so the retired setAppDefinition's edit-time re-pin is not
        // reproducible here. This is acceptable because a table's forms/views are auto-available once
        // the table is in the app, and every chart is independently added to the SOLUTION
        // (charts-phase addSolutionComponent) and shows on its table's chart pane. Preview limitation:
        // a NEW chart added to an ALREADY-DEPLOYED app on an edit rebuild is NOT re-pinned as an
        // explicit app component (rebuild the app fresh, or add the chart via a dashboard/sitemap, if
        // it must be an explicit component). See docs/app-builder-capabilities.md.
        // Imp6 (removal-gate safety) + C2 (page-backed deferral): write the existing app's sitemap here
        // ONLY when the pages phase will NOT run (so there is no removal gate to bypass) AND the spec has
        // no page subareas (a page-backed sitemap is always resolved in the finalizer). When has('pages')
        // is true, DEFER entirely: writing the omitUnbuiltPages sitemap now would strip every live GenPage
        // SubArea BEFORE the pages phase's destructive-removal gate can inspect it, silently orphaning
        // pages the spec dropped. The finalizer then becomes the sole existing-app sitemap writer and runs
        // AFTER the removal + shared-page gates. For an app-shell-only run (pages excluded) of a page-less
        // app, keep today's behavior so a nav/subarea edit still lands (design §7 / Plan-3 C2).
        if (!has('pages') && !appHasPageSubareas(spec)) {
          // Defense-in-depth (whole-branch review): when the pages phase is EXCLUDED and the spec is
          // page-less, there is no pages-phase removal gate. If the LIVE existing app still has generative
          // pages, writing this omitUnbuiltPages sitemap would DETACH them (orphan records, broken nav) —
          // the exact destructive action Imp6 gates. Enforce the gate here too, fail-closed, unless
          // --allow-destructive. (A page-less app with NO live genpages writes normally. The CLI --apply
          // path is already blocked from partial phase ranges by the I1 guard, but runSdkBuild must be safe
          // on its own.)
          const liveSm = await fetchSitemap(provision, appUniqueName(spec));
          if (!liveSm.ok) throw new BuildHalt(`cannot verify the existing app's live generative pages before rewriting its sitemap (${liveSm.reason}) — refusing to proceed (would risk orphaning pages)`, { phase: 'app-shell', code: 'pages-sitemap-read-failed', recoverable: true });
          if (liveSm.ids.length && opts.allowDestructive !== true) throw new BuildHalt(`refusing to rewrite a page-less sitemap over an existing app that still has ${liveSm.ids.length} live generative page(s) (would orphan them: ${liveSm.ids.join(', ')}). Include the pages phase to reconcile them, or re-run with --allow-destructive to detach.`, { phase: 'app-shell', code: 'pages-removed', recoverable: false });
          await provision.updateElement('app', existingId, '/siteMap', def.siteMap);
          requireSuccessfulPush(await provision.pushArtifact('app', existingId), `app ${def.name}`, opts.warn);
          reportPartialPush(await provision.publishArtifact('app', existingId), `app ${def.name}`, opts.warn);
        }
        await ensureSitemapInSolution(provision, sol, def.uniqueName);
        return existingId;
      }
      // Create: the full def (siteMap + explicit components + iconWebResourceId) serializes unchanged
      // through createArtifact, and push emits appmodule -> sitemap -> AddAppComponents -> publish.
      const art = provision.createArtifact('app', def);
      const pushed = requireSuccessfulPush(await provision.pushArtifact('app', art.id), `app ${def.name}`, opts.warn);
      await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.app, solutionUniqueName: sol.uniqueName });
      // The app module and its sitemap are DISTINCT solution components — adding the appmodule does
      // NOT pull the sitemap in (it lands only in the Default solution), so export/import from the
      // app's own solution would be incomplete. Add the sitemap (componenttype 62) explicitly.
      await ensureSitemapInSolution(provision, sol, def.uniqueName);
      return pushed.id;
    });
  }

  // 7b. Pages (generative pages). The app now exists; implement the full §9 protocol: structural scan/parity
  //     BEFORE any write (fail-closed) → create-absent-first for nav targets (persist manifest after EVERY
  //     create, crash-safety) → resolve nav pagerefs into run-scoped staging (never mutate canonical source)
  //     → upload-once with UPDATE-identity guard (I7) → sitemap finalize. All under a single-machine advisory
  //     lockfile (courtesy, not a correctness guarantee — convergence spine is the safety guarantee).
  // Run the pages phase when the phase is enabled AND there is page work to do: the spec declares pages,
  // OR the app already existed (Imp6 — an existing app may still reference live pages the new spec dropped;
  // the destructive-removal gate below must run even when spec.pages is now empty). A FRESH app with no
  // spec pages has nothing to build and no pre-existing pages to remove, so it is correctly skipped (this
  // also avoids spinning up genpage enumeration for every page-less app build).
  if (has('pages') && ((spec.pages || []).length || appWasExisting)) {
    const genpageCli = opts.genpageCli || makeGenpageCli(opts.env);
    const appUnique = appUniqueName(spec);
    // I1 recovery guard: the app id is only populated by app-shell (this run). If pages runs without it
    // (e.g. --from pages), there is nothing to upload against — HALT and require a FULL rerun.
    if (!result.created.app) throw new BuildHalt('pages phase requires the app (app-shell) in the same run — the app id is not carried across invocations. Re-run a FULL build (do not use --from pages).', { phase: 'pages', code: 'pages-requires-app', recoverable: false });
    const wsDir = opts.workspaceDir || path.join(path.resolve(opts.appDir || '.'), '.maker-workspace');
    // Advisory lease: acquired OUTSIDE the try so a failed acquire (pages-locked HALT) never triggers the
    // finally that would release a lease we never held. Correctness rests on the convergence spine, not this.
    const lease = acquireAppPagesLease(wsDir, appUnique);
    const stagingDir = path.join(wsDir, '.pageref-deploy', randomUUID());
    try {
      // ── THREE AUTHORITIES (Identity · Existence · Membership) ─────────────────────────────────────
      // EXISTENCE (env-wide `pac genpage list`, Task 2) drives create-vs-reuse. Fail-closed: a failed
      // listing must NOT look like "no pages" (that would recreate everything). This is NOT the sitemap —
      // a page created + manifested but not yet finalized into the sitemap is still in EXISTENCE, so a
      // crash-after-create converges to REUSE, not a duplicate (C1).
      const enumd = await genpageCli.enumerateEnv();
      if (!enumd.ok) throw new BuildHalt(`generative-page existence enumeration failed — refusing to (re)create pages against an unknown page set: ${enumd.error}`, { phase: 'pages', code: 'pages-existence-failed', recoverable: true });

      // MEMBERSHIP (this app's live sitemap, Task 1) — fail-closed & discriminated (C4). Fetched BEFORE
      // reconcile because reconcile's provenance guard needs the sitemap id set (a spec pageId may bind
      // only when it is a proven member of THIS app). A page-bearing build has just created or is editing
      // the app, so the sitemap MUST be readable; ok:false is a real failure, never "empty". A fresh app's
      // sitemap is validly empty of genpages here → ids:[] (correct). Reused below for the removal gate.
      const membership = await fetchSitemap(provision, appUnique);
      if (!membership.ok) throw new BuildHalt(`could not read the app sitemap (${membership.reason}) — refusing to proceed without verifying the app's page set`, { phase: 'pages', code: 'pages-sitemap-read-failed', recoverable: true });
      const sitemapIds = membership.ids;

      // IDENTITY (the durable manifest, discriminated read). A PRESENT-but-unparseable manifest is CORRUPT
      // and must HALT fail-closed BEFORE reconcile — reconciling it as "no identity" would recreate the
      // app's existing pages as orphans. An ABSENT manifest (present:false) is normal for a fresh app.
      const { id: readId, manifest, text, present } = await readPageManifest(provision, appUnique);
      if (present && !manifest) throw new BuildHalt(`the page manifest ${manifestResourceName(appUnique)} exists but is corrupt/unparseable — refusing to proceed (would risk recreating existing pages as orphans). Fix or delete the web resource and rebuild.`, { phase: 'pages', code: 'pages-manifest-corrupt', recoverable: false });
      let manifestId = readId;
      let lastManifestContent = text;

      // Reconcile by EXISTENCE (create-vs-reuse) + MEMBERSHIP (spec-pageId provenance, C3). Conflicts (a
      // spec pageId that is not a GUID, a spec/manifest disagreement where both ids are live, or two keys
      // → one live id) HALT — refusing to overwrite/misbind an arbitrary page.
      const { keyToId, conflicts } = reconcilePageIds(spec.pages, manifest, enumd.ids, sitemapIds);
      if (conflicts.length) throw new BuildHalt(`generative-page identity conflict(s): ${JSON.stringify(conflicts)} — refusing to overwrite/misbind a page. Resolve the duplicate/mismatched id(s) in the spec/manifest and rebuild.`, { phase: 'pages', code: 'pages-identity-conflict', recoverable: false });

      // DUPLICATE-NAME MATERIALIZATION GATE (post-reconciliation). validateAppSpec TOLERATES a duplicate
      // page name only when every colliding page is PRE-EXISTING (carries a pageId) — but a spec pageId is a
      // CLAIM, not proof of live existence. reconcilePageIds is the authority: a stale/unprovenanced id (e.g.
      // a page deleted in Maker since this snapshot was downloaded) is NOT bound into keyToId, so the upload
      // loop below would CREATE it fresh and re-materialize the duplicate the app-spec rule meant to prevent.
      // A dup-name group is safe ONLY when EVERY member reconciled to a live id (all id-matched UPDATEs). If
      // any member is unbound (would be created), HALT before any write — matching the validation rule's
      // intent (never CREATE a duplicate name) rather than creating it and only catching it in verify after
      // the pages/manifest/sitemap were already written.
      const pagesByLowerName = new Map();
      for (const p of spec.pages || []) {
        if (!p || !p.name) continue;
        const nl = String(p.name).toLowerCase();
        const arr = pagesByLowerName.get(nl) || [];
        arr.push(p);
        pagesByLowerName.set(nl, arr);
      }
      for (const group of pagesByLowerName.values()) {
        if (group.length < 2) continue;
        const unbound = group.filter((p) => !keyToId.has(p.key || p.name));
        if (unbound.length) {
          throw new BuildHalt(`refusing to CREATE a duplicate-named generative page: ${unbound.length} of ${group.length} pages named '${group[0].name}' are NOT bound to an existing deployed page (their pageId is absent/stale — e.g. the page was deleted in Maker since this spec was downloaded), so this build would re-materialize the duplicate. Re-download the app for fresh page ids, or rename/remove the stale page(s) in the spec.`, { phase: 'pages', code: 'pages-duplicate-name-create', recoverable: false });
        }
      }

      // ── Imp6: DESTRUCTIVE-REMOVAL GATE. Runs even when spec.pages is empty, and BEFORE any sitemap write
      // (the app-shell existing-app write is now deferred to the finalizer below, so nothing has stripped
      // the live pages yet). The app's CONFIRMED live page set is MEMBERSHIP ∩ EXISTENCE — sitemap ids that
      // still exist env-wide (a stale SubArea whose page was deleted in Maker is dropped, so it is never
      // mis-flagged as "removed"). keptIds are the CONFIRMED reconciled ids (keyToId), NOT raw spec pageIds
      // (an unprovenanced spec pageId is not bound, so it cannot mask a real removal). A live page the spec
      // no longer keeps would be orphaned by the rebuild → HALT with a report, UNLESS --allow-destructive,
      // in which case the scope is DETACH-only: the finalizer omits the page's SubArea (no page-record
      // delete). New (absent) pages aren't in the live set, so they are never flagged.
      const existenceLower = new Set(enumd.ids.map((id) => String(id).toLowerCase()));
      const keptIds = new Set(Array.from(keyToId.values()).map((id) => String(id).toLowerCase()));
      const liveAppIds = sitemapIds.filter((id) => existenceLower.has(String(id).toLowerCase()));
      const removedIds = liveAppIds.filter((id) => !keptIds.has(String(id).toLowerCase()));
      if (removedIds.length && opts.allowDestructive !== true) throw new BuildHalt(`refusing to orphan ${removedIds.length} generative page(s) the spec removed but the app still references: ${removedIds.join(', ')}. Re-run with --allow-destructive to detach them (the page records are LEFT deployed; only the app's nav SubAreas are removed), or restore them to the spec.`, { phase: 'pages', code: 'pages-removed', recoverable: false });

      // ── Imp5: SHARED-PAGE DETECTION (report-only, FAIL-CLOSED). A page we are about to UPDATE (a reused
      // id in keyToId) that ALSO belongs to ANOTHER app's sitemap is shared (`pac genpage add`) — updating
      // its content would mutate a page another app uses. GROUNDED (live probe): a genpage has NO
      // appmodulecomponent row, so the ONLY membership signal is the sitemap XML; there is no direct
      // genpage→apps join, so we scan every OTHER app's sitemap (fetchAppsForPages; `excludeAppUnique` self-
      // skips, so a single-app env reads zero other sitemaps). FAIL-CLOSED: an env-scan failure OR any app
      // whose sitemap we cannot read HALTs — an unreadable app could be the one that shares the page, so we
      // cannot prove non-sharing. On positive detection (id in ≥1 other app) → HALT (never auto-modify);
      // --allow-destructive does NOT authorize cross-app mutation (this HALT has no escape by design).
      const updateIds = Array.from(keyToId.values());
      if (updateIds.length) {
        const scan = await fetchAppsForPages(provision, updateIds, { excludeAppUnique: appUnique });
        if (!scan.ok) throw new BuildHalt(`could not scan the environment for pages shared across apps (${scan.error}) — refusing to UPDATE a page without verifying it is not shared. Re-run to retry.`, { phase: 'pages', code: 'pages-shared-check-failed', recoverable: true });
        if (scan.unreadable.length) throw new BuildHalt(`cannot verify pages are not shared across apps — ${scan.unreadable.length} app(s) had an unreadable sitemap (${scan.unreadable.join(', ')}); one of them could share a page we are about to UPDATE. Fix or remove the unreadable app(s), then rebuild.`, { phase: 'pages', code: 'pages-shared-check-failed', recoverable: true });
        if (scan.byId.size) {
          const shared = Array.from(scan.byId, ([id, apps]) => `${id} (also in ${apps.join(', ')})`);
          throw new BuildHalt(`generative page(s) shared across apps: ${shared.join('; ')} — refusing to UPDATE a page another app's sitemap references (a rebuild would mutate shared content). Detach it in Maker, or give this app its own page.`, { phase: 'pages', code: 'pages-shared-across-apps', recoverable: false });
        }
      }

      const persistNow = async () => { const pr = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId, lastManifestContent); manifestId = pr.id; lastManifestContent = pr.content; };

      const keyOf = (p) => p.key || p.name;
      const canonicalPath = (p) => path.resolve(opts.appDir || '.', normalizePageSource(p).codeFile);
      const implemented = [];
      // `spec.pages || []` — the phase can run with no spec pages (a removal-only / detach run reaches here
      // for the removal gate + sitemap finalize), so never assume spec.pages is an array.
      for (const p of spec.pages || []) {
        const src = normalizePageSource(p);
        if (src && src.kind === 'tsx' && src.codeFile) implemented.push(p);
        else runner.skip('pages', `page "${p.name}" (no tsx source)`);
      }

      // (1) STRUCTURAL SCAN of every implemented canonical source BEFORE any write (C1/C4), via the single
      //     nav oracle (extractNavTargets). Reject a malformed (non-canonical) nav PAGEREF and enforce EXACT
      //     parity between declared navigatesTo targetKeys and the keys the source references at REAL nav
      //     call sites — a decoy "PAGEREF_" string or a stray GUID in a comment can never pass.
      //     new-Important-1 (OVERRIDE 2): additionally reject `dynamic` (variable/expression) and `literal`
      //     (hardcoded GUID) nav pageIds — a nav target must always be a declared "PAGEREF_<key>" symbol.
      const sourceByKey = new Map();
      for (const p of implemented) {
        const code = fs.readFileSync(canonicalPath(p), 'utf8');
        sourceByKey.set(keyOf(p), code);
        const malformed = navMalformedRefs(code);
        if (malformed.length) throw new BuildHalt(`page "${p.name}" has malformed navigation reference(s): ${malformed.join(', ')} — a cross-page link must be a double-quoted "PAGEREF_<key>" pageId literal`, { phase: 'pages', code: 'pages-malformed-navref', recoverable: false });
        const { declaredNotReferenced, referencedNotDeclared } = navTargetParity((p.navigatesTo || []).map((n) => n.targetKey), navReferencedKeys(code));
        if (declaredNotReferenced.length || referencedNotDeclared.length) throw new BuildHalt(`page "${p.name}" navigation parity mismatch — declared-but-absent: [${declaredNotReferenced.join(', ')}], referenced-but-undeclared: [${referencedNotDeclared.join(', ')}]`, { phase: 'pages', code: 'pages-nav-parity', recoverable: false });
        // new-Important-1 (fail-closed): a nav pageId must be a DECLARED "PAGEREF_<key>" — never a dynamic
        // expression (unverifiable target) or a hardcoded GUID literal in CANONICAL source (breaks cross-env
        // recreate and ships nav the design never declared). extractNavTargets classifies each nav call site's
        // pageId; 'pageref'-not-declared is already caught by navTargetParity, so here reject 'dynamic' + 'literal'.
        const badNav = extractNavTargets(code).filter((t) => t.kind === 'dynamic' || t.kind === 'literal');
        if (badNav.length) throw new BuildHalt(`page "${p.name}" has ${badNav.length} undeclared/non-symbolic navigation target(s) (dynamic expression or hardcoded page GUID) — cross-page navigation must use a double-quoted "PAGEREF_<key>" pageId declared via navigatesTo`, { phase: 'pages', code: 'pages-nav-parity', recoverable: false });
      }

      const navTargets = new Set();
      for (const p of implemented) for (const n of p.navigatesTo || []) navTargets.add(n.targetKey);
      const mintedKeys = new Set();
      const deployment = new Map(); // key -> resolved code (nav sources only)

      // (2+3) Inside ONE "resolve cross-page navigation" step: create-absent-first for ABSENT nav TARGETS
      //       (upload symbolic source to mint an id; persist the manifest IMMEDIATELY after EVERY create for
      //       crash-safety, C5), then RESOLVE the graph once every referenced target has an id (fail-closed
      //       on a dangling target).
      if (appHasCrossPageNav(spec)) {
        await runner.run('pages', 'resolve cross-page navigation', async () => {
          for (const p of implemented) {
            const key = keyOf(p);
            if (keyToId.has(key) || !navTargets.has(key)) continue; // only ABSENT targets need pre-minting
            const up = await genpageCli.upload({ appId: result.created.app, codeFile: canonicalPath(p), name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
            keyToId.set(key, up.pageId);
            result.created.pages[key] = up.pageId;
            mintedKeys.add(key);
            await persistNow();
          }
          const navSources = new Map();
          for (const p of implemented) if ((p.navigatesTo || []).length) navSources.set(keyOf(p), { code: sourceByKey.get(keyOf(p)) });
          const { deployment: dep, unresolved } = resolvePageRefs(navSources, keyToId);
          if (unresolved.length) throw new BuildHalt(`unresolved cross-page navigation target(s): ${unresolved.join(', ')} — a page navigates to a key that isn't a built page`, { phase: 'pages', code: 'pages-dangling-navref', recoverable: false });
          for (const [k, code] of dep) deployment.set(k, code);
          return `${deployment.size} navigation source(s)`;
        });
      }

      // (4) UPLOAD-ONCE — exactly one runner.run/skip per page. A non-nav page already minted in step 2 is
      //     final (skip). Every UPDATE asserts the returned id matches the requested id (I7). Persist the
      //     manifest immediately after each create (C5).
      //
      // #changed-only selectedKeysOnly: on a pages-only fast apply, upload ONLY the changed page keys — the
      // whole-app scan/reconcile/removal/shared checks above still run over ALL pages (safety), but
      // re-uploading an UNCHANGED page would clobber an out-of-band Maker edit to it (Sol #1 / data loss).
      // keyToId already holds every existing page's live id (reconciled from the manifest/enumerate), so a
      // changed page that navigates to an unchanged page still resolves its target without re-uploading it.
      const selectedKeys = opts.changedOnly && Array.isArray(opts.changedOnly.selectedKeys) ? new Set(opts.changedOnly.selectedKeys) : null;
      for (const p of implemented) {
        const key = keyOf(p);
        if (selectedKeys && !selectedKeys.has(key)) { runner.skip('pages', `page "${p.name}" (unchanged — changed-only)`); continue; }
        const isNav = (p.navigatesTo || []).length > 0;
        if (!isNav && mintedKeys.has(key)) { runner.skip('pages', `page "${p.name}" (created)`); continue; }
        await runner.run('pages', `page "${p.name}"`, async () => {
          const requestedId = keyToId.get(key);
          // Capture the EXACT bytes we upload so the caller can record a MEASURED deployedSha (a nav source's
          // deployed bytes differ from its canonical source — PAGEREF_ is resolved to GUIDs — so deployedSha
          // must never be assumed equal to the source hash). For a non-nav page the deployed bytes ARE the
          // canonical file content.
          const deployedBytes = isNav ? deployment.get(key) : fs.readFileSync(canonicalPath(p), 'utf8');
          const codeFile = isNav ? writeStagingFile(stagingDir, key, deployment.get(key)) : canonicalPath(p);
          const up = await genpageCli.upload({ appId: result.created.app, pageId: requestedId, codeFile, name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
          // I7: an UPDATE (requestedId set) must return the SAME id, else a resolved sibling could point at
          // a stale target. Case-insensitive (Dataverse may echo a differently-cased GUID).
          if (requestedId && String(up.pageId).toLowerCase() !== String(requestedId).toLowerCase()) throw new BuildHalt(`page "${p.name}" UPDATE returned a different id (${up.pageId} != ${requestedId}) — refusing to finalize with an inconsistent target`, { phase: 'pages', code: 'pages-update-identity-mismatch', recoverable: false });
          // Key by the STABLE key (p.key||p.name): appDef resolves result.pages[s.page] where s.page is the
          // migrated KEY (:506). Keying by name left v2 key-referenced subareas unresolved.
          keyToId.set(key, up.pageId);
          result.created.pages[key] = up.pageId;
          result.created.pageDeployedShas[key] = sha256(deployedBytes);
          await persistNow(); // manifest carries this id BEFORE the next create (crash-safety, design §9 / C5)
          return up.pageId;
        });
      }

      // (5) Persist the FINAL manifest (deduped no-op after per-create persists). Skipped for a page-less
      //     (removal-only / detach) run — there is no page identity to record, and writing an empty manifest
      //     would needlessly create/update the web resource. The scan/create/upload steps above are already
      //     no-ops when spec.pages is empty (they iterate over spec.pages / implemented).
      if ((spec.pages || []).length) {
        await runner.run('pages', `page manifest ${manifestResourceName(appUnique)}`, async () => { await persistNow(); return manifestResourceName(appUnique); });
      }
      // (6) Finalize the sitemap (the true commit point — only after all resolved uploads succeed). For a
      //     page-backed app this writes the resolved GenPage SubAreas. For an EXISTING app the app-shell
      //     write was deferred, so this is the SOLE existing-app sitemap write — including the intentionally
      //     page-less sitemap on an authorized removal/detach (result.created.pages is empty, so appDef emits
      //     no GenPage SubAreas). A FRESH page-less app already had its sitemap written by the app-shell
      //     create path, so it needs no finalize here.
      // #changed-only (pages-only content re-upload): the finalize below rebuilds the WHOLE sitemap via
      // appDef(spec, result.created) and rewrites /siteMap + components. In a pages-only apply result.created
      // holds only app+pages, so appDef would THROW on any dashboard subarea (:610-611, result.dashboards
      // empty) and STRIP the app's form/view/chart component registrations (:635). A pure content re-upload
      // leaves the key→pageId map unchanged, so the sitemap needs no rewrite — skip the finalize in that
      // submode. Any sitemap-changing apply (and every full build) still finalizes.
      const skipSitemapFinalize = !!(opts.changedOnly && opts.changedOnly.skipSitemapFinalize);
      if (!skipSitemapFinalize && (appHasPageSubareas(spec) || appWasExisting)) {
        await runner.run('pages', 'finalize sitemap (genpage subareas)', async () => {
          await provision.fetchArtifact('app', result.created.app);
          const full = appDef(spec, result.created);
          await provision.updateElement('app', result.created.app, '/siteMap', full.siteMap);
          requireSuccessfulPush(await provision.pushArtifact('app', result.created.app), 'app sitemap finalize', opts.warn);
          reportPartialPush(await provision.publishArtifact('app', result.created.app), `app ${(spec.app && spec.app.name) || result.created.app}`, opts.warn);
          return result.created.app;
        });
      }
    } finally {
      // Always clean up run-scoped staging (never leave env GUIDs on disk) and release the advisory lease.
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      lease.release();
    }
  }

  // 7b-ii. Modern ("new look") shell — opt-in via `app.newLook`.
  //
  // This is a per-app SETTING, not an appmodule column: `navigationtype` (the only nav-ish column the
  // SDK writes) is Single/Multi *session* and unrelated. Of the several new-look definitions Dataverse
  // ships, `NewLookAlwaysOn` is the one worth writing — its own description says it "enables the new
  // look and hides the user switch", and that when it is on the user-facing "New look for model driven
  // apps" preference "will have no effect". The alternatives (`NewLookOptOut`,
  // `NewLookModernExperienceOct2023`) both DEFAULT to true and are per-user toggles, so writing them
  // would give a result the app author cannot actually depend on.
  //
  // Runs in the app-shell phase, right after the app exists, and is scoped to the app + solution so it
  // travels on export/import. Best-effort by design: a tenant where the definition is absent (it is a
  // platform feature that rolls out) must not fail an otherwise-good build, so a failure is reported
  // and the build continues — the app is fully functional, just on the classic shell.
  if (has('app-shell') && spec.app && spec.app.newLook === true && result.created.app) {
    // Deliberately NOT inside runner.run: that helper turns any throw into a BuildHalt, and failing
    // an otherwise-good app build because a rolling-out preview setting is unavailable in this tenant
    // is the wrong trade. But a silent ✓ would be worse — reporting success for something that did not
    // happen is the exact failure mode this build has had to fix elsewhere. So: warn, record the real
    // outcome, and let the caller see `newLook: false` rather than infer it.
    try {
      await provision.saveSettingValue(NEW_LOOK_SETTING, 'true', {
        appUniqueName: appUniqueName(spec),
        solutionUniqueName: spec.solution && spec.solution.uniqueName,
      });
      result.created.newLook = true;
    } catch (err) {
      result.created.newLook = false;
      const detail = (err && err.message) || String(err);
      if (typeof opts.warn === 'function') {
        opts.warn(`could not enable the new look (${NEW_LOOK_SETTING}): ${detail} — the app is fully built and functional, but stays on the classic shell. This setting is a platform feature that rolls out by tenant.`);
      }
    }
  }

  // 7b-iii. Wave 2 header + navigation refresh — stated via `app.headerNavigationRefresh`.
  // Deliberately not called "opt-in": the platform default is ON (see below), so this field exists
  // as much to turn the feature OFF as on. Absent means "no opinion" and touches nothing.
  //
  // DISTINCT from `newLook` above, and both can be set independently. `NewLookAlwaysOn` is the
  // new-look shell toggle; `HeaderAndNavigationRefresh` is the Wave 2 header/navigation redesign
  // (public preview). They are separate `settingdefinition` rows and enabling one does not enable
  // the other.
  //
  // Written through the SDK's dedicated `setHeaderAndNavigationRefresh` rather than a raw setting
  // write, because the encoding is a trap: this is a `datatype = 0` (Number) TRI-STATE where ON is
  // '2', not '1'. The SDK's own note records that of the nine Number settings with rows in a live
  // org, eight use '1' for on and only this one uses '2' — and that writing '1' is ACCEPTED by the
  // API and then silently fails to enable the feature. Hand-rolling this is how you ship a green
  // build with the feature off.
  //
  // Same best-effort contract as the new look: this is a rolling-out preview, so a tenant without
  // the definition gets a warning and the real outcome, never a silent success and never a failed
  // build. The SDK throws a plain Error (not an SdkError subclass) when the definition is absent, so
  // this catches broadly on purpose.
  //
  // BOTH values are honoured, and that is not symmetry for its own sake. Verified against the real
  // vendored bundle (offline, by capturing the writes a push issues): the SDK
  // defaults the app artifact's `headerAndNavigationRefresh` to TRUE, and pushing a new app writes
  // the setting to '2' (ON) unprompted. So the platform default is ON, not off — and treating
  // `false` as "do nothing" would silently leave it ON for an author who explicitly asked for it to
  // be off. `false` therefore has to be an active write of the OFF value, not a skip.
  if (has('app-shell') && spec.app && typeof spec.app.headerNavigationRefresh === 'boolean' && result.created.app) {
    const wanted = spec.app.headerNavigationRefresh;
    try {
      const outcome = await provision.setHeaderAndNavigationRefresh(result.created.app, wanted);
      // AppSettingWriteOutcome is 'created' | 'updated' | 'unchanged' — all three mean the row now
      // holds the requested value, so all three are success. Recorded verbatim so a caller can tell
      // a fresh write from a no-op re-run.
      result.created.headerNavigationRefresh = wanted;
      result.created.headerNavigationRefreshOutcome = outcome;
    } catch (err) {
      // Report what actually happened, NOT what was asked for. On failure the row keeps whatever it
      // had — which for a newly created app is the SDK's ON default, so reporting `false` here would
      // be as wrong as reporting success.
      result.created.headerNavigationRefresh = 'unknown';
      const detail = (err && err.message) || String(err);
      if (typeof opts.warn === 'function') {
        opts.warn(`could not ${wanted ? 'enable' : 'disable'} the header and navigation refresh (${HEADER_NAV_SETTING}): ${detail} — the app is fully built and functional, but the header and navigation setting is whatever the platform defaulted it to. This setting is a public-preview feature that rolls out by tenant.`);
      }
    }
  }

  // 7c. AI features (opt-in via spec.ai). Enable app-level agents (gated on admin settings) +
  //     configure per-table row summaries. All AI writes are best-effort-gated: setAppAiFeatures
  //     skips features whose admin gate is off; it never throws.
  // Features the SDK did not put in `applied`, deferred for a post-publish re-proof (see inside the
  // ai-features phase for why the verdict cannot honestly be decided at write time).
  const pendingAiReconfirm = [];

  if (has('ai-features') && spec.ai !== undefined && spec.ai !== null) {
    const solutionUniqueName = spec.solution && spec.solution.uniqueName;
    const appUnique = appUniqueName(spec);
    const flags = resolveAiFlags(spec);
    // NOTE: this first write frequently NO-OPS. An app-scope setting write does nothing until the
    // app is published, and this phase runs moments after `app-shell` created it (the `publish`
    // phase is later, and is opt-in). It is still issued here so an ALREADY-published app — the
    // common case on a rebuild/edit — applies immediately and needs no retry. Anything it does not
    // apply is re-issued after publish by the block at the end of this function, which replicates
    // the fetch → publish → write sequence measured to work live.
    await runner.run('ai-features', 'enable app AI features', async () => {
      // The SDK confirms each app-scope write by polling for its `appsettings` override row, keyed by
      // appmoduleid. That id is normally resolved from the app's unique NAME — but a freshly created
      // appmodule is not readable until it is PUBLISHED (Dataverse omits it from list queries and 404s
      // the by-id retrieve), and this phase runs moments after `app-shell` created it. The by-name
      // lookup is the ONLY piece that fails pre-publish; the `appsettings` proof query itself works
      // fine. Passing the id we already hold skips the lookup entirely and lets the write be proven
      // here, in the same phase that made it.
      //
      // The SDK still re-checks the id against the published app when the app IS readable, so a stale
      // or wrong id is rejected rather than silently used to configure another app.
      //
      // A modest retry budget still helps: on an established app the override row is queryable ~580ms
      // after the write (measured live), so the SDK's 4-attempt/500ms default is tight but the budget
      // is only ever spent when the row is genuinely absent.
      const r = await provision.setAppAiFeatures(appUnique, flags, {
        solutionUniqueName,
        appModuleId: result.created.app || undefined,
        verifyAttempts: 8,
        verifyDelayMs: 1000,
      });
      result.created.ai.appFeatures = r;
      // `applied` is the SDK's ONLY success bucket: a feature reaches it only when the APP-SCOPE
      // override row is proven present holding the requested value. Every other bucket is a
      // non-success the build must surface, because reporting them as plain success was the
      // false-PASS half of ADO 6603383 (features were pushed onto `applied` while writing nothing):
      //   notPersisted — the write returned 204 but no override was observed for the whole retry
      //                  budget; Dataverse can accept an app-scope write and store nothing.
      //   unverified   — the write was issued but the proof could not be READ (no access to
      //                  appsettings/settingdefinitions/appmodules, or a transport error).
      //   failed       — the write (or its org-gate read) threw. The SDK keeps going so the rest
      //                  of the batch still reports, so this arrives as data, never as an exception.
      //
      // RE-CONFIRMATION (safety net): with `appModuleId` supplied above, the SDK can prove the
      // override row here, pre-publish, so the normal path decides the verdict in this phase. The
      // deferral below remains for the residual cases the proof genuinely cannot settle yet — a
      // transient read failure, or a row that has not materialized inside the retry budget. Deciding
      // "NOT PERSISTED" on those would print a scary and WRONG verdict that `--verify` then
      // contradicts in the same run, so the buckets are recorded and re-proved after publish (see
      // `reconfirmAiFeatures` below) against the identical override-row oracle the verifier uses.
      // The re-proof can only ever UPGRADE a feature, never hide a real failure.
      //
      // Derive the non-success buckets from the RESULT, not a fixed list: a bucket added by a future
      // SDK revision is then reported verbatim rather than silently dropped (which is the very bug
      // class this phase exists to remove). `outcomes` is per-feature detail, not a bucket.
      const problemKeys = Object.keys(r || {}).filter((k) => k !== 'applied' && k !== 'skipped' && k !== 'outcomes' && Array.isArray(r[k]) && r[k].length);
      for (const key of problemKeys) {
        for (const feature of r[key]) {
          const outcome = (r.outcomes || []).find((o) => o && o.feature === feature);
          pendingAiReconfirm.push({ feature, bucket: key, reason: outcome && outcome.reason });
        }
      }
      const parts = [];
      if (r.applied && r.applied.length) parts.push(`applied: ${r.applied.join(', ')}`);
      if (r.skipped && r.skipped.length) parts.push(`skipped (admin gate off): ${r.skipped.join(', ')}`);
      if (pendingAiReconfirm.length) parts.push(`retrying after publish: ${pendingAiReconfirm.map((p) => p.feature).join(', ')}`);
      return parts.length ? parts.join('; ') : '(none \u2014 admin gate off)';
    });
    // Same rule as the plan: `selectSummaryTables` owns the default-vs-override decision, so calling
    // it unconditionally is what lets `default: 'off'` + `tables[x].enabled: true` opt a single table
    // back in. Short-circuiting here made the plan and the execution agree only by both being wrong.
    const tables = selectSummaryTables(spec);
    // Row summaries are an AI Builder / Copilot-LICENSED capability, gated per environment
    // INDEPENDENTLY of the `EnableFormInsights` org setting: an environment can report the feature
    // "on" and still refuse the publish. Live-observed on an environment whose gate reads on:
    //   HTTP 403 from .../api/data/v9.0/AIModelPublish
    //   {"operationStatus":"Error","error":{"type":"Error","code":"ModelNotSupported",
    //     "message":"This scenario is not supported in this environment.",
    //     "properties":{"exceptionStackTrace":"   at Microsoft.PowerAI...LicenseChecker..."}}}
    // — i.e. a licence check, reported as a 6 KB .NET stack trace the operator can do nothing with.
    //
    // Halting there abandons a build that already created the solution, tables, columns, views, the
    // app and its AI feature settings, for a reason no change to the spec can fix. So degrade the way
    // business rules and `app.newLook` already do: skip the artifact, say so specifically, and let the
    // rest of the build finish. Nothing wrong is written — the summary simply does not exist, and the
    // skip is recorded on the result so the run summary reports it instead of implying it was created.
    let aiSummaryGateWarned = false;
    // Tables whose skipped publish may have left a committed `msdyn_aimodel` row behind.
    const pendingAiSummarySweeps = [];
    // `tables` keys are documented as entity schemaNames matched CASE-INSENSITIVELY, and
    // `selectSummaryTables` honours that when deciding what to build. Looking the override back up by
    // exact (or merely lower-cased) key therefore selected the table but dropped its `instruction` and
    // `columns` whenever the author's spelling differed from the entity's — silently substituting the
    // generated default prompt for the one they wrote. Build the same case-folded index the selector
    // uses so the two agree.
    const summaryOverrides = new Map();
    for (const [key, val] of Object.entries((spec.ai.summaries && spec.ai.summaries.tables) || {})) {
      summaryOverrides.set(String(key).toLowerCase(), val);
    }
    const DUPLICATE_MODEL_REASON = 'a model with this name already exists';
    const aiSummaryUnsupported = (err) => {
      const detail = `${(err && err.message) || ''} ${JSON.stringify((err && err.cause) || '')}`;
      // Match the platform's own error CODE, not the prose: the message is localized and the status
      // alone (403/400) is also what a plain privilege or validation failure returns, which must
      // still halt. `err.cause` carries the parsed error BODY (where `code` lives) while `err.message`
      // carries only the localized text, so both are searched — on a non-English org the code is
      // reachable only through `cause`.
      //
      // `DuplicateRecordKey` is in this set for a specific, measured reason. `configureRowSummary`
      // CREATES the `msdyn_aimodel` row and THEN publishes it, so on a gated environment the licence
      // check fails at publish with the row already committed:
      //   HTTP 400 ... "code":"DuplicateRecordKey" ... Cannot insert duplicate key row in object
      //   'dbo.msdyn_AIModelBase' with unique index 'ndx_Uniquename'. The duplicate key value is
      //   (<table> row summary, ...)
      // on the NEXT build. Without this, skipping the licence gate would make the first build pass
      // and every rebuild fail — strictly worse than failing consistently. The orphan is also swept
      // below so the row does not accumulate.
      //
      // The two are reported as DIFFERENT reasons: telling an operator their environment is
      // unlicensed when the real cause is a leftover row sends them to the wrong place entirely.
      if (/DuplicateRecordKey/i.test(detail)) return DUPLICATE_MODEL_REASON;
      return /ModelNotSupported|not supported in this environment/i.test(detail)
        ? 'unsupported in this environment'
        : false;
    };
    // Best-effort sweep of the row the failed publish left behind. The SDK names the model
    // "<entity> row summary" — which is also the value the platform quotes back in the duplicate-key
    // error above ("The duplicate key value is (zza_ticket row summary, ...)"), so this matches the
    // real stored name rather than a guess.
    //
    // FILTERED SERVER-SIDE, not fetched-and-scanned. `msdyn_aimodel` is a shared system table written
    // by AI Builder, Copilot Studio and other features, so a real org can hold far more rows than any
    // safety cap — an unfiltered page would silently fail to contain the orphan, leaving it forever
    // and making every rebuild fail on the duplicate key. That is the exact failure this sweep exists
    // to prevent, so the query must not depend on the orphan happening to land in the first page.
    //
    // Failure here is never fatal: the build already decided to skip, and a leftover row degrades the
    // next run at worst — it must not turn a warn-and-continue back into a halt.
    const sweepOrphanSummaryModel = async (logical) => {
      const modelName = `${String(logical).toLowerCase()} row summary`;
      try {
        const rows = await provision.queryRecords('msdyn_aimodel', {
          select: ['msdyn_aimodelid'],
          filter: `msdyn_name eq '${odataLit(modelName)}'`,
          top: 5,
        });
        for (const row of rows || []) {
          try { await provision.deleteRecord('msdyn_aimodel', row.msdyn_aimodelid); } catch { /* leave it; the next run reports it again */ }
        }
      } catch { /* no read access to msdyn_aimodel is not a build failure */ }
    };
    try {
      for (const logical of tables) {
        const ent = (spec.entities || []).find((e) => String(e.schemaName).toLowerCase() === String(logical).toLowerCase());
        if (!ent) continue;
        const override = summaryOverrides.get(String(logical).toLowerCase());
        await runner.run('ai-features', `row summary for ${logical}`, async () => {
          const promptSpec = buildPromptSpec(ent, { spec, override });
          const res = await provision.configureRowSummary(promptSpec, { solutionUniqueName });
          result.created.ai.summaries[logical] = res;
          return res.modelId;
        }, {
          skipIf: (err) => {
            const reason = aiSummaryUnsupported(err);
            if (!reason) return false;
            result.skipped.aiSummaries.push(logical);
            pendingAiSummarySweeps.push(logical);
            // Warn ONCE per build: on a gated environment every table skips for the same reason, and
            // N copies of the same paragraph buries the rest of the output.
            if (!aiSummaryGateWarned && typeof opts.warn === 'function') {
              aiSummaryGateWarned = true;
              opts.warn(reason === DUPLICATE_MODEL_REASON
                ? `AI row summaries were NOT created: an AI model named "<table> row summary" already exists for a table in this spec, so the platform refused to create another (duplicate key on 'ndx_Uniquename'). This is normally residue from an earlier run whose publish was refused after the model row was committed; the leftover row is removed so the next build can retry. Everything else in the app was built normally.`
                : `AI row summaries were NOT created: this environment does not license the row-summary (AI Builder) capability, so there is no supported way to author them here — the org's 'EnableFormInsights' setting can read ON and the publish still be refused. Everything else in the app was built normally. Re-run against a licensed environment, or set ai.summaries.default to "off" (with no per-table enabled:true) to stop requesting them.`);
            }
            return reason;
          },
        });
      }
    } finally {
      // In a `finally` on purpose: a LATER table failing for an unrelated (non-skippable) reason
      // throws out of the loop, and without this the orphan already queued by an EARLIER skipped
      // table would never be swept — leaving exactly the duplicate-key residue this sweep exists to
      // remove, and making every future rebuild fail on it.
      //
      // Swept here rather than inside `skipIf` because `skipIf` is synchronous and cannot await.
      for (const logical of pendingAiSummarySweeps) await sweepOrphanSummaryModel(logical);
    }
  }

  // 7c. Security (persona roles). Author ONE security role per persona (role name = persona), sized to
  //     the UNION of every job's declared entity access; the SDK converges the privilege set via
  //     ReplacePrivilegesRole, so this is idempotent and a re-run REMOVES a privilege dropped from the
  //     spec. Runs AFTER app-shell so the app module exists to be (a) read via the injected appmodule
  //     privilege and (b) associated to the role so the app opens for the persona. All writes go through
  //     the header-less `provision` client and role solution membership is added explicitly (same
  //     pattern as app/forms/views), because — like appmodule/savedquery creates — a create carrying the
  //     MSCRM.SolutionUniqueName header is rejected; the role lands in the default solution and is then
  //     moved into the app's solution.
  if (has('security')) {
    const appId = result.created.app; // null when app-shell is excluded from this run (partial phases)
    for (const persona of spec.personas || []) {
      const roleSpec = personaRoleSpecFor(persona);
      const roleName = canonicalPersonaName(persona); // trimmed identity — matches the SDK + teardown/verify
      await runner.run('security', `security role "${roleName}"`, async () => {
        let rr;
        try {
          rr = await provision.createPersonaRole(roleSpec);
        } catch (err) {
          // Fail-closed on any SDK security error: a SEC-1 conflict (a hand-built or managed same-name
          // role the SDK refuses to adopt) or an apply-time metadata guard (an entity that does not
          // support a requested access, or the shared-privilege same-scope rule). Halt with the SDK's
          // message rather than leave a half-authored access model behind.
          throw new BuildHalt(`security role "${roleName}" could not be authored: ${err && err.message ? err.message : err}`, { phase: 'security', code: 'security-role-failed', recoverable: false });
        }
        result.created.roles[roleName] = rr;
        // Ensure the role is in the app's solution on EVERY run so an export/import carries it.
        // AddSolutionComponent is idempotent server-side (re-adding an existing component returns 200 —
        // live-verified), so this ALSO repairs a role that missed membership on a prior run
        // (created, then the add failed, then reused — a `!reused` gate would skip the repair forever).
        // NOT swallowed: a real failure means the exported solution would omit the role and silently break
        // access in the target env, so it fails the phase fail-closed — same as the app/sitemap adds.
        if (sol && sol.uniqueName) {
          await provision.addSolutionComponent({ componentId: rr.roleId, componentType: COMPONENT_TYPE.role, solutionUniqueName: sol.uniqueName });
        }
        // Reconcile app availability to match `appAccess`: associate so the app appears for the persona
        // (default), or DISSOCIATE when the persona opted out — otherwise a role flipped true->false would
        // keep surfacing the app (the read privilege is converged away, but the association is grant-only).
        if (appId) {
          if (persona.appAccess !== false) await ensureAppAvailableToRole(provision, appId, rr.roleId);
          else await ensureAppNotAvailableToRole(provision, appId, rr.roleId);
        }
        const priv = (rr.appliedPrivileges || []).length;
        const assigned = (rr.assignedTeams || []).length + (rr.assignedUsers || []).length;
        return `${rr.reused ? 'reused' : 'created'} — ${priv} privilege${priv === 1 ? '' : 's'}${appId && persona.appAccess !== false ? ', app access' : ''}${assigned ? `, ${assigned} assignment(s)` : ''}`;
      });
    }

    // 7b. Offer forms to specific security roles (`forms[].securityRoles`). AB#6648526.
    //
    // This runs in the SECURITY phase, not the forms phase, because a persona's role does not exist
    // until the loop above has run — `forms[]` is built at phase 6, `personas[]` at phase 13.
    //
    // The roles do NOT live in a relationship. MEASURED against a live environment: `systemform`
    // declares no many-to-many relationships and reports
    // `CanBeInManyToMany: { Value: false, CanBeChanged: false }`, there is no `systemformrole`
    // entity, and `role`'s six N:N partners are systemuser / privilege / appmodule / team /
    // application / applicationuser — none of them forms. They live INSIDE `formxml`, as a
    // `<DisplayConditions>` child of `<form>`, which is why only the SDK's dedicated call can write
    // them and why no `associateRecords` shape ever worked.
    //
    // A form with NO DisplayConditions is offered to every role, so this is a RESTRICTION: declaring
    // `securityRoles` narrows a form that was previously universal.
    const formsWithRoles = (spec.forms || []).filter((f) => f && f.securityRoles);
    for (const f of formsWithRoles) {
      const label = `${f.name || f.formType || 'Main'} on ${f.entity}`;
      const formId = result.created.formIds[formIdentityKey(f)];
      if (!formId) {
        // The forms phase did not run in this invocation (`--phases security`, or a --changed-only
        // apply). Skipping is right — silently doing nothing is not, because the author asked for a
        // restriction and its absence is a security-relevant difference.
        runner.skip('security', `form roles for ${label} (form not built in this run — re-run with the forms phase)`);
        continue;
      }
      await runner.run('security', `form roles for ${label}`, async () => {
        const sr = f.securityRoles;
        const opts2 = {};
        if (sr.everyone === true) opts2.everyone = true;
        else {
          // Personas, not GUIDs: the spec names roles the way an author does, and the build resolves
          // them against the roles it just created. An unresolved name is a HALT, not a warning — a
          // typo would otherwise silently produce a form offered to nobody.
          //
          // Matched CASE-INSENSITIVELY, because the spec gate that pre-checks these names is
          // case-insensitive. A case-sensitive lookup here made `personas: ["dispatcher"]` against a
          // declared `"Dispatcher"` pass validation and then halt in phase 7b — the LAST thing the
          // build does, after every table, form, view, chart, dashboard, page and role already
          // exists. That is precisely the half-built outcome the business-rule skip exists to avoid,
          // and it also falsified this function's own promise that a bad name is caught at the gate.
          //
          // This index is only UNAMBIGUOUS because `personas[]` already rejects two names differing
          // solely by case — a rule that lives elsewhere in app-spec.js and was written for an
          // unrelated reason. Nothing links the two, so form-security-roles.test.js pins it: relax
          // that rule and one of the two roles would silently win here, offering a form to the wrong
          // one with every other test still green.
          const roleByLower = new Map(Object.entries(result.created.roles || {})
            .map(([name, rr]) => [String(name).trim().toLowerCase(), rr]));
          opts2.roleIds = (sr.personas || []).map((p) => {
            const rr = roleByLower.get(String(canonicalPersonaName({ persona: p }) || '').toLowerCase());
            if (!rr || !rr.roleId) {
              throw new Error(`securityRoles names persona "${p}", which this build did not create a role for. Declare it in personas[], or use "everyone": true.`);
            }
            return rr.roleId;
          });
        }
        // Both are PRESERVED by the SDK when omitted, so only send what the author actually set —
        // sending `undefined` would be indistinguishable from "reset it" if that ever changes.
        if (sr.fallbackForm !== undefined) opts2.fallbackForm = sr.fallbackForm;
        if (sr.order !== undefined) opts2.order = sr.order;
        await provision.setFormSecurityRoles(formId, opts2);
        return sr.everyone === true ? 'every role' : `${opts2.roleIds.length} role(s)`;
      });
    }
  }

  // 8. Publish (opt-in). Publish ONE artifact per entity (covers that entity's customizations)
  //    + the app — far fewer PublishXml round-trips than publishing every artifact.
  if (has('publish') && publish) {
    await runner.run('publish', 'publish customizations', async () => {
      const seen = new Set();
      const perEntity = []; // [type, id] — first artifact found per entity
      for (const f of spec.forms || []) {
        const k = f.entity.toLowerCase();
        // Prefer the entity's Main form (what `created.forms` holds), but fall back to THIS form's
        // own id. A `securityRoles` assignment lands on the UNPUBLISHED layer — live-measured: the
        // published row still read `<Everyone />` until PublishXml ran — so an entity whose only
        // annotated form is, say, a QuickCreate would otherwise never be published and the
        // restriction would silently not take effect. Publishing is per-ENTITY, so any one of its
        // forms covers the rest.
        const id = result.created.forms[k] || result.created.formIds[formIdentityKey(f)];
        if (id && !seen.has(k)) { seen.add(k); perEntity.push(['form', id]); }
      }
      for (const v of spec.views || []) { const k = v.entity.toLowerCase(); const vid = result.created.views[`${k}|${v.name}`]; if (vid && !seen.has(k)) { seen.add(k); perEntity.push(['view', vid]); } }
      // Charts too — but ONLY the ones this run created or fetched. `publishArtifact` requires the
      // artifact to be workspace-resident (readRaw -> readLocal throws ArtifactNotFoundError rather
      // than lazily fetching), and `findArtifact` does not populate the workspace. Deriving the id
      // from `result.created.charts` would therefore hand publish an id it cannot resolve for an
      // existing chart with no description to reconcile, and the throw escapes publishArtifact and
      // halts the phase. `chartsToPublish` is populated at exactly the two points that put a chart in
      // the workspace. It is also keyed by entity rather than by chart NAME, which sidesteps the
      // `result.created.charts` name-only keying (two same-named charts on different entities
      // collide there).
      for (const [k, cid] of chartsToPublish) { if (cid && !seen.has(k)) { seen.add(k); perEntity.push(['chart', cid]); } }
      await runner.mapLimit(perEntity, concurrency, (async ([type, id]) => reportPartialPush(await provision.publishArtifact(type, id), `${type} ${id}`, opts.warn)));
      if (result.created.app) reportPartialPush(await provision.publishArtifact('app', result.created.app), `app ${(spec.app && spec.app.name) || result.created.app}`, opts.warn);
    });
  }

  // 8b. AI feature re-issue + re-confirmation. An app-scope setting write is a NO-OP on a freshly
  //     created app: measured live on two different apps, the write returned `notPersisted` and a
  //     direct `appsettings` query showed no override row at ALL, while fetching + publishing that
  //     same app and re-issuing the identical call produced every feature `applied` with real rows
  //     holding the requested values. So this pass RE-ISSUES the write (re-proving alone cannot help
  //     — there is nothing to find), then falls back to proving the override row for anything the
  //     retry still did not claim. It can only ever UPGRADE a feature, never hide a real failure.
  if (pendingAiReconfirm.length) {
    const flags = resolveAiFlags(spec);
    const appUnique = appUniqueName(spec);
    const BUCKET_LABELS = {
      notPersisted: ['NOT PERSISTED', 'Dataverse accepted the write but no app-scope override holding the requested value was observed'],
      unverified: ['UNVERIFIED', 'the write was issued but could not be confirmed \u2014 verify manually before relying on it'],
      failed: ['FAILED', 'the write or its org-gate read threw'],
    };
    // Replicate the sequence proven to work live, in order: fetch the app (so the workspace holds the
    // server's copy), publish it, then write. Each step is best-effort — a failure here must not fail
    // the build, it just leaves the original non-success verdict standing and reported.
    const retryApplied = new Set();
    if (result.created.app) {
      const retryFlags = {};
      for (const p of pendingAiReconfirm) if (flags && Object.prototype.hasOwnProperty.call(flags, p.feature)) retryFlags[p.feature] = flags[p.feature];
      if (Object.keys(retryFlags).length) {
        try {
          await provision.fetchArtifact('app', result.created.app);
          reportPartialPush(await provision.publishArtifact('app', result.created.app), `app ${(spec.app && spec.app.name) || result.created.app}`, opts.warn);
          const retry = await provision.setAppAiFeatures(appUnique, retryFlags, {
            solutionUniqueName: spec.solution && spec.solution.uniqueName,
            appModuleId: result.created.app,
            verifyAttempts: 6,
            verifyDelayMs: 1000,
          });
          for (const f of (retry && retry.applied) || []) retryApplied.add(f);
        } catch { /* leave the original verdict standing; it is reported below */ }
      }
    }
    const app = await resolveAppModuleId(provision, appUnique);
    const stillBad = [];
    const reproven = [];
    // Track HOW each feature was recovered so the reported reason is true for that path. Claiming a
    // re-issue applied something the proof merely found is the same "report what you did not verify"
    // failure this whole phase exists to remove.
    const reprovenBy = new Map();
    for (const p of pendingAiReconfirm) {
      if (retryApplied.has(p.feature)) {
        reproven.push(p.feature);
        reprovenBy.set(p.feature, 'applied by the post-publish re-issue (an app-scope write is a no-op before the app is published)');
        continue;
      }
      const setting = AI_APP_SETTING[p.feature];
      let proof = { error: app.error };
      if (!app.error && setting) proof = await proveAppOverride(provision, app.appModuleId, setting);
      if (!proof.error && proof.exists && sameSettingValue(proof.value, featureWantValue(flags && flags[p.feature], p.feature))) {
        reproven.push(p.feature);
        reprovenBy.set(p.feature, 'confirmed present after publish by the build\u2019s own override-row proof');
        continue;
      }
      const [label, why] = BUCKET_LABELS[p.bucket] || [String(p.bucket).toUpperCase(), 'reported by the SDK as a non-success outcome'];
      // Prefer the SDK's OWN per-feature reason: it carries the real error text for `failed`, which
      // a canned bucket description throws away.
      stillBad.push({ feature: p.feature, label, why: p.reason || proof.error || why });
    }
    // Reflect the corrected verdict in the machine-readable result too, so a caller reading
    // `created.ai.appFeatures` is not told a feature failed when it demonstrably did not.
    const af = result.created.ai && result.created.ai.appFeatures;
    if (af && reproven.length) {
      af.applied = [...(af.applied || []), ...reproven];
      for (const key of Object.keys(af)) if (Array.isArray(af[key]) && key !== 'applied' && key !== 'skipped') af[key] = af[key].filter((f) => !reproven.includes(f));
      for (const o of af.outcomes || []) if (reproven.includes(o.feature)) { o.status = 'applied'; o.appOverrideExists = true; o.reason = reprovenBy.get(o.feature); }
    }
    // `runner.skip` renders as `⊘ <label>` — the closest thing the narrator has to a warning — and
    // advances the step counter correctly, which a hand-built `runner.emit` did not.
    const byLabel = new Map();
    for (const b of stillBad) {
      if (!byLabel.has(b.label)) byLabel.set(b.label, { names: [], why: b.why });
      byLabel.get(b.label).names.push(b.feature);
    }
    for (const [label, info] of byLabel) runner.skip('ai-features', `${label}: ${info.names.join(', ')} \u2014 ${info.why}`);
  }

  return result;
}

module.exports = { runSdkBuild, planFor, resolvePhases, PHASES, BuildHalt, SDK_COLUMN_TYPE, viewDef, defaultViewColumns, subgridLabel, enrichesDefaultViews, artifactIdentityQuery, resolveExistingFormId, FORM_TYPE_CODE, chartDef, dashboardTileOpts, dashboardComponent, compileFormIntent, formFieldLogicals, appDef, appUniqueName, commandsByEntity, commandDef, businessRuleDef, businessRuleFilter, webResourceOpts, WEB_RESOURCE_KINDS, FORM_EVENTS, acquireAppPagesLease, personaRoleSpecFor, resolveRoleBusinessUnit, roleBuClause };

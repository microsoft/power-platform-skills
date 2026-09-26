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
  bpfUniqueName,
  labelText,
  choiceValueMap,
  BPF_ROLE_ACCESS,
} = require('./app-spec.js');
const { PHASES } = require('./stages.js');
const { topoOrderEntities, entityByLogical } = require('./_graph.js');
const {
  makeRunner,
  requireSuccessfulPush,
  pushFailed,
  reportPartialPush,
  errorCodeChain,
  makeEntitySetResolver,
  provisionSolution,
  provisionDataModel,
  provisionSampleData,
  BuildHalt: _BuildHalt,
  SDK_COLUMN_TYPE: _SDK_COLUMN_TYPE,
  findExistingTable,
  findExistingColumns,
  relationshipExists,
  localizedLabelLcidsInSpec,
} = require('./entity-provision.js');
// Pure App Spec -> canonical SDK intent compiler (new form topology + generic-surface intents).
const {
  compileFormIntent,
  formFieldLogicals,
  firstSectionRowsPointer,
  findFieldCellPointer,
  findFieldCellLocation,
  findSectionLocation,
  declaredSectionByField,
  subgridCellIntent,
  subgridSectionIntent,
  quickViewCellIntent,
  formEventsRegionIntent,
  viewColumnsIntent,
  firstColumnSectionsPointer,
  cellFitsInRow,
  rowsFromCells,
} = require('./artifact-intent.js');
const { makeGenpageCli, suppliedButBlank } = require('./genpage-cli.js');
const { matchContainer, isEngineOwnedSection, isEngineHostSection, holdsControlOf, claimedByAuthoredName } = require('./form-container-match.js');
const { rowOccupancy, fitsGrid } = require('./form-occupancy.js');
const { manifestResourceName, buildManifest, serializeManifest, parseManifestBase64, reconcilePageIds } = require('./page-manifest.js');
// MEMBERSHIP authority (the app's live sitemap) + the cross-app shared-page scan. fetchSitemap is
// fail-closed & discriminated (C4); fetchAppsForPages is the only way to prove a generative page is not
// shared, since a genpage has no appmodulecomponent row (Imp5 — grounded live probe).
const { fetchSitemap, fetchAppsForPages } = require('./sitemap-pages.js');
// Structural nav oracle — used in the §9 PAGEREF_ scan/parity/resolve pipeline. `extractNavTargets`
// classifies every generative navigateTo pageId at a REAL call site (never a decoy string / comment GUID).
const { extractNavTargets, navReferencedKeys, navMalformedRefs, resolvePageRefs, navTargetParity } = require('./pageref-resolver.js');
const { selectSummaryTables } = require('./ai-candidates.js');
const { AI_APP_SETTING, resolveAiFlags, specOptsIntoAi, featureWantValue, sameSettingValue, resolveAppModuleId, proveAppOverride } = require('./ai-app-settings.js');
const { buildPromptSpec } = require('./ai-prompt.js');
const { odataLit } = require('./odata.js');
const { isRestrictedSolution } = require('./system-solutions.js');

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

// Which of `ids` (dashboard systemform ids) are components of the solution `solutionUniqueName`.
//
// A dashboard's only identity in an App Spec is its name, and Dataverse neither keeps names unique nor
// compares them exactly (it ignores case, most accents and trailing spaces), so a lookup by name can
// return other apps' dashboards too. Every dashboard the build creates is added to the app's solution
// (the dashboards phase below) — which makes membership the evidence of ownership that the name alone
// cannot give. Used by the build (which of several matches to reuse) and by teardown (which to delete).
//
// Returns a Set of bare lower-case ids, or null when there is no solution to ask: none named, a
// built-in container (it holds every unmanaged customization, so it proves nothing), or one that no
// longer exists. Throws when a read fails; each caller decides how to fail closed.
async function dashboardsInSolution(sdk, solutionUniqueName, ids) {
  if (!solutionUniqueName || isRestrictedSolution(solutionUniqueName)) return null;
  const bare = (g) => String(g == null ? '' : g).replace(/[{}]/g, '').toLowerCase();
  const sols = await sdk.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${odataLit(solutionUniqueName)}'`, top: 1 });
  const solId = sols && sols[0] && sols[0].solutionid;
  if (!solId) return null;
  const wanted = [...new Set((ids || []).map(bare).filter(Boolean))];
  const members = new Set();
  // In chunks, so the OR-list — and the URL — stays bounded however many name matches there are
  // (findDashboardsByName reads them all). A component appears once per solution, so a chunk of 25
  // ids answers at most 25 rows and `top: 50` never truncates.
  for (let i = 0; i < wanted.length; i += 25) {
    const chunk = wanted.slice(i, i + 25);
    const rows = await sdk.queryRecords('solutioncomponent', {
      select: ['objectid'],
      filter: `_solutionid_value eq ${bare(solId)} and componenttype eq ${COMPONENT_TYPE.dashboard} and (${chunk.map((id) => `objectid eq ${id}`).join(' or ')})`,
      top: 50,
    });
    for (const r of rows || []) {
      const id = bare(r && r.objectid);
      if (id) members.add(id);
    }
  }
  return members;
}

// Every dashboard whose name matches `name` (Dataverse's comparison: case, most accents and trailing
// spaces ignored), as `[{ id, name }]`. The vendored `resolveArtifact('dashboard', { name })` reads ONE
// page — `top: 10` with no `$orderby`, so the server picks which ten — and with more matches than that
// the app's own dashboard can sort beyond it, leaving every ownership decision (reuse, check, delete)
// made without it. So a full page is re-read in full. A reader without resolveArtifact (verify's)
// always reads in full. Shared by build, verify and teardown so all three see the same set.
const DASHBOARD_LOOKUP_PAGE = 10;
async function findDashboardsByName(sdk, name) {
  if (typeof sdk.resolveArtifact === 'function') {
    const page = (await sdk.resolveArtifact('dashboard', { name })) || [];
    if (page.length < DASHBOARD_LOOKUP_PAGE) return page;
  }
  const rows = (await sdk.queryRecords('systemform', { select: ['formid', 'name'], filter: `type eq 0 and name eq '${odataLit(name)}'`, paginate: true })) || [];
  return rows.map((r) => ({ id: String(r.formid), name: String(r.name) }));
}

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
//
// Views AND charts are keyed `entity|name`, and a tile resolves both on its OWN target entity. A chart
// keyed by name alone let two same-named charts on different tables collide, so a tile took whichever
// was built last — one table's view with another table's chart, which the platform accepts and
// publishes (live-measured). Validation guarantees the named chart exists on the tile's table.
function dashboardTileOpts(spec, tile, result) {
  const viewEntity = (name) => { const v = (spec.views || []).find((x) => x.name === name); return v && v.entity.toLowerCase(); };
  const span = (o) => { if (tile.colspan) o.colspan = tile.colspan; if (tile.rowspan) o.rowspan = tile.rowspan; return o; };
  // ID passthrough (round-tripped dashboards): a tile may carry the deployed view/chart ids + entity
  // directly, so it binds to the EXISTING views/charts without re-declaring them in views[]/charts[].
  const targetEntity = tile.entity ? tile.entity.toLowerCase() : viewEntity(tile.view);
  if (tile.type === 'chart') {
    return span({ type: 'chart', name: tile.name || tile.chart, targetEntity,
      viewId: tile.viewId || result.created.views[`${targetEntity}|${tile.view}`], visualizationId: tile.visualizationId || result.created.charts[`${targetEntity}|${tile.chart}`] });
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
//
// Resolution goes through `choiceValueMap`, the SHARED rule, rather than `options.indexOf(val)`.
// Two reasons, and the first is a real defect the naive version had: a LOCALIZED option is an
// object (`{ "1033": "Open", "3082": "Abierto" }`), so `indexOf("Abierto")` returns -1 and the
// LABEL was sent as the value of a numeric picklist condition — an invalid or silently ineffective
// view filter. The second is that `choiceValueMap` also resolves a column bound to a `globalChoice`,
// which the inline-only lookup never did.
function resolveFilterValue(spec, entityLogical, attr, val) {
  if (typeof val !== 'string') return val;
  const e = entityByLogical(spec, entityLogical);
  const c = e && (e.columns || []).find((x) => x.schemaName.toLowerCase() === String(attr).toLowerCase());
  if (!c || (c.type !== 'Choice' && c.type !== 'MultiChoice')) return val;
  const byLabel = choiceValueMap(e, spec)[String(c.schemaName).toLowerCase()];
  const hit = byLabel && byLabel[val];
  return typeof hit === 'number' ? hit : val;
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
    // The relationship probe identity must match the one the APPLY path uses, or an existing
    // relationship reads as `create`. `provisionDataModel` queries the REFERENCED (parent) entity's
    // OneToManyRelationships — the child's collection does not contain it — and builds the schema
    // name WITH the publisher prefix. Getting either wrong is invisible for a self-referencing
    // relationship (referenced === referencing), which is exactly the shape this was first tested on.
    const relPrefix = spec.solution && spec.solution.publisherPrefix;
    for (const gc of spec.globalChoices || []) items.push({ phase: 'data-model', label: `global choice ${gc.name}` });
    for (const e of spec.entities) {
      // `labelText` returns "" for an absent displayName, or for a localized map with nothing usable
      // — which rendered a dry-run line as `table new_order ("")`, an empty quoted string the reader
      // has to decode. Fall back to the schema name, which is what the CREATE itself falls back to
      // (`displayName || schemaName`), so the plan says what the build will actually do.
      const shown = labelText(e.displayName, spec && spec.languageCode) || e.schemaName;
      items.push({ phase: 'data-model', label: `table ${e.schemaName} ("${shown}")`, key: { kind: 'table', entity: e.schemaName } });
      if (quickCreateEnabledFor(spec, e)) items.push({ phase: 'data-model', label: `enable quick create on ${e.schemaName.toLowerCase()}` });
      for (const c of e.columns || []) {
        if (SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer') items.push({ phase: 'data-model', label: `column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`, key: { kind: 'column', entity: e.schemaName, name: c.schemaName } });
      }
      const buildable = (e.columns || []).filter((c) => SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer');
      for (const c of [e.primaryAttribute, ...buildable]) {
        if (c && c.schemaName && Object.prototype.hasOwnProperty.call(c, 'required')) {
          items.push({ phase: 'data-model', label: `required ${e.schemaName}.${c.schemaName}` });
        }
      }
      for (const c of buildable) {
        if (c.type !== 'Customer' && (
          c.defaultValue !== undefined || c.integerFormat !== undefined
          || c.isValidForCreate !== undefined || c.isValidForUpdate !== undefined || c.isValidForRead !== undefined
        )) {
          items.push({ phase: 'data-model', label: `column capabilities ${e.schemaName}.${c.schemaName}` });
        }
      }
      for (const c of e.columns || []) {
        if (c && c.schemaName && c.visualization !== undefined) {
          items.push({ phase: 'data-model', label: `visualization ${e.schemaName}.${c.schemaName} (${c.visualization})` });
        }
      }
      for (const sr of e.statusReasons || []) items.push({ phase: 'data-model', label: `status reason ${e.schemaName}: ${sr.label}` });
      for (const k of e.alternateKeys || []) items.push({ phase: 'data-model', label: `alt key ${e.schemaName}.${k.schemaName}` });
    }
    for (const r of spec.relationships || []) {
      if (r.type === 'OneToMany') items.push({ phase: 'data-model', label: `relationship 1:N ${r.referenced}->${r.referencing}`, key: { kind: 'relationship', entity: r.referenced, name: relationshipSchemaName(r, relPrefix), relType: 'OneToMany' } });
      else if (r.type === 'ManyToMany') items.push({ phase: 'data-model', label: `relationship N:N ${r.entity1}<->${r.entity2}`, key: { kind: 'relationship', entity: r.entity1, name: manyToManySchemaName(r, relPrefix), relType: 'ManyToMany' } });
    }
  }
  if (has('sample-data') && opts.sampleData) {
    for (const e of spec.entities) { const n = sampleRecordsFor(spec, e).length; if (n) items.push({ phase: 'sample-data', label: `${n} sample record(s) -> ${e.schemaName}` }); }
  }
  if (has('web-resources')) for (const wr of spec.webResources || []) items.push({ phase: 'web-resources', label: `web resource ${wr.name} (${wr.type || 'js'})` });
  if (has('web-resources')) for (const e of spec.entities || []) if (e.icon || e.vectorIcon) items.push({ phase: 'web-resources', label: `table icon for ${e.schemaName.toLowerCase()}` });
  if (has('views')) for (const v of spec.views || []) items.push({ phase: 'views', label: `view "${v.name}" for ${v.entity}`, key: { kind: 'view', entity: v.entity, name: v.name } });
  if (has('views')) for (const e of spec.entities || []) if (enrichesDefaultViews(spec, e)) items.push({ phase: 'views', label: `enrich default views for ${e.schemaName.toLowerCase()}` });
  if (has('charts')) for (const c of spec.charts || []) items.push({ phase: 'charts', label: `chart "${c.name}" (${c.chartType}) for ${c.entity}`, key: { kind: 'chart', entity: c.entity, name: c.name } });
  if (has('forms')) for (const f of spec.forms || []) {
    const ft = f.formType || 'Main';
    const subs = (f.subgrids || []).map((s) => s.childEntity).join(', ');
    // The form's Dataverse NAME is whatever compileFormIntent derives (the author may omit `name`),
    // and that is the name the reuse lookup keys on — so derive it the same way rather than guessing.
    // Wrapped because planFor must stay total: a spec shape compileFormIntent rejects should still
    // produce a plan LINE (it just cannot be probed live), never crash the dry run.
    let formKey;
    try {
      const def = compileFormIntent(spec, f, { notesClassId: NOTES_CLASS_ID });
      formKey = { kind: 'form', entity: def.entityLogicalName, name: def.name, formType: ft, formId: f.formId };
    } catch { formKey = undefined; }
    items.push({ phase: 'forms', label: `${ft === 'Main' ? 'form' : `${ft} form`} for ${f.entity}${subs ? ` (sub-grids: ${subs})` : ''}`, ...(formKey ? { key: formKey } : {}) });
    if ((f.events || []).length) items.push({ phase: 'forms', label: `wire ${f.events.length} event handler(s) on ${f.entity}` });
    if ((f.quickViews || []).length) items.push({ phase: 'forms', label: `place ${f.quickViews.length} quick-view(s) on ${f.entity}` });
  }
  if (has('business-rules')) for (const r of spec.businessRules || []) items.push({ phase: 'business-rules', label: `business rule "${r.name}" on ${r.entity}` });
  if (has('business-process-flows')) for (const p of spec.businessProcessFlows || []) {
    const stages = (p.stages || []).length;
    items.push({ phase: 'business-process-flows', label: `business process flow "${p.name}" on ${p.entity} (${stages} stage${stages === 1 ? '' : 's'})` });
  }
  if (has('commands')) for (const [entity, cmds] of Object.entries(commandsByEntity(spec))) items.push({ phase: 'commands', label: `command bar for ${entity} (${cmds.length} button(s))` });
  if (has('dashboards')) for (const d of spec.dashboards || []) items.push({ phase: 'dashboards', label: `dashboard "${d.name}" (${(d.tiles || []).length} tile(s))` });
  if (has('app-shell')) items.push({ phase: 'app-shell', label: `app module "${spec.app.name}" + sitemap`, key: { kind: 'app', uniqueName: appUniqueName(spec) } });
  if (has('app-shell') && !(spec.app && spec.app.icon)) items.push({ phase: 'app-shell', label: `app icon (generated) ${appUniqueName(spec)}_icon` });
  if (has('pages')) for (const p of spec.pages || []) items.push({ phase: 'pages', label: `page "${p.name}"` });
  if (has('pages') && (spec.pages || []).length && appHasCrossPageNav(spec)) items.push({ phase: 'pages', label: 'resolve cross-page navigation' });
  if (has('pages') && (spec.pages || []).length) items.push({ phase: 'pages', label: `page manifest ${appUniqueName(spec)}_pagemanifest` });
  // Budgeted whenever the pages phase runs, NOT only when the spec has page subareas. The runtime
  // finalizes on `appHasPageSubareas(spec) || appWasExisting`, and `appWasExisting` is a LIVE fact
  // planFor cannot see — so gating the plan on the spec alone under-counted every rebuild against an
  // app that already existed, and the run overran its own denominator ([37/36], live-reproduced on a
  // page-less spec). The runner's total is fixed at construction from plan.length, so the only way to
  // stay in step is to budget the step and have the runtime emit an explicit `skip` when it does not
  // fire — the same shape as the existing-column "applied on create" skips.
  if (has('pages')) items.push({ phase: 'pages', label: 'finalize sitemap (genpage subareas)' });
  if (has('ai-features') && specOptsIntoAi(spec)) {
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
  // Role grants are planned after personas because they run after them (a grant on a role this spec
  // also authors is rejected at validation, but the ORDER still matters for reading the plan).
  if (has('security')) for (const g of spec.roleGrants || []) {
    const n = (g.privileges || []).length;
    items.push({ phase: 'security', label: `grant privileges on ${n} table${n === 1 ? '' : 's'} to existing role ${roleGrantLabel(g)}` });
  }
  // Form role assignment is planned under `security` (not `forms`) because it can only run once the
  // roles exist — see the 7b block in the engine for why.
  if (has('security')) for (const f of spec.forms || []) {
    if (f && f.securityRoles) items.push({ phase: 'security', label: `form roles for ${f.name || f.formType || 'Main'} on ${f.entity}` });
  }
  // Flow role grants are planned under `security` for the same reason form ones are: they target the
  // backing table ACTIVATION creates, and they need persona roles that do not exist until this phase.
  if (has('security')) for (const f of spec.businessProcessFlows || []) {
    if (f && f.securityRoles) items.push({ phase: 'security', label: `flow roles for ${f.name} (backing table ${bpfUniqueName(f.name)})` });
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
  // Resolved through labelText: a LOCALIZED plural/display name is an object, and returning it here
  // put "[object Object]" into the form's section and control labels — and, because the form
  // projection stringifies for change detection, made two DIFFERENT localized labels hash the same.
  const lang = spec && spec.languageCode;
  return labelText(child && child.pluralName, lang) || labelText(child && child.displayName, lang) || sg.childEntity;
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
    // (the pin stays in the spec), silently accumulating duplicate forms. Fail loud instead.
    if (!row) throw new Error(`form "${def.name}": pinned formId ${def.formId} does not exist on this environment — remove the pin to create a new form, or correct the id`);
    // The pin must point at the SAME (table, type, name) the spec intends. reconcileForm blindly pushes the
    // spec layout onto whatever id it gets, so a wrong pin (a Quick View id under formType:"Main", a form on
    // another table, or an unrelated form) would CORRUPT that form. The pin's only legitimate use — two
    // forms with identical (entity, type, name) — matches all three, so validating all three never rejects
    // a valid pin, only a mistaken one.
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
// rebuild and CREATE A DUPLICATE. An AUTHORED create-fresh spec has no `app.uniqueName`, so
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
    runner.skip('app-shell', `app icon (generated) ${name} (exists — reuse)`);
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
    // #583: the routing description, only when the spec sets one (see applyAppAiDescription).
    ...(spec.app.aiDescription ? { aiDescription: spec.app.aiDescription } : {}),
    ...(opts.iconWebResourceId ? { iconWebResourceId: opts.iconWebResourceId } : {}),
    components: { forms: Object.values(result.forms || {}).filter(Boolean), views: Object.values(result.views || {}).filter(Boolean), charts: Object.values(result.charts || {}).filter(Boolean) } };
}

// #583: set the routing description (`app.aiDescription` → `appmodule.aiappdescription`) on the FETCHED
// artifact of an app that already exists. Returns true when the artifact changed and needs a push.
//
//   * Only when the spec sets one. Absent means "leave the deployed value alone" — the platform can write
//     this text itself — so an omitted field is never written, and never blanked.
//   * Only when it differs from the FETCHED artifact, which is the draft layer
//     (RetrieveUnpublishedMultiple) the SDK's own push compares the header against. So `true` here means
//     exactly "the push will write the header", and a plain rebuild neither pushes nor publishes for
//     nothing. Same rule as the chart description reconcile: read the layer the write targets.
//   * A fetched app carries `aiDescription` only when the row has one, and `updateElement` refuses a
//     path that is not there (PATH_NOT_FOUND). So the key is ADDED at the artifact root when absent and
//     updated when present.
// LIVE-MEASURED: addElement at the root and a push write `aiappdescription` (read back before and after
// publish); a later updateElement and push change it; an unrelated edit and push leave it untouched.
async function applyAppAiDescription(provision, spec, appId) {
  const want = spec.app && spec.app.aiDescription;
  if (typeof want !== 'string' || !want.trim()) return false;
  const current = (await provision.getArtifact('app', appId)) || {};
  if (current.aiDescription === want) return false;
  if (current.aiDescription === undefined) await provision.addElement('app', appId, '', { aiDescription: want });
  else await provision.updateElement('app', appId, '/aiDescription', want);
  return true;
}

// #583: halt precisely when the push of an app whose routing description this run changed was refused
// because Dataverse will not take a header write until the app is PUBLISHED — rather than because of a
// concurrent edit. Called before requireSuccessfulPush, whose generic 412 remedy (re-download and
// rebuild) reads the same draft and fails the same way. The SDK reports that state two ways:
//   * APP_DRAFT_HEADER_NOT_WRITABLE, THROWN (see pushAppHeader) for an app that was never published. The
//     SDK's own message names the state, so no read is needed.
//   * VERSION_CONFLICT, RESOLVED (saved:false) for a published app with an unpublished header change.
//     LIVE-MEASURED: once a header change (name, description or routing description) is pushed but not
//     published, the appmodule row has a second, unpublished layer with its own version number, and the
//     SDK's next header PATCH fails with 412 although nothing changed since the fetch; a sitemap-only
//     push over the same state still succeeds, and publishing clears it. The state arises from a header
//     edit saved in Maker but not published, or from a build whose publish did not complete. A 412 is
//     relabelled only when it was the APPMODULE row's and a draft read PROVES that state (componentstate
//     1 = Unpublished:
//     https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule#BKMK_ComponentState);
//     any other outcome — a settled row, a read that fails — returns and leaves the generic halt in place.
//
//     Whose 412 it was matters because the SDK writes an app in two PATCHes, the header then the sitemap,
//     each conditional on its own version, and names the refused one in the error's `detail`:
//       Version conflict (412) from https://contoso.crm.dynamics.com/api/data/v9.2/appmodules(<id>)
//       Version conflict (412) from https://contoso.crm.dynamics.com/api/data/v9.2/sitemaps(<id>)
//     A sitemap 412 is a concurrent sitemap edit — and by then this push's own header write has committed,
//     leaving exactly the unpublished layer the draft read finds. Relabelling it reset the copy, and
//     "publish, then re-run" then overwrote the other edit; the kept copy is what makes that re-run stop.
//
// Before halting it RESETS the workspace copy to the server's. The refused push left this run's edits in
// it; once the operator publishes, the server moves, and a plain fetch then refuses to discard unpushed
// edits (LOCAL_EDITS_WOULD_BE_LOST) — so "publish, then re-run" would halt again. Measured against the
// vendored bundle. The edits were projected from the spec and the re-run re-applies them, so nothing is
// lost; if the reset itself fails, the halt names the workspace to delete instead.
async function haltOnUnpublishedAppHeader(provision, appId, pushed, name) {
  // pushFailed reads `saved`, then the older SDK spelling `success`, then a bare error — the same reading
  // requireSuccessfulPush applies, so the precise halt fires for either result shape.
  const code = pushFailed(pushed) && pushed.error && pushed.error.code;
  const neverPublished = code === 'APP_DRAFT_HEADER_NOT_WRITABLE';
  if (!neverPublished) {
    if (code !== 'VERSION_CONFLICT' || !provision.dataverse || typeof provision.dataverse.get !== 'function') return;
    if (!/\/appmodules\(/i.test(`${pushed.error.detail || ''} ${pushed.error.message || ''}`)) return;
    let pending = false;
    try {
      // No `$top`: look for the unpublished layer among EVERY row the draft read returns. Measured, it
      // returns only the unpublished row while one exists, but that is not a documented guarantee, and a
      // published row read first would silently fall through to the generic halt this exists to replace.
      const res = await provision.dataverse.get(`/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=componentstate&$filter=appmoduleid eq ${appId}`);
      // `dataverse.get` RESOLVES on a non-2xx, so the status is checked explicitly.
      if (res && res.status >= 200 && res.status < 300 && res.body && Array.isArray(res.body.value)) {
        pending = res.body.value.some((r) => r && r.componentstate === 1);
      }
    } catch {
      return;
    }
    if (!pending) return;
  }
  let reset = true;
  try {
    await provision.fetchArtifact('app', appId, { overwrite: true });
  } catch {
    reset = false;
  }
  const workspace = reset ? ''
    : ' First delete the .maker-workspace directory (or the --workspace one): it still holds this run\'s unpushed copy of the app, which a re-run would refuse to overwrite.';
  const why = neverPublished
    ? 'the app has never been published, and Dataverse refuses a write to its name, description or routing description until it is'
    : 'the app has an unpublished change to its name, description or routing description (saved in Maker, or by a build whose publish did not complete), and Dataverse refuses another write to those fields until it is published';
  const fix = neverPublished ? 'publish the app in Power Apps' : 'publish the app in Power Apps (or discard the change)';
  throw new BuildHalt(`push app ${name} failed: ${why}. Re-downloading reads the same draft and fails the same way: ${fix}, then re-run the build.${workspace}`, { phase: 'push', code: 'app-header-unpublished', recoverable: true, cause: pushed.error });
}

// #583: push an app artifact whose header this run may have changed (the routing description). A refusal
// that means "publish first" — thrown or returned — goes through haltOnUnpublishedAppHeader; everything
// else is exactly the plain push (the result is still for requireSuccessfulPush to judge) — except that a
// FAILED push first resets the workspace copy (discardUnrecordedEdits).
async function pushAppHeader(provision, appId, name, headerChanged) {
  let pushed;
  try {
    pushed = await provision.pushArtifact('app', appId);
  } catch (e) {
    if (headerChanged) await haltOnUnpublishedAppHeader(provision, appId, { saved: false, error: e }, name);
    await discardUnrecordedEdits(provision, appId, e, true);
    throw e;
  }
  if (headerChanged) await haltOnUnpublishedAppHeader(provision, appId, pushed, name);
  if (pushFailed(pushed)) await discardUnrecordedEdits(provision, appId, pushed.error, false);
  return pushed;
}

// #583: after a push of the app FAILED, reset the workspace copy to the server's. Its edits were never
// recorded, and a copy still holding them hurts the re-run: its plain fetch refuses to discard them
// (LOCAL_EDITS_WOULD_BE_LOST) once the server has moved; the next run that pushes the app refuses such a
// copy outright (refuseUnpushedAppCopy); and applyAppAiDescription would compare against it, so a pending
// routing description read as "already set". The edits are projected from the spec, so the re-run
// re-applies them and nothing is lost. (Only a push that carried a header change used to reset; a failed
// sitemap-only push left the copy holding its edits.)
//
// A concurrent edit is the one failure that KEEPS the copy: a VERSION_CONFLICT, or a returned failure
// with no code at all (the bare 412 requireSuccessfulPush reads the same way). There the remedy is a
// fresh download, and the unrecorded copy is what makes a blind re-run stop instead of overwriting the
// other edit. Best-effort: a reset that fails leaves the copy exactly as it was before this existed.
async function discardUnrecordedEdits(provision, appId, error, thrown) {
  const code = error && error.code;
  if (code === 'VERSION_CONFLICT' || (!thrown && !code)) return;
  try {
    await provision.fetchArtifact('app', appId, { overwrite: true });
  } catch { /* see above */ }
}

// #583 review: an app copy an earlier run left holding unpushed edits — a build interrupted between its edit
// and its push, say — goes out with the next push of the app, whatever that run asked for. A plain fetch
// keeps such a copy while the server has not moved, and the SDK serializes every field that differs from
// its stored server copy: a routing description the spec leaves out ("leave the deployed one alone") was
// overwritten with the earlier run's, a wanted one read as already set (so its push skipped the
// unpublished-header halt), and a stale sitemap rewrite was replayed, detaching live pages with no gate. So
// a run that will push the app refuses such a copy before it applies anything.
async function refuseUnpushedAppCopy(provision, appId, name) {
  const listed = (await provision.listArtifacts('app')).find((a) => a && a.id === appId);
  if (listed && listed.isDirty) {
    throw new BuildHalt(`app ${name}: the workspace copy holds edits an earlier run did not push (an interrupted build, say), and this run's push of the app would send them too. Delete the .maker-workspace directory (or the --workspace one) and re-run.`, { phase: 'app-shell', code: 'app-copy-unpushed-edits', recoverable: true });
  }
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

// A BPF is a `workflows` row like a business rule, but a DIFFERENT category, so it needs its own
// filter rather than a parameterized one — sharing it would invite passing the wrong category.
//
// category 4 = BusinessProcessFlow; type 1 = definition (activating a process creates a `type 2`
// activated copy the platform owns and refuses to delete directly — see businessRuleFilter for the
// full story, which cost real time there). `businessprocesstype eq 0` excludes TASK FLOWS, which are
// also category 4; without it a task flow with the same name would be adopted as this flow.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/workflow
function bpfFilter(name, entityLogical) {
  return `category eq 4 and type eq 1 and businessprocesstype eq 0 and name eq '${odataLit(name)}' and primaryentity eq '${odataLit(String(entityLogical).toLowerCase())}'`;
}

// Map one App Spec `businessProcessFlows[]` entry to the vendored SDK's BpfArtifact shape.
//
// Pure: spec shape -> SDK shape. Three normalizations that are easy to get wrong:
//   1. `entity` (a spec schemaName) becomes `entityLogicalName`, lower-cased — Dataverse logical
//      names are lower-case and the XAML binds on them.
//   2. Each stage repeats the entity. The SDK models a per-stage entity (that is how a cross-entity
//      flow is expressed); v1 validates them equal, and stamping it here keeps the artifact valid
//      rather than relying on the adapter's `''` default.
//   3. The step's column key is `fieldName`, NOT `fieldLogicalName`. The adapter's step normalizer
//      copies exactly `id`/`name`/`fieldName`/`required` and DROPS anything else, so a mis-named key
//      is silently discarded and the step deploys bound to nothing. Measured against the real bundle
//      and pinned in bpf-real-bundle.test.js.
//
// Ids are deliberately NOT minted here: the adapter assigns any missing stage/step id itself, and a
// stable id would only matter for an edit-in-place path the build does not have (a flow is
// reused-as-is or created whole).
function bpfDef(flow) {
  const entityLogicalName = String(flow.entity).toLowerCase();
  const def = {
    name: flow.name,
    entityLogicalName,
    // Active unless the author asks for Draft. A BPF is not merely inert when inactive — the stage
    // bar does not render at all — so Active is the only useful default.
    status: flow.status || 'Active',
    stages: (flow.stages || []).map((st) => ({
      name: st.name,
      entityLogicalName,
      steps: (st.steps || []).map((step) => ({
        name: step.name,
        ...(step.field !== undefined ? { fieldName: String(step.field).toLowerCase() } : {}),
        ...(step.required !== undefined ? { required: step.required } : {}),
      })),
    })),
  };
  if (flow.description !== undefined) def.description = flow.description;
  if (flow.order !== undefined) def.order = flow.order;
  return def;
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
// because `valueType` already means that other thing here. See BUSINESS_RULE_DATA_TYPES in
// app-spec.js.
//
// `dataType` is NO LONGER decorative on the CONDITION path, and that changed under us in the SDK
// uptake. The previous bundle consulted `valueWorkflowType` only for `valueType: 'Clear'` and
// hard-typed every ordinary literal as `WorkflowAttributeType.String`; the current bundle uses the
// field for ALL value types, VERBATIM, with no name -> enum mapping of its own
// (`… : e.valueWorkflowType ?? WorkflowAttributeType.String`).
//
// `WorkflowAttributeType` is a NUMERIC-STRING enum — `{ Boolean:'0' … Money:'7', Picklist:'10',
// String:'14' … }` — so passing the App Spec's human token would put an out-of-domain value on the
// wire. MEASURED against the vendored bundle before this mapping existed, the condition literal
// carried `"String"`, `"Money"`, and even `"NotAWorkflowType"` straight through, while the SDK's own
// fallback for the same field is `'14'`. Note this hit EVERY rule, not only ones that authored a
// `dataType`, because the default below is the token `'String'` rather than the enum value.
//
// LIVE-MEASURED that this fails SILENTLY rather than loudly: a build carrying the raw tokens
// deployed all four probe rules with 0 failures and activated them. The platform does not reject the
// value, so nothing upstream of a user noticing the rule never fires would surface it — and
// `--verify` cannot, because it checks existence, duplicate count and statecode, never the rule's
// WFOM.
//
// The ACTION path still types every literal as String on the SDK side, so it is unaffected — the
// asymmetry is deliberate and pinned in business-rules.test.js.
const WORKFLOW_ATTRIBUTE_TYPE = {
  boolean: '0', customer: '1', datetime: '2', decimal: '3', float: '4', double: '4', integer: '5',
  lookup: '6', money: '7', owner: '8', partylist: '9', picklist: '10', key: '11', state: '12',
  status: '13', string: '14', memo: '14', uniqueidentifier: '15', entitynamereference: '16',
  entity: '17', entitycollection: '18', multiselectpicklist: '23',
};
// Unknown tokens fall back to String rather than being forwarded. The spec gate already restricts
// `dataType` to BUSINESS_RULE_DATA_TYPES, so this is unreachable from a valid spec; forwarding an
// unmapped token would reopen exactly the out-of-domain write this mapping exists to close.
function workflowAttributeType(dataType) {
  return WORKFLOW_ATTRIBUTE_TYPE[String(dataType || 'String').toLowerCase()] || '14';
}
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
    // Active unless the author asks for Draft. A rule is inert until activated, so defaulting to
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
        ...(valueless(c.operator) ? {} : { value: String(c.value), valueWorkflowType: workflowAttributeType(c.dataType) }),
      })),
      trueBranch: (rule.actions || []).map((a) => {
        const node = { id: actionId(), type: a.type, displayName: a.label || `${a.type} ${a.field}`, field: String(a.field).toLowerCase() };
        if (a.type === 'SetVisibility') node.visible = a.visible;
        else if (a.type === 'LockUnlock') node.lock = a.lock;
        else if (a.type === 'SetBusinessRequired') node.required = a.required;
        else if (a.type === 'SetFieldValue') { node.value = String(a.value); node.valueType = 'Value'; node.valueWorkflowType = workflowAttributeType(a.dataType); }
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
// with no parent), else NULL when it cannot be resolved. Every current caller treats null as FAIL
// CLOSED and reports the role as missing rather than matching on name alone (teardown
// sdk-teardown.js, verify verify-spec.js, and the roleGrant apply path) — a name-only match could
// touch a same-named role in a DIFFERENT business unit, which for a grant is privilege escalation.
// `q` is a queryRecords fn (the teardown `sdk` or the verify `read`); `cache` memoizes the root-BU
// lookup for the run.
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
// business unit. Empty string when the BU is unknown — but no caller reaches that today: every one
// treats an unresolved BU as fail-closed before calling this. `bu` is GUID-validated by
// resolveRoleBusinessUnit, so interpolation is injection-safe.
function roleBuClause(bu) {
  return bu && FORM_GUID_RE.test(String(bu)) ? ` and _businessunitid_value eq ${bu}` : '';
}

// A stable, human-readable name for a `roleGrants[]` entry, used in plan lines, progress labels and
// errors. Prefers the display name the author wrote; falls back to the pinned id.
function roleGrantLabel(g) {
  const name = g && typeof g.role === 'string' ? g.role.trim() : '';
  return name ? `"${name}"` : `${(g && g.roleId) || '?'}`;
}

// Resolve the EXISTING role a `roleGrants[]` entry extends. AB#6686429.
//
// Fail-closed on every ambiguity, because the write is a privilege grant: granting on the wrong role is
// a silent access-control defect that no later phase would catch.
//   - `roleId` pinned → confirm the row EXISTS (an absent id is a stale pin, not a create trigger — this
//     surface never creates a role) and report its name so the build log names what was actually changed.
//   - `role` name → exact-match within the resolved business unit (explicit `businessUnitId`, else the org
//     ROOT BU — the same identity `createPersonaRole`, teardown and verify use). 0 matches and >1 match
//     are BOTH errors; ">1" happens when the same role name exists in several BUs and the author must
//     disambiguate.
//
// Unlike the persona path this deliberately does NOT require the SDK ownership marker: the whole point is
// to extend a role somebody else built. `ismanaged` is not a blocker either — Dataverse permits
// AddPrivilegesRole on a managed role, and refusing would block the bug's actual scenario (a solution's
// shipped roles). It IS surfaced in the returned detail so the log says what was touched.
async function resolveRoleGrantTarget(provision, grant, buCache) {
  if (grant.roleId) {
    const rows = await provision.queryRecords('role', { select: ['roleid', 'name', 'ismanaged'], filter: `roleid eq ${grant.roleId}`, top: 1 });
    const row = rows && rows[0];
    if (!row) throw new Error(`roleGrant: pinned roleId ${grant.roleId} does not exist on this environment — correct the id, or target the role by name`);
    return { roleId: String(row.roleid), name: row.name || '', managed: row.ismanaged === true };
  }
  const name = String(grant.role).trim();
  const bu = await resolveRoleBusinessUnit((e, o) => provision.queryRecords(e, o), grant.businessUnitId, buCache);
  // FAIL CLOSED when the BU cannot be resolved. Teardown/verify fall back to a name-only match because a
  // false negative there is merely noisy; here a name-only match could grant privileges on a same-named
  // role in a DIFFERENT business unit, which is a real privilege escalation.
  if (!bu) throw new Error(`roleGrant "${name}": could not resolve the business unit to scope the role lookup — pin the role with 'roleId' instead`);
  const rows = await provision.queryRecords('role', {
    select: ['roleid', 'name', 'ismanaged'],
    filter: `name eq '${String(name).replace(/'/g, "''")}'${roleBuClause(bu)}`,
    top: 5,
  });
  const matches = (rows || []).filter((r) => r && r.roleid);
  if (!matches.length) throw new Error(`roleGrant "${name}": no security role with that name exists in business unit ${bu} — check the spelling (the name must match EXACTLY), or pin the role with 'roleId'`);
  if (matches.length > 1) throw new Error(`roleGrant "${name}": ${matches.length} roles share that name in business unit ${bu} — pin the one you mean with 'roleId'`);
  return { roleId: String(matches[0].roleid), name: matches[0].name || name, managed: matches[0].ismanaged === true };
}


// Decide, against the LIVE environment, whether each planned item would be created or reused. #559.
//
// The dry run used to print `planFor`'s static, spec-derived listing and exit before any discovery,
// so the identical plan appeared for a spec whose every artifact already exists and for one that
// would create everything from nothing. A caller could not tell CREATE from REUSE — which is the one
// question a dry run exists to answer before a production apply.
//
// This deliberately reuses the BUILD'S OWN discovery — `findExistingTable`, `findExistingColumns`,
// `relationshipExists` and the shared `artifactIdentityQuery` — rather than re-implementing a
// parallel "does it exist?" pass. A second implementation would drift from the one that actually
// decides at apply time, and a dry run that confidently disagrees with the apply is worse than one
// that says nothing.
//
// Read-only: every call here is a GET/query. Nothing is created, updated or published.
//
// Three states, because two would have to lie:
//   create   — probed, not present: the apply will create it.
//   reuse    — probed, present: the apply will discover and skip/reconcile it.
//   unknown  — probed and the read FAILED. Never collapsed into create or reuse: guessing "create"
//              overstates the work and guessing "reuse" understates it, and both read as certainty.
// An item with no `key` is left unprobed (`state` absent) — the plan line still prints.
async function annotateLivePlan(plan, { spec, provision, warn } = {}) {
  // Localization is decided PER ITEM, because that is how the apply path decides it (per entity in
  // entity-provision.js, per relationship lookup label). A spec-wide flag would push a plain-label
  // table down the fail-closed path because some unrelated table is localized, and the plan would
  // then contradict the apply it exists to predict.
  //
  // The entity map is built here rather than carried on the key so it cannot depend on probe ORDER:
  // `tableCache` is keyed by table alone, and a form/view item naming the same table must not be
  // able to seed the cache with a different localization answer than the table item would.
  //
  // The previous spec-wide read also called `localizedLabelLcidsInSpec` without importing it. It
  // lives in entity-provision.js, not app-spec.js, so the identifier was undeclared and the
  // `typeof … === 'function'` guard silently evaluated to false on every run — the flag was never
  // once true.
  const localizedByEntity = new Map();
  for (const e of (spec && spec.entities) || []) {
    localizedByEntity.set(String(e.schemaName || '').toLowerCase(), localizedLabelLcidsInSpec({ entities: [e] }).length > 0);
  }
  const tableCache = new Map();   // entity logical -> { found: bool|null }
  const columnCache = new Map();  // entity logical -> Set<logicalName> | null

  // `findExistingColumns` is written for the APPLY path, where a failed read is safe to treat as
  // "assume every column is new" — the create's own already-exists handling absorbs the duplicates.
  // A dry run has no create to absorb anything, so the same `[]` would print `+ create` for columns
  // that exist. The helper calls `warn` exactly when it is returning that fallback, so the warning
  // is the signal that the answer was not conclusive.
  const columnsOf = async (logical) => {
    if (!columnCache.has(logical)) {
      let readFailed = false;
      try {
        const cols = await findExistingColumns(provision, logical, (msg) => {
          readFailed = true;
          if (typeof warn === 'function') warn(msg);
        });
        columnCache.set(logical, readFailed ? null : new Set((cols || []).map((c) => String(c.logicalName || '').toLowerCase())));
      } catch { columnCache.set(logical, null); }
    }
    return columnCache.get(logical);
  };

  // `relationshipExists` falls back to the BROAD `fetchEntityMetadata` read when the narrow one is
  // inconclusive. Two reasons not to take that fallback here: the vendored implementation WRITES the
  // fetched metadata into the on-disk workspace, which a read-only dry run must not do (it would
  // change cached state a later apply reads); and the apply path deliberately treats its `null` as
  // "absent" because the create absorbs the race, which a dry run must not copy. Handing it a
  // reader with no `fetchEntityMetadata` makes an inconclusive probe return `null`, which becomes
  // `unknown` below.
  const relReader = { dataverse: provision && provision.dataverse };

  const tableState = async (logical) => {
    if (!tableCache.has(logical)) {
      try {
        const hit = await findExistingTable(provision, logical, { hasLocalizedLabels: localizedByEntity.get(logical) === true });
        tableCache.set(logical, { found: !!hit });
      } catch (err) {
        // Includes the BuildHalt findExistingTable raises for a LOCALIZED spec whose probe is
        // inconclusive — which is precisely an "unknown", not an absence.
        //
        // `why` is kept SHORT because it is printed once per plan line, and every column, view and
        // form on the table inherits it: the BuildHalt text is a ~390-character remediation
        // paragraph, so a 20-column table would emit ~8 KB of the same prose. The full text is kept
        // on `whyLong` for the table's own line, where it is worth reading once.
        const full = String((err && err.message) || err);
        tableCache.set(logical, { found: null, why: 'the table existence probe was inconclusive', whyLong: full });
      }
    }
    return tableCache.get(logical);
  };

  // Resolve view/chart/form/app the way the BUILD resolves them, so the plan cannot claim a state
  // the apply then contradicts:
  //   - forms go through `resolveExistingFormId`, which validates a pinned `formId` (a stale or
  //     foreign pin makes the apply HALT — reporting that as create/reuse would hide it) and throws
  //     on two same-(entity,type,name) forms;
  //   - views/charts go through `provision.findArtifact`, which raises on an ambiguous identity;
  //   - the app is keyed by its deterministic unique name.
  // Anything thrown becomes `unknown` with the resolver's own message, which is the actionable one.
  const artifactPresent = async (kind, def) => {
    if (kind === 'form') return !!(await resolveExistingFormId(provision, def));
    if ((kind === 'view' || kind === 'chart') && typeof provision.findArtifact === 'function') {
      return !!(await provision.findArtifact(kind, { name: def.name, entity: def.entityLogicalName }));
    }
    const q = artifactIdentityQuery(kind, def);
    if (!q) return null;
    const rows = await provision.queryRecords(q.set, { select: [q.idField], filter: q.filter, top: 1 });
    return !!(rows && rows.length);
  };

  for (const item of plan) {
    const k = item.key;
    if (!k) continue;
    try {
      if (k.kind === 'table') {
        const t = await tableState(String(k.entity).toLowerCase());
        item.state = t.found === null ? 'unknown' : (t.found ? 'reuse' : 'create');
        // The table's own line carries the FULL reason (the halt text names the remediation); every
        // other item on the same table gets the short form, so the paragraph is printed once.
        if (t.found === null) item.stateWhy = t.whyLong || t.why;
      } else if (k.kind === 'column') {
        const logical = String(k.entity).toLowerCase();
        const t = await tableState(logical);
        // A column on a table that does not exist is unambiguously a create — and asking Dataverse
        // for the attributes of a non-existent table only produces a metadata-cache error.
        if (t.found === false) { item.state = 'create'; continue; }
        if (t.found === null) { item.state = 'unknown'; item.stateWhy = t.why; continue; }
        const cols = await columnsOf(logical);
        if (!cols) { item.state = 'unknown'; item.stateWhy = 'the table\'s attributes could not be read'; continue; }
        item.state = cols.has(String(k.name).toLowerCase()) ? 'reuse' : 'create';
      } else if (k.kind === 'relationship') {
        // Tri-state: `null` means the probe could not tell. The apply path treats that as absent
        // (its create absorbs the race); a plan has nothing to absorb it, so it must say so.
        // The localized-label flag is deliberately NOT threaded here. Its only effect inside
        // `relationshipExists` is to suppress the `fetchEntityMetadata` fallback — and `relReader`
        // has no `fetchEntityMetadata` at all (see above), so an inconclusive probe already returns
        // `null` either way. Passing it would be inert code that reads as though it decides
        // something.
        const present = await relationshipExists(relReader, String(k.entity).toLowerCase(), k.name, k.relType);
        item.state = present === null || present === undefined ? 'unknown' : (present ? 'reuse' : 'create');
        if (item.state === 'unknown') item.stateWhy = 'the relationship metadata read was inconclusive';
      } else if (k.kind === 'app') {
        const present = await artifactPresent('app', { uniqueName: k.uniqueName });
        item.state = present ? 'reuse' : 'create';
      } else if (k.kind === 'view' || k.kind === 'chart' || k.kind === 'form') {
        // A form/view/chart on a table that does not exist yet cannot exist either, and the filter
        // would 400 on the metadata cache — so answer from the table, as the build's own lookup does.
        const t = await tableState(String(k.entity).toLowerCase());
        if (t.found === false) { item.state = 'create'; continue; }
        // …and if the TABLE probe was inconclusive, nothing about its artifacts is knowable either.
        // Without this the plan contradicts itself in adjacent lines — `? unknown` for the table and
        // a confident `+ create` for every view and form on it — and the apply never gets that far:
        // findExistingTable raises BuildHalt for exactly this state, outside any runner.run, so the
        // build aborts in `data-model`. The form arm is the worst of the three, because
        // resolveExistingFormId deliberately swallows the MetadataCache 400 and returns null, which
        // `!!` then flattens into a confident "absent".
        if (t.found === null) { item.state = 'unknown'; item.stateWhy = t.why; continue; }
        const present = await artifactPresent(k.kind, { name: k.name, entityLogicalName: String(k.entity).toLowerCase(), formType: k.formType, formId: k.formId, uniqueName: k.uniqueName });
        item.state = present === null ? 'unknown' : (present ? 'reuse' : 'create');
      }
    } catch (err) {
      item.state = 'unknown';
      item.stateWhy = String((err && err.message) || err);
    }
  }
  return plan;
}

// --- orchestrator ----------------------------------------------------------------------
function normalizeFormId(value) {
  return String(value || '').trim().replace(/^\{+|\}+$/g, '').toLowerCase();
}

function authorizedFormRemovalEntry(map, formId) {
  if (!(map instanceof Map)) return { fenced: false, authorized: null };
  const normalized = normalizeFormId(formId);
  if (map.has(normalized)) return { fenced: true, authorized: map.get(normalized), normalizedFormId: normalized };
  for (const [key, value] of map) {
    if (normalizeFormId(key) === normalized) return { fenced: true, authorized: value, normalizedFormId: normalized };
  }
  return { fenced: false, authorized: null, normalizedFormId: normalized };
}

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
    // #559: resolve create-vs-reuse against the live environment before printing the plan. Opt out
    // with `livePlan: false` for an offline/spec-only listing (the old behaviour). Probing is
    // skipped silently when the caller supplied no reader — a dry run must still work without one.
    const canProbe = opts.livePlan !== false && provision && typeof provision.queryRecords === 'function';
    if (canProbe) {
      try {
        await annotateLivePlan(plan, { spec, provision, warn: opts.warn });
      } catch (err) {
        // The plan itself is still worth printing; say the states are missing rather than implying
        // every item is a create.
        emit({ phase: 'plan', status: 'warn', label: `live plan unavailable (${(err && err.message) || err}) — showing the spec-derived plan only`, n: 0, total: plan.length });
      }
    }
    plan.forEach((p, i) => emit({ phase: p.phase, status: p.state === 'reuse' ? 'skip' : 'skip', label: p.label, state: p.state, stateWhy: p.stateWhy, n: i + 1, total: plan.length }));
    return {
      ok: true,
      dryRun: true,
      livePlan: canProbe,
      plan: plan.map((p) => (p.state ? `${p.label} [${p.state}]` : p.label)),
      planItems: plan.map((p) => ({ phase: p.phase, label: p.label, ...(p.state ? { state: p.state } : {}), ...(p.stateWhy ? { stateWhy: p.stateWhy } : {}) })),
    };
  }

  const result = { ok: true, created: { entities: {}, relationships: {}, records: {}, webResources: {}, views: {}, charts: {}, forms: {}, formIds: {}, businessRules: {}, businessProcessFlows: {}, bpfBackingTables: {}, commands: {}, dashboards: {}, pages: {}, pageDeployedShas: {}, ai: { appFeatures: null, summaries: {} }, roles: {}, roleGrants: {}, bpfRoleGrants: {}, app: null }, skipped: { businessRules: [], aiSummaries: [], layout: [], unauthorizedRemovals: [] } };
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
    const art = await provision.createArtifact('form', { name: def.name, entityLogicalName: def.entityLogicalName, formType: def.formType, status: def.status, ...(def.description ? { description: def.description } : {}) });
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

  // Fetch a just-created form before wiring its event handlers, tolerating the workspace-metadata
  // race. AB#6688905.
  //
  // `buildArtifact` resolves once the form ROW exists, but the SDK persists the workspace copy as two
  // files — `.maker-workspace/forms/<id>.json` and `.maker-workspace/.metadata/forms/<id>.meta.json`
  // — and `fetchArtifact` reads the metadata one. Under `mapLimit` several forms are written
  // concurrently, and the reporter hit the window between them:
  //   UNKNOWN: unknown error, open '...\.maker-workspace\.metadata\forms\<id>.meta.json'
  // with the sibling `.json` already on disk. `UNKNOWN` (not ENOENT) is what Windows reports for a
  // concurrent-access/sharing violation, which is why this matches on the PATH rather than the code
  // — matching only ENOENT would miss the shape that was actually observed.
  //
  // A retry is the correct remedy rather than a workaround: the reporter's second identical run
  // succeeded, so the state is transient by construction, and the build is idempotent. Bounded and
  // narrow on purpose — a form whose metadata never lands still fails, with a message that names the
  // race instead of the bare `UNKNOWN` the operator could do nothing with.
  //
  // ⚠ THE SDK NOW RETRIES TOO, and this is deliberately kept as a SECOND layer rather than deleted.
  // The vendored `WorkspaceManager` retries `EPERM`/`EACCES`/`EBUSY`/`UNKNOWN` on its own and treats a
  // file deleted between its `exists` probe and its open as absent. Two reasons this outer retry still
  // earns its place: the SDK's authors explicitly decline to call that fix MEASURED (a two-process
  // harness never reproduced the failure, so the trigger is environmental — an AV scanner or indexer
  // holding a handle), and an exhausted SDK budget rethrows the bare `UNKNOWN` unchanged, which is the
  // message the operator could do nothing with. The layering costs nothing on the happy path. Delete
  // this only against evidence that the SDK's budget is sufficient, not merely because it exists.
  const isWorkspaceMetadataRace = (err) => {
    const msg = (err && err.message) || String(err || '');
    return /[\\/]\.metadata[\\/]/.test(msg) && /\.meta\.json/.test(msg);
  };
  const fetchFormForWiring = async (id, f) => {
    const attempts = 4;
    let last;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await provision.fetchArtifact('form', id);
      } catch (err) {
        last = err;
        if (!isWorkspaceMetadataRace(err) || i === attempts - 1) break;
        // Linear, not exponential: the writer is a local file flush, so the wait needed is
        // milliseconds — a doubling backoff would spend seconds waiting for something already done.
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
    if (isWorkspaceMetadataRace(last)) {
      throw new Error(`form ${f && (f.name || f.entity)}: the workspace metadata for this form was still not readable after ${attempts} attempts `
        + `(${(last && last.message) || last}). The form row itself was created — this is a local workspace write race, not a Dataverse failure. `
        + 'Re-run the same command: the build is idempotent and the metadata will exist on the next run.');
    }
    throw last;
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
  const applyFieldPositions = async (formId, def, vacated) => {
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

      // A positioning move can CROSS sections (`fieldOptions[x].after` may anchor to a field in
      // another one), which empties the source just as a layout move does. Recording it here is what
      // keeps the vacated-section sweep honest: without it, a source section emptied by this pass —
      // and then stripped of its last field by the prune pass — survived as an orphan, because no
      // one ever added its name to the set.
      if (vacated && from.sectionPointer !== to.sectionPointer) {
        const src = sectionAt(form, from.sectionPointer);
        if (src && src.name) vacated.add(String(src.name).toLowerCase());
      }

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

  // Identity of a deployed tab/section across rebuilds, in descending order of confidence:
  //   1. NAME  — what the compiler emits, so a form this plugin created matches itself exactly.
  //   2. LABEL — what the author sees and types; survives a name this plugin did not choose
  //      (a form built in Maker, or by a much older version).
  //   3. POSITION — last resort, and the one that makes an AUTO -> EXPLICIT migration converge.
  //      The auto layout emits `tab_general`/`section_general`, while an explicit layout with no
  //      authored names emits `tab_0`/`section_0_0` — so name matching alone would append a second
  //      tab to every form this plugin had already built, on every single rebuild.
  // A container is CREATED only when all three miss, which is what stops a rebuild duplicating one.
  //
  // `claimed` carries the indices an EARLIER want already took. Without it every want is matched
  // independently, and because the compiler substitutes a DEFAULT label for an unlabeled container
  // ('General' for a tab, 'Details' for a section), an author who labels nothing produces several
  // wants with an identical label — the label pass then returns index 0 for all of them and the
  // whole layout collapses into one container. Position has the same failure with repeated indices.
  //
  // `skip` hides containers the weaker passes must not claim. Only NAME may match them, because a
  // name is positive evidence and a label/position is not.
  // Send only the keys that actually differ, so a rebuild that changes nothing issues no writes.
  const diffPatch = (live, want, keys) => {
    const patch = {};
    for (const k of keys) if (want[k] !== undefined && live[k] !== want[k]) patch[k] = want[k];
    return patch;
  };

  // Converge an EXISTING form's CONTAINER topology (tabs, form-columns, sections) onto the spec's
  // explicit layout, before any field is placed.
  //
  // Why this exists: the reconcile used to flatten an explicit layout entirely — every field was
  // appended to `firstSectionRowsPointer`, i.e. the first section of the first tab, and no tab or
  // section was ever created or reshaped. Because declaring explicit `tabs` ALSO switches pruning
  // on, an author who moved to an explicit two-column layout to reorganize a deployed form got the
  // old topology, minus any field they had not re-declared, and a successful build (#575).
  //
  // Containers are created EMPTY (`rows: []`) and every field is placed by the single pass that
  // follows. Adding a tab with its compiled cells intact would duplicate any field already on the
  // form elsewhere, and would leave two code paths that can each place a control.
  //
  // Existing containers are UPDATED IN PLACE rather than replaced, so ids — and any control a maker
  // added to a section by hand — survive. `updateElement` merges when both sides are objects, so
  // patching only the differing keys preserves everything else in the container.
  //
  // Returns the desired-section-name -> deployed-section locator map the field pass places through.
  // It cannot re-derive this by name: a position-matched section keeps its own deployed name (it is
  // deliberately NOT renamed, because form scripts and business rules can reference a section name).
  const reconcileFormTopology = async (formId, def) => {
    // An engine-owned section carries its rows INTACT when created: the field pass places only bound
    // fields, so a notes/timeline section created empty would deploy a visible section header
    // promising a control that nothing ever adds.
    const stripRows = (section) => (isEngineOwnedSection(section) ? Object.assign({}, section) : Object.assign({}, section, { rows: [] }));
    // Null-prototype, because this map is keyed by AUTHOR-CONTROLLED section names. On a plain
    // object a section legitimately named `__proto__` would mutate the prototype instead of becoming
    // an own enumerable property, so it would be invisible to `Object.values` — and the
    // vacated-section sweep would then treat a section the layout explicitly claimed as unclaimed.
    //
    // Only AUTHORED wants are recorded: the map routes the author's fields. The compiler's notes section
    // is also named `section_notes`, and an authored section may be too — recording the engine's want
    // after the author's replaced the author's target, and the field pass then poured the author's fields
    // into the timeline and the sweep removed the emptied authored section. An engine section routes no
    // field, and the sweep never removes a section that still holds its control.
    const sectionTargets = Object.create(null);
    const wantTabs = def.tabs || [];
    // The section names the AUTHOR declared, computed by the compiler from the spec with the same
    // function verify uses, so the label and position passes cannot hand one want's named section to
    // another (see claimedByAuthoredName) — and build and verify skip the same containers.
    const authoredSectionNames = new Set(def.__authoredSectionNames || []);
    // …and the subset the author NAMED. Only those are looked for across the form (see the form-wide
    // lookup below): a generated name encodes the section's place.
    const namedSectionNames = new Set(def.__namedSectionNames || []);
    // A section MOVE shifts its siblings: the ones after it in the source column slide up one. Every
    // recorded target pointer there is corrected, not only the name-less ones resolveSectionPointer
    // falls back to — the vacated-section sweep also treats recorded pointers as claims, and a stale
    // one would spare a section it should reclaim. Nothing recorded can sit at or after the INSERTION
    // point: the target column's own matches all precede it, and every other column's matches live in
    // that column (an authored name hit in another column is moved, never recorded in place; an engine
    // want, which is never moved, is never recorded at all).
    const shiftRecordedSectionPointers = (fromPointer) => {
      const split = (p) => { const m = /^(.*\/sections)\/(\d+)$/.exec(p || ''); return m ? { list: m[1], index: Number(m[2]) } : null; };
      const from = split(fromPointer);
      if (!from) return;
      for (const t of Object.values(sectionTargets)) {
        const at = t && split(t.pointer);
        if (at && at.list === from.list && at.index > from.index) t.pointer = at.list + '/' + (at.index - 1);
      }
    };
    // Indices already taken by an earlier want, so two wants can never converge on one container.
    const claimedTabs = new Set();
    const claimedSections = new Map(); // column pointer -> Set(index)
    const claimedIn = (key) => { if (!claimedSections.has(key)) claimedSections.set(key, new Set()); return claimedSections.get(key); };
    for (let ti = 0; ti < wantTabs.length; ti++) {
      const wantTab = wantTabs[ti];
      // Re-read before every mutation: addElement appends and shifts sibling indices, so a pointer
      // computed against an earlier snapshot can address the wrong container.
      let form = await provision.getArtifact('form', formId) || {};
      let tabMatch = matchContainer(form.tabs, wantTab, ti, { claimed: claimedTabs });
      if (!tabMatch) {
        // A new tab is added with EMPTY form-columns, and its sections then go through the same
        // per-section pass as an existing tab's: a section the deployed form already carries elsewhere
        // is MOVED in, and only a genuinely new one is created. Adding the tab with its sections created
        // a same-named DUPLICATE of any section it relocated — the field pass then emptied the original,
        // which the vacated-section sweep spared for its claimed name.
        await provision.addElement('form', formId, '/tabs', Object.assign({}, wantTab, {
          columns: (wantTab.columns || []).map((c) => Object.assign({}, c, { sections: [] })),
        }));
        form = await provision.getArtifact('form', formId) || {};
        tabMatch = matchContainer(form.tabs, wantTab, (form.tabs || []).length - 1, { claimed: claimedTabs });
        if (!tabMatch) continue; // defensive: the added tab could not be found again
      }
      claimedTabs.add(tabMatch.index);
      const tabPointer = '/tabs/' + tabMatch.index;
      const tabPatch = diffPatch(tabMatch.item, wantTab, ['label', 'expanded', 'visible']);
      if (Object.keys(tabPatch).length) await provision.updateElement('form', formId, tabPointer, tabPatch);

      const wantColumns = wantTab.columns || [];
      for (let ci = 0; ci < wantColumns.length; ci++) {
        form = await provision.getArtifact('form', formId) || {};
        let liveTab = (form.tabs || [])[tabMatch.index];
        if (!liveTab) break; // defensive: the tab vanished mid-reconcile
        if (ci >= (liveTab.columns || []).length) {
          // A tab that gained a form-column — e.g. a single-column form widened into two. Added EMPTY,
          // for the same reason as a new tab: its sections go through the per-section pass below.
          await provision.addElement('form', formId, tabPointer + '/columns', Object.assign({}, wantColumns[ci], { sections: [] }));
          form = await provision.getArtifact('form', formId) || {};
          liveTab = (form.tabs || [])[tabMatch.index];
          if (!liveTab || ci >= (liveTab.columns || []).length) break; // defensive: the add did not land
        }
        const liveColumns = liveTab.columns || [];
        if (wantColumns[ci].width && liveColumns[ci].width !== wantColumns[ci].width) {
          await provision.updateElement('form', formId, tabPointer + '/columns/' + ci, { width: wantColumns[ci].width });
        }
        const wantSections = wantColumns[ci].sections || [];
        for (let si = 0; si < wantSections.length; si++) {
          const wantSection = wantSections[si];
          form = await provision.getArtifact('form', formId) || {};
          const columnPointer = tabPointer + '/columns/' + ci;
          const liveSections = (((form.tabs || [])[tabMatch.index] || {}).columns || [])[ci];
          const claimedHere = claimedIn(columnPointer);
          // A section may have been dragged to a different tab in Maker, or the spec may now place it
          // somewhere else; either way it is still THAT section, so a form-wide name hit outranks a
          // positional one inside this column. A name hit INSIDE this column is preferred, so a pair of
          // same-named sections left by an older build resolves to the one already in place.
          const liveList = ((liveSections || {}).sections) || [];
          // An AUTHORED want never takes an engine HOST (the notes timeline, a sub-grid host, still under
          // the name the compiler gave it) by name, here or anywhere below. An authored section may legally
          // carry the name the engine gives its host — `section_notes` is a natural name for a section
          // holding a notes field — and taking the host MOVED it into the author's column and poured
          // authored fields into it. Such a host is simply not a candidate: the want is matched or created
          // like any other authored section — and a host a maker added a field to is still one, since it
          // still holds its control. A section a maker filled with a control but that carries an AUTHORED
          // name stays a candidate: the name is the evidence it is the author's (see isEngineHostSection). An ENGINE want, in turn, takes only a section holding its own control
          // (the notes timeline's class id): its name is shared with any authored `section_notes`, and taking
          // the author's section for its host meant an existing form never got its timeline (see
          // holdsControlOf).
          const authoredWant = !isEngineOwnedSection(wantSection);
          const engineHost = authoredWant ? null : holdsControlOf(wantSection);
          const candidate = (s) => (authoredWant ? !isEngineHostSection(s) : engineHost(s));
          const sameName = (s) => !!(s && s.name) && String(s.name).toLowerCase() === String(wantSection.name).toLowerCase() && candidate(s);
          const inColumn = wantSection.name ? liveList.findIndex((s, i) => !claimedHere.has(i) && sameName(s)) : -1;
          // The form-wide lookup is for a section the author NAMED — and for an engine want, whose host a
          // maker may have moved. A GENERATED name (`section_<tab>[_<column>]_<index>`) encodes the
          // section's place, so a section of that name elsewhere — dragged there in Maker, or another one
          // that carries it after a reorder — is not taken from there: as documented for a generated
          // section (app-spec-schema.md, "Moving a section"), it is created where the layout places it,
          // its fields follow, and the emptied original is removed. The in-column hit above still finds it
          // where it belongs, so an unchanged layout converges.
          const lookFormWide = !!wantSection.name && (!authoredWant || namedSectionNames.has(String(wantSection.name).toLowerCase()));
          let global = inColumn >= 0 ? { pointer: columnPointer + '/sections/' + inColumn, section: liveList[inColumn] }
            : (lookFormWide ? findSectionLocation(form, wantSection.name, candidate) : null);
          // A named section the spec places in THIS column but that lives elsewhere is MOVED here: the
          // same node, so its id, name, rows and any maker-set properties travel with it. It used to be
          // reused in place — its attributes patched, its location left alone — so the build reported
          // success, the section stayed in the wrong tab, and verify, which checks placement, failed.
          // It lands right after the furthest section this column has already matched — exactly the
          // sections the layout places before it here — so it follows all of them (or goes first when
          // there are none) and stays ahead of any sub-grid host appended after them.
          //
          // An ENGINE-owned want (the notes section, a sub-grid host) is never moved: the author did
          // not place it — the compiler appends it to the first tab — so a maker who moved the
          // timeline elsewhere keeps it there, and nothing verifies its placement either.
          if (global && !isEngineOwnedSection(wantSection) && !global.pointer.startsWith(columnPointer + '/sections/')) {
            const liveCount = liveList.length;
            const index = Math.min(liveCount, claimedHere.size ? Math.max(...claimedHere) + 1 : 0);
            // Named for the report before the move: after it, `global` addresses the new place.
            const fromTab = ((form.tabs || [])[global.tabIndex] || {}).name || `#${global.tabIndex + 1}`;
            const fromColumn = global.columnIndex + 1;
            // Source and target are different arrays here, so moveElement's remove-then-splice needs no
            // index compensation (it is only off by one within a single array).
            await provision.moveElement('form', formId, global.pointer, columnPointer + '/sections', { index });
            shiftRecordedSectionPointers(global.pointer);
            // Moving a section a maker may have dragged there on purpose is the spec winning, as it does
            // for a section's columns and label — so it is reported, never silent.
            if (typeof opts.warn === 'function') {
              opts.warn(`form ${def.name}: moved section '${wantSection.name}' from tab '${fromTab}' (form-column ${fromColumn}) `
                + `to tab '${liveTab.name || `#${tabMatch.index + 1}`}' (form-column ${ci + 1}), where the layout places it.`);
            }
            form = await provision.getArtifact('form', formId) || {};
            const moved = ((((form.tabs || [])[tabMatch.index] || {}).columns || [])[ci] || {}).sections || [];
            global = { pointer: columnPointer + '/sections/' + index, section: moved[index] || global.section };
          }
          // An ENGINE want has no label or position to go on: its evidence is its name and its own control,
          // both weighed above. Running it through the label and position passes let the notes section, when
          // no host qualified, take whatever maker section sat at its index — relabelled "Notes", re-flowed
          // to one column, and still no timeline.
          const local = (global || !authoredWant) ? null : matchContainer((liveSections || {}).sections, wantSection, si,
            { claimed: claimedHere, skip: (s) => isEngineOwnedSection(s) || isEngineHostSection(s) || claimedByAuthoredName(authoredSectionNames)(s), nameSkip: (s) => !candidate(s) });
          if (!global && !local) {
            // An authored section is created where the layout places it: right after the furthest section this
            // column has already matched, the index the move above uses. Appended, it landed after every
            // section still to come — a new one declared mid-column, or a generated one recreated after a
            // drag in Maker — and the build never reorders what exists, so the wrong order was permanent (and
            // verify does not check order). Nothing recorded sits at or after that index, so no recorded
            // pointer shifts. An ENGINE want is still appended: the compiler puts the notes section last.
            const at = authoredWant ? Math.min(liveList.length, claimedHere.size ? Math.max(...claimedHere) + 1 : 0) : null;
            await provision.addElement('form', formId, columnPointer + '/sections', stripRows(wantSection), ...(at === null ? [] : [{ position: { index: at } }]));
            form = await provision.getArtifact('form', formId) || {};
            const addedList = ((((form.tabs || [])[tabMatch.index] || {}).columns || [])[ci] || {}).sections || [];
            const addedIdx = at === null ? addedList.length - 1 : at;
            claimedHere.add(addedIdx);
            if (authoredWant) sectionTargets[wantSection.name] = { pointer: columnPointer + '/sections/' + addedIdx, name: (addedList[addedIdx] || {}).name };
            continue;
          }
          if (local) claimedHere.add(local.index);
          else if (global && global.pointer.startsWith(columnPointer + '/sections/')) {
            // A form-wide NAME hit inside THIS column still consumes that index. Without this, a
            // later want in the same column could match the very section the name hit already took
            // (by label or position), routing two authored sections onto one deployed section.
            const idx = Number(global.pointer.slice((columnPointer + '/sections/').length));
            if (Number.isInteger(idx)) claimedHere.add(idx);
          }
          const pointer = global ? global.pointer : columnPointer + '/sections/' + local.index;
          const live = global ? global.section : local.item;
          if (authoredWant) sectionTargets[wantSection.name] = { pointer, name: live.name };
          // `columns` is the key that matters most: it is what makes a section render as two
          // columns rather than one, and it was previously unreachable on an existing form.
          const patch = diffPatch(live, wantSection, ['columns', 'label', 'showLabel', 'visible']);
          // NARROWING the grid overflows rows that no cell changed. Three unit-width cells sit
          // legally in a 4-column row and illegally in a 1-column one, so a width change alone can
          // invalidate the layout — and the span-change repack never fires, because no span changed.
          // Live-reproduced: occupancy 3 in width 1, on both applies.
          //
          // Only a NARROWING needs this. Widening cannot overflow a row that already fitted, and
          // re-packing on every widen would reflow rows the author never asked to touch.
          const narrowing = patch.columns !== undefined && Number(patch.columns) < Number(live.columns || 1);
          let reflow = narrowing;
          if (narrowing && reflowBreaksReservation(live.rows)) {
            // A reflow here would move a cell into a row-spanning cell's reservation, so it cannot
            // run — and the decision has to be made BEFORE the width is written. Writing the width
            // and then refusing the reflow left rows overflowing the new grid for good: the next
            // apply sees the width already applied and has nothing to do.
            const width = Number(patch.columns);
            reflow = false;
            if (!fitsGrid(live.rows || [], width)) {
              delete patch.columns;
              reportLayoutSkip(`form section '${live.name || pointer}' keeps its ${live.columns}-column grid: narrowing it `
                + `to ${width} would overflow rows that cannot be re-flowed without moving a cell into a row-spanning `
                + 'cell\'s reservation. Adjust the layout in the maker.');
            }
            // …otherwise every row already fits the narrower grid: the width is written and nothing
            // is moved, because a reflow would only reshuffle cells that are already valid.
          }
          if (Object.keys(patch).length) await provision.updateElement('form', formId, pointer, patch);
          if (reflow) await repackSectionRows(formId, pointer, Number(patch.columns));
        }
      }
    }
    return sectionTargets;
  };

  // Resolve a section target recorded during the topology pass back to a live pointer.
  // Prefer the deployed NAME (stable across the row-level mutations the field pass makes) and fall
  // back to the recorded pointer for a section that carries no name at all.
  const resolveSectionPointer = (form, target) => {
    if (!target) return null;
    // The recorded pointer, when the section there still carries the recorded name, is EXACT — and
    // only it can tell two same-named sections apart (a real one and an empty twin an older build left
    // in another tab), where a name search always returns the first in document order. Section indices
    // do not move under the field pass (it mutates rows and cells; the topology pass corrects them
    // across its own section moves), so a mismatch means the pointer went stale, and the name decides.
    if (target.name && target.pointer) {
      const at = sectionAt(form, target.pointer);
      if (at && String(at.name || '').toLowerCase() === String(target.name).toLowerCase()) return target.pointer;
    }
    if (target.name) {
      const loc = findSectionLocation(form, target.name);
      if (loc) return loc.pointer;
    }
    return target.pointer || null;
  };

  const sectionAt = (form, pointer) => {
    const t = String(pointer || '').split('/').filter(Boolean);
    if (t.length !== 6) return null;
    const tab = (form.tabs || [])[Number(t[1])];
    const col = tab && (tab.columns || [])[Number(t[3])];
    return (col && (col.sections || [])[Number(t[5])]) || null;
  };

  // Reflow an ENTIRE section against a new grid width, using the create path's own packer so both
  // routes produce the same shape. Called when a section NARROWS: no cell changed, but rows that
  // fitted the old width can overrun the new one.
  //
  // The cells are re-laid in their existing reading order, so the author's field order survives, and
  // they are MOVED (written as cells arrays) rather than recreated, so ids and any maker-edited
  // control state survive with them. Rows beyond the new count are removed from the END backwards,
  // because removing by index shifts every later index.
  const repackSectionRows = async (formId, sectionPointer, width) => {
    const form = await provision.getArtifact('form', formId) || {};
    const section = sectionAt(form, sectionPointer);
    if (!section) return;
    const liveRows = section.rows || [];
    // A ROWSPAN makes a row's cells positionally meaningful: the cell beneath a vertically spanning
    // one is a SPACER reserving the covered slot, and reading-order flattening moves it beside the
    // spanning cell instead of under it. Live shape, narrowed 4 -> 2, before this guard:
    //     [A rowspan=2] [spacer, B] [C, D]   became   [A rowspan=2, spacer] [B, C] [D]
    // i.e. B took the reserved position. `rowsFromCells` models width only, so it cannot express
    // that reservation — and the authored-rowspan restriction does not help, because the span
    // belongs to the fetched MAKER form, not to the spec.
    //
    // REFUSE rather than guess. Leaving a maker's valid arrangement alone is the recoverable
    // outcome; silently rearranging their form is not. The caller makes this decision BEFORE it
    // writes the new width (so the grid and its rows never disagree); this is the backstop for any
    // future caller that does not.
    if (reflowBreaksReservation(liveRows)) {
      reportLayoutSkip(`form section at ${sectionPointer}: its rows were left as they are rather than re-flowed to `
        + `${width} column(s) — re-flowing them would move a cell into a row-spanning cell's reservation. `
        + 'Adjust the layout in the maker if it no longer fits.');
      return;
    }
    const cells = liveRows.flatMap((r) => (r && r.cells) || []);
    if (!cells.length) return;
    const packed = rowsFromCells(cells, width);
    const live = liveRows;
    // Nothing to do only when the existing rows match the packing the new width implies — INCLUDING
    // each cell's span. Comparing field names alone discarded exactly the change this exists to make:
    // `rowsFromCells` clamps a too-wide cell without moving it, so a section narrowed to 1 while
    // holding a colspan-4 cell had identical row membership and was judged unchanged. The stale
    // width then survived, and a second apply issued no corrective write either.
    const shapeOf = (rows) => JSON.stringify((rows || []).map((r) => ((r && r.cells) || []).map((c) => [
      c.control && c.control.fieldName,
      Number(c.colspan) || 1,
      Number(c.rowspan) || 1,
    ])));
    if (shapeOf(packed) === shapeOf(live)) return;
    for (let i = 0; i < packed.length; i += 1) {
      if (i < live.length) {
        await provision.updateElement('form', formId, `${sectionPointer}/rows/${i}`, { cells: packed[i].cells });
      } else {
        await provision.addElement('form', formId, `${sectionPointer}/rows`, { cells: [] });
        await provision.updateElement('form', formId, `${sectionPointer}/rows/${i}`, { cells: packed[i].cells });
      }
    }
    for (let i = live.length - 1; i >= packed.length; i -= 1) {
      await provision.removeElement('form', formId, `${sectionPointer}/rows/${i}`);
    }
  };

  // Re-laying rows by reading order is unsafe exactly when a cell FOLLOWS a row-spanning one. That
  // later cell — or the empty spacer holding a covered slot — has a position only relative to the
  // span above it, and `rowsFromCells` models WIDTH only, so a reflow can move it into the reserved
  // slot. A section whose row spans are all TRAILING reflows safely: nothing comes after the span to
  // land in its reservation. Stock account and contact Main forms put `rowspan` on the last cell of
  // a section, so treating every rowspan as unsafe refused exactly the commonest real shape.
  //
  // Shared by BOTH reflow routes (whole-section on a grid narrowing, single-row on a span change).
  // It does not cover PLACING a new or moved field into such a section: that path predates these
  // guards and needs spacer-aware placement (#581).
  const reflowBreaksReservation = (rows) => {
    let spanning = false;
    for (const r of rows || []) {
      for (const c of (r && r.cells) || []) {
        if (spanning) return true;
        if ((Number(c.rowspan) || 1) > 1) spanning = true;
      }
    }
    return false;
  };
  const rowWidth = (cells) => (cells || []).reduce((n, c) => n + (Number(c.colspan) || 1), 0);
  const maxRowspan = (rows) => Math.max(1, ...(rows || []).flatMap((r) => ((r && r.cells) || []).map((c) => Number(c.rowspan) || 1)));
  const rowReservationAt = (rows, rowIndex) => {
    const padded = (rows || []).slice();
    while (padded.length <= rowIndex) padded.push({ cells: [] });
    const occupancy = rowOccupancy(padded)[rowIndex];
    return occupancy ? occupancy.reserved : 0;
  };
  const fitsWithCellAtRow = (rows, rowIndex, cell, width) => {
    const row = ((rows || [])[rowIndex]) || { cells: [] };
    return cellFitsInRow(row, cell, width, rowReservationAt(rows, rowIndex));
  };
  const firstAppendRowThatFits = (rows, cell, width) => {
    const start = Math.max(0, (rows || []).length - 1);
    const limit = (rows || []).length + maxRowspan(rows);
    for (let rowIndex = start; rowIndex <= limit; rowIndex += 1) {
      if (fitsWithCellAtRow(rows, rowIndex, cell, width)) return rowIndex;
    }
    return Math.max(0, (rows || []).length);
  };
  // Whether any cell — a field or an empty spacer — comes after (rowIndex, cellIndex) in reading order.
  const cellFollows = (rows, rowIndex, cellIndex) => (rows || []).some((r, ri) => ri >= rowIndex
    && ((r && r.cells) || []).some((_, ci) => ri > rowIndex || ci > cellIndex));

  // A layout change the build declined to make. Reported, AND recorded on the result: a stderr line
  // alone is invisible to a non-interactive run, and `--verify` does not check every route — an
  // auto layout's topology is never verified, so a skipped `fieldOptions` span would pass silently.
  const reportLayoutSkip = (message) => {
    result.skipped.layout.push(message);
    if (typeof opts.warn === 'function') opts.warn(message);
  };

  // The span to WRITE for a cell landing in `liveSection`: the authored value when there is one,
  // else the compiled one, with `colspan` clamped to the LIVE grid. `undefined` means no opinion —
  // a span the author never declared is never written, so a maker's hand-widened cell survives.
  //
  // Clamped against the section the write actually lands in, NOT the one the compiler laid out. On
  // an existing form they can differ: an AUTO layout compiles a synthetic section of one column (two
  // once it holds more than six fields) while reconcile deliberately keeps the deployed geometry, so
  // the compiled clamp narrowed a maker's four-column cell. `rawSpan` is the authored value carried
  // past compilation for exactly this.
  // Used by BOTH the existing-cell route and the add route — the add route once used the compiled
  // span alone, so a newly added field landed narrow and was only widened by a second apply.
  const spanForLiveSection = (key, wantCell, rawSpan, liveSection) => {
    const raw = rawSpan && typeof rawSpan[key] === 'number' ? rawSpan[key] : undefined;
    const compiled = wantCell && wantCell[key];
    if (raw === undefined && compiled === undefined) return undefined;
    const value = raw === undefined ? compiled : raw;
    if (key !== 'colspan') return value; // only colspan is bounded by the grid
    return Math.min(value, Math.max(1, Math.min(4, Number(liveSection && liveSection.columns) || 1)));
  };

  // Write an authored `colspan`/`rowspan` onto a cell that is already on the form. Only a span the
  // author explicitly declared is sent, and only when the deployed value differs, so a rebuild that
  // changes nothing issues no writes.
  const convergeCellSpans = async (formId, form, location, wantCell, rawSpan) => {
    if (!location || !wantCell) return;
    const live = cellAt(form, location);
    if (!live) return;
    const liveSection = sectionAt(form, location.sectionPointer) || {};
    const patch = {};
    for (const key of ['colspan', 'rowspan']) {
      const want = spanForLiveSection(key, wantCell, rawSpan, liveSection);
      if (want === undefined) continue; // no opinion — never overwrite a maker's span
      const current = live[key] === undefined ? 1 : live[key];
      if (current !== want) patch[key] = want;
    }
    if (!Object.keys(patch).length) return;

    // A span change can require a REFLOW of its row, and a reflow by reading order cannot honour a
    // row-spanning cell's reservation. For example, on a maker form holding
    // `[A rowspan=2, B] / [spacer]`, widening `B` overflows the row, and `repackRowAt` splits it
    // by reading order — placing `B` in the row `A` reserves. Judged on the rows AS THEY WILL BE.
    const current = await provision.getArtifact('form', formId) || {};
    const sec = sectionAt(current, location.sectionPointer) || {};
    const rows = sec.rows || [];
    const field = (live.control && live.control.fieldName) || location.cellPointer;
    // A rowspan RAISED on a cell that other cells follow creates a reservation they must route
    // around: the next row's cells are displaced past the covered slot, so a full row beneath needs
    // more columns than its grid has — even when the patched row itself still fits, which the
    // overflow check below cannot see. The validator only allows an authored rowspan on the LAST
    // field of the spec's list, but the reconcile keeps a staying cell where the maker put it, so the
    // deployed order can differ. Only the rowspan is withheld; a colspan in the same patch proceeds.
    if (patch.rowspan !== undefined && patch.rowspan > (Number(live.rowspan) || 1)
      && cellFollows(rows, location.rowIndex, location.cellIndex)) {
      delete patch.rowspan;
      reportLayoutSkip(`form section at ${location.sectionPointer}: the rowspan on '${field}' was not applied — `
        + 'other cells follow it, and a row-spanning cell displaces the cells beneath it. Make it the last '
        + 'field of its section in the maker.');
      if (!Object.keys(patch).length) return;
    }
    const row = rows[location.rowIndex];
    const beforeCells = (row && row.cells) || [];
    const afterCells = beforeCells.map((c, i) => (i === location.cellIndex ? { ...c, ...patch } : c));
    const afterRows = rows.map((r, i) => (i === location.rowIndex ? { ...r, cells: afterCells } : r));
    const patchedCell = afterCells[location.cellIndex] || live;
    const occupiedUntil = location.rowIndex + Math.max(1, Number(patchedCell && patchedCell.rowspan) || 1) - 1;
    const paddedAfterRows = afterRows.slice();
    while (paddedAfterRows.length <= occupiedUntil) paddedAfterRows.push({ cells: [] });
    const occupancy = rowOccupancy(paddedAfterRows);
    const overflows = occupancy.slice(location.rowIndex, occupiedUntil + 1)
      .some((row) => row && row.used > (Number(sec.columns) || 1));
    const unsafe = reflowBreaksReservation(afterRows);
    if (overflows && unsafe) {
      if (rowWidth(afterCells) > rowWidth(beforeCells)) {
        // A WIDENING into an overflow: skipped whole, not half-applied. Applying it without the
        // reflow would leave an overflowing row — a shape `rowsFromCells` would never emit and
        // Dataverse renders unpredictably — which is worse than a form that does not match the spec.
        reportLayoutSkip(`form section at ${location.sectionPointer}: the span change on '${field}' was skipped — `
          + 'it would overflow the row, and re-flowing that row would move a cell into a row-spanning cell\'s '
          + 'reservation. Adjust the layout in the maker.');
        return;
      }
      // A narrowing inside a row that ALREADY overflowed is strictly an improvement, so it is
      // written — but the row is not re-flowed, for the same reason.
      await provision.updateElement('form', formId, location.cellPointer, patch);
      reportLayoutSkip(`form section at ${location.sectionPointer}: the span change on '${field}' was applied, `
        + 'but its row still overflows the grid and was NOT re-flowed — that would move a cell into a '
        + 'row-spanning cell\'s reservation. Adjust the layout in the maker.');
      return;
    }
    await provision.updateElement('form', formId, location.cellPointer, patch);
    // A WIDENED span can overflow the row it sits in: a 2-column section holding two colspan-1
    // cells becomes 2+1 = 3 columns of content the moment one is widened to 2. The create path
    // packs rows by WIDTH (`rowsFromCells`), but an in-place span change never re-ran that
    // packing, so the row was left overflowing — a shape `rowsFromCells` would never emit, and one
    // Dataverse renders unpredictably. Live-reproduced: widening a field left three columns of
    // content in a two-column row across two applies.
    await repackRowAt(formId, location);
  };

  // Re-pack the row a span change just overflowed, using the create path's own packer so both routes
  // produce the same shape. The displaced cells move DOWN into rows inserted immediately below,
  // rather than to the bottom of the section, so the author's field order survives.
  //
  // The cells are moved by `updateElement` (the same mechanism `appendCellPacked` uses to write a
  // cells array), and the new rows are created EMPTY first — an existing cell carries an `id`, and
  // handing one to `addElement` risks re-keying the node rather than moving it.
  const repackRowAt = async (formId, location) => {
    const form = await provision.getArtifact('form', formId) || {};
    const section = sectionAt(form, location.sectionPointer);
    const row = section && (section.rows || [])[location.rowIndex];
    if (!row) return;
    const packed = rowsFromCells(row.cells || [], section.columns);
    if (packed.length <= 1) return; // still fits — nothing to do
    for (let k = 1; k < packed.length; k += 1) {
      await provision.addElement('form', formId, location.sectionPointer + '/rows', { cells: [] },
        // The SDK's position resolver accepts `undefined | 'end' | 'start' | {index} | {before} |
        // {after}` and tests `'index' in position`, so a BARE NUMBER throws
        // "Cannot use 'in' operator to search for 'index' in 1".
        { position: { index: location.rowIndex + k } });
      await provision.updateElement('form', formId,
        `${location.sectionPointer}/rows/${location.rowIndex + k}`, { cells: packed[k].cells });
    }
    await provision.updateElement('form', formId,
      `${location.sectionPointer}/rows/${location.rowIndex}`, { cells: packed[0].cells });
  };

  // The live cell a findFieldCellLocation result points at.
  const cellAt = (form, location) => {
    const section = sectionAt(form, location.sectionPointer);
    const row = section && (section.rows || [])[location.rowIndex];
    return (row && (row.cells || [])[location.cellIndex]) || null;
  };

  // Place one field in the section the layout declares, whether it is absent or merely misplaced.
  //
  // A field whose declared section could not be resolved falls back to the form's first section —
  // exactly the pre-existing behavior. A layout the topology pass could not materialize must still
  // never lose a field.
  // Append a cell to a section, PACKING it the way the create path does.
  //
  // `rowsFromCells` fills a row until the section's grid width is used, so a 2-column section holds
  // two single-width fields per row. The reconcile path used to ignore that entirely — every ADDED
  // field became its own single-cell row and every MOVED field was appended to the last row whatever
  // its width — so the same spec deployed a different shape depending only on whether the form
  // already existed. The effective-capacity check below is the create path's width rule plus
  // any columns still reserved by row-spanning cells above the target row.
  //
  // MEASURED against the vendored bundle: `addElement` REFUSES a `.../rows/<i>/cells` pointer
  // ("Path not found in form/<id>"), so a cell cannot be appended to an existing row that way. The
  // row is rewritten instead — `updateElement` replaces the `cells` array, and re-sending the
  // existing cell objects carries their `id` and `control.id` through verbatim (measured), so this
  // neither mints new ids nor drops adapter-derived control state.
  const appendCellPacked = async (formId, form, sectionPointer, wantCell) => {
    const section = sectionAt(form, sectionPointer) || {};
    const rows = section.rows || [];
    const rowIndex = firstAppendRowThatFits(rows, wantCell, section.columns);
    while ((section.rows || []).length < rowIndex) {
      await provision.addElement('form', formId, sectionPointer + '/rows', { cells: [] });
      section.rows = [...(section.rows || []), { cells: [] }];
    }
    if (rowIndex < rows.length) {
      await provision.updateElement('form', formId, sectionPointer + '/rows/' + rowIndex,
        { cells: [...(rows[rowIndex].cells || []), wantCell] });
      return;
    }
    await provision.addElement('form', formId, sectionPointer + '/rows', { cells: [wantCell] });
  };

  const placeFieldInSection = async (formId, logical, wantCell, target, vacated, rawSpan) => {
    let form = await provision.getArtifact('form', formId) || {};
    const targetPointer = resolveSectionPointer(form, target);
    const existing = findFieldCellLocation(form, logical);

    if (!existing) {
      const rowsPtr = targetPointer ? targetPointer + '/rows' : firstSectionRowsPointer(form);
      if (!rowsPtr) return;
      const sectionPointer = rowsPtr.slice(0, -'/rows'.length);
      // Span the NEW cell for the section it is landing in, by the same rule as an existing one.
      // The compiled cell alone carried the compiler's clamp, which for an auto layout is a
      // synthetic one- or two-column section: a field added to a four-column maker form arrived
      // narrow and was only widened — and its row reflowed — by a SECOND apply of the same spec.
      const liveSection = sectionAt(form, sectionPointer) || {};
      const cell = { ...wantCell };
      for (const key of ['colspan', 'rowspan']) {
        const span = spanForLiveSection(key, wantCell, rawSpan, liveSection);
        if (span === undefined) delete cell[key]; else cell[key] = span;
      }
      await appendCellPacked(formId, form, sectionPointer, cell);
      return;
    }
    // Converge the cell SHAPE even when the cell is already where it belongs. `colspan`/`rowspan`
    // used to be create-only on an existing form: an author who widened a field to `colspan: 2` on a
    // deployed form got a green build and an unchanged cell.
    //
    // Only spans the author EXPLICITLY set are written. `fieldCellIntent` omits a span of 1, so an
    // absent span means "no opinion" and leaves a cell a maker widened by hand alone — the same rule
    // that keeps `isReadOnly: false` from ever being written.
    //
    // Converging BEFORE a relocation would clamp the span against the section the cell is LEAVING:
    // a `colspan: 4` bound for a 4-column destination was cut to the 2-column source's width and
    // then moved, arriving narrower than authored (and only widening on a second apply). So when the
    // cell is staying, converge here; when it is moving, converge in the DESTINATION after the move.
    const staying = !targetPointer || existing.sectionPointer === targetPointer;
    if (staying) {
      await convergeCellSpans(formId, form, existing, wantCell, rawSpan);
      // Already on the form and already in the right section (or we have no opinion) — leave it be,
      // so a rebuild converges instead of reshuffling the form on every run.
      return;
    }

    // Misplaced: relocate the CELL rather than delete-and-recreate it, so its id and any
    // adapter-derived or maker-edited control state survive the move.
    //
    // Record the section this cell is LEAVING. That is what makes the vacated-section sweep precise:
    // "empty" alone cannot distinguish a section this run emptied from one a maker created empty and
    // may reference from a form script.
    const sourceSection = sectionAt(form, existing.sectionPointer);
    if (vacated && sourceSection && sourceSection.name) vacated.add(String(sourceSection.name).toLowerCase());
    //
    // The destination ROW is chosen by the same packing rule the create path uses, not simply the
    // last one: appending every relocated field to `rows.length - 1` piled four fields into a single
    // row of a 2-column section, a shape `rowsFromCells` would never emit.
    const targetSection = sectionAt(form, targetPointer) || {};
    const targetRows = targetSection.rows || [];
    // Captured BEFORE the add below. `getArtifact` can hand back a live reference to the artifact
    // tree rather than a copy, so `targetRows` may be the very array `addElement` pushes into —
    // reading `.length` afterwards would yield the POST-add count and target a row one past the end,
    // which silently skips the move (the `if (!row) return` guard below).
    const priorRowCount = targetRows.length;
    let rowIndex = firstAppendRowThatFits(targetRows, wantCell, targetSection.columns);
    while (rowIndex >= priorRowCount && ((targetSection.rows || []).length <= rowIndex)) {
      // Either the section this run just created has no row yet, or all existing rows whose carried
      // row-span reservations leave enough capacity are behind us. The SDK accepts a row with an
      // empty cells array and serializes it correctly, so seed rows until the chosen target exists.
      await provision.addElement('form', formId, targetPointer + '/rows', { cells: [] });
      targetSection.rows = [...(targetSection.rows || []), { cells: [] }];
    }
    form = await provision.getArtifact('form', formId) || {};
    const from = findFieldCellLocation(form, logical);
    const liveTarget = resolveSectionPointer(form, target);
    if (!from || !liveTarget) return;
    const row = ((sectionAt(form, liveTarget) || {}).rows || [])[rowIndex];
    if (!row) return;
    await provision.moveElement('form', formId, from.cellPointer, liveTarget + '/rows/' + rowIndex + '/cells', { index: (row.cells || []).length });
    // Moving the only cell out of a row leaves an empty `<row/>` that renders as a blank line and
    // would accumulate one per relocated field. Row indices are unchanged by a cell move, so the
    // source row is still where it was.
    if (from.rowCellCount === 1) {
      const after = await provision.getArtifact('form', formId) || {};
      const stranded = jsonPointerRow(after, from.rowPointer);
      if (stranded && (stranded.cells || []).length === 0) {
        await provision.removeElement('form', formId, from.rowPointer);
      }
    }

    // Converge the span NOW, in the destination, so it is clamped and packed against the section the
    // cell actually landed in rather than the one it left. Re-resolve the location: the move (and a
    // possible stranded-row removal) invalidated every pointer computed above.
    const settledForm = await provision.getArtifact('form', formId) || {};
    const settled = findFieldCellLocation(settledForm, logical);
    if (settled) await convergeCellSpans(formId, settledForm, settled, wantCell, rawSpan);
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
    // An EXPLICIT layout is author-controlled topology, so converge the containers first and then
    // place every field into the section that layout names. An AUTO layout has exactly one section
    // and no authored structure to honor, so it keeps the additive first-section behavior —
    // reshaping a form a maker built by hand is not something an auto layout ever asked for.
    let declaredSection = {};
    // Null-prototype: keyed by AUTHOR-CONTROLLED section names, so a section legitimately named
    // `__proto__` must land as an own enumerable property. On a plain object that assignment mutates
    // the prototype instead, leaving the claimed-set lookup below blind to it — and the sweep then
    // deleted a section the layout had explicitly asked for.
    let sectionTargets = Object.create(null);
    // Sections this run EMPTIED, by deployed name. The vacated-section sweep considers only these:
    // "holds no cells" cannot tell a section we just emptied from one a maker created empty and may
    // show/hide from a form script, and deleting the latter is invisible to the destructive preflight.
    const vacatedSections = new Set();
    if (def.__explicitLayout) {
      declaredSection = declaredSectionByField(def.tabs);
      sectionTargets = await reconcileFormTopology(formId, def);
    }
    // RAW authored spans, kept off the compiled cells because a cell is pushed verbatim to the SDK.
    // Reconcile re-clamps them against the section it actually writes into: the compiled span is
    // clamped to the COMPILER's section, which for an auto layout is a synthetic one- or two-column
    // stand-in that reconcile never deploys.
    const rawSpans = def.__fieldSpans || {};
    for (const logical of want) {
      await placeFieldInSection(formId, logical, wantCellByLogical[logical], sectionTargets[declaredSection[logical]], vacatedSections, rawSpans[logical]);
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
    await applyFieldPositions(formId, def, vacatedSections);
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
      const { fenced, authorized, normalizedFormId } = authorizedFormRemovalEntry(opts.authorizedFormRemovals, formId);
      for (const logical of formFieldLogicals(await provision.getArtifact('form', formId) || {})) {
        if (wantSet.has(logical) || logical === primary) continue;
        if (fenced && (!authorized || !authorized.has(logical))) {
          // The preflight gate records the exact live field list the maker approved before this run.
          // If a later form read sees more fields, deleting them would exceed that approval (another
          // maker may have added the field while this build was starting), so keep the field and make
          // the skipped destructive change visible on the build result.
          result.skipped.unauthorizedRemovals.push({ formId: normalizedFormId, form: def.name, field: logical });
          reportLayoutSkip(`form ${def.name}: kept field '${logical}' because it was not among the removals authorized when this run started. Another maker may have added it; re-run to review it.`);
          continue;
        }
        const pruneForm = await provision.getArtifact('form', formId) || {};
        const loc = findFieldCellLocation(pruneForm, logical);
        // Pruning can empty a section too, so it feeds the vacated set on the same terms as a move.
        if (loc) {
          const sec = sectionAt(pruneForm, loc.sectionPointer);
          if (sec && sec.name) vacatedSections.add(String(sec.name).toLowerCase());
        }
        const ptr = loc ? loc.cellPointer : findFieldCellPointer(pruneForm, logical);
        if (ptr) await provision.removeElement('form', formId, ptr);
      }
    }
    // Reclaim a section the layout VACATED (#581). A generated section name encodes position
    // (`section_<tab>[_<column>]_<index>`), so moving a section between form-columns or tabs under a
    // generated name changes its identity: the topology pass creates a new one and the old one is
    // never matched again. The field pass then empties it, leaving a deployed form with two sections
    // headed the same thing, one of them blank — stable across rebuilds and permanently wrong.
    //
    // Runs LAST, after the field placement and prune passes, because only then is a vacated section
    // actually empty. Four conditions, each load-bearing:
    //   · explicit layout + prune ON — the same gate the field prune uses. An `auto` layout has no
    //     authored shape to vacate, and `prune: false` means "leave what I did not re-declare".
    //   · THIS RUN emptied it. `vacatedSections` records every section a cell was moved or pruned
    //     out of. Without this the sweep deleted a section a maker had created empty and may
    //     show/hide from a form script — an unchanged layout would silently destroy it, and the
    //     destructive preflight cannot see it because that compares fields, not containers.
    //   · the section is NOT one the authored layout claimed — judged by the section each target
    //     RESOLVES to on the live form, not by name: two same-named sections (a real one and a copy an
    //     older build left in another tab) share a name, and a name test spared the emptied copy
    //     forever while the field pass had moved everything into the real one.
    //   · it holds NO cells at all — not merely no bound fields. A section can carry a spacer or a
    //     control this reader does not model, and an empty-LOOKING section is not an empty one.
    //
    // That last test is also what protects the ENGINE's own sections. An explicit
    // `isEngineOwnedSection` check was written here first and then removed as dead: that predicate is
    // `cells.length > 0 && every cell unbound`, so anything it calls engine-owned already has cells
    // and is spared above. Mutation testing proved it unkillable, and a guard that cannot fail
    // implies coverage that does not exist.
    if (def.__explicitLayout && def.__prune !== false) {
      // Collected from a single read and removed from the BACK, because removeElement shifts the
      // indices of later siblings — deleting front-first would silently target the wrong section.
      const orphans = [];
      const live = await provision.getArtifact('form', formId) || {};
      const claimedPointers = new Set();
      for (const t of Object.values(sectionTargets || {})) {
        const p = t && resolveSectionPointer(live, t);
        if (p) claimedPointers.add(p);
      }
      (live.tabs || []).forEach((tab, ti) => {
        (tab.columns || []).forEach((col, ci) => {
          (col.sections || []).forEach((sec, si) => {
            const pointer = `/tabs/${ti}/columns/${ci}/sections/${si}`;
            if (claimedPointers.has(pointer)) return;
            const secName = sec && sec.name ? String(sec.name).toLowerCase() : null;
            if (!secName || !vacatedSections.has(secName)) return;
            const cells = ((sec && sec.rows) || []).flatMap((r) => (r && r.cells) || []);
            if (cells.length) return;
            orphans.push({ pointer, name: (sec && sec.name) || '(unnamed)', label: (sec && sec.label) || '' });
          });
        });
      });
      for (const o of orphans.slice().reverse()) {
        await provision.removeElement('form', formId, o.pointer);
        if (typeof opts.warn === 'function') {
          // The naming hint helps only a GENERATED name (`section_<tab>[_<column>]_<index>`), which is
          // the one that loses its identity on a move; a named copy or a dropped section needs none. The
          // shape alone is not proof: an author may NAME a section `section_0_0`, and a copy of that
          // needs no advice to give it a name.
          const generated = /^section_\d+(?:_\d+)?_\d+$/.test(String(o.name)) && !(def.__namedSectionNames || []).includes(String(o.name).toLowerCase());
          opts.warn(`form ${def.name}: removed the now-empty section '${o.name}'${o.label ? ` ("${o.label}")` : ''} — the layout no longer places anything in it.${generated ? ' Give a section an explicit `name` if you intend to move it between tabs or form-columns.' : ''}`);
        }
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
  const reconcileView = async (viewId, def, authoredQuery) => {
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
    // An EXISTING view's FetchXML (filters + sort) is not reapplied here — only columns and the
    // description converge. Silence made an authored filter edit look applied when it was not, so
    // the no-op is reported instead. It is a warning rather than a failure because the common way to
    // hit it is entirely benign: the build reconciles onto the platform's auto-generated
    // "Active <Plural>" view, which every table already has.
    //
    // `authoredQuery` is passed in rather than derived from `def`, because `viewDef` folds the
    // implicit `statecode eq 0` of `activeOnly` into the same `filters.conditions` array as the
    // author's own — so a non-empty array does not mean the author declared anything, and warning
    // off it would fire on every rebuild of every view. `--verify` proves the deployed fetchxml
    // separately and FAILS on a divergence; this explains what verification will report.
    if (authoredQuery && typeof opts.warn === 'function') {
      opts.warn(`view '${def.name}' already exists — its columns and description were updated, but authored filters/sort are NOT reapplied to an existing view. Rename the view to author a separate one, or adjust its filters in Maker.`);
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
  const promoteDefaultForm = async (formId, entityLogical, deactivateOthers, siblingFormIds = []) => {
    // Deactivating the OTHER main forms is only safe once OUR form is the entity default: if the
    // isdefault promote failed we must NOT deactivate the others, or the entity could be left with its
    // (now-deactivated) stock form still the default and no active default — a bricked form experience.
    let promoted = false;
    try {
      await provision.updateRecord('systemform', formId, { isdefault: true });
      promoted = true;
    } catch (err) {
      // Best-effort for the BUILD (leave promoted=false so the destructive deactivation below is
      // skipped), but no longer SILENT. Swallowing this outright let a build record a selected
      // default form it had not actually promoted, and report success — the exact silent-partial
      // class `--verify` exists to catch. Verification now proves `systemform.isdefault`
      // independently, so this warning is the signal that explains the failure it will report.
      const reason = (err && err.message) ? String(err.message).slice(0, 200) : 'unknown error';
      if (typeof opts.warn === 'function') opts.warn(`could not make form the default for '${entityLogical}': ${reason} — the table keeps its previous default form`);
    }
    if (!promoted) return promoted;
    if (typeof provision.queryRecords === 'function') {
      for (const siblingId of siblingFormIds || []) {
        if (!siblingId || String(siblingId) === String(formId)) continue;
        try {
          const rows = await provision.queryRecords('systemform', {
            select: ['formid', 'isdefault'],
            filter: `formid eq ${siblingId}`,
            top: 1,
          });
          const sibling = rows && rows[0];
          if (sibling && sibling.isdefault === true) {
            await provision.updateRecord('systemform', String(sibling.formid || siblingId), { isdefault: false });
          }
        } catch (err) {
          const reason = (err && err.message) ? String(err.message).slice(0, 200) : 'unknown error';
          if (typeof opts.warn === 'function') opts.warn(`could not clear the previous default Main form for '${entityLogical}': ${reason}`);
        }
      }
    }
    if (!deactivateOthers) return promoted;
    if (typeof provision.queryRecords !== 'function') return promoted;
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
    return promoted;
  };

  // helper: create an artifact — or UPDATE it in place if it already exists — then add to the solution.
  const buildArtifact = (type, def, meta) => runner.run(`${type}s`, `${type} "${def.name}"`, async () => {
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
      if (existingId) return await reconcileForm(existingId, def);
    } else if (type === 'view') {
      const existingId = await provision.findArtifact('view', { name: def.name, entity: def.entityLogicalName });
      if (existingId) return await reconcileView(existingId, def, !!(meta && meta.authoredQuery));
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
      id = (await provision.createArtifact(type, def)).id;
    }
    const pushed = requireSuccessfulPush(await provision.pushArtifact(type, id), `${type} ${def.name}`, opts.warn);
    await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE[type], solutionUniqueName: sol.uniqueName });
    return pushed.id;
  });

  // 4. Views (independent -> parallel).
  if (has('views')) {
    const ids = await runner.mapLimit(spec.views || [], concurrency, (v) => buildArtifact('view', viewDef(spec, v), { authoredQuery: !!((v.filters || []).length || (v.sort || []).length) }));
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
        const art = await provision.createArtifact('chart', def);
        const pushed = requireSuccessfulPush(await provision.pushArtifact('chart', art.id), `chart ${def.name}`, opts.warn);
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.chart, solutionUniqueName: sol.uniqueName });
        // Created here, so it IS workspace-resident and publishable.
        chartsToPublish.set(String(def.entityLogicalName || '').toLowerCase(), pushed.id);
        return pushed.id;
      });
    });
    charts.forEach((c, i) => { result.created.charts[`${String(c.entity).toLowerCase()}|${c.name}`] = ids[i]; });
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
      const wantedEvents = (d.f.events || []).filter((ev) => FORM_EVENTS.has(ev.event) && ev.library && ev.function);
      if (wantedEvents.length) {
        await runner.run('forms', `wire ${wantedEvents.length} event handler(s) on ${d.f.entity}`, async () => {
          await fetchFormForWiring(id, d.f);
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
    //
    // AB#6686426 — default-form promotion, ONCE per entity, AFTER every form exists.
    //
    // This used to run inside the concurrent per-form build above, so on a table with several Main
    // forms every one of them promoted itself and the LAST to finish won. Which form a table opened
    // with therefore depended on completion order — an alternate read-only or OnSave-blocked form
    // could silently become the default, changing normal app behaviour.
    //
    // Selection is explicit first (`forms[].isDefault`), then a documented stable fallback: the FIRST
    // Main form in spec order. Both are order-independent, which is the property that was missing.
    // Still guarded to a table THIS build owns — re-pointing the default form of a system or reused
    // table is an environment-wide side effect.
    const promotedEntities = new Set();
    const mainByEntity = new Map(); // entity -> { id, f } chosen for promotion
    const mainIdsByEntity = new Map(); // entity -> spec-declared Main form ids for sibling demotion
    defs.forEach((d, i) => {
      if ((d.f.formType || 'Main') !== 'Main') return;
      const key = d.f.entity.toLowerCase();
      if (!mainIdsByEntity.has(key)) mainIdsByEntity.set(key, []);
      if (ids[i]) mainIdsByEntity.get(key).push(ids[i]);
      const current = mainByEntity.get(key);
      // An explicit isDefault always wins; otherwise the first Main form in spec order holds the slot.
      if (!current || (d.f.isDefault === true && current.f.isDefault !== true)) {
        mainByEntity.set(key, { id: ids[i], f: d.f });
      }
    });
    for (const [entityLogical, chosen] of mainByEntity) {
      const entSpec = entityByLogical(spec, entityLogical);
      const prefix = spec.solution && spec.solution.publisherPrefix;
      const isOwnCustomTable = !!(entSpec && entSpec.existing !== true && prefix &&
        String(entSpec.schemaName).toLowerCase().startsWith(String(prefix).toLowerCase() + '_'));
      if (!isOwnCustomTable) continue;
      // Serialized deliberately: two promotions racing is the bug being fixed. `promoted` gates the
      // bookkeeping below — a build that could not set the flag must not report a default form it
      // did not set, which is what `result.created.defaultForms` claims.
      const promoted = await promoteDefaultForm(chosen.id, entityLogical, chosen.f.deactivateOtherMainForms === true, mainIdsByEntity.get(entityLogical) || []);
      if (promoted) promotedEntities.add(entityLogical);
    }
    if (promotedEntities.size) result.created.defaultForms = Object.fromEntries(
      [...mainByEntity].filter(([k]) => promotedEntities.has(k)).map(([k, v]) => [k, v.id])
    );

    // overwrites the first. That is correct for what the map is for — the app shell wires one form
    // per entity — but it is invisible to a consumer reading the emitted JSON, who reasonably
    // concludes the other ids were lost. `created.formIds` below is keyed by the (entity, formType,
    // name) triple and normally holds them all.
    //
    // The warning deliberately does NOT promise that `formIds` is complete: `formIdentityKey` omits
    // `formId`, which the App Spec supports precisely so two forms can share an entity, type and
    // name. Two such pinned forms collide in `formIds` as well, and claiming otherwise would send
    // the reader to a map that cannot answer them either.
    const mainFormSeen = new Map(); // entity -> { shownName, identityKey } for the first Main form, in spec order
    defs.forEach((d, i) => {
      if ((d.f.formType || 'Main') !== 'Main') return;
      const key = d.f.entity.toLowerCase();
      // `name` is optional on a form and is compiled to "<entity> form"; using the raw spec value
      // here would print "undefined" for exactly the forms the author did not name.
      const shownName = d.f.name || (d.def && d.def.name) || `${key} form`;
      if (!mainFormSeen.has(key)) {
        mainFormSeen.set(key, { shownName, identityKey: formIdentityKey(d.f) });
      } else if (typeof opts.warn === 'function') {
        const first = mainFormSeen.get(key);
        // Compared on the stored IDENTITY KEY of the earlier form, not on a key rebuilt from its
        // DISPLAY name. Those differ for an UNNAMED form: `formIdentityKey` uses `f.name || ''`
        // while `shownName` falls back to "<entity> form", so rebuilding from the display name made
        // two unnamed Main forms look distinct when they actually collide in `created.formIds` —
        // and the warning then pointed the reader at a map that could not separate them either.
        const distinct = formIdentityKey(d.f) !== first.identityKey;
        opts.warn(`entity ${key} has more than one Main form ("${first.shownName}" and "${shownName}"); `
          + `created.forms keeps ONE id per entity for the app shell, so it now reports "${shownName}". `
          + (distinct
            ? 'The other ids are in created.formIds, keyed "entity|formType|name" — read that map rather than re-querying systemform.'
            : 'These two share an entity, type and name, so created.formIds cannot separate them either — give them distinct names.'));
      }
      result.created.forms[key] = ids[i];
    });
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
    // form id — so key QuickView forms only.
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
          // global name, so two entities with same-named QuickView forms don't cross-wire.
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
    //
    // The code is looked for along the whole CAUSE CHAIN, not just on the error handed to us,
    // because the SDK signals this condition two different ways and both mean the same thing:
    //   * it THROWS the SdkError (older bundles), which arrives here directly; or
    //   * `pushArtifact` RESOLVES with `{ saved: false, error }` — the preview rollout is a reported
    //     no-op rather than a failure — and `requireSuccessfulPush` wraps that into a BuildHalt
    //     whose `cause` is the SdkError.
    // Reading only `err.code` matched the first and missed the second, so once the SDK moved this to
    // a return, every build on an environment without the member HALTED instead of skipping — and
    // AGENTS.md records that such environments are the common case, not the edge case.
    const businessRuleApiUnavailable = (err) => {
      const codes = errorCodeChain(err);
      // `BUSINESS_RULE_LEFT_DEACTIVATED` must NEVER collapse into this skip. It means a write failed
      // AND the SDK could not put the rule back into the Activated state it found it in, so a live
      // rule is sitting Draft on the server — reporting that as "this environment cannot host rules"
      // tells the operator the opposite of what they need to act on. The SDK raises it as a distinct
      // code for exactly this reason; honour the distinction here.
      if (codes.includes('BUSINESS_RULE_LEFT_DEACTIVATED')) return false;
      return codes.includes('BUSINESS_RULE_API_UNAVAILABLE') ? 'unsupported in this environment' : false;
    };
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
        // Reconcile solution membership on the REUSE path too, for the same reason the BPF phase
        // does. `addSolutionComponent` is otherwise only reached by the create branch, so a run
        // where the rule was written but the component add failed — or a rule created by an earlier
        // build of a DIFFERENT solution — is reused forever and never joins this one, leaving it out
        // of export/import with nothing in the output saying so. The SDK treats an already-present
        // component as success, so re-issuing it every build is safe.
        //
        // A failure here warns rather than halts: the rule itself is correct and running, and
        // blocking an otherwise-good build over solution bookkeeping would be the worse outcome.
        try {
          await provision.addSolutionComponent({ componentId: existingId, componentType: COMPONENT_TYPE.workflow, solutionUniqueName: sol.uniqueName });
        } catch (e) {
          if (typeof opts.warn === 'function') {
            opts.warn(`business rule "${rule.name}" on ${rule.entity} exists but could not be added to solution '${sol.uniqueName}' (${e && e.message}). The rule works, but it will not travel on solution export until it is added.`);
          }
        }
        continue;
      }
      await runner.run('business-rules', `business rule "${rule.name}" on ${rule.entity}`, async () => {
        const def = businessRuleDef(rule);
        const art = await provision.createArtifact('businessRule', def);
        // The condition tree is a nested object, so it goes on through the generic element surface
        // rather than the create payload — mirroring how the SDK's own workflow test authors one.
        await provision.updateElement('businessRule', art.id, '/rootCondition', def.rootCondition);
        // The push USED to be unable to tell you a rule was wrong: a mis-shaped condition tree was
        // MERGED onto the node, ignored by the serializer, and written as a rule with no clauses and
        // no actions — HTTP 204, activated, and it never fired.
        //
        // That trap is CLOSED at the source as of the injected-storage re-vendor. The SDK now runs
        // the business-rule designer's own completeness validator internally on EVERY save — create
        // and update, Active and Draft — so an incomplete or mis-shaped rule is REFUSED by
        // `pushArtifact` below, naming the offending clause, and nothing reaches the wire.
        // Measured and pinned in sdk-uptake-contract.test.js ("a wrongly-shaped condition is now
        // REFUSED at push, closing the empty-rule trap"), which asserts both the refusal and that no
        // request was made.
        //
        // ⚠ The explicit validation call that used to sit HERE is therefore gone, and its removal is
        // a TIGHTENING rather than a loss of coverage. It invoked the SDK's old business-rule
        // validator method, which no longer exists. The old call was best-effort by design (a bundle
        // without the method must not block a build it cannot judge), so it silently degraded to NO
        // validation whenever the vendored bundle predated it. Re-adding a defensive
        // `typeof ... === 'function'` block would now be dead code that never runs and implies
        // coverage living elsewhere.
        //
        // NOTE: the method name is deliberately NOT written in call form anywhere in this file.
        // `sdk-surface-contract.test.js` scans engine source for `sdk.<method>(` and would read a
        // mention in prose as a live call, then demand it back on the vendored bundle.
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

  // 6b-post. Business process flows. Additive discover-reconcile, exactly like business rules and for
  // the same reasons: a flow is identified by (entity, name), and pushing unconditionally on every
  // rebuild would stack duplicate processes on the table. Unlike a rule, a BPF goes through the SDK's
  // GENERIC artifact surface (createArtifact -> pushArtifact) — there is no bound member and no
  // fallback path, so there is no double-write hazard to sweep up after.
  if (has('business-process-flows')) {
    for (const flow of spec.businessProcessFlows || []) {
      const entityLogical = String(flow.entity).toLowerCase();
      const key = `${entityLogical}|${flow.name}`;
      const existing = await provision.queryRecords('workflow', {
        // `uniquename` is selected, not derived. Activation creates the flow's backing TABLE with
        // exactly this name, and the security phase grants privileges on that table. For a flow this
        // build created, `bpfUniqueName(flow.name)` IS the deployed value — but a REUSED flow may
        // have been authored in Maker or by another tool under any unique name at all, and a
        // later display-name rename does not follow it. Deriving instead of reading would then grant
        // on a table that either does not exist or, worse, belongs to something else entirely.
        // See https://learn.microsoft.com/en-us/power-automate/developer/business-process-flows-code
        select: ['workflowid', 'statecode', 'createdon', 'uniquename'],
        // Definition rows only, and BusinessFlow only — see bpfFilter.
        filter: bpfFilter(flow.name, entityLogical),
        // Ordered and > 1 for the same reason as business rules: `top: 1` unordered adopts an
        // ARBITRARY row, and seeing more than one is the only way to report a pre-existing duplicate.
        orderBy: 'createdon asc',
        top: 50,
      });
      const existingId = existing && existing[0] && existing[0].workflowid;
      if (existingId) {
        if ((existing || []).length > 1 && typeof opts.warn === 'function') {
          opts.warn(`business process flow "${flow.name}" on ${flow.entity}: ${existing.length} definitions exist with this name — the oldest is being reused. Remove the extras in Maker so users are not offered the same process twice.`);
        }
        // Exists, but a flow left in Draft is invisible on the form — "exists, so skip" would report
        // success over a process nobody can run. Converge the one property that is cheap and safe to
        // reconcile, in BOTH directions, exactly as the business-rule phase does.
        const wantActive = (flow.status || 'Active') === 'Active';
        const isActive = existing[0].statecode === 1;
        if (wantActive !== isActive) {
          // statecode 1 / statuscode 2 = Activated; 0 / 1 = Draft. Best-effort, NOT a build halt: a
          // process the platform refuses to toggle should not block an otherwise-good app, and
          // `--verify` reports the real deployed state.
          const target = wantActive ? { statecode: 1, statuscode: 2 } : { statecode: 0, statuscode: 1 };
          const verb = wantActive ? 'activated' : 'deactivated';
          try {
            await provision.updateRecord('workflow', existingId, target);
            runner.skip('business-process-flows', `business process flow "${flow.name}" on ${flow.entity} (existed in the wrong state — ${verb})`);
          } catch (e) {
            if (typeof opts.warn === 'function') {
              opts.warn(`business process flow "${flow.name}" on ${flow.entity} exists but could not be ${verb} (${e && e.message}). It is ${isActive ? 'still running' : 'inert'}. Delete it and rebuild to recreate it cleanly.`);
            }
            runner.skip('business-process-flows', `business process flow "${flow.name}" on ${flow.entity} (exists but could not be ${verb})`);
          }
        } else {
          runner.skip('business-process-flows', `business process flow "${flow.name}" on ${flow.entity} (exists — reuse; stage edits aren't applied on rebuild, recreate to change)`);
        }
        result.created.businessProcessFlows[key] = existingId;
        // The DEPLOYED backing-table name, read back rather than derived (see the select above). A
        // row with no `uniquename` (an older projection, or a double that does not model the field)
        // falls back to the derivation, which is still the right answer for anything this tool made.
        result.created.bpfBackingTables[key] = String(existing[0].uniquename || bpfUniqueName(flow.name)).toLowerCase();
        // Reconcile solution membership on the REUSE path too. `addSolutionComponent` is otherwise
        // only reached by the create branch, so a run where the flow was created but the component
        // add failed (or a flow created by an earlier build of a different solution) would be reused
        // forever and never join this solution — leaving it out of export/import with nothing in the
        // output saying so. The SDK treats an already-present component as success, so this is safe
        // to re-issue every build; a failure here is a warning, not a halt, because the flow itself
        // is correct and blocking the build over solution bookkeeping would be worse than reporting it.
        try {
          await provision.addSolutionComponent({ componentId: existingId, componentType: COMPONENT_TYPE.workflow, solutionUniqueName: sol.uniqueName });
        } catch (e) {
          if (typeof opts.warn === 'function') {
            opts.warn(`business process flow "${flow.name}" on ${flow.entity} exists but could not be added to solution '${sol.uniqueName}' (${e && e.message}). The flow works, but it will not travel on solution export until it is added.`);
          }
        }
        continue;
      }
      const stageCount = (flow.stages || []).length;
      await runner.run('business-process-flows', `business process flow "${flow.name}" on ${flow.entity} (${stageCount} stage${stageCount === 1 ? '' : 's'})`, async () => {
        // The reuse query above keys on (name, entity). The SERVER key does not: it is the DERIVED
        // unique name, which strips case and punctuation and ignores the table entirely. So two
        // situations are invisible to that query and fail inside the create instead:
        //   * a RENAME that preserves the derived name — "Ticket Handling" -> "ticket-handling";
        //   * a flow with the same derived name on a DIFFERENT table, including one this spec did
        //     not author.
        // Both then fail with a platform error about a backing TABLE the author never mentioned,
        // because activation creates an org-owned table with that logical name. Naming the real
        // conflict here is the difference between a two-minute rename and an afternoon.
        //
        // The in-spec cases (two flows colliding, or a flow colliding with a declared table) are
        // rejected at the plan gate; this covers only what the spec cannot see.
        //
        // Best-effort: a DIAGNOSTIC must never be the thing that breaks a build, so a query that
        // fails or is unsupported proceeds and lets the platform speak for itself.
        const unique = bpfUniqueName(flow.name);
        let clash = null;
        try {
          const rows = await provision.queryRecords('workflow', {
            select: ['workflowid', 'name', 'primaryentity'],
            filter: `uniquename eq '${odataLit(unique)}'`,
            top: 5,
          });
          const row = (rows || [])[0];
          if (row) clash = `the flow "${row.name}"${row.primaryentity ? ` on ${row.primaryentity}` : ''}`;
        } catch { /* diagnostic only — fall through to the create */ }
        // A flow is only ONE of the things that can own that name. Activation creates a real TABLE
        // called `unique`, so an unrelated table already holding that logical name blocks the flow
        // just as surely — and that table need not have come from any flow at all. Checking only
        // `workflows` left the commonest environment-side collision undetected.
        //
        // `findTables` is the SDK's only table-existence surface and takes no server-side filter, so
        // the match is made here. It runs ONLY on the create path (never on reuse), and the SDK
        // caches the metadata read, so this does not add a per-build enumeration.
        if (!clash && typeof provision.findTables === 'function') {
          try {
            const tables = await provision.findTables();
            const owner = (tables || []).find((t) => t && String(t.logicalName || '').toLowerCase() === unique);
            if (owner) clash = `the table '${owner.logicalName}'`;
          } catch { /* diagnostic only */ }
        }
        if (clash) {
          throw new BuildHalt(
            `business process flow "${flow.name}" on ${flow.entity} cannot be created: the Dataverse unique name it derives ('${unique}') is already used by ${clash}. The derivation lower-cases the name, strips punctuation and always uses the 'new_' prefix, so two differently-spelled names can collide — and activation creates a backing TABLE with that name, so only one owner can exist. Rename this flow, or remove the existing one.`,
            { phase: 'business-process-flows', code: 'bpf-unique-name-conflict', recoverable: false });
        }
        // The whole flow — including its stages and steps — is carried on the CREATE payload. The
        // adapter normalizes and id-stamps the stage/step tree there, so unlike a business rule's
        // condition tree there is no element-surface follow-up to make.
        const art = await provision.createArtifact('bpf', bpfDef(flow));
        const pushed = requireSuccessfulPush(await provision.pushArtifact('bpf', art.id), `business process flow ${flow.name}`, opts.warn);
        result.created.businessProcessFlows[key] = pushed.id;
        // On the CREATE path the derivation is authoritative: the build supplied `flow.name`, the
        // adapter derived `uniquename` from it, and `unique` above is that same derivation — already
        // proven collision-free by the clash checks. Recorded explicitly so the security phase reads
        // ONE map regardless of which branch produced the flow.
        result.created.bpfBackingTables[key] = unique;
        // componentType 29 (workflow) — a BPF is a workflow row, so it ships in the solution the same
        // way a business rule does. Without this the process is left out of the solution and does not
        // travel on export/import.
        await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.workflow, solutionUniqueName: sol.uniqueName });
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
        const art = await provision.createArtifact('command', def);
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
      const existing = await findDashboardsByName(provision, dash.name);
      let existingId = existing[0] && existing[0].id;
      // A name lookup can return several dashboards — names are not unique, and the lookup ignores
      // case, most accents and trailing spaces — and reusing the first one returned bound this app to
      // an arbitrary one, possibly another app's. The app's own is the one its solution holds; when
      // that does not single one out, halt with the names to fix rather than guess.
      if (existing.length > 1) {
        let ours = null;
        let unreadable = '';
        try {
          const members = await dashboardsInSolution(provision, sol.uniqueName, existing.map((e) => e.id));
          ours = members ? existing.filter((e) => members.has(String(e.id).replace(/[{}]/g, '').toLowerCase())) : null;
        } catch (err) {
          unreadable = ` (${(err && err.message) || err})`;
        }
        if (ours && ours.length === 1) {
          existingId = ours[0].id;
        } else {
          const reason = ours === null
            ? `and this app's solution cannot say which is its own${unreadable}`
            : `and ${ours.length ? `${ours.length} of them are` : 'none of them is'} in this app's solution '${sol.uniqueName}'`;
          await runner.run('dashboards', `dashboard "${dash.name}"`, async () => {
            throw new Error(`${existing.length} dashboards in this environment match the name '${dash.name}' (Dataverse compares names ignoring case, most accents and trailing spaces) ${reason}, so the build cannot tell which one to reuse. Rename or delete the extra ones in Maker, or give this dashboard a different name.`);
          });
        }
      } else if (existing.length === 1 && typeof opts.warn === 'function') {
        // A LONE match is reused without that proof. A downloaded app's dashboard may never have joined
        // the solution the download recovered — the one holding the APP; a dashboard made in Maker outside
        // it stays in Default — and refusing or duplicating it would break that rebuild. It is not ADDED to
        // the solution either (only a dashboard the build creates is), so teardown, which deletes solution
        // members only, keeps it. But a lone match outside the solution may be another app's namesake, and
        // this app is then bound to it with nothing to tell — so the build says so. A read that fails
        // proves nothing either way and is no reason to fail the step: the reuse is today's behaviour.
        let members = null;
        try {
          members = await dashboardsInSolution(provision, sol.uniqueName, [existing[0].id]);
        } catch {
          members = null;
        }
        if (members && !members.has(String(existing[0].id).replace(/[{}]/g, '').toLowerCase())) {
          opts.warn(`dashboard "${dash.name}": the one dashboard with this name is not in this app's solution '${sol.uniqueName}', so nothing proves it is this app's. It is reused; teardown will keep it, and a solution export will leave it out. If it is this app's, add it to the solution in Maker; if it is another app's, give this dashboard a different name.`);
        }
      }
      if (existingId) {
        runner.skip('dashboards', `dashboard "${dash.name}" (exists — reuse; tile edits aren't applied on rebuild, recreate to change)`);
        result.created.dashboards[dash.name] = existingId;
        continue;
      }
      await runner.run('dashboards', `dashboard "${dash.name}" (${(dash.tiles || []).length} tile(s))`, async () => {
        const art = await provision.createArtifact('dashboard', { name: dash.name, ...(dash.description ? { description: dash.description } : {}) });
        // for..of, not forEach: addElement is async, and a forEach callback would fire the adds
        // without awaiting them — the push below could then race an unfinished tile insert.
        const tiles = dash.tiles || [];
        for (let ti = 0; ti < tiles.length; ti++) {
          await provision.addElement('dashboard', art.id, '/components', dashboardComponent(dashboardTileOpts(spec, tiles[ti], result), ti));
        }
        const pushed = requireSuccessfulPush(await provision.pushArtifact('dashboard', art.id), `dashboard ${dash.name}`, opts.warn);
        try {
          await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.dashboard, solutionUniqueName: sol.uniqueName });
        } catch (err) {
          // The app's solution is the only proof, to a later rebuild or teardown, that this dashboard is
          // the app's (names are not unique — see dashboardsInSolution). Left outside it, a rebuild would
          // reuse it as a lone name match without ever adding it, and teardown would keep it as "not
          // created by this build" while its tiles blocked the chart and view deletes. So undo the push
          // — a re-run then simply creates it again — and when that fails too, say what is left behind.
          const why = (err && err.message) || String(err);
          let undoErr = null;
          try {
            await provision.deleteRemoteArtifact('dashboard', pushed.id);
          } catch (e) {
            undoErr = e;
          }
          // deleteRemoteArtifact removes the row and THEN the local workspace copy, so a failure can come
          // from either half. Only a row that is still there is left outside the solution; when that
          // cannot be read either, assume it is.
          let stranded = false;
          if (undoErr) {
            stranded = true;
            try {
              const still = await provision.queryRecords('systemform', { select: ['formid'], filter: `formid eq ${String(pushed.id).replace(/[{}]/g, '')}`, top: 1 });
              stranded = !!(still && still.length);
            } catch { /* cannot tell — keep assuming it is still there */ }
          }
          if (stranded) {
            const left = new Error(`dashboard "${dash.name}" was created (${pushed.id}) but could not be added to solution '${sol.uniqueName}' (${why}), and removing it again failed (${(undoErr && undoErr.message) || undoErr}) — add it to the solution or delete it in Maker before re-running, or teardown will not recognise it as this app's`);
            // Never auto-retried (isTransientHalt, build-model-app.js): a retry would reuse it as a lone
            // name match without adding it, whatever transient text the causes quoted above carry.
            left.transient = false;
            left.cause = err;
            throw left;
          }
          const removed = new Error(`dashboard "${dash.name}" could not be added to solution '${sol.uniqueName}' (${why}), so it was removed again — re-run to create it afresh`);
          // Nothing is left behind, so a retry is safe: keep the cause's HTTP status, so a 429/503 is
          // still auto-retried as it was before the undo existed.
          const status = err && (err.statusCode || err.status);
          if (status) removed.statusCode = status;
          removed.cause = err;
          throw removed;
        }
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
        // Refused here, before anything is applied, whenever this run pushes the app: the finalizer (every
        // pages-phase run that rewrites the sitemap), or the app-shell pushes below (refuseUnpushedAppCopy).
        const routingSet = typeof (spec.app && spec.app.aiDescription) === 'string' && !!spec.app.aiDescription.trim();
        const pushesApp = has('pages')
          ? !(opts.changedOnly && opts.changedOnly.skipSitemapFinalize)
          : (!appHasPageSubareas(spec) || routingSet);
        if (pushesApp) await refuseUnpushedAppCopy(provision, existingId, def.name);
        // #583: the routing description rides an app push this run ALREADY makes — never a second push from
        // the same fetch (the push is If-Match). With the pages phase in the run — every CLI apply, since
        // --apply refuses a partial range that includes app-shell — the finalizer is the sole existing-app
        // sitemap writer, and applies it there, after its own re-fetch and after the removal gate. Pushing
        // the fetched app HERE would re-send the LIVE sitemap, which the SDK validates reference by
        // reference, so a subarea whose page or table was deleted in Maker would halt the run before the
        // pages phase could drop it. Without the pages phase it is applied below, right before the push
        // that carries it — after the live-page gate, so a gate that halts leaves no unrecorded edit in
        // the workspace copy for the re-run's plain fetch to refuse.
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
          const aiDescriptionChanged = await applyAppAiDescription(provision, spec, existingId);
          requireSuccessfulPush(await pushAppHeader(provision, existingId, def.name, aiDescriptionChanged), `app ${def.name}`, opts.warn);
          reportPartialPush(await provision.publishArtifact('app', existingId), `app ${def.name}`, opts.warn);
        } else if (!has('pages') && typeof (spec.app && spec.app.aiDescription) === 'string' && spec.app.aiDescription.trim()) {
          // Reached only WITHOUT the pages phase (a programmatic partial run — the CLI refuses one on
          // --apply): a page-backed app's sitemap is not written on this run, so the routing description
          // needs its own push. That push re-sends the workspace copy's sitemap, which the SDK validates —
          // and which is the live one only because a copy holding an earlier run's unpushed edits was
          // refused above (refuseUnpushedAppCopy): replaying a stale sitemap rewrite detached live pages
          // with no gate and no --allow-destructive, and the copy's routing description may be this very
          // edit, left unpushed, so "unchanged" against it would skip the push the server still needs.
          if (await applyAppAiDescription(provision, spec, existingId)) {
            requireSuccessfulPush(await pushAppHeader(provision, existingId, def.name, true), `app ${def.name} routing description`, opts.warn);
            reportPartialPush(await provision.publishArtifact('app', existingId), `app ${def.name}`, opts.warn);
          }
        }
        await ensureSitemapInSolution(provision, sol, def.uniqueName);
        return existingId;
      }
      // Create: the full def (siteMap + explicit components + iconWebResourceId) serializes unchanged
      // through createArtifact, and push emits appmodule -> sitemap -> AddAppComponents -> publish.
      const art = await provision.createArtifact('app', def);
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

      // A page that SUPPLIES an empty prompt or agent message would otherwise have generated text
      // deployed in its place. Checked here, before ANY upload, so a bad spec fails whole rather than
      // leaving half the pages deployed. Absent keys are untouched — only a present-but-blank value is
      // an authoring mistake. Same rule as the standalone CLI, via the same predicate.
      for (const p of implemented) {
        for (const [field, value] of [['prompt', p.prompt], ['agentMessage', p.agentMessage]]) {
          if (suppliedButBlank(value)) {
            throw new BuildHalt(`page "${p.name || keyOf(p)}": ${field} is present but blank — refusing to deploy generated text in its place. Give it real content or remove the key.`, { phase: 'pages', code: 'pages-blank-provenance', recoverable: false });
          }
        }
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
          // #583: the routing description rides THIS push whenever the pages phase runs (the app-shell
          // branch defers it here). A fresh app already carries it from its create, so this is a no-op there.
          const headerChanged = await applyAppAiDescription(provision, spec, result.created.app);
          const appName = (spec.app && spec.app.name) || result.created.app;
          requireSuccessfulPush(await pushAppHeader(provision, result.created.app, appName, headerChanged), 'app sitemap finalize', opts.warn);
          reportPartialPush(await provision.publishArtifact('app', result.created.app), `app ${appName}`, opts.warn);
          return result.created.app;
        });
      } else {
        // planFor budgets this step for every pages-phase run, so consume the slot even when there is
        // nothing to write — otherwise the remaining steps renumber past the advertised total.
        runner.skip('pages', `finalize sitemap (genpage subareas) (${skipSitemapFinalize ? 'content-only re-upload — sitemap unchanged' : 'no sitemap change'})`);
      }
    } finally {
      // Always clean up run-scoped staging (never leave env GUIDs on disk) and release the advisory lease.
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      lease.release();
    }
  } else if (has('pages')) {
    // The pages phase was selected but the block above did not open: a FRESH app with a page-less
    // spec has nothing to build and no pre-existing pages to remove, and its sitemap was already
    // written by the app-shell create path. planFor still budgeted the finalize step (it cannot see
    // that the app is fresh), so consume the slot here rather than leaving the run one short of its
    // advertised total.
    runner.skip('pages', 'finalize sitemap (genpage subareas) (fresh page-less app — sitemap written on create)');
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

  // 7c. AI features (opt-in via spec.ai). Enable app-level agents + configure per-table row
  //     summaries. `setAppAiFeatures` never throws — every outcome arrives as data in a bucket.
  // Features the SDK did not put in `applied`, deferred for a post-publish re-issue (see inside the
  // ai-features phase for why the verdict cannot honestly be decided at write time).
  const pendingAiReconfirm = [];

  if (has('ai-features') && specOptsIntoAi(spec)) {
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
      //   skipped      — as notPersisted, PLUS the feature's org readiness gate reads off, which is
      //                  offered as the explanation. Since AB#6688904 the SDK ATTEMPTS every write
      //                  and reads the gate only afterwards, to explain a failure that happened —
      //                  it no longer pre-empts the write, so this bucket is now evidence, not a
      //                  prediction.
      //   unverified   — the write was issued but the proof could not be READ (no access to
      //                  appsettings/settingdefinitions/appmodules, or a transport error).
      //   failed       — the write threw. The SDK keeps going so the rest of the batch still
      //                  reports, so this arrives as data, never as an exception.
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
      // `skipped` is deferred WITH the rest, and that is the plugin half of AB#6688904. On a freshly
      // created app NO app-scope write persists until the app is published, so the SDK's post-write
      // gate read fires for every feature — and for the ones that happen to have a distinct org gate
      // (`nlSearch`, `nlChart`, `formFillSmartPaste`) an org-wide `false` then labels them `skipped`.
      // Treating that as a final answer would abandon them before the one sequence measured to work,
      // and `--verify` would then fail on an override row the build gave up on writing. The reported
      // environment ran a working app at `NLGridSearchSetting = 2` with `EnableNLGridSearch` off, so
      // a gate reading off is not proof the app-scope write cannot land — only the retry can settle
      // it. Anything still `skipped` after the retry is reported as an admin action, not a defect.
      //
      // Derive the non-success buckets from the RESULT, not a fixed list: a bucket added by a future
      // SDK revision is then reported verbatim rather than silently dropped (which is the very bug
      // class this phase exists to remove). `outcomes` is per-feature detail, not a bucket.
      const problemKeys = Object.keys(r || {}).filter((k) => k !== 'applied' && k !== 'outcomes' && Array.isArray(r[k]) && r[k].length);
      for (const key of problemKeys) {
        for (const feature of r[key]) {
          const outcome = (r.outcomes || []).find((o) => o && o.feature === feature);
          pendingAiReconfirm.push({ feature, bucket: key, reason: outcome && outcome.reason });
        }
      }
      const parts = [];
      if (r.applied && r.applied.length) parts.push(`applied: ${r.applied.join(', ')}`);
      if (pendingAiReconfirm.length) parts.push(`retrying after publish: ${pendingAiReconfirm.map((p) => p.feature).join(', ')}`);
      return parts.length ? parts.join('; ') : '(none)';
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

    // 7a-bis. Role grants (`roleGrants[]`) — ADD privileges for a table to a PRE-EXISTING role. AB#6686429.
    //
    // The scenario this exists for: a table is added to an app whose solution already ships four data
    // roles. Before this, the table, its forms and its nav deployed while every non-admin persona still
    // had no access to it, and nothing said so.
    //
    // ADDITIVE, never converging. `addEntityPrivilegesToRole` compiles to `AddPrivilegesRole`, so a
    // privilege the role already holds is re-asserted and every privilege the spec does NOT mention is
    // left alone. That is what makes it safe to point at a role somebody else owns — and it is also why
    // this surface cannot REVOKE (documented in references/app-spec-schema-advanced.md).
    //
    // Idempotency comes from Dataverse, not from a read-compare here: re-POSTing a grant the role already
    // holds at the same depth succeeds and changes nothing. Re-POSTing at a HIGHER depth raises it. We do
    // not pre-read the role's privileges, because a read-then-write would be racy and the write is
    // already the converged operation.
    //
    // Runs AFTER the persona loop so that, if a future change ever allowed both to touch one role, the
    // additive grant lands last rather than being converged away. Today validation rejects that overlap
    // outright (see validateRoleGrants).
    const roleGrantBuCache = {}; // memoize the root-BU lookup across grants in this build
    // Resolved-id guards. The static validator can only compare NAMES, so a `roleId` pinned at a role
    // a persona also authors, or a name-and-id pair aliasing one role, both slip past it. Both are
    // caught here on the identity that actually matters — the resolved Dataverse role id:
    //   * persona overlap would let ReplacePrivilegesRole converge the grant away on the next build,
    //     and a failure BETWEEN the two passes leaves the access removed;
    //   * two grants on one role split a depth conflict across two SDK calls, where the SDK's
    //     "entities sharing one privilege must request one depth" check cannot see it and the later
    //     write silently wins.
    const personaRoleIds = new Map(); // lowercased roleId -> persona name, from the loop above
    for (const [name, rr] of Object.entries(result.created.roles || {})) {
      if (rr && rr.roleId) personaRoleIds.set(String(rr.roleId).toLowerCase(), name);
    }
    const grantedRoleIds = new Map(); // lowercased roleId -> the label of the grant that claimed it
    // TWO PASSES, deliberately. Resolving and guarding EVERY grant before applying ANY is what makes
    // the identity guards below worth having: with resolve-guard-apply interleaved per grant, a spec
    // whose second entry aliases the first applied grant #1 and only then halted, leaving one role
    // changed and one not, with nothing in the output saying which. Every guard here rejects a spec
    // that is wrong independently of the environment, so it costs nothing to learn that first.
    const resolvedGrants = [];
    for (const grant of spec.roleGrants || []) {
      const label = roleGrantLabel(grant);
      let target;
      try {
        target = await resolveRoleGrantTarget(provision, grant, roleGrantBuCache);
      } catch (err) {
        // Fail-closed: an unresolvable or ambiguous role means we do not know what we would be granting
        // on. Halting is better than skipping, because a skipped grant reads as a successful build whose
        // users still cannot open the table — the exact failure this feature was filed for.
        throw new BuildHalt(`roleGrant ${label} could not be resolved: ${err && err.message ? err.message : err}`, { phase: 'security', code: 'role-grant-unresolved', recoverable: false });
      }
      const idKey = String(target.roleId).toLowerCase();
      if (personaRoleIds.has(idKey)) {
        throw new BuildHalt(
          `roleGrant ${label} resolves to role ${target.roleId}, which is also persona "${personaRoleIds.get(idKey)}" in this spec. `
          + 'The build CONVERGES a persona\'s role (privileges not declared on the persona are removed), so this grant would be '
          + 'undone on the next build — declare these privileges on that persona\'s job instead.',
          { phase: 'security', code: 'role-grant-persona-overlap', recoverable: false },
        );
      }
      if (grantedRoleIds.has(idKey)) {
        throw new BuildHalt(
          `roleGrant ${label} resolves to role ${target.roleId}, which roleGrant ${grantedRoleIds.get(idKey)} already targets. `
          + 'Merge them into one entry: two entries can request conflicting depths for one shared Dataverse privilege, and the '
          + 'SDK only detects that within a single call, so the later write would silently win.',
          { phase: 'security', code: 'role-grant-duplicate-target', recoverable: false },
        );
      }
      grantedRoleIds.set(idKey, label);
      resolvedGrants.push({ grant, label, target });
    }
    for (const { grant, label, target } of resolvedGrants) {
      await runner.run('security', `grant privileges to existing role ${label}`, async () => {
        let applied;
        try {
          applied = await provision.addEntityPrivilegesToRole(target.roleId, grant.privileges);
        } catch (err) {
          // Apply-time metadata guards live here: a table that exposes no such access, and the SDK's
          // shared-privilege rule (two tables aliasing to one prv* must request one depth). Both are
          // author errors that only live metadata can detect, so they surface with the SDK's own message.
          throw new BuildHalt(`roleGrant ${label} could not be applied: ${err && err.message ? err.message : err}`, { phase: 'security', code: 'role-grant-failed', recoverable: false });
        }
        const n = Array.isArray(applied) ? applied.length : 0;
        // Keyed on the resolved ROLE ID, with the display name carried in the value. Keying on
        // `target.name` collapsed two DIFFERENT roles that share a display name — which the spec
        // gate deliberately allows, because a role is identified by (name, business unit) and the
        // same name in two BUs is two roles. The second grant then overwrote the first in this map,
        // so `--json` consumers saw one grant where two were applied. The id is the identity the
        // apply itself guards on, so it cannot collide.
        result.created.roleGrants[target.roleId] = { roleId: target.roleId, name: target.name, managed: target.managed, privileges: applied || [] };
        // The role is NOT added to the app's solution. A persona role is ours to place; a pre-existing role
        // already lives wherever its owner put it, and adding a foreign (possibly managed) role to this
        // solution would take an ownership decision the author did not ask for. If the role is already a
        // component of this solution, its updated privileges export with it either way.
        return `${n} privilege${n === 1 ? '' : 's'} granted on ${target.name || target.roleId}${target.managed ? ' (managed role)' : ''}`;
      });
    }

    // 7b-bis. Business process flow role grants (`businessProcessFlows[].securityRoles`). #513.
    //
    // Runs in SECURITY, not in the flow phase, for the same reason `forms[].securityRoles` does: a
    // persona's role does not exist until the loop above has run.
    //
    // The target is the flow's BACKING TABLE, not the flow row. Activating a flow makes the platform
    // create an org-owned table, and holding privileges on THAT is what lets a persona run the
    // process. Two things were measured live before this was written (see validateBpfSecurityRoles):
    // the table is organization-owned and every privilege is Global-only, so there is no scope to
    // author; and the public `addEntityPrivilegesToRole` grants on it (the SDK's internal BPF role
    // helper is not on its public surface).
    //
    // The table NAME is taken from `created.bpfBackingTables`, which the flow phase read back from
    // the deployed `workflow.uniquename`. It is only DERIVED from the display name as a last resort:
    // a flow authored elsewhere, or renamed after creation, keeps its original unique name, and
    // granting on the derivation would target a table that does not exist — or one that belongs to
    // something else. The fallback still covers the doubles and older projections that do not carry
    // the field, where the derivation is the correct answer anyway.
    const flowsWithRoles = (spec.businessProcessFlows || []).filter((f) => f && f.securityRoles);
    for (const f of flowsWithRoles) {
      const flowKey = `${String(f.entity).toLowerCase()}|${f.name}`;
      const backingTable = result.created.bpfBackingTables[flowKey] || bpfUniqueName(f.name);
      const label = `flow "${f.name}" (backing table ${backingTable})`;
      // The flow must have been built in THIS invocation, or its backing table may not exist —
      // ACTIVATION is what creates it. Checked BEFORE runner.run and reported through runner.skip,
      // because a value returned from runner.run is not emitted: a silent skip would report a clean
      // build in which nobody can run the process, which is the failure #513 exists to fix.
      // The key mirrors the flow phase's own `${entityLogical}|${flow.name}`.
      const built = result.created.businessProcessFlows[flowKey];
      if (!built) {
        runner.skip('security', `flow roles for ${f.name} (the business-process-flows phase did not run in this invocation, so the backing table may not exist yet)`);
        continue;
      }
      await runner.run('security', `flow roles for ${f.name}`, async () => {
        const personas = (f.securityRoles.personas || []);
        // Case-INSENSITIVE, exactly like the form path immediately below — and for the same reason.
        // `validateBpfSecurityRoles` resolves the persona reference against a LOWERCASED set, so a
        // spec naming "dispatcher" for a persona declared as "Dispatcher" validates clean. A
        // case-sensitive lookup here would then halt at the near-last phase, with a message claiming
        // the persona "has no role in this build" — which is false; it was declared and its role was
        // created. Late halt, wrong diagnosis, half-built app.
        const roleByLower = new Map(Object.entries(result.created.roles || {})
          .map(([name, rr]) => [String(name).trim().toLowerCase(), rr]));
        const roleIds = personas.map((p) => {
          const rr = roleByLower.get(String(canonicalPersonaName({ persona: p }) || '').toLowerCase());
          if (!rr || !rr.roleId) throw new BuildHalt(`${label}: persona '${p}' has no role in this build`, { phase: 'security', code: 'bpf-role-unresolved', recoverable: false });
          return { persona: p, roleId: rr.roleId };
        });
        for (const { persona, roleId } of roleIds) {
          try {
            // Organization scope is not a choice: the backing table is org-owned and its privileges
            // report CanBeGlobal only, so any other depth is rejected by the platform.
            await provision.addEntityPrivilegesToRole(roleId, [{ entity: backingTable, access: BPF_ROLE_ACCESS, scope: 'organization' }]);
          } catch (err) {
            throw new BuildHalt(`${label}: could not grant to persona '${persona}': ${err && err.message ? err.message : err}`, { phase: 'security', code: 'bpf-role-grant-failed', recoverable: false });
          }
        }
        result.created.bpfRoleGrants[f.name] = { backingTable, personas };
        return `${roleIds.length} persona(s) granted ${BPF_ROLE_ACCESS.join('/')} on ${backingTable}`;
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
      // the workspace, and keyed by entity because publishing is per-entity.
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
      // Distinct wording from NOT PERSISTED on purpose: both mean the override row is absent, but
      // `skipped` carries a diagnosis the operator can ACT on — an environment admin has to turn the
      // feature on before any app can. The SDK's own per-feature `reason` names the gate and its
      // value, and it is preferred over this text wherever it is present.
      skipped: ['ADMIN GATE OFF', 'the write was issued, no app-scope override appeared, and the feature\u2019s org readiness gate reads off \u2014 an environment admin must enable it first'],
      unverified: ['UNVERIFIED', 'the write was issued but could not be confirmed \u2014 verify manually before relying on it'],
      failed: ['FAILED', 'the write threw'],
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
      // `skipped` is cleaned up like every other non-success bucket. It used to be exempt, back when
      // the SDK pre-empted a gated write and `skipped` therefore meant "never attempted" — a state
      // no retry could change. Since AB#6688904 the write IS attempted, so a feature can genuinely
      // move from `skipped` to `applied`, and leaving it listed in both would make
      // `created.ai.appFeatures` contradict itself for any `--json` consumer.
      for (const key of Object.keys(af)) if (Array.isArray(af[key]) && key !== 'applied' && key !== 'outcomes') af[key] = af[key].filter((f) => !reproven.includes(f));
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

module.exports = { runSdkBuild, normalizeFormId, planFor, annotateLivePlan, resolvePhases, PHASES, BuildHalt, SDK_COLUMN_TYPE, viewDef, defaultViewColumns, subgridLabel, enrichesDefaultViews, dashboardsInSolution, findDashboardsByName, artifactIdentityQuery, resolveExistingFormId, FORM_TYPE_CODE, chartDef, dashboardTileOpts, dashboardComponent, compileFormIntent, formFieldLogicals, appDef, appUniqueName, applyAppAiDescription, haltOnUnpublishedAppHeader, pushAppHeader, commandsByEntity, commandDef, businessRuleDef, businessRuleFilter, bpfDef, bpfFilter, webResourceOpts, WEB_RESOURCE_KINDS, FORM_EVENTS, acquireAppPagesLease, personaRoleSpecFor, resolveRoleBusinessUnit, roleBuClause, roleGrantLabel, resolveRoleGrantTarget };

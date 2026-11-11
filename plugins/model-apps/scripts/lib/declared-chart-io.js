'use strict';
// The explicit managed download's restore of declared charts (charts[].reconcile "declared", createIdentity "stable-v1"): each chart a
// committed chart group of the build's binding store proves this app CREATED is written back into charts[] as a declaration that
// rebuilds it exactly, and every other is named. Nothing here writes, binds or publishes. It follows lib/declared-view-io.js; what
// differs is what a chart declaration can say and how that is proved.
//
// What a chart declaration can say (lib/chart-reconcile.js compileChartIntent): a chart type, ONE group-by column of the chart's own
// table, ONE count or countcolumn measure of the table's primary id, and a description and title. The typed chart the SDK reads
// (liveFull) shows the category and series but not the rest of the query, so the projection hash alone cannot prove a chart has
// nothing more: a filter, a join or an order sits in the datadescription the typed chart does not show. So the PUBLISHED row (the
// one whose layer hash equals the saved one's) is checked with verify's own content checks (lib/chart-verify.js chartContentChecks)
// against the declaration: every one must pass. A filter, a join, an order, a second series, a date grouping, a related category or
// an element the verifier does not model leaves the chart out (`unsupported`), never approximated.
//
// The shape it writes: the chart's current table and name, `reconcile: "declared"`, chartType, groupBy, the measure stated
// explicitly, and the description and title only when they hold non-blank text. No chart id and no key: a chart declaration has
// neither, so the rebuild finds the row through the binding store's key (`<table>/<trimmed name>`), which must be the key the group
// was bound under (a renamed chart is `key-mismatch`, never rekeyed). A restore is therefore an edit snapshot for THIS build folder:
// the store selects the exact row, and a same-named chart on the table is never bound in its place. Styling (palette, colours,
// axes, legends) is not the spec's: a rebuild that changes nothing keeps it byte for byte, which is not a claim that it is portable.
const { normalizeGuid, projectionBaseline, canonicalJson } = require('./reconcile-common.js');
const { readManagedFormFile } = require('./declared-form-io.js');
const { readSavedQueryLayerRows } = require('./savedquery-published.js');
const { omission } = require('./managed-restore-report.js');
const chartReconcile = require('./chart-reconcile.js');
const { chartContentChecks } = require('./chart-verify.js');
const { compareVersions, isPluginVersion, CREATE_IDENTITY_MIN_VERSION } = require('./app-spec.js');

const FAMILY = 'chart';
const SETTLED = new Set(['confirmed', 'not-needed']);
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404);
const nonBlank = (s) => typeof s === 'string' && s.trim() !== '';

/**
 * The declaration that rebuilds `chart` (a typed chart the SDK read, types/chart.ts), or { unsupported: why }. Pure: it reads only
 * `chart`. It covers the typed parts only; restoreManagedCharts proves the rest of the query with the verifier and the planner.
 */
function chartDeclarationFromLive(chart) {
  if (!chart || typeof chart !== 'object' || typeof chart.entityLogicalName !== 'string' || !nonBlank(chart.name)) return { unsupported: 'no table or name' };
  const live = chartReconcile.liveFull(chart);
  if (!live) return { unsupported: 'several series or categories, or a measure on a joined table' };
  const entity = lc(chart.entityLogicalName);
  if (!chartReconcile.CHART_TYPES.includes(live.chartType)) return { unsupported: 'a chart type a declaration cannot say' };
  if (live.category.relatedEntity || live.category.dateGrouping) return { unsupported: 'a category on a joined table or grouped by date' };
  if (!live.category.attribute) return { unsupported: 'a category with no column' };
  if (live.series.attribute !== `${entity}id`) return { unsupported: 'a measure on another column than the table\'s id' };
  if (!['count', 'countcolumn'].includes(live.series.aggregate)) return { unsupported: 'a measure that is not a count' };
  const declaration = { entity, name: chart.name, reconcile: 'declared', chartType: live.chartType, groupBy: live.category.attribute, measure: live.series.aggregate };
  if (nonBlank(live.description)) declaration.description = live.description;
  if (nonBlank(live.title)) declaration.title = live.title;
  return { declaration };
}

// createIdentity's plugin floor, keeping a higher one the spec already names (the rule of app-components.js setAppThemeFloor).
const floorOf = (current) => (isPluginVersion(current) && compareVersions(current, CREATE_IDENTITY_MIN_VERSION) > 0 ? current : CREATE_IDENTITY_MIN_VERSION);

/**
 * The explicit managed download's restore of declared charts (--include-managed --managed-manifest <file>). For each committed chart
 * group of the store file, in key order, the chart is restored into `spec.charts` (mutated) only when every check holds and the
 * downloaded spec still validates with it (`validate`, the download's own validator, which also holds the group-by to a Choice
 * column the spec declares on the chart's table); a restored chart also restores the spec's `createIdentity: "stable-v1"` (only a
 * stable build keeps chart groups) with its plugin floor. Every other group is answered as an omission with a fixed reason.
 * The checks, in order: the group is settled and valid; the build created the row; its publish is confirmed or not needed; the row
 * is read, by its id, on the table its publication names; its projection is the one the build proved; its saved layer equals its
 * published layer (and the layer the build published); the typed chart inverts (chartDeclarationFromLive); the declaration's key is
 * the bound key; verify's content checks pass on the published row; the declaration compiles back to the row part for part; and the
 * build's own planner, given the store's binding, answers noChange for the same row.
 * Answers { restored: [{ key, id }], omitted: [omission] }; a store file that cannot be used throws `managed-manifest-unusable`.
 */
async function restoreManagedCharts({ sdk, spec, file, environment, appUniqueName, solutionUniqueName, validate }) {
  const { groups, pending, invalid } = readManagedFormFile({ file, environment, appUniqueName, solutionUniqueName }, FAMILY);
  const restored = [];
  const omitted = [
    ...pending.map((p) => omission({ kind: 'chart', key: p.key, code: 'pending' })),
    ...invalid.map((p) => omission({ kind: 'chart', key: p.key, code: 'invalid' })),
  ];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const id = normalizeGuid(group.root && group.root.id);
    const left = (code, name) => omitted.push(omission({ kind: 'chart', id, key, name, code }));
    const record = id ? (group.records || []).find((r) => r && r.kind === FAMILY && normalizeGuid(r.id) === id) : null;
    if (!record) { left('invalid'); continue; }
    if (record.origin !== 'created') { left('not-created'); continue; }
    const publication = group.publication || {};
    if (!SETTLED.has(publication.state)) { left('publication-unsettled'); continue; }
    let art;
    try {
      await sdk.fetchArtifact('chart', id, { overwrite: true });
      art = await sdk.getArtifact('chart', id);
    } catch (e) {
      left(isNotFound(e) ? 'missing' : 'unread');
      continue;
    }
    if (!art || typeof art !== 'object') { left('missing'); continue; }
    const name = typeof art.name === 'string' ? art.name : undefined;
    const table = lc(publication.scope && publication.scope.table);
    if (normalizeGuid(art.id) !== id || !table || lc(art.entityLogicalName) !== table) { left('wrong-table', name); continue; }
    const live = chartReconcile.liveFull(art);
    if (!live) { left('unsupported', name); continue; }
    const observed = projectionBaseline(live).intentSha256;
    const baseline = group.consumerState && group.consumerState.baseline;
    if (observed !== record.intentSha256 || (baseline && baseline.intentSha256 !== observed)) { left('changed', name); continue; }
    let layers;
    try {
      layers = await readSavedQueryLayerRows(FAMILY, sdk.dataverse, group);
    } catch {
      left('unread', name);
      continue;
    }
    if (!layers.published || layers.savedSha256 !== layers.publishedSha256) { left('unpublished-changes', name); continue; }
    if (publication.state === 'confirmed' && publication.desiredSha256 && publication.desiredSha256 !== layers.savedSha256) { left('changed', name); continue; }
    const inverse = chartDeclarationFromLive(art);
    if (!inverse.declaration) { left('unsupported', name); continue; }
    const declaration = inverse.declaration;
    if (chartReconcile.declaredChartKey(declaration) !== key) { left('key-mismatch', name); continue; }
    // Verify's own checks on the published row (lib/chart-verify.js): anything the typed chart does not show — a filter, a join, an
    // order, an element the verifier does not model — fails or is unverified, and either leaves the chart out.
    const content = chartContentChecks(declaration, layers.published, key);
    if (content.unverified.length || !content.checks.length || content.checks.some((c) => !c.present)) { left('unsupported', name); continue; }
    const { errors, intent } = chartReconcile.compileChartIntent(declaration);
    const desired = intent && chartReconcile.desiredFull(intent, live);
    if (errors.length || !desired || chartReconcile.PARTS.some((p) => canonicalJson(desired[p]) !== canonicalJson(live[p]))) { left('not-equivalent', name); continue; }
    // The build's own planner, given exactly the binding the store holds: a rebuild must answer noChange, bind as it is, and send
    // nothing. GET only (chart-reconcile.js planChartReconcile).
    let plan;
    try {
      plan = await chartReconcile.planChartReconcile({ chart: declaration, sdk }, {
        managed: { lookup: async (kind, k) => (kind === FAMILY && k === key ? record : null) },
      });
    } catch {
      left('unread', name);
      continue;
    }
    if (plan.action !== 'noChange' || !plan.bindUnchanged || plan.refused.length || plan.unknown.length || normalizeGuid(plan.chartId) !== id) { left('would-change', name); continue; }
    const charts = Array.isArray(spec.charts) ? spec.charts : [];
    const at = charts.findIndex((c) => c && chartReconcile.declaredChartKey(c) === key);
    const next = at >= 0 ? charts.map((c, i) => (i === at ? declaration : c)) : [...charts, declaration];
    const candidate = { ...spec, charts: next, createIdentity: 'stable-v1', minimumPluginVersion: floorOf(spec.minimumPluginVersion) };
    const check = validate(candidate);
    if (!check || !check.ok) { left('invalid-in-spec', name); continue; }
    spec.charts = next;
    spec.createIdentity = candidate.createIdentity;
    spec.minimumPluginVersion = candidate.minimumPluginVersion;
    restored.push({ key, id });
  }
  return { restored, omitted };
}

module.exports = { restoreManagedCharts, chartDeclarationFromLive };

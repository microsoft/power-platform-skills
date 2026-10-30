'use strict';
// Declared reconciliation for an existing chart (`charts[].reconcile: "declared"`).
//
// Without the opt-in, the build creates a missing chart and leaves an existing one alone apart from
// its description (sdk-build's chart phase). With it, the chart the spec names converges to the
// spec's supported shape — chartType, the group-by column and the measure — and to the
// description/title the spec sets explicitly. Everything else on the live chart is kept.
//
// Why a push is safe here when the legacy description path avoids one: the SDK's ChartAdapter
// re-serializes `datadescription` by rewriting the matched measure/group-by elements IN PLACE and
// `presentationdescription` by overlaying the typed fields onto the stored XML, so a maker's
// palette, colours, custom properties and axis styling survive. Measured through the real bundle
// (chart-reconcile-real-bundle.test.js pins it):
//   <Chart Palette="None" PaletteCustomColors="91,151,213; 237,125,49"><Series><Series ChartType="Column"
//     ... CustomProperties="PointWidth=0.75, MaxPixelPointWidth=40">
// pushed with chartType Bar comes back byte-identical except ChartType="Bar".
//
// The supported shape is the one the build's chartDef compiles: ONE category (a Choice column on the
// chart's own table) and ONE series that aggregates the table's primary id. A live chart with more
// series or categories, or a measure on a joined table, was shaped outside that model; rewriting it
// would invent semantics, so it is refused, not reduced.

const {
  canonicalJson,
  intentSha256,
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  ownershipDriftVerdict,
  ownershipSubsets,
  bindsUnchanged,
  pushIfChanged,
  queuePublication,
  normalizeGuid,
  rulesOf,
} = require('./reconcile-common.js');

const CHART_TYPES = ['Column', 'Bar', 'Pie', 'Line'];
// The series aggregates the table's primary id (chartDef). On a GUID only counting is meaningful:
// sum/avg/min/max of a primary key are not a measure anyone asked for, so they are refused here
// rather than written.
const ID_MEASURES = ['count', 'countcolumn'];

const lc = (s) => String(s == null ? '' : s).toLowerCase();

function isDeclaredChart(ch) {
  return !!ch && ch.reconcile === 'declared';
}

/**
 * The owned projection of a spec chart. Returns { errors, intent }.
 * `description` and `title` are owned only when the spec sets them to non-blank text: chartDef
 * emits `|| ''`, and owning that would blank a maker's text.
 */
function compileChartIntent(ch) {
  const errors = [];
  const entity = lc(ch && ch.entity);
  const name = ch && typeof ch.name === 'string' ? ch.name.trim() : '';
  if (!entity) errors.push('entity is required');
  if (!name) errors.push('name is required');
  if (!CHART_TYPES.includes(ch && ch.chartType)) errors.push(`chartType must be one of ${CHART_TYPES.join('|')}`);
  const groupBy = lc(ch && ch.groupBy);
  if (!groupBy) errors.push('groupBy is required');
  const measure = ch && ch.measure !== undefined ? lc(ch.measure) : 'count';
  if (!ID_MEASURES.includes(measure)) errors.push(`measure must be one of ${ID_MEASURES.join('|')}`);
  if (errors.length) return { errors, intent: null };
  const intent = {
    key: `${entity}/${name}`,
    entity,
    name,
    chartType: ch.chartType,
    category: { attribute: groupBy },
    series: { attribute: `${entity}id`, aggregate: measure },
  };
  if (typeof ch.description === 'string' && ch.description.trim()) intent.description = ch.description.trim();
  if (typeof ch.title === 'string' && ch.title.trim()) intent.title = ch.title.trim();
  return { errors, intent };
}

/** The live chart's owned fields, or null when its shape is outside the supported model. */
function liveOwned(chart, intent) {
  const series = chart.series || [];
  const categories = chart.categories || [];
  if (series.length !== 1 || categories.length !== 1 || series[0].relatedEntity) return null;
  const cat = categories[0];
  const out = {
    chartType: chart.chartType,
    category: { attribute: lc(cat.attribute) },
    series: { attribute: lc(series[0].attribute), aggregate: lc(series[0].aggregate) },
  };
  // A related-table or date-grouped category is part of the owned value: declaring a plain Choice
  // group-by over it is a change, and must be seen as one.
  if (cat.relatedEntity) out.category.relatedEntity = lc(cat.relatedEntity);
  if (cat.dateGrouping) out.category.dateGrouping = cat.dateGrouping;
  if (intent.description !== undefined) out.description = String(chart.description || '');
  if (intent.title !== undefined) out.title = String((chart.presentation && chart.presentation.title) || '');
  return out;
}

function desiredOwned(intent) {
  const out = { chartType: intent.chartType, category: intent.category, series: intent.series };
  if (intent.description !== undefined) out.description = intent.description;
  if (intent.title !== undefined) out.title = intent.title;
  return out;
}

const PARTS = ['chartType', 'category', 'series', 'description', 'title'];

/**
 * Plan one declared chart. GET only.
 * @returns {{ key, intent, chartId, action, changed, desiredSha?, origin?, operations, refused, unknown }}
 *   action 'create' means "not found": the build creates it through its existing path, then records
 *   the binding with {@link createdChartBinding}.
 */
async function planChartReconcile({ chart, sdk }, ctx = {}) {
  const { errors, intent } = compileChartIntent(chart);
  const key = intent ? intent.key : `${lc(chart && chart.entity)}/${(chart && chart.name) || ''}`;
  const plan = { key, intent, chartId: null, action: null, changed: [], operations: [], refused: [], unknown: [] };
  if (errors.length) {
    plan.errors = errors;
    plan.refused.push(refusal(key, 'chart-spec-invalid', 'the declared chart is outside the supported chart shape (see validation)'));
    return plan;
  }
  plan.desiredSha = intentSha256(desiredOwned(intent));
  let id;
  try {
    id = normalizeGuid(await sdk.findArtifact('chart', { name: intent.name, entity: intent.entity }));
  } catch {
    plan.unknown.push(refusal(key, 'chart-lookup-unreadable', 'whether the chart exists could not be read'));
    return plan;
  }
  if (!id) {
    plan.action = 'create';
    plan.operations.push(operation({ key, kind: 'chart', target: null, action: 'create', publicationScopes: [{ type: 'chart', table: intent.entity }] }));
    return plan;
  }
  plan.chartId = id;
  let current;
  try {
    await sdk.fetchArtifact('chart', id);
    current = await sdk.getArtifact('chart', id);
  } catch {
    plan.unknown.push(refusal(key, 'chart-unreadable', 'the chart could not be read'));
    return plan;
  }
  const live = current ? liveOwned(current, intent) : null;
  if (!live) {
    plan.refused.push(refusal(key, 'chart-shape-unsupported', 'the chart has several series or categories, or a joined-table measure; it was left as it is'));
    return plan;
  }
  const desired = desiredOwned(intent);
  plan.changed = PARTS.filter((p) => desired[p] !== undefined && canonicalJson(desired[p]) !== canonicalJson(live[p]));
  const binding = await lookupBinding(ctx, 'chart', key);
  plan.origin = binding ? binding.origin : 'adopted';
  if (plan.changed.length === 0) {
    plan.action = 'noChange';
    plan.bindUnchanged = bindsUnchanged(binding, ctx, key);
    plan.operations.push(operation({ key, kind: 'chart', target: id, action: 'noChange' }));
    return plan;
  }
  const variants = ownershipSubsets(['description', 'title']).map((o) => liveOwned(current, { ...intent, description: o.description ? '' : undefined, title: o.title ? '' : undefined }));
  const verdict = ownershipDriftVerdict(binding, variants, intentSha256(live), plan.desiredSha);
  if (verdict === 'drift' && !isAuthorized(ctx.authorizedOverwrite, key)) {
    plan.refused.push(refusal(key, 'chart-drift', 'an owned part of the chart was changed outside the spec; refresh the spec or approve the overwrite'));
    return plan;
  }
  if (verdict === 'unbound' && !isAuthorized(ctx.authorizedAdoption, key)) {
    plan.refused.push(refusal(key, 'chart-adoption-not-authorized', 'the chart exists and is not yet managed by this spec; approve adopting it first'));
    return plan;
  }
  plan.action = 'update';
  plan.operations.push(operation({ key, kind: 'chart', target: id, action: 'update', publicationScopes: [{ type: 'chart', id, table: intent.entity }] }));
  return plan;
}

/** Apply a chart plan. A plan with a refusal or an unknown writes nothing; `create` is the build's. */
async function applyChartReconcile(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action || plan.action === 'create') return result;
  const id = plan.chartId;
  const record = () => bindingRecord(ctx, { kind: 'chart', key: plan.key, id, intentSha256: plan.desiredSha, origin: plan.origin });
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: 'chart', id });
    if (plan.bindUnchanged) result.managedBindings.push(record());
    return result;
  }
  const rejected = (rules) => ({ ...refusal(plan.key, 'chart-rejected', 'the SDK refused the chart edit before anything was sent'), rules });
  try {
    const current = await sdk.getArtifact('chart', id);
    const it = plan.intent;
    for (const part of plan.changed) {
      if (part === 'chartType') await sdk.updateElement('chart', id, '/chartType', it.chartType);
      else if (part === 'category') {
        // Keep the live alias (the presentation XML and the category collection refer to it); drop
        // what does not apply to a base-table Choice column.
        const cat = { ...current.categories[0], attribute: it.category.attribute };
        delete cat.relatedEntity;
        delete cat.dateGrouping;
        await sdk.updateElement('chart', id, '/categories/0', cat);
      } else if (part === 'series') {
        await sdk.updateElement('chart', id, '/series/0', { ...current.series[0], attribute: it.series.attribute, aggregate: it.series.aggregate });
      } else if (part === 'description') await sdk.updateElement('chart', id, '/description', it.description);
      else if (part === 'title') await sdk.updateElement('chart', id, '/presentation', { ...(current.presentation || {}), title: it.title });
    }
  } catch (err) {
    result.refused.push(rejected(rulesOf(err)));
    return result;
  }
  const pushed = await pushIfChanged(sdk, 'chart', id);
  if (pushed.outcome === 'unchanged') {
    result.unchanged.push({ key: plan.key, kind: 'chart', id });
    result.managedBindings.push(record());
  } else if (pushed.outcome === 'saved') {
    result.saved.push({ key: plan.key, kind: 'chart', id, parts: plan.changed.slice() });
    const scope = { type: 'chart', id, table: plan.intent.entity };
    queuePublication(ctx, scope);
    result.pendingPublish.push({ key: plan.key, scope });
    result.managedBindings.push(record());
  } else if (pushed.outcome === 'refused') {
    result.refused.push(rejected(pushed.rules || []));
  } else {
    result.unknown.push(refusal(plan.key, 'chart-write-unknown', 'the chart write did not report its outcome; check the chart'));
  }
  return result;
}

/** The binding the build records after creating a declared chart through its existing create path. */
function createdChartBinding(plan, id, ctx = {}) {
  return bindingRecord(ctx, { kind: 'chart', key: plan.key, id, intentSha256: plan.desiredSha, origin: 'created' });
}

module.exports = {
  isDeclaredChart,
  compileChartIntent,
  planChartReconcile,
  applyChartReconcile,
  createdChartBinding,
  CHART_TYPES,
  ID_MEASURES,
};

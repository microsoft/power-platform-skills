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
//
// Identity: an existing managed binding is the authority — a bound chart is edited by its bound id
// only, and a bound chart that is gone is refused (never re-resolved by name to a same-name
// replacement). Unbound, the exact name on the table (the SDK refuses an ambiguous name).
//
// The binding's baseline is the FULL ownable projection (chart type, category, series, description
// and title, whatever the spec declares today), so starting or stopping to declare a description or
// title is an edit, never drift; drift is judged on the parts this run writes.
//
// A missing chart is created here, through the creation-identity port (ctx.creates.run), from the
// artifact the build compiles for it (chartDef), under the id the port reserved.

const {
  canonicalJson,
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  bindsUnchanged,
  pushIfChanged,
  pushChecked,
  queuePublication,
  normalizeGuid,
  rulesOf,
  projectionBaseline,
  partsDriftVerdict,
  boundIdentity,
  createThroughPort,
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

/**
 * The live chart's FULL ownable projection, or null when its shape is outside the supported model.
 * The description and title are always part of it (see the header).
 */
function liveFull(chart) {
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
  out.description = String(chart.description || '');
  out.title = String((chart.presentation && chart.presentation.title) || '');
  return out;
}

/** The full projection after this run: the declared parts over the live ones. */
function desiredFull(intent, live) {
  return {
    chartType: intent.chartType,
    category: intent.category,
    series: intent.series,
    description: intent.description !== undefined ? intent.description : live.description,
    title: intent.title !== undefined ? intent.title : live.title,
  };
}

const PARTS = ['chartType', 'category', 'series', 'description', 'title'];

const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404);

/**
 * Plan one declared chart. GET only.
 * @param {object} args
 * @param {object} args.chart              the spec chart
 * @param {object} args.sdk
 * @param {object} [args.chartArtifact]    the ChartArtifact (without id) the build compiles for it
 *                                         (sdk-build chartDef); needed only when the chart is missing. Not named
 *                                         createArtifact: a destructured binding named like an SDK method is
 *                                         checked as an SDK call by the async-surface guard.
 * @returns {{ key, intent, chartId, action, changed, baseline?, origin?, operations, refused, unknown }}
 */
async function planChartReconcile({ chart, sdk, chartArtifact }, ctx = {}) {
  const { errors, intent } = compileChartIntent(chart);
  const key = intent ? intent.key : `${lc(chart && chart.entity)}/${(chart && chart.name) || ''}`;
  const plan = { key, intent, chartId: null, action: null, changed: [], operations: [], refused: [], unknown: [] };
  if (errors.length) {
    plan.errors = errors;
    plan.refused.push(refusal(key, 'chart-spec-invalid', 'the declared chart is outside the supported chart shape (see validation)'));
    return plan;
  }
  const binding = await lookupBinding(ctx, 'chart', key);
  let id = boundIdentity(binding, { code: 'chart-binding-mismatch', key }).id;
  if (id) id = normalizeGuid(id) || id;
  if (!id) {
    try {
      id = normalizeGuid(await sdk.findArtifact('chart', { name: intent.name, entity: intent.entity }));
    } catch (err) {
      // The SDK refuses a name two rows share (AMBIGUOUS_ARTIFACT): choosing one would edit a row the spec
      // may not mean, so the maker names it instead. Any other failure leaves existence unknown.
      if (err && err.code === 'AMBIGUOUS_ARTIFACT') plan.refused.push(refusal(key, 'chart-name-ambiguous', 'several charts on the table have this name; rename or remove the extra one before it can be managed'));
      else plan.unknown.push(refusal(key, 'chart-lookup-unreadable', 'whether the chart exists could not be read'));
      return plan;
    }
  }
  if (!id) {
    plan.action = 'create';
    plan.createArtifact = chartArtifact || null;
    plan.operations.push(operation({ key, kind: 'chart', target: null, action: 'create', publicationScopes: [{ type: 'chart', table: intent.entity }] }));
    return plan;
  }
  plan.chartId = id;
  let current;
  try {
    await sdk.fetchArtifact('chart', id);
    current = await sdk.getArtifact('chart', id);
  } catch (err) {
    if (binding && isNotFound(err)) plan.refused.push(refusal(key, 'chart-bound-row-missing', 'the chart this key is bound to is gone; repair the binding explicitly before it can be recreated'));
    else plan.unknown.push(refusal(key, 'chart-unreadable', 'the chart could not be read'));
    return plan;
  }
  const live = current ? liveFull(current) : null;
  if (!live) {
    plan.refused.push(refusal(key, 'chart-shape-unsupported', 'the chart has several series or categories, or a joined-table measure; it was left as it is'));
    return plan;
  }
  const desired = desiredFull(intent, live);
  plan.changed = PARTS.filter((p) => canonicalJson(desired[p]) !== canonicalJson(live[p]));
  plan.baseline = projectionBaseline(desired);
  plan.origin = binding ? binding.origin : 'adopted';
  if (plan.changed.length === 0) {
    plan.action = 'noChange';
    plan.bindUnchanged = bindsUnchanged(binding, ctx, key);
    plan.operations.push(operation({ key, kind: 'chart', target: id, action: 'noChange' }));
    return plan;
  }
  const verdict = partsDriftVerdict(binding, live, desired);
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

async function readBaseline(sdk, id) {
  try {
    await sdk.fetchArtifact('chart', id);
    const fresh = await sdk.getArtifact('chart', id);
    const live = fresh && liveFull(fresh);
    return live ? projectionBaseline(live) : null;
  } catch {
    return null;
  }
}

/** Create a missing declared chart through the creation-identity port (see the header). */
async function applyChartCreate(plan, sdk, ctx, result) {
  if (!plan.createArtifact) {
    result.refused.push(refusal(plan.key, 'chart-create-artifact-missing', 'the build did not pass the chart definition to create; nothing was written'));
    return result;
  }
  const created = await createThroughPort(ctx, { kind: 'chart', key: plan.key, identity: [plan.intent.entity, plan.intent.name], childKeys: [] }, async ({ id }) => {
    const art = await sdk.createArtifact('chart', { ...plan.createArtifact, id });
    // The port recorded `id` before this send; a chart stored under another id could not be recovered.
    if (normalizeGuid(art && art.id) !== normalizeGuid(id)) return { outcome: 'refused', code: 'CREATE_ID_NOT_KEPT' };
    return pushChecked(sdk, 'chart', id);
  });
  const id = created.id ? normalizeGuid(created.id) || String(created.id) : null;
  if (created.status === 'created') {
    const scope = { type: 'chart', id, table: plan.intent.entity };
    result.saved.push({ key: plan.key, kind: 'chart', id, created: true, parts: PARTS.slice() });
    queuePublication(ctx, scope);
    result.pendingPublish.push({ key: plan.key, scope });
    const baseline = await readBaseline(sdk, id);
    if (baseline) result.managedBindings.push(bindingRecord(ctx, { kind: 'chart', key: plan.key, id, origin: 'created', ...baseline }));
    else result.unknown.push(refusal(plan.key, 'chart-created-unreadable', 'the chart was created but could not be read back to record its baseline'));
  } else if (created.status === 'adopted') {
    const baseline = id ? await readBaseline(sdk, id) : null;
    if (baseline) {
      result.managedBindings.push(bindingRecord(ctx, { kind: 'chart', key: plan.key, id, origin: 'created', ...baseline }));
      result.refused.push(refusal(plan.key, 'creation-adopted-rerun', 'the chart an earlier create made was bound; run again to apply the spec to it'));
    } else {
      result.refused.push(refusal(plan.key, 'creation-adopted-row-missing', 'the chart the resolved create named could not be read; repair the binding explicitly'));
    }
  } else if (created.status === 'refused') {
    result.refused.push({ ...refusal(plan.key, /^creation-/.test(created.code) ? created.code : 'chart-create-refused', 'the chart was not created; nothing was written'), rules: created.rules || [] });
  } else {
    result.unknown.push(refusal(plan.key, 'chart-write-unknown', 'the chart create did not report its outcome; check the table\'s charts'));
  }
  return result;
}

/** Apply a chart plan. A plan with a refusal or an unknown writes nothing. */
async function applyChartReconcile(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  if (plan.action === 'create') return applyChartCreate(plan, sdk, ctx, result);
  const id = plan.chartId;
  const record = () => bindingRecord(ctx, { kind: 'chart', key: plan.key, id, origin: plan.origin, ...plan.baseline });
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
module.exports = {
  isDeclaredChart,
  compileChartIntent,
  planChartReconcile,
  applyChartReconcile,
  CHART_TYPES,
  ID_MEASURES,
};

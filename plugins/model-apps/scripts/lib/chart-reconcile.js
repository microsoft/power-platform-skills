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
// A missing chart is created here, through the creation port (ctx.creates.run), from the artifact
// the build compiles for it (chartDef), under the id the port allocated for this create.
//
// A declared title is stored only where the SDK can write one: into a <Title> element the stored
// presentation already has. An existing chart without one is refused (chart-title-not-stored) before
// anything is written; a new chart is created from the SDK's scratch presentation, which has none, so
// its title is reported not stored rather than saved. A title is never claimed without a read-back.
//
// The apply records the publish it needs in `pendingPublish`; the publish is queued only once the
// whole result has settled with no refusal and no unknown (commitPublication).

const {
  canonicalJson,
  emptyResult,
  operation,
  refusal,
  approvalKey,
  isApproved,
  lookupBinding,
  bindingRecord,
  bindsUnchanged,
  pushIfChanged,
  pushChecked,
  commitPublication,
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
 * The plan key of a declared chart that compiles: `<table>/<trimmed name>`. Shared by the planner and the stable create
 * catalog (creates-stable-build.js), so a create is always looked up under the key it was reserved for.
 */
function declaredChartKey(ch) {
  return `${lc(ch && ch.entity)}/${ch && typeof ch.name === 'string' ? ch.name.trim() : ''}`;
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
    key: declaredChartKey(ch),
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

/**
 * Whether the stored presentation has a <Title> element the SDK can write a title into. The SDK keeps
 * the presentation XML it does not model in the chart's `presentationBag`, a public HybridBag of
 * RawNode trees ({ n: tag, a: attributes, c: children }), e.g. for `<Titles><Title Alignment="TopLeft"/></Titles>`:
 *   { a: [...], c: [{ i: 2, node: { n: 'Titles', a: [], c: [{ n: 'Title', a: [['Alignment', 'TopLeft']], c: [] }] } }] }
 * A chart with no bag (one built from scratch) has no title element either.
 */
function canHoldTitle(chart) {
  const bag = chart && chart.presentationBag;
  const stack = bag && Array.isArray(bag.c) ? bag.c.map((child) => child && child.node) : [];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.n === 'Title') return true;
    if (Array.isArray(node.c)) stack.push(...node.c);
  }
  return false;
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
    plan.bindUnchanged = bindsUnchanged(binding, ctx, approvalKey('chart', key));
    plan.operations.push(operation({ key, kind: 'chart', target: id, action: 'noChange' }));
    return plan;
  }
  const verdict = partsDriftVerdict(binding, live, desired);
  if (verdict === 'drift' && !isApproved(ctx.authorizedOverwrite, 'chart', key)) {
    plan.refused.push(refusal(key, 'chart-drift', 'an owned part of the chart was changed outside the spec; refresh the spec or approve the overwrite'));
    return plan;
  }
  if (verdict === 'unbound' && !isApproved(ctx.authorizedAdoption, 'chart', key)) {
    plan.refused.push(refusal(key, 'chart-adoption-not-authorized', 'the chart exists and is not yet managed by this spec; approve adopting it first'));
    return plan;
  }
  if (plan.changed.includes('title') && !canHoldTitle(current)) {
    plan.refused.push(refusal(key, 'chart-title-not-stored', 'the chart has no title element the SDK can write, so the declared title cannot be stored; nothing was written. Remove the title from the spec, or add a title to the chart in the chart designer'));
    return plan;
  }
  plan.action = 'update';
  plan.operations.push(operation({ key, kind: 'chart', target: id, action: 'update', publicationScopes: [{ type: 'chart', id, table: intent.entity }] }));
  return plan;
}

/** The stored chart's full projection, read back after a write, or null when it cannot be read. */
async function readObserved(sdk, id) {
  try {
    await sdk.fetchArtifact('chart', id);
    const fresh = await sdk.getArtifact('chart', id);
    return (fresh && liveFull(fresh)) || null;
  } catch {
    return null;
  }
}

// The SDK writes a chart title only into a <Title> element the stored presentation already has
// (ChartAdapter applyPresentation); a chart without one, including every new chart, which starts
// from the SDK's scratch presentation, keeps no title and the push still succeeds. So a declared
// title is claimed only when the read-back shows it stored, and otherwise refused as not stored,
// with the binding taken from what was read back so the next run is not false drift.
const TITLE_NOT_STORED = 'the chart was written, but it has no title element the SDK can write, so the declared title was not stored; remove the title from the spec or add a title to the chart in the chart designer';

/** Create a missing declared chart through the creation port (see the header). */
async function applyChartCreate(plan, sdk, ctx, result) {
  if (!plan.createArtifact) {
    result.refused.push(refusal(plan.key, 'chart-create-artifact-missing', 'the build did not pass the chart definition to create; nothing was written'));
    return result;
  }
  const created = await createThroughPort(ctx, { kind: 'chart', key: plan.key, identity: [plan.intent.entity, plan.intent.name], childKeys: [] }, async ({ id }) => {
    const art = await sdk.createArtifact('chart', { ...plan.createArtifact, id });
    // The chart must be stored under the id this create was given: the result, the binding and the
    // solution bookkeeping all name that id, so a create that does not keep it is refused.
    if (normalizeGuid(art && art.id) !== normalizeGuid(id)) return { outcome: 'refused', code: 'CREATE_ID_NOT_KEPT' };
    return pushChecked(sdk, 'chart', id);
  });
  const id = created.id ? normalizeGuid(created.id) || String(created.id) : null;
  if (created.status === 'created' || created.status === 'matched') {
    // 'matched' (the stable port only): the row is already at the reserved id. Handled as a create, bound as adopted
    // (see applyViewCreate).
    const origin = created.status === 'created' ? 'created' : 'adopted';
    const scope = { type: 'chart', id, table: plan.intent.entity };
    const observed = await readObserved(sdk, id);
    // The title is claimed only when the spec declares one and the read-back shows it stored.
    const titleStored = plan.intent.title !== undefined && !!observed && observed.title === plan.intent.title;
    result.saved.push({ key: plan.key, kind: 'chart', id, created: true, parts: PARTS.filter((p) => p !== 'title' || titleStored) });
    result.pendingPublish.push({ key: plan.key, scope });
    if (observed) result.managedBindings.push(bindingRecord(ctx, { kind: 'chart', key: plan.key, id, origin, ...projectionBaseline(observed) }));
    else result.unknown.push(refusal(plan.key, 'chart-created-unreadable', 'the chart was created but could not be read back to record its baseline'));
    if (observed && plan.intent.title !== undefined && !titleStored) result.refused.push(refusal(plan.key, 'chart-title-not-stored', TITLE_NOT_STORED));
  } else if (created.status === 'adopted') {
    const observed = id ? await readObserved(sdk, id) : null;
    if (observed) {
      result.managedBindings.push(bindingRecord(ctx, { kind: 'chart', key: plan.key, id, origin: 'created', ...projectionBaseline(observed) }));
      result.refused.push(refusal(plan.key, 'creation-adopted-rerun', 'the chart an earlier create made was bound; run again to apply the spec to it'));
    } else {
      result.refused.push(refusal(plan.key, 'creation-adopted-row-missing', 'the chart the resolved create named could not be read; repair the binding explicitly'));
    }
  } else if (created.status === 'refused') {
    result.refused.push({ ...refusal(plan.key, /^creation-/.test(created.code) ? created.code : 'chart-create-refused', 'the chart was not created; nothing was written'), rules: created.rules || [] });
  } else {
    // The create may have been stored: its table's publication is recorded (withheld) so the build's
    // publication barrier keeps the table unpublished (publication-barrier.js).
    result.pendingPublish.push({ key: plan.key, scope: { type: 'chart', id, table: plan.intent.entity } });
    result.unknown.push(refusal(plan.key, 'chart-write-unknown', 'the chart create did not report its outcome; check the table\'s charts'));
  }
  return result;
}

/**
 * Apply a chart plan. A plan with a refusal or an unknown writes nothing. The publish the apply needs
 * is queued only when the whole result settles cleanly (commitPublication).
 */
async function applyChartReconcile(plan, { sdk }, ctx = {}) {
  return commitPublication(ctx, await applyChartPlan(plan, sdk, ctx));
}

async function applyChartPlan(plan, sdk, ctx) {
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
  if (plan.changed.includes('title') && (pushed.outcome === 'unchanged' || pushed.outcome === 'saved')) {
    const observed = await readObserved(sdk, id);
    if (!observed || observed.title !== plan.intent.title) {
      const parts = plan.changed.filter((p) => p !== 'title');
      if (pushed.outcome === 'saved') {
        // Only the parts other than the title are claimed saved, but the push stored the row either way,
        // so its publication is recorded (withheld with the refusal or unknown below).
        if (parts.length) result.saved.push({ key: plan.key, kind: 'chart', id, parts });
        result.pendingPublish.push({ key: plan.key, scope: { type: 'chart', id, table: plan.intent.entity } });
      }
      if (observed) {
        result.refused.push(refusal(plan.key, 'chart-title-not-stored', TITLE_NOT_STORED));
        result.managedBindings.push(bindingRecord(ctx, { kind: 'chart', key: plan.key, id, origin: plan.origin, ...projectionBaseline(observed) }));
      } else {
        // Without a read-back no baseline is guessed: the next run judges the chart afresh.
        result.unknown.push(refusal(plan.key, 'chart-title-unverified', 'the chart was written but could not be read back, so whether the declared title was stored is unknown'));
      }
      return result;
    }
  }
  if (pushed.outcome === 'unchanged') {
    result.unchanged.push({ key: plan.key, kind: 'chart', id });
    result.managedBindings.push(record());
  } else if (pushed.outcome === 'saved') {
    result.saved.push({ key: plan.key, kind: 'chart', id, parts: plan.changed.slice() });
    result.pendingPublish.push({ key: plan.key, scope: { type: 'chart', id, table: plan.intent.entity } });
    result.managedBindings.push(record());
  } else if (pushed.outcome === 'refused') {
    result.refused.push(rejected(pushed.rules || []));
  } else {
    // The write may have been stored: recorded (withheld) for the publication barrier.
    result.pendingPublish.push({ key: plan.key, scope: { type: 'chart', id, table: plan.intent.entity } });
    result.unknown.push(refusal(plan.key, 'chart-write-unknown', 'the chart write did not report its outcome; check the chart'));
  }
  return result;
}
module.exports = {
  isDeclaredChart,
  declaredChartKey,
  compileChartIntent,
  planChartReconcile,
  applyChartReconcile,
  CHART_TYPES,
  ID_MEASURES,
};

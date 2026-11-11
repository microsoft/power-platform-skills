'use strict';
// What verify holds a deployed chart's CONTENT to (lib/verify-spec.js, the charts section). The presence check finds the chart; these checks say
// whether the chart it found is the one the spec describes: its type, the query it draws (table, group-by column, measure), and — where the build
// owns them — its description and title. A chart that exists with the wrong type, a different grouping or an extra filter used to pass verify;
// it now fails, for a legacy chart as for a declared one, because verify reports what is deployed, not what a rebuild would repair.
//
// The expectation is the build's own:
//   - a declared chart (`reconcile: "declared"`): the intent lib/chart-reconcile.js compileChartIntent compiles — chart type, one Choice
//     category on the chart's table, one count/countcolumn measure of the table's primary id, and the description and title only where the spec
//     sets them to non-blank text;
//   - a legacy chart: what sdk-build.js chartDef sends — chart type, group-by and `measure || 'count'` of the primary id, and the description
//     the build reconciles (#496) where the spec sets one. Its title is not asserted: the legacy build ignores a title (validation warns), and the
//     name chartDef puts in the presentation is not stored by the SDK's scratch presentation, which has no Title element. A legacy measure the
//     verifier does not know as a FetchXML aggregate is not compared (unverified), never failed by the declared validator's narrower rule.
//
// The deployed side is the PUBLISHED row (a plain read of savedqueryvisualization answers the published layer; sdk-build.js says so where it
// reads a description), the same row the presence check found:
//   datadescription, as the SDK writes it (ChartAdapter, scripts/vendor/cds-maker-sdk.cjs):
//     <datadefinition><fetchcollection><fetch mapping="logical" aggregate="true"><entity name="new_ticket">
//       <attribute alias="agg_0" name="new_ticketid" aggregate="count" />
//       <attribute alias="grp_0" name="new_status" groupby="true" />
//     </entity></fetch></fetchcollection>
//     <categorycollection><category alias="grp_0"><measurecollection><measure alias="agg_0" /></measurecollection></category></categorycollection>
//     </datadefinition>
//   presentationdescription, the chart type on the one Series item, styling around it:
//     <Chart Palette="BrightPastel"><Series><Series ChartType="Column" ChartArea="Default" /></Series><ChartAreas>…</ChartAreas>…</Chart>
//
// Both are read with the one strict XML reader (lib/strict-xml.js): an XML declaration or byte order mark, either quote style, any attribute
// order, `<a/>` or `<a></a>`, character references and white space between elements read the same; a document type declaration, a malformed
// document, one too large or too deep is not read, and its content is UNVERIFIED — never normalized into a pass.
//
// Three outcomes per check, kept apart:
//   - a pass: every part of the query is one this verifier models and each equals the expectation;
//   - a FAILURE: a part the verifier models contradicts the expectation — another chart type, a second measure or series, a different group-by
//     column or date grouping, another aggregate (count and countcolumn are distinct), another table, a filter or a join that changes the rows
//     the chart counts, or a declared title the fully read presentation does not have;
//   - UNVERIFIED: something the verifier cannot give a meaning to — an element or attribute it does not model (an order, an outer join with
//     nothing in it, a per-series chart type), an alias that names nothing, or a document it cannot read. An unknown element is never dropped
//     to obtain a match: the platform's own additions need a measurement before they are let through.
//
// Styling — palette, colours, custom properties, axes, legends — is not the spec's, so it is not compared at all: the declared reconcile keeps
// it byte for byte (chart-reconcile-real-bundle.test.js), which is an ownership boundary, not evidence that the platform rewrites it.
//
// Nothing here reads the service or writes anything: it is handed the row verify read.

const { readXmlElements, XML_PREDEFINED } = require('./strict-xml.js');
const { isDeclaredChart, compileChartIntent, CHART_TYPES } = require('./chart-reconcile.js');

// The datadescription and presentationdescription of a chart the build makes are a few hundred characters; a maker-styled one a few
// kilobytes. Anything past these bounds is not a chart this verifier reads (and a deep one would cost the reader the square of its depth).
const MAX_CHART_XML = 256 * 1024;
const MAX_CHART_DEPTH = 32;
// The FetchXML aggregates (https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/aggregate-data). A legacy chart's
// measure is sent as written (chartDef), so only one of these, written as FetchXML writes it, has a meaning the verifier can compare.
const FETCH_AGGREGATES = ['count', 'countcolumn', 'sum', 'avg', 'min', 'max'];

const lc = (s) => String(s == null ? '' : s).toLowerCase();

const DATA = 'datadefinition';
const FETCH_PATH = 'datadefinition/fetchcollection/fetch';
const ENTITY_PATH = `${FETCH_PATH}/entity`;
const CATEGORY_PATH = 'datadefinition/categorycollection/category';
// The elements of a datadescription this verifier gives a meaning to, by where they are, with the attributes each may carry. Anything else is
// unverified. A filter, a join and an order are handled apart (below), because what they mean is known.
const KNOWN_DATA = new Map([
  ['|datadefinition', []],
  ['datadefinition|fetchcollection', []],
  ['datadefinition/fetchcollection|fetch', ['mapping', 'aggregate']],
  [`${FETCH_PATH}|entity`, ['name']],
  [`${ENTITY_PATH}|attribute`, ['name', 'alias', 'aggregate', 'groupby', 'dategrouping']],
  ['datadefinition|categorycollection', []],
  ['datadefinition/categorycollection|category', ['alias']],
  [`${CATEGORY_PATH}|measurecollection`, []],
  [`${CATEGORY_PATH}/measurecollection|measure`, ['alias']],
]);

/**
 * What the spec says the chart is, as the build compiles it, or `{ unverifiable }` when it cannot be compiled into something to compare.
 * `aggregate` is null for a legacy measure the verifier does not know (its data check is then unverified).
 * @returns {{ declared: boolean, entity: string, chartType: string|null, groupBy: string, measureAttribute: string, aggregate: string|null,
 *            measure: *, description?: string, title?: string } | { declared: boolean, unverifiable: string }}
 */
function expectedChart(ch) {
  const declared = isDeclaredChart(ch);
  if (declared) {
    const { errors, intent } = compileChartIntent(ch);
    if (errors.length) return { declared, unverifiable: `the declared chart does not compile (${errors.join('; ')})` };
    return {
      declared,
      entity: intent.entity,
      chartType: intent.chartType,
      groupBy: intent.category.attribute,
      measureAttribute: intent.series.attribute,
      aggregate: intent.series.aggregate,
      measure: intent.series.aggregate,
      ...(intent.description !== undefined ? { description: intent.description } : {}),
      ...(intent.title !== undefined ? { title: intent.title } : {}),
    };
  }
  const entity = lc(ch && ch.entity);
  const groupBy = lc(ch && ch.groupBy);
  if (!entity || !groupBy) return { declared, unverifiable: 'the chart names no table or no group-by column' };
  // chartDef sends `ch.measure || 'count'` as the aggregate, exactly as written.
  const measure = (ch && ch.measure) || 'count';
  const out = {
    declared,
    entity,
    chartType: CHART_TYPES.includes(ch.chartType) ? ch.chartType : null,
    groupBy,
    measureAttribute: `${entity}id`,
    aggregate: typeof measure === 'string' && FETCH_AGGREGATES.includes(measure) ? measure : null,
    measure,
  };
  // The legacy build writes a description only when the spec sets one (sdk-build.js, "Same two guards as views").
  if (typeof ch.description === 'string' && ch.description.trim()) out.description = ch.description.trim();
  return out;
}

function readChartXml(xml, what, options) {
  if (typeof xml !== 'string' || !xml.trim()) return { unreadable: `the chart has no ${what} to read` };
  if (xml.length > MAX_CHART_XML) return { unreadable: `its ${what} is larger than the verifier reads` };
  const read = readXmlElements(xml, () => true, { maxDepth: MAX_CHART_DEPTH, ...options });
  if (!read.ok) return { unreadable: `its ${what} is not XML the verifier reads (${read.detail})` };
  return { elements: read.elements };
}

const within = (path, base) => path === base || path.startsWith(`${base}/`);

/**
 * The verdict on the query a chart draws: `{ verdict: 'pass'|'fail'|'unverified', detail }`. A known contradiction fails even when another part
 * is unknown: two measures are two measures whatever else the document holds.
 */
function chartDataVerdict(xml, want) {
  // Every element of a datadescription holds elements only: text, a comment or a CDATA section anywhere in it is not read.
  const doc = readChartXml(xml, 'datadescription', { elementOnly: () => true });
  if (doc.unreadable) return { verdict: 'unverified', detail: doc.unreadable };
  const contradictions = [];
  const unknowns = [];
  const note = (list, text) => { if (!list.includes(text)) list.push(text); };
  const roots = doc.elements.filter((e) => e.path === '');
  if (roots.length !== 1 || roots[0].name !== DATA) return { verdict: 'unverified', detail: 'its datadescription is not a datadefinition' };
  // A filter or a join is read as one thing, its content with it: elements under one are not separately unknown.
  const covered = [];
  const fetches = [];
  const entities = [];
  const attributes = [];
  const categories = [];
  const measures = [];
  for (const e of doc.elements) {
    if (covered.some((base) => within(e.path, base))) continue;
    if (within(e.path, ENTITY_PATH) && e.name === 'filter') {
      note(contradictions, 'a filter narrows the rows it counts, which the spec\u2019s chart does not');
      covered.push(`${e.path}/filter`);
      continue;
    }
    if (within(e.path, ENTITY_PATH) && e.name === 'link-entity') {
      const self = `${e.path}/link-entity`;
      const holds = doc.elements.some((x) => within(x.path, self));
      // An outer join that brings nothing in and filters nothing does not change the rows counted, but what the platform does with one in a
      // chart is not measured: unverified. Any other join (an inner one changes the rows; one that holds a column moves the measure or the
      // category to another table) contradicts the spec's base-table chart.
      if (lc(e.attrs['link-type']) === 'outer' && !holds) note(unknowns, `an outer join to ${e.attrs.name || 'a table'}`);
      else note(contradictions, `it joins ${e.attrs.name || 'another table'}, which the spec\u2019s chart does not`);
      covered.push(self);
      continue;
    }
    if (e.path === ENTITY_PATH && e.name === 'order') { note(unknowns, 'an order on its groups'); continue; }
    const allowed = KNOWN_DATA.get(`${e.path}|${e.name}`);
    if (!allowed) { note(unknowns, `an element <${e.name}> the verifier does not model`); continue; }
    for (const a of Object.keys(e.attrs)) if (!allowed.includes(a)) note(unknowns, `the attribute ${a} on <${e.name}>`);
    if (e.name === 'fetch') fetches.push(e);
    else if (e.name === 'entity') entities.push(e);
    else if (e.name === 'attribute') attributes.push(e);
    else if (e.name === 'category') categories.push(e);
    else if (e.name === 'measure') measures.push(e);
  }
  if (fetches.length !== 1) note(unknowns, `${fetches.length} fetches`);
  for (const f of fetches) {
    if (f.attrs.mapping !== undefined && f.attrs.mapping !== 'logical') note(unknowns, `a fetch with mapping "${f.attrs.mapping}"`);
    if (lc(f.attrs.aggregate) !== 'true') note(unknowns, 'a fetch that is not an aggregate query');
  }
  if (entities.length !== 1) note(unknowns, `${entities.length} entities in its fetch`);
  for (const en of entities) if (lc(en.attrs.name) !== want.entity) note(contradictions, `it reads ${en.attrs.name || 'no table'}, not ${want.entity}`);
  // The aliases are the references between the query and its category collection; a document where two columns share one cannot be mapped.
  const aliases = attributes.map((a) => a.attrs.alias).filter((a) => a !== undefined);
  if (new Set(aliases).size !== aliases.length) note(unknowns, 'two columns with one alias');
  const groups = [];
  const aggregates = [];
  for (const a of attributes) {
    const isGroup = lc(a.attrs.groupby) === 'true';
    if (a.attrs.aggregate !== undefined && isGroup) note(unknowns, `a column ${a.attrs.name || ''} that is both grouped and aggregated`);
    else if (a.attrs.aggregate !== undefined) aggregates.push(a);
    else if (isGroup) groups.push(a);
    else note(unknowns, `a column ${a.attrs.name || ''} that is neither grouped nor aggregated`);
  }
  if (aggregates.length === 0) note(contradictions, 'it has no measure');
  else if (aggregates.length > 1) note(contradictions, `it has ${aggregates.length} measures; the spec\u2019s chart has one`);
  if (groups.length === 0) note(contradictions, 'it has no category');
  else if (groups.length > 1) note(contradictions, `it groups by ${groups.length} columns; the spec\u2019s chart groups by one`);
  if (aggregates.length === 1) {
    const m = aggregates[0];
    if (lc(m.attrs.name) !== want.measureAttribute) note(contradictions, `its measure is on ${m.attrs.name || 'no column'}, not ${want.measureAttribute}`);
    if (want.aggregate === null) note(unknowns, `the spec\u2019s measure ${JSON.stringify(want.measure)} is not an aggregate the verifier compares`);
    // FetchXML writes an aggregate in lower case; one written otherwise is not known to mean the same.
    else if (m.attrs.aggregate === want.aggregate) { /* the measure the spec asks for */ }
    else if (lc(m.attrs.aggregate) === want.aggregate) note(unknowns, `the aggregate "${m.attrs.aggregate}"`);
    else note(contradictions, `it aggregates with ${m.attrs.aggregate}, not ${want.aggregate}`);
  }
  if (groups.length === 1) {
    const g = groups[0];
    if (lc(g.attrs.name) !== want.groupBy) note(contradictions, `it groups by ${g.attrs.name || 'no column'}, not ${want.groupBy}`);
    if (g.attrs.dategrouping !== undefined) note(contradictions, `it groups ${g.attrs.name || 'its column'} by ${g.attrs.dategrouping}, which a Choice group-by does not`);
  }
  if (categories.length === 0) note(unknowns, 'no category in its category collection');
  else if (categories.length > 1) note(contradictions, `it has ${categories.length} categories; the spec\u2019s chart has one`);
  if (categories.length === 1) {
    const cat = categories[0];
    if (groups.length === 1 && (cat.attrs.alias === undefined || cat.attrs.alias !== groups[0].attrs.alias)) note(unknowns, 'a category that does not name its group-by column');
    if (measures.length === 0) note(unknowns, 'a category with no measure');
    else if (measures.length > 1) note(contradictions, `it shows ${measures.length} series; the spec\u2019s chart shows one`);
    else if (aggregates.length === 1 && (measures[0].attrs.alias === undefined || measures[0].attrs.alias !== aggregates[0].attrs.alias)) note(unknowns, 'a series that does not name its measure');
  }
  if (contradictions.length) return { verdict: 'fail', detail: contradictions.join('; ') };
  if (unknowns.length) return { verdict: 'unverified', detail: `its query holds what the verifier does not model: ${unknowns.join('; ')}` };
  return { verdict: 'pass', detail: '' };
}

// The text of an element the strict reader placed (`spans`), as an XML parser gives its textContent; null when it holds markup (a child element,
// a comment, a CDATA section), which this does not read. References are decoded (the reader has checked each is a predefined entity or a
// character XML allows) and line ends read as XML reads them (https://www.w3.org/TR/xml/#sec-line-ends).
function elementText(xml, el) {
  const whole = xml.slice(el.start, el.end);
  let quote = '';
  let close = -1;
  for (let i = 1; i < whole.length; i += 1) {
    const c = whole[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === '\'') {
      quote = c;
    } else if (c === '>') {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  if (whole[close - 1] === '/') return '';
  const inner = whole.slice(close + 1, whole.lastIndexOf('</'));
  if (inner.includes('<')) return null;
  return inner.replace(/\r\n?/g, '\n').replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|amp|quot|apos));/g, (ref, hex, dec, name) => (name
    ? XML_PREDEFINED[name]
    : String.fromCodePoint(parseInt(hex !== undefined ? hex : dec, hex !== undefined ? 16 : 10))));
}

/**
 * The verdicts on a chart's presentation: its type (from the one Series item's ChartType, which is where the SDK reads and writes it) and,
 * when `want.title` is set, its title (the first Title element's text, as the SDK reads it).
 * @returns {{ type: { verdict, detail }, title?: { verdict, detail } }}
 */
function chartPresentationVerdicts(xml, want) {
  const doc = readChartXml(xml, 'presentationdescription', { spans: true });
  const out = {};
  if (doc.unreadable) {
    out.type = { verdict: 'unverified', detail: doc.unreadable };
    if (want.title !== undefined) out.title = { verdict: 'unverified', detail: doc.unreadable };
    return out;
  }
  const roots = doc.elements.filter((e) => e.path === '');
  if (roots.length !== 1 || roots[0].name !== 'Chart') {
    out.type = { verdict: 'unverified', detail: 'its presentationdescription is not a Chart' };
    if (want.title !== undefined) out.title = { verdict: 'unverified', detail: 'its presentationdescription is not a Chart' };
    return out;
  }
  const items = doc.elements.filter((e) => e.name === 'Series' && e.path === 'Chart/Series');
  const typedElsewhere = doc.elements.some((e) => e.name === 'Series' && e.path !== 'Chart/Series' && e.attrs.ChartType !== undefined);
  if (want.chartType === null) out.type = { verdict: 'unverified', detail: 'the spec\u2019s chartType is not one the build writes' };
  else if (items.length > 1) out.type = { verdict: 'fail', detail: `it presents ${items.length} series; the spec\u2019s chart presents one` };
  else if (items.length === 0) out.type = { verdict: 'unverified', detail: 'its presentation has no series' };
  else if (typedElsewhere) out.type = { verdict: 'unverified', detail: 'its presentation sets a chart type outside its series' };
  else if (items[0].attrs.ChartType === undefined) out.type = { verdict: 'unverified', detail: 'its series states no chart type' };
  // The SDK reads ChartType case-insensitively (its known types), so the verifier does too.
  else if (lc(items[0].attrs.ChartType) === lc(want.chartType)) out.type = { verdict: 'pass', detail: '' };
  else out.type = { verdict: 'fail', detail: `it is a ${items[0].attrs.ChartType} chart, not ${want.chartType}` };
  if (want.title !== undefined) {
    const titles = doc.elements.filter((e) => e.name === 'Title');
    if (titles.length === 0) out.title = { verdict: 'fail', detail: `the chart has no title element, so the declared title "${want.title}" is not shown` };
    else if (titles.length > 1) out.title = { verdict: 'unverified', detail: 'its presentation has more than one title' };
    else {
      const text = elementText(xml, titles[0]);
      if (text === null) out.title = { verdict: 'unverified', detail: 'its title holds markup the verifier does not read' };
      else if (text.trim() === want.title) out.title = { verdict: 'pass', detail: '' };
      else out.title = { verdict: 'fail', detail: `its title is "${text.trim()}", not "${want.title}"` };
    }
  }
  return out;
}

// A legacy chart's definition is left as it is by a rebuild (sdk-build.js charts phase), so a mismatch there says how to change it.
const LEGACY_NOTE = ' (the chart is not reconcile: "declared", so a rebuild leaves an existing chart\u2019s definition as it is: declare it, or recreate the chart, to change it)';

/**
 * The content checks of one present chart. `row` is the published row verify read, with datadescription, presentationdescription and
 * description. A row that carries neither XML column comes from a reader that does not read chart content: nothing is checked, as a view's
 * filters are not checked against a row without fetchxml.
 * @param {object} ch the spec chart
 * @param {object} row the deployed row
 * @param {string} name the name the chart's checks report under (the presence check's)
 * @returns {{ checks: { kind: string, name: string, present: boolean, detail: string }[], unverified: string[] }}
 */
function chartContentChecks(ch, row, name) {
  const checks = [];
  const unverified = [];
  const has = (k) => !!row && Object.prototype.hasOwnProperty.call(row, k);
  if (!has('datadescription') && !has('presentationdescription')) return { checks, unverified };
  const want = expectedChart(ch);
  if (want.unverifiable) {
    unverified.push(`chart-data:${name} (${want.unverifiable})`);
    return { checks, unverified };
  }
  const report = (kind, v, legacyNote) => {
    if (v.verdict === 'pass') checks.push({ kind, name, present: true, detail: '' });
    else if (v.verdict === 'fail') checks.push({ kind, name, present: false, detail: `${v.detail}${legacyNote && !want.declared ? LEGACY_NOTE : ''}` });
    else unverified.push(`${kind}:${name} (${v.detail})`);
  };
  const presentation = chartPresentationVerdicts(has('presentationdescription') ? row.presentationdescription : undefined, want);
  report('chart-type', presentation.type, true);
  report('chart-data', chartDataVerdict(has('datadescription') ? row.datadescription : undefined, want), true);
  if (want.description !== undefined) {
    if (!has('description')) report('chart-description', { verdict: 'unverified', detail: 'the read does not carry the chart\u2019s description' });
    else {
      // Compared trimmed on both sides: a chart created from an untrimmed description stores it as written (chartDef), and the build's
      // own reconcile compares the trimmed text.
      const got = row.description == null ? '' : String(row.description).trim();
      report('chart-description', got === want.description ? { verdict: 'pass' } : { verdict: 'fail', detail: got ? `its description is "${got}", not the spec\u2019s` : 'it has no description; the spec sets one' });
    }
  }
  if (presentation.title) report('chart-title', presentation.title);
  return { checks, unverified };
}

module.exports = { expectedChart, chartDataVerdict, chartPresentationVerdicts, chartContentChecks, MAX_CHART_XML };

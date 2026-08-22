'use strict';

function patternFor(element, count) {
  if (element === 'filters') return count <= 4 ? 'chips' : count <= 8 ? 'chips-overflow' : 'filter-sheet-search';
  if (element === 'bottomTabs') return count <= 5 ? 'tab-bar' : 'four-tabs-more-or-drawer';
  if (element.startsWith('choice-')) return count <= 3 ? 'segmented-control' : count <= 6 ? 'inline-radio-list' : 'picker-sheet-search';
  if (element === 'listRows') {
    if (count === 0) return 'empty-state-cta';
    return count <= 20 ? 'plain-list' : count <= 200 ? 'search-section-groups' : 'search-virtualized-sticky-index';
  }
  if (element === 'childRecords') return count <= 5 ? 'inline-child-list' : 'first-three-see-all';
  if (element === 'actions') {
    if (count <= 1) return 'single-primary';
    if (count === 2) return 'primary-secondary-adjacent';
    return count <= 4 ? 'button-row' : 'primary-overflow-menu';
  }
  if (element === 'statTiles') return count <= 4 ? 'single-stat-row' : 'stat-grid-2xn';
  if (element === 'images') return count <= 1 ? 'image-hero' : count <= 4 ? 'thumbnail-row' : 'gallery-count-badge';
  if (element === 'productCards') return count <= 1 ? 'featured-product-card' : count <= 4 ? 'product-card-row' : count <= 12 ? 'product-card-grid' : 'product-list-search';
  return null;
}

function renderedPatterns(snapshot) {
  const patterns = new Map();
  for (const element of snapshot.elements) {
    if (!element.visible) continue;
    const match = element.testId.match(/^cardinality:([^:]+):([a-z0-9-]+)$/i);
    if (!match) continue;
    const values = patterns.get(match[1]) || [];
    values.push(match[2]);
    patterns.set(match[1], values);
  }
  return patterns;
}

function run(snapshot, context) {
  const expectations = context.cardinalityExpectations || [];
  if (expectations.length === 0) {
    return {
      pass: false,
      notRun: true,
      failures: ['cardinality contract is absent'],
      report: { missingContract: true, comparisons: [] },
    };
  }
  const actual = renderedPatterns(snapshot);
  const missingTestIds = expectations
    .filter((expectation) => !actual.has(expectation.element))
    .map((expectation) => `cardinality:${expectation.element}:<pattern>`);
  if (missingTestIds.length > 0) {
    return {
      pass: false,
      notRun: true,
      failures: [`required cardinality testID is absent: ${missingTestIds.join(', ')}`],
      report: { missingContract: false, missingTestIds, comparisons: [] },
    };
  }
  const failures = [];
  const comparisons = [];
  for (const expectation of expectations) {
    const expectedPattern = patternFor(expectation.element, expectation.count);
    const rendered = actual.get(expectation.element) || [];
    comparisons.push({
      element: expectation.element,
      count: expectation.count,
      expected: expectedPattern,
      declared: expectation.declaredPattern,
      actual: rendered,
      source: expectation.source,
    });
    if (!expectedPattern) failures.push(`${expectation.element} has no cardinality threshold`);
    if (expectation.declaredPattern !== expectedPattern && !expectation.overrideReason) {
      failures.push(`${expectation.element} declares ${expectation.declaredPattern}, expected ${expectedPattern} for N=${expectation.count}`);
    }
    if (rendered.length !== 1 || rendered[0] !== (expectation.overrideReason ? expectation.declaredPattern : expectedPattern)) {
      failures.push(`${expectation.element} rendered ${rendered.join(', ') || 'nothing'}, expected ${expectation.overrideReason ? expectation.declaredPattern : expectedPattern}`);
    }
  }
  return {
    pass: failures.length === 0,
    failures,
    reportOnly: failures.length === 0,
    report: { missingContract: false, comparisons },
  };
}

module.exports = { patternFor, renderedPatterns, run };
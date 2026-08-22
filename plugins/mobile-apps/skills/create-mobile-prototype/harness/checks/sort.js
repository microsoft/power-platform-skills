'use strict';

function run(snapshot, context) {
  const options = context.sortOptions || [];
  if (options.length <= 1) return { pass: true, failures: [], reportOnly: true, report: { applicable: false } };
  const failures = [];
  const expectedPattern = options.length <= 3 ? 'inline-chips' : 'sheet';
  const root = snapshot.elements.find((element) => element.visible && element.testId === `sort-control:${expectedPattern}`);
  if (!root) failures.push(`sort renders no sort-control:${expectedPattern} for ${options.length} options`);

  const activeElements = snapshot.elements.filter((element) => element.visible && element.testId.startsWith('sort-active:'));
  if (activeElements.length !== 1) failures.push(`sort must expose exactly one visible active option; found ${activeElements.length}`);
  const active = activeElements[0];
  if (active) {
    const match = active.testId.match(/^sort-active:([^:]+):(asc|desc)$/);
    const option = match && options.find((candidate) => candidate.field === match[1] && candidate.direction === match[2]);
    if (!option) failures.push(`active sort ${active.testId} is absent from the plan`);
    else if (!String(active.text || '').toLowerCase().includes(option.label.toLowerCase())) {
      failures.push(`active sort must visibly name ${option.label}`);
    }
  }

  const results = snapshot.elements.find((element) => element.testId === 'sort-results');
  if (!results || results.attributes?.['data-sort-reset'] !== 'top') {
    failures.push('sort-results must declare data-sort-reset="top"');
  }
  return {
    pass: failures.length === 0,
    failures,
    reportOnly: failures.length === 0,
    report: { applicable: true, optionCount: options.length, expectedPattern, active: active?.testId || null },
  };
}

module.exports = { run };
'use strict';

function run(snapshot, context) {
  const actions = context.batchActions || [];
  if (actions.length === 0) return { pass: true, failures: [], reportOnly: true, report: { applicable: false } };
  const failures = [];
  const visible = snapshot.elements.filter((element) => element.visible);
  const mode = visible.find((element) => element.testId === 'selection-mode:active');
  if (!mode) return { pass: false, failures: ['batch contract has no active selection mode'] };
  const entry = mode.attributes?.['data-selection-entry'];
  if (!['long-press', 'select', 'long-press-or-select'].includes(entry)) failures.push('selection mode must declare long-press or visible Select entry');
  if (mode.attributes?.['data-selection-exit-restores'] !== 'primary') failures.push('selection exit must restore the primary bar');

  const countElement = visible.find((element) => element.testId === 'selection-count');
  const count = Number.parseInt(String(countElement?.text || ''), 10);
  if (!countElement || !Number.isInteger(count) || count < 1 || !/selected/i.test(countElement.text)) failures.push('selection mode must show a positive selected count');
  for (const testId of ['selection-select-all', 'selection-exit']) {
    if (!visible.some((element) => element.testId === testId && element.interactive)) failures.push(`${testId} must be interactive`);
  }

  if (visible.filter((element) => element.testId === 'pinned:batch-actions').length !== 1) failures.push('selection mode requires exactly one pinned:batch-actions');
  if (visible.some((element) => element.testId === 'pinned:primary-actions' || element.testId === 'cta-primary')) failures.push('batch bar must replace, not stack with, the normal primary CTA');
  const pattern = actions.length <= 3 ? 'batch-actions:buttons' : 'batch-actions:primary-overflow';
  if (!visible.some((element) => element.testId === pattern)) failures.push(`batch actions must render ${pattern}`);
  if (actions.length > 3 && !visible.some((element) => element.testId === 'batch-overflow' && element.interactive)) failures.push('4+ batch actions require an interactive overflow');

  const expectedVisible = actions.length <= 3 ? actions : actions.slice(0, 1);
  for (const action of expectedVisible) {
    const testId = action.destructive ? `batch-destructive:${action.key}` : `batch-action:${action.key}`;
    const rendered = visible.find((element) => element.testId === testId && element.interactive);
    if (!rendered) failures.push(`batch action ${action.key} is missing`);
    if (action.destructive && rendered && !String(rendered.ariaLabel || rendered.text).includes(String(count))) {
      failures.push(`destructive batch action ${action.key} must name selected count ${count}`);
    }
  }
  return {
    pass: failures.length === 0,
    failures,
    reportOnly: failures.length === 0,
    report: { applicable: true, selectedCount: count, actionCount: actions.length, pattern },
  };
}

module.exports = { run };
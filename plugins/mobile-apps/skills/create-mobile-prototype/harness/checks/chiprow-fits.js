'use strict';

function run(snapshot) {
  const elements = snapshot.elements.filter((element) => element.visible);
  const rows = elements.filter((element) => /^chip-row:/.test(element.testId));
  const chips = elements.filter((element) => /^chip:/.test(element.testId));
  if (rows.length === 0 && chips.length === 0) return { pass: true, failures: [], report: { applicable: false } };
  if (rows.length === 0) return { pass: false, notRun: true, failures: ['chip elements exist without a chip-row:<key> root'] };
  const failures = [];
  for (const row of rows) {
    const overflow = Number(row.scrollWidth || 0) - Number(row.clientWidth || row.rect?.width || 0);
    const wraps = row.style?.flexWrap === 'wrap';
    const scrolls = ['auto', 'scroll'].includes(row.style?.overflowX);
    if (overflow > 0.5 && !wraps && !scrolls) failures.push(`${row.testId} overflows horizontally by ${overflow.toFixed(1)}px without wrap or scroll`);
  }
  for (const chip of chips) {
    if (chip.visibleRect && chip.rect && chip.visibleRect.width + 0.5 < chip.rect.width) failures.push(`${chip.testId} is clipped from ${chip.rect.width}px to ${chip.visibleRect.width}px`);
  }
  return { pass: failures.length === 0, failures, report: { applicable: true, rows: rows.length, chips: chips.length } };
}

module.exports = { run };
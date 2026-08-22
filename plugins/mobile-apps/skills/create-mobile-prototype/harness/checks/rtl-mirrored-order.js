'use strict';

function rtlLocale(locale) {
  return /^(?:ar|fa|he|ur)(?:-|$)/i.test(String(locale || ''));
}

function run(snapshot, context) {
  const rtl = rtlLocale(context.locale || snapshot.locale);
  const rows = snapshot.elements.filter((element) => element.visible && /^mirror-row:/.test(element.testId));
  if (rows.length === 0) return { pass: true, failures: [], report: { applicable: false, rtl } };
  const failures = [];
  if (rtl && snapshot.direction !== 'rtl') failures.push(`document direction ${snapshot.direction || 'missing'}, expected rtl for ${context.locale}`);
  for (const row of rows) {
    const children = snapshot.elements.filter((element) => element.visible && element.parentId === row.id && /^\d+$/.test(element.attributes?.['data-logical-order'] || ''))
      .sort((left, right) => Number(left.attributes['data-logical-order']) - Number(right.attributes['data-logical-order']));
    if (children.length < 2) {
      failures.push(`${row.testId} requires at least two data-logical-order children`);
      continue;
    }
    const centers = children.map((child) => Number(child.rect.left) + Number(child.rect.width) / 2);
    const ordered = centers.every((center, index) => index === 0 || (rtl ? centers[index - 1] > center : centers[index - 1] < center));
    if (!ordered) failures.push(`${row.testId} logical order ${children.map((child) => child.attributes['data-logical-order']).join(',')} renders at x=${centers.join(',')}, expected ${rtl ? 'right-to-left' : 'left-to-right'}`);
  }
  return { pass: failures.length === 0, failures, report: { applicable: true, rtl, rows: rows.length } };
}

module.exports = { rtlLocale, run };
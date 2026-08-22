'use strict';

function run(snapshot) {
  const grouped = new Map();
  for (const element of snapshot.elements.filter((candidate) => candidate.visible)) {
    const group = element.attributes?.['data-wrap-group'];
    if (!group) continue;
    const values = grouped.get(group) || [];
    values.push({ testId: element.testId, wrap: element.style?.flexWrap || 'nowrap' });
    grouped.set(group, values);
  }
  const failures = [];
  for (const [group, rows] of grouped) {
    const modes = [...new Set(rows.map((row) => row.wrap))];
    if (modes.length > 1) failures.push(`wrap group ${group} mixes ${modes.join(' and ')}`);
  }
  return { pass: failures.length === 0, failures, report: { applicable: grouped.size > 0, groups: grouped.size } };
}

module.exports = { run };
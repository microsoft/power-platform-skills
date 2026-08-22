'use strict';

function primaryAncestor(element, byId) {
  let current = element;
  while (current) {
    if (current.testId === 'hero' || current.testId === 'cta-primary' || current.testId.startsWith('row:')) return current;
    if (current.testId === 'row-meta') return null;
    current = current.parentId === null ? null : byId.get(current.parentId);
  }
  return null;
}

function run(snapshot) {
  const byId = new Map(snapshot.elements.map((element) => [element.id, element]));
  const failures = [];
  for (const element of snapshot.elements) {
    if (!element.visible || !element.text.trim() || !primaryAncestor(element, byId)) continue;
    const ellipsized = element.style.textOverflow === 'ellipsis';
    const clamped = Number.parseInt(element.style.webkitLineClamp, 10) > 0;
    const horizontalOverflow = element.scrollWidth > element.clientWidth + 1;
    const verticalOverflow = element.scrollHeight > element.clientHeight + 1;
    const clippedSingleLine = element.style.whiteSpace === 'nowrap' && horizontalOverflow;
    if (ellipsized || clamped || clippedSingleLine || verticalOverflow) {
      failures.push(`${element.testId || element.tag} truncates primary label ${JSON.stringify(element.text)}`);
    }
  }
  return { pass: failures.length === 0, failures };
}

module.exports = { primaryAncestor, run };
'use strict';

function intersects(left, right) {
  const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
  const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
  return width > 0.5 && height > 0.5;
}

function contains(outer, inner) {
  return outer.left <= inner.left + 0.5
    && outer.top <= inner.top + 0.5
    && outer.right >= inner.right - 0.5
    && outer.bottom >= inner.bottom - 0.5;
}

function hasAncestor(element, ancestorId, byId) {
  let current = element;
  while (current && current.parentId !== null) {
    if (current.parentId === ancestorId) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

function label(element) {
  return element.testId || element.ariaLabel || element.text || `${element.tag}#${element.id}`;
}

function run(snapshot) {
  const interactive = snapshot.elements.filter((element) => element.visible && element.interactive);
  const byId = new Map(snapshot.elements.map((element) => [element.id, element]));
  const failures = [];
  for (let leftIndex = 0; leftIndex < interactive.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < interactive.length; rightIndex += 1) {
      const left = interactive[leftIndex];
      const right = interactive[rightIndex];
      const leftRect = left.visibleRect || left.rect;
      const rightRect = right.visibleRect || right.rect;
      if (!intersects(leftRect, rightRect)) continue;
      const nested = hasAncestor(right, left.id, byId) || hasAncestor(left, right.id, byId);
      if (nested && (contains(leftRect, rightRect) || contains(rightRect, leftRect))) continue;
      failures.push(`${JSON.stringify(label(left))} overlaps ${JSON.stringify(label(right))}`);
    }
  }
  return { pass: failures.length === 0, failures };
}

module.exports = { contains, intersects, run };
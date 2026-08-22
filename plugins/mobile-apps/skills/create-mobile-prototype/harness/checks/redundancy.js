'use strict';

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function run(snapshot) {
  const visible = snapshot.elements.filter((element) => element.visible);
  const byId = new Map(visible.map((element) => [element.id, element]));
  const rowAncestor = (element) => {
    let current = element;
    while (current && current.parentId != null) {
      current = byId.get(current.parentId);
      if (current?.testId?.startsWith('row:')) return current.id;
    }
    return null;
  };
  const groups = new Map();
  for (const element of visible) {
    const text = normalize(element.text);
    if (text.length < 4 || /^[-+]?\d+(?:[.,]\d+)?$/.test(text)) continue;
    const list = groups.get(text) || [];
    list.push(element);
    groups.set(text, list);
  }
  const failures = [];
  for (const [text, elements] of groups) {
    for (let left = 0; left < elements.length; left += 1) {
      for (let right = left + 1; right < elements.length; right += 1) {
        const firstRow = rowAncestor(elements[left]);
        const secondRow = rowAncestor(elements[right]);
        if (firstRow != null && secondRow != null && firstRow !== secondRow) continue;
        const distance = Math.abs(Number(elements[left].rect?.top || 0) - Number(elements[right].rect?.top || 0));
        if (distance <= 96) failures.push(`${JSON.stringify(text)} repeats within ${distance}px in one content region`);
      }
    }
  }
  return { pass: failures.length === 0, failures, report: { duplicateCount: failures.length } };
}

module.exports = { normalize, run };
'use strict';

function number(value) {
  const parsed = Number.parseFloat(String(value || '0'));
  return Number.isFinite(parsed) ? parsed : 0;
}

const LINE_BUDGET = {
  hero: 2,
  'row:title': 1,
  pill: 1,
};

function budgetFor(element, foldHeight) {
  if (Object.hasOwn(LINE_BUDGET, element.testId)) return LINE_BUDGET[element.testId];
  if (element.testId.startsWith('row:title')) return LINE_BUDGET['row:title'];
  if (element.testId.startsWith('pill:') || element.role === 'status') return LINE_BUDGET.pill;
  return number(element.rect.top) < foldHeight * 0.5 ? 3 : 4;
}

function run(snapshot, context = {}) {
  const visible = snapshot.elements.filter((element) => element.visible);
  const byId = new Map(visible.map((element) => [element.id, element]));
  const foldHeight = number(context.foldHeight) || number(snapshot.viewport?.height) || 844;
  const failures = [];

  for (const element of visible) {
    const parent = byId.get(element.parentId);
    if (parent && number(element.rect.width) > 0 && number(parent.rect.width) > 0) {
      const horizontallyScrollable = ['auto', 'scroll'].includes(parent.style.overflowX)
        || number(parent.scrollWidth) > number(parent.clientWidth) + 1;
      const rightOverhang = number(element.rect.right || (element.rect.x + element.rect.width))
        - number(parent.rect.right || (parent.rect.x + parent.rect.width));
      const leftOverhang = number(parent.rect.left ?? parent.rect.x) - number(element.rect.left ?? element.rect.x);
      const overhang = Math.max(rightOverhang, leftOverhang);
      if (overhang > 1 && !horizontallyScrollable) {
        failures.push(`${element.testId || element.tag} overflows ${parent.testId || parent.tag} by ${overhang.toFixed(0)}px`);
      }
    }

    const text = String(element.text || '').trim();
    if (!text) continue;
    const lineHeight = number(element.style.lineHeight) || number(element.style.fontSize) * 1.2;
    if (lineHeight <= 0 || number(element.rect.height) <= 0) continue;
    const lines = Math.max(1, Math.round(number(element.rect.height) / lineHeight));
    const budget = budgetFor(element, foldHeight);
    if (lines > budget) {
      failures.push(`${element.testId || element.tag} wraps to ${lines} lines (budget ${budget}): ${JSON.stringify(text.slice(0, 40))}`);
    }
  }
  return { pass: failures.length === 0, failures };
}

module.exports = { LINE_BUDGET, budgetFor, run };
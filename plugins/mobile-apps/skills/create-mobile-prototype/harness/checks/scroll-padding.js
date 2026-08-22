'use strict';

function number(value) {
  const parsed = Number.parseFloat(String(value || '0'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function run(snapshot, context) {
  const visible = snapshot.elements.filter((element) => element.visible);
  const pinned = visible.filter((element) => element.testId.startsWith('pinned:'));
  if (pinned.length === 0) return { pass: true, failures: [] };
  const requiredPadding = pinned.reduce((total, element) => total + element.rect.height, 0) + context.safeAreaBottom;
  const byParent = new Map();
  for (const element of visible) {
    const children = byParent.get(element.parentId) || [];
    children.push(element);
    byParent.set(element.parentId, children);
  }
  const scrolls = visible.filter((element) => (
    element.testId.startsWith('scroll:') || ['auto', 'scroll'].includes(element.style.overflowY)
  ));
  if (scrolls.length === 0) {
    return { pass: false, failures: [`pinned layers require a scroll container with at least ${requiredPadding}px bottom padding`] };
  }
  const failures = [];
  for (const scroll of scrolls) {
    const candidates = [scroll, ...(byParent.get(scroll.id) || [])];
    const actualPadding = Math.max(...candidates.map((element) => number(element.style.paddingBottom)));
    if (actualPadding + 0.5 < requiredPadding) {
      failures.push(`${scroll.testId || scroll.tag} bottom padding ${actualPadding}px is below pinned + safe-area requirement ${requiredPadding}px`);
    }
  }
  return { pass: failures.length === 0, failures };
}

module.exports = { run };
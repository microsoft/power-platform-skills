'use strict';

function number(value) {
  const parsed = Number.parseFloat(String(value || '0'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function notRun(reason) {
  return { pass: false, notRun: true, failures: [reason] };
}

function insideScroll(element, byId) {
  let current = byId.get(element.parentId);
  while (current) {
    if (current.testId.startsWith('scroll:') || ['auto', 'scroll'].includes(current.style.overflowY)) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

function structurallyPinned(element, snapshot, byId) {
  if (insideScroll(element, byId) || !element.rect?.height) return false;
  const viewportHeight = snapshot.viewport?.height || 0;
  const nearBottom = viewportHeight > 0
    && Math.abs(element.rect.bottom - viewportHeight) <= 8
    && element.rect.height <= Math.min(200, viewportHeight * 0.4);
  const positioned = ['absolute', 'fixed'].includes(element.style.position);
  const bottom = Number.parseFloat(element.style.bottom);
  const bottomBand = viewportHeight > 0 && element.rect.height <= Math.min(200, viewportHeight * 0.4);
  return nearBottom || (positioned && bottomBand && Number.isFinite(bottom));
}

function run(snapshot, context) {
  const visible = snapshot.elements.filter((element) => element.visible);
  const byId = new Map(visible.map((element) => [element.id, element]));
  const rawPinned = visible.filter((element) => element.testId.startsWith('pinned:') || structurallyPinned(element, snapshot, byId));
  const pinnedIds = new Set(rawPinned.map((element) => element.id));
  const pinned = rawPinned.filter((element) => {
    let parent = byId.get(element.parentId);
    while (parent) {
      if (pinnedIds.has(parent.id)) return false;
      parent = byId.get(parent.parentId);
    }
    return true;
  });
  if (pinned.length === 0) return { pass: true, failures: [], note: 'no pinned layer found' };
  const requiredPadding = pinned.reduce((total, element) => total + element.rect.height, 0) + context.safeAreaBottom;
  const byParent = new Map();
  for (const element of visible) {
    const children = byParent.get(element.parentId) || [];
    children.push(element);
    byParent.set(element.parentId, children);
  }
  const scrolls = visible.filter((element) => element.testId.startsWith('scroll:'));
  if (scrolls.length === 0) return notRun('required scroll:<screen> testID is absent');
  const failures = pinned
    .filter((element) => !element.testId.startsWith('pinned:'))
    .map((element) => `bottom-anchored ${element.tag || 'layer'} is missing required pinned:<layer> testID`);
  for (const scroll of scrolls) {
    const candidates = [scroll, ...(byParent.get(scroll.id) || [])];
    const actualPadding = Math.max(...candidates.map((element) => number(element.style.paddingBottom)));
    if (actualPadding + 0.5 < requiredPadding) {
      failures.push(`${scroll.testId || scroll.tag} bottom padding ${actualPadding}px is below pinned + safe-area requirement ${requiredPadding}px`);
    }
  }
  return { pass: failures.length === 0, failures };
}

module.exports = { insideScroll, run, structurallyPinned };
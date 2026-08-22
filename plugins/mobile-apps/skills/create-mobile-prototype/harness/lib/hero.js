'use strict';

function heroRoot(snapshot, context) {
  if (!context.heroContract) return null;
  return snapshot.elements.find((element) => element.visible && element.testId === `hero:${context.heroContract.key}`) || null;
}

function descendants(root, elements) {
  const byParent = new Map();
  for (const element of elements) {
    const children = byParent.get(element.parentId) || [];
    children.push(element);
    byParent.set(element.parentId, children);
  }
  const output = [];
  const queue = [...(byParent.get(root.id) || [])];
  while (queue.length > 0) {
    const child = queue.shift(); output.push(child); queue.push(...(byParent.get(child.id) || []));
  }
  return output;
}

module.exports = { descendants, heroRoot };
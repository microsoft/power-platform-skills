'use strict';

function run(snapshot, context) {
  const contract = context.carouselContract;
  const roots = snapshot.elements.filter((element) => element.visible && /^carousel:[^:]+:carousel-row$/.test(element.testId));
  if (!contract) {
    if (roots.length > 0) return { pass: false, failures: ['screen renders a carousel without an approved Carousel contract'] };
    return { pass: true, failures: [], reportOnly: true, report: { applicable: false } };
  }
  const failures = [];
  if (contract.queue) failures.push('working queues must not use carousel-row');
  if (contract.items < 3) failures.push(`carousel requires at least 3 items; planned ${contract.items}`);
  const root = roots.find((element) => element.testId === `carousel:${contract.entity}:carousel-row`);
  if (!root) failures.push(`missing carousel:${contract.entity}:carousel-row`);
  if (root) {
    if (!(root.scrollWidth > root.clientWidth)) failures.push(`carousel content width ${root.scrollWidth} must exceed viewport width ${root.clientWidth}`);
    if (root.attributes?.['data-carousel-snap'] !== 'start') failures.push('carousel must snap to item start');
    if (root.attributes?.['data-auto-advance'] !== 'false') failures.push('carousel auto-advance must be false');
    if (root.attributes?.['data-preserve-position'] !== 'true') failures.push('carousel must preserve position on return');
  }
  const items = snapshot.elements.filter((element) => element.testId.startsWith('carousel-item:'));
  if (items.length < 3) failures.push(`carousel renders ${items.length} items; minimum is 3`);
  items.forEach((item, index) => {
    if (item.ariaLabel !== `${index + 1} of ${contract.items}`) failures.push(`${item.testId} must announce ${index + 1} of ${contract.items}`);
  });
  return {
    pass: failures.length === 0,
    failures,
    reportOnly: failures.length === 0,
    report: { applicable: true, entity: contract.entity, field: contract.field, itemCount: items.length, contentWidth: root?.scrollWidth, viewportWidth: root?.clientWidth },
  };
}

module.exports = { run };
'use strict';
const { heroRoot } = require('../lib/hero');
const key = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
function run(snapshot, context) {
  if (!context.heroContract) return { pass: true, failures: [], reportOnly: true, report: { applicable: false } };
  const hero = heroRoot(snapshot, context);
  if (!hero) return { pass: false, failures: [`missing hero:${context.heroContract.key}`] };
  const page = snapshot.elements.find((element) => element.visible && element.testId.startsWith('screen:'));
  const heroColor = key(hero.style.ownBackgroundColor);
  const pageColor = key(page?.style.ownBackgroundColor || page?.style.backgroundColor);
  const failures = !heroColor || !pageColor || heroColor === pageColor ? ['hero ground must differ from page background'] : [];
  return { pass: failures.length === 0, failures };
}
module.exports = { run };
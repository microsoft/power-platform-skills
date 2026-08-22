'use strict';
const { descendants, heroRoot } = require('../lib/hero');
function run(snapshot, context) {
  if (!context.heroContract) return { pass: true, failures: [], reportOnly: true, report: { applicable: false } };
  const hero = heroRoot(snapshot, context);
  if (!hero) return { pass: false, failures: [`missing hero:${context.heroContract.key}`] };
  const crossing = descendants(hero, snapshot.elements).some((element) => element.visible && element.rect.top < hero.rect.bottom && element.rect.bottom > hero.rect.bottom);
  return crossing ? { pass: true, failures: [] } : { pass: false, failures: ['hero requires a nested element crossing its boundary'] };
}
module.exports = { run };
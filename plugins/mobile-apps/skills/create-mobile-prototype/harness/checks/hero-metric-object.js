'use strict';
const { descendants, heroRoot } = require('../lib/hero');
function run(snapshot, context) {
  if (!context.heroContract) return { pass: true, failures: [], reportOnly: true, report: { applicable: false } };
  const hero = heroRoot(snapshot, context);
  if (!hero) return { pass: false, failures: [`missing hero:${context.heroContract.key}`] };
  const metric = descendants(hero, snapshot.elements).find((element) => element.visible && /\d/.test(element.text) && Number.parseFloat(element.style.fontSize) >= 32);
  return metric ? { pass: true, failures: [] } : { pass: false, failures: ['hero requires a numeric metric object at 32px or larger'] };
}
module.exports = { run };
'use strict';
const { descendants, heroRoot } = require('../lib/hero');
function run(snapshot, context) {
  if (!context.heroContract || context.heroContract.key !== 'media-hero') return { pass: true, failures: [], reportOnly: true, report: { applicable: false } };
  const hero = heroRoot(snapshot, context);
  if (!hero) return { pass: false, failures: ['missing hero:media-hero'] };
  const images = descendants(hero, snapshot.elements).filter((element) => element.tag === 'img' && element.src);
  const seeds = new Set(context.seedTexts || []);
  const invalid = images.filter((image) => !seeds.has(image.src));
  if (images.length === 0) return { pass: false, failures: ['media-hero requires a record image'] };
  return invalid.length === 0 ? { pass: true, failures: [] } : { pass: false, failures: [`hero image source is absent from seed data: ${invalid[0].src}`] };
}
module.exports = { run };
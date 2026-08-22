'use strict';

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function run(snapshot, context) {
  const visible = snapshot.elements.filter((element) => element.visible);
  const dataBacked = visible.some((element) => element.testId === 'hero' || element.testId.startsWith('row:'));
  if (!dataBacked) return { pass: true, failures: [] };
  const candidates = visible
    .filter((element) => String(element.text || '').trim() && Number.parseFloat(element.style.fontSize) > 0)
    .map((element) => ({
      element,
      fontSize: Number.parseFloat(element.style.fontSize),
      area: element.rect.width * element.rect.height,
    }))
    .sort((left, right) => right.fontSize - left.fontSize || right.area - left.area);
  if (candidates.length === 0) return { pass: false, failures: ['data-backed screen has no measurable visible text'] };
  const oracle = new Set(context.seedTexts.map(normalize).filter(Boolean));
  const seedBacked = candidates.find(({ element }) => oracle.has(normalize(element.text)));
  if (seedBacked) return { pass: true, failures: [] };
  const largest = candidates[0].element.text;
  return {
    pass: false,
    failures: [`no visible text is backed by generated seed data; largest visible text is ${JSON.stringify(largest)}`],
  };
}

module.exports = { normalize, run };
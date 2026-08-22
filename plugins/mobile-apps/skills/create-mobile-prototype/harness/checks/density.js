'use strict';

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function run(snapshot, context) {
  const oracle = new Set(context.seedTexts.map(normalize).filter(Boolean));
  const firstViewport = snapshot.elements.filter((element) => (
    element.visible
    && element.rect.bottom > 0
    && element.rect.top < snapshot.viewport.height
  ));
  const matches = firstViewport.filter((element) => (
    String(element.text || '').trim() && oracle.has(normalize(element.text))
  ));
  const rows = firstViewport.filter((element) => element.testId.startsWith('row:'));
  const metadata = context.screenMeta || {};
  const classificationText = `${metadata.Screen || ''} ${metadata.Archetype || ''} ${metadata.Purpose || ''}`;
  const listQueue = /\blist\b|\bqueue\b/i.test(classificationText) || rows.length >= 2;
  const dataBacked = matches.length > 0 || rows.length > 0 || firstViewport.some((element) => element.testId === 'hero');
  const floor = listQueue ? 35 : dataBacked ? 8 : 0;
  return {
    pass: true,
    failures: [],
    reportOnly: true,
    report: {
      observed: matches.length,
      floor,
      classification: listQueue ? 'list-queue' : dataBacked ? 'data-backed' : 'non-data',
      wouldMeetFloor: matches.length >= floor,
    },
  };
}

module.exports = { normalize, run };
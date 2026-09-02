'use strict';

const crypto = require('node:crypto');

const { compileScreenBuildPack } = require('../../compile-screen-build-pack');
const { compileScenarioFacts } = require('../../validate-fixture-scenarios');

function stableId(prefix, value) {
  const slug = String(value || prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36) || prefix;
  const hash = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
  return `${prefix}-${slug}-${hash}`;
}

function scenarioInputForBundle(bundle, compiled) {
  const records = new Map();
  const mediaAssets = new Map();
  const scenarioByJourney = new Map((bundle.journey.journeys || []).map((journey) => [
    journey.id,
    {
      id: `${journey.id}-facts`,
      name: `${journey.name} fixture`,
      journeyId: journey.id,
      kind: 'happy-path',
      recordIds: [],
    },
  ]));
  const firstScenario = scenarioByJourney.values().next().value;
  const screenBindings = [];

  const addRecord = (record) => {
    if (!records.has(record.id)) records.set(record.id, record);
    return record.id;
  };
  const addToScenario = (scenario, recordId) => {
    if (!scenario.recordIds.includes(recordId)) scenario.recordIds.push(recordId);
  };

  for (const screen of compiled.screens) {
    const pack = screen.pack;
    const journey = (bundle.journey.journeys || []).find((candidate) => (
      (candidate.steps || []).some((step) => step.surface?.screenId === screen.screenId)
    ));
    const scenario = scenarioByJourney.get(journey?.id) || firstScenario;
    const factsRecordId = addRecord({
      id: `${screen.screenId}-screen-facts`,
      conceptId: 'screen-presentation',
      fields: {
        headline: pack.previewContent.headline,
        supportingText: pack.previewContent.supportingText,
        ...(pack.previewContent.heroMediaLabel
          ? { heroMediaLabel: pack.previewContent.heroMediaLabel }
          : {}),
        ...Object.fromEntries((pack.previewContent.metrics || []).map(
          (item, index) => [`metric${index}`, item.value],
        )),
        ...Object.fromEntries((pack.previewContent.fields || []).map(
          (item, index) => [`field${index}`, item.value],
        )),
        ...Object.fromEntries((pack.previewContent.summaryRows || []).map(
          (item, index) => [`summary${index}`, item.value],
        )),
      },
    });
    addToScenario(scenario, factsRecordId);

    const recordIds = [factsRecordId];
    const previewRecords = (pack.previewContent.records || []).map((item) => {
      const recordId = stableId('record', item.title);
      addRecord({
        id: recordId,
        conceptId: 'preview-record',
        fields: {
          title: item.title,
          subtitle: item.subtitle,
          meta: item.meta || '',
          badge: item.badge || '',
        },
      });
      addToScenario(scenario, recordId);
      if (!recordIds.includes(recordId)) recordIds.push(recordId);
      let mediaAssetKey;
      if (item.mediaLabel) {
        mediaAssetKey = stableId('media', item.mediaLabel);
        mediaAssets.set(mediaAssetKey, {
          key: mediaAssetKey,
          source: { kind: 'generated', value: item.mediaLabel },
          fallback: item.mediaLabel,
          aspectRatio: 1.5,
          fit: 'cover',
          focalPoint: 'center',
        });
      }
      return {
        recordId,
        titleField: 'title',
        subtitleFields: ['subtitle'],
        metaField: 'meta',
        badgeField: 'badge',
        ...(mediaAssetKey ? { mediaAssetKey } : {}),
      };
    });

    const mediaAssetKeys = [];
    if (pack.media?.role && pack.media.role !== 'none') {
      const declaredBinding = pack.media.assetKeyOrFieldBinding || `asset:${screen.screenId}-media`;
      const key = declaredBinding.startsWith('asset:')
        ? declaredBinding.slice('asset:'.length)
        : `${screen.screenId}-media`;
      mediaAssets.set(key, {
        key,
        source: {
          kind: 'generated',
          value: pack.previewContent.heroMediaLabel || pack.media.fallback,
        },
        fallback: pack.media.fallback,
        aspectRatio: 1.5,
        fit: 'cover',
        focalPoint: 'center',
      });
      mediaAssetKeys.push(key);
    }
    for (const record of previewRecords) {
      if (record.mediaAssetKey && !mediaAssetKeys.includes(record.mediaAssetKey)) {
        mediaAssetKeys.push(record.mediaAssetKey);
      }
    }

    screenBindings.push({
      screenId: screen.screenId,
      scenarioId: scenario.id,
      recordIds,
      mediaAssetKeys,
      preview: {
        headline: { recordId: factsRecordId, field: 'headline' },
        supportingText: { recordId: factsRecordId, field: 'supportingText' },
        records: previewRecords,
        metrics: (pack.previewContent.metrics || []).map((item, index) => ({
          label: item.label,
          value: { recordId: factsRecordId, field: `metric${index}` },
        })),
        fields: (pack.previewContent.fields || []).map((item, index) => ({
          label: item.label,
          value: { recordId: factsRecordId, field: `field${index}` },
        })),
        summaryRows: (pack.previewContent.summaryRows || []).map((item, index) => ({
          label: item.label,
          value: { recordId: factsRecordId, field: `summary${index}` },
        })),
      },
    });
  }

  return {
    schemaVersion: 1,
    records: [...records.values()],
    relationships: [],
    scenarios: [...scenarioByJourney.values()],
    mediaAssets: [...mediaAssets.values()],
    screenBindings,
    invariants: [],
  };
}

function scenarioFactsForBundle(bundle, bindings = {}) {
  const buildResult = compileScreenBuildPack(bundle.buildPack, bundle);
  if (!buildResult.ok) throw new Error(JSON.stringify(buildResult.errors));
  const source = { ...bundle, compiled: buildResult.compiled, ...bindings };
  const result = compileScenarioFacts(
    scenarioInputForBundle(bundle, buildResult.compiled),
    source,
  );
  if (result.errors.length > 0) throw new Error(JSON.stringify(result.errors));
  return { compiled: buildResult.compiled, scenario: result.compiled };
}

module.exports = {
  scenarioFactsForBundle,
  scenarioInputForBundle,
};

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { revision } = require('../lib/prototype-files');
const { sampleImageAsset } = require('./helpers/prototype-image-fixtures');

const {
  compileScenarioFacts,
  projectScreenFacts,
  validateScenarioFacts,
} = require('../validate-fixture-scenarios');

function source() {
  const scope = {
    screens: [
      { id: 'home', jobIds: ['maintain-equipment'] },
      { id: 'equipment', jobIds: ['maintain-equipment'] },
      { id: 'complete', jobIds: ['maintain-equipment'] },
    ],
  };
  const journey = {
    journeys: [{
      id: 'maintenance-journey',
      jobId: 'maintain-equipment',
      steps: [
        { id: 'open-equipment', order: 1, surface: { screenId: 'home' } },
        { id: 'inspect-equipment', order: 2, surface: { screenId: 'equipment' } },
        { id: 'close-work', order: 3, surface: { screenId: 'complete' } },
      ],
    }],
  };
  const compiled = {
    compiledRevision: 'a'.repeat(64),
    screens: [
      { screenId: 'home', pack: { media: { role: 'none' } } },
      {
        screenId: 'equipment',
        pack: {
          media: {
            role: 'supportive',
            assetKeyOrFieldBinding: 'asset:equipment-tm-014-photo',
            fallback: 'Equipment identity placeholder',
          },
        },
      },
      { screenId: 'complete', pack: { media: { role: 'none' } } },
    ],
  };
  const input = {
    schemaVersion: 1,
    records: [
      {
        id: 'equipment-tm-014',
        conceptId: 'equipment',
        fields: {
          name: 'Treadmill',
          assetCode: 'TM-014',
          maintenanceStatus: 'scheduled',
          nextMaintenanceDate: '2026-09-12',
          completedChecks: 4,
          totalChecks: 6,
        },
      },
      {
        id: 'inspection-001',
        conceptId: 'inspection',
        fields: {
          equipmentId: 'equipment-tm-014',
          result: 'Attention required',
        },
      },
    ],
    relationships: [{
      id: 'inspection-equipment',
      fromRecordId: 'inspection-001',
      toRecordId: 'equipment-tm-014',
      kind: 'belongs-to',
    }],
    scenarios: [{
      id: 'minimum-complete-journey',
      name: 'Inspect and close one equipment item',
      journeyId: 'maintenance-journey',
      kind: 'happy-path',
      recordIds: ['equipment-tm-014', 'inspection-001'],
    }],
    mediaAssets: [{
      key: 'equipment-tm-014-photo',
      source: { kind: 'local', value: 'assets/fixtures/equipment-tm-014.jpg' },
      fallback: 'Equipment identity placeholder',
      aspectRatio: 1.5,
      fit: 'cover',
      focalPoint: 'center',
    }],
    screenBindings: [
      {
        screenId: 'home',
        scenarioId: 'minimum-complete-journey',
        recordIds: ['equipment-tm-014'],
        preview: {
          headline: { recordId: 'equipment-tm-014', field: 'name' },
          supportingText: { recordId: 'equipment-tm-014', field: 'maintenanceStatus' },
          records: [{
            recordId: 'equipment-tm-014',
            titleField: 'name',
            subtitleFields: ['assetCode'],
            metaField: 'nextMaintenanceDate',
          }],
        },
      },
      {
        screenId: 'equipment',
        scenarioId: 'minimum-complete-journey',
        recordIds: ['equipment-tm-014', 'inspection-001'],
        mediaAssetKeys: ['equipment-tm-014-photo'],
        preview: {
          headline: { recordId: 'equipment-tm-014', field: 'name' },
          supportingText: { recordId: 'equipment-tm-014', field: 'assetCode' },
          fields: [
            { label: 'Status', value: { recordId: 'equipment-tm-014', field: 'maintenanceStatus' } },
            { label: 'Inspection', value: { recordId: 'inspection-001', field: 'result' } },
          ],
        },
      },
      {
        screenId: 'complete',
        scenarioId: 'minimum-complete-journey',
        recordIds: ['equipment-tm-014'],
        preview: {
          headline: { recordId: 'equipment-tm-014', field: 'name' },
          supportingText: { recordId: 'equipment-tm-014', field: 'maintenanceStatus' },
        },
      },
    ],
    invariants: [
      {
        id: 'unscheduled-has-no-date',
        operator: 'field-absent-when-equals',
        recordId: 'equipment-tm-014',
        field: 'maintenanceStatus',
        equals: 'unscheduled',
        forbiddenField: 'nextMaintenanceDate',
      },
      {
        id: 'completed-does-not-exceed-total',
        operator: 'field-lte-field',
        recordId: 'equipment-tm-014',
        leftField: 'completedChecks',
        rightField: 'totalChecks',
      },
      {
        id: 'inspection-parent-exists',
        operator: 'field-references-record',
        recordId: 'inspection-001',
        field: 'equipmentId',
      },
    ],
  };
  return { scope, journey, compiled, input };
}

test('canonical scenario facts compile deterministically and project preview values', () => {
  const fixture = source();
  const result = compileScenarioFacts(fixture.input, fixture);
  assert.deepEqual(result.errors, []);
  assert.match(result.compiled.scenarioRevision, /^[a-f0-9]{64}$/);
  const projection = projectScreenFacts(result.compiled, 'equipment');
  assert.equal(projection.headline, 'Treadmill');
  assert.equal(projection.supportingText, 'TM-014');
  assert.deepEqual(projection.fields, [
    { label: 'Status', value: 'scheduled' },
    { label: 'Inspection', value: 'Attention required' },
  ]);
  assert.equal(projection.media[0].key, 'equipment-tm-014-photo');
  assert.deepEqual(
    projection.referencedRecords.map((record) => record.id),
    ['equipment-tm-014', 'inspection-001'],
  );
  assert.deepEqual(
    projection.relationships.map((relationship) => relationship.id),
    ['inspection-equipment'],
  );
  assert.deepEqual(
    projection.invariants.map((invariant) => invariant.id),
    [
      'unscheduled-has-no-date',
      'completed-does-not-exceed-total',
      'inspection-parent-exists',
    ],
  );
  assert.equal(
    compileScenarioFacts(fixture.input, fixture).compiled.scenarioRevision,
    result.compiled.scenarioRevision,
  );
});

test('contradictory unscheduled records with future dates are rejected', () => {
  const fixture = source();
  fixture.input.records[0].fields.maintenanceStatus = 'unscheduled';
  const result = compileScenarioFacts(fixture.input, fixture);
  assert.ok(result.errors.some((item) => item.code === 'scenario-invariant-failed'));
});

test('completed values cannot exceed totals', () => {
  const fixture = source();
  fixture.input.records[0].fields.completedChecks = 7;
  assert.ok(compileScenarioFacts(fixture.input, fixture).errors.some(
    (item) => item.code === 'scenario-invariant-failed',
  ));
});

test('relationships, field references, screens, and scenarios reject missing IDs', () => {
  const fixture = source();
  fixture.input.relationships[0].toRecordId = 'missing-equipment';
  fixture.input.screenBindings[0].scenarioId = 'missing-scenario';
  fixture.input.screenBindings[1].screenId = 'missing-screen';
  const result = compileScenarioFacts(fixture.input, fixture);
  assert.ok(result.errors.some((item) => item.code === 'relationship-record-missing'));
  assert.ok(result.errors.some((item) => item.code === 'screen-binding-scenario-missing'));
  assert.ok(result.errors.some((item) => item.code === 'screen-binding-screen-missing'));
});

test('screen bindings may use only records owned by their selected scenario', () => {
  const fixture = source();
  fixture.input.scenarios[0].recordIds = ['equipment-tm-014'];
  const result = compileScenarioFacts(fixture.input, fixture);
  assert.ok(result.errors.some(
    (item) => item.code === 'screen-binding-record-outside-scenario',
  ));
});

test('preview values may reference only records declared by their screen binding', () => {
  const fixture = source();
  fixture.input.screenBindings[1].recordIds = ['equipment-tm-014'];
  const result = compileScenarioFacts(fixture.input, fixture);
  assert.ok(result.errors.some((item) => item.code === 'preview-record-not-bound'));
});

test('cross-screen identity stays consistent because bindings share record IDs', () => {
  const fixture = source();
  const compiled = compileScenarioFacts(fixture.input, fixture).compiled;
  assert.equal(projectScreenFacts(compiled, 'home').headline, 'Treadmill');
  assert.equal(projectScreenFacts(compiled, 'equipment').headline, 'Treadmill');
  assert.equal(projectScreenFacts(compiled, 'complete').headline, 'Treadmill');
});

test('media-required screens need a valid asset and fallback', () => {
  const fixture = source();
  fixture.input.screenBindings[1].mediaAssetKeys = [];
  let result = compileScenarioFacts(fixture.input, fixture);
  assert.ok(result.errors.some((item) => item.code === 'required-media-binding-missing'));
  fixture.input.screenBindings[1].mediaAssetKeys = ['missing-asset'];
  result = compileScenarioFacts(fixture.input, fixture);
  assert.ok(result.errors.some((item) => item.code === 'media-asset-missing'));
});

test('screen media bindings and scenario asset keys cannot drift', () => {
  const fixture = source();
  fixture.compiled.screens[1].pack.media.assetKeyOrFieldBinding = 'asset:other-photo';
  const result = compileScenarioFacts(fixture.input, fixture);
  assert.ok(result.errors.some((item) => item.code === 'screen-media-binding-mismatch'));
});

test('minimum complete journey needs bindings for entry, core action, and outcome', () => {
  const fixture = source();
  fixture.input.screenBindings = fixture.input.screenBindings.filter(
    (binding) => binding.screenId !== 'complete',
  );
  assert.ok(compileScenarioFacts(fixture.input, fixture).errors.some(
    (item) => item.code === 'scenario-journey-coverage-missing',
  ));
});

test('compiled scenario validation rejects stale source revisions', () => {
  const fixture = source();
  const compiled = compileScenarioFacts(fixture.input, fixture).compiled;
  assert.deepEqual(validateScenarioFacts(compiled, fixture).errors, []);
  fixture.compiled.compiledRevision = 'b'.repeat(64);
  assert.ok(validateScenarioFacts(compiled, fixture).errors.some(
    (item) => item.code === 'stale-screen-pack-binding',
  ));
});

function imageSource() {
  const fixture = source();
  const asset = sampleImageAsset('equipment-tm-014-photo');
  fixture.input.records[0].fields.photo = { mediaAssetKey: asset.key };
  fixture.input.mediaAssets = [asset];
  fixture.input.screenBindings[1].preview.records = [{
    recordId: 'equipment-tm-014', titleField: 'name', mediaAssetKey: asset.key,
  }];
  return fixture;
}

test('licensed CDN metadata stays canonical and survives exact screen/record projection without fetching', (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Deterministic compilation must not fetch'); });
  const fixture = imageSource();
  const before = structuredClone(fixture.input);
  const result = compileScenarioFacts(fixture.input, fixture);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(fixture.input, before);
  assert.deepEqual(result.compiled.records[0].fields.photo, { mediaAssetKey: 'equipment-tm-014-photo' });
  assert.deepEqual(result.compiled.mediaAssets, before.mediaAssets);
  assert.equal(validateScenarioFacts(result.compiled, fixture).ok, true);
  const projected = projectScreenFacts(result.compiled, 'equipment');
  assert.deepEqual(projected.records[0].media, before.mediaAssets[0]);
  assert.deepEqual(projected.media[0].provenance, before.mediaAssets[0].provenance);
  assert.equal(projectScreenFacts(result.compiled, 'complete').media.length, 0);
  projected.records[0].media.provenance.creator = 'Mutated projection';
  assert.equal(result.compiled.mediaAssets[0].provenance.creator, 'Hannes Röst');
  assert.equal(compileScenarioFacts(fixture.input, fixture).compiled.scenarioRevision, result.compiled.scenarioRevision);
});

test('CDN assets require bounded source, license, credit, alt and fallback facts', () => {
  for (const change of [
    (asset) => { delete asset.provenance; },
    (asset) => { delete asset.provenance.sourcePage; },
    (asset) => { asset.provenance.license = ''; },
    (asset) => { asset.provenance.licenseUrl = 'http://creativecommons.org/licenses/by-sa/3.0/'; },
    (asset) => { asset.provenance.attribution = 'a'.repeat(601); },
    (asset) => { asset.provenance.creator = ''; },
    (asset) => { asset.provenance.attributionRequired = 'true'; },
    (asset) => { asset.provenance.changes = ''; },
    (asset) => { asset.provenance.verified = true; },
    (asset) => { asset.alt = ''; },
    (asset) => { asset.fallback = ''; },
    (asset) => { asset.fit = 'stretch'; },
    (asset) => { asset.aspectRatio = 0; },
    (asset) => { asset.focalPoint = 'top'; },
  ]) {
    const fixture = imageSource();
    change(fixture.input.mediaAssets[0]);
    const result = compileScenarioFacts(fixture.input, fixture);
    assert.equal(result.compiled, null);
    assert.ok(result.errors.some((item) => item.code === 'media-provenance-invalid'), JSON.stringify(result.errors));
  }
});

test('sample URLs reject insecure, private, signed and random sources deterministically', () => {
  for (const uri of [
    'http://upload.wikimedia.org/photo.jpg',
    'https://localhost/photo.jpg', 'https://127.0.0.1/photo.jpg',
    'https://0x7f.0.0.1/photo.jpg', 'https://[::1]/photo.jpg',
    'https://photos.internal/photo.jpg', 'https://photos.local/photo.jpg',
    'https://user:password@upload.wikimedia.org/photo.jpg',
    'https://upload.wikimedia.org:443/photo.jpg',
    'https://upload.wikimedia.org/photo.jpg?sig=not-a-real-signature',
    'https://upload.wikimedia.org/photo.jpg#fragment',
    'https://upload.wikimedia.org/%72andom/photo.jpg',
    'https://source.unsplash.com/featured/?mountain',
    'https://picsum.photos/seed/mountain/600/400',
    'https://loremflickr.com/600/400/mountain',
    'https://images.unsplash.com/random',
    'https://upload.wikimedia.org/photo.jpg?Random=true',
    'data:image/png;base64,AA==', '//upload.wikimedia.org/photo.jpg',
  ]) {
    const fixture = imageSource();
    fixture.input.mediaAssets[0].source.value = uri;
    const result = compileScenarioFacts(fixture.input, fixture);
    assert.equal(result.compiled, null, uri);
    assert.ok(result.errors.some((item) => item.code === 'media-provenance-invalid'), uri);
  }
});

test('canonical image field references reject unknown keys and duplicate fixture photo populations', () => {
  for (const photo of [
    { mediaAssetKey: 'missing' },
    { mediaAssetKey: 'equipment-tm-014-photo', uri: sampleImageAsset().source.value },
    { status: 'ready', id: 'equipment-tm-014-photo', uri: sampleImageAsset().source.value },
  ]) {
    const fixture = imageSource();
    fixture.input.records[0].fields.photo = photo;
    assert.equal(compileScenarioFacts(fixture.input, fixture).compiled, null);
  }
  const fixture = imageSource();
  fixture.input.mediaAssets[0].source = { kind: 'generated', value: 'mountain' };
  assert.ok(compileScenarioFacts(fixture.input, fixture).errors.some((item) => item.code === 'media-source-invalid'));
});

test('licensed presentation images preserve screen bindings without inventing persistent photo fields', () => {
  const fixture = imageSource();
  delete fixture.input.records[0].fields.photo;
  const result = compileScenarioFacts(fixture.input, fixture);
  assert.deepEqual(result.errors, []);
  assert.ok(result.compiled);
  assert.deepEqual(result.compiled.records, fixture.input.records);
  const projection = projectScreenFacts(result.compiled, 'equipment');
  assert.deepEqual(projection.media[0], fixture.input.mediaAssets[0]);
});

test('CDN preview imagery cannot borrow another record or an unbound screen asset', () => {
  const fixture = imageSource();
  fixture.input.screenBindings[1].preview.records[0].recordId = 'inspection-001';
  fixture.input.screenBindings[1].preview.records[0].titleField = 'result';
  assert.ok(compileScenarioFacts(fixture.input, fixture).errors.some((item) => item.code === 'preview-media-binding-mismatch'));
  fixture.input.screenBindings[1].preview.records = [];
  fixture.input.screenBindings[1].recordIds = ['inspection-001'];
  assert.ok(compileScenarioFacts(fixture.input, fixture).errors.some((item) => item.code === 'screen-media-record-mismatch'));
});

test('legacy presentation-only CDN metadata cannot be reused as an uncredited record photo', () => {
  const fixture = imageSource();
  delete fixture.input.records[0].fields.photo;
  delete fixture.input.mediaAssets[0].alt;
  delete fixture.input.mediaAssets[0].provenance;
  assert.deepEqual(compileScenarioFacts(fixture.input, fixture).errors, []);
  fixture.input.records[0].fields.photo = { mediaAssetKey: fixture.input.mediaAssets[0].key };
  assert.ok(compileScenarioFacts(fixture.input, fixture).errors.some((item) => item.code === 'media-provenance-invalid'));
});

test('a rehashed canonical contract cannot bypass deterministic image provenance checks', () => {
  const fixture = imageSource();
  const compiled = compileScenarioFacts(fixture.input, fixture).compiled;
  delete compiled.mediaAssets[0].provenance;
  delete compiled.scenarioRevision;
  compiled.scenarioRevision = revision(compiled);
  const checked = validateScenarioFacts(compiled, fixture);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((item) => item.code === 'media-provenance-invalid'));
  assert.equal(checked.errors.some((item) => item.code === 'scenario-revision-mismatch'), false);
});

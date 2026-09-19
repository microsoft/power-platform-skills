const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DECLARATIVE_SITE_TEMPLATES,
  parseArgs,
  buildResult,
} = require('../../skills/create-site/scripts/list-site-templates');

test('returns the curated declarative template identifiers', () => {
  assert.deepEqual(
    DECLARATIVE_SITE_TEMPLATES.map((template) => template.name),
    [
      'StarterLayout1',
      'BlankPage',
      'ProgramRegistration',
      'EventPortal',
      'BookMeetings',
    ],
  );
});

test('reports capability as indeterminate without administrator confirmation', () => {
  const result = buildResult({ modelVersion: 'Enhanced' });
  assert.equal(result.capability.status, 'indeterminate');
  assert.equal(result.capability.source, 'public-api-unavailable');
  assert.equal(result.capability.requiredToggleState, 'enabled');
  assert.equal(result.modelVersion, 'Enhanced');
  assert.equal(result.catalog.environmentSpecific, false);
  assert.equal(result.catalog.templates.length, 5);
});

test('requires the EDM toggle to be disabled for Standard creation', () => {
  const result = buildResult({ modelVersion: 'Standard' });
  assert.equal(result.capability.status, 'indeterminate');
  assert.equal(result.capability.requiredToggleState, 'disabled');
  assert.match(result.capability.reason, /disabled for Standard site creation/);
});

test('returns Event Portal presentation metadata and responsive previews', () => {
  const eventPortal = buildResult({ modelVersion: 'Enhanced' }).catalog.templates.find(
    (template) => template.name === 'EventPortal',
  );

  assert.equal(eventPortal.displayName, 'Event Portal');
  assert.match(eventPortal.description, /discover events/i);
  assert.deepEqual(eventPortal.requirements, ['Customer Insights - Journeys license']);
  assert.equal(eventPortal.capabilities.length, 4);
  assert.deepEqual(
    eventPortal.previews.map((preview) => preview.name),
    ['home', 'registration', 'about'],
  );
  assert.deepEqual(
    eventPortal.previews.map((preview) => preview.displayName),
    ['Home page', 'Registration page', 'Event about page'],
  );
  for (const preview of eventPortal.previews) {
    assert.match(preview.desktop, /\.png$/);
    assert.match(preview.mobile, /\.png$/);
  }
});

test('returns Starter Layout 1 capabilities and responsive previews', () => {
  const starter = buildResult({ modelVersion: 'Standard' }).catalog.templates.find(
    (template) => template.name === 'StarterLayout1',
  );

  assert.match(starter.description, /multipage navigation framework/i);
  assert.deepEqual(
    starter.capabilities,
    ['Home page', 'Subpages', 'Contact us', 'Search results'],
  );
  assert.deepEqual(
    starter.previews.map((preview) => preview.name),
    ['home', 'subpage-1', 'subpage-2'],
  );
  assert.deepEqual(
    starter.previews.map((preview) => preview.displayName),
    ['Home page', 'Sub page 1', 'Sub page 2'],
  );
});

test('returns Blank page metadata and supplied responsive previews', () => {
  const blank = buildResult({ modelVersion: 'Standard' }).catalog.templates.find(
    (template) => template.name === 'BlankPage',
  );

  assert.equal(blank.displayName, 'Blank page');
  assert.match(blank.description, /1-page blank template/);
  assert.deepEqual(blank.capabilities, ['Home page']);
  assert.deepEqual(
    blank.previews.map((preview) => preview.name),
    ['home'],
  );
  for (const preview of blank.previews) {
    assert.match(preview.desktop, /BlankPage\/desktop-home\.png$/);
    assert.match(preview.mobile, /BlankPage\/mobile-home\.png$/);
  }
});

test('records administrator confirmation without claiming API verification', () => {
  const result = buildResult({ administratorConfirmed: true, modelVersion: 'Standard' });
  assert.equal(result.capability.status, 'confirmed');
  assert.equal(result.capability.source, 'administrator-confirmation');
  assert.equal(result.capability.requiredToggleState, 'disabled');
  assert.equal(result.catalog.source, 'plugin-declarative-template-allowlist');
});

test('parseArgs accepts model and administrator confirmation spellings', () => {
  assert.deepEqual(parseArgs(['--modelVersion', 'Enhanced', '--administratorConfirmed']), {
    administratorConfirmed: true,
    modelVersion: 'Enhanced',
  });
  assert.deepEqual(parseArgs(['--model-version', 'Standard', '--administrator-confirmed']), {
    administratorConfirmed: true,
    modelVersion: 'Standard',
  });
});

test('rejects a missing or unsupported model version', () => {
  assert.throws(() => buildResult(), /must be Enhanced or Standard/);
  assert.throws(() => buildResult({ modelVersion: 'automatic' }), /must be Enhanced or Standard/);
});

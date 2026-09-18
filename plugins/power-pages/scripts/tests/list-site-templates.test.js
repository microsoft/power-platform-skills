const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EDM_SITE_TEMPLATES,
  parseArgs,
  buildResult,
} = require('../../skills/create-site/scripts/list-site-templates');

test('returns the curated EDM template identifiers', () => {
  assert.deepEqual(
    EDM_SITE_TEMPLATES.map((template) => template.name),
    [
      'StarterLayout1',
      'ProgramRegistration',
      'EventPortal',
      'BookMeetings',
    ],
  );
});

test('reports capability as indeterminate without administrator confirmation', () => {
  const result = buildResult();
  assert.equal(result.capability.status, 'indeterminate');
  assert.equal(result.capability.source, 'public-api-unavailable');
  assert.equal(result.catalog.environmentSpecific, false);
  assert.equal(result.catalog.templates.length, 4);
});

test('returns Event Portal presentation metadata and responsive previews', () => {
  const eventPortal = buildResult().catalog.templates.find(
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
  const starter = buildResult().catalog.templates.find(
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

test('records administrator confirmation without claiming API verification', () => {
  const result = buildResult({ administratorConfirmed: true });
  assert.equal(result.capability.status, 'enabled');
  assert.equal(result.capability.source, 'administrator-confirmation');
  assert.equal(result.catalog.source, 'plugin-edm-template-allowlist');
});

test('parseArgs accepts both administrator confirmation spellings', () => {
  assert.equal(parseArgs(['--administratorConfirmed']).administratorConfirmed, true);
  assert.equal(parseArgs(['--administrator-confirmed']).administratorConfirmed, true);
  assert.equal(parseArgs([]).administratorConfirmed, false);
});

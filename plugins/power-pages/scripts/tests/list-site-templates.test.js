const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const {
  DECLARATIVE_SITE_TEMPLATES,
  parseArgs,
  buildResult,
} = require('../../skills/create-site/scripts/list-site-templates');
const {
  BOOTSTRAP_5_DOCUMENTATION_URL,
  BOOTSTRAP_5_TEMPLATE_NAMES,
  CREATE_WEBSITE_TEMPLATE_NAMES,
} = require('../lib/site-templates');

const SCRIPT = require.resolve('../../skills/create-site/scripts/list-site-templates');

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1' },
  });
}

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
  assert.equal(result.bootstrapVersion, null);
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
    bootstrapVersion: null,
  });
  assert.deepEqual(parseArgs(['--model-version', 'Standard', '--administrator-confirmed']), {
    administratorConfirmed: true,
    modelVersion: 'Standard',
    bootstrapVersion: null,
  });
});

test('rejects a missing or unsupported model version', () => {
  assert.throws(() => buildResult(), /must be Enhanced or Standard/);
  assert.throws(() => buildResult({ modelVersion: 'automatic' }), /must be Enhanced or Standard/);
});

test('filters explicit Enhanced Bootstrap 5 creation to documented catalog families', () => {
  const result = buildResult({ modelVersion: 'Enhanced', bootstrapVersion: '5' });
  assert.equal(result.bootstrapVersion, 5);
  assert.equal(result.modelVersion, 'Enhanced');
  assert.equal(result.capability.status, 'indeterminate');
  assert.equal(result.capability.requiredToggleState, 'enabled');
  assert.deepEqual(
    result.catalog.templates.map((template) => template.name),
    ['StarterLayout1', 'BlankPage', 'ProgramRegistration', 'BookMeetings'],
  );
  assert.equal(result.catalog.bootstrapCompatibility.source, BOOTSTRAP_5_DOCUMENTATION_URL);
  assert.deepEqual(result.catalog.bootstrapCompatibility.omittedTemplateNames, ['EventPortal']);
  assert.match(result.catalog.bootstrapCompatibility.reason, /validate their version after download/);
});

test('central Bootstrap 5 eligibility includes documented API aliases but only allowlisted identifiers', () => {
  assert.ok(BOOTSTRAP_5_TEMPLATE_NAMES.includes('PowerPortals_ProgramRegistration'));
  assert.ok(BOOTSTRAP_5_TEMPLATE_NAMES.includes('PowerPortals_BookMeeting'));
  assert.ok(!BOOTSTRAP_5_TEMPLATE_NAMES.includes('EventPortal'));
  assert.ok(!BOOTSTRAP_5_TEMPLATE_NAMES.includes('DefaultPortalTemplate'));
  for (const name of BOOTSTRAP_5_TEMPLATE_NAMES) {
    assert.ok(CREATE_WEBSITE_TEMPLATE_NAMES.has(name), `${name} must already be an allowed API identifier`);
  }
});

test('administrator confirmation does not claim downloaded Bootstrap 5 verification', () => {
  const result = buildResult({
    modelVersion: 'Enhanced', bootstrapVersion: 5, administratorConfirmed: true,
  });
  assert.equal(result.capability.status, 'confirmed');
  assert.equal(result.capability.source, 'administrator-confirmation');
  assert.equal(result.capability.requiredToggleState, 'enabled');
  assert.match(result.capability.reason, /Switch to enhanced data model is enabled/);
  assert.match(result.catalog.bootstrapCompatibility.reason, /not the downloaded Bootstrap assets/);
});

test('rejects Bootstrap 5 with Standard even after administrator confirmation', () => {
  for (const administratorConfirmed of [false, true]) {
    assert.throws(
      () => buildResult({ modelVersion: 'Standard', bootstrapVersion: 5, administratorConfirmed }),
      /Bootstrap 5 sites require --modelVersion Enhanced/,
    );
  }
});

test('preserves the full legacy catalog for omitted Bootstrap and explicit Bootstrap 3', () => {
  for (const modelVersion of ['Standard', 'Enhanced']) {
    for (const bootstrapVersion of [undefined, null, '3', 3]) {
      const result = buildResult({ modelVersion, bootstrapVersion });
      assert.equal(result.bootstrapVersion, bootstrapVersion == null ? null : 3);
      assert.deepEqual(result.catalog.templates, DECLARATIVE_SITE_TEMPLATES);
      assert.equal(result.catalog.bootstrapCompatibility, undefined);
    }
  }
});

test('Bootstrap choice never substitutes for an explicit data-model choice', () => {
  assert.throws(() => buildResult({ bootstrapVersion: 5 }), /must be Enhanced or Standard/);
});

test('parses supported Bootstrap CLI values as numeric targets', () => {
  for (const flag of ['--bootstrapVersion', '--bootstrap-version']) {
    for (const version of ['3', '5']) {
      for (const args of [[flag, version], [`${flag}=${version}`]]) {
        assert.deepEqual(parseArgs(['--modelVersion', 'Enhanced', ...args]), {
          administratorConfirmed: false,
          modelVersion: 'Enhanced',
          bootstrapVersion: Number(version),
        });
      }
    }
  }
});

test('rejects malformed or absent values for an explicitly supplied Bootstrap flag', () => {
  for (const args of [
    ['--bootstrapVersion'],
    ['--bootstrapVersion', '--administratorConfirmed'],
    ['--bootstrapVersion', ''],
    ['--bootstrapVersion='],
    ['--bootstrap-version'],
    ['--bootstrap-version', '--modelVersion', 'Enhanced'],
    ['--bootstrapVersion', '4'],
    ['--bootstrapVersion', '5.0'],
    ['--bootstrapVersion', '05'],
    ['--bootstrapVersion', 'automatic'],
    ['--bootstrapVersion', '5', '--bootstrap-version', '3'],
  ]) {
    assert.throws(() => parseArgs(args), /--bootstrapVersion must be/);
  }
});

test('rejects unsupported programmatic Bootstrap values without numeric coercion', () => {
  for (const bootstrapVersion of [4, 0, '', '5.0', '05', true, false, [], [5], {}]) {
    assert.throws(
      () => buildResult({ modelVersion: 'Enhanced', bootstrapVersion }),
      /--bootstrapVersion must be 3 or 5/,
    );
  }
});

test('CLI JSON agrees with module results for filtered and legacy catalogs', () => {
  for (const args of [
    ['--modelVersion', 'Enhanced', '--bootstrapVersion', '5', '--administratorConfirmed'],
    ['--modelVersion', 'Standard', '--bootstrapVersion', '3'],
    ['--modelVersion', 'Standard'],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), buildResult(parseArgs(args)));
  }
});

test('CLI rejects invalid Bootstrap prerequisites rather than returning the legacy catalog', () => {
  for (const args of [
    ['--modelVersion', 'Standard', '--bootstrapVersion', '5'],
    ['--modelVersion', 'Enhanced', '--bootstrapVersion'],
    ['--modelVersion', 'Enhanced', '--bootstrapVersion', '--administratorConfirmed'],
    ['--modelVersion', 'Enhanced', '--bootstrapVersion='],
    ['--modelVersion', 'Enhanced', '--bootstrapVersion', '4'],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--bootstrapVersion must be|Bootstrap 5 sites require/);
  }
});

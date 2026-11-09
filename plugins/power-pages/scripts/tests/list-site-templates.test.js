const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  buildResult,
  run,
} = require('../../skills/create-site/scripts/list-site-templates');
const { validateCatalogShape } = require('../lib/template-catalog');

const SHA = '0123456789abcdef0123456789abcdef01234567';

function nonSpaTemplate({
  id = 'starter-layout-1',
  templateName = 'StarterLayout1',
  displayName = 'Starter Layout 1',
  previews = true,
} = {}) {
  return {
    id,
    displayName,
    description: `${displayName} description`,
    kind: 'non-spa',
    keywords: ['non-spa'],
    audience: ['makers'],
    author: 'Microsoft',
    provisioning: {
      type: 'create-website-api',
      templateName,
    },
    capabilities: ['Home page'],
    requirements: [],
    responsivePreviews: previews ? [{
      id: 'home',
      displayName: 'Home page',
      desktop: `templates/non-spa/${id}/previews/desktop-home.png`,
      mobile: `templates/non-spa/${id}/previews/mobile-home.png`,
    }] : [],
  };
}

function catalogResult(templates = [
  nonSpaTemplate(),
  nonSpaTemplate({
    id: 'starter-layout-2',
    templateName: 'StarterLayout2',
    displayName: 'Starter Layout 2',
  }),
  nonSpaTemplate({
    id: 'starter-layout-3',
    templateName: 'StarterLayout3',
    displayName: 'Starter Layout 3',
  }),
  nonSpaTemplate({
    id: 'starter-layout-4',
    templateName: 'StarterLayout4',
    displayName: 'Starter Layout 4',
  }),
  nonSpaTemplate({
    id: 'starter-layout-5',
    templateName: 'StarterLayout5',
    displayName: 'Starter Layout 5',
  }),
  nonSpaTemplate({
    id: 'event-portal',
    templateName: 'EventPortal',
    displayName: 'Event Portal',
  }),
]) {
  return {
    ok: true,
    owner: 'microsoft',
    repo: 'power-pages-samples',
    ref: 'latest-release',
    resolvedRef: 'templates-v1.0.0',
    sha: SHA,
    releaseName: 'templates-v1.0.0',
    releaseUrl: 'https://github.com/microsoft/power-pages-samples/releases/tag/templates-v1.0.0',
    catalog: { templates },
  };
}

test('samples manifest contract accepts Create Website API templates without artifact fields', () => {
  assert.equal(validateCatalogShape({ templates: [nonSpaTemplate()] }), null);
});

test('samples manifest contract rejects malformed non-SPA provisioning metadata', () => {
  const template = nonSpaTemplate();
  delete template.provisioning.templateName;
  assert.match(
    validateCatalogShape({ templates: [template] }),
    /provisioning\.templateName/,
  );
});

test('returns Enhanced Bootstrap 5 samples metadata with immutable preview URLs', () => {
  const result = buildResult({
    modelVersion: 'Enhanced',
    bootstrapVersion: 5,
    catalogResult: catalogResult(),
  });

  assert.equal(result.catalog.source, 'power-pages-samples');
  assert.equal(result.catalog.commitSha, SHA);
  assert.deepEqual(
    result.catalog.templates.map((template) => template.name),
    [
      'StarterLayout1',
      'StarterLayout2',
      'StarterLayout3',
      'StarterLayout4',
      'StarterLayout5',
    ],
  );
  assert.equal(
    result.catalog.templates[0].previews[0].desktop,
    `https://raw.githubusercontent.com/microsoft/power-pages-samples/${SHA}/templates/non-spa/starter-layout-1/previews/desktop-home.png`,
  );
});

test('retains documented Bootstrap 5 filtering while metadata comes from samples', () => {
  const result = buildResult({
    modelVersion: 'Enhanced',
    bootstrapVersion: 5,
    catalogResult: catalogResult(),
  });

  assert.deepEqual(
    result.catalog.templates.map((template) => template.name),
    [
      'StarterLayout1',
      'StarterLayout2',
      'StarterLayout3',
      'StarterLayout4',
      'StarterLayout5',
    ],
  );
  assert.deepEqual(result.catalog.bootstrapCompatibility.omittedTemplateNames, ['EventPortal']);
});

test('fails closed when the samples catalog is unavailable or contains no non-SPA templates', () => {
  assert.throws(
    () => buildResult({
      modelVersion: 'Enhanced',
      bootstrapVersion: 5,
      catalogResult: { ok: false, error: 'network unavailable' },
    }),
    /catalog unavailable: network unavailable/,
  );
  assert.throws(
    () => buildResult({
      modelVersion: 'Enhanced',
      bootstrapVersion: 5,
      catalogResult: catalogResult([]),
    }),
    /contains no templates/,
  );
});

test('rejects every new-site model and Bootstrap combination except Enhanced with Bootstrap 5', () => {
  for (const [modelVersion, bootstrapVersion] of [
    ['Standard', 3],
    ['Standard', 5],
    ['Enhanced', 3],
  ]) {
    assert.throws(
      () => buildResult({
        modelVersion,
        bootstrapVersion,
        catalogResult: catalogResult(),
      }),
      /supports only --modelVersion Enhanced with --bootstrapVersion 5/,
    );
  }
});

test('run fetches the production catalog and preserves administrator confirmation', async () => {
  const result = await run(
    ['--modelVersion', 'Enhanced', '--bootstrapVersion', '5', '--administratorConfirmed'],
    { fetchCatalog: async () => catalogResult() },
  );

  assert.equal(result.capability.status, 'confirmed');
  assert.equal(result.capability.requiredToggleState, 'enabled');
  assert.equal(result.catalog.requestedRef, 'latest-release');
});

test('parseArgs accepts supported spellings', () => {
  assert.deepEqual(
    parseArgs(['--model-version', 'Enhanced', '--bootstrap-version=5', '--administrator-confirmed']),
    {
      administratorConfirmed: true,
      modelVersion: 'Enhanced',
      bootstrapVersion: 5,
    },
  );
});

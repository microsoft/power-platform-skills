'use strict';
// An App Spec with no tables of its own. A model-driven app need not have one: its navigation can hold only generative pages (an app
// `apps.js create --page-id` makes), dashboards over tables the environment already has, or URLs. The validator used to refuse every
// such spec with `at least one entity is required`, in every profile — so the download of such an app wrote its page folders and then
// stopped without a spec, and no build could make one. A spec is now refused for that only when it has no table AND no navigation entry,
// which is a spec with nothing to build an app from. The build, the download, verify and teardown of such an app are driven over the
// real bundle in lifecycle-no-tables-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAppSpec, VALIDATION_PROFILES } = require('../lib/app-spec.js');

const REFUSAL = /^at least one entity is required/;
const oneGroup = (...subAreas) => ({ areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas }] }] });
const base = (extra = {}) => ({
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoPages', displayName: 'Contoso Pages', publisherPrefix: 'contoso' },
  app: { name: 'Account Metrics', description: 'Metrics over accounts.' },
  entities: [],
  ...extra,
});

// Every profile a caller validates with: the build's deploy, plan and design, teardown's structural, and the download's plan for a spec
// it reconstructed from a deployed app.
const PROFILES = [...VALIDATION_PROFILES.map((profile) => ({ profile })), { profile: 'plan', reconstructed: true }];
const errorsOf = (spec, opts) => validateAppSpec(JSON.parse(JSON.stringify(spec)), opts).errors;

// The shapes a download writes for an app with no table: a page reading a table the environment has; a dashboard over one, bound by the
// ids the download read; a URL.
const VALID = {
  'a navigation of one generative page': base({
    pages: [{ key: 'overview', name: 'Overview', pageId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', dataSources: ['account'], source: { kind: 'tsx', codeFile: 'pages/7c9e6679-7425-40de-944b-e07fc1f90ae7/page.tsx' } }],
    appShell: oneGroup({ page: 'overview', title: 'Overview' }),
  }),
  'a navigation of one dashboard over a table the environment has': base({
    dashboards: [{ name: 'Account overview', dashboardId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', tiles: [{ type: 'list', name: 'Accounts', entity: 'account', viewId: '00000000-0000-0000-00aa-000010001001' }] }],
    appShell: oneGroup({ dashboard: 'Account overview', title: 'Overview' }),
  }),
  'a navigation of one URL': base({ appShell: oneGroup({ url: 'https://contoso.example/help', title: 'Help' }) }),
};

for (const [name, spec] of Object.entries(VALID)) {
  test(`an app with no tables is a valid spec in every profile: ${name}`, () => {
    for (const opts of PROFILES) assert.deepEqual(errorsOf(spec, opts), [], JSON.stringify(opts));
  });
}

// NEIGHBOURS: what the rule still refuses, and what it does not hide.

test('a spec with no table and no navigation entry is still refused, in every profile, and the refusal names the way out', () => {
  const shapes = {
    'no appShell': base(),
    'appShell.areas is empty': base({ appShell: { areas: [] } }),
    'an area with no group': base({ appShell: { areas: [{ label: 'Main', groups: [] }] } }),
    'a group with no entry': base({ appShell: oneGroup() }),
    'no entities key at all': (() => { const s = base({ appShell: { areas: [] } }); delete s.entities; return s; })(),
  };
  for (const [name, spec] of Object.entries(shapes)) {
    for (const opts of PROFILES) {
      const refusals = errorsOf(spec, opts).filter((e) => REFUSAL.test(e));
      assert.equal(refusals.length, 1, `${name} ${JSON.stringify(opts)}`);
      assert.match(refusals[0], /an app with no tables, an entry in appShell \(a page, a dashboard or a URL\)/);
    }
  }
});

test('a navigation entry the spec cannot resolve is still an entry: the spec is not refused for having no table, and the entry\u2019s own error is reported', () => {
  // An entry that names a page the spec does not declare, or a table it does not declare, counts as an entry here (there is something
  // in the navigation), and the navigation's own errors say what is wrong with it.
  const undeclaredPage = errorsOf(base({ appShell: oneGroup({ page: 'missing', title: 'Missing' }) }), { profile: 'deploy' });
  assert.ok(!undeclaredPage.some((e) => REFUSAL.test(e)), JSON.stringify(undeclaredPage));
  assert.ok(undeclaredPage.some((e) => /missing/.test(e)), JSON.stringify(undeclaredPage));
  const undeclaredTable = errorsOf(base({ appShell: oneGroup({ entity: 'account', title: 'Accounts' }) }), { profile: 'deploy' });
  assert.ok(undeclaredTable.some((e) => e === "sitemap subArea references unknown entity 'account'"), JSON.stringify(undeclaredTable));
});

test('a spec with a table needs no navigation, as before: a data-only spec is valid', () => {
  const dataOnly = base({ entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }] });
  for (const opts of PROFILES) assert.deepEqual(errorsOf(dataOnly, opts), [], JSON.stringify(opts));
});

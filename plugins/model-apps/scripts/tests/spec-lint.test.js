// plugins/model-apps/scripts/tests/spec-lint.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { lintAppSpec } = require('../lib/spec-lint.js');

const base = () => ({
  solution: { uniqueName: 'X', publisherPrefix: 'new' },
  entities: [
    { schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name', displayName: 'Title' },
      columns: [{ schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options: ['Low', 'High'] }] },
  ],
  relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } }],
  forms: [], views: [], charts: [],
});

test('a clean spec passes with no errors', () => {
  const r = lintAppSpec(base());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errors.length, 0);
});

test('warns when a sitemap vectorIcon looks like an image filename (probably meant icon)', () => {
  const s = base();
  s.appShell = { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [
    { entity: 'new_customer', title: 'Customers', vectorIcon: 'my.svg' },
  ] }] }] };
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((w) => /vectorIcon 'my\.svg' looks like a file/.test(w)), JSON.stringify(r.warnings));
});

test('flags the relationship-name vs lookup-name collision (the live bug)', () => {
  const s = base();
  s.relationships[0].lookup.schemaName = 'new_customer_new_ticket';
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((m) => /collides with its lookup/i.test(m)));
});

test('errors on a missing primaryAttribute', () => {
  const s = base();
  delete s.entities[1].primaryAttribute;
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /primaryAttribute/i.test(m)));
});

test('errors on a Choice column with no options', () => {
  const s = base();
  s.entities[1].columns[0].options = [];
  const r = lintAppSpec(s);
  assert.ok(r.errors.some((m) => /needs options/i.test(m)));
});

test('warns when a Choice has too many options', () => {
  const s = base();
  s.entities[1].columns[0].options = Array.from({ length: 14 }, (_, i) => 'O' + i);
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((m) => /consider a lookup table/i.test(m)));
});

test('errors on a sub-grid with no matching OneToMany', () => {
  const s = base();
  s.forms = [{ entity: 'new_customer', subgrids: [{ childEntity: 'new_comment' }] }];
  const r = lintAppSpec(s);
  assert.ok(r.errors.some((m) => /no matching OneToMany/i.test(m)));
});

test('warns when a QuickView form is built but not placed on any host form', () => {
  const s = base();
  s.forms = [{ entity: 'new_ticket', name: 'Ticket QV', formType: 'QuickView' }];
  const r = lintAppSpec(s);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((m) => /QuickView form/i.test(m) && /isn't placed/i.test(m)));
});

test('a placed QuickView form draws no unplaced warning, and quick-view refs validate', () => {
  const s = base();
  s.forms = [
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main',
      quickViews: [{ lookup: 'new_customerid', targetEntity: 'new_customer', form: 'Customer QV' }] },
    { entity: 'new_customer', name: 'Customer QV', formType: 'QuickView' },
  ];
  const r = lintAppSpec(s);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.ok(!r.warnings.some((m) => /isn't placed/i.test(m)), 'no unplaced warning once referenced');
});

test('errors when a quick-view references a non-QuickView (or unknown) form', () => {
  const s = base();
  s.forms = [
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main',
      quickViews: [{ lookup: 'new_customerid', targetEntity: 'new_customer', form: 'Customer' }] },
    { entity: 'new_customer', name: 'Customer', formType: 'Main' },
  ];
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /must be a QuickView form/i.test(m)));
});

test('command flyouts: a FlyoutAnchor needs children; children need a library + function', () => {
  const s = base();
  s.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  s.commands = [
    { entity: 'new_ticket', label: 'More', type: 'FlyoutAnchor', children: [{ label: 'A' }] }, // child missing lib/fn
  ];
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /needs a library/i.test(m) || /needs a function/i.test(m)));
});

test('command flyouts: a well-formed flyout (with library-backed children) passes', () => {
  const s = base();
  s.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  s.commands = [
    { entity: 'new_ticket', label: 'More', type: 'FlyoutAnchor', children: [
      { label: 'A', library: 'new_ticket.js', function: 'T.a' },
    ] },
  ];
  const r = lintAppSpec(s);
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('sitemap: a DashBoard subarea must reference a declared dashboard', () => {
  const s = base();
  s.appShell = { areas: [{ label: 'Main', groups: [{ label: 'G', subAreas: [{ dashboard: 'Ops', title: 'Overview' }] }] }] };
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /unknown dashboard 'Ops'/i.test(m)));
  s.dashboards = [{ name: 'Ops', tiles: [{ type: 'iframe', url: 'https://x', name: 'X' }] }];
  const r2 = lintAppSpec(s);
  assert.ok(r2.ok, JSON.stringify(r2.errors));
});

test('sitemap: a page subarea must reference a declared page', () => {
  const s = base();
  s.appShell = { areas: [{ label: 'Main', groups: [{ label: 'G', subAreas: [{ page: 'Overview', title: 'Overview' }] }] }] };
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /unknown page 'Overview'/i.test(m)), JSON.stringify(r.errors));
  s.pages = [{ name: 'Overview', codeFile: 'overview.tsx' }];
  const r2 = lintAppSpec(s);
  assert.ok(r2.ok, JSON.stringify(r2.errors));
});

test('sitemap: a subarea with two targets is rejected', () => {
  const s = base();
  s.appShell = { areas: [{ label: 'Main', groups: [{ label: 'G', subAreas: [{ entity: 'new_customer', url: 'https://x', title: 'Both' }] }] }] };
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /sets multiple targets/i.test(m)));
});

test('errors on sub-grids declared on a non-Main form', () => {
  const s = base();
  s.forms = [{ entity: 'new_customer', formType: 'QuickCreate', subgrids: [{ childEntity: 'new_ticket' }] }];
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /Main-form only/i.test(m)));
});

test('errors on a relationship referencing an unknown entity', () => {
  const s = base();
  s.relationships[0].referencing = 'new_nope';
  const r = lintAppSpec(s);
  assert.ok(r.errors.some((m) => /unknown entity/i.test(m)));
});

test('errors on a command with no function and an undeclared library', () => {
  const s = base();
  s.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'missing.js' }];
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /needs a function/i.test(m)));
  assert.ok(r.errors.some((m) => /undeclared web resource/i.test(m)));
});

test('accepts a command bound to a declared web resource + function', () => {
  const s = base();
  s.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  s.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'new_ticket.js', function: 'T.escalate' }];
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('errors on a dashboard tile referencing an unknown view', () => {
  const s = base();
  s.views = [{ entity: 'new_ticket', name: 'Active', columns: ['new_name'] }];
  s.dashboards = [{ name: 'Ops', tiles: [{ type: 'list', view: 'Missing' }] }];
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /references unknown view/i.test(m)));
});

test('warns on prefix drift', () => {
  const s = base();
  s.entities[1].schemaName = 'cr123_ticket';
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((m) => /prefix/i.test(m)));
});

// --- Sample-data Choice value resolvability (the global-choice live gap) -----------------

test('errors on a sampleData Choice value that is neither a declared label nor an int', () => {
  const s = base();
  s.sampleData = { new_ticket: [{ new_name: 'T1', new_priority: 'Platnium' }] }; // typo, not Low/High
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /isn't a valid option/i.test(m)));
});

test('catches an unresolvable label on a GLOBAL-choice column (the gap that slipped past)', () => {
  const s = base();
  s.globalChoices = [{ name: 'new_tierset', options: ['Platinum', 'Gold', 'Silver', 'Bronze'] }];
  s.entities[0].columns.push({ schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', globalChoice: 'new_tierset' });
  s.sampleData = { new_customer: [{ new_name: 'C1', new_tier: 'Platnium' }] }; // typo for Platinum
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /new_tier='Platnium'/.test(m)));
});

test('accepts sampleData Choice values that match a declared label (inline or global) or a raw int', () => {
  const s = base();
  s.globalChoices = [{ name: 'new_tierset', options: ['Platinum', 'Gold'] }];
  s.entities[0].columns.push({ schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', globalChoice: 'new_tierset' });
  s.sampleData = {
    new_ticket: [{ new_name: 'T1', new_priority: 'High' }, { new_name: 'T2', new_priority: 100000000 }],
    new_customer: [{ new_name: 'C1', new_tier: 'Gold' }],
  };
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

// --- ai block lint guardrails -----------------------------------------------------------

test('lint warns on a summary configured for a D365-owned table', () => {
  const s = base();
  s.ai = { summaries: { tables: { incident: { enabled: true } } } };
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((w) => /Dynamics 365|own summaries/i.test(w)));
});

test('lint warns on lead and opportunity D365-owned tables', () => {
  const s = base();
  s.ai = { summaries: { tables: { lead: { enabled: true }, opportunity: { enabled: true } } } };
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((w) => /lead/i.test(w) && /Dynamics 365/i.test(w)));
  assert.ok(r.warnings.some((w) => /opportunity/i.test(w) && /Dynamics 365/i.test(w)));
});

test('lint warns when a summary table has no descriptive columns', () => {
  const s = base();
  // new_customer has no columns at all in base() — should warn
  s.ai = { summaries: { tables: { new_customer: { enabled: true } } } };
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((w) => /no descriptive columns/i.test(w)));
});

test('lint errors when a configured columns[] entry is not declared on the entity', () => {
  const s = base();
  s.ai = { summaries: { tables: { new_ticket: { columns: ['new_nonexistent'] } } } };
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /unknown column 'new_nonexistent'/i.test(m)));
});

test('lint passes a well-formed ai block and raises no ai errors', () => {
  const s = base();
  s.ai = { appFeatures: { formFill: true }, summaries: { default: 'auto', tables: { new_ticket: { enabled: true, columns: ['new_priority'] } } } };
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('lint does not warn/error on specs with no ai block (no regression)', () => {
  const r = lintAppSpec(base());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errors.length, 0);
});

// --- headless spec lint guardrails ------------------------------------------------------
// A headless model app is an entity-only shell: solution + entities + an appShell that
// points at entities. Classic UI artifacts (forms/views/charts/dashboards/pages/commands/
// webResources) are forbidden — the mutual-exclusion rule keeps the shell honest so the
// build won't quietly emit them. See U1 contract in units.json for run20260708headless01.

// Build a minimally-viable headless spec: entities + an appShell whose subarea points
// at an entity. Kept local so headless tests can mutate freely.
const headlessBase = () => {
  const s = base();
  s.headless = true;
  s.appShell = { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [
    { entity: 'new_customer', title: 'Customers' },
  ] }] }] };
  return s;
};

test('lint passes a clean headless spec (entities + entity subarea, no classic UI)', () => {
  const r = lintAppSpec(headlessBase());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  // Guard against a future noisy warning being added to the headless code path.
  assert.ok(!(r.warnings || []).some((w) => /headless/i.test(w)),
    `clean headless spec should raise no headless warnings; got ${JSON.stringify(r.warnings)}`);
});

test('lint fails a headless spec that declares non-empty forms[] with a mutual-exclusion error naming headless', () => {
  const s = headlessBase();
  s.forms = [{ entity: 'new_ticket', layout: 'auto' }];
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((m) => /headless/i.test(m) && /forms/i.test(m)),
    `expected an error mentioning both 'headless' and 'forms'; got ${JSON.stringify(r.errors)}`);
});

test('lint tolerates empty classic UI arrays on a headless spec (forms:[], views:[], etc.)', () => {
  const s = headlessBase();
  s.forms = []; s.views = []; s.charts = []; s.dashboards = []; s.pages = []; s.commands = []; s.webResources = [];
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('lint fails a headless spec that also declares non-empty views/charts/dashboards/pages/commands/webResources', () => {
  // Collect failures across every forbidden key so we see EVERY regression, not just
  // the first. `assert` inside a loop aborts on the first miss and hides the rest.
  const failures = [];
  for (const key of ['views', 'charts', 'dashboards', 'pages', 'commands', 'webResources']) {
    const s = headlessBase();
    // Shape doesn't matter — mutual-exclusion is structural (non-empty array).
    s[key] = [{ name: 'x', entity: 'new_ticket', chartType: 'Column', groupBy: 'new_priority' }];
    const r = lintAppSpec(s);
    if (r.ok || !r.errors.some((m) => /headless/i.test(m) && new RegExp(key, 'i').test(m))) {
      failures.push({ key, ok: r.ok, errors: r.errors });
    }
  }
  assert.deepStrictEqual(failures, [], `forbidden sections that failed to trigger a headless error: ${JSON.stringify(failures)}`);
});

test('lint fails a headless spec with no entities (both missing key and empty array)', () => {
  for (const mutate of [(s) => { s.entities = []; }, (s) => { delete s.entities; }]) {
    const s = headlessBase();
    mutate(s);
    const r = lintAppSpec(s);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((m) => /headless/i.test(m) && /entit/i.test(m)),
      `expected an error mentioning both 'headless' and 'entities'; got ${JSON.stringify(r.errors)}`);
  }
});

test('lint fails a headless spec whose appShell has no Entity-typed subareas', () => {
  const s = headlessBase();
  // Replace the entity subarea with a URL subarea so no Entity subareas remain.
  s.appShell.areas[0].groups[0].subAreas = [{ url: 'https://example.com', title: 'Docs' }];
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, false);
  // Match specifically on subarea/sitemap wording (not just 'entity', which would also
  // match an unrelated no-entities error and mask a regression).
  assert.ok(r.errors.some((m) => /headless/i.test(m) && /subarea|sitemap/i.test(m)),
    `expected a headless error naming the missing entity subarea; got ${JSON.stringify(r.errors)}`);
});

test('lint does not apply headless rules when headless is false or absent (populated classic UI stays legal)', () => {
  // Populate the classic-UI sections that WOULD trip the headless rule if it fired.
  // The real regression case is "user forgets `headless: true`, keeps forms/views" — the
  // headless rule must stay silent.
  for (const mutate of [(s) => { s.headless = false; }, (_s) => { /* headless absent */ }]) {
    const s = base();
    s.forms = [{ entity: 'new_ticket', name: 'Ticket', formType: 'Main', layout: 'auto' }];
    s.views = [{ entity: 'new_ticket', name: 'Active', columns: ['new_name'] }];
    mutate(s);
    const r = lintAppSpec(s);
    assert.ok(!r.errors.some((m) => /headless/i.test(m)),
      `no headless-rule error should fire when headless is ${s.headless}; got ${JSON.stringify(r.errors)}`);
  }
});

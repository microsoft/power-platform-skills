// plugins/model-apps/scripts/tests/spec-lint.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { migrateAppSpec } = require('../lib/app-spec.js');

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

test('a view named like the stock default ("Active <Plural>") WARNS about the merge-onto-default collision', () => {
  const s = base();
  s.views = [{ entity: 'new_ticket', name: 'Active Tickets', columns: ['new_name', 'new_priority'], activeOnly: true }];
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, true, 'the collision is a warning, not an error: ' + JSON.stringify(r.errors));
  assert.ok(
    r.warnings.some((w) => /Active Tickets/.test(w) && /stock default view/.test(w) && /filters\/sort are ignored/.test(w)),
    JSON.stringify(r.warnings)
  );
});

test('a view with a DISTINCT name does NOT warn about a stock-default collision', () => {
  const s = base();
  s.views = [{ entity: 'new_ticket', name: 'Open Tickets', columns: ['new_name', 'new_priority'], activeOnly: true }];
  const r = lintAppSpec(s);
  assert.ok(!r.warnings.some((w) => /stock default view/.test(w)), JSON.stringify(r.warnings));
});

test('a relationship to a standard/system table (referenced not in entities[]) WARNS, not errors', () => {
  const s = base();
  // systemuser is a standard table the build supports (auto-prefixes the rel name) — must not error.
  s.relationships.push({ type: 'OneToMany', referenced: 'systemuser', referencing: 'new_ticket', lookup: { schemaName: 'new_AssignedUserId', displayName: 'Assigned' } });
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, true, 'systemuser referenced is not an error: ' + JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => /systemuser/.test(w) && /standard\/system table/.test(w)), JSON.stringify(r.warnings));
});

test('a relationship whose REFERENCING (child) side is unknown IS an error (the child must be declared)', () => {
  const s = base();
  s.relationships.push({ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_missing', lookup: { schemaName: 'new_CustId', displayName: 'Customer' } });
  const r = lintAppSpec(s);
  assert.ok(r.errors.some((e) => /unknown entity 'new_missing'/.test(e)), JSON.stringify(r.errors));
});

test('warns that vectorIcon on an entity subarea is ignored (dropped) — the nav uses the table icon', () => {
  const s = base();
  s.appShell = { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [
    { entity: 'new_customer', title: 'Customers', vectorIcon: 'Shield' },
  ] }] }] };
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((w) => /vectorIcon is ignored on an entity subarea/.test(w)), JSON.stringify(r.warnings));
});

test('warns when a non-entity subarea vectorIcon is a bare Fluent token (VectorIcon needs an SVG path / $webresource)', () => {
  const s = base();
  s.appShell = { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [
    { url: 'https://x', title: 'Help', vectorIcon: 'Home' },
  ] }] }] };
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((w) => /vectorIcon 'Home' is a bare token/.test(w)), JSON.stringify(r.warnings));
});

test('flags the relationship-name vs lookup-name collision (the live bug)', () => {
  const s = base();
  s.relationships[0].lookup.schemaName = 'new_customer_new_ticket';
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((m) => /collides with its lookup/i.test(m)));
});

test('errors on an explicit relationship schemaName that lacks the publisher prefix', () => {
  const s = base();
  // systemuser-referenced relationship with a hand-written, unprefixed name — Dataverse would 400.
  s.entities.push({ schemaName: 'systemuser', displayName: 'User', primaryAttribute: { schemaName: 'fullname', displayName: 'Name' }, columns: [] });
  s.relationships.push({ type: 'OneToMany', referenced: 'systemuser', referencing: 'new_ticket', schemaName: 'systemuser_new_ticket', lookup: { schemaName: 'new_UserId', displayName: 'User' } });
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((m) => /must start with the publisher prefix 'new_'/.test(m)), JSON.stringify(r.errors));
});

test('a system-table relationship with NO schemaName is clean (auto-prefixed default is valid)', () => {
  const s = base();
  s.entities.push({ schemaName: 'systemuser', displayName: 'User', primaryAttribute: { schemaName: 'fullname', displayName: 'Name' }, columns: [] });
  s.relationships.push({ type: 'OneToMany', referenced: 'systemuser', referencing: 'new_ticket', lookup: { schemaName: 'new_UserId', displayName: 'User' } });
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
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

// REGRESSION: a schemaVersion-2 page subarea references the page by its stable KEY (migrateAppSpec
// rewrites name-based appShell refs to keys). When key !== name (e.g. key 'order-detail', name 'Order
// Detail') the guardrail lint must NOT falsely error "references unknown page" — that was a bug where
// lint only checked page NAMES while validateAppSpec correctly checks KEYS for v2 specs.
test('lint accepts a v2 page subarea referenced by KEY when key !== name (no false "unknown page")', () => {
  const raw = {
    schemaVersion: 2,
    solution: { uniqueName: 'X', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{ schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Order #' }, columns: [] }],
    pages: [{ key: 'order-detail', name: 'Order Detail', source: { kind: 'intent' }, purpose: 'One order', dataSources: ['new_order'] }],
    appShell: { areas: [{ label: 'Sales', groups: [{ label: 'Work', subAreas: [{ page: 'order-detail', title: 'Order Detail' }] }] }] },
  };
  const spec = migrateAppSpec(raw); // sa.page is now the KEY 'order-detail'
  assert.strictEqual(spec.appShell.areas[0].groups[0].subAreas[0].page, 'order-detail');
  const r = lintAppSpec(spec);
  assert.ok(!r.errors.some((e) => /unknown page/i.test(e)), `no false unknown-page error; got: ${JSON.stringify(r.errors)}`);
  // A genuinely unknown page ref (neither key nor name) is still an error.
  const bad = JSON.parse(JSON.stringify(spec));
  bad.appShell.areas[0].groups[0].subAreas[0].page = 'nope-not-a-page';
  assert.ok(lintAppSpec(bad).errors.some((e) => /unknown page/i.test(e)), 'an unknown page ref still errors');
});

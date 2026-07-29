'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderAppPreview } = require('../lib/app-preview.js');

const sample = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', `app-spec.${n}.json`), 'utf8'));

test('renderAppPreview renders every design section for the support-desk sample', () => {
  const out = renderAppPreview(sample('support-desk'));
  assert.match(out, /APP: Support Desk/);
  assert.match(out, /=== Data model ===/);
  assert.match(out, /new_customer/); // table logical shown
  assert.match(out, /=== Sitemap \(appShell\) ===/);
  assert.match(out, /table:new_customer/); // entity subarea labeled by target kind
  assert.match(out, /=== Views & charts ===/);
  assert.match(out, /Tickets by Priority/);
  assert.match(out, /=== Forms ===/);
  // A reused form wireframe (from form-preview.js) is embedded — its box border is present.
  assert.match(out, /┌─/);
  // 1:N relationships summarized.
  assert.match(out, /1:N\s+new_customer\s+→\s+new_ticket/);
});

test('renderAppPreview renders page-intents and the design contract for a v2 multi-page spec', () => {
  const spec = {
    schemaVersion: 2,
    app: { name: 'Orders', description: 'Order ops' },
    entities: [{ schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_order', title: 'Orders' }, { page: 'overview', title: 'Overview' }] }] }] },
    pages: [
      { key: 'overview', name: 'Overview', purpose: 'KPIs', dataSources: ['new_order'], source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'order-detail', data: { orderId: 'string' } }] },
      { key: 'order-detail', name: 'Order Detail', purpose: 'One order', dataSources: ['new_order'], source: { kind: 'tsx', codeFile: 'order-detail.tsx' } },
    ],
    design: { accentColor: '#0f6cbd', density: 'comfortable' },
  };
  const out = renderAppPreview(spec);
  assert.match(out, /=== Pages \(generative\) ===/);
  assert.match(out, /Overview \[overview\] — intent \(design-only\)/);
  assert.match(out, /Order Detail \[order-detail\] — implemented \(order-detail\.tsx\)/);
  assert.match(out, /purpose: KPIs/);
  assert.match(out, /→ navigates to order-detail/);
  assert.match(out, /page:overview/); // page subarea labeled by key
  assert.match(out, /=== Design contract ===/);
  assert.match(out, /accentColor=#0f6cbd/);
});

test('renderAppPreview does not throw on a minimal / empty spec', () => {
  const out = renderAppPreview({ app: { name: 'Bare' } });
  assert.match(out, /APP: Bare/);
  assert.match(out, /\(no tables\)/);
  assert.match(out, /\(no forms\)/);
});

test('renderAppPreview renders the security-roles section with per-entity access + app-open posture', () => {
  const spec = {
    app: { name: 'Ops' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    personas: [
      { persona: 'Agent', jobs: [{ name: 'Work', privileges: [{ entity: 'new_ticket', access: ['read', 'write'], scope: 'businessUnit' }] }] },
      { persona: 'Auditor', appAccess: false, jobs: [{ name: 'Audit', privileges: [{ entity: 'new_ticket', access: ['read'], scope: 'organization' }] }] },
    ],
  };
  const out = renderAppPreview(spec);
  assert.match(out, /=== Security roles \(personas\) ===/);
  assert.match(out, /role "Agent"\s+\(app opens for this persona\)/);
  assert.match(out, /new_ticket: read\/write @ businessUnit/);
  assert.match(out, /role "Auditor"\s+\(data-only — no app access\)/);
});

test('renderAppPreview omits the security section when no personas are declared', () => {
  const out = renderAppPreview({ app: { name: 'Bare' }, entities: [] });
  assert.doesNotMatch(out, /Security roles/);
});

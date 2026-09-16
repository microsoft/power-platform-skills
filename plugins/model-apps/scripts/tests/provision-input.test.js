'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateProvisionInput } = require(path.join(__dirname, '..', 'lib', 'provision-input.js'));

test('accepts a minimal valid input', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }], relationships: [] });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('rejects an entity whose schemaName prefix does not match the solution publisher prefix', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default', publisherPrefix: 'new' },
    entities: [{ schemaName: 'cr_candidate', displayName: 'C', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }], relationships: [] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /must start with the solution publisher prefix 'new_'/.test(e)));
});

test('rejects a missing solution.publisherPrefix', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default' }, entities: [], relationships: [] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /publisherPrefix/i.test(e)));
});

test('accepts an entity schemaName with underscores in the suffix (junction/config tables)', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_ticket_tag', displayName: 'Ticket Tag', primaryAttribute: { schemaName: 'new_name' }, columns: [] }], relationships: [] });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('rejects an entity whose schemaName lacks a prefix', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'candidate', displayName: 'C', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }], relationships: [] });
  assert.strictEqual(r.ok, false);
});

test('rejects a relationship referencing an unknown entity', () => {
  const r = validateProvisionInput({ 
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }],
    relationships: [{ type: 'OneToMany', referenced: 'cr_jobrequisition', referencing: 'cr_candidate', lookup: { schemaName: 'cr_jobrequisition' } }]
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /not found in entities/i.test(e)));
});

test('rejects a relationship with an unknown type', () => {
  const r = validateProvisionInput({
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [
      { schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
      { schemaName: 'cr_job', displayName: 'Job', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
    ],
    relationships: [{ type: 'OneToOne', referenced: 'cr_job', referencing: 'cr_candidate', lookup: { schemaName: 'cr_jobid' } }],
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /type must be 'OneToMany' or 'ManyToMany'/.test(e)));
});

test('rejects a column with an unknown type', () => {
  const r = validateProvisionInput({ 
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ 
      schemaName: 'cr_candidate', 
      displayName: 'Candidate', 
      primaryAttribute: { schemaName: 'cr_name' }, 
      columns: [{ schemaName: 'cr_status', type: 'InvalidType' }]
    }],
    relationships: []
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown type/i.test(e)));
});

test('accepts a valid OneToMany relationship', () => {
  const r = validateProvisionInput({ 
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [
      { schemaName: 'cr_jobrequisition', displayName: 'Job', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
      { schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }
    ],
    relationships: [{ type: 'OneToMany', referenced: 'cr_jobrequisition', referencing: 'cr_candidate', lookup: { schemaName: 'cr_jobrequisition' } }]
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

// #447: an LCID supplied in the input JSON must be rejected at the SAME strictness as the
// `--language-code` flag and the App Spec field. Before this gate the input-file path failed OPEN --
// resolveLanguageCode maps garbage to null and falls through to the org default -- so a typo like
// "1O33" (capital O for zero) produced ok:true with every label in the wrong language, no error and
// no warning, while the identical string was fatal on the flag path one line away.
test('languageCode in the provision input is validated, not silently discarded (#447)', () => {
  const base = { solution: { uniqueName: 'S', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_a', displayName: 'A', pluralName: 'As', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }],
    relationships: [] };
  for (const bad of ['1O33', 'de-DE', true, 0, -1, '1e3', 65536, 1033.5, [1033], {}]) {
    const r = validateProvisionInput({ ...base, languageCode: bad });
    assert.ok(
      (r.errors || []).some((e) => /languageCode must be a positive integer LCID/.test(e)),
      `languageCode=${JSON.stringify(bad)} must be REJECTED before any SDK write`
    );
  }
  for (const good of [1033, 1031, '1036', 1, 65535]) {
    const r = validateProvisionInput({ ...base, languageCode: good });
    assert.ok(!(r.errors || []).some((e) => /languageCode/.test(e)), `languageCode=${JSON.stringify(good)} must be accepted`);
  }
  // Absent stays valid — the field is optional and the org default is the normal case.
  assert.ok(!(validateProvisionInput(base).errors || []).some((e) => /languageCode/.test(e)));
});

// ---------------------------------------------------------------------------------------------
// #537 — this CLI is the SECOND entry point that accepts entities (the /genpage provisioning
// path). Validating only in validateAppSpec left the silent drop fully reproducible here: an
// entity-level languageCode returned ok:true and the table was then created with the org default.
// ---------------------------------------------------------------------------------------------

function provisionBase(entityExtra) {
  return {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [Object.assign({
      schemaName: 'cr_candidate', displayName: 'Candidate',
      primaryAttribute: { schemaName: 'cr_name' }, columns: [],
    }, entityExtra)],
    relationships: [],
  };
}

test('#537: provision input rejects entities[].languageCode and names the alternative', () => {
  const r = validateProvisionInput(provisionBase({ languageCode: 3082 }));
  assert.strictEqual(r.ok, false);
  const hit = r.errors.find((e) => /unknown key 'languageCode'/.test(e));
  assert.ok(hit, JSON.stringify(r.errors));
  assert.match(hit, /spec-level `languageCode`/);
});

test('#537: provision input rejects entities[].localizedLabels', () => {
  const r = validateProvisionInput(provisionBase({ localizedLabels: { 3082: 'Cliente' } }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown key 'localizedLabels'/.test(e)), JSON.stringify(r.errors));
});

test('#537: provision input rejects a misspelled entity key', () => {
  const r = validateProvisionInput(provisionBase({ pluralname: 'Candidates' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown key 'pluralname'/.test(e)), JSON.stringify(r.errors));
});

// The input is documented as "App Spec format", so entities copied out of an app-spec.json must
// still validate — including the keys this narrower path does not itself consume (icons, existing,
// enrichDefaultViews). Rejecting those would break the compatibility the format promises; they are
// a known subset boundary, not the unknown-key hole.
test('#537: provision input still accepts every App Spec table key', () => {
  const r = validateProvisionInput(provisionBase({
    pluralName: 'Candidates', description: 'A candidate.', hasNotes: true, quickCreate: true,
    existing: true, enrichDefaultViews: true,
    vectorIcon: 'cr_icon', iconDescription: 'a badge', icon: 'cr_iconpng',
    statusReasons: [], alternateKeys: [],
  }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('#537 review: provision-input reports the SAME invalid-LCID message as the App Spec validator', () => {
  // The entity-key rule is already shared between these two entry points; the top-level LCID message
  // was not, so the same bad value produced a helpful error on one path and a terse one on the other.
  const { validateProvisionInput } = require('../lib/provision-input.js');
  const r = validateProvisionInput({
    solution: { uniqueName: 'S', displayName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_t', displayName: 'T', pluralName: 'Ts', primaryAttribute: { schemaName: 'new_n', displayName: 'N' }, columns: [] }],
    relationships: [],
    languageCode: 'es-ES',
  });
  assert.strictEqual(r.ok, false);
  const msg = (r.errors || []).join(' | ');
  assert.match(msg, /1033|1031/, `should name a concrete LCID: ${msg}`);
  assert.match(msg, /language tag/, `should name the language-tag mistake: ${msg}`);
});

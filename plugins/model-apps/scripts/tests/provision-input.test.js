'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateProvisionInput } = require(path.join(__dirname, '..', 'lib', 'provision-input.js'));
const { provisionEntities } = require(path.join(__dirname, '..', 'provision-entities.js'));

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

// --- review follow-up: the OTHER public provisioning entry point ------------------------------
// The sample-data row-level gate was added to `validateAppSpec` only. `provision-entities` is a
// separate CLI that seeds through the SAME loader, and it checked only that the value was an
// array — so `null` still crashed at Object.keys and primitives were still spread into
// index-keyed "columns", AFTER the solution and data model had already been written.
test('sampleData rows get the same row-level gate as the app-builder path', () => {
  const mk = (rows) => ({
    solution: { uniqueName: 's', displayName: 'S', publisherPrefix: 'pp' },
    entities: [{ schemaName: 'pp_t', displayName: 'T', pluralName: 'Ts',
      primaryAttribute: { schemaName: 'pp_name', displayName: 'N' }, columns: [] }],
    sampleData: { pp_t: rows },
  });
  for (const [rows, want] of [[[null], 'null'], [['abc'], 'string'], [[42], 'number'], [[['x']], 'an array']]) {
    const r = validateProvisionInput(mk(rows));
    const hit = r.errors.filter((e) => /sampleData\[/.test(e));
    assert.strictEqual(hit.length, 1, `${JSON.stringify(rows)} must be rejected; got ${JSON.stringify(r.errors)}`);
    assert.match(hit[0], new RegExp(`got ${want}$`), `the offending type must be named; got ${hit[0]}`);
  }
  // The control: a real record object produces no sampleData error.
  const ok = validateProvisionInput(mk([{ pp_name: 'fine' }]));
  assert.deepStrictEqual(ok.errors.filter((e) => /sampleData\[/.test(e)), [],
    'a valid row must not be rejected');
});

// Guards below are the ones a subset test can delete without the happy-path cases noticing. Each
// refusal must name the field and must not reach the SDK: provisionEntities writes the solution
// before the data model, so a validator that fails open leaves a real solution behind.
function refusingDeps() {
  const calls = [];
  const trap = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return async () => {
        calls.push(String(prop));
        throw new Error(`unexpected SDK ${String(prop)}`);
      };
    },
  });
  return { calls, sdk: trap, provision: trap };
}

function baseEntity(extra = {}) {
  return Object.assign({
    schemaName: 'cr_candidate',
    displayName: 'Candidate',
    pluralName: 'Candidates',
    primaryAttribute: { schemaName: 'cr_name' },
    columns: [],
  }, extra);
}

function baseInput(extra = {}) {
  return Object.assign({
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [baseEntity()],
    relationships: [],
  }, extra);
}

const twoEntities = [
  baseEntity({ schemaName: 'cr_parent', displayName: 'Parent', pluralName: 'Parents' }),
  baseEntity({ schemaName: 'cr_child', displayName: 'Child', pluralName: 'Children' }),
];

test('malformed provisioning inputs return errors before writes', async () => {
  const cases = [
    ['null input', null, /input is not an object/],
    ['string input', 'not-an-object', /input is not an object/],
    ['solution null', baseInput({ solution: null }), /solution is required and must be an object/],
    ['solution uniqueName blank', baseInput({ solution: { uniqueName: '  ', publisherPrefix: 'cr' } }), /solution\.uniqueName is required and must be a non-empty string/],
    ['entities object', baseInput({ entities: {} }), /entities must be an array/],
    ['null entity', baseInput({ entities: [null] }), /each entity must be an object/],
    ['entity missing schemaName', baseInput({ entities: [{ displayName: 'Candidate' }] }), /entity\.schemaName is required and must be a string/],
    ['primaryAttribute null', baseInput({ entities: [baseEntity({ primaryAttribute: null })] }), /primaryAttribute is required and must be an object/],
    ['primaryAttribute missing schemaName', baseInput({ entities: [baseEntity({ primaryAttribute: { displayName: 'Name' } })] }), /primaryAttribute\.schemaName is required and must be a string/],
    ['null column', baseInput({ entities: [baseEntity({ columns: [null] })] }), /each column must be an object/],
    ['column missing schemaName', baseInput({ entities: [baseEntity({ columns: [{ type: 'Text' }] })] }), /column\.schemaName is required and must be a string/],
    ['choice without options', baseInput({ entities: [baseEntity({ columns: [{ schemaName: 'cr_status', type: 'Choice' }] })] }), /needs options\[\] or a globalChoice reference/],
    ['relationships null', baseInput({ relationships: null }), /relationships must be an array/],
    ['null relationship', baseInput({ relationships: [null] }), /each relationship must be an object/],
    ['1:N missing referenced', baseInput({ relationships: [{ type: 'OneToMany', referencing: 'cr_candidate', lookup: { schemaName: 'cr_parentid' } }] }), /OneToMany relationship: referenced entity is required/],
    ['1:N unknown referenced', baseInput({ relationships: [{ type: 'OneToMany', referenced: 'cr_missing', referencing: 'cr_candidate', lookup: { schemaName: 'cr_parentid' } }] }), /referenced entity 'cr_missing' not found in entities\[\]/],
    ['1:N missing referencing', baseInput({ relationships: [{ type: 'OneToMany', referenced: 'cr_candidate', lookup: { schemaName: 'cr_parentid' } }] }), /OneToMany relationship: referencing entity is required/],
    ['1:N unknown referencing', baseInput({ relationships: [{ type: 'OneToMany', referenced: 'cr_candidate', referencing: 'cr_missing', lookup: { schemaName: 'cr_parentid' } }] }), /referencing entity 'cr_missing' not found in entities\[\]/],
    ['1:N missing lookup', baseInput({ relationships: [{ type: 'OneToMany', referenced: 'cr_candidate', referencing: 'cr_candidate' }] }), /OneToMany relationship: lookup object is required/],
    ['1:N lookup missing schemaName', baseInput({ relationships: [{ type: 'OneToMany', referenced: 'cr_candidate', referencing: 'cr_candidate', lookup: {} }] }), /OneToMany relationship: lookup\.schemaName is required/],
    ['N:N missing entity1', baseInput({ entities: twoEntities, relationships: [{ type: 'ManyToMany', entity2: 'cr_child' }] }), /ManyToMany relationship: entity1 is required/],
    ['N:N unknown entity1', baseInput({ entities: twoEntities, relationships: [{ type: 'ManyToMany', entity1: 'cr_missing', entity2: 'cr_child' }] }), /entity1 'cr_missing' not found in entities\[\]/],
    ['N:N missing entity2', baseInput({ entities: twoEntities, relationships: [{ type: 'ManyToMany', entity1: 'cr_parent' }] }), /ManyToMany relationship: entity2 is required/],
    ['N:N unknown entity2', baseInput({ entities: twoEntities, relationships: [{ type: 'ManyToMany', entity1: 'cr_parent', entity2: 'cr_missing' }] }), /entity2 'cr_missing' not found in entities\[\]/],
    ['globalChoices not an array', baseInput({ globalChoices: {} }), /globalChoices must be an array when provided/],
    ['null globalChoice', baseInput({ globalChoices: [null] }), /each globalChoice must be an object/],
    ['globalChoice missing name', baseInput({ globalChoices: [{ options: ['Low'] }] }), /globalChoice\.name is required and must be a string/],
    ['globalChoice empty options', baseInput({ globalChoices: [{ name: 'cr_priority', options: [] }] }), /options must be a non-empty array/],
    ['sampleData array', baseInput({ sampleData: [] }), /sampleData must be an object keyed by entity schemaName when provided/],
    ['unknown sample table', baseInput({ sampleData: { cr_missing: [] } }), /sampleData: entity key 'cr_missing' not found in entities\[\]/],
    ['sample rows not an array', baseInput({ sampleData: { cr_candidate: { cr_name: 'Ada' } } }), /sampleData\['cr_candidate'\]: value must be an array of records/],
  ];

  for (const [label, input, pattern] of cases) {
    const validated = validateProvisionInput(input);
    assert.strictEqual(validated.ok, false, `${label} must be refused; got ${JSON.stringify(validated.errors)}`);
    assert.ok(validated.errors.some((e) => pattern.test(e)), `${label}: expected ${pattern} in ${JSON.stringify(validated.errors)}`);

    const deps = refusingDeps();
    const applied = await provisionEntities(input, { apply: true, sampleData: true }, deps);
    assert.strictEqual(applied.ok, false, `${label} must not apply`);
    assert.ok(applied.errors.some((e) => pattern.test(e)), `${label}: apply path dropped the error ${pattern}`);
    assert.deepStrictEqual(deps.calls, [], `${label} reached the SDK: ${deps.calls.join(',')}`);
  }

  // Object.keys is the inspection the unknown-key gate depends on. A throwing enumeration must be
  // a returned error, not an exception that skips the rest of the gate and proceeds to createTable.
  const explosive = new Proxy(baseEntity(), {
    ownKeys() { throw new Error('keys exploded'); },
  });
  const exploded = baseInput({ entities: [explosive] });
  const explodedCheck = validateProvisionInput(exploded);
  assert.ok(
    explodedCheck.errors.some((e) => e === "entity 'cr_candidate': could not be inspected — enumerating its keys threw"),
    JSON.stringify(explodedCheck.errors)
  );
  const explodedDeps = refusingDeps();
  const explodedApply = await provisionEntities(exploded, { apply: true }, explodedDeps);
  assert.strictEqual(explodedApply.ok, false);
  assert.deepStrictEqual(explodedDeps.calls, []);

  // Valid control: the same shapes, filled in, are not refused — and a real apply does write, so the
  // zero-call assertion above is not passing because the SDK double never records calls.
  const valid = {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [
      baseEntity({
        schemaName: 'cr_parent',
        displayName: 'Parent',
        pluralName: 'Parents',
        columns: [{ schemaName: 'cr_priority', type: 'Choice', globalChoice: 'cr_priority' }],
      }),
      baseEntity({ schemaName: 'cr_child', displayName: 'Child', pluralName: 'Children' }),
    ],
    relationships: [
      { type: 'OneToMany', schemaName: 'cr_parent_children', referenced: 'cr_parent', referencing: 'cr_child', lookup: { schemaName: 'cr_parentid' } },
      { type: 'ManyToMany', schemaName: 'cr_parent_child_nn', entity1: 'cr_parent', entity2: 'cr_child' },
    ],
    globalChoices: [{ name: 'cr_priority', options: ['Low', 'High'] }],
    sampleData: { cr_parent: [{ cr_name: 'Ada' }], cr_child: [] },
  };
  const accepted = validateProvisionInput(valid);
  assert.deepStrictEqual(accepted.errors, [], 'a complete input must not be refused');
  assert.strictEqual(accepted.ok, true);

  const writes = [];
  const sdk = {
    queryRecords: async () => [{ solutionid: 's' }],
    createTable: async (o) => { writes.push('createTable'); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: 'tbl' }; },
    createColumn: async (l, o) => { writes.push('createColumn'); return { logicalName: o.schemaName.toLowerCase(), metadataId: 'col' }; },
    createGlobalOptionSet: async () => ({ metadataId: 'g' }),
    createRelationship: async (o) => ({ schemaName: o.schemaName, metadataId: 'rel' }),
    createRecordsBulk: async () => [],
    seedRecordGraph: async () => ({ createdIds: {} }),
  };
  const provision = {
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    queryRecords: async () => [{ solutionid: 's', languagecode: 1033 }],
  };
  const applied = await provisionEntities(baseInput(), { apply: true }, { sdk, provision });
  assert.strictEqual(applied.ok, true, JSON.stringify(applied.errors || applied));
  assert.ok(writes.includes('createTable'), 'the valid control must be able to observe an SDK write');
});

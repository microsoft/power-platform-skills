'use strict';
// A relationship is called the one the spec declares — reused by the build, present for verify — only when the
// environment's answer states its whole identity: its schema name, its type, both of its tables and, for a 1:N, the
// lookup column, for an N:N the intersect table and the column each table has in it. A part the answer leaves out is
// not "nothing contradicts": it is a part nobody checked, and a relationship whose name matches while its ends are
// unstated has not been shown to be the declared one.
//
// The inputs are the shapes a SUCCESSFUL answer takes with part of that missing: a collection row without its
// referencing table and lookup (for an N:N, without its intersect table), and a typed read that answers 200 with an
// empty body (or without the intersect table) after a create collided on the name; and, for an N:N, a complete answer
// on another intersect table than the spec names. The first group is the rule itself; the next groups drive the build,
// the dry run and verify with the fakes those shapes need; the last runs the real vendored bundle over a stub transport.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { makeRunner, provisionDataModel, relationshipExists } = require('../lib/entity-provision.js');
const { compareRelationship, sameRelationship } = require('../lib/relationship-metadata.js');
const { annotateLivePlan } = require('../lib/sdk-build.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { readerFor } = require('../verify-model-app.js');
const { isTransientHalt } = require('../build-model-app.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const SCHEMA = 'contoso_project_contoso_task';

const ONE_TO_MANY = {
  type: 'OneToMany', schemaName: SCHEMA, referenced: 'contoso_project', referencing: 'contoso_task',
  lookup: { schemaName: 'contoso_ProjectId', displayName: 'Project' },
};
const MANY_TO_MANY = { type: 'ManyToMany', schemaName: SCHEMA, entity1: 'contoso_project', entity2: 'contoso_task' };
// The same N:N with the intersect table the spec names (`intersectEntityName`). The SDK creates the intersect table under that name, and
// under the relationship's own lower-cased schema name when the spec names none.
const INTERSECT = 'contoso_project_task_links';
const MANY_TO_MANY_LINKED = { ...MANY_TO_MANY, intersectEntityName: INTERSECT };
const HOLDER_1N = {
  schemaName: SCHEMA, type: 'OneToMany', referencedEntity: 'contoso_project', referencingEntity: 'contoso_task', referencingAttribute: 'contoso_projectid',
};
const HOLDER_NN = {
  schemaName: SCHEMA, type: 'ManyToMany', entity1: 'contoso_task', entity2: 'contoso_project',
  intersectEntityName: INTERSECT, entity1IntersectAttribute: 'contoso_taskid', entity2IntersectAttribute: 'contoso_projectid',
};

const specOf = (...relationships) => ({ solution: { uniqueName: 'Offline', publisherPrefix: 'contoso' }, entities: [], relationships });

// ── 1. The rule ─────────────────────────────────────────────────────────────────────────────────────────────────

test('identity: a complete holder is the same relationship whatever its case, and an N:N whichever order its tables come in', () => {
  const shouting = { schemaName: SCHEMA.toUpperCase(), type: 'OneToMany', referencedEntity: 'CONTOSO_PROJECT', referencingEntity: 'Contoso_Task', referencingAttribute: 'CONTOSO_PROJECTID' };
  assert.strictEqual(sameRelationship(ONE_TO_MANY, shouting), true);
  assert.strictEqual(sameRelationship(MANY_TO_MANY, HOLDER_NN), true, 'the pair is unordered');
  assert.deepStrictEqual(compareRelationship(ONE_TO_MANY, shouting), { state: 'same', missing: [] });
  assert.deepStrictEqual(compareRelationship(MANY_TO_MANY, HOLDER_NN), { state: 'same', missing: [] });
});

test('identity: a part the holder does not state leaves the relationship unproven — each part, whether missing, empty or null', () => {
  const cases = [
    [ONE_TO_MANY, HOLDER_1N, 'schemaName', 'schema name'],
    [ONE_TO_MANY, HOLDER_1N, 'referencedEntity', 'referenced table'],
    [ONE_TO_MANY, HOLDER_1N, 'referencingEntity', 'referencing table'],
    [ONE_TO_MANY, HOLDER_1N, 'referencingAttribute', 'lookup column'],
    [MANY_TO_MANY, HOLDER_NN, 'schemaName', 'schema name'],
    [MANY_TO_MANY, HOLDER_NN, 'entity1', 'first table'],
    [MANY_TO_MANY, HOLDER_NN, 'entity2', 'second table'],
  ];
  // An empty string is what the vendored SDK's own relationship projection writes for a value the answer lacked.
  for (const [declared, holder, field, part] of cases) {
    for (const absent of [undefined, '', null]) {
      const partial = { ...holder, [field]: absent };
      assert.strictEqual(sameRelationship(declared, partial), false, `${field} = ${JSON.stringify(absent)} is no proof`);
      assert.deepStrictEqual(compareRelationship(declared, partial), { state: 'incomplete', missing: [part] }, `${field} = ${JSON.stringify(absent)}`);
    }
  }
});

test('identity: a holder that says nothing about itself is unproven, not "nothing contradicts"', () => {
  for (const holder of [{}, { schemaName: SCHEMA }, { schemaName: SCHEMA, type: 'OneToMany' }, { type: 'OneToMany' }]) {
    assert.strictEqual(sameRelationship(ONE_TO_MANY, holder), false, JSON.stringify(holder));
    assert.strictEqual(compareRelationship(ONE_TO_MANY, holder).state, 'incomplete', JSON.stringify(holder));
  }
  assert.ok(compareRelationship(ONE_TO_MANY, { schemaName: SCHEMA }).missing.includes('relationship type'), 'a name alone does not even say which kind it is');
  assert.strictEqual(sameRelationship(MANY_TO_MANY, { schemaName: SCHEMA, type: 'ManyToMany', entity1: 'contoso_project' }), false, 'an N:N that names one table');
  for (const holder of [null, undefined, SCHEMA]) assert.strictEqual(sameRelationship(ONE_TO_MANY, holder), false);
});

test('identity: a part that differs makes a different relationship, even when other parts are unstated', () => {
  const cases = {
    'another lookup and no referencing table': { ...HOLDER_1N, referencingAttribute: 'contoso_ownerid', referencingEntity: undefined },
    'another referenced table and nothing else': { schemaName: SCHEMA, type: 'OneToMany', referencedEntity: 'contoso_other' },
    'another schema name': { ...HOLDER_1N, schemaName: 'contoso_other_contoso_task' },
    'an N:N under the name of a 1:N': { schemaName: SCHEMA, type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_task' },
  };
  for (const [what, holder] of Object.entries(cases)) {
    assert.strictEqual(sameRelationship(ONE_TO_MANY, holder), false, what);
    assert.strictEqual(compareRelationship(ONE_TO_MANY, holder).state, 'different', what);
  }
  assert.strictEqual(compareRelationship(MANY_TO_MANY, { schemaName: SCHEMA, type: 'ManyToMany', entity1: 'contoso_tag' }).state, 'different', 'a table the declared pair does not have');
  assert.strictEqual(compareRelationship(MANY_TO_MANY, { ...HOLDER_NN, entity2: 'contoso_tag' }).state, 'different');
});

test('identity: an N:N is compared on the tables each side states, and a self-referencing one names its table twice', () => {
  const self = { type: 'ManyToMany', schemaName: 'contoso_item_contoso_item', entity1: 'contoso_item', entity2: 'contoso_item' };
  const held = {
    schemaName: 'contoso_item_contoso_item', type: 'ManyToMany', entity1: 'Contoso_Item', entity2: 'contoso_item',
    intersectEntityName: 'contoso_item_contoso_item', entity1IntersectAttribute: 'contoso_itemidone', entity2IntersectAttribute: 'contoso_itemidtwo',
  };
  assert.strictEqual(sameRelationship(self, held), true);
  assert.strictEqual(compareRelationship(self, { ...held, entity2: 'contoso_other' }).state, 'different');
  // A declaration that names one table is held to that one, and the holder still has to state both of its own.
  const named = { type: 'ManyToMany', schemaName: SCHEMA, entity1: 'contoso_project' };
  assert.strictEqual(compareRelationship(named, HOLDER_NN).state, 'same');
  assert.strictEqual(compareRelationship({ ...named, entity1: 'contoso_tag' }, HOLDER_NN).state, 'different');
  assert.deepStrictEqual(compareRelationship(named, { ...HOLDER_NN, entity1: undefined }), { state: 'incomplete', missing: ['first table'] });
});

test('identity: an N:N states its intersect table and the column each table has in it, or it is unproven — each part, whether missing, empty or null', () => {
  const parts = [
    ['intersectEntityName', 'intersect table'],
    ['entity1IntersectAttribute', 'first intersect column'],
    ['entity2IntersectAttribute', 'second intersect column'],
  ];
  // Whether or not the spec names an intersect table: the answer has to state its own.
  for (const declared of [MANY_TO_MANY, MANY_TO_MANY_LINKED]) {
    for (const [field, part] of parts) {
      for (const absent of [undefined, '', null]) {
        const partial = { ...HOLDER_NN, [field]: absent };
        assert.strictEqual(sameRelationship(declared, partial), false, `${field} = ${JSON.stringify(absent)} is no proof`);
        assert.deepStrictEqual(compareRelationship(declared, partial), { state: 'incomplete', missing: [part] }, `${field} = ${JSON.stringify(absent)}`);
      }
    }
  }
  // What the narrow reads used to ask for — the name and the two tables — is not the whole identity of an N:N.
  const bare = { schemaName: SCHEMA, type: 'ManyToMany', entity1: 'contoso_task', entity2: 'contoso_project' };
  assert.deepStrictEqual(compareRelationship(MANY_TO_MANY_LINKED, bare), { state: 'incomplete', missing: ['intersect table', 'first intersect column', 'second intersect column'] });
  assert.strictEqual(sameRelationship(MANY_TO_MANY_LINKED, bare), false);
});

test('identity: an N:N on another intersect table than the one the spec names is a different relationship, whatever else the answer leaves out', () => {
  const other = { ...HOLDER_NN, intersectEntityName: 'contoso_other_links' };
  assert.strictEqual(sameRelationship(MANY_TO_MANY_LINKED, other), false);
  assert.deepStrictEqual(compareRelationship(MANY_TO_MANY_LINKED, other), { state: 'different', missing: [] });
  // A contradiction is a proof, whatever else is unstated.
  const sparse = { schemaName: SCHEMA, type: 'ManyToMany', intersectEntityName: 'contoso_other_links' };
  assert.strictEqual(compareRelationship(MANY_TO_MANY_LINKED, sparse).state, 'different');
  // The platform lower-cases the name of a table, so the comparison does not tell cases apart.
  assert.strictEqual(compareRelationship(MANY_TO_MANY_LINKED, { ...HOLDER_NN, intersectEntityName: INTERSECT.toUpperCase() }).state, 'same');
  assert.strictEqual(compareRelationship({ ...MANY_TO_MANY, intersectEntityName: 'Contoso_Project_Task_Links' }, HOLDER_NN).state, 'same');
});

test('identity: a spec that names no intersect table is held to none — any intersect table the answer states is the declared relationship', () => {
  // The reference says "intersect auto-named", a download never writes one, and a relationship adopted from the environment (`existing: true`)
  // has the intersect table its maker chose: none of them contradicts a spec that is silent about it.
  for (const intersect of ['contoso_other_links', SCHEMA, 'systemuserroles']) {
    assert.deepStrictEqual(compareRelationship(MANY_TO_MANY, { ...HOLDER_NN, intersectEntityName: intersect }), { state: 'same', missing: [] }, intersect);
  }
  // …and an authored one is the only thing that makes another intersect table a contradiction. Another part still does.
  assert.strictEqual(compareRelationship(MANY_TO_MANY, { ...HOLDER_NN, entity2: 'contoso_tag' }).state, 'different');
});

test('identity: the intersect table is read from the answer however it is spelled, and a 1:N is not asked for one', () => {
  const raw = {
    SchemaName: SCHEMA, RelationshipType: 'ManyToManyRelationship', Entity1LogicalName: 'contoso_task', Entity2LogicalName: 'contoso_project',
    IntersectEntityName: INTERSECT, Entity1IntersectAttribute: 'contoso_taskid', Entity2IntersectAttribute: 'contoso_projectid',
  };
  assert.strictEqual(compareRelationship(MANY_TO_MANY_LINKED, raw).state, 'same');
  assert.strictEqual(compareRelationship(MANY_TO_MANY_LINKED, { ...raw, IntersectEntityName: 'contoso_other_links' }).state, 'different');
  assert.deepStrictEqual(compareRelationship(MANY_TO_MANY_LINKED, { ...raw, IntersectEntityName: undefined }), { state: 'incomplete', missing: ['intersect table'] });
  assert.deepStrictEqual(compareRelationship(ONE_TO_MANY, HOLDER_1N), { state: 'same', missing: [] }, 'a complete 1:N still needs no intersect table');
});

// ── 2. What the environment says ────────────────────────────────────────────────────────────────────────────────
// The three reads the build and verify make of a relationship, in the shapes the platform answers them (a contoso name):
//   GET /EntityDefinitions(LogicalName='contoso_project')/OneToManyRelationships?$select=SchemaName,ReferencingEntity,ReferencingAttribute
//     → 200 { "value": [ { "SchemaName": "contoso_project_contoso_task", "ReferencingEntity": "contoso_task", "ReferencingAttribute": "contoso_projectid" } ] }
//   GET /RelationshipDefinitions(SchemaName='contoso_project_contoso_task')?$select=SchemaName,RelationshipType
//     → 200 { "SchemaName": "contoso_project_contoso_task", "RelationshipType": "OneToManyRelationship" }
//   GET /RelationshipDefinitions(SchemaName='contoso_project_contoso_task')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute
//     → 200 { "SchemaName": "contoso_project_contoso_task", "ReferencedEntity": "contoso_project", "ReferencingEntity": "contoso_task", "ReferencingAttribute": "contoso_projectid" }
// and for an N:N: …/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity2LogicalName,IntersectEntityName,Entity1IntersectAttribute,Entity2IntersectAttribute
//     → 200 { "value": [ { "SchemaName": "contoso_project_contoso_task", "Entity1LogicalName": "contoso_project", "Entity2LogicalName": "contoso_task",
//                          "IntersectEntityName": "contoso_project_task_links", "Entity1IntersectAttribute": "contoso_projectid", "Entity2IntersectAttribute": "contoso_taskid" } ] }
// RelationshipType "ManyToManyRelationship", and the ManyToManyRelationshipMetadata cast with the same six properties.
const BASE_1N = { SchemaName: SCHEMA, RelationshipType: 'OneToManyRelationship' };
const BASE_NN = { SchemaName: SCHEMA, RelationshipType: 'ManyToManyRelationship' };
const ROW_1N = { SchemaName: SCHEMA, ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' };
const ROW_NN = {
  SchemaName: SCHEMA, Entity1LogicalName: 'contoso_project', Entity2LogicalName: 'contoso_task',
  IntersectEntityName: INTERSECT, Entity1IntersectAttribute: 'contoso_projectid', Entity2IntersectAttribute: 'contoso_taskid',
};
// What a row without its intersect identity looks like: the name and the two tables, and nothing about the table that holds the links.
const ROW_NN_BARE = { SchemaName: SCHEMA, Entity1LogicalName: 'contoso_project', Entity2LogicalName: 'contoso_task' };
const ROW_NN_OTHER = { ...ROW_NN, IntersectEntityName: 'contoso_other_links' };

// An environment: what each collection lists, and what the keyed read of the name and its typed cast answer. A keyed read
// that is not given answers 404, as the platform does for a name it does not hold.
function environment({ oneToMany = [], manyToOne = [], manyToMany = [], base, cast, onRead } = {}) {
  return (url) => {
    if (onRead) { const answer = onRead(url); if (answer) return answer; }
    if (/\/OneToManyRelationships\?/.test(url)) return { status: 200, body: { value: oneToMany } };
    if (/\/ManyToOneRelationships\?/.test(url)) return { status: 200, body: { value: manyToOne } };
    if (/\/ManyToManyRelationships\?/.test(url)) return { status: 200, body: { value: manyToMany } };
    if (/^\/RelationshipDefinitions\(SchemaName='[^']*'\)\?\$select=SchemaName,RelationshipType$/.test(url)) {
      return base ? { status: 200, body: base } : { status: 404, body: { error: { code: '0x80060888', message: 'RelationshipMetadataBase With Id does not exist.' } } };
    }
    if (/^\/RelationshipDefinitions\(SchemaName='[^']*'\)\/Microsoft\.Dynamics\.CRM\./.test(url)) {
      return cast !== undefined ? { status: 200, body: cast } : { status: 404, body: { error: { code: '0x80060888', message: 'does not exist' } } };
    }
    return { status: 200, body: { value: [] } };
  };
}

// The four answers the 1:N build and verify are held to: a complete match, a complete row on another lookup, a row without
// its referencing table and lookup, and a typed read that answers an empty body after the name collided.
const SHAPES = {
  'complete-same': environment({ oneToMany: [ROW_1N], manyToOne: [ROW_1N], base: BASE_1N, cast: ROW_1N }),
  'complete-wrong-lookup': environment({ oneToMany: [{ ...ROW_1N, ReferencingAttribute: 'contoso_ownerid' }], manyToOne: [{ ...ROW_1N, ReferencingAttribute: 'contoso_ownerid' }], base: BASE_1N, cast: { ...ROW_1N, ReferencingAttribute: 'contoso_ownerid' } }),
  'missing-end-and-lookup': (() => {
    const row = { SchemaName: SCHEMA, ReferencedEntity: 'contoso_project' };
    return environment({ oneToMany: [row], manyToOne: [row], base: BASE_1N, cast: row });
  })(),
  'malformed-cast': environment({ oneToMany: [], manyToOne: [], base: BASE_1N, cast: {} }),
};

// A real answer holds only the properties the request selected (`$select=SchemaName,Entity1LogicalName,…`), so this gives a row only what was
// asked for: a read that leaves a property out of its select can never be told it. The N:N fakes below go through it, because the whole of
// an N:N's identity has to be ASKED for — a fake that handed over the full row whatever was selected would pass a build that never asked.
function selecting(answer) {
  return (url) => {
    const reply = answer(url);
    const asked = /[?&]\$select=([^&]*)/.exec(url);
    if (!asked || !reply || reply.status !== 200) return reply;
    const keep = new Set(asked[1].split(','));
    const only = (row) => (row && typeof row === 'object' ? Object.fromEntries(Object.entries(row).filter(([key]) => keep.has(key))) : row);
    const body = reply.body;
    return { ...reply, body: body && Array.isArray(body.value) ? { ...body, value: body.value.map(only) } : only(body) };
  };
}

// The answers the N:N build and verify are held to, each on both ways a holder is read: from the collection of its table (`row`), and from
// the keyed read of its name and its typed cast, which is what the build falls back on after its create collided (`cast`).
const nnEnvironment = (row, how) => selecting(environment(how === 'row' ? { manyToMany: [row], base: BASE_NN, cast: row } : { base: BASE_NN, cast: row }));
const NN_SHAPES = {
  'complete-row': nnEnvironment(ROW_NN, 'row'),
  'complete-cast': nnEnvironment(ROW_NN, 'cast'),
  'missing-intersect-row': nnEnvironment(ROW_NN_BARE, 'row'),
  'missing-intersect-cast': nnEnvironment(ROW_NN_BARE, 'cast'),
  'wrong-intersect-row': nnEnvironment(ROW_NN_OTHER, 'row'),
  'wrong-intersect-cast': nnEnvironment(ROW_NN_OTHER, 'cast'),
};

// The build's data-model step over fakes whose create ALWAYS collides on the name, so that a relationship the probe could
// not prove has only its re-read to be reused by. `reads` is every request path the build made, `creates` every create it tried.
async function runBuild({ spec, answer, sleeps = [] }) {
  const events = [];
  const reads = [];
  const creates = [];
  const sdk = {
    createRelationship: async (o) => {
      creates.push(o.schemaName);
      const err = new Error('Relationship with the same name already exists');
      err.statusCode = 409;
      throw err;
    },
  };
  const provision = {
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    dataverse: { get: async (url) => { reads.push(url); return answer(url); } },
  };
  let result;
  let error;
  try {
    result = await provisionDataModel({ sdk, provision, runner: makeRunner({ emit: (e) => events.push(e), total: 8 }), spec, apply: true, sleep: async (ms) => { sleeps.push(ms); } });
  } catch (e) { error = e; }
  return { result, error, events, reads, creates, sleeps };
}
const reused = (run) => run.events.some((e) => e.status === 'skip' && /\(exists\)/.test(e.label));

// ── 3. The build ────────────────────────────────────────────────────────────────────────────────────────────────

test('build: a complete matching relationship is reused, proven by its own row, and nothing is created', async () => {
  const run = await runBuild({ spec: specOf(ONE_TO_MANY), answer: SHAPES['complete-same'] });
  assert.strictEqual(run.error, undefined);
  assert.ok(reused(run), JSON.stringify(run.events));
  assert.deepStrictEqual(run.creates, []);
  // The healthy path costs what it always did: one narrow collection read — no re-read of the relationship, no create.
  assert.deepStrictEqual(run.reads, ["/EntityDefinitions(LogicalName='contoso_project')/OneToManyRelationships?$select=SchemaName,ReferencingEntity,ReferencingAttribute"]);
});

test('build: a complete relationship on another lookup halts — the name is held by a different relationship', async () => {
  const run = await runBuild({ spec: specOf(ONE_TO_MANY), answer: SHAPES['complete-wrong-lookup'] });
  assert.ok(run.error);
  assert.strictEqual(run.error.code, 'relationship-name-taken');
  assert.match(run.error.message, /already used by 1:N contoso_project -> contoso_task \(lookup contoso_ownerid\)/);
  assert.strictEqual(isTransientHalt(run.error), false);
  assert.deepStrictEqual(run.creates, []);
});

test('build: a relationship whose row leaves out its referencing table and lookup is not reused — the exact read is no better, so the build halts', async () => {
  const run = await runBuild({ spec: specOf(ONE_TO_MANY), answer: SHAPES['missing-end-and-lookup'] });
  assert.ok(run.error, 'a relationship nobody could identify must not be skipped as reused');
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.match(run.error.message, /relationship schema name 'contoso_project_contoso_task' already exists, but the environment's answer for it is incomplete/);
  assert.match(run.error.message, /does not state its referencing table and its lookup column/);
  assert.match(run.error.message, /declared 1:N contoso_project -> contoso_task \(lookup contoso_projectid\)/);
  assert.ok(run.reads.some((u) => /OneToManyRelationshipMetadata/.test(u)), 'the relationship was re-read before the build gave up');
  assert.strictEqual(isTransientHalt(run.error), false, 'a run again reads the same answer');
  assert.strictEqual(run.error.cause && run.error.cause.transient, false);
});

test('build: a typed read that answers 200 with an empty body after the name collided halts — the name alone is not proof', async () => {
  const run = await runBuild({ spec: specOf(ONE_TO_MANY), answer: SHAPES['malformed-cast'] });
  assert.ok(run.error, 'an empty answer is not the declared relationship');
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.deepStrictEqual(run.creates, [SCHEMA], 'the create was tried, collided, and its holder was read');
  assert.match(run.error.message, /already exists, but the environment's answer for it is incomplete/);
  assert.match(run.error.message, /does not state its schema name, its referenced table, its referencing table and its lookup column/);
  assert.strictEqual(isTransientHalt(run.error), false);
});

test('build: a row that leaves out its ends is completed by a re-read of the relationship, and then reused', async () => {
  const run = await runBuild({
    spec: specOf(ONE_TO_MANY),
    answer: environment({ oneToMany: [{ SchemaName: SCHEMA }], base: BASE_1N, cast: ROW_1N }),
  });
  assert.strictEqual(run.error, undefined, run.error && run.error.message);
  assert.ok(reused(run), JSON.stringify(run.events));
  assert.ok(run.reads.some((u) => /OneToManyRelationshipMetadata/.test(u)), 'the proof came from reading the relationship itself');
});

test('build: an N:N row that names only one of its tables is not reused; its re-read completes it, or the build halts', async () => {
  const half = { SchemaName: SCHEMA, Entity1LogicalName: 'contoso_project' };
  const halted = await runBuild({ spec: specOf({ ...MANY_TO_MANY }), answer: environment({ manyToMany: [half], base: BASE_NN, cast: half }) });
  assert.ok(halted.error, 'half an N:N is not the declared N:N');
  assert.ok(!reused(halted), JSON.stringify(halted.events));
  assert.match(halted.error.message, /does not state its second table/);
  assert.match(halted.error.message, /declared N:N contoso_project <-> contoso_task/);

  const completed = await runBuild({ spec: specOf({ ...MANY_TO_MANY }), answer: environment({ manyToMany: [half], base: BASE_NN, cast: ROW_NN }) });
  assert.strictEqual(completed.error, undefined, completed.error && completed.error.message);
  assert.ok(reused(completed), JSON.stringify(completed.events));
});

test('build N:N: a complete matching N:N is reused, proven by its own row — the one narrow read it always cost, and no create', async () => {
  for (const [what, spec] of [['a spec that names its intersect table', specOf(MANY_TO_MANY_LINKED)], ['a spec that leaves it to the platform', specOf(MANY_TO_MANY)]]) {
    const run = await runBuild({ spec, answer: NN_SHAPES['complete-row'] });
    assert.strictEqual(run.error, undefined, `${what}: ${run.error && run.error.message}`);
    assert.ok(reused(run), `${what}: ${JSON.stringify(run.events)}`);
    assert.deepStrictEqual(run.creates, [], what);
    assert.strictEqual(run.reads.length, 1, `${what}: no re-read and no create — ${run.reads.join(' | ')}`);
    assert.match(run.reads[0], /^\/EntityDefinitions\(LogicalName='contoso_project'\)\/ManyToManyRelationships\?\$select=/);
  }
});

test('build N:N: the narrow reads ask for the whole identity of an N:N — its intersect table and the column each table has in it', async () => {
  // The collection read, and — after a create that collided — the keyed read of the name and its typed cast.
  const run = await runBuild({ spec: specOf(MANY_TO_MANY_LINKED), answer: NN_SHAPES['complete-cast'] });
  assert.strictEqual(run.error, undefined, run.error && run.error.message);
  const selectOf = (pattern) => {
    const url = run.reads.find((read) => pattern.test(read));
    return url ? url.split('$select=')[1].split(',') : [];
  };
  for (const [read, props] of [['the collection read', selectOf(/ManyToManyRelationships\?/)], ['the typed read', selectOf(/ManyToManyRelationshipMetadata\?/)]]) {
    assert.ok(props.length > 0, `${read} was made`);
    for (const prop of ['SchemaName', 'Entity1LogicalName', 'Entity2LogicalName', 'IntersectEntityName', 'Entity1IntersectAttribute', 'Entity2IntersectAttribute']) {
      assert.ok(props.includes(prop), `${read} asks for ${prop}: ${props.join(',')}`);
    }
  }
});

test('build N:N: a row that does not state its intersect table is not reused — the exact read is no better, so the build halts', async () => {
  const run = await runBuild({ spec: specOf(MANY_TO_MANY_LINKED), answer: NN_SHAPES['missing-intersect-row'] });
  assert.ok(run.error, 'an N:N whose intersect table nobody stated must not be skipped as reused');
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.deepStrictEqual(run.creates, [SCHEMA], 'the create was tried, collided, and its holder was read');
  assert.match(run.error.message, /relationship schema name 'contoso_project_contoso_task' already exists, but the environment's answer for it is incomplete/);
  assert.match(run.error.message, /does not state its intersect table, its first intersect column and its second intersect column/);
  assert.match(run.error.message, /declared N:N contoso_project <-> contoso_task \(intersect contoso_project_task_links\)/);
  assert.ok(run.reads.some((u) => /ManyToManyRelationshipMetadata/.test(u)), 'the relationship was re-read before the build gave up');
  assert.strictEqual(isTransientHalt(run.error), false, 'a run again reads the same answer');
});

test('build N:N: a typed read that leaves out the intersect table after the name collided halts too — whether or not the spec names one', async () => {
  for (const spec of [specOf(MANY_TO_MANY_LINKED), specOf(MANY_TO_MANY)]) {
    const run = await runBuild({ spec, answer: NN_SHAPES['missing-intersect-cast'] });
    assert.ok(run.error, 'a name alone is not proof');
    assert.ok(!reused(run), JSON.stringify(run.events));
    assert.deepStrictEqual(run.creates, [SCHEMA]);
    assert.match(run.error.message, /already exists, but the environment's answer for it is incomplete \(it does not state its intersect table, its first intersect column and its second intersect column\)/);
    assert.strictEqual(isTransientHalt(run.error), false);
  }
});

test('build N:N: an empty typed read after the name collided halts — the tables alone are not the declared N:N either', async () => {
  const run = await runBuild({ spec: specOf(MANY_TO_MANY_LINKED), answer: selecting(environment({ base: BASE_NN, cast: {} })) });
  assert.ok(run.error);
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.match(run.error.message, /does not state its schema name, its first table, its second table, its intersect table, its first intersect column and its second intersect column/);
});

test('build N:N: each part of the intersect identity is needed — an answer that leaves out any one of them is not reused', async () => {
  for (const part of ['IntersectEntityName', 'Entity1IntersectAttribute', 'Entity2IntersectAttribute']) {
    const row = { ...ROW_NN };
    delete row[part];
    const run = await runBuild({ spec: specOf(MANY_TO_MANY_LINKED), answer: nnEnvironment(row, 'row') });
    assert.ok(run.error, `${part} left out`);
    assert.ok(!reused(run), `${part} left out: ${JSON.stringify(run.events)}`);
    assert.match(run.error.message, /already exists, but the environment's answer for it is incomplete/, part);
  }
});

test('build N:N: a row that leaves out its intersect identity is completed by a re-read of the relationship, and then reused', async () => {
  const run = await runBuild({ spec: specOf(MANY_TO_MANY_LINKED), answer: selecting(environment({ manyToMany: [ROW_NN_BARE], base: BASE_NN, cast: ROW_NN })) });
  assert.strictEqual(run.error, undefined, run.error && run.error.message);
  assert.ok(reused(run), JSON.stringify(run.events));
  assert.ok(run.reads.some((u) => /ManyToManyRelationshipMetadata/.test(u)), 'the proof came from reading the relationship itself');
});

test('build N:N: an N:N on another intersect table halts — the name is held by a different relationship, and nothing is created', async () => {
  const run = await runBuild({ spec: specOf(MANY_TO_MANY_LINKED), answer: NN_SHAPES['wrong-intersect-row'] });
  assert.ok(run.error);
  assert.strictEqual(run.error.code, 'relationship-name-taken');
  assert.match(run.error.message, /already used by N:N contoso_project <-> contoso_task \(intersect contoso_other_links\)/);
  assert.match(run.error.message, /the spec declares N:N contoso_project <-> contoso_task \(intersect contoso_project_task_links\)/);
  assert.match(run.error.message, /Set "intersectEntityName" to 'contoso_other_links' \(or leave it out\) to reuse that relationship, or give the declared one an explicit "schemaName" to create another\./);
  assert.strictEqual(isTransientHalt(run.error), false);
  assert.deepStrictEqual(run.creates, []);
});

test('build N:N: the same on the exact read, after the create collided — a complete answer on another intersect table is refused', async () => {
  const run = await runBuild({ spec: specOf(MANY_TO_MANY_LINKED), answer: NN_SHAPES['wrong-intersect-cast'] });
  assert.ok(run.error);
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.deepStrictEqual(run.creates, [SCHEMA]);
  assert.match(run.error.message, /is already used by N:N contoso_project <-> contoso_task \(intersect contoso_other_links\); the spec declares N:N contoso_project <-> contoso_task \(intersect contoso_project_task_links\)/);
  assert.match(run.error.message, /Set "intersectEntityName" to 'contoso_other_links' \(or leave it out\) to reuse that relationship/);
  assert.strictEqual(isTransientHalt(run.error), false);
});

test('build N:N: an N:N on another intersect table and ANOTHER table is not offered as reusable by naming its intersect table', async () => {
  const elsewhere = { ...ROW_NN_OTHER, Entity2LogicalName: 'contoso_tag' };
  const run = await runBuild({ spec: specOf(MANY_TO_MANY_LINKED), answer: nnEnvironment(elsewhere, 'row') });
  assert.ok(run.error);
  assert.strictEqual(run.error.code, 'relationship-name-taken');
  assert.doesNotMatch(run.error.message, /intersectEntityName/);
  assert.match(run.error.message, /Give it an explicit "schemaName"\./);
});

test('build N:N: a spec that names no intersect table reuses the relationship whichever one it has, as long as the answer states it', async () => {
  // A relationship adopted from the environment (`existing: true`) or made elsewhere has the intersect table its maker chose, and the spec says nothing against it.
  const run = await runBuild({ spec: specOf(MANY_TO_MANY), answer: NN_SHAPES['wrong-intersect-row'] });
  assert.strictEqual(run.error, undefined, run.error && run.error.message);
  assert.ok(reused(run), JSON.stringify(run.events));
  assert.deepStrictEqual(run.creates, []);
  const adopted = await runBuild({ spec: specOf({ ...MANY_TO_MANY, existing: true }), answer: NN_SHAPES['wrong-intersect-cast'] });
  assert.strictEqual(adopted.error, undefined, adopted.error && adopted.error.message);
  assert.ok(reused(adopted), JSON.stringify(adopted.events));
});

test('build: a lookup owner that carries the declared name but not its referenced table halts instead of being skipped', async () => {
  // The name is free on every read of the holder, and then the child's ManyToOne list shows the lookup under the declared name
  // with no ReferencedEntity: the lag case, whose row has to be the declared relationship to be skipped.
  let childReads = 0;
  const run = await runBuild({
    spec: specOf(ONE_TO_MANY),
    answer: environment({
      onRead: (url) => {
        if (/LogicalName='contoso_task'\)\/ManyToOneRelationships\?/.test(url)) {
          childReads += 1;
          return { status: 200, body: { value: childReads < 2 ? [] : [{ SchemaName: SCHEMA, ReferencingAttribute: 'contoso_projectid' }] } };
        }
        return null;
      },
    }),
  });
  assert.ok(run.error, 'a row without its referenced table is not the declared relationship');
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.match(run.error.message, /does not state its referenced table/);
  assert.deepStrictEqual(run.sleeps, [], 'a known lookup owner is not a lag re-read');
});

test('build: a holder that shows up on a later read without its ends halts at once — it is not waited for again', async () => {
  let keyed = 0;
  const run = await runBuild({
    spec: specOf(ONE_TO_MANY),
    answer: environment({
      base: BASE_1N,
      cast: {},
      onRead: (url) => {
        if (!/^\/RelationshipDefinitions\(/.test(url)) return null;
        keyed += 1;
        return keyed === 1 ? { status: 404, body: { error: { code: '0x80060888', message: 'RelationshipMetadataBase With Id does not exist.' } } } : null;
      },
    }),
  });
  assert.ok(run.error, 'an answer that cannot be told from the declared relationship is not proof');
  assert.match(run.error.message, /already exists, but the environment's answer for it is incomplete/);
  assert.deepStrictEqual(run.sleeps, [2000], 'one wait for the name to show up, none after it did');
});

test('relationshipExists: a row that does not state its ends is inconclusive, a complete one is the relationship, another lookup is a mismatch', async () => {
  const provisionOf = (...rows) => ({ dataverse: { get: async () => ({ status: 200, body: { value: rows } }) } });
  const probe = (provision, declared = ONE_TO_MANY) => relationshipExists(provision, 'contoso_project', SCHEMA, 'OneToMany', { declared });
  assert.strictEqual(await probe(provisionOf({ SchemaName: SCHEMA, ReferencingEntity: 'contoso_task' })), null, 'no lookup');
  assert.strictEqual(await probe(provisionOf({ SchemaName: SCHEMA })), null, 'a name alone');
  assert.strictEqual(await probe(provisionOf({ SchemaName: SCHEMA, ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' })), true);
  const wrong = await probe(provisionOf({ SchemaName: SCHEMA, ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_ownerid' }));
  assert.strictEqual(wrong && wrong.mismatch, true);
  assert.strictEqual(await probe(provisionOf({ SchemaName: 'contoso_other', ReferencingEntity: 'contoso_task' })), false, 'another name is absent');
});

test('relationshipExists: a probe that names no declared relationship still answers by name alone, as the plan of an item without one does', async () => {
  const provision = { dataverse: { get: async () => ({ status: 200, body: { value: [{ SchemaName: SCHEMA }] } }) } };
  assert.strictEqual(await relationshipExists(provision, 'contoso_project', SCHEMA, 'OneToMany'), true);
});

test('relationshipExists: a projection row that carries no type or ends cannot prove the relationship either', async () => {
  const provision = { fetchEntityMetadata: async () => ({ relationships: [{ schemaName: SCHEMA }] }) };
  assert.strictEqual(await relationshipExists(provision, 'contoso_project', SCHEMA, 'OneToMany', { declared: ONE_TO_MANY }), null);
  const typed = { fetchEntityMetadata: async () => ({ relationships: [{ schemaName: SCHEMA, type: 'OneToMany', relatedEntity: 'contoso_task', relatedAttribute: '' }] }) };
  assert.strictEqual(await relationshipExists(typed, 'contoso_project', SCHEMA, 'OneToMany', { declared: ONE_TO_MANY }), null, 'the SDK writes an empty string for a value it lacked');
  const complete = { fetchEntityMetadata: async () => ({ relationships: [{ schemaName: SCHEMA, type: 'OneToMany', relatedEntity: 'contoso_task', relatedAttribute: 'contoso_projectid' }] }) };
  assert.strictEqual(await relationshipExists(complete, 'contoso_project', SCHEMA, 'OneToMany', { declared: ONE_TO_MANY }), true);
});

test('relationshipExists: an N:N row that does not state its intersect identity is inconclusive, a complete one is the relationship, another intersect table is a mismatch', async () => {
  const provisionOf = (...rows) => ({ dataverse: { get: async () => ({ status: 200, body: { value: rows } }) } });
  const probe = (provision, declared = MANY_TO_MANY_LINKED) => relationshipExists(provision, 'contoso_project', SCHEMA, 'ManyToMany', { declared });
  assert.strictEqual(await probe(provisionOf(ROW_NN_BARE)), null, 'the tables alone');
  assert.strictEqual(await probe(provisionOf({ ...ROW_NN_BARE, IntersectEntityName: INTERSECT })), null, 'the intersect table without its columns');
  assert.strictEqual(await probe(provisionOf({ ...ROW_NN, IntersectEntityName: '' })), null, 'an empty intersect table');
  assert.strictEqual(await probe(provisionOf(ROW_NN)), true);
  assert.strictEqual(await probe(provisionOf(ROW_NN), MANY_TO_MANY), true, 'a spec that names none');
  assert.strictEqual(await probe(provisionOf(ROW_NN_OTHER), MANY_TO_MANY), true, 'a spec that names none is held to none');
  const wrong = await probe(provisionOf(ROW_NN_OTHER));
  assert.strictEqual(wrong && wrong.mismatch, true);
  assert.strictEqual(wrong.holder.intersectEntityName, 'contoso_other_links', 'the holder carries what it stated, for the message');
  assert.strictEqual(await probe(provisionOf({ ...ROW_NN, SchemaName: 'contoso_other' })), false, 'another name is absent');
});

test('relationshipExists: the SDK projection of an N:N says nothing of its intersect table, so it cannot prove an N:N', async () => {
  // fetchEntityMetadata lists an N:N as { schemaName, type: 'ManyToMany', relatedEntity: <the other table>, relatedAttribute: '' }: no intersect table, no columns.
  const projected = { fetchEntityMetadata: async () => ({ relationships: [{ schemaName: SCHEMA, type: 'ManyToMany', relatedEntity: 'contoso_task', relatedAttribute: '' }] }) };
  assert.strictEqual(await relationshipExists(projected, 'contoso_project', SCHEMA, 'ManyToMany', { declared: MANY_TO_MANY }), null);
  assert.strictEqual(await relationshipExists(projected, 'contoso_project', SCHEMA, 'ManyToMany', { declared: MANY_TO_MANY_LINKED }), null);
  const elsewhere = { fetchEntityMetadata: async () => ({ relationships: [{ schemaName: SCHEMA, type: 'ManyToMany', relatedEntity: 'contoso_tag', relatedAttribute: '' }] }) };
  const mismatch = await relationshipExists(elsewhere, 'contoso_project', SCHEMA, 'ManyToMany', { declared: MANY_TO_MANY });
  assert.strictEqual(mismatch && mismatch.mismatch, true, 'a table the declared pair does not have is still a contradiction');
});

// ── 4. The dry run ──────────────────────────────────────────────────────────────────────────────────────────────

async function planOf(answer, declared = ONE_TO_MANY) {
  const plan = [{
    phase: 'data-model',
    label: 'relationship 1:N contoso_project->contoso_task',
    key: { kind: 'relationship', entity: 'contoso_project', name: SCHEMA, relType: declared.type, declared },
  }];
  await annotateLivePlan(plan, { spec: {}, provision: { dataverse: { get: async (url) => answer(url) } } });
  return plan[0];
}

test('dry run: a complete matching relationship reads reuse, from its row or from the exact read', async () => {
  assert.strictEqual((await planOf(SHAPES['complete-same'])).state, 'reuse');
  assert.strictEqual((await planOf(environment({ base: BASE_1N, cast: ROW_1N }))).state, 'reuse', 'the typed collection cannot see it; the exact read does');
});

test('dry run: a relationship the environment answered incompletely is unknown, never reuse', async () => {
  const fromRow = await planOf(SHAPES['missing-end-and-lookup']);
  assert.strictEqual(fromRow.state, 'unknown');
  assert.match(fromRow.stateWhy, /inconclusive/);

  const fromCast = await planOf(SHAPES['malformed-cast']);
  assert.strictEqual(fromCast.state, 'unknown');
  assert.match(fromCast.stateWhy, /schema name 'contoso_project_contoso_task' exists, but the environment's answer for it is incomplete \(it does not state its schema name, its referenced table, its referencing table and its lookup column\)/);

  const holder = await planOf(environment({ base: BASE_1N, cast: { SchemaName: SCHEMA, ReferencedEntity: 'contoso_project' } }));
  assert.strictEqual(holder.state, 'unknown');
  assert.match(holder.stateWhy, /does not state its referencing table and its lookup column/);
});

test('dry run: a complete relationship on another lookup is still unknown and names the holder', async () => {
  const plan = await planOf(SHAPES['complete-wrong-lookup']);
  assert.strictEqual(plan.state, 'unknown');
  assert.match(plan.stateWhy, /already used by 1:N contoso_project -> contoso_task \(lookup contoso_ownerid\), not the declared relationship/);
});

test('dry run N:N: a complete matching N:N reads reuse, from its row or from the exact read', async () => {
  assert.strictEqual((await planOf(NN_SHAPES['complete-row'], MANY_TO_MANY_LINKED)).state, 'reuse');
  assert.strictEqual((await planOf(NN_SHAPES['complete-cast'], MANY_TO_MANY_LINKED)).state, 'reuse', 'the typed collection cannot see it; the exact read does');
  assert.strictEqual((await planOf(NN_SHAPES['wrong-intersect-row'], MANY_TO_MANY)).state, 'reuse', 'a spec that names no intersect table is held to none');
});

test('dry run N:N: an N:N whose intersect identity the environment did not state is unknown, never reuse', async () => {
  const fromRow = await planOf(NN_SHAPES['missing-intersect-row'], MANY_TO_MANY_LINKED);
  assert.strictEqual(fromRow.state, 'unknown');
  assert.match(fromRow.stateWhy, /inconclusive/);

  const fromCast = await planOf(NN_SHAPES['missing-intersect-cast'], MANY_TO_MANY_LINKED);
  assert.strictEqual(fromCast.state, 'unknown');
  assert.match(fromCast.stateWhy, /schema name 'contoso_project_contoso_task' exists, but the environment's answer for it is incomplete \(it does not state its intersect table, its first intersect column and its second intersect column\)/);
  assert.strictEqual((await planOf(NN_SHAPES['missing-intersect-cast'], MANY_TO_MANY)).state, 'unknown', 'whether or not the spec names an intersect table');
});

test('dry run N:N: an N:N on another intersect table is unknown and names the holder', async () => {
  for (const shape of ['wrong-intersect-row', 'wrong-intersect-cast']) {
    const plan = await planOf(NN_SHAPES[shape], MANY_TO_MANY_LINKED);
    assert.strictEqual(plan.state, 'unknown', shape);
    assert.match(plan.stateWhy, /already used by N:N contoso_project <-> contoso_task \(intersect contoso_other_links\), not the declared relationship/, shape);
  }
});

// ── 5. Verify ───────────────────────────────────────────────────────────────────────────────────────────────────

// The reader verify is handed. `rows` is what the child's relationships list gives (the ManyToOne rows read from the
// referencing table, with the table stamped as the referencing end); `holder` is what the exact read of the name gives.
const verifyRead = (rows, holder) => ({
  sitemapXml: async () => '',
  queryRecords: async () => [],
  entityRelationships: async () => rows,
  relationshipHolder: async () => holder,
});
const checkOf = (result) => result.checks.find((c) => c.kind === 'relationship');
const verifyOf = (spec, read) => verifySpec({ ...spec, app: { name: 'Offline' } }, read);

test('verify: a complete matching relationship passes, and so does one the typed list cannot see but the exact read gives', async () => {
  const listed = await verifyOf(specOf(ONE_TO_MANY), verifyRead([HOLDER_1N], { found: false }));
  assert.strictEqual(listed.ok, true, JSON.stringify(listed.missing));
  const exact = await verifyOf(specOf(ONE_TO_MANY), verifyRead([], { found: true, holder: HOLDER_1N }));
  assert.strictEqual(exact.ok, true, JSON.stringify(exact.missing));
});

test('verify: a complete relationship on another lookup fails and names it', async () => {
  const r = await verifyOf(specOf(ONE_TO_MANY), verifyRead([{ ...HOLDER_1N, referencingAttribute: 'contoso_ownerid' }], { found: false }));
  assert.strictEqual(r.ok, false);
  assert.match(checkOf(r).detail, /exists as 1:N contoso_project -> contoso_task \(lookup contoso_ownerid\)/);
});

test('verify: a row that leaves out its referencing table and lookup does not pass — the check fails and says what is missing', async () => {
  const holder = { schemaName: SCHEMA, type: 'OneToMany', referencedEntity: 'contoso_project' };
  const r = await verifyOf(specOf(ONE_TO_MANY), verifyRead([holder], { found: true, holder: { schemaName: SCHEMA, type: 'OneToMany' } }));
  assert.strictEqual(r.ok, false, 'a relationship that cannot be told from the declared one is not verified');
  const check = checkOf(r);
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /exists, but the environment's answer for it is incomplete \(it does not state its referencing table and its lookup column\)/);
  assert.match(check.detail, /verify cannot prove it is the declared 1:N contoso_project -> contoso_task \(lookup contoso_projectid\)/);
  assert.strictEqual(r.unverified, undefined, 'a check that fails is not listed as one that could not be decided: that list leaves ok and the exit status as they were');
});

test('verify: an exact read that answers only the name and the type does not pass', async () => {
  const r = await verifyOf(specOf(ONE_TO_MANY), verifyRead([], { found: true, holder: { schemaName: SCHEMA, type: 'OneToMany' } }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(checkOf(r).present, false);
  assert.match(checkOf(r).detail, /incomplete \(it does not state its referenced table, its referencing table and its lookup column\)/);
  const empty = await verifyOf(specOf(ONE_TO_MANY), verifyRead([], { found: true, holder: {} }));
  assert.strictEqual(empty.ok, false);
  assert.match(checkOf(empty).detail, /incomplete \(it does not state its schema name, its relationship type, its referenced table, its referencing table and its lookup column\)/);
});

test('verify: an N:N passes on a complete pair and does not on a row that names one table', async () => {
  const ok = await verifyOf(specOf(MANY_TO_MANY), verifyRead([HOLDER_NN], { found: false }));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.missing));
  const half = await verifyOf(specOf(MANY_TO_MANY), verifyRead([{ schemaName: SCHEMA, type: 'ManyToMany', entity1: 'contoso_project' }], { found: false }));
  assert.strictEqual(half.ok, false);
  assert.match(checkOf(half).detail, /does not state its second table, its intersect table, its first intersect column and its second intersect column\), so verify cannot prove it is the declared N:N contoso_project <-> contoso_task/);
});

test('verify N:N: a complete N:N passes, from the typed list or from the exact read — and a spec that names no intersect table is held to none', async () => {
  const listed = await verifyOf(specOf(MANY_TO_MANY_LINKED), verifyRead([HOLDER_NN], { found: false }));
  assert.strictEqual(listed.ok, true, JSON.stringify(listed.missing));
  const exact = await verifyOf(specOf(MANY_TO_MANY_LINKED), verifyRead([], { found: true, holder: HOLDER_NN }));
  assert.strictEqual(exact.ok, true, JSON.stringify(exact.missing));
  const other = { ...HOLDER_NN, intersectEntityName: 'contoso_other_links' };
  const silent = await verifyOf(specOf(MANY_TO_MANY), verifyRead([other], { found: false }));
  assert.strictEqual(silent.ok, true, JSON.stringify(silent.missing));
});

test('verify N:N: an N:N that does not state its intersect table fails the check and says what the answer lacked', async () => {
  const bare = { schemaName: SCHEMA, type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_task' };
  for (const [what, read] of [['a row of the typed list', verifyRead([bare], { found: false })], ['the exact read', verifyRead([], { found: true, holder: bare })]]) {
    const r = await verifyOf(specOf(MANY_TO_MANY_LINKED), read);
    assert.strictEqual(r.ok, false, `${what} without its intersect identity is not a proof`);
    assert.strictEqual(checkOf(r).present, false, what);
    assert.match(checkOf(r).detail, /exists, but the environment's answer for it is incomplete \(it does not state its intersect table, its first intersect column and its second intersect column\), so verify cannot prove it is the declared N:N contoso_project <-> contoso_task \(intersect contoso_project_task_links\)/, what);
    assert.strictEqual(r.unverified, undefined, `${what}: a check that fails is not listed as one that could not be decided`);
  }
  for (const field of ['intersectEntityName', 'entity1IntersectAttribute', 'entity2IntersectAttribute']) {
    const r = await verifyOf(specOf(MANY_TO_MANY), verifyRead([{ ...HOLDER_NN, [field]: undefined }], { found: false }));
    assert.strictEqual(r.ok, false, `${field} left out`);
  }
});

test('verify N:N: an N:N on another intersect table fails and names it', async () => {
  const other = { ...HOLDER_NN, intersectEntityName: 'contoso_other_links' };
  for (const [what, read] of [['a row of the typed list', verifyRead([other], { found: false })], ['the exact read', verifyRead([], { found: true, holder: other })]]) {
    const r = await verifyOf(specOf(MANY_TO_MANY_LINKED), read);
    assert.strictEqual(r.ok, false, what);
    assert.match(checkOf(r).detail, /exists as N:N contoso_task <-> contoso_project \(intersect contoso_other_links\)/, what);
  }
});

test('verify: a reader that lists plain names stays a name-only reader, as it always was', async () => {
  const r = await verifyOf(specOf(ONE_TO_MANY), verifyRead([SCHEMA], { found: false }));
  assert.strictEqual(checkOf(r).present, true);
});

// ── 6. The real vendored bundle ─────────────────────────────────────────────────────────────────────────────────
// Over a stub transport, so the SDK's own create (and the error it throws when the name is taken) and its own client (the
// reads the build and verify make of a relationship) are the ones a live run uses.
async function realSdk(answer, { post } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = makeTempDir('relationship-identity-');
  const writes = [];
  const reads = [];
  const answered = (a) => ({ status: a.status, headers: {}, body: a.body });
  const httpClient = {
    get: async (url) => {
      // The client sends the origin and the api path before what the plugin asked for; the fakes answer by what it asked for.
      const asked = decodeURIComponent(url).replace(/^https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v9\.\d+/, '');
      reads.push(asked);
      return answered(answer(asked));
    },
    post: async (url, body) => {
      writes.push({ verb: 'POST', url: decodeURIComponent(url), body });
      if (post) return post(decodeURIComponent(url), body);
      return { status: 409, headers: {}, body: { error: { code: '0x80044363', message: 'Relationship with the same name already exists' } } };
    },
    put: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, writes, reads };
}

async function realBuildOf(answer, spec, options) {
  const { sdk, writes, reads } = await realSdk(answer, options);
  const events = [];
  let error;
  try {
    await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 8 }), spec, apply: true, preResolvedLanguageCode: 1033, sleep: async () => {} });
  } catch (e) { error = e; }
  return { error, events, writes, reads, sdk };
}
const realBuild = (shape) => realBuildOf(SHAPES[shape], specOf(ONE_TO_MANY));
const realBuildNN = (shape, declared = MANY_TO_MANY_LINKED) => realBuildOf(NN_SHAPES[shape], specOf(declared));

test('REAL BUNDLE: a build reuses the relationship whose row states its whole identity, and creates nothing', async () => {
  const run = await realBuild('complete-same');
  assert.strictEqual(run.error, undefined, run.error && run.error.message);
  assert.ok(reused(run), JSON.stringify(run.events));
  assert.deepStrictEqual(run.writes, []);
});

test('REAL BUNDLE: a build halts on a relationship whose row leaves out its ends — the SDK\'s own collision is read, and the exact read is no better', async () => {
  const run = await realBuild('missing-end-and-lookup');
  assert.ok(run.error, 'the build must not skip a relationship it could not identify');
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.strictEqual(run.writes.filter((w) => /\/RelationshipDefinitions$/.test(w.url)).length, 1, 'the SDK tried the create, and the name was taken');
  assert.match(run.error.message, /already exists, but the environment's answer for it is incomplete/);
  assert.match(run.error.message, /does not state its referencing table and its lookup column/);
  assert.strictEqual(isTransientHalt(run.error), false);
});

test('REAL BUNDLE: a build halts when the typed read of the holder answers an empty body after the SDK\'s collision', async () => {
  const run = await realBuild('malformed-cast');
  assert.ok(run.error);
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.ok(run.reads.some((r) => /OneToManyRelationshipMetadata/.test(r)), 'the typed read was made');
  assert.match(run.error.message, /already exists, but the environment's answer for it is incomplete/);
  assert.strictEqual(isTransientHalt(run.error), false);
});

test('REAL BUNDLE: a build halts on a complete relationship under another lookup, as it did', async () => {
  const run = await realBuild('complete-wrong-lookup');
  assert.ok(run.error);
  assert.strictEqual(run.error.code, 'relationship-name-taken');
  assert.deepStrictEqual(run.writes, [], 'a name held by a different relationship is not created over');
});

test('REAL BUNDLE: verify through the real reader passes a complete relationship and fails one whose row leaves out its lookup', async () => {
  const child = (rows) => (url) => (/LogicalName='contoso_task'\)\/ManyToOneRelationships\?/.test(url) ? { status: 200, body: { value: rows } } : { status: 200, body: { value: [] } });
  const spec = { ...specOf(ONE_TO_MANY), app: { name: 'Offline', uniqueName: 'contoso_offline' } };

  const complete = await realSdk(child([{ SchemaName: SCHEMA, ReferencedEntity: 'contoso_project', ReferencingAttribute: 'contoso_projectid' }]));
  const passed = checkOf(await verifySpec(spec, readerFor(complete.sdk, 'contoso_offline', {})));
  assert.strictEqual(passed.present, true, passed.detail);

  const partial = await realSdk(child([{ SchemaName: SCHEMA, ReferencedEntity: 'contoso_project' }]));
  const failed = checkOf(await verifySpec(spec, readerFor(partial.sdk, 'contoso_offline', {})));
  assert.strictEqual(failed.present, false, 'a row that does not say which lookup it is is not the declared relationship');
  assert.match(failed.detail, /incomplete \(it does not state its lookup column\)/);
});

// ── 6b. The real vendored bundle: an N:N and its intersect table ────────────────────────────────────────────────

test('REAL BUNDLE N:N: a build reuses an N:N whose row states its whole identity, and creates nothing', async () => {
  for (const [what, declared] of [['a spec that names its intersect table', MANY_TO_MANY_LINKED], ['a spec that leaves it to the SDK', MANY_TO_MANY]]) {
    const run = await realBuildNN('complete-row', declared);
    assert.strictEqual(run.error, undefined, `${what}: ${run.error && run.error.message}`);
    assert.ok(reused(run), `${what}: ${JSON.stringify(run.events)}`);
    assert.deepStrictEqual(run.writes, [], what);
    assert.strictEqual(run.reads.length, 1, `${what}: the healthy path is one narrow read — ${run.reads.join(' | ')}`);
  }
});

test('REAL BUNDLE N:N: a build halts on a row that leaves out its intersect identity — the SDK\'s own collision is read, and the exact read is no better', async () => {
  const run = await realBuildNN('missing-intersect-row');
  assert.ok(run.error, 'the build must not skip an N:N it could not identify');
  assert.ok(!reused(run), JSON.stringify(run.events));
  const creates = run.writes.filter((w) => /\/RelationshipDefinitions$/.test(w.url));
  assert.strictEqual(creates.length, 1, 'the SDK tried the create, and the name was taken');
  assert.strictEqual(creates[0].body.IntersectEntityName, INTERSECT, 'the SDK sends the intersect table the spec names');
  assert.ok(run.reads.some((r) => /ManyToManyRelationshipMetadata/.test(r)), 'the typed read was made');
  assert.match(run.error.message, /already exists, but the environment's answer for it is incomplete \(it does not state its intersect table, its first intersect column and its second intersect column\)/);
  assert.strictEqual(isTransientHalt(run.error), false);
});

test('REAL BUNDLE N:N: a build halts when the typed read of the holder leaves out the intersect table after the SDK\'s collision', async () => {
  const run = await realBuildNN('missing-intersect-cast');
  assert.ok(run.error);
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.strictEqual(run.writes.length, 1, 'the SDK tried the create once');
  assert.match(run.error.message, /already exists, but the environment's answer for it is incomplete \(it does not state its intersect table, its first intersect column and its second intersect column\)/);
  assert.strictEqual(isTransientHalt(run.error), false);
});

test('REAL BUNDLE N:N: a build halts on a complete N:N on another intersect table, and creates nothing over it', async () => {
  const run = await realBuildNN('wrong-intersect-row');
  assert.ok(run.error);
  assert.strictEqual(run.error.code, 'relationship-name-taken');
  assert.match(run.error.message, /already used by N:N contoso_project <-> contoso_task \(intersect contoso_other_links\)/);
  assert.deepStrictEqual(run.writes, [], 'a name held by a different relationship is not created over');
});

test('REAL BUNDLE N:N: the typed read of an N:N on another intersect table is refused after the SDK\'s collision', async () => {
  const run = await realBuildNN('wrong-intersect-cast');
  assert.ok(run.error);
  assert.ok(!reused(run), JSON.stringify(run.events));
  assert.strictEqual(run.writes.length, 1, 'the SDK tried the create once');
  assert.match(run.error.message, /is already used by N:N contoso_project <-> contoso_task \(intersect contoso_other_links\)/);
  assert.strictEqual(isTransientHalt(run.error), false);
});

test('REAL BUNDLE N:N: an intersect table the answer gives as null or empty is not stated — by the row and by the typed read alike', async () => {
  for (const absent of [null, '']) {
    for (const how of ['row', 'cast']) {
      const what = `${JSON.stringify(absent)} through the ${how}`;
      const run = await realBuildOf(nnEnvironment({ ...ROW_NN, IntersectEntityName: absent }, how), specOf(MANY_TO_MANY_LINKED));
      assert.ok(run.error, what);
      assert.ok(!reused(run), `${what}: ${JSON.stringify(run.events)}`);
      assert.match(run.error.message, /does not state its intersect table\), so the build cannot tell it from the declared N:N/, what);
    }
  }
});

// A platform that remembers what the SDK created: its POST is recorded, and every later read answers as the platform does for a
// relationship with that identity — the intersect table it was given, and `<table>id` for the column each table has in it, as a custom table's
// key is named. Answers are cut to the properties the read selected, so what a read did not ask for is not told.
function platformThatRemembers() {
  const made = new Map();
  const created = [];
  const rowOf = (body) => ({
    SchemaName: body.SchemaName,
    Entity1LogicalName: body.Entity1LogicalName,
    Entity2LogicalName: body.Entity2LogicalName,
    IntersectEntityName: body.IntersectEntityName,
    Entity1IntersectAttribute: `${body.Entity1LogicalName}id`,
    Entity2IntersectAttribute: `${body.Entity2LogicalName}id`,
  });
  const answer = selecting((url) => {
    const keyed = /^\/RelationshipDefinitions\(SchemaName='([^']*)'\)/.exec(url);
    if (keyed) {
      const row = made.get(keyed[1].toLowerCase());
      if (!row) return { status: 404, body: { error: { code: '0x80060888', message: 'RelationshipMetadataBase With Id does not exist.' } } };
      return { status: 200, body: { ...row, RelationshipType: 'ManyToManyRelationship' } };
    }
    const collection = /LogicalName='([^']*)'\)\/ManyToManyRelationships\?/.exec(url);
    if (collection) return { status: 200, body: { value: [...made.values()].filter((row) => row.Entity1LogicalName === collection[1] || row.Entity2LogicalName === collection[1]) } };
    return { status: 200, body: { value: [] } };
  });
  const post = async (url, body) => {
    created.push(body);
    const key = String(body.SchemaName).toLowerCase();
    if (made.has(key)) return { status: 409, headers: {}, body: { error: { code: '0x80044363', message: 'Relationship with the same name already exists' } } };
    made.set(key, rowOf(body));
    return { status: 204, headers: { 'odata-entityid': 'https://contoso.crm.dynamics.com/api/data/v9.2/RelationshipDefinitions(11111111-2222-3333-4444-555555555555)' }, body: {} };
  };
  return { answer, post, created };
}

test('REAL BUNDLE N:N: an N:N the build made is reused by the next build and passes verify — whether the spec names its intersect table or leaves it to the SDK', async () => {
  for (const [what, declared, intersect] of [['named', MANY_TO_MANY_LINKED, INTERSECT], ['left to the SDK', MANY_TO_MANY, SCHEMA]]) {
    const platform = platformThatRemembers();
    const first = await realBuildOf(platform.answer, specOf(declared), { post: platform.post });
    assert.strictEqual(first.error, undefined, `${what}: ${first.error && first.error.message}`);
    assert.strictEqual(platform.created.length, 1, `${what}: the first build created the relationship`);
    assert.strictEqual(platform.created[0].IntersectEntityName, intersect, `${what}: the intersect table the SDK sent`);

    const second = await realBuildOf(platform.answer, specOf(declared), { post: platform.post });
    assert.strictEqual(second.error, undefined, `${what}: ${second.error && second.error.message}`);
    assert.ok(reused(second), `${what}: ${JSON.stringify(second.events)}`);
    assert.strictEqual(platform.created.length, 1, `${what}: the rebuild created nothing`);
    assert.strictEqual(second.writes.length, 0, what);

    const spec = { ...specOf(declared), app: { name: 'Offline', uniqueName: 'contoso_offline' } };
    const verified = checkOf(await verifySpec(spec, readerFor(second.sdk, 'contoso_offline', {})));
    assert.strictEqual(verified.present, true, `${what}: ${verified.detail}`);
  }
});

test('REAL BUNDLE N:N: verify through the real reader passes a complete N:N, and fails one that leaves out its intersect table or names another', async () => {
  const onProject = (row) => selecting((url) => (/LogicalName='contoso_project'\)\/ManyToManyRelationships\?/.test(url) ? { status: 200, body: { value: [row] } } : { status: 200, body: { value: [] } }));
  const spec = { ...specOf(MANY_TO_MANY_LINKED), app: { name: 'Offline', uniqueName: 'contoso_offline' } };
  const verifyWith = async (row) => checkOf(await verifySpec(spec, readerFor((await realSdk(onProject(row))).sdk, 'contoso_offline', {})));

  const passed = await verifyWith(ROW_NN);
  assert.strictEqual(passed.present, true, passed.detail);

  const bare = await verifyWith(ROW_NN_BARE);
  assert.strictEqual(bare.present, false, 'a row that does not say which intersect table it has is not the declared N:N');
  assert.match(bare.detail, /incomplete \(it does not state its intersect table, its first intersect column and its second intersect column\)/);

  const other = await verifyWith(ROW_NN_OTHER);
  assert.strictEqual(other.present, false);
  assert.match(other.detail, /exists as N:N contoso_project <-> contoso_task \(intersect contoso_other_links\)/);
});

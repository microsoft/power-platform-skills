'use strict';
// A relationship is called the one the spec declares — reused by the build, present for verify — only when the
// environment's answer states its whole identity: its schema name, its type, both of its tables and, for a 1:N, the
// lookup column. A part the answer leaves out is not "nothing contradicts": it is a part nobody checked, and a
// relationship whose name matches while its ends are unstated has not been shown to be the declared one.
//
// The inputs are the shapes a SUCCESSFUL answer takes with part of that missing: a collection row without its
// referencing table and lookup, and a typed read that answers 200 with an empty body after a create collided on the
// name. The first group is the rule itself; the next groups drive the build, the dry run and verify with the fakes
// those shapes need; the last runs the real vendored bundle over a stub transport.
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
const HOLDER_1N = {
  schemaName: SCHEMA, type: 'OneToMany', referencedEntity: 'contoso_project', referencingEntity: 'contoso_task', referencingAttribute: 'contoso_projectid',
};
const HOLDER_NN = { schemaName: SCHEMA, type: 'ManyToMany', entity1: 'contoso_task', entity2: 'contoso_project' };

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
  const held = { schemaName: 'contoso_item_contoso_item', type: 'ManyToMany', entity1: 'Contoso_Item', entity2: 'contoso_item' };
  assert.strictEqual(sameRelationship(self, held), true);
  assert.strictEqual(compareRelationship(self, { ...held, entity2: 'contoso_other' }).state, 'different');
  // A declaration that names one table is held to that one, and the holder still has to state both of its own.
  const named = { type: 'ManyToMany', schemaName: SCHEMA, entity1: 'contoso_project' };
  assert.strictEqual(compareRelationship(named, HOLDER_NN).state, 'same');
  assert.strictEqual(compareRelationship({ ...named, entity1: 'contoso_tag' }, HOLDER_NN).state, 'different');
  assert.deepStrictEqual(compareRelationship(named, { ...HOLDER_NN, entity1: undefined }), { state: 'incomplete', missing: ['first table'] });
});

// ── 2. What the environment says ────────────────────────────────────────────────────────────────────────────────
// The three reads the build and verify make of a relationship, in the shapes the platform answers them (a contoso name):
//   GET /EntityDefinitions(LogicalName='contoso_project')/OneToManyRelationships?$select=SchemaName,ReferencingEntity,ReferencingAttribute
//     → 200 { "value": [ { "SchemaName": "contoso_project_contoso_task", "ReferencingEntity": "contoso_task", "ReferencingAttribute": "contoso_projectid" } ] }
//   GET /RelationshipDefinitions(SchemaName='contoso_project_contoso_task')?$select=SchemaName,RelationshipType
//     → 200 { "SchemaName": "contoso_project_contoso_task", "RelationshipType": "OneToManyRelationship" }
//   GET /RelationshipDefinitions(SchemaName='contoso_project_contoso_task')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute
//     → 200 { "SchemaName": "contoso_project_contoso_task", "ReferencedEntity": "contoso_project", "ReferencingEntity": "contoso_task", "ReferencingAttribute": "contoso_projectid" }
// and for an N:N: …/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity2LogicalName, RelationshipType "ManyToManyRelationship", and the
// ManyToManyRelationshipMetadata cast with the same three properties.
const BASE_1N = { SchemaName: SCHEMA, RelationshipType: 'OneToManyRelationship' };
const BASE_NN = { SchemaName: SCHEMA, RelationshipType: 'ManyToManyRelationship' };
const ROW_1N = { SchemaName: SCHEMA, ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' };
const ROW_NN = { SchemaName: SCHEMA, Entity1LogicalName: 'contoso_project', Entity2LogicalName: 'contoso_task' };

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
  assert.match(checkOf(half).detail, /does not state its second table\), so verify cannot prove it is the declared N:N contoso_project <-> contoso_task/);
});

test('verify: a reader that lists plain names stays a name-only reader, as it always was', async () => {
  const r = await verifyOf(specOf(ONE_TO_MANY), verifyRead([SCHEMA], { found: false }));
  assert.strictEqual(checkOf(r).present, true);
});

// ── 6. The real vendored bundle ─────────────────────────────────────────────────────────────────────────────────
// Over a stub transport, so the SDK's own create (and the error it throws when the name is taken) and its own client (the
// reads the build and verify make of a relationship) are the ones a live run uses.
async function realSdk(answer) {
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

async function realBuild(shape) {
  const { sdk, writes, reads } = await realSdk(SHAPES[shape]);
  const events = [];
  let error;
  try {
    await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 8 }), spec: specOf(ONE_TO_MANY), apply: true, preResolvedLanguageCode: 1033, sleep: async () => {} });
  } catch (e) { error = e; }
  return { error, events, writes, reads };
}

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

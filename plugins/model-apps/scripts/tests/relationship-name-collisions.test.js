'use strict';
// Relationship schema names are unique in Dataverse. A 1:N and an N:N between the same pair, two
// 1:N relationships on one pair, and a self-referential 1:N plus an N:N all derive the same default
// name. The gate must refuse that before a build silently skips the second create.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  relationshipNameCollisions,
  relationshipCollisionMessage,
  relationshipSchemaName,
  manyToManySchemaName,
  validateAppSpec,
} = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));
const { validateProvisionInput } = require(path.join(__dirname, '..', 'lib', 'provision-input.js'));

const oneToMany = (referenced, referencing, lookup, schemaName) => ({
  type: 'OneToMany',
  referenced,
  referencing,
  lookup: { schemaName: lookup },
  ...(schemaName ? { schemaName } : {}),
});
const manyToMany = (entity1, entity2, schemaName) => ({
  type: 'ManyToMany',
  entity1,
  entity2,
  ...(schemaName ? { schemaName } : {}),
});

test('1:N and N:N between the same pair derive one schema name', () => {
  const rels = [
    oneToMany('contoso_project', 'contoso_task', 'contoso_ProjectId'),
    manyToMany('contoso_project', 'contoso_task'),
  ];
  assert.deepStrictEqual(relationshipNameCollisions(rels, 'contoso'), [
    { name: 'contoso_project_contoso_task', first: 0, second: 1 },
  ]);
});

test('two 1:N relationships on one pair collide even with different lookups', () => {
  const rels = [
    oneToMany('contoso_project', 'contoso_task', 'contoso_ProjectId'),
    oneToMany('contoso_project', 'contoso_task', 'contoso_OwnerId'),
  ];
  const hits = relationshipNameCollisions(rels, 'contoso');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].name, 'contoso_project_contoso_task');
  assert.deepStrictEqual([hits[0].first, hits[0].second], [0, 1]);
});

test('a self-referential 1:N and an N:N on the same table collide', () => {
  const rels = [
    oneToMany('contoso_item', 'contoso_item', 'contoso_ParentId'),
    manyToMany('contoso_item', 'contoso_item'),
  ];
  assert.deepStrictEqual(relationshipNameCollisions(rels, 'contoso'), [
    { name: 'contoso_item_contoso_item', first: 0, second: 1 },
  ]);
});

test('an explicit schemaName on one of the pair removes the collision', () => {
  const rels = [
    oneToMany('contoso_project', 'contoso_task', 'contoso_ProjectId'),
    manyToMany('contoso_project', 'contoso_task', 'contoso_project_task_link'),
  ];
  assert.deepStrictEqual(relationshipNameCollisions(rels, 'contoso'), []);
});

test('an explicit schemaName that only differs by case from a derived name still collides', () => {
  const rels = [
    oneToMany('contoso_project', 'contoso_task', 'contoso_ProjectId'),
    manyToMany('contoso_project', 'contoso_task', 'CONTOSO_PROJECT_CONTOSO_TASK'),
  ];
  assert.deepStrictEqual(relationshipNameCollisions(rels, 'contoso'), [
    { name: 'contoso_project_contoso_task', first: 0, second: 1 },
  ]);
});

test('a relationship to a system table collides with the N:N the real name functions derive', () => {
  // Do not hand-compute the prefixed name — the helper and the name functions must agree.
  const one = oneToMany('account', 'contoso_task', 'contoso_AccountId');
  const nn = manyToMany('contoso_task', 'account');
  const derived = relationshipSchemaName(one, 'contoso').toLowerCase();
  assert.strictEqual(manyToManySchemaName(nn, 'contoso').toLowerCase(), derived);
  assert.deepStrictEqual(relationshipNameCollisions([one, nn], 'contoso'), [
    { name: derived, first: 0, second: 1 },
  ]);
});

test('distinct pairs do not collide', () => {
  const rels = [
    oneToMany('contoso_project', 'contoso_task', 'contoso_ProjectId'),
    manyToMany('contoso_project', 'contoso_tag'),
  ];
  assert.deepStrictEqual(relationshipNameCollisions(rels, 'contoso'), []);
});

test('null and garbage relationship entries are skipped and do not throw', () => {
  const rels = [
    null,
    undefined,
    'not-a-relationship',
    {},
    { type: 'OneToMany' },
    { type: 'ManyToMany' },
    oneToMany('contoso_project', 'contoso_task', 'contoso_ProjectId'),
  ];
  assert.doesNotThrow(() => relationshipNameCollisions(rels, 'contoso'));
  assert.deepStrictEqual(relationshipNameCollisions(rels, 'contoso'), []);
});

function appSpec(relationships, extra) {
  return {
    solution: { uniqueName: 'Contoso', publisherPrefix: 'contoso' },
    app: { name: 'Projects' },
    entities: [
      { schemaName: 'contoso_project', displayName: 'Project', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } },
      { schemaName: 'contoso_task', displayName: 'Task', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } },
    ],
    relationships,
    ...extra,
  };
}

const COLLIDING = [
  oneToMany('contoso_project', 'contoso_task', 'contoso_ProjectId'),
  manyToMany('contoso_project', 'contoso_task'),
];

const COLLISION_ERROR = 'relationships[0] (1:N contoso_project -> contoso_task) and relationships[1] (N:N contoso_project <-> contoso_task) both use the schema name \'contoso_project_contoso_task\'. Dataverse allows one relationship per name, so the second would not be created. Give one of them an explicit "schemaName".';

test('the collision message is built in one place and names both relationships', () => {
  const [hit] = relationshipNameCollisions(COLLIDING, 'contoso');
  assert.strictEqual(relationshipCollisionMessage(COLLIDING, hit), COLLISION_ERROR);
});

test('validateAppSpec errors on a collision for design, plan and deploy, but not structural', () => {
  for (const profile of ['design', 'plan', 'deploy']) {
    const r = validateAppSpec(appSpec(COLLIDING), { profile });
    assert.strictEqual(r.ok, false, profile);
    assert.ok(r.errors.includes(COLLISION_ERROR), `${profile}: ${JSON.stringify(r.errors)}`);
  }
  const structural = validateAppSpec(appSpec(COLLIDING), { profile: 'structural' });
  assert.strictEqual(structural.ok, true, JSON.stringify(structural.errors));
  assert.ok(!(structural.warnings || []).some((w) => /schema name/.test(w)), 'teardown must not be blocked or warned');
});

test('relationshipCollisions: warn demotes the collision to a warning and leaves the spec valid', () => {
  const r = validateAppSpec(appSpec(COLLIDING), { profile: 'deploy', relationshipCollisions: 'warn' });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.ok((r.warnings || []).includes(COLLISION_ERROR), JSON.stringify(r.warnings));
});

test('a reconstructed spec with an explicit schemaName on one of a same-pair 1:N and N:N passes', () => {
  // Download validates with profile plan + reconstructed. A downloaded spec carries deployed names,
  // so giving one relationship its deployed name is enough for the gate to accept the pair.
  const rels = [
    oneToMany('contoso_project', 'contoso_task', 'contoso_ProjectId', 'contoso_project_task_lookup'),
    manyToMany('contoso_project', 'contoso_task'),
  ];
  const r = validateAppSpec(appSpec(rels), { profile: 'plan', reconstructed: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validation does not reject a foreign-prefix explicit schemaName, including when reconstructed', () => {
  // Download must be able to keep a deployed name that uses another publisher's prefix when omitting
  // it would collide. If a validation rule (not lint) rejected that name, reconstructed specs would
  // need an exemption. This pins that no such rule exists.
  const rels = [
    oneToMany('contoso_project', 'contoso_task', 'contoso_ProjectId', 'other_ProjectLink'),
    manyToMany('contoso_project', 'contoso_task', 'other_ProjectTask'),
  ];
  const authored = validateAppSpec(appSpec(rels), { profile: 'deploy' });
  const reconstructed = validateAppSpec(appSpec(rels), { profile: 'plan', reconstructed: true });
  assert.strictEqual(authored.ok, true, JSON.stringify(authored.errors));
  assert.strictEqual(reconstructed.ok, true, JSON.stringify(reconstructed.errors));
});

function provisionInput(relationships) {
  const entity = (schemaName) => ({
    schemaName,
    displayName: schemaName,
    primaryAttribute: { schemaName: `${schemaName}_name` },
    columns: [],
  });
  return {
    solution: { uniqueName: 'Contoso', publisherPrefix: 'contoso' },
    entities: [entity('contoso_project'), entity('contoso_task')],
    relationships,
  };
}

test('validateProvisionInput emits the same collision error as validateAppSpec', () => {
  const r = validateProvisionInput(provisionInput(COLLIDING));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.includes(COLLISION_ERROR), JSON.stringify(r.errors));
});

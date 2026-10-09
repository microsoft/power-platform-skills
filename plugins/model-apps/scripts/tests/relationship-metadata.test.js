'use strict';
// Narrow relationship reads. The SchemaName alternate key is case-sensitive; a 404 there is not
// proof the name is free, only that this spelling was not found. Shapes below are the live
// RelationshipDefinitions responses with contoso names.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  readRelationshipsOf,
  findRelationshipHolder,
  sameRelationship,
  describeRelationship,
} = require(path.join(__dirname, '..', 'lib', 'relationship-metadata.js'));

function client(routes) {
  const paths = [];
  return {
    paths,
    get: async (p) => {
      paths.push(p);
      const hit = routes.find((r) => (r.test ? r.test(p) : r.path === p));
      if (!hit) return { status: 404, body: { error: { code: '0x80060888', message: `no route for ${p}` } } };
      return { status: hit.status, body: hit.body };
    },
  };
}

const ONE_TO_MANY_BASE = "/RelationshipDefinitions(SchemaName='contoso_project_contoso_task')?$select=SchemaName,RelationshipType";
const ONE_TO_MANY_CAST = "/RelationshipDefinitions(SchemaName='contoso_project_contoso_task')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute";
const MANY_TO_MANY_BASE = "/RelationshipDefinitions(SchemaName='contoso_project_contoso_tag')?$select=SchemaName,RelationshipType";
const MANY_TO_MANY_CAST = "/RelationshipDefinitions(SchemaName='contoso_project_contoso_tag')/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$select=SchemaName,Entity1LogicalName,Entity2LogicalName";

test('readRelationshipsOf uses the narrow collection selects and stamps the queried end', async () => {
  const c = client([
    {
      path: "/EntityDefinitions(LogicalName='contoso_project')/OneToManyRelationships?$select=SchemaName,ReferencingEntity,ReferencingAttribute",
      status: 200,
      body: { value: [{ SchemaName: 'contoso_project_contoso_task', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' }] },
    },
    {
      path: "/EntityDefinitions(LogicalName='contoso_task')/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencingAttribute",
      status: 200,
      body: { value: [{ SchemaName: 'contoso_project_contoso_task', ReferencedEntity: 'contoso_project', ReferencingAttribute: 'contoso_projectid' }] },
    },
    {
      path: "/EntityDefinitions(LogicalName='contoso_project')/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity2LogicalName",
      status: 200,
      body: { value: [{ SchemaName: 'contoso_project_contoso_tag', Entity1LogicalName: 'contoso_project', Entity2LogicalName: 'contoso_tag' }] },
    },
  ]);
  const one = await readRelationshipsOf(c, 'contoso_project', 'OneToMany');
  const many = await readRelationshipsOf(c, 'contoso_task', 'ManyToOne');
  const nn = await readRelationshipsOf(c, 'contoso_project', 'ManyToMany');
  assert.deepStrictEqual(one, { ok: true, rows: [{ schemaName: 'contoso_project_contoso_task', type: 'OneToMany', referencedEntity: 'contoso_project', referencingEntity: 'contoso_task', referencingAttribute: 'contoso_projectid' }] });
  assert.deepStrictEqual(many.rows[0].referencingEntity, 'contoso_task');
  assert.strictEqual(many.rows[0].referencedEntity, 'contoso_project');
  assert.deepStrictEqual(nn.rows[0], { schemaName: 'contoso_project_contoso_tag', type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_tag' });
});

test('a 404 on the table is an empty read, not a failure', async () => {
  const c = client([{ test: () => true, status: 404, body: { error: { code: '0x80060888', message: "EntityMetadata With Id = LogicalName='missing' does not exist." } } }]);
  const read = await readRelationshipsOf(c, 'missing', 'OneToMany');
  assert.deepStrictEqual(read, { ok: true, rows: [], tableMissing: true });
});

test('a quote in a logical name is escaped with odataLit', async () => {
  const c = client([{ test: () => true, status: 200, body: { value: [] } }]);
  await readRelationshipsOf(c, "contoso_o'brien", 'ManyToMany');
  assert.strictEqual(c.paths[0], "/EntityDefinitions(LogicalName='contoso_o''brien')/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity2LogicalName");
});

test('findRelationshipHolder reads the 1:N cast after the base type', async () => {
  const c = client([
    { path: ONE_TO_MANY_BASE, status: 200, body: { '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName: 'contoso_project_contoso_task', RelationshipType: 'OneToManyRelationship' } },
    { path: ONE_TO_MANY_CAST, status: 200, body: { SchemaName: 'contoso_project_contoso_task', ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' } },
  ]);
  const found = await findRelationshipHolder(c, 'contoso_project_contoso_task', { candidates: ['contoso_project', 'contoso_task'] });
  assert.deepStrictEqual(c.paths, [ONE_TO_MANY_BASE, ONE_TO_MANY_CAST]);
  assert.strictEqual(found.found, true);
  assert.strictEqual(describeRelationship(found.holder), '1:N contoso_project -> contoso_task (lookup contoso_projectid)');
});

test('findRelationshipHolder reads the N:N cast after the base type', async () => {
  const c = client([
    { path: MANY_TO_MANY_BASE, status: 200, body: { '@odata.type': '#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata', SchemaName: 'contoso_project_contoso_tag', RelationshipType: 'ManyToManyRelationship' } },
    { path: MANY_TO_MANY_CAST, status: 200, body: { SchemaName: 'contoso_project_contoso_tag', Entity1LogicalName: 'contoso_tag', Entity2LogicalName: 'contoso_project' } },
  ]);
  const found = await findRelationshipHolder(c, 'contoso_project_contoso_tag', { candidates: [] });
  assert.deepStrictEqual(c.paths, [MANY_TO_MANY_BASE, MANY_TO_MANY_CAST]);
  assert.strictEqual(describeRelationship(found.holder), 'N:N contoso_tag <-> contoso_project');
});

test('a case-sensitive 404 falls back to the candidate collections and finds the other casing', async () => {
  const c = client([
    { test: (p) => p.startsWith('/RelationshipDefinitions('), status: 404, body: { error: { code: '0x80060888', message: "RelationshipMetadataBase With Id = SchemaName='CONTOSO_PROJECT_CONTOSO_TASK' does not exist." } } },
    {
      path: "/EntityDefinitions(LogicalName='contoso_task')/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencingAttribute",
      status: 200,
      body: { value: [{ SchemaName: 'contoso_project_contoso_task', ReferencedEntity: 'contoso_project', ReferencingAttribute: 'contoso_projectid' }] },
    },
  ]);
  const found = await findRelationshipHolder(c, 'CONTOSO_PROJECT_CONTOSO_TASK', { candidates: ['contoso_project', 'contoso_task'] });
  assert.strictEqual(found.found, true);
  assert.strictEqual(found.holder.schemaName, 'contoso_project_contoso_task');
  assert.ok(c.paths.some((p) => p.includes("/EntityDefinitions(LogicalName='contoso_project')/OneToManyRelationships")));
  assert.ok(c.paths.some((p) => p.includes("/EntityDefinitions(LogicalName='contoso_task')/ManyToOneRelationships")));
  assert.ok(c.paths.some((p) => p.includes('ManyToManyRelationships')));
});

test('404 plus no fallback match is found:false', async () => {
  const c = client([
    { test: () => true, status: 404, body: { error: { message: "RelationshipMetadataBase With Id = SchemaName='contoso_missing' does not exist." } } },
  ]);
  const found = await findRelationshipHolder(c, 'contoso_missing', { candidates: ['contoso_project'] });
  assert.deepStrictEqual(found, { found: false });
});

test('a 500 on the exact-name read is found:null and does not fall back', async () => {
  const c = client([
    { test: (p) => p.startsWith('/RelationshipDefinitions('), status: 500, body: { error: { message: 'server' } } },
  ]);
  const found = await findRelationshipHolder(c, 'contoso_project_contoso_task', { candidates: ['contoso_project'] });
  assert.strictEqual(found.found, null);
  assert.strictEqual(found.status, 500);
  assert.ok(c.paths.every((p) => p.startsWith('/RelationshipDefinitions(')));
});

test('a 429 on the exact-name read is found:null with status 429', async () => {
  const c = client([
    { test: (p) => p.startsWith('/RelationshipDefinitions('), status: 429, body: { error: { message: 'try again later' } } },
  ]);
  const found = await findRelationshipHolder(c, 'contoso_project_contoso_task', { candidates: ['contoso_task'] });
  assert.strictEqual(found.found, null);
  assert.strictEqual(found.status, 429);
  assert.ok(!c.paths.some((p) => p.includes('/EntityDefinitions(')));
});

test('projectionHolder turns the SDK row into ends before compare or describe', () => {
  const { projectionHolder } = require(path.join(__dirname, '..', 'lib', 'relationship-metadata.js'));
  const one = projectionHolder(
    { type: 'OneToMany', schemaName: 'contoso_project_contoso_task', relatedEntity: 'contoso_task', relatedAttribute: 'contoso_projectid' },
    'contoso_project',
  );
  assert.strictEqual(describeRelationship(one), '1:N contoso_project -> contoso_task (lookup contoso_projectid)');
  const many = projectionHolder(
    { type: 'ManyToOne', schemaName: 'contoso_item_contoso_item', relatedEntity: 'contoso_item', relatedAttribute: 'contoso_itemid' },
    'contoso_item',
  );
  assert.strictEqual(many.referencingAttribute, undefined, 'the parent key is not a lookup');
  assert.strictEqual(describeRelationship(many), '1:N contoso_item -> contoso_item');
});

test('sameRelationship matches endpoints case-insensitively and rejects a different lookup or type', () => {
  const declared = {
    type: 'OneToMany',
    schemaName: 'contoso_project_contoso_task',
    referenced: 'contoso_project',
    referencing: 'contoso_task',
    lookup: { schemaName: 'contoso_ProjectId' },
  };
  const holder = {
    schemaName: 'CONTOSO_PROJECT_CONTOSO_TASK',
    type: 'OneToMany',
    referencedEntity: 'Contoso_Project',
    referencingEntity: 'Contoso_Task',
    referencingAttribute: 'contoso_projectid',
  };
  assert.strictEqual(sameRelationship(declared, holder), true);
  assert.strictEqual(sameRelationship(declared, { ...holder, referencingAttribute: 'contoso_ownerid' }), false);
  assert.strictEqual(sameRelationship(
    { type: 'ManyToMany', schemaName: 'contoso_project_contoso_task', entity1: 'contoso_task', entity2: 'contoso_project' },
    { schemaName: 'contoso_project_contoso_task', type: 'OneToMany', referencedEntity: 'contoso_project', referencingEntity: 'contoso_task', referencingAttribute: 'contoso_projectid' },
  ), false);
  assert.strictEqual(sameRelationship(
    { type: 'ManyToMany', entity1: 'contoso_tag', entity2: 'contoso_project' },
    { type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_tag' },
  ), true);
});

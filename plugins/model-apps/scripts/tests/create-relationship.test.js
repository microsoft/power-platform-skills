'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'create-relationship.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('create-relationship.js posts to RelationshipDefinitions for both 1n and nn', () => {
  assert.match(scriptSrc, /RelationshipDefinitions/);
  assert.match(scriptSrc, /OneToManyRelationshipMetadata/);
  assert.match(scriptSrc, /ManyToManyRelationshipMetadata/);
});

test('create-relationship.js builds OneToManyRelationshipMetadata payload', () => {
  assert.match(scriptSrc, /OneToManyRelationshipMetadata/);
  assert.match(scriptSrc, /CascadeConfiguration/);
});

test('create-relationship.js builds ManyToManyRelationshipMetadata payload', () => {
  assert.match(scriptSrc, /ManyToManyRelationshipMetadata/);
  assert.match(scriptSrc, /IntersectEntityName/);
});

test('create-relationship.js: missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('create-relationship.js: unknown kind exits 1', () => {
  const res = spawnSync(process.execPath, [scriptPath, 'foo', 'https://example.crm.dynamics.com'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown relationship kind/);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPromptSpec } = require('../lib/ai-prompt.js');

const entity = { schemaName:'New_Case', displayName:'Case', primaryAttribute:{schemaName:'new_caseid'}, columns:[
  {schemaName:'new_caseid',type:'AutoNumber',displayName:'Case #'},
  {schemaName:'new_status',type:'Choice',displayName:'Status'},
  {schemaName:'new_priority',type:'Choice',displayName:'Priority'},
  {schemaName:'new_notes',type:'Memo',displayName:'Notes'},
  {schemaName:'new_owner',type:'Lookup',displayName:'Owner'} ] };

test('buildPromptSpec excludes PK/autonumber/lookup, caps columns, sets primaryKey', () => {
  const p = buildPromptSpec(entity, { spec: { entities:[entity] } });
  assert.strictEqual(p.entityLogicalName, 'new_case');
  assert.strictEqual(p.primaryKey, 'new_caseid');
  assert.ok(!p.columns.some(c => c.logical === 'new_caseid'));   // PK excluded
  assert.ok(!p.columns.some(c => c.logical === 'new_owner'));    // lookup excluded
  assert.ok(p.columns.length <= 6 && p.columns.length >= 1);
  assert.ok(p.columns.every(c => c.logical === c.logical.toLowerCase()));
  assert.strictEqual(p.outputFormat, 'text');
});
test('buildPromptSpec primaryKey is the entity id, NOT the primary NAME column (regression: summary filter must match the record GUID)', () => {
  // Realistic spec entity: primaryAttribute is the NAME column (new_name), the id is new_ohprojectid.
  const proj = { schemaName: 'new_ohproject', displayName: 'Ops Project', primaryAttribute: { schemaName: 'new_name', displayName: 'Project Name' }, columns: [
    { schemaName: 'new_status', type: 'Choice', displayName: 'Status' },
    { schemaName: 'new_budget', type: 'Money', displayName: 'Budget' } ] };
  const p = buildPromptSpec(proj, { spec: { entities: [proj] } });
  assert.strictEqual(p.primaryKey, 'new_ohprojectid', 'primaryKey must be <entity>id, not the primary name column');
  assert.notStrictEqual(p.primaryKey, 'new_name', 'must NOT use primaryAttribute (name column) as the filter key');
});
test('buildPromptSpec default instruction has no GUID/id wording; honors override instruction+columns', () => {
  const def = buildPromptSpec(entity, { spec:{entities:[entity]} });
  assert.ok(!/\bguid\b/i.test(def.instruction) && def.instruction.length > 0);
  const ov = buildPromptSpec(entity, { spec:{entities:[entity]}, override:{ instruction:'Custom.', columns:['new_status'] } });
  assert.strictEqual(ov.instruction, 'Custom.');
  assert.deepStrictEqual(ov.columns, [{ logical:'new_status', display:'Status' }]);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { selectSummaryTables } = require('../lib/ai-candidates.js');

test('selectSummaryTables picks content tables, skips junction/config/D365-owned, honors overrides', () => {
  const spec = { entities: [
    { schemaName: 'new_ticket', columns: [{schemaName:'new_status',type:'Choice'},{schemaName:'new_desc',type:'Memo'}] },
    { schemaName: 'new_ticket_tag', columns: [{schemaName:'new_ticketid',type:'Lookup'},{schemaName:'new_tagid',type:'Lookup'}] },
    { schemaName: 'new_config', columns: [] },
  ], relationships: [{ type:'ManyToMany', entity1:'new_ticket', entity2:'new_ticket_tag' }],
     ai: { summaries: { tables: { new_config: { enabled: false } } } } };
  assert.deepStrictEqual(selectSummaryTables(spec), ['new_ticket']);
});
test('default off returns nothing unless a table opts in', () => {
  const spec = { entities: [{ schemaName:'new_ticket', columns:[{schemaName:'new_desc',type:'Memo'}] }], ai:{ summaries:{ default:'off' } } };
  assert.deepStrictEqual(selectSummaryTables(spec), []);
  spec.ai.summaries.tables = { new_ticket: { enabled: true } };
  assert.deepStrictEqual(selectSummaryTables(spec), ['new_ticket']);
});
test('excludes D365-owned even if explicitly enabled', () => {
  const spec = { entities: [{ schemaName:'incident', columns:[{schemaName:'title',type:'Text'}] }], ai:{ summaries:{ tables:{ incident:{ enabled:true } } } } };
  assert.deepStrictEqual(selectSummaryTables(spec), []);
});

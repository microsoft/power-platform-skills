'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { updateStatus } = require('../mobile-plan-status');
const { renderPlan, splitSections } = require('../render-mobile-plan');
const { checkAgentPreflight } = require('../agent-preflight');
const { createSnapshot } = require('../create-dataverse-snapshot');

test('status updates preserve start time and set prompt awareness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-status-'));
  const file = path.join(dir, 'mobile-app-status.json');
  const first = updateStatus(file, { phase: 'architecture', completed: 1, total: 4 });
  const second = updateStatus(file, { awaitingInput: true, inputPrompt: 'approve architecture' });
  assert.strictEqual(second.startedAt, first.startedAt);
  assert.strictEqual(second.phase, 'architecture');
  assert.strictEqual(second.awaitingInput, true);
});

test('plan renderer creates navigation, progress, and input banner safely', () => {
  const markdown = '## Data Model\n<script>alert(1)</script>\n\n## Screens\nHome';
  const html = renderPlan(markdown, {
    phase: 'architecture approval',
    completed: 2,
    total: 4,
    awaitingInput: true,
    inputPrompt: 'return to terminal',
  });
  assert.strictEqual(splitSections(markdown).length, 2);
  assert.match(html, /50% complete/);
  assert.match(html, /Input required/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('agent preflight selects fallback before dispatch when snapshot is missing', () => {
  const root = path.resolve(__dirname, '..', '..');
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-preflight-'));
  const result = checkAgentPreflight({
    agent: 'data-model-architect',
    workingDir,
    pluginRoot: root,
    snapshot: path.join(workingDir, 'missing-snapshot.json'),
  });
  assert.strictEqual(result.status, 'fallback');
  assert.strictEqual(result.fallback, 'foreground-data-model-from-snapshot');
  assert.ok(result.missing.includes('normalized Dataverse snapshot'));
});

test('snapshot generator normalizes foreground Dataverse metadata', async () => {
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tableNames: ['cr1_newtable'],
    request: async (method, apiPath) => {
      if (apiPath.startsWith('EntityDefinitions?')) {
        return {
          status: 200,
          data: { value: [{
        LogicalName: 'cr1_product',
        SchemaName: 'cr1_Product',
        EntitySetName: 'cr1_products',
        PrimaryIdAttribute: 'cr1_productid',
        PrimaryNameAttribute: 'cr1_name',
        IsCustomEntity: false,
        IsManaged: true,
        IsCustomizable: { Value: true },
        CanCreateAttributes: { Value: true },
        Attributes: [{
          LogicalName: 'cr1_name',
          SchemaName: 'cr1_Name',
          AttributeType: 'String',
          AttributeTypeName: { Value: 'StringType' },
          IsCustomAttribute: true,
          IsPrimaryName: true,
          IsValidForCreate: true,
          IsValidForRead: true,
          IsValidForUpdate: true,
        }],
        ManyToOneRelationships: [{
          SchemaName: 'cr1_Product_Category',
          ReferencingAttribute: 'cr1_categoryid',
          ReferencedEntity: 'cr1_category',
          ReferencedAttribute: 'cr1_categoryid',
        }],
          }] },
        };
      }
      return { status: 404, error: 'not found' };
    },
  });
  assert.strictEqual(snapshot.tables[0].entitySetName, 'cr1_products');
  assert.strictEqual(snapshot.tables[0].columns[0].primaryName, true);
  assert.strictEqual(snapshot.tables[0].columns[0].typeName, 'StringType');
  assert.strictEqual(snapshot.tables[0].columns[0].customAttribute, true);
  assert.strictEqual(snapshot.tables[0].customizable, true);
  assert.strictEqual(snapshot.tables[0].canCreateAttributes, true);
  assert.strictEqual(snapshot.tables[0].manyToOneRelationships[0].targetTable, 'cr1_category');
  assert.deepStrictEqual(snapshot.missingProposedTables, ['cr1_newtable']);
});

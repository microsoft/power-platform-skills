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

test('status updates merge durable delivery outcomes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-outcomes-'));
  const file = path.join(dir, 'mobile-app-status.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, phase: 'planning' }));
  updateStatus(file, {
    outcomeTotal: 8,
    outcome: { id: 'data-ready', label: 'Data layer ready', state: 'running' },
  });
  const result = updateStatus(file, {
    outcome: {
      id: 'data-ready',
      label: 'Data layer ready',
      state: 'completed',
      artifact: '.datamodel-manifest.json',
    },
  });
  assert.strictEqual(result.version, 2);
  assert.strictEqual(result.outcomeTotal, 8);
  assert.strictEqual(result.outcomes.length, 1);
  assert.strictEqual(result.outcomes[0].state, 'completed');
  assert.ok(result.outcomes[0].completedAt);
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

test('plan renderer turns fenced Mermaid ER diagrams into local safe HTML', () => {
  const markdown = [
    '## Data Model',
    '### ER Diagram',
    '```mermaid',
    'erDiagram',
    '  ACCOUNT ||--o{ CONTACT : contains',
    '  CONTACT {',
    '    string name',
    '  }',
    '```',
    '<script>alert(1)</script>',
  ].join('\n');
  const html = renderPlan(markdown);
  assert.match(html, /class="diagram er-diagram"/);
  assert.match(html, /data-er-name>ACCOUNT<\/span>/);
  assert.match(html, /data-er-name>CONTACT<\/span>/);
  assert.match(html, /data-er-cardinality>\|\|--o\{<\/code>/);
  assert.match(html, /contains/);
  assert.match(html, /data-er-field-name>name<\/th>/);
  assert.match(html, /ER review editor/);
  assert.match(html, /data-er-toggle/);
  assert.match(html, /data-er-add-entity/);
  assert.match(html, /data-er-add-field/);
  assert.match(html, /data-er-add-relationship/);
  assert.match(html, /mobile-er-revision\.json/);
  assert.match(html, /This page never mutates the approved plan directly/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.doesNotThrow(() => new Function(scripts.at(-1)[1]));
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|mermaid\.min\.js/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('plan renderer separates review views and renders plan tables with statuses', () => {
  const markdown = [
    '## Data Model',
    '### Target Reconciliation',
    '| Entity | Decision |',
    '|---|---|',
    '| Product | Reuse verified |',
    '## Connectors',
    '| Connector | Status |',
    '|---|---|',
    '| Dataverse | Planned |',
    '| SharePoint | Authentication required |',
    '## Screens',
    '| Screen | Archetype |',
    '|---|---|',
    '| Home | Tab-root |',
    '## Approvals',
    '- Gate 2 blocked by missing connection',
  ].join('\n');
  const html = renderPlan(markdown, { completed: 2, total: 4 });
  assert.match(html, /data-filter="architecture"/);
  assert.match(html, /data-filter="experience"/);
  assert.match(html, /data-filter="implementation"/);
  assert.match(html, /class="plan-table"/);
  assert.match(html, /<strong>1<\/strong><span>Dataverse tables<\/span>/);
  assert.match(html, /<strong>1<\/strong><span>Planned screens<\/span>/);
  assert.match(html, /class="status success">Reuse verified/);
  assert.match(html, /class="status danger">Authentication required/);
  assert.match(html, /Connector status is explicit/);
  assert.match(html, /Concept review:/);
  assert.match(html, /class="concern"/);
});

test('plan renderer shows outcome-driven implementation progress', () => {
  const html = renderPlan('## Data Model\nNo tables.', {
    outcomeTotal: 3,
    outcomes: [
      { id: 'plan', label: 'Architecture approved', state: 'completed', artifact: 'native-app-plan.md' },
      { id: 'data', label: 'Data layer ready', state: 'running', detail: 'Creating Dataverse services' },
      { id: 'screens', label: 'Screens ready', state: 'pending' },
    ],
  });
  assert.match(html, /33% complete/);
  assert.match(html, /<strong>1\/3<\/strong><span>Outcomes delivered<\/span>/);
  assert.match(html, /Delivery outcomes/);
  assert.match(html, /class="outcome completed"/);
  assert.match(html, /Creating Dataverse services/);
  assert.match(html, /native-app-plan\.md/);
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
  const calls = [];
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tableNames: ['cr1_newtable'],
    concepts: ['product'],
    request: async (method, apiPath) => {
      calls.push(apiPath);
      if (apiPath.startsWith('EntityDefinitions?')) {
        return {
          status: 200,
          data: { value: [{
            LogicalName: 'cr1_product',
            SchemaName: 'cr1_Product',
            DisplayName: { UserLocalizedLabel: { Label: 'Product' } },
            DisplayCollectionName: { UserLocalizedLabel: { Label: 'Products' } },
            EntitySetName: 'cr1_products',
            PrimaryIdAttribute: 'cr1_productid',
            PrimaryNameAttribute: 'cr1_name',
            IsCustomEntity: false,
            IsManaged: true,
            IsCustomizable: { Value: true },
            CanCreateAttributes: { Value: true },
          }] },
        };
      }
      if (apiPath.includes('/Attributes?$select=')) {
        return { status: 200, data: { value: [{
          LogicalName: 'cr1_name',
          SchemaName: 'cr1_Name',
          AttributeType: 'String',
          AttributeTypeName: { Value: 'StringType' },
          IsCustomAttribute: true,
          IsPrimaryName: true,
          IsValidForCreate: true,
          IsValidForRead: true,
          IsValidForUpdate: true,
        }, {
          LogicalName: 'cr1_categoryid',
          SchemaName: 'cr1_CategoryId',
          AttributeType: 'Lookup',
          AttributeTypeName: { Value: 'LookupType' },
          MetadataId: 'lookup-metadata-id',
          SourceType: 0,
        }, {
          LogicalName: 'cr1_status',
          SchemaName: 'cr1_Status',
          AttributeType: 'Picklist',
          AttributeTypeName: { Value: 'PicklistType' },
          MetadataId: 'choice-metadata-id',
          SourceType: 0,
        }, {
          LogicalName: 'cr1_total',
          SchemaName: 'cr1_Total',
          AttributeType: 'Decimal',
          AttributeTypeName: { Value: 'DecimalType' },
          MetadataId: 'formula-metadata-id',
          SourceType: 3,
        }, {
          LogicalName: 'cr1_featured',
          SchemaName: 'cr1_Featured',
          AttributeType: 'Boolean',
          AttributeTypeName: { Value: 'BooleanType' },
          MetadataId: 'boolean-metadata-id',
          SourceType: 0,
        }] } };
      }
      if (apiPath.includes('/ManyToOneRelationships?')) {
        return { status: 200, data: { value: [{
          SchemaName: 'cr1_Product_Category',
          ReferencingAttribute: 'cr1_categoryid',
          ReferencedEntity: 'cr1_category',
          ReferencedAttribute: 'cr1_categoryid',
        }] } };
      }
      if (apiPath.includes('/Keys?')) {
        return { status: 200, data: { value: [{
          LogicalName: 'cr1_productcode_key',
          SchemaName: 'cr1_ProductCodeKey',
          KeyAttributes: ['cr1_name'],
          EntityKeyIndexStatus: 'Active',
        }] } };
      }
      if (apiPath.includes('PicklistAttributeMetadata')) {
        return { status: 200, data: { value: [{
          LogicalName: 'cr1_status',
          OptionSet: { Options: [
            { Value: 1, Label: { UserLocalizedLabel: { Label: 'Active' } } },
          ] },
        }] } };
      }
      if (apiPath.includes('BooleanAttributeMetadata')) {
        return { status: 200, data: { value: [{
          LogicalName: 'cr1_featured',
          OptionSet: {
            FalseOption: { Value: 0, Label: { UserLocalizedLabel: { Label: 'No' } } },
            TrueOption: { Value: 1, Label: { UserLocalizedLabel: { Label: 'Yes' } } },
          },
        }] } };
      }
      if (apiPath.includes('LookupAttributeMetadata')) {
        return { status: 200, data: { value: [{
          LogicalName: 'cr1_categoryid',
          Targets: ['cr1_category'],
        }] } };
      }
      if (apiPath.includes('DecimalAttributeMetadata')) {
        return {
          status: 200,
          data: { LogicalName: 'cr1_total', FormulaDefinition: 'cr1_quantity * cr1_price' },
        };
      }
      if (apiPath.includes('/Microsoft.Dynamics.CRM.')) {
        return { status: 200, data: { value: [] } };
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
  const columns = Object.fromEntries(snapshot.tables[0].columns.map((column) => [column.logicalName, column]));
  assert.deepStrictEqual(columns.cr1_categoryid.lookupTargets, ['cr1_category']);
  assert.deepStrictEqual(columns.cr1_status.choices, [{ value: 1, label: 'Active' }]);
  assert.strictEqual(columns.cr1_total.formula, 'cr1_quantity * cr1_price');
  assert.deepStrictEqual(columns.cr1_featured.choices, [
    { value: 0, label: 'No' },
    { value: 1, label: 'Yes' },
  ]);
  assert.deepStrictEqual(snapshot.tables[0].alternateKeys[0].columns, ['cr1_name']);
  assert.deepStrictEqual(snapshot.concepts, ['product']);
  assert.deepStrictEqual(snapshot.missingProposedTables, ['cr1_newtable']);
  assert.ok(calls.every((apiPath) => !apiPath.includes('$expand=Attributes')));
});

test('snapshot generator surfaces formula metadata request failures', async () => {
  await assert.rejects(
    createSnapshot({
      environmentUrl: 'https://example.crm.dynamics.com',
      concepts: ['product'],
      request: async (_method, apiPath) => {
        if (apiPath.startsWith('EntityDefinitions?')) {
          return { status: 200, data: { value: [{
            LogicalName: 'cr1_product',
            SchemaName: 'cr1_Product',
            DisplayName: { UserLocalizedLabel: { Label: 'Product' } },
            IsCustomizable: { Value: true },
            CanCreateAttributes: { Value: true },
          }] } };
        }
        if (apiPath.includes('/Attributes?$select=')) {
          return { status: 200, data: { value: [{
            LogicalName: 'cr1_total',
            AttributeType: 'Decimal',
            MetadataId: 'formula-metadata-id',
            SourceType: 3,
          }] } };
        }
        if (apiPath.includes('/ManyToOneRelationships?') || apiPath.includes('/Keys?')) {
          return { status: 200, data: { value: [] } };
        }
        if (apiPath.includes('/Attributes/Microsoft.Dynamics.CRM.')) {
          return { status: 200, data: { value: [] } };
        }
        if (apiPath.includes('Attributes(formula-metadata-id)')) {
          return { status: 500, error: 'server failure' };
        }
        return { status: 404, error: 'not found' };
      },
    }),
    /formula metadata failed \(500\)/,
  );
});

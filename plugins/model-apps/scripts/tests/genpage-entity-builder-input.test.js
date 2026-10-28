'use strict';

// agents/genpage-entity-builder.md Step 4 tells the /genpage entity-builder how to write the input of provision-entities.js. That
// input is validated by validateProvisionInput (lib/provision-input.js) and built by the same code as an App Spec, so what Step 4 shows
// has to be what that gate accepts and what the build reads — or the documented path fails before anything is written (a Choice option
// written as a {"label", "value"} object: "'label' is not an LCID"), or builds a column without what the plan asked (a DateTime
// `format` where the build reads `dateFormat`). These tests read Step 4 itself, fill its placeholders, and run what it shows through
// the gate and the provisioning core, so the page and the code cannot drift apart again.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { validateProvisionInput } = require('../lib/provision-input.js');
const { TYPE_MAP } = require('../lib/app-spec.js');
const { provisionEntities } = require('../provision-entities.js');

const DOC = path.join(__dirname, '..', '..', 'agents', 'genpage-entity-builder.md');

// Step 4 of the page: from its heading to the next step's.
function stepFour() {
  const text = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('\n## Step 4');
  const end = text.indexOf('\n## Step 5', start + 1);
  assert.ok(start >= 0 && end > start, 'the page has a Step 4 followed by a Step 5');
  return text.slice(start, end);
}

// The page's placeholders, made concrete: the prefix and the solution of the plan's `## Environment`, and any other `<Placeholder>`
// as its letters (`<Display Name>` -> `DisplayName`, `${PREFIX}_<columnSuffix>` -> `new_columnSuffix`).
function fill(text) {
  return text
    .replace(/\$\{PREFIX\}|<PREFIX>/g, 'new')
    .replace(/<SOLUTION>/g, 'Default')
    .replace(/<([^<>"\n]+)>/g, (_, inner) => inner.replace(/[^A-Za-z0-9]/g, ''));
}

// Every ```json block of Step 4, parsed after its placeholders are filled. A column whose type is itself a placeholder takes a
// real type, as the entity-builder gives it one from the mapping table.
function jsonBlocks() {
  const blocks = [];
  for (const match of stepFour().matchAll(/```json\n([\s\S]*?)```/g)) {
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(fill(match[1])); }, `a JSON block of Step 4 parses once its placeholders are filled:\n${match[1]}`);
    blocks.push(parsed);
  }
  for (const block of blocks) {
    for (const entity of block.entities || []) {
      for (const column of entity.columns || []) if (!Object.hasOwn(TYPE_MAP, column.type)) column.type = 'Text';
    }
  }
  return blocks;
}

// An input holds every table its relationships name: a placeholder relationship names its own tables, which the skeleton's one table
// stands in for.
function withTablesFor(input) {
  const out = JSON.parse(JSON.stringify(input));
  const template = out.entities[0];
  const named = new Set(out.entities.map((e) => e.schemaName.toLowerCase()));
  for (const r of out.relationships || []) {
    for (const table of [r.referenced, r.referencing, r.entity1, r.entity2]) {
      if (typeof table !== 'string' || named.has(table.toLowerCase())) continue;
      named.add(table.toLowerCase());
      out.entities.push({ ...template, schemaName: table, columns: [] });
    }
  }
  return out;
}

// The rows of Step 4's type mapping table: | `plan type` | `AppSpecType` | properties |.
function typeRows() {
  const rows = [];
  for (const line of stepFour().split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 3 || !/^`[A-Za-z]+`$/.test(cells[1])) continue;
    rows.push({ planType: cells[0], type: cells[1].slice(1, -1), properties: cells[2] });
  }
  return rows;
}

// A property name in a row is a backticked identifier that starts in lower case (`maxLength`); a value is not (`Email`, `DateOnly`, a JSON example).
const propertyNames = (cell) => [...cell.matchAll(/`([a-z][A-Za-z]*)`/g)].map((m) => m[1]);

// A value each documented property can take, and the key of the SDK's column options it reaches (lib/entity-provision.js columnOptions).
const SAMPLE = {
  maxLength: [250, 'maxLength'], format: ['Email', 'stringFormat'], minValue: [0, 'minValue'], maxValue: [10, 'maxValue'],
  precision: [2, 'precision'], dateFormat: ['DateOnly', 'dateFormat'], defaultValue: [true, 'defaultValue'],
  trueLabel: ['Open', 'trueLabel'], falseLabel: ['Closed', 'falseLabel'],
};

// One table, as the entity-builder writes it, to hold the column a test puts in: the documented examples are tried on their own, so that
// one of them going wrong names itself.
const oneTable = (columns) => ({
  solution: { uniqueName: 'Default', publisherPrefix: 'new' },
  entities: [{ schemaName: 'new_Ticket', displayName: 'Ticket', pluralName: 'Tickets', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns }],
  relationships: [],
});

function mockDeps() {
  const created = [];
  const sdk = {
    queryRecords: async () => [{ solutionid: 's' }], createPublisher: async () => ({ id: 'p' }), createSolution: async () => ({ id: 's' }),
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }),
    updateTable: async () => ({}), updateColumn: async () => ({}),
    createColumn: async (l, o) => { created.push(o); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
    createGlobalOptionSet: async () => ({ metadataId: 'g' }), insertStatusValue: async () => 1, createAlternateKey: async () => ({}),
    createCustomerColumn: async (l, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }),
    createRelationship: async (o) => ({ schemaName: o.schemaName, metadataId: `rel-${o.schemaName}` }),
  };
  const provision = { findTables: async () => [], findColumns: async () => [], fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }), queryRecords: async () => [{ solutionid: 's' }] };
  return { sdk, provision, created };
}

test('the input Step 4 shows is accepted by the provision-entities gate', () => {
  const [skeleton] = jsonBlocks();
  assert.ok(skeleton && Array.isArray(skeleton.entities), 'the first JSON block of Step 4 is the input');
  const result = validateProvisionInput(withTablesFor(skeleton));
  assert.deepStrictEqual(result, { ok: true, errors: [] });
});

test('every relationship Step 4 shows is accepted inside an input that holds its tables', () => {
  const [skeleton, ...rest] = jsonBlocks();
  const relationships = rest.filter((block) => block && typeof block.type === 'string');
  assert.deepStrictEqual(relationships.map((r) => r.type).sort(), ['ManyToMany', 'OneToMany'], 'Step 4 shows a 1:N and an N:N relationship');
  for (const relationship of relationships) {
    const result = validateProvisionInput(withTablesFor({ ...skeleton, relationships: [relationship] }));
    assert.deepStrictEqual(result, { ok: true, errors: [] }, JSON.stringify(relationship));
  }
});

test('the Choice options Step 4 shows are accepted and become options numbered 100000000 + index, labelled as written', async () => {
  const row = typeRows().find((r) => r.type === 'Choice');
  assert.ok(row, 'the type mapping table has a Choice row');
  // The example is the first JSON array the row shows in backticks (an ellipsis that stands for "and so on" is left out).
  const example = [...row.properties.matchAll(/`[^`]*?(\[[^`]*\])[^`]*`/g)].map((m) => m[1].replace(/,\s*\.\.\.\s*\]$/, ']'))[0];
  assert.ok(example, `the Choice row shows its options: ${row.properties}`);
  const options = JSON.parse(example);
  const input = oneTable([{ schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options }]);
  assert.deepStrictEqual(validateProvisionInput(input), { ok: true, errors: [] });
  const d = mockDeps();
  const result = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  const column = d.created.find((c) => c.schemaName === 'new_priority');
  assert.deepStrictEqual(column.options, options.map((label, i) => ({ value: 100000000 + i, label })));
});

test('every property the type mapping table names reaches the column the build creates', async () => {
  const rows = typeRows();
  assert.ok(rows.length >= 8, `the table maps the plan's types: ${JSON.stringify(rows)}`);
  for (const row of rows) {
    assert.ok(Object.hasOwn(TYPE_MAP, row.type), `${row.planType} maps to an App Spec type: ${row.type}`);
    for (const property of propertyNames(row.properties)) {
      if (property === 'options') continue; // the Choice test above
      assert.ok(SAMPLE[property], `${row.type}: '${property}' is not a property the build reads for a column (lib/entity-provision.js columnOptions)`);
      const [value, sdkKey] = SAMPLE[property];
      const input = oneTable([{ schemaName: 'new_sample', displayName: 'Sample', type: row.type, [property]: value }]);
      assert.deepStrictEqual(validateProvisionInput(input), { ok: true, errors: [] }, `${row.type}.${property}`);
      const d = mockDeps();
      const result = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision });
      assert.strictEqual(result.ok, true, `${row.type}.${property}: ${JSON.stringify(result.errors)}`);
      const column = d.created.find((c) => c.schemaName === 'new_sample');
      assert.ok(column, `${row.type}.${property}: the column was created`);
      assert.deepStrictEqual(column[sdkKey], value, `${row.type}.${property} reaches the create as ${sdkKey}`);
    }
  }
});

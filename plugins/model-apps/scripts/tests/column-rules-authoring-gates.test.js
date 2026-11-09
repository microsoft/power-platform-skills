'use strict';

// The two column rules (lib/app-spec.js: an AutoNumber column needs a format, and `required` is true, false or "recommended") are errors on every path
// that builds, plans or provisions. Read-only verification alone turns them into warnings — verify-model-app.js passes `columnValues: 'warn'`, as it passes
// `relationshipCollisions: 'warn'` — because it creates and updates nothing and the spec of an app an earlier release built must still reach the deployment
// (verify-model-app.test.js runs the CLI over such specs). These tests pin that the downgrade is that narrow: an option only that one caller passes, which moves
// nothing but these two rules, and which no authoring gate takes.

const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec } = require('../lib/app-spec.js');
const { validateProvisionInput } = require('../lib/provision-input.js');
const { lintSpec } = require('../lint-app-spec.js');
const { buildModelApp } = require('../build-model-app.js');
const { provisionEntities } = require('../provision-entities.js');
const { scriptsMatching } = require('./helpers/production-scripts.js');
const { BUILDING_PROFILES, column, nameColumn, appSpec, provisionInput, watchedDeps } = require('./helpers/column-gate-specs.js');

const FORMAT_FINDING = 'entity new_ticket: column new_ref is an AutoNumber column but its autoNumberFormat is missing — give it a format such as "C-{SEQNUM:5}", or use type "Text" for a plain text column';
const OMIT_THE_KEY = "omit the key to leave an existing column's level as it is";
const COLUMN_FINDING = `entity new_ticket: column new_status required must be true, false or "recommended" (got "true") — write true for a required column; ${OMIT_THE_KEY}`;
const PRIMARY_FINDING = `entity new_ticket: primaryAttribute.required must be true, false or "recommended" (got "ApplicationRequired") — write true for a required column; ${OMIT_THE_KEY}`;

// Both rules broken at once, in an order the validator reports them: the name column first, then each column in turn.
const olderSpec = () => appSpec({
  columns: [column({ type: 'AutoNumber' }), column({ schemaName: 'new_status', type: 'Text', required: 'true' })],
  primaryAttribute: nameColumn({ required: 'ApplicationRequired' }),
});
const FINDINGS = [PRIMARY_FINDING, FORMAT_FINDING, COLUMN_FINDING];

// --- the downgrade, as validateAppSpec takes it -----------------------------------------------------------------------------------

test('columnValues: "warn" moves the findings of both rules from errors to warnings, in the wording they have as errors, and moves nothing else', () => {
  const strict = validateAppSpec(olderSpec(), { profile: 'deploy' });
  assert.deepStrictEqual(strict.errors, FINDINGS);
  assert.deepStrictEqual(strict.warnings, []);

  const lenient = validateAppSpec(olderSpec(), { profile: 'deploy', columnValues: 'warn' });
  assert.strictEqual(lenient.ok, true, JSON.stringify(lenient.errors));
  assert.deepStrictEqual(lenient.errors, []);
  assert.deepStrictEqual(lenient.warnings, FINDINGS, 'the same sentences, as warnings');

  // Any other problem of the spec is still an error beside them.
  const spec = olderSpec();
  spec.entities[0].columns.push(column({ schemaName: 'new_bad', type: 'Nope' }));
  const mixed = validateAppSpec(spec, { profile: 'deploy', columnValues: 'warn' });
  assert.strictEqual(mixed.ok, false);
  assert.deepStrictEqual(mixed.errors, ["entity new_ticket: column new_bad has unknown type 'Nope'"]);
  assert.deepStrictEqual(mixed.warnings, FINDINGS);
});

test('only the value "warn" downgrades, and relationshipCollisions: "warn" alone does not', () => {
  for (const options of [{}, { columnValues: undefined }, { columnValues: true }, { columnValues: 'error' }, { columnValues: 'WARN' }, { columnValues: 'warning' }, { relationshipCollisions: 'warn' }]) {
    const result = validateAppSpec(olderSpec(), { profile: 'deploy', ...options });
    assert.strictEqual(result.ok, false, JSON.stringify(options));
    assert.deepStrictEqual(result.errors, FINDINGS, JSON.stringify(options));
  }
  // And the two downgrades are independent: columnValues leaves a relationship-name collision an error.
  const collision = { ...olderSpec(), relationships: [
    { type: 'OneToMany', referenced: 'new_ticket', referencing: 'new_ticket', lookup: { schemaName: 'new_ParentId', displayName: 'Parent' } },
    { type: 'ManyToMany', entity1: 'new_ticket', entity2: 'new_ticket' },
  ] };
  const both = validateAppSpec(collision, { profile: 'deploy', columnValues: 'warn', relationshipCollisions: 'warn' });
  assert.strictEqual(both.ok, true, JSON.stringify(both.errors));
  const columnsOnly = validateAppSpec(collision, { profile: 'deploy', columnValues: 'warn' });
  assert.strictEqual(columnsOnly.ok, false, 'a collision is still an error when only the column rules are downgraded');
  assert.ok(columnsOnly.errors.some((e) => /both use the schema name/.test(e)), JSON.stringify(columnsOnly.errors));
});

test('the structural profile, which never held a spec to these rules, says nothing about them with or without the option', () => {
  for (const options of [{}, { columnValues: 'warn' }]) {
    const result = validateAppSpec(olderSpec(), { profile: 'structural', ...options });
    assert.deepStrictEqual(result.errors, [], JSON.stringify(options));
    assert.deepStrictEqual(result.warnings, [], JSON.stringify(options));
  }
});

test('a spec that satisfies both rules has no finding to move: the result is the same with and without the option', () => {
  const spec = appSpec({ columns: [column({ type: 'AutoNumber', autoNumberFormat: 'C-{SEQNUM:5}', required: 'recommended' })], primaryAttribute: nameColumn({ required: true }) });
  const strict = validateAppSpec(spec, { profile: 'deploy' });
  const lenient = validateAppSpec(spec, { profile: 'deploy', columnValues: 'warn' });
  assert.deepStrictEqual(lenient, strict);
  assert.deepStrictEqual(strict.errors, []);
});

// --- every authoring path keeps them as errors ------------------------------------------------------------------------------------

test('lint (the authoring flow\'s gate, which defaults to the plan profile) reports both rules as schema errors under every profile that builds', () => {
  for (const options of [undefined, ...BUILDING_PROFILES.map((profile) => ({ profile }))]) {
    const report = lintSpec(olderSpec(), options);
    const label = JSON.stringify(options);
    assert.strictEqual(report.ok, false, label);
    for (const finding of FINDINGS) assert.ok(report.errors.includes(`schema: ${finding}`), `${label}: ${finding}\n${JSON.stringify(report.errors)}`);
    assert.ok(!report.warnings.some((w) => FINDINGS.some((f) => w.includes(f))), `${label}: none of them is only a warning`);
  }
});

test('the build refuses both rules before any call — dry run or apply, under the default and the plan profile', async () => {
  for (const options of [{ apply: true }, { apply: false }, { apply: true, profile: 'plan' }, { apply: false, profile: 'deploy' }]) {
    const d = watchedDeps();
    const result = await buildModelApp(olderSpec(), { env: 'https://x', ...options }, { sdk: d.sdk, provisionSdk: d.provision });
    const label = JSON.stringify(options);
    assert.strictEqual(result.ok, false, label);
    assert.deepStrictEqual(result.errors, FINDINGS, label);
    assert.deepStrictEqual(d.touched, [], `${label}: nothing was called`);
  }
});

test('the provision-entities gate has no downgrade: it refuses both rules, however it is called, before anything is called', async () => {
  const input = () => provisionInput({
    columns: [column({ type: 'AutoNumber' }), column({ schemaName: 'new_status', type: 'Text', required: 'true' })],
    primaryAttribute: nameColumn({ required: 'ApplicationRequired' }),
  });
  // An extra argument is ignored: the validator takes the input and nothing else.
  const validated = validateProvisionInput(input(), { columnValues: 'warn' });
  assert.strictEqual(validated.ok, false);
  assert.strictEqual(validated.errors.length, 3, JSON.stringify(validated.errors));
  for (const options of [{ apply: true }, { apply: false }]) {
    const d = watchedDeps();
    const result = await provisionEntities(input(), options, { sdk: d.sdk, provision: d.provision });
    assert.strictEqual(result.ok, false, JSON.stringify(options));
    assert.strictEqual(result.errors.length, 3, JSON.stringify(result.errors));
    assert.deepStrictEqual(d.touched, [], `${JSON.stringify(options)}: nothing was called`);
  }
});

test('no script but the verify CLI passes the downgrade', () => {
  assert.deepStrictEqual(scriptsMatching(/columnValues\s*:\s*['"]warn['"]/), ['verify-model-app.js']);
});

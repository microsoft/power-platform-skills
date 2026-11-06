'use strict';

// `entities[].primaryAttribute` takes the keys the build reads from it — schemaName, displayName, autoNumberFormat, required and maxLength —
// and no other. Before it had this list a misspelled key (`maxlength`, `autonumberFormat`) or a Dataverse name for one (`requiredLevel`)
// validated clean and the build ignored it, so the table was made without the length, the number format or the level the author wrote.
// It now gets what an unknown key of the table itself gets (ENTITY_KEYS) and of a form's fieldOptions entry: an error, which names the
// key, the key it most likely meant and the keys that are allowed, on every path that builds, plans, lints or provisions. Read-only paths
// keep reading such a spec, as they do for a fieldOptions key — an earlier release accepted it and built the table without the option:
// the structural profile (teardown, preview) and verification (`primaryAttributeKeys: 'warn'`, which only verify-model-app.js passes) take
// it as a warning in the same words.

const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec } = require('../lib/app-spec.js');
const { validateProvisionInput } = require('../lib/provision-input.js');
const { lintSpec } = require('../lint-app-spec.js');
const { buildModelApp } = require('../build-model-app.js');
const { provisionEntities } = require('../provision-entities.js');
const { primaryColumnOptionFields } = require('../lib/download-column-options.js');
const { scriptsMatching } = require('./helpers/production-scripts.js');
const { BUILDING_PROFILES, nameColumn, appSpec, provisionInput, watchedDeps } = require('./helpers/column-gate-specs.js');

const ALLOWED = '(allowed: schemaName, displayName, autoNumberFormat, required, maxLength)';
// What each slip is told, after the table and the key: the key it most likely meant, or what to write instead.
const SLIPS = [
  ['maxlength', 100, " — did you mean 'maxLength'?"],
  ['autonumberFormat', 'T-{SEQNUM:5}', " — did you mean 'autoNumberFormat'?"],
  ['requiredLevel', 'ApplicationRequired', ' — the level is \'required\': true, "recommended" or false'],
  ['type', 'Text', " — the primary name column is always a single line of text: leave 'type' out (for an auto-numbered name, give 'autoNumberFormat')"],
  ['description', 'The ticket title', ''],
];
const specFinding = (key, hint) => `entity new_ticket: unknown key '${key}' on primaryAttribute${hint} ${ALLOWED}`;
const inputFinding = (key, hint) => `entity 'new_ticket': unknown key '${key}' on primaryAttribute${hint} ${ALLOWED}`;
const withKey = (key, value) => nameColumn({ [key]: value });

// --- the authoring gates refuse it -----------------------------------------------------------------------------------------------------

test('an unknown primaryAttribute key is an error that names the key, the key it most likely meant and the allowed keys', () => {
  for (const [key, value, hint] of SLIPS) {
    const result = validateAppSpec(appSpec({ primaryAttribute: withKey(key, value) }), { profile: 'deploy' });
    assert.strictEqual(result.ok, false, key);
    assert.deepStrictEqual(result.errors, [specFinding(key, hint)], key);
    assert.deepStrictEqual(result.warnings, [], key);
  }
});

test('every profile that builds or plans a build refuses it', () => {
  for (const profile of BUILDING_PROFILES) {
    const result = validateAppSpec(appSpec({ primaryAttribute: withKey('maxlength', 100) }), { profile });
    assert.strictEqual(result.ok, false, profile);
    assert.deepStrictEqual(result.errors, [specFinding('maxlength', " — did you mean 'maxLength'?")], profile);
  }
});

test('lint reports it as a schema error under every profile that builds', () => {
  for (const options of [undefined, ...BUILDING_PROFILES.map((profile) => ({ profile }))]) {
    const report = lintSpec(appSpec({ primaryAttribute: withKey('requiredLevel', 'ApplicationRequired') }), options);
    const label = JSON.stringify(options);
    assert.strictEqual(report.ok, false, label);
    assert.ok(report.errors.includes(`schema: ${specFinding('requiredLevel', SLIPS[2][2])}`), `${label}\n${JSON.stringify(report.errors)}`);
  }
});

test('the build refuses it before any call, dry run or apply', async () => {
  // With navigation, so that without the rule the dry run would plan the build and the apply would call the SDK.
  const spec = () => ({ ...appSpec({ primaryAttribute: withKey('maxlength', 100) }), appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] } });
  for (const options of [{ apply: true }, { apply: false }]) {
    const d = watchedDeps();
    const result = await buildModelApp(spec(), { env: 'https://contoso.crm.dynamics.com', ...options }, { sdk: d.sdk, provisionSdk: d.provision });
    assert.strictEqual(result.ok, false, JSON.stringify(options));
    assert.deepStrictEqual(result.errors, [specFinding('maxlength', " — did you mean 'maxLength'?")], JSON.stringify(options));
    assert.deepStrictEqual(d.touched, [], `${JSON.stringify(options)}: nothing was called`);
  }
});

test('the provision-entities gate (the /genpage path) refuses it in its own wording, before anything is called', async () => {
  for (const [key, value, hint] of SLIPS) {
    const validated = validateProvisionInput(provisionInput({ primaryAttribute: withKey(key, value) }));
    assert.strictEqual(validated.ok, false, key);
    assert.deepStrictEqual(validated.errors, [inputFinding(key, hint)], key);
  }
  for (const options of [{ apply: true }, { apply: false }]) {
    const d = watchedDeps();
    const result = await provisionEntities(provisionInput({ primaryAttribute: withKey('autonumberFormat', 'T-{SEQNUM:5}') }), options, { sdk: d.sdk, provision: d.provision });
    assert.strictEqual(result.ok, false, JSON.stringify(options));
    assert.deepStrictEqual(result.errors, [inputFinding('autonumberFormat', " — did you mean 'autoNumberFormat'?")]);
    assert.deepStrictEqual(d.touched, [], `${JSON.stringify(options)}: nothing was called`);
  }
});

// --- the read-only paths keep reading it ----------------------------------------------------------------------------------------------

test('the structural profile (teardown, preview) takes it as a warning in the same words', () => {
  const result = validateAppSpec(appSpec({ primaryAttribute: withKey('maxlength', 100) }), { profile: 'structural' });
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.warnings, [specFinding('maxlength', " — did you mean 'maxLength'?")]);
});

test('primaryAttributeKeys: "warn" (verification) moves it to the warnings, and only the value "warn" does', () => {
  const lenient = validateAppSpec(appSpec({ primaryAttribute: withKey('maxlength', 100) }), { profile: 'deploy', primaryAttributeKeys: 'warn' });
  assert.strictEqual(lenient.ok, true, JSON.stringify(lenient.errors));
  assert.deepStrictEqual(lenient.warnings, [specFinding('maxlength', " — did you mean 'maxLength'?")]);
  // The other downgrades are independent of it, and any other value keeps the error.
  for (const options of [{}, { primaryAttributeKeys: 'WARN' }, { primaryAttributeKeys: true }, { columnValues: 'warn' }, { fieldOptionKeys: 'warn' }, { relationshipCollisions: 'warn' }]) {
    const strict = validateAppSpec(appSpec({ primaryAttribute: withKey('maxlength', 100) }), { profile: 'deploy', ...options });
    assert.strictEqual(strict.ok, false, JSON.stringify(options));
    assert.deepStrictEqual(strict.errors, [specFinding('maxlength', " — did you mean 'maxLength'?")], JSON.stringify(options));
  }
  // Any other problem of the spec is still an error beside it.
  const spec = appSpec({ primaryAttribute: withKey('maxlength', 100) });
  spec.entities[0].columns.push({ schemaName: 'new_bad', displayName: 'Bad', type: 'Nope' });
  const mixed = validateAppSpec(spec, { profile: 'deploy', primaryAttributeKeys: 'warn' });
  assert.deepStrictEqual(mixed.errors, ["entity new_ticket: column new_bad has unknown type 'Nope'"]);
  assert.deepStrictEqual(mixed.warnings, [specFinding('maxlength', " — did you mean 'maxLength'?")]);
});

test('no script but the verify CLI passes the primaryAttribute downgrade', () => {
  assert.deepStrictEqual(scriptsMatching(/primaryAttributeKeys\s*:\s*['"]warn['"]/), ['verify-model-app.js']);
});

// --- what must not move ---------------------------------------------------------------------------------------------------------------

test('every key the build reads validates clean, on both gates', () => {
  const full = nameColumn({ autoNumberFormat: 'T-{SEQNUM:5}', required: 'recommended', maxLength: 120 });
  for (const profile of [...BUILDING_PROFILES, 'structural']) {
    const result = validateAppSpec(appSpec({ primaryAttribute: full }), { profile });
    assert.deepStrictEqual(result.errors, [], profile);
    assert.deepStrictEqual(result.warnings, [], profile);
  }
  assert.deepStrictEqual(validateProvisionInput(provisionInput({ primaryAttribute: full })), { ok: true, errors: [] });
});

test('the name column a download writes validates clean', () => {
  const downloaded = { schemaName: 'new_name', displayName: 'Name', ...primaryColumnOptionFields({ MaxLength: 850, AutoNumberFormat: 'T-{SEQNUM:5}' }) };
  assert.deepStrictEqual(Object.keys(downloaded).sort(), ['autoNumberFormat', 'displayName', 'maxLength', 'schemaName']);
  const result = validateAppSpec(appSpec({ primaryAttribute: downloaded }), { profile: 'plan', reconstructed: true });
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.warnings, []);
});

test('a key named like an Object.prototype member is reported as itself, with no native function in the message', () => {
  for (const key of ['constructor', 'toString', '__proto__x']) {
    const result = validateAppSpec(appSpec({ primaryAttribute: withKey(key, 'x') }), { profile: 'deploy' });
    assert.deepStrictEqual(result.errors, [specFinding(key, '')], key);
    assert.ok(!/native code/.test(result.errors.join(' ')), key);
  }
});

test('a primaryAttribute that is not an object, or is missing, gets the errors it always got and no key finding', () => {
  for (const [value, expected] of [
    [undefined, ['entity new_ticket: primaryAttribute.schemaName required']],
    ['new_name', ['entity new_ticket: primaryAttribute.schemaName required']],
    [['new_name'], ['entity new_ticket: primaryAttribute.schemaName required']],
  ]) {
    const spec = appSpec();
    if (value === undefined) delete spec.entities[0].primaryAttribute;
    else spec.entities[0].primaryAttribute = value;
    const result = validateAppSpec(spec, { profile: 'deploy' });
    assert.deepStrictEqual(result.errors, expected, JSON.stringify(value));
  }
});

test('a primaryAttribute whose keys cannot be enumerated is a finding, not a crash', () => {
  const trap = new Proxy(nameColumn(), { ownKeys() { throw new Error('boom'); } });
  const spec = appSpec({ primaryAttribute: trap });
  let result;
  assert.doesNotThrow(() => { result = validateAppSpec(spec, { profile: 'deploy' }); });
  assert.deepStrictEqual(result.errors, ['entity new_ticket: primaryAttribute could not be inspected — enumerating its keys threw']);
  let input;
  assert.doesNotThrow(() => { input = validateProvisionInput(provisionInput({ primaryAttribute: trap })); });
  assert.deepStrictEqual(input.errors, ["entity 'new_ticket': primaryAttribute could not be inspected — enumerating its keys threw"]);
});

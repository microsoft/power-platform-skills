'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'preview-form.js');
const tempDirs = [];

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSpec(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-form-test-'));
  tempDirs.push(dir);
  const specPath = path.join(dir, 'app-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
  return specPath;
}

function run(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

function validSpec() {
  return {
    solution: { uniqueName: 'new_service', publisherPrefix: 'new' },
    app: { name: 'Service Console' },
    entities: [
      {
        schemaName: 'new_account',
        displayName: 'Account',
        hasNotes: true,
        primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: [
          { schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['Active', 'Dormant'] },
        ],
      },
      {
        schemaName: 'new_contact',
        displayName: 'Contact',
        primaryAttribute: { schemaName: 'new_fullname', displayName: 'Full Name' },
        columns: [],
      },
    ],
    forms: [
      { entity: 'new_account', name: 'Account Main', tabs: [{ label: 'Summary', sections: [{ label: 'Details', fields: ['new_name', 'new_status'] }] }] },
      { entity: 'new_contact', name: 'Contact Main', tabs: [{ label: 'Summary', sections: [{ label: 'Details', fields: ['new_fullname'] }] }] },
    ],
  };
}

test('missing spec argument exits 1 with the CLI usage string', () => {
  const res = run([]);

  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: node scripts\/preview-form\.js --spec @<app-folder>\/app-spec\.json/);
  assert.equal(res.stdout, '');
});

test('renders the requested entity form only, including field widget hints from the spec', () => {
  const specPath = writeSpec(validSpec());

  const res = run(['--spec', '@' + specPath, '--entity', 'new_account']);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Account Main/);
  assert.match(res.stdout, /Name \*/);
  assert.match(res.stdout, /Status/);
  assert.match(res.stdout, /▼ select/);
  assert.match(res.stdout, /Notes \/ Timeline/);
  assert.doesNotMatch(res.stdout, /Contact Main/);
});

test('accepts a positional spec path and reports when an entity has no forms', () => {
  const specPath = writeSpec(validSpec());

  const res = run([specPath, '--entity', 'new_missing']);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\(no forms in spec for 'new_missing'\)/);
});

test('invalid App Spec prints validation errors instead of throwing from the renderer', () => {
  const specPath = writeSpec({ solution: { uniqueName: 'new_bad', publisherPrefix: 'new' }, app: { name: 'Broken' }, forms: [{ entity: 'new_missing' }] });

  const res = run(['--spec', '@' + specPath]);

  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /Invalid App Spec:/);
  assert.match(res.stderr, /at least one entity is required/);
  assert.match(res.stderr, /form references unknown entity 'new_missing'/);
  assert.doesNotMatch(res.stderr, /TypeError/);
});

// A key a form's `fieldOptions` entry does not take is refused by the build and the lint, but a release before that check
// accepted it and built the form without the option. The preview reads the spec under the structural profile, as teardown
// does, where that finding is a warning: the form still renders, without the misspelled option.
function specWithFieldOptions(entry) {
  const spec = validSpec();
  spec.forms[0] = { entity: 'new_account', name: 'Account Main', fieldOptions: { new_status: entry } };
  return spec;
}

test('a form whose fieldOptions entry carries a key it does not take still renders, without that option', () => {
  const res = run(['--spec', '@' + writeSpec(specWithFieldOptions({ readOnlyy: true })), '--entity', 'new_account']);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Account Main/);
  assert.match(res.stdout, /Status/);
  assert.doesNotMatch(res.stdout, /read-only/, 'the misspelled option is not applied');
});

test('such a form is still refused for any other problem of its fieldOptions, and the unknown key is no part of the refusal', () => {
  const res = run(['--spec', '@' + writeSpec(specWithFieldOptions({ readOnlyy: true, readOnly: false }))]);

  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /Invalid App Spec:/);
  assert.match(res.stderr, /fieldOptions\['new_status'\] sets readOnly: false/);
  assert.doesNotMatch(res.stderr, /unknown key/);
});

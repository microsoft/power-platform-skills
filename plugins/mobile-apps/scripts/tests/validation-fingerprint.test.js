'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { reusableValidation, validationFingerprint } = require('../validate-mobile-app');

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-validation-fingerprint-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mobile-app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'index.tsx'), 'export default function Home() { return null; }\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"type-check":"tsc --noEmit"}}\n');
  return root;
}

test('fingerprint is stable and changes with relevant source content', (context) => {
  const root = project(context);
  const first = validationFingerprint(root, 'all');
  assert.equal(validationFingerprint(root, 'all'), first);
  fs.appendFileSync(path.join(root, 'app', 'index.tsx'), '// changed\n');
  assert.notEqual(validationFingerprint(root, 'all'), first);
});

test('only an identical recorded successful scope is reusable', (context) => {
  const root = project(context);
  const fingerprint = validationFingerprint(root, 'all');
  fs.writeFileSync(path.join(root, '.mobile-app', 'state.json'), `${JSON.stringify({
    schemaVersion: 2,
    lastValidation: { scope: 'all', screenId: null, status: 'passed', contentFingerprint: fingerprint },
  })}\n`);
  assert.equal(reusableValidation(root, 'all', null, fingerprint), true);
  assert.equal(reusableValidation(root, 'screens', null, fingerprint), false);
  fs.appendFileSync(path.join(root, 'app', 'index.tsx'), '// changed\n');
  assert.equal(reusableValidation(root, 'all', null, validationFingerprint(root, 'all')), false);
});
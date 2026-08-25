'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { safeExistingProjectFile, safeProjectOutput } = require('../lib/project-path');

test('project paths reject traversal and symlinked parents', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-project-path-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-project-path-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.tmp'));
  fs.writeFileSync(path.join(root, '.tmp', 'input.json'), '{}\n');
  const canonicalRoot = fs.realpathSync(root);
  assert.equal(safeExistingProjectFile(root, '.tmp/input.json'), path.join(canonicalRoot, '.tmp', 'input.json'));
  assert.equal(safeProjectOutput(root, '.mobile-app/state.json'), path.join(canonicalRoot, '.mobile-app', 'state.json'));
  assert.throws(() => safeExistingProjectFile(root, '../outside.json'), /inside the project root/);

  const link = path.join(root, 'linked');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows runner does not permit symlink creation');
      return;
    }
    throw error;
  }
  fs.writeFileSync(path.join(outside, 'input.json'), '{}\n');
  assert.throws(() => safeExistingProjectFile(root, 'linked/input.json'), /must not contain a symlink/);
  assert.throws(() => safeProjectOutput(root, 'linked/output.json'), /without symlinks/);
});

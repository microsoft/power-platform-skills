'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  scaffold,
} = require('../scaffold-push-service-account-function');

const ROOT = path.join(__dirname, '.scaffold-push-service-account-function-work');
const OUTSIDE_ROOT = path.join(__dirname, '.scaffold-push-service-account-function-outside');

test.afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
});

test('copies the reusable Function scaffold below the project root', () => {
  fs.mkdirSync(path.join(ROOT, 'azure'), { recursive: true });
  const output = scaffold({
    projectRoot: ROOT,
    destination: 'azure/push-sender',
  });
  assert.equal(fs.existsSync(path.join(output, 'src', 'index.js')), true);
  assert.equal(fs.existsSync(path.join(output, 'tests', 'policy.test.js')), true);
});

test('rejects traversal, absolute paths, and overwrite attempts', () => {
  fs.mkdirSync(ROOT, { recursive: true });
  assert.throws(() => scaffold({ projectRoot: ROOT, destination: '../outside' }));
  assert.throws(() => scaffold({ projectRoot: ROOT, destination: path.resolve(ROOT, 'absolute') }));
  fs.mkdirSync(path.join(ROOT, 'existing'));
  assert.throws(() => scaffold({ projectRoot: ROOT, destination: 'existing' }));
});

test('rejects a symlinked destination parent without creating files outside the project', () => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(OUTSIDE_ROOT, { recursive: true });
  fs.symlinkSync(OUTSIDE_ROOT, path.join(ROOT, 'azure'), 'dir');

  assert.throws(
    () => scaffold({ projectRoot: ROOT, destination: 'azure/push-sender' }),
    /symbolic links/,
  );
  assert.deepEqual(fs.readdirSync(OUTSIDE_ROOT), []);
  assert.equal(fs.existsSync(path.join(OUTSIDE_ROOT, 'push-sender')), false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main } = require('../capture-pcf-fixture.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-capture-test-'));
}

function withDirs(fn) {
  const root = tempDir();
  try {
    const project = path.join(root, 'project');
    const fixtures = path.join(root, 'fixtures');
    fs.mkdirSync(path.join(project, 'Control'), { recursive: true });
    fs.writeFileSync(path.join(project, 'Control', 'ControlManifest.Input.xml'), '<manifest />\n');
    fs.mkdirSync(fixtures, { recursive: true });
    return fn({ root, project, fixtures });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runMain(argv, options) {
  const originalWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { status: main(argv, options), stdout: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('refuses to capture when the fixture destination is the source project', () => withDirs(({ project }) => {
  assert.throws(
    () => main([project, project], { fixturesRoot: path.dirname(project) }),
    /overlap/i,
  );
  assert.equal(fs.existsSync(path.join(project, 'Control', 'ControlManifest.Input.xml')), true);
}));

test('refuses to capture when the destination is an ancestor of the source project', () => withDirs(({ fixtures }) => {
  const destination = path.join(fixtures, 'captured');
  const project = path.join(destination, 'project');
  fs.mkdirSync(path.join(project, 'Control'), { recursive: true });
  fs.writeFileSync(path.join(project, 'Control', 'ControlManifest.Input.xml'), '<manifest />\n');
  assert.throws(
    () => main([project, destination], { fixturesRoot: fixtures }),
    /overlap/i,
  );
  assert.equal(fs.existsSync(path.join(project, 'Control', 'ControlManifest.Input.xml')), true);
}));

test('does not delete a source directory named ..source when the destination is its ancestor', () => {
  const root = tempDir();
  try {
    const fixtures = path.join(root, 'fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    const destination = path.join(fixtures, 'captured');
    const project = path.join(destination, '..source');
    fs.mkdirSync(path.join(project, 'Control'), { recursive: true });
    const marker = path.join(project, 'Control', 'ControlManifest.Input.xml');
    fs.writeFileSync(marker, '<manifest />\n');
    assert.throws(
      () => main([project, destination], { fixturesRoot: fixtures }),
      /overlap/i,
    );
    assert.equal(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copies a project into a non-overlapping fixture directory', () => withDirs(({ project, fixtures }) => {
  const target = path.join(fixtures, 'captured');

  const result = runMain([project, target], { fixturesRoot: fixtures });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"ok":true/);
  assert.equal(fs.existsSync(path.join(target, 'Control', 'ControlManifest.Input.xml')), true);
}));

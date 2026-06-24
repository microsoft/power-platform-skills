'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readCloneRecord, writeCloneRecord, cloneMatches, toCoordinates } = require('../lib/clone-record');

const COORDS = {
  env: 'sri-alm-dev-1', organization: 'GitIntegration22', project: 'srijan-pp-alm',
  repository: 'srijan-pp-alm-2', rootFolder: 'solutions', gitFolder: 'RetailOS',
  branch: 'feature/dev-b', solutionUniqueName: 'RetailOS',
};

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-clone-record-'));
  fs.mkdirSync(path.join(root, 'docs', 'inner-loop'), { recursive: true });
  return root;
}

test('D3 readCloneRecord: null when no manifest / no clone block', () => {
  const root = tmpProject();
  try {
    assert.equal(readCloneRecord({ projectRoot: root }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('D3 writeCloneRecord: writes a clone block with coordinates + ISO stamps', () => {
  const root = tmpProject();
  try {
    const block = writeCloneRecord({ projectRoot: root, clonePath: 'C:/pp-clones/RetailOS', coordinates: COORDS });
    assert.equal(block.path, 'C:/pp-clones/RetailOS');
    assert.equal(block.coordinates.branch, 'feature/dev-b');
    assert.equal(block.coordinates.solutionUniqueName, 'RetailOS');
    assert.match(block.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.match(block.updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.match(block.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    // round-trips
    const read = readCloneRecord({ projectRoot: root });
    assert.equal(read.path, 'C:/pp-clones/RetailOS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('D3 writeCloneRecord: preserves other manifest keys AND createdAt across updates', async () => {
  const root = tmpProject();
  try {
    // seed a manifest with an unrelated key
    const mp = path.join(root, 'docs', 'inner-loop', '.git-integration-manifest.json');
    fs.writeFileSync(mp, JSON.stringify({ binding: { branch: 'feature/dev-b' }, somethingElse: 42 }, null, 2));
    const first = writeCloneRecord({ projectRoot: root, clonePath: 'C:/c1', coordinates: COORDS });
    await new Promise((r) => setTimeout(r, 5));
    const second = writeCloneRecord({ projectRoot: root, clonePath: 'C:/c1', coordinates: COORDS });
    const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
    assert.equal(manifest.somethingElse, 42, 'unrelated key preserved');
    assert.equal(manifest.binding.branch, 'feature/dev-b', 'binding preserved');
    assert.equal(second.createdAt, first.createdAt, 'createdAt preserved');
    assert.notEqual(second.updatedAt, first.updatedAt, 'updatedAt advanced');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('D4 cloneMatches: true for identical coordinates, false on any drift', () => {
  const root = tmpProject();
  try {
    const block = writeCloneRecord({ projectRoot: root, clonePath: 'C:/c', coordinates: COORDS });
    assert.equal(cloneMatches(block, COORDS), true);
    assert.equal(cloneMatches(block, { ...COORDS, branch: 'main' }), false);         // different branch
    assert.equal(cloneMatches(block, { ...COORDS, repository: 'other' }), false);    // different repo
    assert.equal(cloneMatches(block, { ...COORDS, solutionUniqueName: 'Other' }), false); // different solution
    assert.equal(cloneMatches(null, COORDS), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('D4 cloneMatches: accepts envName alias and matches on .coordinates or raw', () => {
  const block = { coordinates: toCoordinates(COORDS) };
  assert.equal(cloneMatches(block, { ...COORDS, env: undefined, envName: 'sri-alm-dev-1' }), true);
  // raw coordinates object (not wrapped) also matches
  assert.equal(cloneMatches(toCoordinates(COORDS), COORDS), true);
});

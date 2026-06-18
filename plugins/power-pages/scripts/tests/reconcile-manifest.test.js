'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileManifest, COMPARED_FIELDS } = require('../lib/reconcile-manifest');

const BOUND = {
  bound: true, gitIntegrationId: 'gi-1', bindingType: 'solution',
  organization: 'Org', project: 'Proj', repository: 'Repo', branch: 'main',
  gitFolder: 'solutions/RetailOS', solutionUniqueName: 'RetailOS',
};

test('COMPARED_FIELDS includes bound + identity coordinates', () => {
  assert.ok(COMPARED_FIELDS.includes('bound'));
  assert.ok(COMPARED_FIELDS.includes('gitIntegrationId'));
  assert.ok(COMPARED_FIELDS.includes('branch'));
});

// Case 1 — aligned (both bound, identical)
test('aligned when local and server agree on a binding', () => {
  const r = reconcileManifest({ manifest: { ...BOUND }, serverBinding: { ...BOUND } });
  assert.equal(r.aligned, true);
  assert.deepEqual(r.divergences, []);
  assert.deepEqual(r.options, []);
  assert.match(r.summary, /matches server/i);
});

// Case 1b — aligned (both unbound)
test('aligned when both sides are unbound', () => {
  const r = reconcileManifest({ manifest: { bound: false }, serverBinding: { bound: false } });
  assert.equal(r.aligned, true);
  assert.deepEqual(r.divergences, []);
  assert.match(r.summary, /not bound/i);
});

// Case 2 — local bound, server unbound (the stale-manifest / deleted-branch case)
test('stale manifest: local bound but server unbound → offers rebind-old-coords + clear-local', () => {
  const r = reconcileManifest({ manifest: { ...BOUND }, serverBinding: { bound: false } });
  assert.equal(r.aligned, false);
  const boundDiv = r.divergences.find((d) => d.field === 'bound');
  assert.deepEqual(boundDiv, { field: 'bound', local: true, server: false });
  assert.deepEqual(r.options, ['overwrite-from-server', 'rebind-old-coords', 'clear-local']);
  assert.match(r.summary, /stale manifest/i);
});

// Case 3 — local unbound, server bound
test('server bound but local unbound → overwrite-from-server only', () => {
  const r = reconcileManifest({ manifest: { bound: false }, serverBinding: { ...BOUND } });
  assert.equal(r.aligned, false);
  assert.deepEqual(r.options, ['overwrite-from-server']);
  assert.match(r.summary, /Server is bound/i);
});

// Case 4 — gitIntegrationId mismatch (both bound)
test('gitIntegrationId mismatch is surfaced as a divergence with clear-local option', () => {
  const r = reconcileManifest({
    manifest: { ...BOUND, gitIntegrationId: 'gi-OLD' },
    serverBinding: { ...BOUND, gitIntegrationId: 'gi-NEW' },
  });
  assert.equal(r.aligned, false);
  const div = r.divergences.find((d) => d.field === 'gitIntegrationId');
  assert.deepEqual(div, { field: 'gitIntegrationId', local: 'gi-OLD', server: 'gi-NEW' });
  assert.ok(r.options.includes('overwrite-from-server'));
  assert.ok(r.options.includes('clear-local'));
  assert.ok(!r.options.includes('rebind-old-coords'), 'both bound → no rebind-old-coords');
});

// Case 5 — branch mismatch (both bound)
test('branch mismatch is surfaced as a divergence', () => {
  const r = reconcileManifest({
    manifest: { ...BOUND, branch: 'main' },
    serverBinding: { ...BOUND, branch: 'feature/x' },
  });
  assert.equal(r.aligned, false);
  const div = r.divergences.find((d) => d.field === 'branch');
  assert.deepEqual(div, { field: 'branch', local: 'main', server: 'feature/x' });
});

// Case 6 — full coordinate mismatch (both bound, different repo)
test('full coordinate mismatch lists every differing field', () => {
  const r = reconcileManifest({
    manifest: { ...BOUND },
    serverBinding: { ...BOUND, organization: 'Org2', project: 'Proj2', repository: 'Repo2' },
  });
  assert.equal(r.aligned, false);
  const fields = r.divergences.map((d) => d.field);
  assert.ok(fields.includes('organization'));
  assert.ok(fields.includes('project'));
  assert.ok(fields.includes('repository'));
  assert.match(r.summary, /disagree on coordinates/i);
});

test('tolerates null/empty manifest input', () => {
  const r = reconcileManifest({ manifest: null, serverBinding: { ...BOUND } });
  assert.equal(r.aligned, false);
  assert.deepEqual(r.options, ['overwrite-from-server']);
});

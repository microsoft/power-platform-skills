'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { REQUIRED_ARTIFACTS, reviewState } = require('../prototype-plan-review');

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-plan-review-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [key, relativePath] of Object.entries(REQUIRED_ARTIFACTS)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, key === 'plan' ? '# App plan\n' : `${JSON.stringify({ schemaVersion: 1, artifact: key })}\n`);
  }
  return root;
}

test('one consolidated prototype review cannot authorize external mutation', (context) => {
  const root = project(context);
  const draft = reviewState(root, 'draft');
  assert.equal(draft.status, 'needs-user-approval');
  assert.deepEqual(draft.sections, ['prototype-review']);
  assert.deepEqual(draft.approvals, { prototypeReview: { status: 'pending' } });
  assert.equal(draft.mayAuthorizeExternalMutations, false);

  const approved = reviewState(root, 'approve', { response: 'approve', now: '2026-08-26T00:00:00.000Z' });
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.approvedSections, ['prototype-review']);
  assert.equal(approved.mayAuthorizeExternalMutations, false);
  assert.equal(reviewState(root, 'status').status, 'approved');
});

test('artifact edits invalidate approval without silently restamping it', (context) => {
  const root = project(context);
  reviewState(root, 'draft');
  reviewState(root, 'approve', { response: 'approve' });
  fs.appendFileSync(path.join(root, REQUIRED_ARTIFACTS.screenContract), '\n');
  const stale = reviewState(root, 'status');
  assert.equal(stale.status, 'needs-user-approval');
  assert.equal(stale.reason, 'plan-revision-changed');
  assert.deepEqual(stale.approvedSections, []);
  assert.throws(() => reviewState(root, 'approve', { response: 'approve' }), /draft the current prototype review/);
});

test('approval requires the explicit approve response', (context) => {
  const root = project(context);
  reviewState(root, 'draft');
  assert.throws(() => reviewState(root, 'approve', { response: 'yes' }), /explicit response approve/);
});

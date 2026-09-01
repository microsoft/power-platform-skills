'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAllowedGcloudArgs,
  loadAllowlist,
} = require('../run-allowlisted-gcloud');

test('allows checked-in gcloud command families with explicit flags', () => {
  const allowlist = loadAllowlist();
  assert.equal(
    isAllowedGcloudArgs(
      ['config', 'list', 'account', '--format=json'],
      allowlist,
    ),
    true,
  );
  assert.equal(
    isAllowedGcloudArgs(
      [
        'iam',
        'workload-identity-pools',
        'describe',
        'power-automate-push',
        '--location=global',
        '--project=contoso-mobile',
        '--format=json',
      ],
      allowlist,
    ),
    true,
  );
});

test('rejects unlisted, shell-shaped, and malformed commands', () => {
  const allowlist = loadAllowlist();
  assert.equal(isAllowedGcloudArgs(['auth', 'print-access-token'], allowlist), false);
  assert.equal(isAllowedGcloudArgs(['projects', 'delete', 'prod'], allowlist), false);
  assert.equal(isAllowedGcloudArgs(['iam', 'service-accounts', 'keys', 'create'], allowlist), false);
  assert.equal(isAllowedGcloudArgs(['projects', 'describe', 'prod\nwhoami'], allowlist), false);
  assert.equal(isAllowedGcloudArgs([], allowlist), false);
});

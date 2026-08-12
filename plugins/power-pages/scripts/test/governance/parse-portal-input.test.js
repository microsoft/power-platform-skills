const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parsePortalInput,
} = require('../../../skills/manage-governance/scripts/parse-portal-input');

test('parsePortalInput resolves a portal name from an in-memory list', () => {
  const result = parsePortalInput('Portal_1', {
    validIds: [{ portalId: 'portal-id-1', name: 'Portal_1' }],
  });
  assert.deepEqual(result, {
    policyValue: 'Include',
    portalIds: ['portal-id-1'],
    errors: [],
    resolvedNames: ['Portal_1'],
  });
});

test('parse portal CLI accepts list-portals JSON on stdin', () => {
  const script = path.resolve(
    __dirname,
    '../../../skills/manage-governance/scripts/parse-portal-input.js'
  );
  const result = spawnSync(
    process.execPath,
    [script, '--portalsStdin', '--input', 'Portal_1'],
    {
      input: JSON.stringify({
        portals: [{ portalId: 'portal-id-1', name: 'Portal_1' }],
      }),
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).portalIds, ['portal-id-1']);
});

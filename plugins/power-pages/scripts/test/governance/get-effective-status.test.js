const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('get-effective-status documents stdin as the default portal input', () => {
  const script = path.resolve(
    __dirname,
    '../../../skills/manage-governance/scripts/get-effective-status.js'
  );
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node list-portals\.js/);
  assert.match(result.stdout, /stdin\s+list-portals\.js output/);
  assert.match(result.stdout, /--portalsFile\s+Backward-compatible alternative/);
});

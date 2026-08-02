const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('list-envs exposes no cache or TTL flags', () => {
  const script = path.resolve(
    __dirname,
    '../../../skills/manage-governance/scripts/list-envs.js'
  );
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /cacheFile|maxAgeHours|refresh|TTL/i);
  assert.match(result.stdout, /node list-envs\.js/);
});

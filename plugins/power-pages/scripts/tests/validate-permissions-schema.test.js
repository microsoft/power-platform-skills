const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempProject, writeProjectFile } = require('./test-utils');

test('validate-permissions-schema CLI exits with code 2 on --fail-on-error', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, '.powerpages-site/table-permissions/foo.yml', 'id: x\n');

  const cliPath = path.join(__dirname, '..', 'validate-permissions-schema.js');
  const result = spawnSync(process.execPath, [cliPath, '--projectRoot', projectRoot, '--fail-on-error'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.summary.error >= 1);
});

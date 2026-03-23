const test = require('node:test');
const assert = require('node:assert/strict');

const { validatePowerPagesSchema } = require('../lib/powerpages-schema-validator');
const { createTempProject, writeProjectFile } = require('./test-utils');

test('validatePowerPagesSchema combines findings across validators', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, '.powerpages-site/table-permissions/foo.yml', 'id: x\n');
  writeProjectFile(projectRoot, '.powerpages-site/site-settings/bar.yml', 'id: x\n');
  writeProjectFile(projectRoot, '.powerpages-site/web-roles/baz.yml', 'id: x\n');

  const result = validatePowerPagesSchema(projectRoot);
  assert.ok(result.summary.error >= 3);
  assert.ok(result.tablePermissions.summary.error >= 1);
  assert.ok(result.siteSettings.summary.error >= 1);
  assert.ok(result.webRoles.summary.error >= 1);
});

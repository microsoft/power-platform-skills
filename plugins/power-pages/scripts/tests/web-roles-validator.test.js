const test = require('node:test');
const assert = require('node:assert/strict');

const { validateWebRoles } = require('../lib/web-roles-validator');
const { createTempProject, writeProjectFile, findingMessages } = require('./test-utils');

test('validateWebRoles flags invalid booleans', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/web-roles/Bad.webrole.yml',
    [
      'anonymoususersrole: maybe',
      'authenticatedusersrole: false',
      'id: fbd6927d-9902-49e2-96b3-79989482c839',
      'name: Bad Role',
      '',
    ].join('\n')
  );

  const result = validateWebRoles(projectRoot);
  assert.ok(findingMessages(result.findings).some(message => message.includes('anonymoususersrole') && message.includes('must be a boolean')));
});

test('validateWebRoles flags naming convention violations', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, '.powerpages-site/web-roles/baz.yml', 'id: x\n');

  const result = validateWebRoles(projectRoot);
  assert.ok(findingMessages(result.findings).some(message => message.includes('does not follow naming convention "*.webrole.yml"')));
});

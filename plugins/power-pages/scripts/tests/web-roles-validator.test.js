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

test('validateWebRoles rejects unexpected per-record source keys before normalization', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/web-roles/Members.webrole.yml',
    [
      'anonymoususersrole: false',
      'authenticatedusersrole: true',
      'id: fbd6927d-9902-49e2-96b3-79989482c839',
      'name: Members',
      'statecode: 1',
      '',
    ].join('\n'),
  );

  const result = validateWebRoles(projectRoot);
  assert.ok(
    findingMessages(result.findings)
      .some(message => message.includes('unexpected schema keys: statecode')),
  );
});

test('validateWebRoles rejects unexpected aggregate source keys before normalization', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/webrole.yml',
    [
      '- adx_anonymoususersrole: false',
      '  adx_authenticatedusersrole: true',
      '  adx_name: Members',
      '  adx_statecode: 1',
      '  adx_webroleid: fbd6927d-9902-49e2-96b3-79989482c839',
      '',
    ].join('\n'),
  );

  const result = validateWebRoles(projectRoot);
  assert.ok(
    findingMessages(result.findings)
      .some(message => message.includes('unexpected schema keys: adx_statecode')),
  );
});

test('validateWebRoles reports misspelled source keys and the resulting invalid field', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/web-roles/Members.webrole.yml',
    [
      'anonymoususersrole: false',
      'authenticateduserrole: true',
      'id: fbd6927d-9902-49e2-96b3-79989482c839',
      'name: Members',
      '',
    ].join('\n'),
  );

  const messages = findingMessages(validateWebRoles(projectRoot).findings);
  assert.ok(messages.some(message => message.includes('unexpected schema keys: authenticateduserrole')));
  assert.ok(
    messages.some(
      message => message.includes('authenticatedusersrole') && message.includes('must be a boolean'),
    ),
  );
});

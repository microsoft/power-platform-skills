const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSimpleYaml } = require('../lib/powerpages-config');

test('parseSimpleYaml handles arrays and block-scalar descriptions', () => {
  const parsed = parseSimpleYaml(
    [
      'description: >-',
      '  First line',
      '',
      '  Second line',
      'id: e7c06211-0cb1-4096-b3f8-9b7f91f3a133',
      'adx_entitypermission_webrole:',
      '- 997e7996-e241-4117-9c09-28e90a1fcdbc',
    ].join('\n'),
    'sample.yml'
  );

  assert.equal(parsed.description, 'First line\n\nSecond line');
  assert.deepEqual(parsed.adx_entitypermission_webrole, ['997e7996-e241-4117-9c09-28e90a1fcdbc']);
});

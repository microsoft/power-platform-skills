const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSiteSettings } = require('../lib/site-settings-validator');
const { createTempProject, writeProjectFile, findingMessages } = require('./test-utils');

test('validateSiteSettings accepts optional description and value', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site\\site-settings\\search-filters.sitesetting.yml',
    [
      'description: >-',
      '  A collection of search logical name filter options.',
      'id: e7c06211-0cb1-4096-b3f8-9b7f91f3a133',
      'name: search/filters',
      '',
    ].join('\n')
  );

  const result = validateSiteSettings(projectRoot);
  assert.equal(result.summary.error, 0);
});

test('validateSiteSettings flags naming convention violations', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, '.powerpages-site\\site-settings\\bar.yml', 'id: x\n');

  const result = validateSiteSettings(projectRoot);
  assert.ok(findingMessages(result.findings).some(message => message.includes('does not follow naming convention "*.sitesetting.yml"')));
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSiteSettings } = require('../lib/site-settings-validator');
const { createTempProject, writeProjectFile, findingMessages } = require('./test-utils');

test('validateSiteSettings accepts optional description and value', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/search-filters.sitesetting.yml',
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
  writeProjectFile(projectRoot, '.powerpages-site/site-settings/bar.yml', 'id: x\n');

  const result = validateSiteSettings(projectRoot);
  assert.ok(findingMessages(result.findings).some(message => message.includes('does not follow naming convention "*.sitesetting.yml"')));
});

test('validateSiteSettings accepts environment-variable-backed settings', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/test-env.sitesetting.yml',
    [
      'envvar_schema: ABC',
      'id: e9981fe5-6724-4111-8341-6045bd001091',
      'name: TestEnvABC',
      'source: 1',
      '',
    ].join('\n')
  );

  const result = validateSiteSettings(projectRoot);
  assert.equal(result.summary.error, 0);
});

test('validateSiteSettings accepts source 0 without envvar_schema', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/CodeSite-Enabled.sitesetting.yml',
    [
      'id: e7c06211-0cb1-4096-b3f8-9b7f91f3a133',
      'name: CodeSite/Enabled',
      'source: 0',
      'value: true',
      '',
    ].join('\n')
  );

  const result = validateSiteSettings(projectRoot);
  assert.equal(result.summary.error, 0);
});

test('validateSiteSettings rejects environment-variable-backed settings with value', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/test-env-invalid.sitesetting.yml',
    [
      'envvar_schema: ABC',
      'id: e9981fe5-6724-4111-8341-6045bd001091',
      'name: TestEnvABC',
      'source: 1',
      'value: should-not-be-present',
      '',
    ].join('\n')
  );

  const result = validateSiteSettings(projectRoot);
  assert.ok(findingMessages(result.findings).some(message => message.includes('must not define "value"')));
});

test('validateSiteSettings rejects wildcard Web API fields', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Webapi-product-fields.sitesetting.yml',
    [
      'id: e9981fe5-6724-4111-8341-6045bd001091',
      'name: Webapi/product/fields',
      'value: "productid,*"',
      '',
    ].join('\n')
  );

  const result = validateSiteSettings(projectRoot);
  assert.ok(findingMessages(result.findings).some(message =>
    message.includes('LogicalName and SchemaName, plus _<LogicalName>_value for lookups')
  ));
});

test('validateSiteSettings rejects wildcard Web API fields when the setting name has whitespace', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Webapi-product-fields-whitespace.sitesetting.yml',
    [
      'id: e9981fe5-6724-4111-8341-6045bd001091',
      'name: " Webapi/product/fields "',
      'value: "*"',
      '',
    ].join('\n')
  );

  const result = validateSiteSettings(projectRoot);
  assert.ok(findingMessages(result.findings).some(message =>
    message.includes('uses unsupported wildcard field access')
  ));
});

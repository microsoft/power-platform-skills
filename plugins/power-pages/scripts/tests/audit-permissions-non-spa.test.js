const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  createTempProject,
  createTempNonSpaSite,
  writeProjectFile,
} = require('./test-utils');

const pluginRoot = path.resolve(__dirname, '..', '..');
const repositoryRoot = path.resolve(pluginRoot, '..', '..');
const collectorPath = path.join(
  pluginRoot,
  'skills',
  'audit-permissions',
  'scripts',
  'collect-non-spa-permission-evidence.js'
);

function runNode(scriptPath, args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
  });
}

function normalizedBody(content, marker) {
  const markerIndex = content.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing ${marker}`);
  return content.slice(markerIndex).replace(/\r\n/g, '\n');
}

test('audit-permissions routes SPA first and preserves the committed SPA workflow body', () => {
  const skillPath = path.join(pluginRoot, 'skills', 'audit-permissions', 'SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  const committed = spawnSync(
    'git',
    ['show', 'HEAD:plugins/power-pages/skills/audit-permissions/SKILL.md'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );

  assert.equal(committed.status, 0, committed.stderr);
  assert.ok(
    skill.indexOf('perform the existing SPA project lookup first')
      < skill.indexOf('node "${PLUGIN_ROOT}/scripts/lib/detect-project-context.js"')
  );
  assert.match(
    skill,
    /Only when that existing SPA lookup finds no `powerpages\.config\.json`, run:/
  );
  assert.match(skill, /siteType: "non-spa"/);
  assert.equal(
    normalizedBody(skill, '## Workflow'),
    normalizedBody(committed.stdout, '## Workflow')
  );
});

test('non-SPA audit keeps the report, checklist, gate, and read-only contracts', () => {
  const reference = fs.readFileSync(
    path.join(
      pluginRoot,
      'skills',
      'audit-permissions',
      'references',
      'non-spa-site-workflow.md'
    ),
    'utf8'
  );
  const architect = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'table-permissions-architect.md'),
    'utf8'
  );

  assert.match(reference, /same seven phases/);
  assert.match(reference, /A-K table-permission checklist/);
  assert.match(reference, /audit-permissions:6\.fix-offer/);
  assert.match(reference, /Native permission enforcement disabled/);
  assert.match(reference, /Page and table role mismatch/);
  assert.match(reference, /data model and local serialization are separate facts/);
  assert.match(reference, /pac pages list -v/);
  assert.match(reference, /If `metadataStorage` is `mixed`/);
  assert.match(reference, /`aggregate`, `per-record`, or `hybrid`/);
  assert.match(reference, /different components use different valid conventions/);
  assert.match(reference, /authoritative for supported aggregate and per-record table permissions/);
  assert.match(reference, /No local or Dataverse mutation/);
  assert.match(reference, /Do\s+not run the hook directly/);
  assert.match(architect, /Standard versus Enhanced comes only from authoritative/);
  assert.match(architect, /Aggregate role storage and `adx_`-prefixed table\s+permissions are supported/);
  assert.match(architect, /Mixed storage remains plan-only until\s+reconciled/);
  assert.match(architect, /For an SPA site, preserve the existing behavior/);
  assert.match(
    architect,
    /Check that the site has been deployed at least once by looking for the `\.powerpages-site` folder/
  );
  assert.match(architect, /create-table-permission\.js.*--scope "Global"/);
});

test('collector normalizes enhanced metadata from a nested non-SPA root', (t) => {
  const projectRoot = createTempProject(t);
  const siteRoot = path.join(projectRoot, '.powerpages-site');
  fs.mkdirSync(path.join(siteRoot, '.portalconfig'), { recursive: true });
  writeProjectFile(
    projectRoot,
    '.powerpages-site/website.yml',
    'id: 11111111-1111-4111-8111-111111111111\nname: Nested Non-SPA\n'
  );
  writeProjectFile(
    projectRoot,
    '.powerpages-site/web-roles/members.webrole.yml',
    [
      'anonymoususersrole: false',
      'authenticatedusersrole: true',
      'id: 22222222-2222-4222-8222-222222222222',
      'name: Members',
      '',
    ].join('\n')
  );
  writeProjectFile(
    projectRoot,
    '.powerpages-site/table-permissions/orders.tablepermission.yml',
    [
      'adx_entitypermission_webrole:',
      '- 22222222-2222-4222-8222-222222222222',
      'append: false',
      'appendto: true',
      'create: true',
      'delete: false',
      'entitylogicalname: cr123_order',
      'entityname: Orders',
      'id: 33333333-3333-4333-8333-333333333333',
      'read: true',
      'scope: 756150001',
      'write: true',
      '',
    ].join('\n')
  );
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/orders.sitesetting.yml',
    [
      'id: 44444444-4444-4444-8444-444444444444',
      'name: Webapi/cr123_order/enabled',
      'value: true',
      '',
    ].join('\n')
  );
  writeProjectFile(
    projectRoot,
    '.powerpages-site/webpage-rules/orders.webpagerule.yml',
    [
      'adx_webpageaccesscontrolrule_webrole:',
      '- 22222222-2222-4222-8222-222222222222',
      'id: 55555555-5555-4555-8555-555555555555',
      'name: Restrict orders',
      'right: 2',
      'webpageid: 66666666-6666-4666-8666-666666666666',
      '',
    ].join('\n')
  );
  writeProjectFile(
    projectRoot,
    '.powerpages-site/basic-forms/order-form/Order.basicform.yml',
    [
      'adx_entityformid: 77777777-7777-4777-8777-777777777777',
      'adx_entityname: cr123_order',
      'adx_entitypermissionsenabled: true',
      'adx_name: Order Form',
      '',
    ].join('\n')
  );
  writeProjectFile(
    projectRoot,
    '.powerpages-site/advanced-forms/order-flow/Order-Flow.advancedform.yml',
    [
      'adx_name: Order Flow',
      'adx_webformid: 88888888-8888-4888-8888-888888888888',
      '',
    ].join('\n')
  );
  writeProjectFile(
    projectRoot,
    '.powerpages-site/advanced-forms/order-flow/advanced-form-steps/details/Details.advancedformstep.yml',
    [
      'adx_entitypermissionsenabled: true',
      'adx_name: Details',
      'adx_targetentitylogicalname: cr123_order',
      'adx_webform: 88888888-8888-4888-8888-888888888888',
      'adx_webformstepid: 99999999-9999-4999-8999-999999999999',
      '',
    ].join('\n')
  );
  writeProjectFile(
    projectRoot,
    '.powerpages-site/lists/orders.list.yml',
    [
      'adx_entitylistid: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'adx_entityname: cr123_order',
      'adx_entitypermissionsenabled: true',
      'adx_name: Orders',
      'adx_settings: >-',
      '  {"Type":"CrmEntityFormView-CreateAction"}',
      '',
    ].join('\n')
  );
  writeProjectFile(
    projectRoot,
    '.powerpages-site/web-pages/orders/orders.webpage.copy.html',
    [
      "{% entityform name: 'Order Form' %}",
      "{% webform name: 'Order Flow' %}",
      "{% include 'entity_list' key: 'Orders' %}",
      "{% fetchxml orders %}<fetch><entity name='cr123_order'><link-entity name='contact' /></entity></fetch>{% endfetchxml %}",
      '<script>fetch("/_api/cr123_orders", { method: "POST" });</script>',
      '',
    ].join('\n')
  );

  const result = runNode(collectorPath, ['--projectRoot', projectRoot]);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);

  assert.equal(evidence.siteRoot, siteRoot);
  assert.equal(evidence.dataModelFormat, 'unknown');
  assert.equal(evidence.metadataStorage, 'per-record');
  assert.deepEqual(evidence.metadataStorageByComponent, {
    roles: 'per-record',
    settings: 'per-record',
    pageRules: 'per-record',
  });
  assert.equal(evidence.roles[0].name, 'Members');
  assert.equal(evidence.tablePermissions[0].table, 'cr123_order');
  assert.equal(evidence.tablePermissions[0].sourceFormat, 'normalized-per-record');
  assert.equal(evidence.basicForms[0].referencedBy.length, 1);
  assert.equal(evidence.advancedForms[0].referencedBy.length, 1);
  assert.equal(evidence.lists[0].actions.create, true);
  assert.equal(evidence.lists[0].referencedBy.length, 1);
  assert.deepEqual(evidence.contentEvidence[0].fetchXmlTables, ['cr123_order']);
  assert.deepEqual(evidence.contentEvidence[0].linkedTables, ['contact']);
  assert.deepEqual(evidence.contentEvidence[0].webApiEntitySets, ['cr123_orders']);
  assert.deepEqual(evidence.contentEvidence[0].httpMethods, ['POST']);
});

test('collector normalizes standard aggregate and adx-prefixed metadata', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'webrole.yml',
    [
      '- adx_anonymoususersrole: true',
      '  adx_authenticatedusersrole: false',
      '  adx_name: Anonymous Users',
      '  adx_webroleid: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '- adx_anonymoususersrole: false',
      '  adx_authenticatedusersrole: true',
      '  adx_name: Authenticated Users',
      '  adx_webroleid: cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '',
    ].join('\n')
  );
  writeProjectFile(
    siteRoot,
    'table-permissions/cases.tablepermission.yml',
    [
      'adx_append: false',
      'adx_appendto: false',
      'adx_create: false',
      'adx_delete: false',
      'adx_entitylogicalname: incident',
      'adx_entityname: Cases',
      'adx_entitypermission_webrole:',
      '- cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'adx_entitypermissionid: dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'adx_read: true',
      'adx_scope: 756150001',
      'adx_write: false',
      '',
    ].join('\n')
  );
  writeProjectFile(
    siteRoot,
    'sitesetting.yml',
    [
      '- adx_name: Webapi/incident/enabled',
      '  adx_sitesettingid: eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '  adx_value: true',
      '',
    ].join('\n')
  );
  writeProjectFile(
    siteRoot,
    'webpagerule.yml',
    [
      '- adx_name: Restrict cases',
      '  adx_right: 2',
      '  adx_webpageaccesscontrolrule_webrole:',
      '  - cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '  adx_webpageaccesscontrolruleid: ffffffff-ffff-4fff-8fff-ffffffffffff',
      '  adx_webpageid: 12121212-1212-4212-8212-121212121212',
      '  adx_statecode: 0',
      '  adx_statuscode: 1',
      '',
    ].join('\n')
  );
  writeProjectFile(
    siteRoot,
    'basic-forms/case/Case.basicform.yml',
    [
      'adx_entityformid: 13131313-1313-4313-8313-131313131313',
      'adx_entityname: incident',
      'adx_entitypermissionsenabled: false',
      'adx_name: Case Form',
      '',
    ].join('\n')
  );
  writeProjectFile(
    siteRoot,
    'web-pages/cases/cases.webpage.copy.html',
    "{% entityform name: 'Case Form' %}\n"
  );

  const result = runNode(collectorPath, ['--projectRoot', siteRoot]);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);

  assert.equal(evidence.dataModelFormat, 'unknown');
  assert.equal(evidence.metadataStorage, 'aggregate');
  assert.deepEqual(evidence.metadataStorageByComponent, {
    roles: 'aggregate',
    settings: 'aggregate',
    pageRules: 'aggregate',
  });
  assert.equal(evidence.roles.length, 2);
  assert.equal(evidence.roles[1].authenticated, true);
  assert.equal(evidence.tablePermissions[0].sourceFormat, 'adx-per-record');
  assert.equal(evidence.tablePermissions[0].table, 'incident');
  assert.equal(evidence.tablePermissions[0].read, true);
  assert.deepEqual(
    evidence.tablePermissions[0].roleIds,
    ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']
  );
  assert.equal(evidence.pageRules[0].right, 2);
  assert.equal(evidence.pageRules[0].stateCode, 0);
  assert.equal(evidence.pageRules[0].statusCode, 1);
  assert.deepEqual(
    evidence.pageRules[0].roleIds,
    ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']
  );
  assert.equal(evidence.webApiSettings[0].name, 'Webapi/incident/enabled');
  assert.equal(evidence.basicForms[0].entityPermissionsEnabled, false);
  assert.equal(evidence.basicForms[0].referencedBy.length, 1);
});

test('collector treats component-specific aggregate and per-record storage as supported hybrid', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'webrole.yml',
    [
      '- adx_anonymoususersrole: false',
      '  adx_authenticatedusersrole: true',
      '  adx_name: Members',
      '  adx_webroleid: 14141414-1414-4414-8414-141414141414',
      '',
    ].join('\n')
  );
  writeProjectFile(
    siteRoot,
    'site-settings/api.sitesetting.yml',
    [
      'id: 15151515-1515-4515-8515-151515151515',
      'name: Webapi/incident/enabled',
      'value: true',
      '',
    ].join('\n')
  );

  const result = runNode(collectorPath, ['--projectRoot', siteRoot]);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);

  assert.equal(evidence.metadataStorage, 'hybrid');
  assert.deepEqual(evidence.metadataStorageByComponent, {
    roles: 'aggregate',
    settings: 'per-record',
    pageRules: 'unknown',
  });
});

test('audit hook validates a report under a direct non-SPA root', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'docs/permissions-audit.html',
    '<!doctype html><title>Permissions audit</title>\n'
  );

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'audit-permissions',
      'scripts',
      'validate-audit.js'
    ),
    [],
    { input: JSON.stringify({ cwd: siteRoot }) }
  );

  assert.equal(result.status, 0, result.stderr);
});

test('audit hook blocks unresolved placeholders under a direct non-SPA root', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'docs/permissions-audit.html',
    '<script>const FINDINGS = __FINDINGS_DATA__;</script>\n'
  );

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'audit-permissions',
      'scripts',
      'validate-audit.js'
    ),
    [],
    { input: JSON.stringify({ cwd: siteRoot }) }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unreplaced placeholders/);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateTablePermissions } = require('../lib/table-permissions-validator');
const { createTempProject, writeProjectFile, findingMessages } = require('./test-utils');

test('validateTablePermissions accepts a valid contact-scope permission', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/table-permissions/Invoice-Supplier-Access.tablepermission.yml',
    [
      'adx_entitypermission_webrole:',
      '- 997e7996-e241-4117-9c09-28e90a1fcdbc',
      'append: true',
      'appendto: true',
      'contactrelationship: crd50_contact_invoice_submitter',
      'create: true',
      'delete: true',
      'entitylogicalname: crd50_invoice',
      'entityname: Invoice - Supplier Access',
      'id: cb0c220a-7e81-4056-9dde-666922e9f1a4',
      'read: true',
      'scope: 756150001',
      'write: true',
      '',
    ].join('\n')
  );

  const result = validateTablePermissions(projectRoot);
  assert.equal(result.summary.error, 0);
});

test('validateTablePermissions flags wrong relationship key and missing contactrelationship', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/table-permissions/Invoice-Supplier-Access.tablepermission.yml',
    [
      'adx_entitypermission_webrole:',
      '- 997e7996-e241-4117-9c09-28e90a1fcdbc',
      'append: true',
      'appendto: true',
      'contactaccessrelationshipname: crd50_contact_invoice_submitter',
      'create: true',
      'delete: true',
      'entitylogicalname: crd50_invoice',
      'entityname: Invoice - Supplier Access',
      'id: cb0c220a-7e81-4056-9dde-666922e9f1a4',
      'read: true',
      'scope: 756150001',
      'write: true',
      '',
    ].join('\n')
  );

  const result = validateTablePermissions(projectRoot);
  assert.ok(findingMessages(result.findings).some(message => message.includes('unexpected schema keys: contactaccessrelationshipname')));
  assert.ok(findingMessages(result.findings).some(message => message.includes('missing "contactrelationship"')));
});

test('validateTablePermissions flags table permission naming convention violations', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, '.powerpages-site/table-permissions/foo.yml', 'id: x\n');

  const result = validateTablePermissions(projectRoot);
  assert.ok(findingMessages(result.findings).some(message => message.includes('does not follow naming convention "*.tablepermission.yml"')));
});

test('validateTablePermissions flags missing scope', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/table-permissions/Invoice-Supplier-Access.tablepermission.yml',
    [
      'adx_entitypermission_webrole:',
      '- 997e7996-e241-4117-9c09-28e90a1fcdbc',
      'append: true',
      'appendto: true',
      'create: true',
      'delete: true',
      'entitylogicalname: crd50_invoice',
      'entityname: Invoice - Supplier Access',
      'id: cb0c220a-7e81-4056-9dde-666922e9f1a4',
      'read: true',
      'write: true',
      '',
    ].join('\n')
  );

  const result = validateTablePermissions(projectRoot);
  assert.ok(findingMessages(result.findings).some(message => message.includes('missing required schema keys: scope')));
  assert.ok(findingMessages(result.findings).some(message => message.includes('empty values for entityname, entitylogicalname, or scope')));
  assert.ok(findingMessages(result.findings).some(message => message.includes('invalid "scope" value')));
});

test('validateTablePermissions can validate relationship names against a provided Dataverse resolver', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/table-permissions/Invoice-Supplier-Access.tablepermission.yml',
    [
      'adx_entitypermission_webrole:',
      '- 997e7996-e241-4117-9c09-28e90a1fcdbc',
      'append: true',
      'appendto: true',
      'contactrelationship: crd50_contact_invoice_submitter',
      'create: true',
      'delete: true',
      'entitylogicalname: crd50_invoice',
      'entityname: Invoice - Supplier Access',
      'id: cb0c220a-7e81-4056-9dde-666922e9f1a4',
      'read: true',
      'scope: 756150001',
      'write: true',
      '',
    ].join('\n')
  );

  const result = validateTablePermissions(projectRoot, {
    resolveRelationships: () => [
      { schemaName: 'different_relationship', referencedEntity: 'contact' },
    ],
  });

  assert.ok(findingMessages(result.findings).some(message => message.includes('was not found in Dataverse')));
});

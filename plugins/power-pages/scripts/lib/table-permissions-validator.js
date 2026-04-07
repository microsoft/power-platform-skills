const path = require('path');
const { TABLE_PERMISSION_FILE_SUFFIX, loadYamlRecordsWithErrors, listYamlFiles } = require('./powerpages-config');
const { addFinding, findUnexpectedKeys, findMissingKeys, summarize } = require('./powerpages-validation-utils');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOLEAN_FIELDS = ['append', 'appendto', 'create', 'delete', 'read', 'write'];

const SCOPE = {
  GLOBAL: 756150000,
  CONTACT: 756150001,
  ACCOUNT: 756150002,
  PARENT: 756150003,
  SELF: 756150004,
};

const VALID_SCOPES = new Set(Object.values(SCOPE));

const TABLE_PERMISSION_ALLOWED_KEYS = new Set([
  'adx_entitypermission_webrole',
  'accountrelationship',
  'append',
  'appendto',
  'contactrelationship',
  'create',
  'delete',
  'entitylogicalname',
  'entityname',
  'id',
  'parententitypermission',
  'parentrelationship',
  'read',
  'scope',
  'write',
]);

const TABLE_PERMISSION_REQUIRED_KEYS = new Set([
  'adx_entitypermission_webrole',
  'append',
  'appendto',
  'create',
  'delete',
  'entitylogicalname',
  'entityname',
  'id',
  'read',
  'scope',
  'write',
]);

function validateTablePermissions(projectRoot, options = {}) {
  return validateTablePermissionsWithOptions(projectRoot, options);
}

function validateTablePermissionsWithOptions(projectRoot, options = {}) {
  const findings = [];
  const tablePermissionsDir = path.join(projectRoot, '.powerpages-site', 'table-permissions');

  for (const filePath of listYamlFiles(tablePermissionsDir)) {
    const fileName = path.basename(filePath);
    if (!fileName.endsWith(TABLE_PERMISSION_FILE_SUFFIX)) {
      addFinding(findings, 'error', `Table permission file does not follow naming convention "*${TABLE_PERMISSION_FILE_SUFFIX}".`, {
        filePath,
        fileName,
      });
    }
  }

  const { records: permissions, errors } = loadYamlRecordsWithErrors(tablePermissionsDir, TABLE_PERMISSION_FILE_SUFFIX);
  for (const error of errors) {
    addFinding(findings, 'error', `Failed to parse table permission YAML: ${error.message}`, {
      filePath: error.filePath,
      fileName: path.basename(error.filePath),
    });
  }

  const permissionsById = new Map();

  for (const permission of permissions) {
    if (permission.id) {
      permissionsById.set(String(permission.id), permission);
    }

    const fileName = path.basename(permission.filePath);
    const entityName = typeof permission.entitylogicalname === 'string' ? permission.entitylogicalname.toLowerCase() : '';
    const scope = permission.scope;

    const unexpectedKeys = findUnexpectedKeys(permission, TABLE_PERMISSION_ALLOWED_KEYS);
    if (unexpectedKeys.length > 0) {
      addFinding(findings, 'error', `Table permission contains unexpected schema keys: ${unexpectedKeys.join(', ')}.`, {
        filePath: permission.filePath,
        fileName,
      });
    }

    const missingKeys = findMissingKeys(permission, TABLE_PERMISSION_REQUIRED_KEYS);
    if (missingKeys.length > 0) {
      addFinding(findings, 'error', `Table permission is missing required schema keys: ${missingKeys.join(', ')}.`, {
        filePath: permission.filePath,
        fileName,
      });
    }

    if (!permission.entityname || !entityName || scope === undefined || scope === null) {
      addFinding(findings, 'error', 'Table permission has empty values for entityname, entitylogicalname, or scope.', {
        filePath: permission.filePath,
        fileName,
      });
    }

    if (!UUID_REGEX.test(String(permission.id || ''))) {
      addFinding(findings, 'error', 'Table permission has an invalid "id" UUID.', {
        filePath: permission.filePath,
        fileName,
      });
    }

    if (!VALID_SCOPES.has(scope)) {
      addFinding(findings, 'error', `Table permission has an invalid "scope" value: ${scope}.`, {
        filePath: permission.filePath,
        fileName,
      });
    }

    for (const fieldName of BOOLEAN_FIELDS) {
      if (typeof permission[fieldName] !== 'boolean') {
        addFinding(findings, 'error', `Table permission field "${fieldName}" must be a boolean.`, {
          filePath: permission.filePath,
          fileName,
        });
      }
    }

    if (!Array.isArray(permission.adx_entitypermission_webrole) || permission.adx_entitypermission_webrole.length === 0) {
      addFinding(findings, 'warning', 'Table permission has no associated web roles.', {
        filePath: permission.filePath,
        fileName,
        permissionName: permission.entityname || null,
      });
    } else {
      const invalidRoleIds = permission.adx_entitypermission_webrole.filter(roleId => !UUID_REGEX.test(String(roleId)));
      if (invalidRoleIds.length > 0) {
        addFinding(findings, 'error', `Table permission has invalid web role UUIDs: ${invalidRoleIds.join(', ')}.`, {
          filePath: permission.filePath,
          fileName,
          permissionName: permission.entityname || null,
        });
      }
    }

    if (permission.parententitypermission && !UUID_REGEX.test(String(permission.parententitypermission))) {
      addFinding(findings, 'error', 'Table permission has an invalid "parententitypermission" UUID.', {
        filePath: permission.filePath,
        fileName,
        permissionName: permission.entityname || null,
      });
    }

    if (scope === SCOPE.CONTACT) {
      if (!permission.contactrelationship) {
        addFinding(findings, 'error', 'Contact-scope table permission is missing "contactrelationship".', {
          filePath: permission.filePath,
          fileName,
          permissionName: permission.entityname || null,
        });
      }
      if (entityName === 'contact') {
        addFinding(findings, 'error', 'The contact table should use Self scope instead of Contact scope.', {
          filePath: permission.filePath,
          fileName,
          permissionName: permission.entityname || null,
        });
      }
    } else if (permission.contactrelationship) {
      addFinding(findings, 'warning', 'Table permission includes "contactrelationship" but is not using Contact scope.', {
        filePath: permission.filePath,
        fileName,
      });
    }

    if (scope === SCOPE.ACCOUNT) {
      if (!permission.accountrelationship) {
        addFinding(findings, 'error', 'Account-scope table permission is missing "accountrelationship".', {
          filePath: permission.filePath,
          fileName,
          permissionName: permission.entityname || null,
        });
      }
    } else if (permission.accountrelationship) {
      addFinding(findings, 'warning', 'Table permission includes "accountrelationship" but is not using Account scope.', {
        filePath: permission.filePath,
        fileName,
      });
    }

    if (scope === SCOPE.PARENT) {
      if (!permission.parententitypermission) {
        addFinding(findings, 'error', 'Parent-scope table permission is missing "parententitypermission".', {
          filePath: permission.filePath,
          fileName,
          permissionName: permission.entityname || null,
        });
      }
      if (!permission.parentrelationship) {
        addFinding(findings, 'error', 'Parent-scope table permission is missing "parentrelationship".', {
          filePath: permission.filePath,
          fileName,
          permissionName: permission.entityname || null,
        });
      }
    } else if (permission.parententitypermission || permission.parentrelationship) {
      addFinding(findings, 'warning', 'Table permission includes parent-scope fields but is not using Parent scope.', {
        filePath: permission.filePath,
        fileName,
      });
    }
  }

  for (const permission of permissions) {
    if (permission.scope !== SCOPE.PARENT || !permission.parententitypermission) {
      continue;
    }

    const parentPermission = permissionsById.get(String(permission.parententitypermission));
    if (!parentPermission) {
      addFinding(findings, 'error', `Parent permission "${permission.parententitypermission}" was not found for this child permission.`, {
        filePath: permission.filePath,
        fileName: path.basename(permission.filePath),
        permissionName: permission.entityname || null,
      });
      continue;
    }

    const childRoles = new Set((permission.adx_entitypermission_webrole || []).map(String));
    const parentRoles = new Set((parentPermission.adx_entitypermission_webrole || []).map(String));
    const invalidRoles = [...childRoles].filter(roleId => !parentRoles.has(roleId));
    if (invalidRoles.length > 0) {
      addFinding(findings, 'error', 'Child permission roles are not a subset of the parent permission roles.', {
        filePath: permission.filePath,
        fileName: path.basename(permission.filePath),
        permissionName: permission.entityname || null,
        invalidRoleIds: invalidRoles,
      });
    }
  }

  if (typeof options.resolveRelationships === 'function') {
    const relationshipCache = new Map();

    function getRelationships(entityLogicalName) {
      const key = String(entityLogicalName || '').toLowerCase();
      if (!relationshipCache.has(key)) {
        relationshipCache.set(key, options.resolveRelationships(key) || []);
      }
      return relationshipCache.get(key);
    }

    for (const permission of permissions) {
      const fileName = path.basename(permission.filePath);
      const entityLogicalName = String(permission.entitylogicalname || '').toLowerCase();
      if (!entityLogicalName) {
        continue;
      }

      try {
        const relationships = getRelationships(entityLogicalName);

        if (permission.scope === SCOPE.CONTACT && permission.contactrelationship) {
          const match = relationships.some(relationship =>
            String(relationship.schemaName || '').toLowerCase() === String(permission.contactrelationship).toLowerCase()
            && String(relationship.referencedEntity || '').toLowerCase() === 'contact'
          );
          if (!match) {
            addFinding(findings, 'error', `Contact relationship "${permission.contactrelationship}" was not found in Dataverse for table "${entityLogicalName}".`, {
              filePath: permission.filePath,
              fileName,
            });
          }
        }

        if (permission.scope === SCOPE.ACCOUNT && permission.accountrelationship) {
          const match = relationships.some(relationship =>
            String(relationship.schemaName || '').toLowerCase() === String(permission.accountrelationship).toLowerCase()
            && String(relationship.referencedEntity || '').toLowerCase() === 'account'
          );
          if (!match) {
            addFinding(findings, 'error', `Account relationship "${permission.accountrelationship}" was not found in Dataverse for table "${entityLogicalName}".`, {
              filePath: permission.filePath,
              fileName,
            });
          }
        }

        if (permission.scope === SCOPE.PARENT && permission.parentrelationship && permission.parententitypermission) {
          const parentPermission = permissionsById.get(String(permission.parententitypermission));
          const expectedParentEntity = String(parentPermission?.entitylogicalname || '').toLowerCase();
          if (expectedParentEntity) {
            const match = relationships.some(relationship =>
              String(relationship.schemaName || '').toLowerCase() === String(permission.parentrelationship).toLowerCase()
              && String(relationship.referencedEntity || '').toLowerCase() === expectedParentEntity
            );
            if (!match) {
              addFinding(findings, 'error', `Parent relationship "${permission.parentrelationship}" was not found in Dataverse for table "${entityLogicalName}".`, {
                filePath: permission.filePath,
                fileName,
              });
            }
          }
        }
      } catch (error) {
        addFinding(findings, 'error', `Dataverse relationship validation failed for table "${entityLogicalName}": ${error.message}`, {
          filePath: permission.filePath,
          fileName,
        });
      }
    }
  }

  return {
    projectRoot,
    findings,
    summary: summarize(findings),
  };
}

module.exports = {
  validateTablePermissions,
  validateTablePermissionsWithOptions,
};

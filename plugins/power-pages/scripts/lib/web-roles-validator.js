const fs = require('fs');
const path = require('path');
const { WEB_ROLE_FILE_SUFFIX, listYamlFiles } = require('./powerpages-config');
const {
  detectMetadataLayout,
  loadAggregateRecords,
  normalizeWebRole,
} = require('./non-spa-metadata');
const { addFinding, findUnexpectedKeys, findMissingKeys, summarize } = require('./powerpages-validation-utils');
const { resolvePowerPagesSiteRoot } = require('./validation-helpers');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEB_ROLE_ALLOWED_KEYS = new Set([
  'anonymoususersrole',
  'authenticatedusersrole',
  'id',
  'name',
]);
const AGGREGATE_WEB_ROLE_ALLOWED_KEYS = new Set([
  'adx_anonymoususersrole',
  'adx_authenticatedusersrole',
  'adx_name',
  'adx_webroleid',
]);
const WEB_ROLE_REQUIRED_KEYS = new Set([
  'anonymoususersrole',
  'authenticatedusersrole',
  'id',
  'name',
]);

function parseWebRoleYaml(content, filePath) {
  const parsed = { filePath };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      throw new Error(`Invalid YAML line "${line}" in ${filePath}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (value === 'true') {
      parsed[key] = true;
    } else if (value === 'false') {
      parsed[key] = false;
    } else {
      parsed[key] = value;
    }
  }

  return parsed;
}

function loadWebRoles(webRolesDir) {
  if (!webRolesDir || !fs.existsSync(webRolesDir)) {
    return [];
  }

  return fs.readdirSync(webRolesDir)
    .filter(fileName => fileName.endsWith('.webrole.yml') || fileName.endsWith('.webrole.yaml'))
    .map(fileName => {
      const filePath = path.join(webRolesDir, fileName);
      return parseWebRoleYaml(fs.readFileSync(filePath, 'utf8'), filePath);
    });
}

function validateWebRoles(projectRoot) {
  const findings = [];
  const siteRoot = resolvePowerPagesSiteRoot(projectRoot);
  let layout;
  try {
    layout = detectMetadataLayout(projectRoot);
  } catch (error) {
    addFinding(findings, 'error', `Failed to resolve web role metadata: ${error.message}`, {
      filePath: siteRoot,
    });
    return {
      projectRoot,
      webRoles: [],
      findings,
      summary: summarize(findings),
    };
  }
  const webRolesDir = layout.roles.directory;

  for (const filePath of layout.roles.mode === 'per-record' ? listYamlFiles(webRolesDir) : []) {
    const fileName = path.basename(filePath);
    if (!fileName.endsWith(WEB_ROLE_FILE_SUFFIX)) {
      addFinding(findings, 'error', `Web role file does not follow naming convention "*${WEB_ROLE_FILE_SUFFIX}".`, {
        filePath,
        fileName,
      });
    }
  }

  let webRoles = [];
  let sourceRecords = [];
  try {
    if (layout.roles.mode === 'mixed') {
      throw new Error(
        `Mixed web-role serialization found at ${layout.siteRoot}; ` +
        'webrole.yml and web-roles/*.webrole.yml cannot be validated as one source.'
      );
    }
    sourceRecords = layout.roles.mode === 'aggregate'
      ? loadAggregateRecords(layout.roles.aggregateFile)
      : loadWebRoles(webRolesDir);
    webRoles = sourceRecords.map(normalizeWebRole);
  } catch (error) {
    addFinding(findings, 'error', `Failed to parse web role YAML: ${error.message}`, {
      filePath: layout.roles.mode === 'aggregate' ? layout.roles.aggregateFile : webRolesDir,
    });
  }

  const sourceAllowedKeys = layout.roles.mode === 'aggregate'
    ? AGGREGATE_WEB_ROLE_ALLOWED_KEYS
    : WEB_ROLE_ALLOWED_KEYS;

  for (let index = 0; index < webRoles.length; index += 1) {
    const webRole = webRoles[index];
    const sourceRecord = sourceRecords[index];
    const fileName = path.basename(webRole.filePath);
    const unexpectedKeys = findUnexpectedKeys(sourceRecord, sourceAllowedKeys);
    if (unexpectedKeys.length > 0) {
      addFinding(findings, 'error', `Web role contains unexpected schema keys: ${unexpectedKeys.join(', ')}.`, {
        filePath: webRole.filePath,
        fileName,
      });
    }

    const missingKeys = findMissingKeys(webRole, WEB_ROLE_REQUIRED_KEYS);
    if (missingKeys.length > 0) {
      addFinding(findings, 'error', `Web role is missing required schema keys: ${missingKeys.join(', ')}.`, {
        filePath: webRole.filePath,
        fileName,
      });
    }

    if (!UUID_REGEX.test(String(webRole.id || ''))) {
      addFinding(findings, 'error', 'Web role has an invalid "id" UUID.', {
        filePath: webRole.filePath,
        fileName,
      });
    }

    if (!webRole.name || String(webRole.name).trim() === '') {
      addFinding(findings, 'error', 'Web role has an empty "name" value.', {
        filePath: webRole.filePath,
        fileName,
      });
    }

    for (const booleanField of ['anonymoususersrole', 'authenticatedusersrole']) {
      if (typeof webRole[booleanField] !== 'boolean') {
        addFinding(findings, 'error', `Web role field "${booleanField}" must be a boolean.`, {
          filePath: webRole.filePath,
          fileName,
        });
      }
    }
  }

  return {
    projectRoot,
    webRoles,
    findings,
    summary: summarize(findings),
  };
}

module.exports = {
  validateWebRoles,
};

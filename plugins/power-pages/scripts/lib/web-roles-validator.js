const fs = require('fs');
const path = require('path');
const { WEB_ROLE_FILE_SUFFIX, listYamlFiles } = require('./powerpages-config');
const { addFinding, findUnexpectedKeys, findMissingKeys, summarize } = require('./powerpages-validation-utils');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEB_ROLE_ALLOWED_KEYS = new Set([
  'anonymoususersrole',
  'authenticatedusersrole',
  'id',
  'name',
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
  const webRolesDir = path.join(projectRoot, '.powerpages-site', 'web-roles');

  for (const filePath of listYamlFiles(webRolesDir)) {
    const fileName = path.basename(filePath);
    if (!fileName.endsWith(WEB_ROLE_FILE_SUFFIX)) {
      addFinding(findings, 'error', `Web role file does not follow naming convention "*${WEB_ROLE_FILE_SUFFIX}".`, {
        filePath,
        fileName,
      });
    }
  }

  let webRoles = [];
  try {
    webRoles = loadWebRoles(webRolesDir);
  } catch (error) {
    addFinding(findings, 'error', `Failed to parse web role YAML: ${error.message}`, {
      filePath: webRolesDir,
    });
  }

  for (const webRole of webRoles) {
    const fileName = path.basename(webRole.filePath);
    const unexpectedKeys = findUnexpectedKeys(webRole, WEB_ROLE_ALLOWED_KEYS);
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

const path = require('path');
const { SITE_SETTING_FILE_SUFFIX, loadYamlRecordsWithErrors, listYamlFiles } = require('./powerpages-config');
const { addFinding, findUnexpectedKeys, findMissingKeys, summarize } = require('./powerpages-validation-utils');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SITE_SETTING_ALLOWED_KEYS = new Set([
  'description',
  'envvar_schema',
  'id',
  'name',
  'source',
  'value',
]);

const SITE_SETTING_REQUIRED_KEYS = new Set([
  'id',
  'name',
]);

function validateSiteSettings(projectRoot) {
  const findings = [];
  const siteSettingsDir = path.join(projectRoot, '.powerpages-site', 'site-settings');

  for (const filePath of listYamlFiles(siteSettingsDir)) {
    const fileName = path.basename(filePath);
    if (!fileName.endsWith(SITE_SETTING_FILE_SUFFIX)) {
      addFinding(findings, 'error', `Site setting file does not follow naming convention "*${SITE_SETTING_FILE_SUFFIX}".`, {
        filePath,
        fileName,
      });
    }
  }

  const { records: siteSettings, errors } = loadYamlRecordsWithErrors(siteSettingsDir, SITE_SETTING_FILE_SUFFIX);
  for (const error of errors) {
    addFinding(findings, 'error', `Failed to parse site setting YAML: ${error.message}`, {
      filePath: error.filePath,
      fileName: path.basename(error.filePath),
    });
  }

  for (const setting of siteSettings) {
    const fileName = path.basename(setting.filePath);
    const unexpectedKeys = findUnexpectedKeys(setting, SITE_SETTING_ALLOWED_KEYS);
    if (unexpectedKeys.length > 0) {
      addFinding(findings, 'error', `Site setting contains unexpected schema keys: ${unexpectedKeys.join(', ')}.`, {
        filePath: setting.filePath,
        fileName,
      });
    }

    const missingKeys = findMissingKeys(setting, SITE_SETTING_REQUIRED_KEYS);
    if (missingKeys.length > 0) {
      addFinding(findings, 'error', `Site setting is missing required schema keys: ${missingKeys.join(', ')}.`, {
        filePath: setting.filePath,
        fileName,
      });
    }

    if (!UUID_REGEX.test(String(setting.id || ''))) {
      addFinding(findings, 'error', 'Site setting has an invalid "id" UUID.', {
        filePath: setting.filePath,
        fileName,
      });
    }

    if (!setting.name || String(setting.name).trim() === '') {
      addFinding(findings, 'error', 'Site setting has an empty "name" value.', {
        filePath: setting.filePath,
        fileName,
      });
    }

    const hasEnvironmentVariableSchema = Object.prototype.hasOwnProperty.call(setting, 'envvar_schema');
    const hasSource = Object.prototype.hasOwnProperty.call(setting, 'source');
    const hasValue = Object.prototype.hasOwnProperty.call(setting, 'value');

    if (hasEnvironmentVariableSchema) {
      if (String(setting.envvar_schema || '').trim() === '') {
        addFinding(findings, 'error', 'Site setting has an empty "envvar_schema" value.', {
          filePath: setting.filePath,
          fileName,
        });
      }

      if (!hasSource || setting.source !== 1) {
        addFinding(findings, 'error', 'Environment-variable-backed site setting must set "source" to 1.', {
          filePath: setting.filePath,
          fileName,
        });
      }

      if (hasValue) {
        addFinding(findings, 'error', 'Environment-variable-backed site setting must not define "value".', {
          filePath: setting.filePath,
          fileName,
        });
      }
    }

    if (hasSource && setting.source === 1 && !hasEnvironmentVariableSchema) {
      addFinding(findings, 'error', 'Site setting with "source" set to 1 must also define "envvar_schema".', {
        filePath: setting.filePath,
        fileName,
      });
    }
  }

  return {
    projectRoot,
    findings,
    summary: summarize(findings),
  };
}

module.exports = {
  validateSiteSettings,
};

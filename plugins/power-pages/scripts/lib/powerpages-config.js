const fs = require('fs');
const path = require('path');

const TABLE_PERMISSION_FILE_SUFFIX = '.tablepermission.yml';
const SITE_SETTING_FILE_SUFFIX = '.sitesetting.yml';
const WEB_ROLE_FILE_SUFFIX = '.webrole.yml';

function parseYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === 'null') {
    return null;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function parseSimpleYaml(content, filePath) {
  const parsed = { filePath };
  let currentArrayKey = null;
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('- ')) {
      if (!currentArrayKey || !Array.isArray(parsed[currentArrayKey])) {
        throw new Error(`Invalid YAML array entry in ${filePath}`);
      }
      parsed[currentArrayKey].push(parseYamlScalar(line.slice(2)));
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      throw new Error(`Invalid YAML line "${line}" in ${filePath}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (/^[>|][+-]?$/.test(value)) {
      const blockLines = [];
      currentArrayKey = null;

      while (index + 1 < lines.length) {
        const nextRawLine = lines[index + 1];
        if (nextRawLine.trim() === '') {
          blockLines.push('');
          index += 1;
          continue;
        }

        if (/^\s+/.test(nextRawLine)) {
          blockLines.push(nextRawLine.replace(/^\s+/, ''));
          index += 1;
          continue;
        }

        break;
      }

      parsed[key] = blockLines.join('\n').trim();
      continue;
    }

    if (value === '') {
      parsed[key] = [];
      currentArrayKey = key;
      continue;
    }

    parsed[key] = parseYamlScalar(value);
    currentArrayKey = null;
  }

  return parsed;
}

function loadYamlRecordsWithErrors(dirPath, suffix) {
  const records = [];
  const errors = [];

  if (!dirPath || !fs.existsSync(dirPath)) {
    return { records, errors };
  }

  for (const fileName of fs.readdirSync(dirPath).filter(name => name.endsWith(suffix))) {
    const filePath = path.join(dirPath, fileName);
    try {
      records.push(parseSimpleYaml(fs.readFileSync(filePath, 'utf8'), filePath));
    } catch (error) {
      errors.push({ filePath, message: error.message });
    }
  }

  return { records, errors };
}

function listYamlFiles(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return [];
  }

  return fs.readdirSync(dirPath)
    .filter(fileName => fileName.endsWith('.yml') || fileName.endsWith('.yaml'))
    .map(fileName => path.join(dirPath, fileName));
}

function loadYamlRecords(dirPath, suffix) {
  const { records, errors } = loadYamlRecordsWithErrors(dirPath, suffix);
  if (errors.length > 0) {
    throw new Error(errors[0].message);
  }
  return records;
}

function loadTablePermissions(tablePermissionsDir) {
  return loadYamlRecords(tablePermissionsDir, TABLE_PERMISSION_FILE_SUFFIX);
}

function loadSiteSettings(siteSettingsDir) {
  return loadYamlRecords(siteSettingsDir, SITE_SETTING_FILE_SUFFIX);
}

module.exports = {
  TABLE_PERMISSION_FILE_SUFFIX,
  SITE_SETTING_FILE_SUFFIX,
  WEB_ROLE_FILE_SUFFIX,
  parseSimpleYaml,
  loadYamlRecordsWithErrors,
  loadTablePermissions,
  loadSiteSettings,
  listYamlFiles,
};

'use strict';

// Joins what the SharePoint workflow provisioned (the sharing manifest) with the
// access control the site actually ships (`.powerpages-site` YAML), so the maker
// can read one page and answer: which SharePoint list is reachable from the
// portal, through which table, by whom, and for which operations.
//
// The manifest records intent and provenance; the YAML is the enforcement. Every
// finding below comes from disagreement between the two, or from a rule that the
// YAML alone cannot express (a SharePoint list has no contact lookup, so a
// Global-scope permission really does mean "every row to every holder of the
// role").

const fs = require('node:fs');
const path = require('node:path');
const { loadTablePermissions, loadSiteSettings, loadYamlRecordsWithErrors, WEB_ROLE_FILE_SUFFIX } = require('./powerpages-config');

/**
 * Provisioning state for the SharePoint workflow, written next to the site rather
 * than inside `docs/` because it is machine state, not a reader-facing record;
 * the same split `.datamodel-manifest.json` uses. It names real SharePoint sites,
 * so it is excluded from Git alongside the HTML records.
 */
const MANIFEST_FILE = '.sharepoint-sharing.json';
const MANIFEST_VERSION = 1;

/**
 * adx_entitypermission scope option values.
 * https://learn.microsoft.com/en-us/power-pages/security/table-permissions
 */
const SCOPE_LABELS = Object.freeze({
  756150000: 'Global',
  756150001: 'Contact',
  756150002: 'Account',
  756150003: 'Parent',
  756150004: 'Self',
});

const OPERATION_FLAGS = Object.freeze(['read', 'create', 'write', 'delete', 'append', 'appendto']);

const WRITE_OPERATIONS = Object.freeze(['create', 'write', 'delete']);

function emptyManifest() {
  return { version: MANIFEST_VERSION, updatedAt: null, entries: [] };
}

function manifestPath(projectRoot) {
  return path.join(projectRoot, MANIFEST_FILE);
}

function readSharingManifest(projectRoot) {
  const file = manifestPath(projectRoot);
  if (!fs.existsSync(file)) return emptyManifest();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.version !== MANIFEST_VERSION) {
    throw new Error(`${MANIFEST_FILE} has unsupported version ${parsed.version}; expected ${MANIFEST_VERSION}.`);
  }
  if (!Array.isArray(parsed.entries)) throw new Error(`${MANIFEST_FILE} is missing an entries array.`);
  return parsed;
}

function writeSharingManifest(projectRoot, manifest, now = new Date()) {
  const file = manifestPath(projectRoot);
  const body = { ...manifest, version: MANIFEST_VERSION, updatedAt: now.toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Replaces the entry for a table, keeping manifest order stable so a re-run
 * produces a reviewable diff rather than a reshuffled file.
 */
function upsertSharingEntry(manifest, entry) {
  if (!entry || typeof entry.table !== 'object' || !entry.table.logicalName) {
    throw new Error('A sharing entry requires table.logicalName.');
  }
  const entries = [...manifest.entries];
  const index = entries.findIndex((existing) => existing.table
    && existing.table.logicalName === entry.table.logicalName);
  if (index === -1) entries.push(entry);
  else entries[index] = entry;
  return { ...manifest, entries };
}

/** Reads the deployed site's access control as committed in `.powerpages-site`. */
function loadSiteConfiguration(projectRoot) {
  const siteDir = path.join(projectRoot, '.powerpages-site');
  if (!fs.existsSync(siteDir)) {
    throw new Error(`No .powerpages-site folder at ${siteDir}. Deploy the site once before mapping what it shares.`);
  }
  const { records: webRoles } = loadYamlRecordsWithErrors(path.join(siteDir, 'web-roles'), WEB_ROLE_FILE_SUFFIX);
  return {
    siteDir,
    webRoles,
    tablePermissions: loadTablePermissions(path.join(siteDir, 'table-permissions')),
    siteSettings: loadSiteSettings(path.join(siteDir, 'site-settings')),
  };
}

function finding(severity, code, message) {
  return { severity, code, message };
}

function normalizeFields(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((field) => field.trim()).filter(Boolean);
}

function operationsOf(permission) {
  return OPERATION_FLAGS.filter((flag) => permission[flag] === true);
}

/**
 * Builds one sharing row per provisioned table plus the findings that matter for
 * a security review. Pure: it takes already-loaded records so the rules can be
 * tested without a project on disk.
 */
function buildSharing(manifest, config) {
  const rolesById = new Map(config.webRoles
    .filter((role) => role && role.id)
    .map((role) => [String(role.id), role]));

  const settingByName = new Map(config.siteSettings
    .filter((setting) => typeof setting.name === 'string')
    .map((setting) => [setting.name.toLowerCase(), setting]));

  const permissionsByTable = new Map();
  for (const permission of config.tablePermissions) {
    const table = typeof permission.entitylogicalname === 'string'
      ? permission.entitylogicalname.toLowerCase()
      : null;
    if (!table) continue;
    if (!permissionsByTable.has(table)) permissionsByTable.set(table, []);
    permissionsByTable.get(table).push(permission);
  }

  const rows = manifest.entries.map((entry) => describeEntry(entry, {
    rolesById, settingByName, permissionsByTable,
  }));

  const mappedTables = new Set(manifest.entries
    .filter((entry) => entry.table && entry.table.logicalName)
    .map((entry) => entry.table.logicalName.toLowerCase()));

  // A Webapi setting for a table nobody provisioned through this workflow is not
  // a defect - it belongs to another integration - but it is worth naming so the
  // reader does not read this page as the site's complete Web API surface.
  const otherWebApiTables = [...settingByName.values()]
    .map((setting) => /^webapi\/([^/]+)\/enabled$/i.exec(setting.name))
    .filter(Boolean)
    .map((match) => match[1].toLowerCase())
    .filter((table) => !mappedTables.has(table) && table !== 'error');

  return { rows, otherWebApiTables: [...new Set(otherWebApiTables)] };
}

function describeEntry(entry, { rolesById, settingByName, permissionsByTable }) {
  const logicalName = entry.table.logicalName;
  const key = logicalName.toLowerCase();
  const findings = [];

  const enabledSetting = settingByName.get(`webapi/${key}/enabled`);
  const fieldsSetting = settingByName.get(`webapi/${key}/fields`);
  const webApiEnabled = enabledSetting ? enabledSetting.value === true || enabledSetting.value === 'true' : false;
  const allowlist = fieldsSetting ? normalizeFields(fieldsSetting.value) : [];

  const permissions = (permissionsByTable.get(key) || []).map((permission) => {
    const roleIds = Array.isArray(permission.adx_entitypermission_webrole)
      ? permission.adx_entitypermission_webrole.map(String)
      : [];
    const roles = roleIds.map((id) => {
      const role = rolesById.get(id);
      return role
        ? { id, name: role.name, anonymous: role.anonymoususersrole === true, authenticated: role.authenticatedusersrole === true }
        : { id, name: null, anonymous: false, authenticated: false };
    });
    return {
      name: permission.entityname,
      file: permission.filePath,
      scope: SCOPE_LABELS[permission.scope] || `Unrecognized (${permission.scope})`,
      operations: operationsOf(permission),
      roles,
    };
  });

  const allRoles = permissions.flatMap((permission) => permission.roles);
  const anonymousRoles = allRoles.filter((role) => role.anonymous);
  const unresolvedRoles = allRoles.filter((role) => role.name === null);
  const grantedOperations = [...new Set(permissions.flatMap((permission) => permission.operations))];

  if (anonymousRoles.length > 0) {
    findings.push(finding('danger', 'anonymous-role',
      `Reachable without signing in: ${anonymousRoles.map((role) => role.name).join(', ')} is an anonymous web role. SharePoint content behind this table is public to anyone with the site URL.`));
  }
  if (permissions.length === 0) {
    findings.push(finding(webApiEnabled ? 'warning' : 'info', 'no-permission',
      'No table permission grants this table. Portal requests return 403 until one exists, so nothing from this list is reachable yet.'));
  }
  if (!enabledSetting) {
    findings.push(finding(permissions.length > 0 ? 'warning' : 'info', 'webapi-not-enabled',
      `Site setting Webapi/${logicalName}/enabled is missing, so the site's Web API calls against this table fail even where a permission allows the row.`));
  } else if (!webApiEnabled) {
    findings.push(finding('warning', 'webapi-disabled',
      `Site setting Webapi/${logicalName}/enabled is set to false.`));
  }
  if (webApiEnabled && allowlist.length === 0) {
    findings.push(finding('warning', 'fields-missing',
      `Site setting Webapi/${logicalName}/fields is missing or empty. Every column read is refused; the allowlist must name each column explicitly.`));
  }
  if (allowlist.includes('*')) {
    // Power Pages stops honoring wildcard Web API field access on 14 September
    // 2026, and until then it shares every column including ones never reviewed.
    findings.push(finding('danger', 'wildcard-fields',
      `Webapi/${logicalName}/fields uses the wildcard "*". It shares every column on the table and is unsupported from 14 September 2026. Replace it with an explicit column list.`));
  }
  if (unresolvedRoles.length > 0) {
    findings.push(finding('warning', 'role-not-found',
      `A permission references web role ${unresolvedRoles.map((role) => role.id).join(', ')}, which has no file in .powerpages-site/web-roles. Who can read this list cannot be established from the project.`));
  }
  for (const permission of permissions) {
    if (permission.scope === 'Global') {
      findings.push(finding('warning', 'global-scope',
        `"${permission.name}" uses Global scope: every holder of its web role can read every row of this list. SharePoint item-level permissions are not carried across - the connection's identity reads the whole list.`));
    }
    const writes = permission.operations.filter((operation) => WRITE_OPERATIONS.includes(operation));
    if (writes.length > 0) {
      findings.push(finding('warning', 'write-back',
        `"${permission.name}" grants ${writes.join(', ')}. Those operations change the SharePoint list itself, because a virtual table has no copy of its own.`));
    }
  }

  const recordedColumns = Array.isArray(entry.columns) ? entry.columns : [];
  const recordedByLogical = new Map(recordedColumns.map((column) => [String(column.logicalName).toLowerCase(), column]));
  const unmapped = allowlist
    .filter((field) => field !== '*')
    // A lookup column is read through `_<name>_value`, so strip that wrapper
    // before comparing against the column's own logical name.
    .filter((field) => !recordedByLogical.has(field.toLowerCase())
      && !recordedByLogical.has(field.replace(/^_(.+)_value$/i, '$1').toLowerCase()));
  if (unmapped.length > 0) {
    findings.push(finding('warning', 'allowlist-column-unknown',
      `Allowlisted column(s) ${unmapped.join(', ')} do not match any column recorded on this table. Column names are case-sensitive and a mismatch returns 403 at runtime.`));
  }

  const isAllowlisted = (column) => allowlist
    .some((field) => field.toLowerCase() === String(column.logicalName).toLowerCase());
  const withheld = recordedColumns.filter((column) => !isAllowlisted(column));

  return {
    source: entry.source || {},
    table: entry.table,
    provisioning: entry.provisioning || {},
    webApi: {
      enabled: webApiEnabled,
      enabledSettingFile: enabledSetting ? enabledSetting.filePath : null,
      fieldsSettingFile: fieldsSetting ? fieldsSetting.filePath : null,
      allowlist,
    },
    permissions,
    operations: grantedOperations,
    columns: { shared: recordedColumns.filter(isAllowlisted), withheld },
    reach: reachOf({ webApiEnabled, permissions, anonymousRoles }),
    findings,
  };
}

function reachOf({ webApiEnabled, permissions, anonymousRoles }) {
  // Reach describes what a browser can fetch today, so a grant the Web API setting
  // does not yet cover reads as not-reachable. The anonymous grant still raises
  // its own must-fix finding, because enabling the setting later makes it public.
  if (!webApiEnabled || permissions.length === 0) return 'not-reachable';
  return anonymousRoles.length > 0 ? 'anonymous' : 'authenticated';
}

const REACH_LABELS = Object.freeze({
  anonymous: { text: 'Anyone, signed in or not', tone: 'danger' },
  authenticated: { text: 'Signed-in holders of the listed roles', tone: 'success' },
  'not-reachable': { text: 'Not reachable from the portal yet', tone: 'neutral' },
});

module.exports = {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  OPERATION_FLAGS,
  REACH_LABELS,
  SCOPE_LABELS,
  WRITE_OPERATIONS,
  buildSharing,
  emptyManifest,
  loadSiteConfiguration,
  manifestPath,
  readSharingManifest,
  upsertSharingEntry,
  writeSharingManifest,
};

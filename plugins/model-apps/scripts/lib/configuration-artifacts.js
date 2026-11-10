'use strict';

// Configuration artifacts declared in an App Spec: environment variables, connection references,
// Custom API definitions, duplicate-detection rules, and the solution's own version number.
//
// Every kind follows the same four roles as the other feature helpers:
//   validate(spec, {profile})  -> {errors, warnings}             no network
//   plan(spec, ctx)            -> {operations, unknown}          reads only
//   apply(plan, ctx)           -> FeatureResult                  writes through the maker SDK only
//   verify(spec, ctx)          -> Check[]                        reads only
//
// Why this module exists instead of calling the SDK from the build directly:
// - An absent field must cost ZERO calls. Every entry point returns early when its spec field is
//   missing, so an App Spec written before these fields existed builds exactly as it did.
// - The SDK's push writes the definition again even when nothing changed (an environment variable
//   PATCHes displayname/description/defaultvalue/isrequired/valueschema; a duplicate rule PATCHes
//   description, which UNPUBLISHES a published rule). So the helper compares first and pushes only
//   the fields that differ; an unchanged artifact is never pushed.
// - Results go into build output and logs, so they carry only kinds, keys, ids, pointers and fixed
//   codes — never a value, a connection id, a token, a raw SDK message or a Key Vault path. SDK
//   messages can echo request bodies (an environment variable's secret reference included).
// - EVERY create goes through `ctx.creates.run(...)`, the build's create port: a root, each of its
//   children, and a child added to an existing root by an update (a value row, a Custom API
//   parameter, a rule condition). The port supplies the client-side ids; this module has no journal,
//   no id allocator and no adoption of its own. A port that can also `resolve` an identity (one
//   that derives the same id on every run) is asked BEFORE any lookup by name: a row already at that
//   id is this build's own and is compared, never created again; a row of the same name at another
//   id is refused (create-identity-conflict), never adopted. The plain pass-through port (random
//   ids, no resolve) keeps the earlier rule: a row found by name is reused.
// - Writes are sent once (lib/configuration-transport.js): the HTTP client's retry loop would send a
//   create whose answer was lost a second time. A lost answer is reported unknown with the identity
//   that was sent, never as "nothing written".
// - An omitted field is not managed. Declaring an existing artifact without a field (or without a
//   child list) never clears that field or deletes those children; only an explicit value does.
// - A required environment variable left without a value is refused before its first write, and
//   `configurationReadiness` names every refused or unknown item and every unbound reference, so a
//   caller can stop before writing the pages that depend on them.
//
// Values that differ per environment (an environment variable's current value, a connection
// reference's connection) never live in the App Spec. They come from the same deployment-settings
// file `pac solution` uses:
//   {
//     "EnvironmentVariables": [ { "SchemaName": "contoso_ApiBase", "Value": "https://api.contoso.com" } ],
//     "ConnectionReferences": [ { "LogicalName": "contoso_sharepoint", "ConnectionId": "<id>",
//                                 "ConnectorId": "/providers/Microsoft.PowerApps/apis/shared_sharepointonline" } ]
//   }
// See: https://learn.microsoft.com/power-platform/alm/conn-ref-env-variables-build-tools

const { commandArgOrPlaceholder } = require('./cli-failure.js');

const CONFIGURATION_MIN_VERSION = '2.21.0';

const FIELDS = Object.freeze({
  environmentVariables: 'environmentVariable',
  connectionReferences: 'connectionReference',
  customApis: 'customApi',
  duplicateDetectionRules: 'duplicateRule',
});

const EV_TYPES = new Set(['string', 'number', 'boolean', 'json', 'dataSource', 'secret']);
const EV_KEYS = new Set(['schemaName', 'type', 'name', 'description', 'defaultValue', 'isRequired', 'valueSchema', 'connectorId', 'parameterKey', 'parentSchemaName']);
const CR_KEYS = new Set(['logicalName', 'connectorId', 'name', 'description', 'customConnectorId']);
const API_KEYS = new Set(['uniqueName', 'name', 'displayName', 'description', 'binding', 'boundEntityLogicalName', 'isFunction', 'isPrivate', 'allowedProcessingSteps', 'enabledForWorkflow', 'executePrivilegeName', 'requestParameters', 'responseProperties']);
const PARAM_KEYS = new Set(['uniqueName', 'type', 'isOptional', 'entityLogicalName', 'name', 'displayName', 'description']);
const RESPONSE_KEYS = new Set(['uniqueName', 'type', 'entityLogicalName', 'name', 'displayName', 'description']);
const RULE_KEYS = new Set(['key', 'name', 'entity', 'matchingEntity', 'description', 'caseSensitive', 'excludeInactiveRecords', 'status', 'conditions']);
const CONDITION_KEYS = new Set(['key', 'column', 'matchingColumn', 'match', 'characters', 'ignoreBlankValues']);

const API_BINDINGS = new Set(['global', 'entity', 'entityCollection']);
const API_STEPS = new Set(['none', 'asyncOnly', 'syncAndAsync']);
const API_TYPES = new Set(['boolean', 'dateTime', 'decimal', 'entity', 'entityCollection', 'entityReference', 'float', 'integer', 'money', 'picklist', 'string', 'stringArray', 'guid']);
// Dataverse reads `logicalentityname` only for these parameter types; on any other type it is meaningless.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/custom-api-tables#customapirequestparameter-table-columns
const API_ENTITY_TYPES = new Set(['entity', 'entityReference']);
const RULE_MATCHES = new Set(['exact', 'firstCharacters', 'lastCharacters', 'sameDate', 'sameDateAndTime', 'exactChoiceLabel', 'exactChoiceValue']);
const RULE_STATUSES = new Set(['published', 'unpublished']);
// Dataverse publishes at most five duplicate-detection rules per table.
// See: https://learn.microsoft.com/power-platform/admin/set-up-duplicate-detection-rules-keep-data-clean
const MAX_PUBLISHED_RULES_PER_TABLE = 5;

// Which App Spec column types each duplicate-detection match type can compare. A column the spec does
// not declare (a system column such as emailaddress1 on contact) is not checked here: its type is the
// platform's to judge, and the platform answers a mismatch with a 4xx before anything is saved.
const MATCH_COLUMN_TYPES = Object.freeze({
  exact: null,
  firstCharacters: new Set(['Text', 'Memo', 'AutoNumber']),
  lastCharacters: new Set(['Text', 'Memo', 'AutoNumber']),
  sameDate: new Set(['DateTime']),
  sameDateAndTime: new Set(['DateTime']),
  exactChoiceLabel: new Set(['Choice']),
  exactChoiceValue: new Set(['Choice']),
});

// Connector ids as Power Apps reports them, e.g. `/providers/Microsoft.PowerApps/apis/shared_sharepointonline`.
const CONNECTOR_ID = /^\/providers\/Microsoft\.PowerApps\/apis\/[A-Za-z0-9_.-]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_TOKEN = /^[A-Za-z][A-Za-z0-9_]*$/;
// A Key Vault secret reference, the only value a `secret` environment variable may hold:
//   /subscriptions/<guid>/resourceGroups/<group>/providers/Microsoft.KeyVault/vaults/<vault>/secrets/<name>[/<version>]
// See: https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables-azure-key-vault-secrets
const KEY_VAULT_REFERENCE = /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.KeyVault\/vaults\/[A-Za-z0-9-]+\/secrets\/[A-Za-z0-9-]+(?:\/[A-Za-z0-9]+)?$/i;
// A solution version is four dot-separated whole numbers, each stored as a 32-bit signed integer.
// See: https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#solution-version
const SOLUTION_VERSION = /^\d{1,10}\.\d{1,10}\.\d{1,10}\.\d{1,10}$/;
const INT32_MAX = 2147483647;
// Labels (a display name, a description) are compared only when the App Spec authors them, for every kind:
// a label someone set in the maker portal is not drift, and an unauthored label must never turn into a
// write (on a Custom API in a multilingual org a label edit is refused outright). A create still fills an
// unauthored name from the unique name.
const LABEL_FIELDS = ['name', 'displayName', 'description'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lower = (v) => String(v).toLowerCase();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// Three questions with three different answers, so each caller asks the one it means:
//   hasConfigurationFields      any configuration field is AUTHORED (even null or malformed): validate it
//   hasConfigurationDefinitions at least one list is a non-empty array: there is something to plan/apply
//   usesConfiguration           definitions, or an authored solution.version: the build has work to do
// An absent field costs nothing; an empty list is validated but costs no request.
function hasConfigurationFields(spec) {
  if (!isObject(spec)) return false;
  if (Object.keys(FIELDS).some((field) => has(spec, field) && spec[field] !== undefined)) return true;
  return isObject(spec.solution) && has(spec.solution, 'version') && spec.solution.version !== undefined;
}

function hasConfigurationDefinitions(spec) {
  if (!isObject(spec)) return false;
  return Object.keys(FIELDS).some((field) => Array.isArray(spec[field]) && spec[field].length > 0);
}

function usesConfiguration(spec) {
  if (!isObject(spec)) return false;
  if (hasConfigurationDefinitions(spec)) return true;
  return isObject(spec.solution) && spec.solution.version !== undefined;
}

// Properties whose explicit null has no meaning (a name is never "cleared"): refused before any read.
function notNull(entry, keys, where, errors) {
  for (const key of keys) if (has(entry, key) && entry[key] === null) errors.push(`${where}.${key} must not be null (omit it to leave it unchanged)`);
}

function closedKeys(entry, allowed, where, errors) {
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) errors.push(`${where}: '${key}' is not a supported property`);
  }
}

function optionalString(entry, key, where, errors, max) {
  if (entry[key] === undefined || entry[key] === null) return;
  if (typeof entry[key] !== 'string') errors.push(`${where}.${key} must be a string`);
  else if (max && entry[key].length > max) errors.push(`${where}.${key} must be at most ${max} characters`);
}

function optionalBoolean(entry, key, where, errors) {
  if (entry[key] !== undefined && typeof entry[key] !== 'boolean') errors.push(`${where}.${key} must be true or false`);
}

function prefixedName(value, prefix, where, field, errors) {
  if (!nonEmptyString(value)) { errors.push(`${where}.${field} is required`); return false; }
  if (!NAME_TOKEN.test(value) || value.length > 100) {
    errors.push(`${where}.${field} must start with a letter and use only letters, digits and '_' (at most 100 characters)`);
    return false;
  }
  if (prefix && !lower(value).startsWith(`${lower(prefix)}_`)) {
    errors.push(`${where}.${field} must start with the solution publisher prefix '${prefix}_'`);
    return false;
  }
  return true;
}

// The SDK stores every environment-variable value as text, so a typed value is checked as the text
// Dataverse will hold: a decimal number, "yes"/"no" for a boolean, parseable JSON for json.
// Messages name the problem, never the value: a value can be a credential someone pasted by mistake.
// See: https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables#data-types
function typedValueProblem(type, value, profile) {
  if (typeof value !== 'string') return 'must be a string';
  if (value === '') return 'must not be empty (omit it instead)';
  if (value.length > 2000) return 'must be at most 2000 characters';
  if (type === 'number' && !/^-?\d+(?:\.\d+)?$/.test(value)) return 'must be a decimal number';
  if (type === 'boolean' && value !== 'yes' && value !== 'no') return "must be 'yes' or 'no'";
  if (type === 'json') {
    try { JSON.parse(value); } catch { return 'must be valid JSON text'; }
  }
  if (type === 'secret') {
    if (profile !== 'environment') return 'is not allowed for a secret variable in a portable App Spec (supply a Key Vault reference through deployment settings)';
    if (!KEY_VAULT_REFERENCE.test(value)) return 'must be a Key Vault secret reference (/subscriptions/<id>/resourceGroups/<group>/providers/Microsoft.KeyVault/vaults/<vault>/secrets/<name>)';
  }
  return null;
}

function validateEnvironmentVariables(spec, profile, errors) {
  const list = spec.environmentVariables;
  if (list === undefined) return;
  if (!Array.isArray(list)) { errors.push('environmentVariables must be an array'); return; }
  const prefix = spec.solution && spec.solution.publisherPrefix;
  const byName = new Map();
  list.forEach((entry, i) => {
    const where = `environmentVariables[${i}]`;
    if (!isObject(entry)) { errors.push(`${where} must be an object`); return; }
    if (has(entry, 'value') || has(entry, 'currentValue')) {
      errors.push(`${where}: an App Spec does not carry a current value; supply it per environment in deployment settings (EnvironmentVariables)`);
    }
    closedKeys(entry, new Set([...EV_KEYS, 'value', 'currentValue']), where, errors);
    if (prefixedName(entry.schemaName, prefix, where, 'schemaName', errors)) {
      if (byName.has(lower(entry.schemaName))) errors.push(`${where}.schemaName '${entry.schemaName}' is declared more than once`);
      else byName.set(lower(entry.schemaName), entry);
    }
    if (!EV_TYPES.has(entry.type)) errors.push(`${where}.type must be one of ${[...EV_TYPES].join(', ')}`);
    notNull(entry, ['name', 'isRequired'], where, errors);
    optionalString(entry, 'name', where, errors, 100);
    optionalString(entry, 'description', where, errors, 2000);
    optionalBoolean(entry, 'isRequired', where, errors);
    // A secret's default would be stored in the definition row, readable by anyone who can read it, so
    // no profile accepts one: a Key Vault reference goes in as the current value, through deployment settings.
    if (entry.type === 'secret' && entry.defaultValue !== undefined && entry.defaultValue !== null) {
      errors.push(`${where}.defaultValue is not allowed for a secret variable (supply a Key Vault reference through deployment settings)`);
    } else if (entry.defaultValue !== undefined && entry.defaultValue !== null && EV_TYPES.has(entry.type)) {
      const problem = typedValueProblem(entry.type, entry.defaultValue, profile);
      if (problem) errors.push(`${where}.defaultValue ${problem}`);
    }
    if (entry.valueSchema !== undefined && entry.valueSchema !== null) {
      if (entry.type !== 'json') errors.push(`${where}.valueSchema applies only to a json variable`);
      else if (typeof entry.valueSchema !== 'string') errors.push(`${where}.valueSchema must be JSON schema text`);
      else { try { JSON.parse(entry.valueSchema); } catch { errors.push(`${where}.valueSchema must be valid JSON text`); } }
    }
    for (const key of ['connectorId', 'parameterKey', 'parentSchemaName']) {
      if (entry[key] === undefined || entry[key] === null) continue;
      if (entry.type !== 'dataSource') errors.push(`${where}.${key} applies only to a dataSource variable`);
      else if (!nonEmptyString(entry[key])) errors.push(`${where}.${key} must be a non-empty string`);
    }
    if (entry.type === 'dataSource' && typeof entry.connectorId === 'string' && !CONNECTOR_ID.test(entry.connectorId)) {
      errors.push(`${where}.connectorId must look like /providers/Microsoft.PowerApps/apis/<connector>`);
    }
  });
  // A data-source variable's parent is another data-source variable (a SharePoint list's parent is its
  // site). The parent must be declared here so its type is known, and the chain must end, because the
  // definitions are created parent-first.
  list.forEach((entry, i) => {
    if (!isObject(entry) || typeof entry.parentSchemaName !== 'string' || entry.type !== 'dataSource') return;
    const parent = byName.get(lower(entry.parentSchemaName));
    if (!parent) errors.push(`environmentVariables[${i}].parentSchemaName '${entry.parentSchemaName}' is not declared in environmentVariables`);
    else if (parent.type !== 'dataSource') errors.push(`environmentVariables[${i}].parentSchemaName '${entry.parentSchemaName}' must be a dataSource variable`);
  });
  for (const entry of byName.values()) {
    const seen = new Set();
    let at = entry;
    while (at && typeof at.parentSchemaName === 'string' && at.type === 'dataSource') {
      if (seen.has(lower(at.schemaName))) { errors.push(`environmentVariables: '${entry.schemaName}' is part of a parentSchemaName cycle`); break; }
      seen.add(lower(at.schemaName));
      at = byName.get(lower(at.parentSchemaName));
    }
  }
}

function validateConnectionReferences(spec, errors) {
  const list = spec.connectionReferences;
  if (list === undefined) return;
  if (!Array.isArray(list)) { errors.push('connectionReferences must be an array'); return; }
  const prefix = spec.solution && spec.solution.publisherPrefix;
  const seen = new Set();
  list.forEach((entry, i) => {
    const where = `connectionReferences[${i}]`;
    if (!isObject(entry)) { errors.push(`${where} must be an object`); return; }
    if (has(entry, 'connectionId')) errors.push(`${where}: an App Spec does not carry a connection; bind it per environment in deployment settings (ConnectionReferences)`);
    closedKeys(entry, new Set([...CR_KEYS, 'connectionId']), where, errors);
    if (prefixedName(entry.logicalName, prefix, where, 'logicalName', errors)) {
      if (seen.has(lower(entry.logicalName))) errors.push(`${where}.logicalName '${entry.logicalName}' is declared more than once`);
      seen.add(lower(entry.logicalName));
    }
    if (typeof entry.connectorId !== 'string' || !CONNECTOR_ID.test(entry.connectorId)) {
      errors.push(`${where}.connectorId must look like /providers/Microsoft.PowerApps/apis/<connector>`);
    }
    notNull(entry, ['name'], where, errors);
    optionalString(entry, 'name', where, errors, 100);
    optionalString(entry, 'description', where, errors, 2000);
    if (entry.customConnectorId !== undefined && entry.customConnectorId !== null && !(typeof entry.customConnectorId === 'string' && GUID.test(entry.customConnectorId))) {
      errors.push(`${where}.customConnectorId must be a GUID`);
    }
  });
}

function validateApiChildren(list, allowed, where, isRequest, errors) {
  if (list === undefined) return;
  if (!Array.isArray(list)) { errors.push(`${where} must be an array`); return; }
  const seen = new Set();
  list.forEach((child, j) => {
    const at = `${where}[${j}]`;
    if (!isObject(child)) { errors.push(`${at} must be an object`); return; }
    closedKeys(child, allowed, at, errors);
    if (!nonEmptyString(child.uniqueName) || !NAME_TOKEN.test(child.uniqueName)) errors.push(`${at}.uniqueName must start with a letter and use only letters, digits and '_'`);
    else if (seen.has(lower(child.uniqueName))) errors.push(`${at}.uniqueName '${child.uniqueName}' is declared more than once`);
    else seen.add(lower(child.uniqueName));
    if (!API_TYPES.has(child.type)) errors.push(`${at}.type is required and must be one of ${[...API_TYPES].join(', ')}`);
    if (isRequest) optionalBoolean(child, 'isOptional', at, errors);
    if (child.entityLogicalName !== undefined && child.entityLogicalName !== null) {
      if (!API_ENTITY_TYPES.has(child.type)) errors.push(`${at}.entityLogicalName applies only to entity or entityReference`);
      else if (!nonEmptyString(child.entityLogicalName)) errors.push(`${at}.entityLogicalName must be a table logical name`);
    }
    optionalString(child, 'name', at, errors, 100);
    optionalString(child, 'displayName', at, errors, 100);
    optionalString(child, 'description', at, errors, 300);
  });
}

function validateCustomApis(spec, errors) {
  const list = spec.customApis;
  if (list === undefined) return;
  if (!Array.isArray(list)) { errors.push('customApis must be an array'); return; }
  const prefix = spec.solution && spec.solution.publisherPrefix;
  const seen = new Set();
  list.forEach((entry, i) => {
    const where = `customApis[${i}]`;
    if (!isObject(entry)) { errors.push(`${where} must be an object`); return; }
    // The implementation (a plug-in type) is deployed separately; the App Spec declares the contract only.
    if (has(entry, 'pluginTypeId')) errors.push(`${where}.pluginTypeId is not supported: an App Spec declares the API contract; register its implementation separately`);
    closedKeys(entry, new Set([...API_KEYS, 'pluginTypeId']), where, errors);
    if (prefixedName(entry.uniqueName, prefix, where, 'uniqueName', errors)) {
      if (seen.has(lower(entry.uniqueName))) errors.push(`${where}.uniqueName '${entry.uniqueName}' is declared more than once`);
      seen.add(lower(entry.uniqueName));
    }
    notNull(entry, ['name', 'displayName', 'description', 'binding', 'boundEntityLogicalName', 'allowedProcessingSteps', 'requestParameters', 'responseProperties'], where, errors);
    optionalString(entry, 'name', where, errors, 100);
    optionalString(entry, 'displayName', where, errors, 100);
    optionalString(entry, 'description', where, errors, 300);
    // The binding is checked only as authored: an omitted binding of an EXISTING API is the API's own
    // (an entity-bound API declared without its binding keeps it), and is checked against the row at plan time.
    if (entry.binding !== undefined) {
      if (!API_BINDINGS.has(entry.binding)) errors.push(`${where}.binding must be one of ${[...API_BINDINGS].join(', ')}`);
      if (entry.binding === 'global' && entry.boundEntityLogicalName !== undefined && entry.boundEntityLogicalName !== null) {
        errors.push(`${where}.boundEntityLogicalName applies only to an entity or entityCollection binding`);
      }
      if ((entry.binding === 'entity' || entry.binding === 'entityCollection') && !nonEmptyString(entry.boundEntityLogicalName)) {
        errors.push(`${where}.boundEntityLogicalName is required for a ${entry.binding} binding`);
      }
    } else if (entry.boundEntityLogicalName !== undefined && !nonEmptyString(entry.boundEntityLogicalName)) {
      errors.push(`${where}.boundEntityLogicalName must be a table logical name`);
    }
    if (entry.allowedProcessingSteps !== undefined && !API_STEPS.has(entry.allowedProcessingSteps)) {
      errors.push(`${where}.allowedProcessingSteps must be one of ${[...API_STEPS].join(', ')}`);
    }
    for (const key of ['isFunction', 'isPrivate', 'enabledForWorkflow']) optionalBoolean(entry, key, where, errors);
    optionalString(entry, 'executePrivilegeName', where, errors, 100);
    if (typeof entry.executePrivilegeName === 'string' && entry.executePrivilegeName.trim() === '') errors.push(`${where}.executePrivilegeName must not be empty (null removes it)`);
    validateApiChildren(entry.requestParameters, PARAM_KEYS, `${where}.requestParameters`, true, errors);
    validateApiChildren(entry.responseProperties, RESPONSE_KEYS, `${where}.responseProperties`, false, errors);
    // A function is called with GET and must return something. Only an EXPLICIT empty list is refused here:
    // an omitted list leaves an existing API's properties as they are, so it is checked against the row at plan time.
    // See: https://learn.microsoft.com/power-apps/developer/data-platform/custom-api#select-a-custom-api-type
    if (entry.isFunction === true && Array.isArray(entry.responseProperties) && entry.responseProperties.length === 0) {
      errors.push(`${where}: a function (isFunction: true) needs at least one responseProperties entry`);
    }
  });
}

function specColumnType(spec, table, column) {
  const entity = (spec.entities || []).find((e) => isObject(e) && typeof e.schemaName === 'string' && lower(e.schemaName) === lower(table));
  if (!entity) return null;
  if (entity.primaryAttribute && typeof entity.primaryAttribute.schemaName === 'string' && lower(entity.primaryAttribute.schemaName) === lower(column)) return 'Text';
  const declared = (entity.columns || []).find((c) => isObject(c) && typeof c.schemaName === 'string' && lower(c.schemaName) === lower(column));
  return declared ? (declared.type || 'Text') : null;
}

function specTableFlag(spec, table) {
  const entity = (spec.entities || []).find((e) => isObject(e) && typeof e.schemaName === 'string' && lower(e.schemaName) === lower(table));
  return entity && typeof entity.duplicateDetectionEnabled === 'boolean' ? entity.duplicateDetectionEnabled : undefined;
}

function validateDuplicateRules(spec, errors) {
  const list = spec.duplicateDetectionRules;
  if (list === undefined) return;
  if (!Array.isArray(list)) { errors.push('duplicateDetectionRules must be an array'); return; }
  const keys = new Set();
  const names = new Set();
  const publishedPerTable = new Map();
  list.forEach((rule, i) => {
    const where = `duplicateDetectionRules[${i}]`;
    if (!isObject(rule)) { errors.push(`${where} must be an object`); return; }
    closedKeys(rule, RULE_KEYS, where, errors);
    // Rule and condition keys are compared byte for byte: they are identities, and a create derives its id from them.
    if (!nonEmptyString(rule.key)) errors.push(`${where}.key is required`);
    else if (keys.has(rule.key)) errors.push(`${where}.key '${rule.key}' is declared more than once`);
    else keys.add(rule.key);
    notNull(rule, ['matchingEntity', 'status', 'conditions', 'caseSensitive', 'excludeInactiveRecords'], where, errors);
    // Dataverse does not keep rule names unique, but the build finds an existing rule by name, so two
    // declared rules with one name would be indistinguishable.
    if (!nonEmptyString(rule.name) || rule.name.length > 100) errors.push(`${where}.name is required (at most 100 characters)`);
    else if (names.has(lower(rule.name))) errors.push(`${where}.name '${rule.name}' is declared more than once`);
    else names.add(lower(rule.name));
    if (!nonEmptyString(rule.entity)) errors.push(`${where}.entity is required (a table logical name)`);
    if (rule.matchingEntity !== undefined && !nonEmptyString(rule.matchingEntity)) errors.push(`${where}.matchingEntity must be a table logical name`);
    optionalString(rule, 'description', where, errors, 2000);
    optionalBoolean(rule, 'caseSensitive', where, errors);
    optionalBoolean(rule, 'excludeInactiveRecords', where, errors);
    // Only an EXPLICIT status is counted here. An omitted status leaves an existing rule's status as it is, and
    // a new rule's default (published) is checked against the environment at plan time.
    if (rule.status !== undefined && !RULE_STATUSES.has(rule.status)) errors.push(`${where}.status must be 'published' or 'unpublished'`);
    if (rule.status === 'published' && nonEmptyString(rule.entity)) {
      const table = lower(rule.entity);
      publishedPerTable.set(table, (publishedPerTable.get(table) || 0) + 1);
      if (specTableFlag(spec, rule.entity) === false) {
        errors.push(`${where}: table '${rule.entity}' declares duplicateDetectionEnabled: false, so the rule cannot be published (set status: 'unpublished' or enable detection on the table)`);
      }
    }
    // Omitted conditions leave an existing rule's criteria as they are (a NEW rule needs at least one, checked at
    // plan time); [] removes every criterion, which only an unpublished rule can hold (also checked at plan time).
    if (rule.conditions === undefined || rule.conditions === null) return;
    if (!Array.isArray(rule.conditions)) { errors.push(`${where}.conditions must be an array`); return; }
    if (rule.conditions.length === 0 && rule.status === 'published') errors.push(`${where}.conditions: a published rule needs at least one condition`);
    const conditionKeys = new Set();
    rule.conditions.forEach((condition, j) => {
      const at = `${where}.conditions[${j}]`;
      if (!isObject(condition)) { errors.push(`${at} must be an object`); return; }
      closedKeys(condition, CONDITION_KEYS, at, errors);
      if (!nonEmptyString(condition.key)) errors.push(`${at}.key is required`);
      else if (conditionKeys.has(condition.key)) errors.push(`${at}.key '${condition.key}' is declared more than once`);
      else conditionKeys.add(condition.key);
      notNull(condition, ['matchingColumn', 'ignoreBlankValues'], at, errors);
      if (!nonEmptyString(condition.column)) errors.push(`${at}.column is required`);
      if (condition.matchingColumn !== undefined && !nonEmptyString(condition.matchingColumn)) errors.push(`${at}.matchingColumn must be a column logical name`);
      if (!RULE_MATCHES.has(condition.match)) { errors.push(`${at}.match must be one of ${[...RULE_MATCHES].join(', ')}`); return; }
      const counted = condition.match === 'firstCharacters' || condition.match === 'lastCharacters';
      if (counted && !(Number.isInteger(condition.characters) && condition.characters > 0)) errors.push(`${at}.characters must be a positive whole number for ${condition.match}`);
      if (!counted && condition.characters !== undefined && condition.characters !== null) errors.push(`${at}.characters applies only to firstCharacters or lastCharacters`);
      optionalBoolean(condition, 'ignoreBlankValues', at, errors);
      const allowed = MATCH_COLUMN_TYPES[condition.match];
      if (!allowed || !nonEmptyString(rule.entity) || !nonEmptyString(condition.column)) return;
      const type = specColumnType(spec, rule.entity, condition.column);
      if (type && !allowed.has(type)) errors.push(`${at}: match '${condition.match}' cannot compare column '${condition.column}' of type ${type}`);
    });
  });
  for (const [table, count] of publishedPerTable) {
    if (count > MAX_PUBLISHED_RULES_PER_TABLE) errors.push(`duplicateDetectionRules: table '${table}' has ${count} published rules; Dataverse allows at most ${MAX_PUBLISHED_RULES_PER_TABLE}`);
  }
}

function validateSolutionVersion(spec, errors) {
  const version = isObject(spec.solution) ? spec.solution.version : undefined;
  if (version === undefined) return;
  // Canonical digits only ('01' is refused): Dataverse stores the parts as integers, so '1.01.0.0' would read back
  // as '1.1.0.0' and every rebuild would see a change.
  if (typeof version !== 'string' || !SOLUTION_VERSION.test(version) || version.split('.').some((part) => Number(part) > INT32_MAX || (part.length > 1 && part[0] === '0'))) {
    errors.push(`solution.version must be four whole numbers separated by dots (major.minor.build.revision), each at most ${INT32_MAX}`);
  }
}

// `profile` says where the spec lives: 'portable' (the default — a file that moves between
// environments) refuses a secret default outright; 'environment' (an environment-bound workspace)
// accepts one only as a Key Vault reference.
function validateConfiguration(spec, { profile = 'portable' } = {}) {
  const errors = [];
  const warnings = [];
  if (!hasConfigurationFields(spec)) return { errors, warnings };
  validateEnvironmentVariables(spec, profile, errors);
  validateConnectionReferences(spec, errors);
  validateCustomApis(spec, errors);
  validateDuplicateRules(spec, errors);
  validateSolutionVersion(spec, errors);
  // Same capability gate as app.tables: an older plugin's closed-key check would refuse the spec, or
  // an older build would skip the fields. `app-spec.js` is required lazily because it requires this
  // module for validation.
  const { isPluginVersion, compareVersions } = require('./app-spec.js');
  const floor = spec.minimumPluginVersion;
  if (!isPluginVersion(floor) || compareVersions(floor, CONFIGURATION_MIN_VERSION) < 0) {
    warnings.push(`set minimumPluginVersion to '${CONFIGURATION_MIN_VERSION}' or newer when using environmentVariables, connectionReferences, customApis, duplicateDetectionRules or solution.version — older plugins ignore these fields`);
  }
  return { errors, warnings };
}

// Read the per-environment bindings from a deployment-settings object (the parsed JSON file).
//   EnvironmentVariables[].Value: a string sets the value, null clears it, "" or a missing entry
//     leaves the environment's value alone (pac writes "" for "not supplied").
//   ConnectionReferences[].ConnectionId: a string binds, null unbinds, "" or a missing entry leaves
//     the binding alone.
// Returns maps keyed by lower-case schema/logical name. Errors name the entry, never its value.
function readDeploymentBindings(settings, spec = {}) {
  const environmentVariables = new Map();
  const connectionReferences = new Map();
  const errors = [];
  if (settings === undefined || settings === null) return { environmentVariables, connectionReferences, errors };
  if (!isObject(settings)) return { environmentVariables, connectionReferences, errors: ['deployment settings must be a JSON object'] };
  const declaredVariables = new Map((Array.isArray(spec.environmentVariables) ? spec.environmentVariables : [])
    .filter((e) => isObject(e) && typeof e.schemaName === 'string').map((e) => [lower(e.schemaName), e]));
  const declaredReferences = new Map((Array.isArray(spec.connectionReferences) ? spec.connectionReferences : [])
    .filter((e) => isObject(e) && typeof e.logicalName === 'string').map((e) => [lower(e.logicalName), e]));
  // Duplicates are tracked apart from the result maps: an entry refused for its value is not in a map,
  // and a second entry for the same name must still be reported rather than silently win.
  const seenVariables = new Set();
  const seenReferences = new Set();
  const variables = settings.EnvironmentVariables === undefined ? [] : settings.EnvironmentVariables;
  if (!Array.isArray(variables)) errors.push('deployment settings EnvironmentVariables must be an array');
  else variables.forEach((entry, i) => {
    const where = `deployment settings EnvironmentVariables[${i}]`;
    if (!isObject(entry) || !nonEmptyString(entry.SchemaName)) { errors.push(`${where} needs a SchemaName`); return; }
    const key = lower(entry.SchemaName);
    if (seenVariables.has(key)) { errors.push(`${where}: '${entry.SchemaName}' appears more than once`); return; }
    seenVariables.add(key);
    if (!has(entry, 'Value') || entry.Value === '') return;
    if (entry.Value !== null) {
      const declared = declaredVariables.get(key);
      const problem = typeof entry.Value !== 'string' ? 'must be a string or null'
        : declared && EV_TYPES.has(declared.type) ? typedValueProblem(declared.type, entry.Value, 'environment') : null;
      if (problem) { errors.push(`${where} (${entry.SchemaName}) Value ${problem}`); return; }
    }
    environmentVariables.set(key, { value: entry.Value });
  });
  const references = settings.ConnectionReferences === undefined ? [] : settings.ConnectionReferences;
  if (!Array.isArray(references)) errors.push('deployment settings ConnectionReferences must be an array');
  else references.forEach((entry, i) => {
    const where = `deployment settings ConnectionReferences[${i}]`;
    if (!isObject(entry) || !nonEmptyString(entry.LogicalName)) { errors.push(`${where} needs a LogicalName`); return; }
    const key = lower(entry.LogicalName);
    if (seenReferences.has(key)) { errors.push(`${where}: '${entry.LogicalName}' appears more than once`); return; }
    seenReferences.add(key);
    const declared = declaredReferences.get(key);
    // A binding to a connection of a different connector would fail at run time in a way the maker
    // only sees when the page calls it, so it is refused here, before anything is written.
    if (declared && nonEmptyString(entry.ConnectorId) && lower(entry.ConnectorId) !== lower(declared.connectorId)) {
      errors.push(`${where} (${entry.LogicalName}) ConnectorId does not match the connector the App Spec declares`);
      return;
    }
    if (!has(entry, 'ConnectionId') || entry.ConnectionId === '') return;
    if (entry.ConnectionId !== null && !nonEmptyString(entry.ConnectionId)) { errors.push(`${where} (${entry.LogicalName}) ConnectionId must be a string or null`); return; }
    connectionReferences.set(key, { connectionId: entry.ConnectionId });
  });
  return { environmentVariables, connectionReferences, errors };
}

// ---------------------------------------------------------------------------------------------
// Failure classification. Results carry a fixed code, never the SDK's message: a message can quote
// the request (a secret reference, a connection id) or a server URL.
//
// A failed write is 'nothing' only when it provably sent nothing that could have committed:
// - the SDK refused locally before sending (VALIDATION_ERROR and the other pre-write refusals below;
//   CUSTOM_API_LABELS_UNSUPPORTED says "Nothing was sent" in its own contract);
// - the server answered a SINGLE-request write with a 4xx, AND the HTTP client's record of the sends
//   behind that answer shows no earlier send of the same request went unanswered. A 4xx alone proves
//   nothing: the client re-sends a request whose first answer was lost (a 503 from a gateway, a dropped
//   connection), and when that first send committed, the re-send is refused (a 412, a duplicate key)
//   although the row exists. The record rides on the failure body the SDK keeps as the error's `cause`
//   (lib/sdk-http-client.js, HTTP_SEND_HISTORY): `{ sends: 2, earlierAmbiguous: true }`. Without the
//   record (a client that does not keep one) the 4xx stays unknown. 408 and 429 are not refusals.
// Everything else is 'unknown': a connection drop, a 5xx from an intermediary, an unconfirmed answer,
// and ANY failure in a composite write (environment variable definition + value, duplicate rule save +
// publish, Custom API root + children), because an earlier request of the same push may already have
// committed. The SDK's own *_NOT_ATOMIC and *_UNSETTLED codes say exactly that.
// Same rule as lib/genpage-sdk.js writeOutcome, plus the send record.
const PRE_WRITE_CODES = new Set([
  'VALIDATION_ERROR', 'INVALID_ARGUMENT', 'INVALID_JSON_POINTER', 'ARTIFACT_NOT_FOUND', 'ARTIFACT_ALREADY_EXISTS',
  'ARTIFACT_LANGUAGE_MISMATCH', 'ARTIFACT_PROJECTION_STALE', 'CUSTOM_API_LABELS_UNSUPPORTED',
]);
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,63}$/;
const TAGGED = Symbol('configuration-artifacts.tagged');
const HTTP_SEND_HISTORY = Symbol.for('power-platform-skills.http-send-history');

function codeOf(error) {
  return error && typeof error.code === 'string' && CODE_SHAPE.test(error.code) ? error.code : 'UNEXPECTED_ERROR';
}

function causeChain(error) {
  const chain = [];
  for (let e = error, i = 0; e && typeof e === 'object' && i < 8; e = e.cause, i++) chain.push(e);
  return chain;
}

function outcomeOf(error, singleWrite) {
  const code = codeOf(error);
  if (PRE_WRITE_CODES.has(code)) return 'nothing';
  if (code !== 'CONNECTION_ERROR' || !singleWrite) return 'unknown';
  const status = error.statusCode;
  if (!Number.isInteger(status) || status < 400 || status >= 500 || status === 408 || status === 429) return 'unknown';
  const chain = causeChain(error);
  const ambiguous = (e) => {
    const s = Number.isInteger(e.statusCode) ? e.statusCode : Number.isInteger(e.status) ? e.status : null;
    return e.outcome === 'unknown' || s === 0 || (s !== null && s >= 500);
  };
  if (chain.some(ambiguous)) return 'unknown';
  const history = chain.map((e) => e[HTTP_SEND_HISTORY]).find((h) => h && typeof h === 'object');
  return history && history.earlierAmbiguous === false ? 'nothing' : 'unknown';
}

// The error handed back through the create port: code and outcome only, so the port can release a
// create that sent nothing and fence one whose outcome is unknown, without seeing the SDK's message.
// `report` overrides how the item is reported when the failure is a deeper create's (see applyUpdate).
function tagged(kind, key, code, outcome, report) {
  const error = new Error(`${kind} '${key}' failed: ${code}`);
  error.code = code;
  error.outcome = outcome;
  error[TAGGED] = true;
  if (report) error.report = report;
  return error;
}

// What a failure out of `ctx.creates.run` means for the result: `{bucket: 'refused' | 'unknown', code}`.
// `sent` says whether the port had entered execute (so a request may have left this machine).
// - our own failures (tagged above) carry their bucket;
// - the port's typed stops carry lower-case codes (create-identity-conflict: a row of that name sits at another
//   id; create-identity-unverified: the derived id could not be read; create-outcome-unknown;
//   create-completion-required) and pass through unchanged, so a caller can name them;
// - any other failure after execute was entered is unknown: what was sent is not known.
const PORT_CODE = /^create-[a-z0-9-]{2,60}$/;
const UNKNOWN_PORT_CODES = new Set(['create-identity-unverified', 'create-outcome-unknown', 'create-completion-required']);
function portCode(error) {
  return error && typeof error.code === 'string' && PORT_CODE.test(error.code) ? error.code : null;
}

function routeFailure(error, sent) {
  if (error && error[TAGGED]) return error.report || { bucket: error.outcome === 'nothing' ? 'refused' : 'unknown', code: error.code };
  const code = portCode(error);
  if (code) return { bucket: sent || UNKNOWN_PORT_CODES.has(code) ? 'unknown' : 'refused', code };
  if (sent) return { bucket: 'unknown', code: 'create-outcome-unknown' };
  return { bucket: 'refused', code: codeOf(error) === 'UNEXPECTED_ERROR' ? 'CREATE_REFUSED' : codeOf(error) };
}

const portOf = (ctx) => (ctx.creates && typeof ctx.creates.run === 'function' ? ctx.creates : null);

function emptyResult() {
  return { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] };
}

// An operation as the build (and a dry-run) sees it. The desired values and the remote snapshot ride on
// a NON-enumerable `detail`, so printing or serializing a plan cannot leak a value.
function operation(kind, key, target, action, fields = {}) {
  const op = {
    key, kind, target, action,
    destructive: false,
    publicationScopes: [],
    preconditions: [],
    ...fields,
  };
  Object.defineProperty(op, 'detail', { value: {}, enumerable: false, writable: true });
  return op;
}

function same(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

const ref = (v) => (typeof v === 'string' ? lower(v) : v === undefined ? null : v);

// The create port's key for a root: the case-insensitive Dataverse name, lower-cased, except a duplicate rule's
// App Spec key, which is an identity of its own and is kept byte for byte.
const portKeyOf = (kind, key) => (kind === 'duplicateRule' ? String(key) : lower(key));

// A stop the resolver step raises itself, shaped like the port's own typed stops. `id` is the identity's id when the
// stop names one (see stoppedId); it is all of the failure that is kept: the resolver's message can quote a header.
function identityStop(code, id) {
  const error = new Error(`create identity: ${code}`);
  error.code = code;
  if (id) error.id = id;
  return error;
}

// Under an exact port the row its binding names is read into the workspace with a fetch that OVERWRITES the local copy.
// A copy that holds edits the service has not seen (an earlier run's unsent change, or one made by hand) is the maker's to
// keep or drop, never this read's: it stops typed, the copy kept (the protected preflight names it first, as
// workspace-copy-unsent-edits with the one approval that replaces it, overwrite:<kind>:<key>). Only a diff (lib/unsynced-edits.js), no request; a copy the workspace does not hold reads clean, and a diff
// that cannot be made reads as edits, so a doubtful copy is kept too.
async function refuseLocalDraft(sdk, kind, id) {
  const { hasUnsyncedEdits } = require('./unsynced-edits.js');
  if (await hasUnsyncedEdits(sdk, kind, id)) throw identityStop('create-completion-required', id);
}

// The id a typed stop is about, when it names one, so a maker can inspect the row the next run could not read. The
// stops of a stable port's resolver carry the create they stop, e.g.
//   { code: 'create-identity-unverified', message: '... could not be read (HTTP 503: ...)', create: { kind, key, id } }
// and a stop raised here carries `id`. Only a GUID is kept: never the message, a cause or any other field.
function stoppedId(error) {
  if (!error || typeof error !== 'object') return null;
  const candidates = [error.create && error.create.id, error.id];
  const id = candidates.find((v) => typeof v === 'string' && GUID.test(v.replace(/^\{|\}$/g, '')));
  return id ? lower(id.replace(/^\{|\}$/g, '')) : null;
}

// Locate the remote artifact for one declaration, in this order:
// 1. a managed binding (`ctx.managed.lookup`) wins: the build recorded that id itself;
// 2. a port that can `resolve` is asked for the identity's own id BEFORE any name is read:
//      {state:'present', id}  the row at that id is this identity's (an earlier run created it): compared, never created again;
//      {state:'absent', id?}  no row at that id; a row found by NAME at another id is someone else's and is refused
//                             (create-identity-conflict, nothing sent), never adopted or renumbered;
//    anything else, or a throw, stops the item (create-identity-unverified): a failed read never proves absence;
// 3. otherwise (the plain pass-through port, no resolve) the unique name is the identity, as for every other kind
//    the plugin builds, and a row found by name is reused.
// A row found in step 2 or 3 has no management record (step 1 did not find one), so the common adoption policy
// (`ctx.managed.planAdoption`) decides it. A build that records what it manages but has no policy to ask cannot
// confirm the row's management: it is marked `unrecorded` and the run reports CONFIGURATION_RECORD_UNCONFIRMED,
// never a quiet success (an earlier run's record that failed would otherwise be lost for good).
async function adoptionOf(managed, kind, key, id, remote, origin) {
  if (managed && typeof managed.planAdoption === 'function') {
    const decision = await managed.planAdoption({ kind, key, id });
    if (!decision || decision.allowed !== true) return { id, remote, origin: 'adopted', refusal: (decision && CODE_SHAPE.test(String(decision.code)) && decision.code) || 'ADOPTION_REFUSED' };
    return { id, remote, origin: 'adopted' };
  }
  if (managed && typeof managed.recordApplied === 'function') return { id, remote, origin, unrecorded: true };
  return { id, remote, origin };
}

// An exact port (protected configuration, lib/configuration-protected.js) is the one authority on the kinds it protects:
// its binding store, read at exact ids, decides, and no other record (the managed-artifacts manifest) or name may stand in.
function exactPortOf(ctx, kind) {
  const port = portOf(ctx);
  return port && port.exact === true && typeof port.protects === 'function' && port.protects(kind) ? port : null;
}

async function locate(ctx, kind, key, identity) {
  const managed = ctx.managed;
  const exactPort = exactPortOf(ctx, kind);
  if (!exactPort && managed && typeof managed.lookup === 'function') {
    const bound = await managed.lookup(kind, key);
    if (bound && bound.id) {
      try {
        return { id: bound.id, remote: await ctx.sdk.fetchArtifact(kind, bound.id, { overwrite: true }), origin: 'managed', childIds: bound.childIds };
      } catch (error) {
        // The bound row was deleted outside the build: fall through and look it up.
        if (codeOf(error) !== 'ARTIFACT_NOT_FOUND') throw error;
      }
    }
  }
  // The stable path runs only for a kind the port protects: an unprotected kind keeps the plain name lookup, so
  // a port that protects some kinds (a stable-v1 spec that ships only some of them) never refuses the others.
  // The caller's port, else the one this plan built (planDefaultPort). The default is the plain pass-through, which
  // has no `resolve`; a stable one exists only when a caller injects the stable-id functions (configurationContext).
  const port = portOf(ctx) || ctx[DEFAULT_PORT] || null;
  const creates = port && typeof port.resolve === 'function' && (typeof port.protects !== 'function' || port.protects(kind)) ? port : null;
  let derived = null;
  if (creates) {
    let resolved;
    try {
      resolved = await creates.resolve({ kind, key: portKeyOf(kind, key), identity });
    } catch (error) {
      // A read of the identity's id that failed proves nothing either way: never absence. A typed stop of the
      // resolver keeps its code (a conflict is refused, the rest stay unknown) and the id it names.
      throw identityStop(portCode(error) || 'create-identity-unverified', stoppedId(error));
    }
    if (resolved && resolved.state === 'present' && typeof resolved.id === 'string' && resolved.id) {
      if (exactPort) await refuseLocalDraft(ctx.sdk, kind, resolved.id);
      const remote = await ctx.sdk.fetchArtifact(kind, resolved.id, { overwrite: true });
      // An exact port proved the row is this build's own create (its committed binding, read at the exact id): it is
      // not adopted, so the adoption policy and the manifest's record are not asked — the binding store answers. A write
      // the port still owes for it (an unsent pending edit) rides along: planOne never counts such an item unchanged.
      if (exactPort) return { id: resolved.id, remote, origin: 'resolved', ...(resolved.owed ? { owed: resolved.owed } : {}) };
      return adoptionOf(managed, kind, key, resolved.id, remote, 'resolved');
    }
    if (!resolved || resolved.state !== 'absent') throw identityStop('create-identity-unverified');
    derived = typeof resolved.id === 'string' && resolved.id ? resolved.id : null;
  }
  const id = await ctx.sdk.findArtifact(kind, identity);
  if (!id) return null;
  if (creates && ref(id) !== ref(derived) && ctx.reuseNamesakes !== true) {
    return { id, origin: 'foreign', refusal: 'create-identity-conflict' };
  }
  return adoptionOf(managed, kind, key, id, await ctx.sdk.fetchArtifact(kind, id, { overwrite: true }), 'existing');
}

// Plan one declaration: locate, compare, and record either the create, the field changes, unchanged, or
// a refusal. `kindPlan` supplies the per-kind identity, desired state and comparison.
async function planOne(ctx, kindPlan, entry, plan) {
  const { kind } = kindPlan;
  const key = kindPlan.key(entry);
  const target = kindPlan.target(entry);
  let found;
  const refuse = (code, id, detail) => {
    const op = operation(kind, key, target, 'refuse', { ...(id ? { id } : {}), code, ...(found ? { origin: found.origin } : {}), ...(detail ? { reason: detail } : {}) });
    plan.operations.push(op);
    return null;
  };
  try {
    found = await locate(ctx, kind, key, kindPlan.identity(entry));
  } catch (error) {
    const code = portCode(error);
    if (code && !UNKNOWN_PORT_CODES.has(code)) return refuse(code);
    // The id the stop names, and the safe handle a maker inspects it by (the same shape a lost create reports).
    const id = code ? stoppedId(error) : null;
    const line = { kind, key, code: code || codeOf(error), ...(id ? { id } : {}) };
    if (id) Object.defineProperty(line, 'handle', { value: identityHandle(kind, key, kindPlan.identity(entry), { id }), enumerable: false });
    plan.unknown.push(line);
    return null;
  }
  if (!found) {
    const missing = kindPlan.requirement && kindPlan.requirement(entry, null);
    if (missing) return refuse(missing);
    const op = operation(kind, key, target, 'create', { origin: 'created' });
    op.detail = { entry, identity: kindPlan.identity(entry), childKeys: kindPlan.childKeys ? kindPlan.childKeys(entry) : [] };
    if (kindPlan.bound) op.detail.bound = kindPlan.bound(entry, null);
    plan.operations.push(op);
    return op;
  }
  // A namesake at another id: the row is not this identity's. The id is kept for the maker to inspect.
  if (found.refusal === 'create-identity-conflict') return refuse(found.refusal, found.id, 'CONFIGURATION_IDENTITY_FOREIGN');
  if (found.refusal) return refuse(found.refusal, found.id);
  const compared = kindPlan.compare(entry, found.remote, ctx, found.childIds);
  if (compared.refusal) return refuse(compared.refusal, found.id);
  const missing = kindPlan.requirement && kindPlan.requirement(entry, found.remote);
  // A clear the maker asked for, with its exact token, is applied: the requirement is then a readiness result of
  // the row read back (ENVIRONMENT_VARIABLE_VALUE_MISSING stops the build), not a reason to keep the old value.
  if (missing && !(kindPlan.consentedClear && kindPlan.consentedClear(entry, compared, ctx))) return refuse(missing, found.id);
  // An exact port still owes a write for this item (an unsent pending edit) that the comparison does not see: success
  // here would leave that attempt pending behind a clean result, so the item stops, typed, before anything is sent.
  if (found.owed && !compared.changes.length) return refuse(found.owed.code, found.id);
  const action = compared.changes.length ? 'update' : 'unchanged';
  const op = operation(kind, key, target, action, {
    id: found.id,
    origin: found.origin,
    fields: compared.changes.map((change) => change.pointer),
    destructive: compared.destructive === true,
    ...(compared.authorize && compared.authorize.length ? { authorize: compared.authorize } : {}),
  });
  op.detail = { entry, identity: kindPlan.identity(entry), remote: found.remote, childIds: found.childIds, changes: compared.changes, singleWrite: compared.singleWrite === true, unrecorded: found.unrecorded === true, ...(found.owed ? { owed: found.owed } : {}) };
  if (kindPlan.bound) op.detail.bound = kindPlan.bound(entry, found.remote);
  plan.operations.push(op);
  return op;
}

// ---------------------------------------------------------------------------------------------
// Environment variables

function topologicalVariables(list) {
  const byName = new Map(list.map((e) => [lower(e.schemaName), e]));
  const ordered = [];
  const done = new Set();
  const visit = (entry, depth) => {
    const key = lower(entry.schemaName);
    if (done.has(key) || depth > list.length) return;
    const parent = entry.type === 'dataSource' && typeof entry.parentSchemaName === 'string' ? byName.get(lower(entry.parentSchemaName)) : null;
    if (parent) visit(parent, depth + 1);
    done.add(key);
    ordered.push(entry);
  };
  for (const entry of list) visit(entry, 0);
  return ordered;
}

const DEFINITION_POINTERS = ['/name', '/description', '/defaultValue', '/isRequired', '/valueSchema', '/connectorId', '/parameterKey', '/parentId'];

// The exact authorization token for one destructive change (see configurationAuthorizationKeys). The root key is
// the port key: lower-cased names, a duplicate rule's own key byte for byte.
const tokenOf = (kind, key, ...rest) => [kind, portKeyOf(kind, key), ...rest].join(':');

// A child a change adds to an existing root. Its port key is `<root port key>|<slot>` and its slot is the same
// string a create of the root uses for it (childKeys), so a child gets the same identity whichever way it is made.
function laterChild(rootKind, rootKey, slot, kind, index) {
  const parentKey = portKeyOf(rootKind, rootKey);
  return { slot, kind, key: `${parentKey}|${slot}`, identity: { parentKind: rootKind, parentKey, slot }, ...(index === undefined ? {} : { index }) };
}

// What a NEW definition is created with: the creation defaults. An update never uses this (an omitted field of an
// existing row is not managed); it overlays only what the App Spec authors (variablePlan.compare).
function desiredVariable(entry) {
  return {
    name: entry.name == null ? entry.schemaName : entry.name,
    description: entry.description == null ? null : entry.description,
    defaultValue: entry.defaultValue == null ? null : entry.defaultValue,
    isRequired: entry.isRequired === true,
    valueSchema: entry.type === 'json' && entry.valueSchema != null ? entry.valueSchema : null,
    connectorId: entry.type === 'dataSource' && entry.connectorId != null ? entry.connectorId : null,
    parameterKey: entry.type === 'dataSource' && entry.parameterKey != null ? entry.parameterKey : null,
  };
}

function variablePlan(bindings, parents) {
  const bindingOf = (entry) => bindings.environmentVariables.get(lower(entry.schemaName));
  return {
    kind: 'environmentVariable',
    key: (e) => e.schemaName,
    target: (e) => ({ schemaName: e.schemaName }),
    identity: (e) => ({ uniqueName: e.schemaName }),
    // A value row id is reserved only when a value is written with the definition.
    childKeys: (e) => {
      const binding = bindingOf(e);
      return binding && binding.value !== null ? ['value'] : [];
    },
    // A required variable needs a value from somewhere: the deployment settings, the row already in the
    // environment, or the definition's default. Without one, every page that reads it fails at run time,
    // so it is refused here, before its first write, and the build's readiness gate sees the refusal.
    // Each input is the App Spec's when it authors it, else the environment's (an omitted field is not
    // managed). Called by the planner only: verify reports the same gap as its 'value' check.
    requirement(entry, remote) {
      const required = has(entry, 'isRequired') ? entry.isRequired === true : !!(remote && remote.isRequired === true);
      if (!required) return null;
      const fallback = has(entry, 'defaultValue') ? entry.defaultValue : remote ? remote.defaultValue : null;
      if (fallback != null && fallback !== '') return null;
      const binding = bindingOf(entry);
      const value = binding ? binding.value : remote && remote.currentValue ? remote.currentValue.value : null;
      return value != null && value !== '' ? null : 'ENVIRONMENT_VARIABLE_VALUE_MISSING';
    },
    // The change deletes the value that is there (a settings Value of null) and the maker passed that delete's own
    // token. Only an existing row's value can be cleared: a first create without a value is still refused.
    consentedClear(entry, compared, ctx) {
      const clears = compared.changes.some((c) => c.pointer === '/currentValue' && c.value === null);
      const granted = ctx && ctx.authorizedDestructive;
      return clears && granted instanceof Set && granted.has(tokenOf('environmentVariableValue', entry.schemaName, 'value'));
    },
    compare(entry, remote) {
      // Dataverse refuses a type change on an existing definition; refusing here keeps the run from
      // writing the other fields first.
      if (remote.type !== entry.type) return { refusal: 'ENVIRONMENT_VARIABLE_TYPE_IMMUTABLE' };
      const changes = [];
      const authorize = [];
      const need = (field) => authorize.push(tokenOf('environmentVariable', entry.schemaName, field));
      // Overlay: only what the App Spec authors is compared, an omitted field is not managed (it never clears a
      // default or turns a flag off). An explicit null clears, and clearing or replacing what is there is a
      // destructive change that needs its own authorization; setting what is empty is not.
      if (entry.name != null && !same(remote.name, entry.name)) changes.push({ pointer: '/name', value: entry.name });
      for (const field of ['description', 'defaultValue', 'valueSchema']) {
        if (!has(entry, field) || entry[field] === undefined) continue;
        const value = entry[field];
        if (same(remote[field] === undefined ? null : remote[field], value)) continue;
        changes.push({ pointer: `/${field}`, value });
        if (value === null) need(field);
      }
      if (has(entry, 'isRequired') && (remote.isRequired === true) !== (entry.isRequired === true)) {
        changes.push({ pointer: '/isRequired', value: entry.isRequired === true });
        if (remote.isRequired === true) need('isRequired');
      }
      for (const field of ['connectorId', 'parameterKey']) {
        if (!has(entry, field) || entry[field] === undefined) continue;
        const value = entry[field];
        if (same(remote[field] === undefined ? null : remote[field], value)) continue;
        changes.push({ pointer: `/${field}`, value });
        if (remote[field] != null) need(field);
      }
      if (has(entry, 'parentSchemaName')) {
        const parentKey = entry.type === 'dataSource' && typeof entry.parentSchemaName === 'string' ? lower(entry.parentSchemaName) : null;
        const parent = parentKey ? parents.get(parentKey) : null;
        let moved = false;
        if (parentKey && (!parent || parent.pending || ref(remote.parentId) !== ref(parent.id))) { changes.push({ pointer: '/parentId', parentKey }); moved = true; }
        if (!parentKey && remote.parentId) { changes.push({ pointer: '/parentId', value: null }); moved = true; }
        if (moved && remote.parentId) need('parentSchemaName');
      }
      const binding = bindingOf(entry);
      if (binding) {
        const existing = remote.currentValue && remote.currentValue.id ? remote.currentValue : null;
        const current = remote.currentValue ? remote.currentValue.value : null;
        if (!same(current, binding.value)) {
          // Keep the existing value row's id so the SDK PATCHes that row instead of adding a second one.
          // A new row is created through the port, which gives it its id (applyUpdate).
          const value = binding.value === null ? null : { ...(existing ? { id: existing.id } : {}), value: binding.value };
          const created = value && !existing ? [laterChild('environmentVariable', entry.schemaName, 'value', 'environmentVariableValue')] : undefined;
          changes.push({ pointer: '/currentValue', value, binding: true, ...(created ? { created } : {}) });
          // Replacing a value that is there, or deleting it (null), needs authorization; giving an empty one a value does not.
          if (current != null) authorize.push(tokenOf('environmentVariableValue', entry.schemaName, 'value'));
        }
      }
      // The definition fields go out in one PATCH and the value in its own request (without the solution
      // header: a value is per-environment data, not a solution component). Both together are two writes.
      const definition = changes.some((c) => DEFINITION_POINTERS.includes(c.pointer));
      const value = changes.some((c) => c.pointer === '/currentValue');
      return { changes, singleWrite: !(definition && value), authorize, destructive: authorize.length > 0 };
    },
  };
}

function newPlan(plan) {
  return plan || { operations: [], unknown: [] };
}

function bindingsOf(ctx) {
  return ctx.bindings || { environmentVariables: new Map(), connectionReferences: new Map() };
}

async function planEnvironmentVariables(spec, ctx, plan) {
  plan = newPlan(plan);
  planDefaultPort(spec, ctx);
  if (!Array.isArray(spec.environmentVariables) || !spec.environmentVariables.length) return plan;
  const parents = new Map();
  const kindPlan = variablePlan(bindingsOf(ctx), parents);
  for (const entry of topologicalVariables(spec.environmentVariables)) {
    const op = await planOne(ctx, kindPlan, entry, plan);
    if (!op) continue;
    parents.set(lower(entry.schemaName), op.action === 'create' ? { pending: true } : { id: op.id });
    if (op.action === 'create' && entry.type === 'dataSource' && typeof entry.parentSchemaName === 'string') {
      op.detail.parentKey = lower(entry.parentSchemaName);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Connection references

function referencePlan(bindings) {
  return {
    kind: 'connectionReference',
    key: (e) => e.logicalName,
    target: (e) => ({ logicalName: e.logicalName, connectorId: e.connectorId }),
    identity: (e) => ({ uniqueName: e.logicalName }),
    // The binding this build ASKS for (the settings decide when they name the reference, else the row's own).
    // This is a plan-time wish, never readiness: readiness is read from the row (observeConfiguration).
    bound(entry, remote) {
      const binding = bindings.connectionReferences.get(lower(entry.logicalName));
      if (binding) return binding.connectionId != null;
      return !!(remote && remote.connectionId);
    },
    compare(entry, remote) {
      // A reference's connector cannot change, and a reference of the wrong connector would only fail
      // when a page calls it, so the mismatch is refused before anything is written (membership included).
      if (ref(remote.connectorId) !== ref(entry.connectorId)) return { refusal: 'CONNECTION_REFERENCE_CONNECTOR_MISMATCH' };
      const changes = [];
      const authorize = [];
      const need = (field) => authorize.push(tokenOf('connectionReference', entry.logicalName, field));
      if (entry.name != null && !same(remote.name, entry.name)) changes.push({ pointer: '/name', value: entry.name });
      if (has(entry, 'description') && !same(remote.description === undefined ? null : remote.description, entry.description)) {
        changes.push({ pointer: '/description', value: entry.description });
        if (entry.description === null) need('description');
      }
      if (has(entry, 'customConnectorId') && ref(remote.customConnectorId) !== ref(entry.customConnectorId)) {
        changes.push({ pointer: '/customConnectorId', value: entry.customConnectorId });
        if (remote.customConnectorId != null) need('customConnectorId');
      }
      const binding = bindings.connectionReferences.get(lower(entry.logicalName));
      if (binding && !same(remote.connectionId == null ? null : remote.connectionId, binding.connectionId)) {
        changes.push({ pointer: '/connectionId', value: binding.connectionId, binding: true });
        // Binding an unbound reference is not destructive; rebinding or unbinding one is.
        if (remote.connectionId != null) need('connectionId');
      }
      return { changes, singleWrite: true, authorize, destructive: authorize.length > 0 };
    },
  };
}

async function planConnectionReferences(spec, ctx, plan) {
  plan = newPlan(plan);
  planDefaultPort(spec, ctx);
  if (!Array.isArray(spec.connectionReferences)) return plan;
  const kindPlan = referencePlan(bindingsOf(ctx));
  for (const entry of spec.connectionReferences) await planOne(ctx, kindPlan, entry, plan);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Custom API definitions

function authoredChild(child, isRequest) {
  const out = { uniqueName: child.uniqueName, type: child.type };
  if (isRequest) out.isOptional = child.isOptional === true;
  if (child.entityLogicalName != null) out.entityLogicalName = child.entityLogicalName;
  for (const field of LABEL_FIELDS) if (child[field] != null) out[field] = child[field];
  return out;
}

// Children are matched by unique name within their direction, so an edit keeps the row's id. A child's
// type, optionality and table are fixed once created; changing one would need a delete and re-create,
// which is not an edit, so it is refused. Optionality and table are compared only when the App Spec
// authors them. A matched child starts from the row and takes only the labels the App Spec authors (an
// explicit null clears one, which needs authorization). A child the row has and the list does not is
// removed: each removal needs its own authorization token (customApi:<api>:request:<child>). A new child
// is created through the create port in the same slot a create of the API would give it.
function compareChildren(declared, remoteList, isRequest, apiName) {
  const childKind = isRequest ? 'customApiRequestParameter' : 'customApiResponseProperty';
  const slotOf = (name) => `${isRequest ? 'request' : 'response'}:${lower(name)}`;
  const remoteByName = new Map((remoteList || []).map((c) => [lower(c.uniqueName), c]));
  let changed = false;
  const merged = [];
  const created = [];
  const authorize = [];
  for (const child of declared || []) {
    const remote = remoteByName.get(lower(child.uniqueName));
    if (!remote) {
      changed = true;
      created.push(laterChild('customApi', apiName, slotOf(child.uniqueName), childKind, merged.length));
      merged.push(authoredChild(child, isRequest));
      continue;
    }
    remoteByName.delete(lower(child.uniqueName));
    if (remote.type !== child.type
      || (isRequest && has(child, 'isOptional') && (remote.isOptional === true) !== (child.isOptional === true))
      || (has(child, 'entityLogicalName') && ref(remote.entityLogicalName) !== ref(child.entityLogicalName))) {
      return { refusal: 'CUSTOM_API_PARAMETER_IMMUTABLE' };
    }
    const next = { ...remote };
    for (const field of LABEL_FIELDS) {
      if (!has(child, field) || child[field] === undefined) continue;
      if (same(remote[field] === undefined ? null : remote[field], child[field])) continue;
      next[field] = child[field];
      changed = true;
      if (child[field] === null) authorize.push(tokenOf('customApi', apiName, slotOf(child.uniqueName)));
    }
    merged.push(next);
  }
  const removed = [...remoteByName.values()].map((c) => ({ uniqueName: c.uniqueName, ...(c.id ? { id: c.id } : {}) }));
  for (const child of removed) authorize.push(tokenOf('customApi', apiName, slotOf(child.uniqueName)));
  return { changed: changed || removed.length > 0, merged, removed, created, authorize: [...new Set(authorize)] };
}

// The contract fields a create fills with defaults. An update compares only the authored ones.
function apiImmutables(entry) {
  return {
    binding: entry.binding || 'global',
    boundEntityLogicalName: entry.boundEntityLogicalName == null ? null : lower(entry.boundEntityLogicalName),
    isFunction: entry.isFunction === true,
    allowedProcessingSteps: entry.allowedProcessingSteps || 'none',
    enabledForWorkflow: entry.enabledForWorkflow === true,
  };
}

// The effective contract once the App Spec is laid over the row (or over the creation defaults when there is
// no row): a bound API needs its table, a global one has none, and a function must return something.
function apiContractProblem(entry, remote) {
  const pick = (field, fallback) => (has(entry, field) && entry[field] !== undefined ? entry[field] : remote ? remote[field] : fallback);
  const binding = pick('binding', 'global') || 'global';
  const table = pick('boundEntityLogicalName', null);
  if (binding !== 'global' && !nonEmptyString(table)) return 'CUSTOM_API_BINDING_INVALID';
  if (binding === 'global' && table != null) return 'CUSTOM_API_BINDING_INVALID';
  const responses = has(entry, 'responseProperties') ? entry.responseProperties : remote ? remote.responseProperties : [];
  if (pick('isFunction', false) === true && !(Array.isArray(responses) && responses.length)) return 'CUSTOM_API_FUNCTION_NEEDS_RESPONSE';
  return null;
}

const customApiPlan = {
  kind: 'customApi',
  key: (e) => e.uniqueName,
  target: (e) => ({ uniqueName: e.uniqueName }),
  identity: (e) => ({ uniqueName: e.uniqueName }),
  childKeys: (e) => [
    ...(e.requestParameters || []).map((c) => `request:${lower(c.uniqueName)}`),
    ...(e.responseProperties || []).map((c) => `response:${lower(c.uniqueName)}`),
  ],
  requirement: (entry, remote) => apiContractProblem(entry, remote),
  compare(entry, remote) {
    // Only authored contract fields are compared: an omitted one is not managed (a create still fills
    // its default). Authorization never overrides an immutable field.
    const immutable = apiImmutables(entry);
    for (const [field, value] of Object.entries(immutable)) {
      if (!has(entry, field) || entry[field] === undefined) continue;
      const current = field === 'boundEntityLogicalName' ? ref(remote[field]) : remote[field];
      if (!same(current, value)) return { refusal: 'CUSTOM_API_IMMUTABLE' };
    }
    const changes = [];
    const authorize = [];
    const need = (field) => authorize.push(tokenOf('customApi', entry.uniqueName, field));
    if (has(entry, 'isPrivate') && (remote.isPrivate === true) !== (entry.isPrivate === true)) {
      changes.push({ pointer: '/isPrivate', value: entry.isPrivate === true });
      need('isPrivate');
    }
    if (has(entry, 'executePrivilegeName') && entry.executePrivilegeName !== undefined) {
      const current = remote.executePrivilegeName == null ? null : remote.executePrivilegeName;
      if (!same(current, entry.executePrivilegeName)) {
        changes.push({ pointer: '/executePrivilegeName', value: entry.executePrivilegeName });
        if (current !== null) need('executePrivilegeName');
      }
    }
    // Labels are compared only when the App Spec authors them: the SDK fills unauthored labels from
    // the unique name, and a label edit is refused when several languages are provisioned, so an
    // unauthored label must never turn into a write.
    for (const field of LABEL_FIELDS) {
      if (entry[field] != null && !same(remote[field] === undefined ? null : remote[field], entry[field])) changes.push({ pointer: `/${field}`, value: entry[field] });
    }
    // An omitted child list is not managed: its children are neither added nor removed. An explicit list is
    // exact: each child it no longer names is removed, one authorization token per child.
    for (const [field, isRequest] of [['requestParameters', true], ['responseProperties', false]]) {
      if (!has(entry, field) || !Array.isArray(entry[field])) continue;
      const result = compareChildren(entry[field], remote[field], isRequest, entry.uniqueName);
      if (result.refusal) return result;
      authorize.push(...result.authorize);
      if (result.changed) changes.push({ pointer: `/${field}`, value: result.merged, removed: result.removed, ...(result.created.length ? { created: result.created } : {}) });
    }
    const singleWrite = !changes.some((c) => c.pointer === '/requestParameters' || c.pointer === '/responseProperties');
    return { changes, singleWrite, authorize, destructive: authorize.length > 0 };
  },
};

async function planCustomApis(spec, ctx, plan) {
  plan = newPlan(plan);
  planDefaultPort(spec, ctx);
  if (!Array.isArray(spec.customApis)) return plan;
  for (const entry of spec.customApis) {
    const op = await planOne(ctx, customApiPlan, entry, plan);
    // Dataverse lets a definition exist with no implementation, and calling it then returns default
    // values rather than failing. So a definition is never proof the action works; the plan says so.
    if (op) op.preconditions.push({ kind: 'customApiImplementation', verified: !!(op.detail.remote && op.detail.remote.pluginTypeId) });
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Duplicate-detection rules

const counted = (match) => match === 'firstCharacters' || match === 'lastCharacters';

// The comparable form of a condition that is COMPLETE (a remote row, or a declared one laid over a row or over
// the creation defaults). Never called on bare intent: an omitted optional field would read as its default.
function normalCondition(c) {
  return {
    column: lower(c.column),
    matchingColumn: lower(c.matchingColumn || c.column),
    match: c.match,
    characters: counted(c.match) && c.characters != null ? c.characters : null,
    ignoreBlankValues: c.ignoreBlankValues === true,
  };
}

// A declared condition laid over the row it is paired with: what the App Spec authors wins, everything it omits
// (matchingColumn, characters, ignoreBlankValues) stays as the row has it. Without a row, the creation defaults.
function overlayCondition(declared, remote) {
  const pick = (field, fallback) => (has(declared, field) && declared[field] !== undefined ? declared[field] : remote ? remote[field] : fallback);
  return {
    column: declared.column,
    matchingColumn: pick('matchingColumn', declared.column),
    match: declared.match,
    characters: pick('characters', null),
    ignoreBlankValues: pick('ignoreBlankValues', false) === true,
  };
}

function sdkCondition(c, id) {
  const out = { ...(id ? { id } : {}), column: c.column, match: c.match };
  if (c.matchingColumn != null) out.matchingColumn = c.matchingColumn;
  if (counted(c.match)) out.characters = c.characters;
  out.ignoreBlankValues = c.ignoreBlankValues === true;
  return out;
}

// Does a declared condition describe this row? Its required fields (column, match) and every optional field it
// AUTHORS must agree; an omitted optional field matches anything.
function describes(declared, remote) {
  const r = normalCondition(remote);
  if (r.column !== lower(declared.column) || r.match !== declared.match) return false;
  if (has(declared, 'matchingColumn') && r.matchingColumn !== lower(declared.matchingColumn)) return false;
  if (has(declared, 'ignoreBlankValues') && r.ignoreBlankValues !== (declared.ignoreBlankValues === true)) return false;
  if (has(declared, 'characters') && counted(declared.match) && r.characters !== declared.characters) return false;
  return true;
}

// Pair each declared condition with a row so an edit keeps the row's id, then overlay, then compare.
// 1. a managed id (the build recorded which row a key created) pairs first;
// 2. otherwise only an unambiguous one-to-one match pairs: exactly one row the declaration describes, and that
//    row described by no other unpaired declaration. Two candidates either way is CONFIGURATION_CHILD_IDENTITY_AMBIGUOUS:
//    a guess would rewrite the wrong criterion.
// A declared condition with no row is added (through the create port, in the slot a create of the rule gives it:
// its key, byte for byte). A row no declaration pairs with is removed. A changed criterion and each removal need
// their own token, duplicateRule:<key>:condition:<condition key> (for a removed row nobody keyed, its id).
function compareConditions(declared, remoteList, childIds, ruleKey) {
  const remaining = (remoteList || []).map((c) => ({ c }));
  const pairs = declared.map(() => null);
  const take = (row) => remaining.splice(remaining.indexOf(row), 1)[0];
  declared.forEach((d, i) => {
    const pinned = childIds && childIds[d.key];
    const row = pinned ? remaining.find((r) => ref(r.c.id) === ref(pinned)) : null;
    if (row) pairs[i] = take(row);
  });
  const unpaired = () => declared.map((d, i) => (pairs[i] ? null : d)).filter(Boolean);
  for (let i = 0; i < declared.length; i++) {
    if (pairs[i]) continue;
    const d = declared[i];
    const rows = remaining.filter((r) => describes(d, r.c));
    if (!rows.length) continue;
    const rivals = rows.length === 1 ? unpaired().filter((o) => o !== d && describes(o, rows[0].c)) : [];
    if (rows.length > 1 || rivals.length) return { refusal: 'CONFIGURATION_CHILD_IDENTITY_AMBIGUOUS' };
    pairs[i] = take(rows[0]);
  }
  const token = (conditionKey) => tokenOf('duplicateRule', ruleKey, 'condition', conditionKey);
  const keyOfRow = (row) => {
    const pinned = childIds ? Object.entries(childIds).find(([, id]) => ref(id) === ref(row.id)) : null;
    return pinned ? pinned[0] : lower(row.id || '');
  };
  const created = [];
  const authorize = [];
  const merged = declared.map((d, i) => {
    const remote = pairs[i] && pairs[i].c;
    const next = overlayCondition(d, remote);
    if (!remote) {
      created.push(laterChild('duplicateRule', ruleKey, d.key, 'duplicateRuleCondition', i));
      return sdkCondition(next, null);
    }
    if (!same(normalCondition(next), normalCondition(remote))) authorize.push(token(d.key));
    return sdkCondition(next, remote.id);
  });
  const removed = remaining.map((r) => ({ key: keyOfRow(r.c), ...(r.c.id ? { id: r.c.id } : {}) }));
  for (const row of removed) authorize.push(token(row.key));
  const changed = created.length > 0 || removed.length > 0 || authorize.length > 0;
  return { changed, merged, created, removed, authorize };
}

// The status a rule is meant to have. A NEW rule is published unless the App Spec says otherwise. An EXISTING
// rule keeps the status it has when the App Spec omits it: an omission never publishes an unpublished rule (nor
// retries a publication nobody asked for), and never unpublishes one.
const ruleStatus = (entry, remote) => (entry.status !== undefined ? entry.status : remote ? remote.status : 'published');

const duplicateRulePlan = {
  kind: 'duplicateRule',
  key: (e) => e.key,
  target: (e) => ({ name: e.name, entity: lower(e.entity) }),
  identity: (e) => ({ name: e.name }),
  childKeys: (e) => (e.conditions || []).map((c) => c.key),
  // A rule that will be published must have criteria to publish; an empty rule can only be unpublished.
  requirement(entry, remote) {
    const conditions = Array.isArray(entry.conditions) ? entry.conditions : remote ? remote.conditions : [];
    if (ruleStatus(entry, remote) === 'published' && !(Array.isArray(conditions) && conditions.length)) return 'DUPLICATE_RULE_CONDITIONS_REQUIRED';
    return null;
  },
  compare(entry, remote, ctx, childIds) {
    // The name found a rule on a different table: that is somebody else's rule, not this one renamed.
    if (ref(remote.entityLogicalName) !== lower(entry.entity)) return { refusal: 'DUPLICATE_RULE_NAME_CONFLICT' };
    if (has(entry, 'matchingEntity') && ref(remote.matchingEntityLogicalName || remote.entityLogicalName) !== lower(entry.matchingEntity)) {
      return { refusal: 'DUPLICATE_RULE_TABLE_IMMUTABLE' };
    }
    const changes = [];
    const authorize = [];
    const need = (field) => authorize.push(tokenOf('duplicateRule', entry.key, field));
    // A rule found at its own id under another name is renamed, which needs authorization.
    if (nonEmptyString(entry.name) && remote.name !== entry.name) { changes.push({ pointer: '/name', value: entry.name }); need('name'); }
    if (has(entry, 'description') && entry.description !== undefined && !same(remote.description === undefined ? null : remote.description, entry.description)) {
      changes.push({ pointer: '/description', value: entry.description });
      if (entry.description === null) need('description');
    }
    // A matching flag changes which records count as duplicates, either way: each change needs authorization.
    for (const field of ['caseSensitive', 'excludeInactiveRecords']) {
      if (!has(entry, field) || entry[field] === undefined) continue;
      if ((remote[field] === true) !== (entry[field] === true)) { changes.push({ pointer: `/${field}`, value: entry[field] === true }); need(field); }
    }
    if (Array.isArray(entry.conditions)) {
      const conditions = compareConditions(entry.conditions, remote.conditions, childIds, entry.key);
      if (conditions.refusal) return conditions;
      authorize.push(...conditions.authorize);
      if (conditions.changed) changes.push({ pointer: '/conditions', value: conditions.merged, removed: conditions.removed, ...(conditions.created.length ? { created: conditions.created } : {}) });
    }
    if (entry.status !== undefined && remote.status !== entry.status) {
      changes.push({ pointer: '/status', value: entry.status });
      if (remote.status === 'published') need('status');
    }
    return { changes, singleWrite: false, authorize, destructive: authorize.length > 0 };
  },
};

// Read the table's duplicate-detection switch. `fetchEntityMetadata` does not carry it, so this reads
// EntityDefinitions directly; the answer is a managed property:
//   { "IsDuplicateDetectionEnabled": { "Value": true, "CanBeChanged": true, ... } }
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/entitymetadata
async function tableDetectionEnabled(sdk, table) {
  const { odataLit } = require('./odata.js');
  const answer = await sdk.dataverse.get(`/EntityDefinitions(LogicalName='${odataLit(table)}')?$select=IsDuplicateDetectionEnabled`);
  const flag = answer && answer.body && answer.body.IsDuplicateDetectionEnabled;
  if (!flag || typeof flag.Value !== 'boolean') {
    const error = new Error('duplicate detection setting unreadable');
    error.code = 'DUPLICATE_DETECTION_UNREADABLE';
    throw error;
  }
  return flag.Value;
}

// Published rules on a table right now (statecode 1 = Active, which is how a published rule reads).
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/duplicaterule#statecode-choicesoptions
async function publishedRuleIds(sdk, table) {
  const { odataLit } = require('./odata.js');
  const filter = encodeURIComponent(`baseentityname eq '${odataLit(table)}' and statecode eq 1`);
  const answer = await sdk.dataverse.get(`/duplicaterules?$select=duplicateruleid&$filter=${filter}`);
  const rows = answer && answer.body && Array.isArray(answer.body.value) ? answer.body.value : null;
  if (!rows) {
    const error = new Error('published duplicate rules unreadable');
    error.code = 'DUPLICATE_RULE_COUNT_UNREADABLE';
    throw error;
  }
  return new Set(rows.map((row) => lower(row.duplicateruleid)));
}

function refuseOp(op, code) {
  op.action = 'refuse';
  op.code = code;
  op.fields = undefined;
}

async function planDuplicateRules(spec, ctx, plan) {
  plan = newPlan(plan);
  planDefaultPort(spec, ctx);
  if (!Array.isArray(spec.duplicateDetectionRules)) return plan;
  const ops = [];
  for (const entry of spec.duplicateDetectionRules) {
    const op = await planOne(ctx, duplicateRulePlan, entry, plan);
    if (op) ops.push(op);
  }
  // Only a write that leaves a rule published needs the table switch on and a free publication slot.
  // An unchanged rule costs no reads at all.
  const effective = (op) => ruleStatus(op.detail.entry, op.detail.remote);
  const publishing = ops.filter((op) => (op.action === 'create' || op.action === 'update') && effective(op) === 'published');
  const tables = [...new Set(publishing.map((op) => lower(op.detail.entry.entity)))];
  for (const table of tables) {
    const tableOps = publishing.filter((op) => lower(op.detail.entry.entity) === table);
    let enabled;
    let published;
    try {
      enabled = await tableDetectionEnabled(ctx.sdk, table);
      published = await publishedRuleIds(ctx.sdk, table);
    } catch (error) {
      for (const op of tableOps) {
        plan.operations.splice(plan.operations.indexOf(op), 1);
        plan.unknown.push({ kind: op.kind, key: op.key, code: codeOf(error) });
      }
      continue;
    }
    if (!enabled) {
      // The build never turns the switch on because a rule was declared: switching it off later
      // unpublishes every rule on the table, so it is the maker's explicit decision
      // (entities[].duplicateDetectionEnabled: true), applied earlier in the data-model phase.
      for (const op of tableOps) {
        if (specTableFlag(spec, table) === true) op.preconditions.push({ kind: 'tableDuplicateDetection', table });
        else refuseOp(op, 'DUPLICATE_DETECTION_DISABLED');
      }
    }
    const ours = new Set(ops.filter((op) => op.id && lower(op.detail.entry.entity) === table).map((op) => lower(op.id)));
    const declared = ops.filter((op) => op.action !== 'refuse' && lower(op.detail.entry.entity) === table && effective(op) === 'published').length;
    const others = [...published].filter((id) => !ours.has(id)).length;
    if (others + declared > MAX_PUBLISHED_RULES_PER_TABLE) {
      for (const op of tableOps) {
        const alreadyPublished = op.id && published.has(lower(op.id));
        if (!alreadyPublished && op.action !== 'refuse') refuseOp(op, 'DUPLICATE_RULE_LIMIT');
      }
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Solution version

// `getSolution` answers a solution that does not exist with INVALID_ARGUMENT ("No solution found for
// '<name>'") rather than null; that is a refusal, not an unknown outcome, so it reads as null here.
async function readSolution(sdk, key) {
  try {
    return await sdk.getSolution(key);
  } catch (error) {
    if (codeOf(error) === 'INVALID_ARGUMENT') return null;
    throw error;
  }
}

async function planSolutionVersion(spec, ctx, plan) {
  plan = newPlan(plan);
  const solution = isObject(spec.solution) ? spec.solution : {};
  if (solution.version === undefined) return plan;
  const key = solution.uniqueName;
  const target = { uniqueName: key };
  let current;
  try {
    current = await readSolution(ctx.sdk, key);
  } catch (error) {
    plan.unknown.push({ kind: 'solutionVersion', key, code: codeOf(error) });
    return plan;
  }
  if (!current) { plan.operations.push(operation('solutionVersion', key, target, 'refuse', { code: 'SOLUTION_NOT_FOUND' })); return plan; }
  // A managed solution's version comes from the package that installed it.
  if (current.isManaged) { plan.operations.push(operation('solutionVersion', key, target, 'refuse', { id: current.solutionId, code: 'SOLUTION_MANAGED' })); return plan; }
  const op = operation('solutionVersion', key, target, current.version === solution.version ? 'unchanged' : 'update', {
    id: current.solutionId,
    fields: current.version === solution.version ? [] : ['/version'],
  });
  op.detail = { version: solution.version, singleWrite: true };
  plan.operations.push(op);
  return plan;
}

// The data-model phase's configuration work, in dependency order: variables (parents first), then
// references, then Custom APIs, then duplicate rules. The solution version is planned separately in
// the solution phase (planSolutionVersion).
async function planConfiguration(spec, ctx) {
  const plan = newPlan();
  if (!usesConfiguration(spec)) return plan;
  await planEnvironmentVariables(spec, ctx, plan);
  await planConnectionReferences(spec, ctx, plan);
  await planCustomApis(spec, ctx, plan);
  await planDuplicateRules(spec, ctx, plan);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Apply

function buildArtifact(op, id, childIds, ctx, parentId) {
  const entry = op.detail.entry;
  const bindings = bindingsOf(ctx);
  switch (op.kind) {
    case 'environmentVariable': {
      const binding = bindings.environmentVariables.get(lower(entry.schemaName));
      return {
        id,
        schemaName: entry.schemaName,
        type: entry.type,
        ...desiredVariable(entry),
        parentId: parentId || null,
        currentValue: binding && binding.value !== null ? { id: childIds.value, value: binding.value } : null,
      };
    }
    case 'connectionReference': {
      const binding = bindings.connectionReferences.get(lower(entry.logicalName));
      return {
        id,
        logicalName: entry.logicalName,
        name: entry.name == null ? entry.logicalName : entry.name,
        description: entry.description == null ? null : entry.description,
        connectorId: entry.connectorId,
        connectionId: binding ? binding.connectionId : null,
        ...(entry.customConnectorId != null ? { customConnectorId: entry.customConnectorId } : {}),
      };
    }
    case 'customApi': {
      const artifact = {
        id,
        uniqueName: entry.uniqueName,
        ...apiImmutables(entry),
        isPrivate: entry.isPrivate === true,
        executePrivilegeName: entry.executePrivilegeName == null ? null : entry.executePrivilegeName,
        requestParameters: (entry.requestParameters || []).map((c) => ({ id: childIds[`request:${lower(c.uniqueName)}`], ...authoredChild(c, true) })),
        responseProperties: (entry.responseProperties || []).map((c) => ({ id: childIds[`response:${lower(c.uniqueName)}`], ...authoredChild(c, false) })),
      };
      for (const field of LABEL_FIELDS) if (entry[field] != null) artifact[field] = entry[field];
      return artifact;
    }
    case 'duplicateRule':
      // The creation defaults apply here and only here: a new rule is published unless the App Spec says
      // otherwise, and an omitted condition field takes its default because there is no row to keep it from.
      return {
        id,
        name: entry.name,
        description: entry.description == null ? null : entry.description,
        entityLogicalName: lower(entry.entity),
        matchingEntityLogicalName: lower(entry.matchingEntity || entry.entity),
        caseSensitive: entry.caseSensitive === true,
        excludeInactiveRecords: entry.excludeInactiveRecords === true,
        status: ruleStatus(entry, null),
        conditions: (entry.conditions || []).map((c) => sdkCondition(overlayCondition(c, null), childIds[c.key])),
      };
    default:
      throw new Error(`unsupported configuration kind ${op.kind}`);
  }
}

// The tokens an operation still lacks. Authority is exactly the Set of normalized tokens the maker passed
// (configurationAuthorizationKeys): no boolean, function or array stands in for it, a parent token never covers
// a child, and an operation that needs authorization but names no token is never authorized.
function missingAuthorization(op, ctx) {
  if (!op.destructive) return [];
  const needed = Array.isArray(op.authorize) ? op.authorize : [];
  const granted = ctx.authorizedDestructive;
  if (!needed.length) return [`${op.kind}:${portKeyOf(op.kind, op.key)}`];
  if (!(granted instanceof Set)) return [...needed];
  return needed.filter((token) => !granted.has(token));
}

async function preconditionsHold(op, ctx, cache) {
  for (const condition of op.preconditions || []) {
    if (condition.kind !== 'tableDuplicateDetection') continue;
    if (!cache.has(condition.table)) {
      let enabled = false;
      try { enabled = await tableDetectionEnabled(ctx.sdk, condition.table); } catch { enabled = false; }
      cache.set(condition.table, enabled);
    }
    if (!cache.get(condition.table)) return 'DUPLICATE_DETECTION_DISABLED';
  }
  return null;
}

const knownKey = (kind, key) => `${kind}:${lower(key)}`;

// A push the SDK answered without throwing can still have failed: it reports `{saved: false, error}`
// (or `errors`). The answer has no HTTP status, so only a code that is decided before any send makes
// it a refusal. ARTIFACT_ALREADY_EXISTS out of a push is the opposite: the row is at this id already,
// because an earlier send of the same create committed (a client that re-sent after a lost answer gets
// 412 and the SDK reads it this way), so it is unknown, never "nothing was written".
function pushFailure(kind, key, pushed, singleWrite) {
  if (!pushed || pushed.saved !== false || pushed.adoptedExisting === true) return null;
  const errors = Array.isArray(pushed.errors) && pushed.errors.length ? pushed.errors : [pushed.error || {}];
  const outcomes = errors.map((e) => (codeOf(e) === 'ARTIFACT_ALREADY_EXISTS' ? 'unknown' : outcomeOf(e, singleWrite)));
  return tagged(kind, key, codeOf(errors[0]), outcomes.every((o) => o === 'nothing') ? 'nothing' : 'unknown');
}

// One result line. `handle` (the identity a maker inspects an unknown outcome by: kind, port key, identity and
// the ids the port gave) rides along non-enumerable, so it never reaches a printed or serialized result.
function pushFinding(result, bucket, fields, handle) {
  const line = {};
  for (const [name, value] of Object.entries(fields)) if (value !== undefined && value !== null) line[name] = value;
  if (handle) Object.defineProperty(line, 'handle', { value: JSON.parse(JSON.stringify(handle)), enumerable: false });
  result[bucket].push(line);
  return line;
}

// The private record of what a fresh read showed (never a value): what the readiness gate decides from. Kept on
// the result non-enumerable, beside the public lines.
// The latest read of each root this run settled (`kind:key` -> {remote, childIds}), kept non-enumerable: the
// membership proof takes a root's children from it.
const ROWS_READ = Symbol('configuration-artifacts.rows-read');
function rowsReadOf(result) {
  if (!Object.prototype.hasOwnProperty.call(result, ROWS_READ)) Object.defineProperty(result, ROWS_READ, { value: new Map(), enumerable: false });
  return result[ROWS_READ];
}

function observationsOf(result) {
  if (!result) return [];
  if (!Object.prototype.hasOwnProperty.call(result, 'observations')) Object.defineProperty(result, 'observations', { value: [], enumerable: false });
  return result.observations;
}

function observe(kind, key, id, entry, remote, source, connections) {
  const out = { kind, key, ...(id ? { id } : {}), source };
  if (!remote) return { ...out, definition: source === 'missing' ? 'missing' : 'unknown' };
  out.definition = 'matched';
  if (kind === 'environmentVariable') {
    const filled = (v) => v != null && v !== '';
    const required = remote.isRequired === true;
    out.requiredValue = !required ? 'notRequired'
      : filled(remote.defaultValue) || (remote.currentValue && filled(remote.currentValue.value)) ? 'present' : 'missing';
  } else if (kind === 'connectionReference') {
    if (remote.connectionId == null || remote.connectionId === '') out.binding = 'unbound';
    else if (!connections) out.binding = 'unknown';
    else if (!connections.has(lower(remote.connectionId))) out.binding = 'unbound';
    else {
      // The connection is there; it binds only when it is a connection of the connector the row and the App Spec
      // name. A connection of another connector is not a usable binding (the call fails when the page makes it),
      // and an inventory row that does not say its connector cannot prove it.
      const held = connections.get(lower(remote.connectionId));
      const wanted = [remote.connectorId, entry && entry.connectorId].filter(nonEmptyString).map(connectorName);
      if (!held || !wanted.length) out.binding = 'unknown';
      else out.binding = wanted.every((w) => w === held) ? 'bound' : 'unbound';
    }
  } else if (kind === 'customApi') {
    // A plug-in type proves an implementation is REGISTERED, not that it works or that a non-admin may call it.
    out.implementation = remote.pluginTypeId ? 'registered' : 'unproven';
  } else if (kind === 'duplicateRule') {
    out.publication = remote.status === 'published' ? 'published' : remote.status === 'unpublished' ? 'unpublished' : 'unknown';
    Object.defineProperty(out, 'publicationRequired', { value: ruleStatus(entry || {}, remote) === 'published', enumerable: false });
  }
  return out;
}

// A connector's name, from either shape an id comes in: '/providers/Microsoft.PowerApps/apis/shared_sql' or
// 'shared_sql' -> 'shared_sql'. Lower-cased: the platform compares connector ids case-insensitively.
function connectorName(value) {
  const text = lower(value).trim();
  const match = text.match(/\/apis\/([^/]+)/);
  return match ? match[1] : text;
}

// The connections a binding can be proven against: a Map of lower-cased connection id -> connector name (null
// when the row does not say), read once per run through `ctx.connections()` (the caller's inventory reader, rows
// as list-connections.js answers them: { connectionId, connectorId, displayName }). Without a reader, or when the
// read fails, a bound reference is not proven (binding 'unknown'): a connection id in a row, or in the settings,
// is a wish.
function connectionInventory(ctx) {
  if (!ctx || typeof ctx.connections !== 'function') return async () => null;
  let pending;
  return () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(() => ctx.connections())
        .then((rows) => {
          if (!Array.isArray(rows)) return null;
          const held = new Map();
          for (const row of rows) {
            const id = lower((row && (row.connectionId || row.id || row.name)) || '');
            if (id) held.set(id, row && nonEmptyString(row.connectorId) ? connectorName(row.connectorId) : null);
          }
          return held;
        }, () => null);
    }
    return pending;
  };
}

// The comparison a read-back uses: the same plan the planner used, with a variable's parent resolved from the
// ids this run knows.
function readBackPlan(kind, ctx, known) {
  const bindings = bindingsOf(ctx);
  if (kind === 'environmentVariable') {
    const parents = { get: (parentKey) => { const id = known.get(knownKey('environmentVariable', parentKey)); return id ? { id } : null; } };
    return variablePlan(bindings, parents);
  }
  if (kind === 'connectionReference') return referencePlan(bindings);
  if (kind === 'customApi') return customApiPlan;
  return duplicateRulePlan;
}

// The App Spec entry without the children a read-back did not find, so what remains can be compared on its own.
function withoutChildren(kind, entry, slots) {
  const gone = new Set(slots);
  if (kind === 'customApi') {
    const keep = (list, direction) => (Array.isArray(list) ? list.filter((c) => !gone.has(`${direction}:${lower(c.uniqueName)}`)) : list);
    return { ...entry, requestParameters: keep(entry.requestParameters, 'request'), responseProperties: keep(entry.responseProperties, 'response') };
  }
  if (kind === 'duplicateRule' && Array.isArray(entry.conditions)) return { ...entry, conditions: entry.conditions.filter((c) => !gone.has(c.key)) };
  return entry;
}

// Read the row back at its exact id (overwriting the workspace copy, which is why unsynced edits are captured
// BEFORE this) and compare what the App Spec authors and the settings ask for. Answers
//   {state: 'unknown'}                                 the read failed: what the write left is not verified
//   {state: 'read', remote, definition: [pointers], value: bool, missing: [slots], status: bool}
// `missing` is every expected child (a parameter, a property, a condition) the row does not have; `definition`
// the authored fields that differ besides them; `value` that the variable's value is not what was asked for;
// `status` that a rule's status differs.
async function readBack(op, ctx, known, id, childIds) {
  let remote;
  try {
    remote = await ctx.sdk.fetchArtifact(op.kind, id, { overwrite: true });
  } catch {
    return { state: 'unknown' };
  }
  if (!remote || typeof remote !== 'object') return { state: 'unknown' };
  const plan = readBackPlan(op.kind, ctx, known);
  const entry = op.detail.entry;
  let compared = plan.compare(entry, remote, ctx, childIds);
  if (compared.refusal) return { state: 'read', remote, definition: ['/'], value: false, missing: [], status: false };
  const value = compared.changes.some((c) => c.pointer === '/currentValue');
  const missing = compared.changes.flatMap((c) => (c.pointer === '/currentValue' ? [] : (c.created || []).map((child) => child.slot)));
  if (missing.length) {
    compared = plan.compare(withoutChildren(op.kind, entry, missing), remote, ctx, childIds);
    if (compared.refusal) return { state: 'read', remote, definition: ['/'], value, missing, status: false };
  }
  const isStatus = (c) => op.kind === 'duplicateRule' && c.pointer === '/status';
  const definition = compared.changes.filter((c) => c.pointer !== '/currentValue' && !isStatus(c)).map((c) => c.pointer);
  return { state: 'read', remote, definition, value, missing, status: compared.changes.some(isStatus) };
}

// The rows a read of a root shows in ONE child slot, never the union of the root's children: a request parameter's
// slot holds only the request parameter of that name, a condition's only the rows its keyed declaration describes,
// a variable's 'value' only its value row.
function slotRows(kind, entry, remote, slot) {
  if (!remote) return [];
  if (kind === 'environmentVariable') return slot === 'value' && remote.currentValue ? [remote.currentValue] : [];
  if (kind === 'customApi') {
    // 'request:<lower unique name>' or 'response:<lower unique name>' (a unique name may itself hold a ':').
    const at = slot.indexOf(':');
    const direction = slot.slice(0, at);
    const name = slot.slice(at + 1);
    const list = direction === 'request' ? remote.requestParameters : direction === 'response' ? remote.responseProperties : null;
    return (list || []).filter((row) => row && lower(row.uniqueName) === name);
  }
  if (kind === 'duplicateRule') {
    const declared = ((entry && entry.conditions) || []).find((c) => isObject(c) && c.key === slot);
    return declared ? (remote.conditions || []).filter((row) => row && describes(declared, row)) : [];
  }
  return [];
}

// The ids of the children a confirmed read shows, by slot: only these are recorded (a child the read does not
// show is not this build's to claim). Each id is checked in its OWN slot (slotRows): an id read under another
// child (two rows that exchanged ids, a row replaced by a namesake) is not confirmed, so a binding can never pair a
// slot with another child's id. The parent is the root the read was made at, so a child read here is under it.
function confirmedChildIds(op, remote, childIds) {
  const out = {};
  if (!remote || !childIds) return out;
  const entry = (op.detail && op.detail.entry) || {};
  for (const [slot, childId] of Object.entries(childIds)) {
    if (childId && slotRows(op.kind, entry, remote, slot).some((row) => ref(row.id) === ref(childId))) out[slot] = childId;
  }
  return out;
}

// Turn a finished write and its read-back into result lines. `units` says what the write carried: whether a
// definition (or root) was written, and whether a value was. `unsettled` is the capture taken before the
// read-back (the value's request did not settle).
function settle(op, ctx, result, { id, back, action, fields, childIds, origin, unsettled, handle, wroteDefinition, publishError }) {
  const { kind, key } = op;
  const observations = observationsOf(result);
  if (back.state === 'unknown') {
    pushFinding(result, 'unknown', { kind, key, id, code: 'CONFIGURATION_READBACK_UNKNOWN' }, handle);
    observations.push(observe(kind, key, id, op.detail.entry, null, 'post-write-read'));
    return false;
  }
  observations.push(observe(kind, key, id, op.detail.entry, back.remote, 'post-write-read', result[INVENTORY]));
  rowsReadOf(result).set(`${kind}:${key}`, { remote: back.remote, childIds: { ...(op.detail.childIds || {}), ...(childIds || {}) } });
  if (back.missing.length) {
    // The root is there and an expected child is not: the create is not complete, and nothing re-sends it here.
    pushFinding(result, 'unknown', { kind, key, id, code: 'create-completion-required', unit: 'content', missing: [...back.missing] }, handle);
    return false;
  }
  if (back.definition.length) {
    pushFinding(result, 'unknown', { kind, key, id, code: 'CONFIGURATION_READBACK_MISMATCH', fields: [...back.definition] }, handle);
    return false;
  }
  const confirmed = confirmedChildIds(op, back.remote, childIds);
  // Content can match a child by its name while the child this run created, at the id it was given, is gone (a row
  // replaced between the write and the read). Every child created now must be read at its own id; one that is not
  // leaves the create incomplete. The root and the children that are confirmed stay this build's.
  const unconfirmed = Object.keys(childIds || {}).filter((slot) => childIds[slot] && !confirmed[slot] && !(slot === 'value' && (unsettled || back.value)));
  if (unconfirmed.length) {
    pushFinding(result, 'unknown', { kind, key, id, code: 'create-completion-required', unit: 'content', missing: unconfirmed }, handle);
    if (origin) result.managedBindings.push({ kind, key, id, ...(Object.keys(confirmed).length ? { childIds: confirmed } : {}), origin });
    return false;
  }
  if (unsettled || back.value) {
    // The definition is proven and the value is not: two lines, never one whole-variable saved.
    if (wroteDefinition) pushFinding(result, 'saved', { kind, key, id, action, unit: 'definition', fields: fields && fields.filter((f) => f !== '/currentValue') });
    pushFinding(result, 'unknown', { kind, key, id, code: unsettled ? 'ENVIRONMENT_VARIABLE_VALUE_UNSETTLED' : 'CONFIGURATION_READBACK_MISMATCH', unit: 'value' }, handle);
    delete confirmed.value;
    if (origin) result.managedBindings.push({ kind, key, id, ...(Object.keys(confirmed).length ? { childIds: confirmed } : {}), origin });
    return false;
  }
  pushFinding(result, 'saved', { kind, key, id, action, fields });
  if (origin) result.managedBindings.push({ kind, key, id, ...(Object.keys(confirmed).length ? { childIds: confirmed } : {}), origin });
  if (kind === 'duplicateRule' && ruleStatus(op.detail.entry, op.detail.remote || null) === 'published' && back.remote.status !== 'published') {
    // Saved, and not published: the read says so, whatever the publish job answered.
    const code = publishError && CODE_SHAPE.test(String(publishError.code)) ? publishError.code : 'DUPLICATE_RULE_NOT_PUBLISHED';
    pushFinding(result, 'pendingPublish', { kind, key, id, code });
  } else if (kind === 'duplicateRule' && back.status && op.detail.entry.status === 'unpublished') {
    pushFinding(result, 'unknown', { kind, key, id, code: 'CONFIGURATION_READBACK_MISMATCH', fields: ['/status'] }, handle);
    return false;
  }
  return true;
}

const INVENTORY = Symbol('configuration-artifacts.inventory');

// The create port a caller without one gets: the plain pass-through (lib/creates-passthrough.js). It allocates a
// fresh id per create, and the declared name is the identity, so a later run finds an earlier run's row by that name.
// This is deliberate: the configuration kinds use the plain create path and never load a stable-id module, so a
// whole-build retry after a lost create answer can create a second row (the build's known limit for every create).
// Only a caller that injects the stable-id functions itself (configurationContext `fence`) gets the configuration
// kinds' own stable port, built when the configuration is planned (planDefaultPort). Ordinary creation always works.
function defaultCreates(ctx) {
  if (!ctx[DEFAULT_PORT]) {
    // A stable port is built from the spec's intents, so it exists only after a plan: an apply that reaches here
    // with injected stable-id functions and no plan is refused rather than quietly sent under random ids.
    if (fenceOf(ctx)) throw new TypeError('configuration: the create port is built when the configuration is planned (planConfiguration)');
    const { createPassthroughCreates } = require('./creates-passthrough.js');
    Object.defineProperty(ctx, DEFAULT_PORT, { value: createPassthroughCreates(), enumerable: false });
  }
  return ctx[DEFAULT_PORT];
}
const DEFAULT_PORT = Symbol('configuration-artifacts.default-port');
const portFor = (ctx) => portOf(ctx) || defaultCreates(ctx);

// The safe handle of a create or write: what a maker inspects an unknown outcome by. Never a value.
function identityHandle(kind, key, identity, ids) {
  return { formatVersion: 1, kind, key: portKeyOf(kind, key), identity: { ...identity }, ...(ids ? { ids } : {}) };
}
function handleOf(op, ids) {
  return identityHandle(op.kind, op.key, op.detail.identity || op.target, ids);
}

// A port success is `created` (this run's acknowledged create) or `matched` (the platform answered with the row
// at the derived id). Anything else, or no id, is an outcome nobody can vouch for.
const portSucceeded = (answer) => !!(answer && (answer.outcome === 'created' || answer.outcome === 'matched') && typeof answer.id === 'string' && answer.id);

async function applyCreate(op, ctx, result, known) {
  const { kind, key } = op;
  const { withConfigurationWrite } = require('./configuration-transport.js');
  const { hasUnsyncedEdits } = require('./unsynced-edits.js');
  const creates = portFor(ctx);
  let parentId = null;
  if (op.detail.parentKey) {
    parentId = known.get(knownKey('environmentVariable', op.detail.parentKey));
    if (!parentId) { pushFinding(result, 'refused', { kind, key, code: 'ENVIRONMENT_VARIABLE_PARENT_UNAVAILABLE' }); return; }
  }
  const binding = kind === 'environmentVariable' ? bindingsOf(ctx).environmentVariables.get(lower(key)) : null;
  const valued = !!(binding && binding.value !== null);
  // A Custom API is one deep-insert POST; a reference is one POST; a variable without a value is one
  // POST. A variable with a value (two POSTs) and a duplicate rule (save, then publish) are composite.
  const singleWrite = kind === 'connectionReference' || kind === 'customApi' || (kind === 'environmentVariable' && !valued);
  const handle = handleOf(op);
  let sent = false;
  let unsettled = false;
  let given = null;
  let answer;
  try {
    answer = await creates.run({ kind, key: portKeyOf(kind, key), identity: op.detail.identity || op.target, childKeys: op.detail.childKeys }, async ({ id, childIds = {} }) => {
      sent = true;
      given = { id, childIds: { ...childIds } };
      handle.ids = given;
      try {
        await ctx.sdk.createArtifact(kind, buildArtifact(op, id, childIds, ctx, parentId));
      } catch (error) {
        // createArtifact only writes the local workspace, so nothing left this machine.
        throw tagged(kind, key, codeOf(error), 'nothing');
      }
      let pushed;
      try {
        pushed = await withConfigurationWrite(() => ctx.sdk.pushArtifact(kind, id));
      } catch (error) {
        throw tagged(kind, key, codeOf(error), outcomeOf(error, singleWrite));
      }
      const failed = pushFailure(kind, key, pushed, singleWrite);
      if (failed) throw failed;
      // Captured before the read-back overwrites the workspace copy: a value the push carried and the server
      // did not take stays in the copy (lib/unsynced-edits.js).
      if (valued && await hasUnsyncedEdits(ctx.sdk, kind, id)) unsettled = true;
      return pushed;
    });
  } catch (error) {
    const routed = routeFailure(error, sent);
    // A create whose answer was lost is the common typed stop; the SDK's own code rides along as the cause.
    const lost = routed.bucket === 'unknown' && error && error[TAGGED];
    pushFinding(result, routed.bucket, {
      kind, key, id: routed.bucket === 'unknown' && given ? given.id : undefined,
      code: lost ? 'create-outcome-unknown' : routed.code, cause: lost ? routed.code : undefined,
    }, routed.bucket === 'unknown' ? handle : null);
    return;
  }
  if (!portSucceeded(answer)) {
    pushFinding(result, 'unknown', { kind, key, id: given ? given.id : undefined, code: 'create-outcome-unknown' }, handle);
    return;
  }
  const { id } = answer;
  const childIds = answer.childIds || {};
  handle.ids = { id, childIds: { ...childIds } };
  known.set(knownKey(kind, key), id);
  const back = await readBack(op, ctx, known, id, childIds);
  const pushed = answer.result && typeof answer.result === 'object' ? answer.result : {};
  settle(op, ctx, result, {
    id, back, action: 'create', childIds, unsettled, handle, wroteDefinition: true,
    // `matched` is the platform's row at the derived id, not this run's create: it is never recorded as created.
    origin: answer.outcome === 'created' ? 'created' : null,
    publishError: pushed.publish && pushed.publish.kind !== 'verified' ? pushed.publish.error : null,
  });
}

// Put the id a create-port record gave a new child into the change that carries it.
function placeChild(change, child, childId) {
  if (child.kind === 'environmentVariableValue') { change.value = { ...change.value, id: childId }; return; }
  change.value[child.index] = { ...change.value[child.index], id: childId };
}

// The solution's version: set it, then read it back. Equal versions never reach here (planSolutionVersion).
async function applyVersion(op, ctx, result) {
  const { kind, key, id } = op;
  const { withConfigurationWrite } = require('./configuration-transport.js');
  try {
    await withConfigurationWrite(() => ctx.sdk.setSolutionVersion(id, op.detail.version));
  } catch (error) {
    if (outcomeOf(error, true) === 'nothing') pushFinding(result, 'refused', { kind, key, code: codeOf(error) });
    else pushFinding(result, 'unknown', { kind, key, id, code: 'CONFIGURATION_WRITE_UNKNOWN', cause: codeOf(error) });
    return;
  }
  let current;
  try {
    current = await ctx.sdk.getSolution(key);
  } catch {
    current = undefined;
  }
  if (!current) { pushFinding(result, 'unknown', { kind, key, id, code: 'CONFIGURATION_READBACK_UNKNOWN' }); return; }
  if (current.version !== op.detail.version) { pushFinding(result, 'unknown', { kind, key, id, code: 'CONFIGURATION_READBACK_MISMATCH', fields: ['/version'] }); return; }
  pushFinding(result, 'saved', { kind, key, id, action: 'update', fields: [...op.fields] });
}

async function applyUpdate(op, ctx, result, known) {
  const { kind, key, id } = op;
  if (kind === 'solutionVersion') { await applyVersion(op, ctx, result); return; }
  const { withConfigurationWrite } = require('./configuration-transport.js');
  const { hasUnsyncedEdits } = require('./unsynced-edits.js');
  // Each change is copied: the ids of new children are placed into the copy, never into the plan.
  const changes = op.detail.changes.map((change) => ({ ...change, value: Array.isArray(change.value) ? [...change.value] : change.value }));
  const created = changes.flatMap((change) => (change.created || []).map((child) => ({ change, child })));
  const creates = created.length ? portFor(ctx) : null;
  for (const change of changes) {
    if (!change.parentKey) continue;
    change.value = known.get(knownKey('environmentVariable', change.parentKey));
    if (!change.value) { pushFinding(result, 'refused', { kind, key, id, code: 'ENVIRONMENT_VARIABLE_PARENT_UNAVAILABLE' }); return; }
  }
  // Every authored value operation is captured, a clear (null) included: a DELETE the server refused after the
  // definition's PATCH went through leaves the clear in the copy, exactly as an unsent value does.
  const valueChange = changes.some((change) => change.pointer === '/currentValue');
  const wroteDefinition = changes.some((change) => change.pointer !== '/currentValue');
  const handle = handleOf(op, { id });
  const childIds = {};
  let unsettled = false;
  // How the item ends when a create of a child stops it short of the write.
  let stop = null;

  // The write itself: every change into the workspace copy, then one push.
  const write = async () => {
    try {
      for (const change of changes) await ctx.sdk.updateElement(kind, id, change.pointer, change.value);
    } catch (error) {
      throw tagged(kind, key, codeOf(error), 'nothing');
    }
    let pushed;
    try {
      pushed = await withConfigurationWrite(() => ctx.sdk.pushArtifact(kind, id));
    } catch (error) {
      throw tagged(kind, key, codeOf(error), outcomeOf(error, op.detail.singleWrite));
    }
    const failed = pushFailure(kind, key, pushed, op.detail.singleWrite);
    if (failed) throw failed;
    if (valueChange && await hasUnsyncedEdits(ctx.sdk, kind, id)) unsettled = true;
    return pushed;
  };

  // Every new child is created through the port, one record per child, nested so that the one push runs inside
  // all of them: each record holds its id before the push, and each learns how the push ended. Its port key is
  // `<root port key>|<slot>` and its identity names the parent's id, so a later run finds the same child.
  const level = async (index) => {
    if (index === created.length) return write();
    const { change, child } = created[index];
    let entered = false;
    let answer;
    try {
      answer = await creates.run({ kind: child.kind, key: child.key, identity: { ...child.identity, parentId: id }, childKeys: [] }, async ({ id: childId }) => {
        entered = true;
        placeChild(change, child, childId);
        childIds[child.slot] = childId;
        handle.ids = { id, childIds: { ...childIds } };
        return level(index + 1);
      });
    } catch (error) {
      if (error && error[TAGGED]) throw error;
      const routed = routeFailure(error, entered);
      throw tagged(child.kind, key, routed.code, entered ? 'unknown' : 'nothing', routed);
    }
    if (portSucceeded(answer)) return answer.result;
    stop = stop || { bucket: 'unknown', code: 'create-outcome-unknown' };
    return answer && answer.result;
  };

  // Under an exact port that edits this kind itself (protected configuration), the whole edit — new children included —
  // is ONE attempt of the port: the children take the ids its plan derived (never one per child through `run`), and the
  // one push runs inside that attempt's create set, which proves and records it.
  const exactPort = portOf(ctx);
  const exactUpdate = exactPort && exactPort.exact === true && typeof exactPort.update === 'function' && typeof exactPort.updates === 'function' && exactPort.updates(kind) ? exactPort : null;
  const updateExactly = async () => {
    let entered = false;
    try {
      const answer = await exactUpdate.update({ kind, key: portKeyOf(kind, key), id }, async ({ childIds: plannedIds = {} }) => {
        entered = true;
        for (const { change, child } of created) {
          const childId = plannedIds[child.slot];
          if (!childId) throw tagged(child.kind, key, 'create-identity-unverified', 'nothing');
          placeChild(change, child, childId);
          childIds[child.slot] = childId;
        }
        handle.ids = { id, childIds: { ...childIds } };
        return write();
      });
      return answer.result;
    } catch (error) {
      if (error && error[TAGGED]) throw error;
      const routed = routeFailure(error, entered);
      throw tagged(kind, key, routed.code, entered ? 'unknown' : 'nothing', routed);
    }
  };

  let pushed;
  try {
    pushed = exactUpdate ? await updateExactly() : await level(0);
  } catch (error) {
    const routed = routeFailure(error, false);
    // A write (not a create) whose answer was lost: what it changed is not known.
    const lost = routed.bucket === 'unknown' && error && error[TAGGED] && !error.report;
    pushFinding(result, routed.bucket, { kind, key, id, code: lost ? 'CONFIGURATION_WRITE_UNKNOWN' : routed.code, cause: lost ? routed.code : undefined }, routed.bucket === 'unknown' ? handle : null);
    return;
  }
  if (stop) { pushFinding(result, stop.bucket, { kind, key, id, code: stop.code }, handle); return; }
  const back = await readBack(op, ctx, known, id, { ...(op.detail.childIds || {}), ...childIds });
  const answered = pushed && typeof pushed === 'object' ? pushed : {};
  settle(op, ctx, result, {
    id, back, action: 'update', fields: [...op.fields], childIds, unsettled, handle, wroteDefinition,
    origin: op.origin === 'adopted' || Object.keys(childIds).length ? op.origin : null,
    publishError: answered.publish && answered.publish.kind !== 'verified' ? answered.publish.error : null,
  });
}

// Dataverse solution component types. An environment variable definition has a fixed type (380). Every other kind
// here is a table row, and a row's component type is its table's ObjectTypeCode ("The object type code of the
// component"), so it is read from the table's metadata (once per kind per run) rather than assumed.
// A duplicate rule and its conditions are table rows too. The choice list documents 44 (Duplicate Rule) and 45
// (Duplicate Rule Condition), but a current environment refuses them: `AddSolutionComponent` with 45 answers
//   400 {"error":{"code":"0x80040216","message":"Invalid component type provided 45"}}
// and the solution lists a rule and its condition under the duplicaterule and duplicaterulecondition tables'
// ObjectTypeCodes (4414 and 4416). 44 and 45 are only read, as proof (see CLASSIC_MEMBERSHIP_TYPES), never sent.
// 380 is the one constant kept: environment variable definitions are added and listed under it on a current environment.
// An environment variable VALUE is never added: it is per-environment data, and a solution that carried it would
// export this environment's value.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solutioncomponent#componenttype-choicesoptions
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/duplicaterule (its entity type
// code list: 4414 Duplicate Detection Rule, 4416 Duplicate Rule Condition)
const MEMBERSHIP_TABLES = Object.freeze({ environmentVariable: 380, connectionReference: 'connectionreference', customApi: 'customapi', duplicateRule: 'duplicaterule' });
// A root exports whole only with its children, and a child's membership is never inferred from its root's (nor from a
// table's subcomponents): each child is its own solution component and is proven as one. A Custom API parameter or
// response property, and a duplicate rule condition, is a table row (its table's ObjectTypeCode).
// The platform's own duplicate-rule code creates conditions solution-scoped because a compound create's children
// can be left out of the solution, so a create header on the root proves nothing about them.
// An environment variable value is deliberately absent (see above).
const CHILD_MEMBERSHIP_TABLES = Object.freeze({ customApiRequestParameter: 'customapirequestparameter', customApiResponseProperty: 'customapiresponseproperty', duplicateRuleCondition: 'duplicaterulecondition' });
// A solution may still list a duplicate rule or condition under its classic type. The SDK's own solution reader
// (fetchSolutionComponents) folds 44 into the rule's type and 45 into the condition's, so a row under the classic type
// is the same component and proves membership. These are read only: an add always sends the resolved type.
const CLASSIC_MEMBERSHIP_TYPES = Object.freeze({ duplicateRule: 44, duplicateRuleCondition: 45 });

// The child rows a read of a root shows, as membership items {kind, key, id}. A child's key is its slot under the
// root, as the create port and the management records name it: `<api>|request:<name>`, `<rule>|<condition key>`.
// A condition row is named by the declaration it is pinned to (childIds) or, failing that, the one declaration that
// describes it; a row no declaration names keeps its id.
function childMembershipItems(kind, key, entry, remote, childIds) {
  if (!remote || typeof remote !== 'object') return [];
  const root = portKeyOf(kind, key);
  if (kind === 'customApi') {
    const rows = [...(remote.requestParameters || []).map((c) => ['request', c]), ...(remote.responseProperties || []).map((c) => ['response', c])];
    return rows.filter(([, c]) => c && nonEmptyString(c.id) && nonEmptyString(c.uniqueName)).map(([direction, c]) => ({
      kind: direction === 'request' ? 'customApiRequestParameter' : 'customApiResponseProperty', key: `${root}|${direction}:${lower(c.uniqueName)}`, id: c.id,
    }));
  }
  if (kind === 'duplicateRule') {
    const declared = (entry && entry.conditions) || [];
    return (remote.conditions || []).filter((c) => c && nonEmptyString(c.id)).map((c) => {
      const pinned = childIds ? Object.keys(childIds).find((slot) => childIds[slot] && ref(childIds[slot]) === ref(c.id)) : null;
      const describing = declared.filter((d) => describes(d, c));
      const slot = pinned || (describing.length === 1 ? describing[0].key : lower(c.id));
      return { kind: 'duplicateRuleCondition', key: `${root}|${slot}`, id: c.id };
    });
  }
  return [];
}

// Put a reused item into the build's solution, and prove at the end that every item is in it. A create carries
// the solution header, so its row should be in the solution already; an item the build found (made earlier, by
// another build, or by hand) may not be, and a solution export would then leave it behind. The add is asserted only
// when the solution's membership does not already prove it (lib/solution-membership.js). `prove` reads the
// membership afresh once at the end: an add the platform answered is not proof, and neither is a create header.
function membershipOf(ctx) {
  const { isRestrictedSolution } = require('./system-solutions.js');
  const active = !!ctx.solutionUniqueName && !isRestrictedSolution(ctx.solutionUniqueName);
  const memberships = new Map();
  const types = new Map();
  const typeOf = async (kind) => {
    const table = has(MEMBERSHIP_TABLES, kind) ? MEMBERSHIP_TABLES[kind] : CHILD_MEMBERSHIP_TABLES[kind];
    if (typeof table === 'number') return table;
    if (!types.has(kind)) {
      types.set(kind, (async () => {
        const answer = await ctx.sdk.dataverse.get(`/EntityDefinitions(LogicalName='${table}')?$select=ObjectTypeCode`);
        const code = answer && answer.body && answer.body.ObjectTypeCode;
        if (!Number.isInteger(code) || code <= 0) {
          const error = new Error(`the ${table} component type is unreadable`);
          error.code = 'SOLUTION_COMPONENT_TYPE_UNREADABLE';
          throw error;
        }
        return code;
      })());
    }
    return types.get(kind);
  };
  const applies = (op) => active && (has(MEMBERSHIP_TABLES, op.kind) || has(CHILD_MEMBERSHIP_TABLES, op.kind)) && !!op.id;
  return {
    async ensure(op) {
      if (!applies(op)) return null;
      const { createSolutionMembership, ensureSolutionComponent } = require('./solution-membership.js');
      const { withConfigurationWrite } = require('./configuration-transport.js');
      let componentType;
      try {
        componentType = await typeOf(op.kind);
      } catch (error) {
        return { bucket: 'unknown', code: codeOf(error) };
      }
      const classic = has(CLASSIC_MEMBERSHIP_TYPES, op.kind) ? CLASSIC_MEMBERSHIP_TYPES[op.kind] : null;
      if (!memberships.has(op.kind)) {
        memberships.set(op.kind, createSolutionMembership({ read: ctx.sdk, solutionUniqueName: ctx.solutionUniqueName, componentTypes: classic ? [componentType, classic] : [componentType] }));
      }
      try {
        if (classic && await memberships.get(op.kind).has(op.id, classic)) return null;
        await withConfigurationWrite(() => ensureSolutionComponent(ctx.sdk, memberships.get(op.kind), { componentId: op.id, componentType, solutionUniqueName: ctx.solutionUniqueName }));
      } catch (error) {
        return outcomeOf(error, true) === 'nothing' ? { bucket: 'refused', code: codeOf(error) } : { bucket: 'unknown', code: 'SOLUTION_MEMBERSHIP_UNKNOWN' };
      }
      return null;
    },
    // The kinds among `kinds` whose component type cannot be read: none when the build joins no solution. It shares
    // typeOf's memo, so a type read here is not read again by ensure or prove, and a failed read is not retried.
    async unreadable(kinds) {
      if (!active) return [];
      const failed = [];
      for (const kind of kinds) {
        try { await typeOf(kind); } catch { failed.push(kind); }
      }
      return failed;
    },
    // [{kind, key, id}] → the items NOT proven to be in the solution.
    async prove(items) {
      const wanted = items.filter((item) => applies(item));
      if (!wanted.length) return [];
      const { readSolutionMembers } = require('./solution-membership.js');
      const typed = [];
      for (const item of wanted) {
        try { typed.push({ item, type: await typeOf(item.kind) }); } catch { typed.push({ item, type: null }); }
      }
      let held = null;
      const classicOf = (item) => (has(CLASSIC_MEMBERSHIP_TYPES, item.kind) ? CLASSIC_MEMBERSHIP_TYPES[item.kind] : null);
      // A classic type is read only alongside a resolved one: an item whose type is unreadable stays unproven.
      const read = typed.filter((t) => t.type).flatMap((t) => [t.type, classicOf(t.item)]).filter(Boolean);
      try {
        held = await readSolutionMembers(ctx.sdk, ctx.solutionUniqueName, [...new Set(read)]);
      } catch {
        held = null;
      }
      const bare = (v) => String(v).replace(/[{}]/g, '').trim().toLowerCase();
      const holds = (type, item) => held.members.has(`${type}:${bare(item.id)}`) || (!!classicOf(item) && held.members.has(`${classicOf(item)}:${bare(item.id)}`));
      return typed.filter(({ item, type }) => !held || !type || !holds(type, item)).map(({ item }) => item);
    },
  };
}

// Apply a plan from any of the plan functions (or several concatenated). Operations run in plan order, which is
// dependency order. The plan's read failures are carried into `unknown` so a caller that only looks at the result
// still sees that requested work did not happen. Per operation, nothing is written before its authorization
// holds, membership included; with `ctx.solutionUniqueName`, an item the build found is put into that solution
// first, and every item is proven a member at the end. An unknown outcome stops the writes after it: what it left
// is not known, and a later write could build on it.
async function applyConfiguration(plan, ctx) {
  const result = emptyResult();
  if (!plan) return result;
  for (const finding of plan.unknown || []) {
    pushFinding(result, 'unknown', { ...finding }, finding.handle);
    observationsOf(result).push({ kind: finding.kind, key: finding.key, source: 'plan-read', definition: 'unknown' });
  }
  const known = new Map();
  for (const op of plan.operations || []) if (op.id) known.set(knownKey(op.kind, op.key), op.id);
  const preconditionCache = new Map();
  const membership = membershipOf(ctx);
  const inventory = connectionInventory(ctx);
  if ((plan.operations || []).some((op) => op.kind === 'connectionReference')) {
    Object.defineProperty(result, INVENTORY, { value: await inventory(), enumerable: false });
  }
  let stopped = false;
  for (const op of plan.operations || []) {
    const { kind, key } = op;
    if (op.action === 'refuse') {
      pushFinding(result, 'refused', { kind, key, id: op.id, code: op.code, reason: op.reason });
      observationsOf(result).push({ kind, key, source: 'plan-read', definition: op.id ? 'unknown' : 'missing' });
      continue;
    }
    if (stopped && op.action !== 'unchanged') {
      pushFinding(result, 'refused', { kind, key, id: op.id, code: 'CONFIGURATION_STOPPED_AFTER_UNKNOWN' });
      observationsOf(result).push({ kind, key, source: 'plan-read', definition: op.id ? 'unknown' : 'missing' });
      continue;
    }
    const missing = missingAuthorization(op, ctx);
    if (missing.length) {
      pushFinding(result, 'refused', { kind, key, id: op.id, code: 'DESTRUCTIVE_CHANGE_UNAUTHORIZED', authorize: missing });
      observationsOf(result).push(observe(kind, key, op.id, op.detail.entry, op.detail.remote, 'plan-read', result[INVENTORY]));
      continue;
    }
    const unknownBefore = result.unknown.length;
    // A duplicate rule's conditions join the solution after they are written, and a new rule itself is proven only at
    // the end. Each needs a component type read from metadata (typeOf); were it read that late, an unreadable type would
    // surface only after the rule or its new conditions were written (and the rule published). So the types a write
    // will need are read before it, through the same memo (so the later ensure and proof read nothing again), and a type
    // that cannot be read stops the step with nothing written for the rule:
    //   - a create reads the rule's type and, when it declares conditions, theirs (before the create);
    //   - an update whose edit creates conditions reads theirs before ensure, which can itself write (it adds a found
    //     rule that is not yet in the solution), and so before the update too. It is read only once the update's
    //     preconditions hold: their answer is cached, and ensure still runs before a refusal, so a refused edit sends
    //     the same requests as before and reads no type. The rule's own type is read by ensure, before its add.
    // A found rule whose edit adds no condition keeps its requests: ensure reads the rule's type before any write of it.
    const typesUnreadable = async (kinds, conditionKeys) => {
      const failed = await membership.unreadable(kinds);
      if (!failed.length) return false;
      const code = 'SOLUTION_COMPONENT_TYPE_UNREADABLE';
      if (failed.includes('duplicateRule')) pushFinding(result, 'unknown', { kind, key, ...(op.action === 'create' ? {} : { id: op.id }), code, unit: 'membership' });
      if (failed.includes('duplicateRuleCondition')) {
        for (const childKey of conditionKeys) pushFinding(result, 'unknown', { kind: 'duplicateRuleCondition', key: childKey, code, unit: 'membership' });
      }
      observationsOf(result).push(op.action === 'create'
        ? { kind, key, source: 'plan-read', definition: 'missing' }
        : observe(kind, key, op.id, op.detail.entry, op.detail.remote, 'plan-read', result[INVENTORY]));
      stopped = true;
      return true;
    };
    if (op.action === 'create' && kind === 'duplicateRule') {
      const slots = declaredSlots(kind, op.detail && op.detail.entry, ctx);
      if (await typesUnreadable(slots.length ? ['duplicateRule', 'duplicateRuleCondition'] : ['duplicateRule'], slots.map((slot) => `${portKeyOf(kind, key)}|${slot}`))) continue;
    }
    // `undefined` until read; null when every precondition holds, else the refusal code.
    let blocked;
    if (op.action === 'update' && kind === 'duplicateRule') {
      const added = (op.detail.changes || []).flatMap((change) => change.created || []).filter((child) => child.kind === 'duplicateRuleCondition');
      if (added.length) {
        blocked = await preconditionsHold(op, ctx, preconditionCache);
        if (!blocked && await typesUnreadable(['duplicateRuleCondition'], added.map((child) => child.key))) continue;
      }
    }
    // An owed edit's membership is added by the port inside that edit's own attempt (configuration-protected.js update),
    // never here outside it.
    if ((op.action === 'update' && !(op.detail && op.detail.owed)) || (op.action === 'unchanged' && !stopped)) {
      const joined = await membership.ensure(op);
      if (joined) {
        pushFinding(result, joined.bucket, { kind, key, id: op.id, code: joined.code, unit: 'membership' });
        observationsOf(result).push(observe(kind, key, op.id, op.detail.entry, op.detail.remote, 'plan-read', result[INVENTORY]));
        if (result.unknown.length > unknownBefore) stopped = true;
        continue;
      }
    }
    if (op.action === 'unchanged') {
      pushFinding(result, 'unchanged', { kind, key, id: op.id });
      if (op.origin === 'adopted') result.managedBindings.push({ kind, key, id: op.id, origin: 'adopted' });
      if (kind !== 'solutionVersion') observationsOf(result).push(observe(kind, key, op.id, op.detail.entry, op.detail.remote, 'plan-read', result[INVENTORY]));
      continue;
    }
    if (blocked === undefined) blocked = await preconditionsHold(op, ctx, preconditionCache);
    if (blocked) { pushFinding(result, 'refused', { kind, key, id: op.id, code: blocked }); continue; }
    if (op.action === 'create') await applyCreate(op, ctx, result, known);
    else if (op.action === 'update') await applyUpdate(op, ctx, result, known);
    if (result.unknown.length > unknownBefore) stopped = true;
  }
  // Membership proof: one fresh read of the solution for every root this run saved or found unchanged, and for each
  // child those rows hold. A child not proven a member is added first (after every write of the run, so only when no
  // outcome is unknown); an add that fails is that child's line, and the fresh read decides the rest.
  const roots = [...result.saved, ...result.unchanged].filter((line, i, all) => all.findIndex((o) => o.kind === line.kind && o.key === line.key) === i);
  const opOf = new Map((plan.operations || []).map((op) => [`${op.kind}:${op.key}`, op]));
  const children = [];
  for (const line of roots) {
    const op = opOf.get(`${line.kind}:${line.key}`);
    if (!op || !op.detail) continue;
    const read = rowsReadOf(result).get(`${line.kind}:${line.key}`) || { remote: op.detail.remote, childIds: op.detail.childIds };
    children.push(...childMembershipItems(line.kind, line.key, op.detail.entry, read.remote, read.childIds));
  }
  const answered = new Set();
  for (const child of children) {
    if (stopped) break;
    const joined = await membership.ensure(child);
    if (!joined) continue;
    answered.add(child);
    pushFinding(result, joined.bucket, { kind: child.kind, key: child.key, id: child.id, code: joined.code, unit: 'membership' });
    if (joined.bucket === 'unknown') stopped = true;
  }
  for (const item of await membership.prove([...roots, ...children.filter((child) => !answered.has(child))])) {
    pushFinding(result, 'unknown', { kind: item.kind, key: item.key, id: item.id, code: 'SOLUTION_MEMBERSHIP_UNKNOWN', unit: 'membership' });
  }
  // A row the content step left complete whose management a recording build could not confirm (see adoptionOf).
  for (const op of plan.operations || []) {
    if (!op.detail || !op.detail.unrecorded) continue;
    const done = roots.some((line) => line.kind === op.kind && line.key === op.key);
    const open = result.unknown.some((line) => line.kind === op.kind && line.key === op.key);
    if (done && !open) pushFinding(result, 'unknown', { kind: op.kind, key: portKeyOf(op.kind, op.key), id: op.id, code: 'CONFIGURATION_RECORD_UNCONFIRMED', unit: 'management' });
  }
  await reconcileChildRecords(plan, ctx, result);
  return result;
}

// The declared child slots of a root: the slots its create, or a later add, gives its children (the create port's
// childKeys). A variable's value is a child only when the deployment settings write one.
function declaredSlots(kind, entry, ctx) {
  if (!isObject(entry)) return [];
  if (kind === 'environmentVariable') return variablePlan(bindingsOf(ctx), new Map()).childKeys(entry);
  if (kind === 'customApi') return customApiPlan.childKeys(entry);
  if (kind === 'duplicateRule') return duplicateRulePlan.childKeys(entry);
  return [];
}

// A root's record does not vouch for its children: each child is a record of its own, and an earlier run whose child
// record failed (CONFIGURATION_RECORD_UNCONFIRMED) left a child no later build would otherwise account for. So for a
// root this run found complete (saved or unchanged, not created now, its own management confirmed), each declared
// child the read shows in its slot is checked against its record (`ctx.managed.lookup(childKind, childKey)` at the
// same id). A child with no such record is decided by the common adoption policy, as a found root is: allowed, it is
// recorded as adopted (never as created: a read does not prove who made it); refused, it is refused. With no policy
// to ask, the child's management stays unconfirmed, reported on every run until a record or a policy settles it.
// Children this run created are recorded with their create (settle) and are not asked again.
async function reconcileChildRecords(plan, ctx, result) {
  const managed = ctx.managed;
  if (!managed || typeof managed.recordApplied !== 'function') return;
  const sameItem = (op) => (line) => line.kind === op.kind && line.key === op.key;
  for (const op of plan.operations || []) {
    if (!op.detail || !CHILD_KINDS[op.kind] || (op.action !== 'update' && op.action !== 'unchanged')) continue;
    // Under an exact port every child is a row of the root's committed binding, proved at its exact id: not adopted.
    if (exactPortOf(ctx, op.kind)) continue;
    // A root whose own management is unconfirmed is reported as such already; its children wait for it.
    if (op.detail.unrecorded) continue;
    if (![...result.saved, ...result.unchanged].some(sameItem(op))) continue;
    if (result.unknown.some(sameItem(op)) || result.refused.some(sameItem(op))) continue;
    const read = rowsReadOf(result).get(`${op.kind}:${op.key}`) || { remote: op.detail.remote, childIds: op.detail.childIds };
    const bindings = result.managedBindings.filter(sameItem(op));
    const createdNow = new Set(bindings.flatMap((b) => Object.keys(b.childIds || {})));
    const rootKey = portKeyOf(op.kind, op.key);
    const adopted = {};
    for (const slot of declaredSlots(op.kind, op.detail.entry, ctx)) {
      if (createdNow.has(slot)) continue;
      const rows = slotRows(op.kind, op.detail.entry, read.remote, slot).filter((row) => nonEmptyString(row.id));
      if (!rows.length) continue;
      // Two rows in one slot are told apart only by the id a record pins (the content step refuses the ambiguity otherwise).
      const pinned = read.childIds && read.childIds[slot];
      const row = rows.length === 1 ? rows[0] : rows.find((r) => pinned && ref(r.id) === ref(pinned));
      const childKind = CHILD_KINDS[op.kind](slot);
      const childKey = `${rootKey}|${slot}`;
      const id = row ? lower(row.id) : undefined;
      const unconfirmed = () => pushFinding(result, 'unknown', { kind: childKind, key: childKey, ...(id ? { id } : {}), code: 'CONFIGURATION_RECORD_UNCONFIRMED', unit: 'management' });
      if (!id) { unconfirmed(); continue; }
      let decision;
      try {
        if (typeof managed.lookup === 'function') {
          const record = await managed.lookup(childKind, childKey);
          if (record && ref(record.id) === ref(id)) continue;
        }
        if (typeof managed.planAdoption !== 'function') { unconfirmed(); continue; }
        decision = await managed.planAdoption({ kind: childKind, key: childKey, id });
      } catch {
        // A store that cannot answer proves nothing: the child's management is not confirmed.
        unconfirmed();
        continue;
      }
      if (decision && decision.allowed === true) adopted[slot] = id;
      else pushFinding(result, 'refused', { kind: childKind, key: childKey, id, code: (decision && CODE_SHAPE.test(String(decision.code)) && decision.code) || 'ADOPTION_REFUSED' });
    }
    if (!Object.keys(adopted).length) continue;
    // Kept on the root's binding of this run when there is one (its own origin is recorded once), else on a binding
    // that records the children alone (origin 'found': the root is recorded already).
    const binding = bindings[0];
    if (binding) binding.adoptedChildIds = { ...(binding.adoptedChildIds || {}), ...adopted };
    else result.managedBindings.push({ kind: op.kind, key: op.key, id: op.id, origin: 'found', adoptedChildIds: adopted });
  }
}

// What still stands between this configuration and the pages that use it, from OBSERVED state only (a fresh read
// of each row: the plan's read, the read-back after a write, or observeConfiguration): never from what the
// settings ask for or what a plan meant to do. `{kind, key, code, blocksConsumers: true}` each, once per item.
//   ENVIRONMENT_VARIABLE_VALUE_MISSING        a required variable with no value and no default
//   CONNECTION_REFERENCE_UNBOUND              a reference with no connection, one the inventory does not hold, or one
//                                             of another connector
//   CONNECTION_REFERENCE_BINDING_UNVERIFIED   a connection the run could not check against the inventory
//   CUSTOM_API_IMPLEMENTATION_UNPROVEN        no plug-in type registered: a call returns default values
//   DUPLICATE_RULE_NOT_PUBLISHED              a rule meant to be published that is not
//   CONFIGURATION_DEFINITION_MISSING          the declaration has no row
//   CONFIGURATION_READ_UNKNOWN                the row could not be read, or a write left it unknown
function configurationReadiness(observations) {
  const out = [];
  const seen = new Set();
  const add = (o, code) => {
    const k = `${o.kind}:${lower(o.key)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ kind: o.kind, key: o.key, code, blocksConsumers: true });
  };
  const list = Array.isArray(observations) ? observations : observationsOf(observations);
  // The last observation of an item wins: a read-back after a write supersedes the plan's read.
  const latest = new Map();
  for (const o of list) if (o && o.kind && o.key != null) latest.set(`${o.kind}:${lower(o.key)}`, o);
  for (const o of latest.values()) {
    if (o.kind === 'solutionVersion') continue;
    if (o.definition === 'unknown') { add(o, 'CONFIGURATION_READ_UNKNOWN'); continue; }
    if (o.definition === 'missing') { add(o, 'CONFIGURATION_DEFINITION_MISSING'); continue; }
    if (o.requiredValue === 'missing') add(o, 'ENVIRONMENT_VARIABLE_VALUE_MISSING');
    else if (o.requiredValue === 'unknown') add(o, 'CONFIGURATION_READ_UNKNOWN');
    if (o.binding === 'unbound') add(o, 'CONNECTION_REFERENCE_UNBOUND');
    else if (o.binding === 'unknown') add(o, 'CONNECTION_REFERENCE_BINDING_UNVERIFIED');
    if (o.implementation === 'unproven' || o.implementation === 'unknown') add(o, 'CUSTOM_API_IMPLEMENTATION_UNPROVEN');
    if (o.publicationRequired && o.publication !== 'published') add(o, 'DUPLICATE_RULE_NOT_PUBLISHED');
  }
  return out;
}

// Fresh reads of every declared configuration item, GET only, for a run that does not apply configuration (a
// pages-only or changed-only run) or a verify: the private observations configurationReadiness consumes. A failed
// read is 'unknown', never absence; a name found at another id than the item's own is 'unknown' too.
async function observeConfiguration(spec, ctx) {
  const observations = [];
  if (!hasConfigurationDefinitions(spec)) return observations;
  const inventory = (spec.connectionReferences || []).length ? await connectionInventory(ctx)() : null;
  const kinds = [
    [variablePlan(bindingsOf(ctx), new Map()), spec.environmentVariables],
    [referencePlan(bindingsOf(ctx)), spec.connectionReferences],
    [customApiPlan, spec.customApis],
    [duplicateRulePlan, spec.duplicateDetectionRules],
  ];
  for (const [kindPlan, entries] of kinds) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const key = kindPlan.key(entry);
      let found;
      try {
        found = await locate({ ...ctx, managed: ctx.managed && { lookup: ctx.managed.lookup } }, kindPlan.kind, key, kindPlan.identity(entry));
      } catch {
        observations.push({ kind: kindPlan.kind, key, source: 'plan-read', definition: 'unknown' });
        continue;
      }
      if (!found) { observations.push({ kind: kindPlan.kind, key, source: 'missing', definition: 'missing' }); continue; }
      if (found.refusal === 'create-identity-conflict' || !found.remote) { observations.push({ kind: kindPlan.kind, key, id: found.id, source: 'plan-read', definition: 'unknown' }); continue; }
      observations.push(observe(kindPlan.kind, key, found.id, entry, found.remote, 'plan-read', inventory));
    }
  }
  return observations;
}

// The pages a blocker stands in the way of: a page calls a reference by its logical name (connectorBindings[].
// logicalName) and a Custom API by its unique name (actionBindings[].name). `pages` is what
// page-binding-targets.js pagesStatingBindings answers. Each refusal names the page, the item and the cause.
function configurationPageBlockers(blocking, pages) {
  const byKey = new Map();
  for (const b of blocking || []) {
    if (b.kind === 'connectionReference' || b.kind === 'customApi') byKey.set(`${b.kind}:${lower(b.key)}`, b);
  }
  const out = [];
  for (const page of pages || []) {
    const uses = [
      ...((page && page.connectorBindings) || []).map((b) => b && b.logicalName != null && `connectionReference:${lower(b.logicalName)}`),
      ...((page && page.actionBindings) || []).map((b) => b && b.name != null && `customApi:${lower(b.name)}`),
    ].filter(Boolean);
    for (const use of [...new Set(uses)]) {
      const cause = byKey.get(use);
      if (cause) out.push({ page: page.key, kind: cause.kind, key: cause.key, code: 'CONFIGURATION_PREREQUISITE_NOT_APPLIED', cause: cause.code });
    }
  }
  return out;
}

// The build's ctx for this helper, from what the build holds. Destructive authority is exactly the normalized
// Set of tokens the maker passed (configurationAuthorizationKeys(...).keys): never "everything" because a flag
// was passed. `connections` is the optional inventory reader the readiness gate proves a binding against.
// `fence` injects stable-id functions (see fenceOf; omitted or null, the plain pass-through), and
// `boundIdOf(kind, portKey)` answers, synchronously, the id the managed-artifacts manifest records for an item.
// `reuseNamesakes` is for a caller that keeps no record of the rows it made (create-connection-reference.js): there
// the declared name IS the item, so a row found by name at another id than the planned one is reused, as it was
// before ids were planned, instead of refused as another's (CONFIGURATION_IDENTITY_FOREIGN). The planned id still
// makes that caller's own create safe to repeat. The build keeps a manifest and never sets it.
function configurationContext({ sdk, creates, managed, bindings, solutionUniqueName, authorizedDestructive, connections, fence, boundIdOf, reuseNamesakes } = {}) {
  return {
    sdk,
    ...(creates ? { creates } : {}),
    ...(managed ? { managed } : {}),
    ...(bindings ? { bindings } : {}),
    ...(solutionUniqueName ? { solutionUniqueName } : {}),
    ...(typeof connections === 'function' ? { connections } : {}),
    ...(fence !== undefined ? { fence } : {}),
    ...(typeof boundIdOf === 'function' ? { boundIdOf } : {}),
    ...(reuseNamesakes === true ? { reuseNamesakes: true } : {}),
    authorizedDestructive: authorizedDestructive instanceof Set ? new Set(authorizedDestructive) : new Set(),
  };
}

// Every authorization token the plan needs: what a refusal run lists for the maker to pass.
const configurationDestructive = (plan) => [...new Set(((plan && plan.operations) || []).filter((op) => op.destructive).flatMap((op) => op.authorize || []))];

// A halt item: kind, key and fixed code, plus the tokens a refusal needs consent for (DESTRUCTIVE_CHANGE_UNAUTHORIZED's `authorize`).
const haltItem = ({ kind, key, code, authorize }) => ({ kind, key, code, ...(Array.isArray(authorize) && authorize.length ? { authorize: authorize.slice() } : {}) });

// The configuration halt's text. A refusal that needs consent ends with the exact flags that give it, e.g.
//   environmentVariable contoso_Mode (DESTRUCTIVE_CHANGE_UNAUTHORIZED) (approve with --authorize environmentVariable:contoso_mode:defaultValue)
// so the maker can resume without reading the plan. A token is <kind>:<key>:<field> (tokenOf): keys and field names only, never a
// setting value or an SDK message, so it may be printed wherever the key already is.
// The flags are meant to be pasted into a command, and a key is not always plain: a duplicate-rule key is an identity kept byte for byte, so
// it may hold white space or quotes, and `--authorize duplicateRule:contact email:description` would reach the CLI as two arguments. So each
// token is written as ONE argument for the shells the skill's commands are written for (commandArg: bare when plain, as above; single-quoted
// otherwise), and a token no spelling carries unchanged through both PowerShell and a POSIX shell (a quote character) is a placeholder whose
// value the message gives as data:
//   duplicateRule contact email (DESTRUCTIVE_CHANGE_UNAUTHORIZED) (approve with --authorize 'duplicateRule:contact email:description')
//   duplicateRule owner's (DESTRUCTIVE_CHANGE_UNAUTHORIZED) (approve with --authorize <token> — <token> is "duplicateRule:owner's:description"; it is ...)
// The halt item's `authorize` keeps the raw tokens either way.
function authorizeFlags(tokens) {
  const spelled = tokens.map((t, i) => commandArgOrPlaceholder(t, tokens.length === 1 ? '<token>' : `<token-${i + 1}>`));
  const notes = spelled.map((s) => s.note).filter(Boolean);
  return `${spelled.map((s) => `--authorize ${s.arg}`).join(' ')}${notes.length ? ` — ${notes.join(' ')}` : ''}`;
}
// A duplicate rule that is saved and not published (pendingPublish: the publish job failed, or the read-back shows it
// unpublished) is not finished by a plain rebuild: an omitted `status` keeps the remote status (ruleStatus), so that a
// build never republishes a rule a maker unpublished, and the rebuild reports the rule unchanged. That rule stays, so
// the line itself says how to finish:
//   duplicateRule email (DUPLICATE_RULE_PUBLISH_FAILED) (saved, but its publication did not complete: publish the rule in ...)
// The marker is non-enumerable so the halt items (and their JSON) stay {kind, key, code}; the step's runtime reuses
// these objects when it rebuilds the message (configuration-build.js), so the hint survives that too.
const SAVED_UNPUBLISHED = Symbol('savedUnpublished');
const UNPUBLISHED_RULE_HINT = 'saved, but its publication did not complete: publish the rule in the environment\'s duplicate detection rules settings, '
  + 'or set "status": "published" on it in the App Spec and build again; a build without "status" keeps it unpublished';
const markSavedUnpublished = (item) => Object.defineProperty(item, SAVED_UNPUBLISHED, { value: true, enumerable: false });
function configurationHaltMessage(items) {
  const hint = (p) => (p[SAVED_UNPUBLISHED] && p.kind === 'duplicateRule' ? ` (${UNPUBLISHED_RULE_HINT})` : '');
  const line = (p) => `${p.kind} ${p.key} (${p.code})${p.authorize && p.authorize.length ? ` (approve with ${authorizeFlags(p.authorize)})` : ''}${hint(p)}`;
  return `${items.length} configuration item${items.length === 1 ? '' : 's'} not completed: ${items.map(line).join(', ')}`;
}

// One configuration step of the build: plan (GET only), apply, then decide. `phase` is 'solution' (the solution
// version) or 'data-model' (everything else). `halt` is null when every requested item is done; otherwise it is
// what the build stops with — refused, unknown, or saved but not published — naming kinds, keys and fixed codes
// only (never an SDK message, which can quote a URL or a value). `retry` is always 'never': an unknown outcome is
// inspected, never replayed by a whole-build retry. `blocking` is configurationReadiness of what the step read.
async function runConfigurationStep(spec, ctx, phase) {
  const plan = phase === 'solution' ? await planSolutionVersion(spec, ctx) : await planConfiguration(spec, ctx);
  const outcome = await applyConfiguration(plan, ctx);
  const problems = [...outcome.refused.map(haltItem), ...outcome.unknown.map(haltItem), ...outcome.pendingPublish.map((p) => markSavedUnpublished(haltItem(p)))];
  const blocking = phase === 'solution' ? [] : configurationReadiness(outcome);
  // A required variable with no value leaves the build incomplete even with no page that reads it, and so does a
  // connection the settings asked for that the read-back does not prove bound (unbound, of another connector, or
  // unverifiable). A reference the settings do not bind is a scaffold, and an authorized unbind (ConnectionId null)
  // is what was asked for: those are readiness only, for the pages that use them.
  const asked = bindingsOf(ctx).connectionReferences;
  const requested = (b) => b.kind === 'connectionReference' && (b.code === 'CONNECTION_REFERENCE_UNBOUND' || b.code === 'CONNECTION_REFERENCE_BINDING_UNVERIFIED')
    && !!asked && typeof asked.get === 'function' && !!asked.get(lower(b.key)) && asked.get(lower(b.key)).connectionId != null;
  for (const b of blocking) {
    if ((b.code === 'ENVIRONMENT_VARIABLE_VALUE_MISSING' || requested(b)) && !problems.some((p) => p.kind === b.kind && lower(p.key) === lower(b.key))) problems.push({ kind: b.kind, key: b.key, code: b.code });
  }
  const halt = problems.length
    ? {
      phase,
      code: 'configuration-incomplete',
      retry: 'never',
      message: configurationHaltMessage(problems),
      items: problems,
    }
    : null;
  return { plan, outcome, halt, blocking };
}

// The `blocking` list for a run that applies no configuration (`--stages pages`, a changed-only run): fresh reads.
async function configurationBlocking(spec, ctx) {
  if (!hasConfigurationDefinitions(spec)) return [];
  return configurationReadiness(await observeConfiguration(spec, ctx));
}

// ---------------------------------------------------------------------------------------------
// Authorization tokens, plan items, intents and records

// The fields each kind's tokens may name after `<kind>:<root key>:`. A child or criterion token names its slot.
const TOKEN_FIELDS = Object.freeze({
  environmentVariable: /^(description|defaultValue|isRequired|valueSchema|connectorId|parameterKey|parentSchemaName)$/,
  environmentVariableValue: /^value$/,
  connectionReference: /^(description|customConnectorId|connectionId)$/,
  customApi: /^(isPrivate|executePrivilegeName|request:[^:\s]+|response:[^:\s]+)$/,
  duplicateRule: /^(name|description|caseSensitive|excludeInactiveRecords|status|condition:\S+)$/,
});
const TOKEN_ROOTS = Object.freeze({
  environmentVariable: ['environmentVariables', 'schemaName'],
  environmentVariableValue: ['environmentVariables', 'schemaName'],
  connectionReference: ['connectionReferences', 'logicalName'],
  customApi: ['customApis', 'uniqueName'],
  duplicateRule: ['duplicateDetectionRules', 'key'],
});

// Sort the `--authorize` tokens the maker passed: those of this module's kinds are checked against the App Spec
// (the root must be declared; the field must be one a plan can ask for) and normalized exactly as a plan writes them
// (lower-cased names and child names; a rule's key and a condition's key byte for byte). Tokens of other kinds are
// answered unclaimed, for their own grammar. `{keys: Set, overwrite: Set, rowApprovals: Set, problems: [{token, code}], unclaimed: [token]}`.
// `overwrite:<kind>:<declared key>` (e.g. overwrite:customApi:contoso_Calc) is the one approval that replaces a protected
// item's local workspace copy with the server's (lib/configuration-protected.js, the preflight's stop on a copy that
// differs). It names a whole root item, matched as the other tokens are (a duplicate rule's key exactly), and is read only
// under `configurationIdentity: "stable-v1"`: the ordinary path never stops on a configuration copy, so the token would
// approve nothing. It lands in `overwrite` as `<kind>:<port key>` (the flag minus its verb, reconcile-common.js approvalKey).
const OVERWRITE_TOKEN = /^overwrite:(environmentVariable|connectionReference|customApi|duplicateRule):([\s\S]+)$/;
// `adopt:<kind>:<declared key>` and `adopt:<child kind>:<root key>/<slot>` approve binding ONE row that an earlier,
// unfinished protected create may have made and whose answer was lost (lib/managed-create-context.js judgeRows). The
// preflight prints them in the context's spelling (defaultApprovalToken): a root as adopt:<kind>:<port key>, a child as
// adopt:<child kind>:<encodeURIComponent(port key)>/<encodeURIComponent(slot)>, e.g.
//   adopt:duplicateRule:email
//   adopt:environmentVariableValue:contoso_apibase/value
//   adopt:customApiRequestParameter:contoso_calc/request%3Aa
//   adopt:duplicateRuleCondition:email/e
// Read only under the opt-in, checked against the App Spec (the root and the child must be declared) and normalized back
// to that spelling, so a key typed in another case still names the one row; a root's approval never covers its children.
// The same tokens with `@<row id>` appended adopt a row a maker made BEFORE the opt-in, at an id the plugin did not derive
// (configuration-protected.js adoptionOf), for an environment variable, a connection reference or a Custom API and their
// children. The id ties the approval to that one row, so it never binds a row deleted and made again, and a root token
// also carries `+<16 hex>` when the build would then change fields of that row, the first 16 hex of the SHA-256 of the
// list of field pointers it printed, so the approval lapses when that list changes, e.g.
//   adopt:customApi:contoso_calc@0b7c6f5e-0000-4000-8000-000000000001+3f2a9c0d1e2b4a59
//   adopt:customApiRequestParameter:contoso_calc/request%3Aa@0b7c6f5e-0000-4000-8000-000000000002
// The two meanings never meet: a plain approval lands in `rowApprovals` as `adopt:...` exactly as before, and an
// `@<row id>` one as `adopt-row:...` (the same text after the verb), a spelling no plain approval normalizes to, so a
// token read one way is never consumed the other way. A declared key may itself end in what reads like `@<id>`: when the
// whole text names a declared item AND the text before `@<id>` names another, the token is refused as ambiguous
// (CONFIGURATION_ADOPT_AMBIGUOUS) rather than read either way, and the stop never prints an `@<id>` approval that would
// read so (adoptionOf refuses that adoption, saying why). A plugin before this form reads the root suffix as part of the
// declared key, names no declared item and refuses the token before any write.
// A duplicate rule and its conditions are never adopted (adoptionOf), so their tokens keep only the plain reading,
// exactly as before this form: a rule or condition key may contain '@' (it is free text), and `odd@<id>` is just that key.
const ADOPT_AT = /^([\s\S]*)@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\+([0-9a-f]{16}))?$/i;
const ADOPT_CHILD_AT = /^([\s\S]*)@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ADOPT_ROOT_TOKEN = /^adopt:(environmentVariable|connectionReference|customApi|duplicateRule):([\s\S]+)$/;
const ADOPT_CHILD_TOKEN = /^adopt:(environmentVariableValue|customApiRequestParameter|customApiResponseProperty|duplicateRuleCondition):([\s\S]+)$/;
const ADOPT_CHILD_PARENT = Object.freeze({
  environmentVariableValue: 'environmentVariable', customApiRequestParameter: 'customApi', customApiResponseProperty: 'customApi', duplicateRuleCondition: 'duplicateRule',
});
function configurationAuthorizationKeys(tokens, spec) {
  const keys = new Set();
  const overwrite = new Set();
  const rowApprovals = new Set();
  const problems = [];
  const unclaimed = [];
  const declaredRoots = (kind) => {
    const [list, field] = TOKEN_ROOTS[kind];
    return Array.isArray(spec && spec[list]) ? spec[list].filter(isObject).map((e) => e[field]).filter(nonEmptyString) : [];
  };
  const declaredEntry = (kind, root) => {
    const [list, field] = TOKEN_ROOTS[kind];
    return (Array.isArray(spec && spec[list]) ? spec[list] : []).find((e) => isObject(e) && e[field] === root) || null;
  };
  const rootOf = (kind, name) => declaredRoots(kind).find((n) => (kind === 'duplicateRule' ? n === name : lower(n) === lower(name)));
  const decode = (text) => {
    try { return decodeURIComponent(text); } catch { return null; }
  };
  // The child's slot as the protected plan keys it (configuration-create-bindings.js planOf), or null when the App Spec
  // declares no such child: an environment variable's one value, a Custom API parameter or property by its lower-cased
  // unique name, a duplicate rule's condition by its key exactly.
  const slotOf = (childKind, entry, slot) => {
    if (childKind === 'environmentVariableValue') return slot === 'value' ? 'value' : null;
    if (childKind === 'duplicateRuleCondition') return (Array.isArray(entry.conditions) ? entry.conditions : []).some((c) => isObject(c) && c.key === slot) ? slot : null;
    const [prefix, list] = childKind === 'customApiRequestParameter' ? ['request:', entry.requestParameters] : ['response:', entry.responseProperties];
    const name = lower(slot).startsWith(prefix) ? lower(slot).slice(prefix.length) : null;
    return name && (Array.isArray(list) ? list : []).some((c) => isObject(c) && lower(c.uniqueName) === name) ? `${prefix}${name}` : null;
  };
  const protectedSpec = isObject(spec) && spec.configurationIdentity === 'stable-v1';
  for (const token of tokens || []) {
    const text = typeof token === 'string' ? token : '';
    const replace = OVERWRITE_TOKEN.exec(text);
    if (replace) {
      const [, kind, name] = replace;
      const root = rootOf(kind, name);
      if (!root) problems.push({ token: text, code: 'CONFIGURATION_AUTHORIZATION_UNKNOWN_ITEM' });
      else if (!protectedSpec) problems.push({ token: text, code: 'CONFIGURATION_OVERWRITE_UNPROTECTED' });
      else overwrite.add(`${kind}:${portKeyOf(kind, root)}`);
      continue;
    }
    const adoptRoot = ADOPT_ROOT_TOKEN.exec(text);
    if (adoptRoot) {
      const [, kind, name] = adoptRoot;
      const plain = rootOf(kind, name);
      const atRow = kind === 'duplicateRule' ? null : ADOPT_AT.exec(name);
      const atRoot = atRow ? rootOf(kind, atRow[1]) : undefined;
      if (plain && atRoot) { problems.push({ token: text, code: 'CONFIGURATION_ADOPT_AMBIGUOUS' }); continue; }
      const root = plain || atRoot;
      if (!root) { problems.push({ token: text, code: 'CONFIGURATION_AUTHORIZATION_UNKNOWN_ITEM' }); continue; }
      if (!protectedSpec) { problems.push({ token: text, code: 'CONFIGURATION_ADOPT_UNPROTECTED' }); continue; }
      rowApprovals.add(plain ? `adopt:${kind}:${portKeyOf(kind, root)}`
        : `adopt-row:${kind}:${portKeyOf(kind, root)}@${atRow[2].toLowerCase()}${atRow[3] ? `+${atRow[3].toLowerCase()}` : ''}`);
      continue;
    }
    const adoptChild = ADOPT_CHILD_TOKEN.exec(text);
    if (adoptChild) {
      const [, childKind, whole] = adoptChild;
      const parent = ADOPT_CHILD_PARENT[childKind];
      // Both parts are percent-encoded, so the one '/' is the separator; anything else is not a key the build printed.
      const named = (rest) => {
        const parts = rest.split('/');
        const name = parts.length === 2 ? decode(parts[0]) : null;
        const slot = parts.length === 2 ? decode(parts[1]) : null;
        if (!nonEmptyString(name) || !nonEmptyString(slot)) return { invalid: true };
        const root = rootOf(parent, name);
        return { root, child: root ? slotOf(childKind, declaredEntry(parent, root), slot) : null };
      };
      // Both readings, as for a root: the whole text (exactly as before the `@<row id>` form), and the text before a
      // trailing `@<id>` with that id (a printed slot is percent-encoded, '@' as %40, so a printed id is never part of it).
      const plain = named(whole);
      const atRow = childKind === 'duplicateRuleCondition' ? null : ADOPT_CHILD_AT.exec(whole);
      const withId = atRow ? named(atRow[1]) : { child: null };
      if (plain.child && withId.child) { problems.push({ token: text, code: 'CONFIGURATION_ADOPT_AMBIGUOUS' }); continue; }
      const found = plain.child || !withId.child ? plain : withId;
      if (found.invalid) { problems.push({ token: text, code: 'CONFIGURATION_ADOPT_INVALID' }); continue; }
      const { root, child } = found;
      const tail = `${childKind}:${encodeURIComponent(portKeyOf(parent, root))}/${encodeURIComponent(child)}`;
      if (!child) problems.push({ token: text, code: 'CONFIGURATION_AUTHORIZATION_UNKNOWN_ITEM' });
      else if (!protectedSpec) problems.push({ token: text, code: 'CONFIGURATION_ADOPT_UNPROTECTED' });
      else rowApprovals.add(found === plain ? `adopt:${tail}` : `adopt-row:${tail}@${atRow[2].toLowerCase()}`);
      continue;
    }
    const kind = text.slice(0, text.indexOf(':'));
    if (!has(TOKEN_FIELDS, kind)) { unclaimed.push(token); continue; }
    const rest = text.slice(kind.length + 1);
    const roots = declaredRoots(kind);
    const exact = kind === 'duplicateRule';
    const root = roots
      .filter((name) => (exact ? rest.startsWith(`${name}:`) : lower(rest).startsWith(`${lower(name)}:`)))
      .sort((a, b) => b.length - a.length)[0];
    if (!root) { problems.push({ token: text, code: 'CONFIGURATION_AUTHORIZATION_UNKNOWN_ITEM' }); continue; }
    let tail = rest.slice(root.length + 1);
    if (kind === 'customApi' && /^(request|response):/i.test(tail)) tail = lower(tail);
    if (!TOKEN_FIELDS[kind].test(tail)) { problems.push({ token: text, code: 'CONFIGURATION_AUTHORIZATION_INVALID' }); continue; }
    keys.add(`${kind}:${portKeyOf(kind, root)}:${tail}`);
  }
  return { keys, overwrite, rowApprovals, problems, unclaimed };
}

// The build runner's items for this feature: ONE data-model item and ONE solution-version item, whatever the
// number of declarations (per-kind detail never inflates the runner's counts).
function configurationPlanItems(spec) {
  const items = [];
  if (hasConfigurationDefinitions(spec)) items.push({ phase: 'data-model', label: 'configuration' });
  const solution = isObject(spec && spec.solution) ? spec.solution : {};
  if (solution.version !== undefined) items.push({ phase: 'solution', label: `solution version ${solution.uniqueName}` });
  return items;
}

const INTENT_LISTS = Object.freeze({
  environmentVariable: ['environmentVariables', 'schemaName', false],
  connectionReference: ['connectionReferences', 'logicalName', false],
  customApi: ['customApis', 'uniqueName', false],
  duplicateRule: ['duplicateDetectionRules', 'key', true],
});

function intentError(code, kind, key) {
  const error = new Error(`configuration intent ${kind} ${key}: ${code}`);
  error.code = code;
  return error;
}

// The ONE declaration a record is about. Zero or several matching entries is an error, raised before anything is
// written (the runtime computes every intent first).
function configurationIntentOf(spec, kind, key) {
  if (kind === 'solutionVersion') {
    const solution = isObject(spec && spec.solution) ? spec.solution : null;
    if (!solution || solution.version === undefined || solution.uniqueName !== key) throw intentError('CONFIGURATION_INTENT_NOT_FOUND', kind, key);
    return { uniqueName: solution.uniqueName, version: solution.version };
  }
  if (!has(INTENT_LISTS, kind)) throw intentError('CONFIGURATION_INTENT_KIND_UNKNOWN', kind, key);
  const [list, field, exact] = INTENT_LISTS[kind];
  const entries = Array.isArray(spec && spec[list]) ? spec[list] : [];
  const hits = entries.filter((e) => isObject(e) && typeof e[field] === 'string' && (exact ? e[field] === key : lower(e[field]) === lower(key)));
  if (hits.length !== 1) throw intentError(hits.length ? 'CONFIGURATION_INTENT_AMBIGUOUS' : 'CONFIGURATION_INTENT_NOT_FOUND', kind, key);
  return hits[0];
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Deterministic JSON: own keys sorted at every depth, arrays in order, JSON scalars only. Rejects what JSON would
// silently change (undefined, NaN, Infinity) and keys that could pollute a prototype when the text is parsed back.
function canonicalConfigurationJson(value) {
  const walk = (v, where) => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw intentError('CONFIGURATION_INTENT_NOT_CANONICAL', 'json', where);
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map((item, i) => walk(item, `${where}/${i}`)).join(',')}]`;
    if (typeof v === 'object') {
      const keys = Object.keys(v).sort();
      for (const k of keys) if (UNSAFE_KEYS.has(k)) throw intentError('CONFIGURATION_INTENT_NOT_CANONICAL', 'json', `${where}/${k}`);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(v[k], `${where}/${k}`)}`).join(',')}}`;
    }
    throw intentError('CONFIGURATION_INTENT_NOT_CANONICAL', 'json', where);
  };
  return walk(value, '');
}

const intentSha256 = (value) => require('./hash.js').sha256(Buffer.from(canonicalConfigurationJson(value), 'utf8'));

const CHILD_KINDS = Object.freeze({
  environmentVariable: () => 'environmentVariableValue',
  customApi: (slot) => (slot.startsWith('request:') ? 'customApiRequestParameter' : 'customApiResponseProperty'),
  duplicateRule: () => 'duplicateRuleCondition',
});

// The intent a child record hashes: a value child hashes only its root's identity and its slot (never the value,
// which can be a secret reference or guessable); other children hash their typed declaration, direction and parent.
function childIntent(kind, rootKey, slot, entry) {
  if (kind === 'environmentVariable') return { parent: portKeyOf(kind, rootKey), slot };
  if (kind === 'customApi') {
    const [direction, name] = [slot.slice(0, slot.indexOf(':')), slot.slice(slot.indexOf(':') + 1)];
    const list = direction === 'request' ? entry.requestParameters : entry.responseProperties;
    const child = (list || []).find((c) => isObject(c) && lower(c.uniqueName) === name);
    return { parent: portKeyOf(kind, rootKey), direction, declaration: child || null };
  }
  const condition = (entry.conditions || []).find((c) => isObject(c) && c.key === slot);
  return { parent: portKeyOf(kind, rootKey), declaration: condition || null };
}

// What deployment settings never contribute to an intent: an environment-specific value or connection.
function portableIntent(kind, entry) {
  if (!isObject(entry)) return entry;
  const out = { ...entry };
  if (kind === 'environmentVariable') { delete out.currentValue; delete out.value; }
  if (kind === 'connectionReference') delete out.connectionId;
  return out;
}

// The management records a build keeps for what THIS run confirmed: each root it created (or a maker adopted) and
// each child its read-back showed. A row merely found or matched is not recorded as created. A binding's childIds
// are only ever the children this run created and read back at their own ids (settle), so each is recorded as
// 'created' whatever its root's origin: a parameter added to an API an earlier build made is this run's create.
// `{kind, key, id, parentKey?, intentSha256, origin}`; the shared recorder adds format, app and environment scope.
function configurationManagedRecords(result, spec) {
  const records = [];
  for (const binding of (result && result.managedBindings) || []) {
    const rootRecorded = binding.origin === 'created' || binding.origin === 'adopted';
    if (!rootRecorded && !Object.keys(binding.childIds || {}).length && !Object.keys(binding.adoptedChildIds || {}).length) continue;
    const entry = configurationIntentOf(spec, binding.kind, binding.key);
    const rootKey = portKeyOf(binding.kind, binding.key);
    if (rootRecorded) records.push({ kind: binding.kind, key: rootKey, id: binding.id, intentSha256: intentSha256({ kind: binding.kind, intent: portableIntent(binding.kind, entry) }), origin: binding.origin });
    // A child the adoption policy allowed for a found root (reconcileChildRecords) is recorded as adopted: a read
    // never proves who created it.
    const children = [
      ...Object.entries(binding.childIds || {}).map(([slot, id]) => [slot, id, 'created']),
      ...Object.entries(binding.adoptedChildIds || {}).map(([slot, id]) => [slot, id, 'adopted']),
    ];
    for (const [slot, id, origin] of children) {
      const childKind = CHILD_KINDS[binding.kind] ? CHILD_KINDS[binding.kind](slot) : null;
      if (!childKind || !id) continue;
      records.push({ kind: childKind, key: `${rootKey}|${slot}`, id, parentKey: rootKey, intentSha256: intentSha256({ kind: childKind, intent: childIntent(binding.kind, binding.key, slot, entry) }), origin });
    }
  }
  return records;
}

// The portable declaration of one row, for a download: definitions only. Never a current value, a connection, a
// plug-in type, a custom connector id or a child's id (they are environment-specific or not representable).
function portableDeclaration(kind, remote) {
  const pick = (fields) => Object.fromEntries(fields.filter((f) => remote[f] !== undefined && remote[f] !== null).map((f) => [f, remote[f]]));
  if (kind === 'environmentVariable') return pick(['schemaName', 'name', 'type', 'description', 'defaultValue', 'isRequired', 'valueSchema', 'connectorId', 'parameterKey']);
  if (kind === 'connectionReference') return pick(['logicalName', 'name', 'description', 'connectorId']);
  if (kind === 'customApi') {
    const child = (c, isRequest) => ({ uniqueName: c.uniqueName, type: c.type, ...(isRequest ? { isOptional: c.isOptional === true } : {}), ...(c.entityLogicalName ? { entityLogicalName: c.entityLogicalName } : {}), ...Object.fromEntries(LABEL_FIELDS.filter((f) => c[f] != null).map((f) => [f, c[f]])) });
    return {
      ...pick(['uniqueName', 'binding', 'boundEntityLogicalName', 'isFunction', 'allowedProcessingSteps', 'enabledForWorkflow', 'isPrivate', 'executePrivilegeName', ...LABEL_FIELDS]),
      requestParameters: (remote.requestParameters || []).map((c) => child(c, true)),
      responseProperties: (remote.responseProperties || []).map((c) => child(c, false)),
    };
  }
  return null;
}

// Read the configuration rows a download's shared manifest names (`entries`: [{kind, key, id}]) and project each
// to a portable declaration. A failed read is reported (lossy), never an empty list; a manifest entry locates a
// row, it does not prove the row is the app's. Duplicate rules are reported lossy: their condition keys are not
// recoverable from the platform. `{declarations: {environmentVariables?, connectionReferences?, customApis?},
// unknown: [{kind, key, code}], lossy: [{kind, key, code}]}`
async function readConfigurationForDownload(sdk, entries) {
  const lists = { environmentVariable: 'environmentVariables', connectionReference: 'connectionReferences', customApi: 'customApis' };
  const declarations = {};
  const unknown = [];
  const lossy = [];
  for (const entry of entries || []) {
    if (!entry || !has(MEMBERSHIP_TABLES, entry.kind) || !nonEmptyString(entry.id)) continue;
    if (entry.kind === 'duplicateRule') { lossy.push({ kind: entry.kind, key: entry.key, code: 'DUPLICATE_RULE_KEYS_NOT_RECOVERABLE' }); continue; }
    let remote;
    try {
      remote = await sdk.fetchArtifact(entry.kind, entry.id, { overwrite: true });
    } catch (error) {
      unknown.push({ kind: entry.kind, key: entry.key, code: codeOf(error) === 'ARTIFACT_NOT_FOUND' ? 'CONFIGURATION_ROW_ABSENT' : 'CONFIGURATION_READ_UNKNOWN' });
      continue;
    }
    const declaration = remote && portableDeclaration(entry.kind, remote);
    if (!declaration) { unknown.push({ kind: entry.kind, key: entry.key, code: 'CONFIGURATION_READ_UNKNOWN' }); continue; }
    (declarations[lists[entry.kind]] = declarations[lists[entry.kind]] || []).push(declaration);
  }
  return { declarations, unknown, lossy };
}

// ---------------------------------------------------------------------------------------------
// Verify. Checks: {kind, key, name, ok, code?, fields?}; `name` is 'definition', 'binding', 'value',
// 'implementation', 'publication' or 'version'. A check never carries a value.

// A typed stop's code as an exact port raised it: the lower-case codes of the binding store and the create identity
// (`configuration-row-not-found`, `managed-settlement-pending`, `create-identity-unverified`) as well as the SDK's own.
const TYPED_CODE = /^[a-z][a-z0-9-]{2,63}$/;
const typedCodeOf = (error) => (error && typeof error.code === 'string' && TYPED_CODE.test(error.code) ? error.code : codeOf(error));

// The row an exact port's binding names, read at that id; any other answer of the port is not a row to verify.
async function locateExactly(ctx, port, kind, key) {
  const resolved = await port.resolve({ kind, key: portKeyOf(kind, key) });
  if (!resolved || resolved.state !== 'present' || typeof resolved.id !== 'string' || !resolved.id) throw identityStop('create-identity-unverified');
  await refuseLocalDraft(ctx.sdk, kind, resolved.id);
  // A protected rule's conditions are paired at the ids its binding holds, as the build's plan pairs them (lib/configuration-protected.js
  // locateItem): a swap of two bound rows' criteria is an edit the build refuses (configuration-edit-unsupported), so verify must not
  // pass it. Content pairing alone would. Only a rule takes them: the other kinds are compared as before.
  const boundChildIds = kind === 'duplicateRule' && resolved.childIds && typeof resolved.childIds === 'object' ? resolved.childIds : undefined;
  return {
    id: resolved.id, remote: await ctx.sdk.fetchArtifact(kind, resolved.id, { overwrite: true }), origin: 'resolved',
    ...(boundChildIds ? { childIds: boundChildIds } : {}),
    ...(kind === 'duplicateRule' && resolved.buildRefusal ? { buildRefusal: resolved.buildRefusal } : {}),
  };
}

// What a protected rule's definition check names, as the union of two judgments: the content comparison (`compared`, whose pointers
// keep the order the unprotected check reports them in) and the build's own (`found.buildRefusal`, from the port: it refuses every
// edit of a protected rule). Placement rules, so a consumer that reads the fields sees one stable shape:
//   - the comparison's pointers stay where they are; a pointer only the build's judgment adds goes after them;
//   - each `/conditions/<key>` follows `/conditions` at once, in declaration order: a declared condition the plan would create
//     (a new or renamed key) or whose bound row no longer holds its criteria;
//   - a removal (a bound row no longer declared, an extra row) names `/conditions` alone;
//   - `/definition` only when the build refuses and nothing above says what: a state change the declaration does not name.
// A content refusal does not hide a build refusal: the build still refuses, so the check is DRIFT, naming the root pointer when
// the refusal is a root field (these refusals stop the comparison before it names anything).
const CONTENT_REFUSAL_POINTER = { DUPLICATE_RULE_TABLE_IMMUTABLE: '/matchingEntity', DUPLICATE_RULE_NAME_CONFLICT: '/entity', CONFIGURATION_CHILD_IDENTITY_AMBIGUOUS: '/conditions' };

function ruleDriftFields(entry, found, compared) {
  const refusal = found.buildRefusal;
  const out = compared.refusal
    ? (CONTENT_REFUSAL_POINTER[compared.refusal] ? [CONTENT_REFUSAL_POINTER[compared.refusal]] : [])
    : compared.changes.filter((c) => !c.binding).map((c) => c.pointer);
  if (refusal || out.includes('/conditions')) {
    const keyed = conditionDriftPointers(entry, found.remote, found.childIds, new Set(refusal ? refusal.created : []));
    if (!out.includes('/conditions') && (keyed.length || (refusal && refusal.removed))) out.push('/conditions');
    const at = out.indexOf('/conditions');
    if (at >= 0) out.splice(at + 1, 0, ...keyed.filter((pointer) => !out.includes(pointer)));
  }
  return refusal && !out.length ? ['/definition'] : out;
}

// The declared conditions of a protected rule that the build's plan would create (`created`, by key), or whose bound row no
// longer holds their criteria, as drift pointers (`/conditions/<key>`), in declaration order, so a failing check names them.
// `bound` is the binding's slot -> id (slot = condition key). A bound row that is gone never gets here: the port reads every
// bound row at its id (configuration-row-not-found).
function conditionDriftPointers(entry, remote, bound, created = new Set()) {
  const rows = Array.isArray(remote.conditions) ? remote.conditions : [];
  const out = [];
  for (const d of Array.isArray(entry.conditions) ? entry.conditions : []) {
    if (created.has(d.key)) { out.push(`/conditions/${d.key}`); continue; }
    const id = has(bound, d.key) ? bound[d.key] : null;
    const row = id ? rows.find((r) => ref(r.id) === ref(id)) : null;
    if (row && !describes(d, row)) out.push(`/conditions/${d.key}`);
  }
  return out;
}
async function verifyKind(ctx, kindPlan, entries, checks, onFound) {
  for (const entry of entries) {
    const { kind } = kindPlan;
    const key = kindPlan.key(entry);
    // Under an exact port (protected configuration) verify asks only it: the row its binding holds, read at that id, or a
    // typed reason there is none (lib/configuration-protected.js protectedVerifyPort). Never a name, and the reason is
    // reported as the port gave it — a gone bound row is configuration-row-not-found, not a missing name.
    const exactPort = exactPortOf(ctx, kind);
    let found;
    try {
      found = exactPort
        ? await locateExactly(ctx, exactPort, kind, key)
        : await locate({ ...ctx, managed: ctx.managed && { lookup: ctx.managed.lookup } }, kind, key, kindPlan.identity(entry));
    } catch (error) {
      checks.push({ kind, key, name: 'definition', ok: false, code: exactPort ? typedCodeOf(error) : codeOf(error) });
      continue;
    }
    if (!found) { checks.push({ kind, key, name: 'definition', ok: false, code: 'NOT_FOUND' }); continue; }
    // A namesake at another id, or a row the build may not adopt, is not this declaration's row.
    if (found.refusal) { checks.push({ kind, key, name: 'definition', ok: false, code: found.refusal }); continue; }
    if (onFound) onFound(entry, found);
    const compared = kindPlan.compare(entry, found.remote, ctx, found.childIds);
    // A protected rule the build refuses is DRIFT whatever the comparison said (ruleDriftFields); otherwise a refusal stands.
    const ruleRefused = kind === 'duplicateRule' && found.buildRefusal;
    if (compared.refusal && !ruleRefused) { checks.push({ kind, key, name: 'definition', ok: false, code: compared.refusal }); continue; }
    const fields = kind === 'duplicateRule' && found.childIds ? ruleDriftFields(entry, found, compared) : compared.changes.filter((c) => !c.binding).map((c) => c.pointer);
    const bindingDrift = (compared.changes || []).filter((c) => c.binding).map((c) => c.pointer);
    checks.push(fields.length ? { kind, key, name: 'definition', ok: false, code: 'DRIFT', fields } : { kind, key, name: 'definition', ok: true });
    const bindings = bindingsOf(ctx);
    const bound = kind === 'environmentVariable' ? bindings.environmentVariables.has(lower(key))
      : kind === 'connectionReference' ? bindings.connectionReferences.has(lower(key)) : false;
    if (bound) checks.push(bindingDrift.length ? { kind, key, name: 'binding', ok: false, code: 'BINDING_DRIFT' } : { kind, key, name: 'binding', ok: true });
    const remote = found.remote;
    if (kind === 'environmentVariable' && remote.isRequired && remote.defaultValue == null && !(remote.currentValue && remote.currentValue.value != null)) {
      checks.push({ kind, key, name: 'value', ok: false, code: 'ENVIRONMENT_VARIABLE_VALUE_MISSING' });
    }
    if (kind === 'customApi') {
      checks.push(remote.pluginTypeId ? { kind, key, name: 'implementation', ok: true } : { kind, key, name: 'implementation', ok: false, code: 'CUSTOM_API_IMPLEMENTATION_UNPROVEN' });
    }
    if (kind === 'duplicateRule' && ruleStatus(entry, remote) === 'published') {
      checks.push(remote.status === 'published' ? { kind, key, name: 'publication', ok: true } : { kind, key, name: 'publication', ok: false, code: 'DUPLICATE_RULE_NOT_PUBLISHED' });
    }
  }
}

async function verifySolutionVersion(spec, ctx) {
  const solution = isObject(spec.solution) ? spec.solution : {};
  if (solution.version === undefined) return [];
  const key = solution.uniqueName;
  try {
    const current = await readSolution(ctx.sdk, key);
    if (!current) return [{ kind: 'solutionVersion', key, name: 'version', ok: false, code: 'SOLUTION_NOT_FOUND' }];
    return [current.version === solution.version ? { kind: 'solutionVersion', key, name: 'version', ok: true } : { kind: 'solutionVersion', key, name: 'version', ok: false, code: 'DRIFT' }];
  } catch (error) {
    return [{ kind: 'solutionVersion', key, name: 'version', ok: false, code: codeOf(error) }];
  }
}

async function verifyConfiguration(spec, ctx) {
  const checks = [];
  if (!usesConfiguration(spec)) return checks;
  const bindings = bindingsOf(ctx);
  if (Array.isArray(spec.environmentVariables)) {
    const parents = new Map();
    await verifyKind(ctx, variablePlan(bindings, parents), topologicalVariables(spec.environmentVariables), checks,
      (entry, found) => parents.set(lower(entry.schemaName), { id: found.id }));
  }
  if (Array.isArray(spec.connectionReferences)) await verifyKind(ctx, referencePlan(bindings), spec.connectionReferences, checks);
  if (Array.isArray(spec.customApis)) await verifyKind(ctx, customApiPlan, spec.customApis, checks);
  if (Array.isArray(spec.duplicateDetectionRules)) await verifyKind(ctx, duplicateRulePlan, spec.duplicateDetectionRules, checks);
  checks.push(...await verifySolutionVersion(spec, ctx));
  return checks;
}

// What a teardown says about the configuration kinds. A teardown never deletes them: nothing proves this
// app owns an environment variable, a connection reference, a Custom API or a duplicate rule (another app
// or flow in the environment can use the same item), so each declared item is named as kept. Only names
// are printed, never a value, a default or a connector. A Custom API bound to a table the spec creates
// (not `existing: true`) blocks that table's delete in Dataverse, so its line says so.
function configurationTeardownNotes(spec) {
  if (!isObject(spec)) return [];
  const kept = 'kept: a teardown does not delete configuration items it cannot prove this app owns';
  const made = new Set((Array.isArray(spec.entities) ? spec.entities : [])
    .filter((e) => isObject(e) && e.existing !== true && nonEmptyString(e.schemaName))
    .map((e) => lower(e.schemaName)));
  const list = (name) => (Array.isArray(spec[name]) ? spec[name].filter(isObject) : []);
  const notes = [];
  for (const v of list('environmentVariables')) notes.push(`environment variable ${v.schemaName} ${kept}`);
  for (const r of list('connectionReferences')) notes.push(`connection reference ${r.logicalName} ${kept}`);
  for (const api of list('customApis')) {
    const table = nonEmptyString(api.boundEntityLogicalName) ? lower(api.boundEntityLogicalName) : null;
    notes.push(table && made.has(table)
      ? `Custom API ${api.uniqueName} ${kept}; it is bound to ${table}, so delete the Custom API first or the table's delete is refused`
      : `Custom API ${api.uniqueName} ${kept}`);
  }
  for (const rule of list('duplicateDetectionRules')) notes.push(`duplicate detection rule ${rule.key} ${kept}`);
  return notes;
}

// ---- An injected stable-id create port, as this module would take it ----
// Not used by the plugin in this release: without the protected opt-in the configuration kinds use the plain create path
// (defaultCreates), and under it the protected port (configuration-protected.js); no injected stable-id module is part of
// the plugin. These adapters run only for a caller that injects the stable-id functions
// itself (configurationContext `fence`: `intentFor`, `resolveProtectedTarget`, `createCreatesPortForSpec`), so this
// module loads none of them; configurationStableCreates (below) composes them into the configuration kinds' own port.
//
// The child slot of every intent is the string the helper sends as a childKey and as a later child's identity.slot:
//   environmentVariable 'contoso_apibase' -> 'value' (only when the deployment settings write a value with it)
//   customApi 'contoso_calc' -> 'request:<lower unique name>', 'response:<lower unique name>'
//   duplicateRule 'email' -> '<condition key>' (byte for byte)
// so a child the create of its root makes and the same child a later run adds are one id when the injected port keys
// a child on its parent's id, its kind and its own key parts.
const CHILD_KIND_OF_SLOT = Object.freeze({
  environmentVariable: () => 'environmentVariableValue',
  customApi: (slot) => (slot.startsWith('request:') ? 'customApiRequestParameter' : 'customApiResponseProperty'),
  duplicateRule: () => 'duplicateRuleCondition',
});

// One intent per declared artifact, under the port key the helper sends (portKeyOf). `boundIdOf(kind, portKey)` answers
// the id a recorded binding holds (or undefined): a bound artifact keeps that id, and its children derive from it.
// `solution` is the scope's solution when the caller names one (configurationStableCreates); else the spec's.
function configurationCreateIntents(spec, { intentFor, bindings, boundIdOf, solution: scopeSolution } = {}) {
  if (typeof intentFor !== 'function') throw new TypeError('configurationCreateIntents: intentFor must be a function');
  const solution = nonEmptyString(scopeSolution) ? scopeSolution : spec && spec.solution && spec.solution.uniqueName;
  if (!nonEmptyString(solution)) throw new TypeError('configurationCreateIntents: the spec names no solution');
  const scope = { kind: 'solution', solution };
  const intents = [];
  const add = (kindPlan, list, declarationOf, childDeclarationOf) => {
    for (const entry of Array.isArray(list) ? list : []) {
      const kind = kindPlan.kind;
      const key = portKeyOf(kind, kindPlan.key(entry));
      const slots = kindPlan.childKeys ? kindPlan.childKeys(entry) : [];
      const children = slots.map((slot) => ({ locator: slot, childKind: CHILD_KIND_OF_SLOT[kind](slot), declaration: childDeclarationOf(entry, slot) }));
      const boundId = typeof boundIdOf === 'function' ? boundIdOf(kind, key) : undefined;
      intents.push(intentFor(kind, { key, scope, declaration: declarationOf(entry), children, ...(boundId ? { boundId } : {}) }));
    }
  };
  const named = (list, slot) => (list || []).find((c) => lower(c.uniqueName) === slot.slice(slot.indexOf(':') + 1));
  add(variablePlan(bindings || { environmentVariables: new Map(), connectionReferences: new Map() }, new Map()), spec.environmentVariables, (e) => ({ schemaName: e.schemaName }), () => ({}));
  add(referencePlan(bindings || { environmentVariables: new Map(), connectionReferences: new Map() }), spec.connectionReferences, (e) => ({ logicalName: e.logicalName }), () => ({}));
  add(customApiPlan, spec.customApis, (e) => ({ uniqueName: e.uniqueName }), (e, slot) => ({ uniqueName: (named(slot.startsWith('request:') ? e.requestParameters : e.responseProperties, slot) || {}).uniqueName }));
  add(duplicateRulePlan, spec.duplicateDetectionRules, (e) => ({ key: e.key }), (e, slot) => ({ key: slot }));
  return intents;
}

// The context a row at the derived id must show to be this artifact (what the injected resolver compares).
function expectedContextOf(spec, kind, key) {
  const find = (list, of) => (Array.isArray(list) ? list : []).find((e) => portKeyOf(kind, of(e)) === key);
  if (kind === 'environmentVariable') { const e = find(spec.environmentVariables, (x) => x.schemaName); return e ? { schemaName: e.schemaName } : {}; }
  if (kind === 'connectionReference') { const e = find(spec.connectionReferences, (x) => x.logicalName); return e ? { logicalName: e.logicalName } : {}; }
  if (kind === 'customApi') { const e = find(spec.customApis, (x) => x.uniqueName); return e ? { uniqueName: e.uniqueName } : {}; }
  if (kind === 'duplicateRule') {
    const e = find(spec.duplicateDetectionRules, (x) => x.key);
    // The matching table is compared only when the declaration names it. Omitted, it means "keep the rule's own" on
    // an update (the planner never changes it), so the base table, which is only the default of a NEW rule, must not
    // be asked of a rule that already exists at its id.
    if (!e) return {};
    return { baseEntity: e.entity, ...(nonEmptyString(e.matchingEntity) ? { matchingEntity: e.matchingEntity } : {}) };
  }
  return {};
}

// The port the helper is handed. A pass-through port is returned unchanged (no `resolve`: the helper's plain name
// lookup, exactly as before). A stable port gains `resolve`, which reads the derived (or bound) id before any name
// lookup. `readByName` answers no match on purpose: the helper runs its own name lookup right after an 'absent'
// and refuses a namesake at another id (create-identity-conflict), so the injected one would only read it twice.
// Every typed stop of the resolver (unverified, conflict, completion-required) reaches the helper unchanged.
function configurationCreates(port, { resolveProtectedTarget, provision, spec, boundIdOf } = {}) {
  if (!port || port.mode !== 'stable') return port;
  if (typeof resolveProtectedTarget !== 'function') throw new TypeError('configurationCreates: resolveProtectedTarget must be a function');
  return {
    mode: port.mode,
    run: port.run,
    protects: port.protects,
    identityFor: port.identityFor,
    async resolve({ kind, key } = {}) {
      const planned = port.identityFor(kind, key);
      if (!planned) throw identityStop('create-identity-invalid');
      const boundId = typeof boundIdOf === 'function' ? boundIdOf(kind, key) : undefined;
      const answer = await resolveProtectedTarget({ provision, kind, key, id: planned.id, ...(boundId ? { boundId } : {}), expected: expectedContextOf(spec || {}, kind, key), readByName: async () => [] });
      return { state: answer.state, id: answer.id };
    },
  };
}

// ---- The configuration kinds' own stable port (injected stable-id functions only) ----
// The configuration step builds its own port rather than taking the build's: the build's catalog keys its kinds (views,
// forms, charts, ...) like their call sites, and these kinds are keyed here (portKeyOf, the value slot that only the
// deployment settings decide), so only this module can say what each create is. A build port that already protects
// every configuration kind AND resolves (configurationAcceptsPort) is used as is; any other is set aside, never half
// used. The build's port in this release is the plain pass-through, which never qualifies; under the protected opt-in the
// build hands this step the protected port (configuration-protected.js), which does.
//
// Every configuration kind is protected as a NEW feature declaration (the injected port's `featureKinds`), with or
// without the spec's `createIdentity` option: `shippedKinds` would leave them unprotected for a spec without the
// option, and those specs are exactly the ones a standalone run or an existing App Spec carries.
const CONFIGURATION_CREATE_KINDS = Object.freeze(['environmentVariable', 'connectionReference', 'customApi', 'duplicateRule']);

// The scope of an item a run makes without naming a solution (the standalone CLI without --solution). A component
// created without a solution header lands in the environment's Default Solution, whose unique name is "Default": the
// platform reserves it, so no maker solution has that name and the scope cannot collide with one. A run that names a
// solution has that solution's scope, so the same reference made with and without --solution is two identities: the
// second run finds the first one's row by name at another id. The CLI, which keeps no record of its rows, reuses it
// (configurationContext reuseNamesakes); a build would refuse it (CONFIGURATION_IDENTITY_FOREIGN). Neither re-creates it.
// See: https://learn.microsoft.com/en-us/power-apps/maker/data-platform/solutions-overview#default-solutions
const STANDALONE_SOLUTION = 'Default';

// The stable-id functions for one context: only the ones a caller injects (`ctx.fence`), never a module of the plugin.
// No injected stable-id module is part of the plugin, so nothing here loads one; a context without `fence` (every build
// and every standalone run) gets the plain pass-through (defaultCreates) unless the build hands it the protected port.
const fenceOf = (ctx) => ctx.fence || null;

// Whether a port the build hands over can stand in for this module's own: it protects every configuration kind and
// reads an identity's own id before any name (`resolve`). The plain pass-through and a port of the build's own kinds
// cannot.
function configurationAcceptsPort(port) {
  return !!(port && typeof port.run === 'function' && typeof port.resolve === 'function' && typeof port.protects === 'function'
    && CONFIGURATION_CREATE_KINDS.every((kind) => port.protects(kind)));
}

// The stable port for one spec: an intent per declaration (configurationCreateIntents) in the scope of the spec's
// solution, else the solution the run names, else the Default Solution; protected as featureKinds; wrapped with the
// resolver (configurationCreates). A spec that declares nothing of these kinds gets the injected pass-through.
function configurationStableCreates(spec, { fence, sdk, bindings, solutionUniqueName, boundIdOf } = {}) {
  if (!fence || typeof fence.createCreatesPortForSpec !== 'function' || typeof fence.intentFor !== 'function' || typeof fence.resolveProtectedTarget !== 'function') {
    throw new TypeError('configurationStableCreates: fence must hold createCreatesPortForSpec, intentFor and resolveProtectedTarget');
  }
  const own = spec && spec.solution && spec.solution.uniqueName;
  const solution = nonEmptyString(own) ? own : nonEmptyString(solutionUniqueName) ? solutionUniqueName : STANDALONE_SOLUTION;
  const intents = configurationCreateIntents(spec, { intentFor: fence.intentFor, bindings, boundIdOf, solution });
  const port = fence.createCreatesPortForSpec(spec, { intents, featureKinds: [...CONFIGURATION_CREATE_KINDS] });
  return configurationCreates(port, { resolveProtectedTarget: fence.resolveProtectedTarget, provision: sdk, spec, boundIdOf });
}

// Build this context's default port the first time a plan needs one (a caller's own port wins): the plain pass-through,
// or the stable port when the caller injected the stable-id functions.
function planDefaultPort(spec, ctx) {
  if (portOf(ctx) || ctx[DEFAULT_PORT]) return;
  const fence = fenceOf(ctx);
  if (!fence) { defaultCreates(ctx); return; }
  const port = configurationStableCreates(spec || {}, { fence, sdk: ctx.sdk, bindings: bindingsOf(ctx), solutionUniqueName: ctx.solutionUniqueName, boundIdOf: ctx.boundIdOf });
  Object.defineProperty(ctx, DEFAULT_PORT, { value: port, enumerable: false });
}

module.exports = {
  CONFIGURATION_CREATE_KINDS,
  configurationAcceptsPort,
  configurationStableCreates,
  configurationCreateIntents,
  configurationCreates,
  configurationTeardownNotes,
  CONFIGURATION_MIN_VERSION,
  MAX_PUBLISHED_RULES_PER_TABLE,
  usesConfiguration,
  validateConfiguration,
  readDeploymentBindings,
  planConfiguration,
  planEnvironmentVariables,
  planConnectionReferences,
  planCustomApis,
  planDuplicateRules,
  planSolutionVersion,
  applyConfiguration,
  applyEnvironmentVariables: applyConfiguration,
  applyConnectionReferences: applyConfiguration,
  applyCustomApis: applyConfiguration,
  applyDuplicateRules: applyConfiguration,
  applySolutionVersion: applyConfiguration,
  verifyConfiguration,
  verifySolutionVersion,
  classifyFailure: (error, { singleWrite = false } = {}) => ({ code: codeOf(error), outcome: outcomeOf(error, singleWrite) }),
  hasConfigurationFields,
  hasConfigurationDefinitions,
  configurationReadiness,
  observeConfiguration,
  configurationPageBlockers,
  configurationContext,
  configurationDestructive,
  configurationHaltMessage,
  configurationAuthorizationKeys,
  // The `--authorize` flags spelled as one shell argument each (commandArgOrPlaceholder): the protected preflight's
  // overwrite approval names a duplicate rule's key, which may hold white space or quotes.
  authorizeFlags,
  runConfigurationStep,
  configurationBlocking,
  configurationPlanItems,
  configurationIntentOf,
  canonicalConfigurationJson,
  configurationManagedRecords,
  readConfigurationForDownload,
  MEMBERSHIP_TABLES,
  CHILD_MEMBERSHIP_TABLES,
  CLASSIC_MEMBERSHIP_TYPES,
  // The pure helpers the protected configuration driver (lib/configuration-create-bindings.js) derives its row plan
  // from, so a planned row and the artifact the SDK pushes come from one definition.
  buildArtifact,
  describes,
  normalCondition,
  portableIntent,
  portKeyOf,
  ruleStatus,
};

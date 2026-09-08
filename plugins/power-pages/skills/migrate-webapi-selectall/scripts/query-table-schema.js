#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  getAuthToken,
  odataGetAll,
  validateDataverseEnvironmentUrl,
} = require('../../../scripts/lib/validation-helpers');

// Refresh the token periodically so long runs never expire.
const TABLES_PER_TOKEN_REFRESH = 4;
// Retry ceilings bound transient Dataverse throttling delays safely.
const MAX_RETRY_ATTEMPTS = 6;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

const HELP = `
Retrieves Dataverse table schema for Web API wildcard migration analysis.

Usage:
  node query-table-schema.js --project-root <path> --environment-url <url>
    (--table <name> | --tables-file <file>) --output <file>

Options:
  --project-root     Power Pages project root; input and output stay inside it
  --environment-url  Dataverse environment URL
  --table            Logical name or entity set name; repeatable
  --tables-file      File of identifiers, one per line or a JSON array
  --output           JSON schema snapshot to write, inside the project root
  --help             Show this help message

Exit codes:
  0  Snapshot written; prints { output, tableCount } to stdout
  1  Invalid arguments, unresolved table, auth failure, or query failure

Example:
  node query-table-schema.js --project-root . --environment-url https://contoso.crm.dynamics.com --table account --output docs/webapi-selectall-migration/table-schema.json
`;

function parseArgs(argv) {
  const options = { tables: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}.`);
    }
    index += 1;
    if (argument === '--table') {
      options.tables.push(value);
    } else if (argument === '--tables-file') {
      options.tablesFile = value;
    } else if (argument === '--environment-url') {
      options.environmentUrl = value;
    } else if (argument === '--project-root') {
      options.projectRoot = value;
    } else if (argument === '--output') {
      options.output = value;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isTransientError(error) {
  return /\b(?:408|429|500|502|503|504)\b|ECONNRESET|ETIMEDOUT|socket hang up/i
    .test(String(error?.message || error));
}

async function getAllWithRetry(getAll, url, token, wait = sleep) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await getAll(url, token);
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === MAX_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      await wait(Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** attempt)));
    }
  }
  throw lastError;
}

function realPath(candidate) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(candidate)
    : fs.realpathSync(candidate);
}

function resolveThroughExistingAncestor(candidate) {
  const unresolved = [];
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Unable to resolve an existing path ancestor.');
    }
    unresolved.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(realPath(current), ...unresolved);
}

function isStrictlyInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative);
}

function resolveOutputPath(projectRoot, candidate) {
  // Canonical paths prevent symlink and junction escapes.
  const resolved = resolveThroughExistingAncestor(candidate);
  if (resolved === projectRoot ||
      (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())) {
    throw new Error('Output must be a file inside the project root.');
  }
  if (!isStrictlyInside(projectRoot, resolved)) {
    throw new Error('Output must remain inside the project root.');
  }
  return resolved;
}

function metadataUrl(environmentUrl, resource, select) {
  const url = new URL(`${environmentUrl}/api/data/v9.2/${resource}`);
  url.searchParams.set('$select', select);
  return url.href;
}

function buildMetadataUrls(environmentUrl, logicalName) {
  const escaped = logicalName.replace(/'/g, "''");
  const resource = `EntityDefinitions(LogicalName='${escaped}')`;
  return {
    attributes: metadataUrl(
      environmentUrl,
      `${resource}/Attributes`,
      'LogicalName,AttributeType,IsValidForRead,IsValidForCreate,IsValidForUpdate'
    ),
    oneToMany: metadataUrl(
      environmentUrl,
      `${resource}/OneToManyRelationships`,
      'SchemaName,ReferencingEntity,ReferencedEntity,ReferencingAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntityNavigationPropertyName'
    ),
    manyToOne: metadataUrl(
      environmentUrl,
      `${resource}/ManyToOneRelationships`,
      'SchemaName,ReferencingEntity,ReferencedEntity,ReferencingAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntityNavigationPropertyName'
    ),
    manyToMany: metadataUrl(
      environmentUrl,
      `${resource}/ManyToManyRelationships`,
      'SchemaName,Entity1LogicalName,Entity2LogicalName,Entity1NavigationPropertyName,Entity2NavigationPropertyName'
    ),
  };
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (value && typeof value.Value === 'boolean') return value.Value;
  return null;
}

function addNavigation(output, seen, navigation) {
  if (!navigation.name || !navigation.targetLogicalName) return;
  const key = `${navigation.name}:${navigation.targetLogicalName}`;
  if (seen.has(key)) return;
  seen.add(key);
  output.push(navigation);
}

function normalizeTableMetadata(definition, attributes, relationships, manyToMany) {
  const navigationProperties = [];
  const seenNavigation = new Set();

  // Navigation names require relationship metadata for expansions.
  for (const relationship of relationships) {
    if (relationship.ReferencingEntity === definition.LogicalName) {
      addNavigation(navigationProperties, seenNavigation, {
        name: relationship.ReferencingEntityNavigationPropertyName,
        targetLogicalName: relationship.ReferencedEntity,
        lookupAttribute: relationship.ReferencingAttribute,
        relationship: relationship.SchemaName,
      });
    }
    if (relationship.ReferencedEntity === definition.LogicalName) {
      addNavigation(navigationProperties, seenNavigation, {
        name: relationship.ReferencedEntityNavigationPropertyName,
        targetLogicalName: relationship.ReferencingEntity,
        lookupAttribute: null,
        relationship: relationship.SchemaName,
      });
    }
  }

  for (const relationship of manyToMany) {
    if (relationship.Entity1LogicalName === definition.LogicalName) {
      addNavigation(navigationProperties, seenNavigation, {
        name: relationship.Entity1NavigationPropertyName,
        targetLogicalName: relationship.Entity2LogicalName,
        lookupAttribute: null,
        relationship: relationship.SchemaName,
      });
    }
    if (relationship.Entity2LogicalName === definition.LogicalName) {
      addNavigation(navigationProperties, seenNavigation, {
        name: relationship.Entity2NavigationPropertyName,
        targetLogicalName: relationship.Entity1LogicalName,
        lookupAttribute: null,
        relationship: relationship.SchemaName,
      });
    }
  }

  const normalizedAttributes = attributes
    .filter(attribute => attribute.LogicalName)
    .map(attribute => ({
      logicalName: attribute.LogicalName,
      attributeType: attribute.AttributeType || null,
      isValidForRead: booleanValue(attribute.IsValidForRead),
      isValidForCreate: booleanValue(attribute.IsValidForCreate),
      isValidForUpdate: booleanValue(attribute.IsValidForUpdate),
    }))
    .sort((left, right) => left.logicalName.localeCompare(right.logicalName));
  const lookupTypes = new Set(['Customer', 'Lookup', 'Owner']);
  const lookupReadProperties = normalizedAttributes
    .filter(attribute => lookupTypes.has(attribute.attributeType))
    .map(attribute => `_${attribute.logicalName}_value`);

  return {
    logicalName: definition.LogicalName,
    entitySetName: definition.EntitySetName,
    primaryIdAttribute: definition.PrimaryIdAttribute,
    attributes: normalizedAttributes,
    lookupReadProperties,
    navigationProperties: navigationProperties.sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

function resolveRequestedTables(definitions, requested) {
  const byIdentifier = new Map();
  for (const definition of definitions) {
    if (definition.LogicalName) {
      byIdentifier.set(definition.LogicalName.toLowerCase(), definition);
    }
    if (definition.EntitySetName) {
      byIdentifier.set(definition.EntitySetName.toLowerCase(), definition);
    }
  }
  const resolved = [];
  const missing = [];
  for (const identifier of requested) {
    const definition = byIdentifier.get(identifier.toLowerCase());
    if (!definition) {
      missing.push(identifier);
    } else if (!resolved.some(item => item.LogicalName === definition.LogicalName)) {
      resolved.push(definition);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Unknown table logical names or entity sets: ${missing.join(', ')}`);
  }
  return resolved;
}

async function queryTableSchemas(environmentUrl, requested, dependencies = {}) {
  const getToken = dependencies.getAuthToken || getAuthToken;
  const getAll = dependencies.odataGetAll || odataGetAll;
  const wait = dependencies.sleep || sleep;
  let token = getToken(environmentUrl);
  if (!token) {
    throw new Error('Authentication unavailable. Run az login --allow-no-subscriptions.');
  }
  const definitions = await getAllWithRetry(
    getAll,
    metadataUrl(
      environmentUrl,
      'EntityDefinitions',
      'LogicalName,EntitySetName,PrimaryIdAttribute'
    ),
    token,
    wait
  );
  const selected = resolveRequestedTables(definitions, requested);
  const tables = [];
  let queried = 0;

  for (let index = 0; index < selected.length; index += 1) {
    const definition = selected[index];
    if (queried > 0 && queried % TABLES_PER_TOKEN_REFRESH === 0) {
      token = getToken(environmentUrl);
      if (!token) throw new Error('Authentication expired while querying table schemas.');
    }
    const urls = buildMetadataUrls(environmentUrl, definition.LogicalName);
    const attributes = await getAllWithRetry(getAll, urls.attributes, token, wait);
    const oneToMany = await getAllWithRetry(getAll, urls.oneToMany, token, wait);
    const manyToOne = await getAllWithRetry(getAll, urls.manyToOne, token, wait);
    const manyToMany = await getAllWithRetry(getAll, urls.manyToMany, token, wait);
    const table = normalizeTableMetadata(
      definition,
      attributes,
      [...oneToMany, ...manyToOne],
      manyToMany
    );
    tables.push(table);
    queried += 1;
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tables: tables.sort((left, right) => left.logicalName.localeCompare(right.logicalName)),
  };
}

function validateOptions(options) {
  if (!options.environmentUrl || !options.projectRoot || !options.output) {
    throw new Error(
      'Usage: query-table-schema.js --project-root <path> --environment-url <url> ' +
      '--table <logical-name-or-entity-set> [--table <name>] ' +
      '[--tables-file <file>] --output <file>'
    );
  }
  const requestedProjectRoot = path.resolve(options.projectRoot);
  if (!fs.existsSync(requestedProjectRoot) ||
      !fs.statSync(requestedProjectRoot).isDirectory()) {
    throw new Error('Project root must be an existing directory.');
  }
  const projectRoot = realPath(requestedProjectRoot);
  const output = resolveOutputPath(projectRoot, path.resolve(options.output));
  let tablesFile = null;
  if (options.tablesFile) {
    const requestedTablesFile = path.resolve(options.tablesFile);
    if (!fs.existsSync(requestedTablesFile)) {
      throw new Error('Tables file must exist inside the project root.');
    }
    tablesFile = realPath(requestedTablesFile);
    if (!isStrictlyInside(projectRoot, tablesFile) ||
        !fs.statSync(tablesFile).isFile()) {
      throw new Error('Tables file must exist inside the project root.');
    }
  }
  return {
    environmentUrl: validateDataverseEnvironmentUrl(options.environmentUrl),
    projectRoot,
    output,
    tables: options.tables,
    tablesFile,
  };
}

function loadTableIdentifiers(options) {
  const values = [...options.tables];
  if (options.tablesFile) {
    const content = fs.readFileSync(options.tablesFile, 'utf8').trim();
    if (content.startsWith('[')) {
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error('Tables file JSON must contain an array.');
      }
      for (const value of parsed) values.push(value);
    } else if (content) {
      values.push(...content.split(/\r?\n/));
    }
  }
  const normalized = [...new Set(values.map(value => String(value).trim().toLowerCase())
    .filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error('At least one table identifier is required.');
  }
  for (const table of normalized) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table identifier: ${table}`);
    }
  }
  return normalized;
}

function writeAtomicJson(projectRoot, filePath, value) {
  const output = resolveOutputPath(projectRoot, filePath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, output);
  } catch (error) {
    // Never strand a partial .tmp file behind.
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  let validated;
  try {
    validated = validateOptions(parseArgs(process.argv.slice(2)));
    const tables = loadTableIdentifiers(validated);
    const result = await queryTableSchemas(validated.environmentUrl, tables);
    writeAtomicJson(validated.projectRoot, validated.output, result);
    process.stdout.write(`${JSON.stringify({
      output: path.relative(validated.projectRoot, validated.output).split(path.sep).join('/'),
      tableCount: result.tables.length,
    })}\n`);
  } catch (error) {
    const message = validated?.environmentUrl
      ? error.message.replaceAll(validated.environmentUrl, '<environment>')
      : error.message;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMetadataUrls,
  normalizeTableMetadata,
  parseArgs,
  queryTableSchemas,
  resolveRequestedTables,
  loadTableIdentifiers,
  validateOptions,
};

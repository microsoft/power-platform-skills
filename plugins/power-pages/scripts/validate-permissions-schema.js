#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');
const { validatePowerPagesSchema } = require('./lib/powerpages-schema-validator');
const { getEnvironmentUrl } = require('./lib/validation-helpers');

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
}

const projectRoot = getArg('projectRoot');
const failOnError = args.includes('--fail-on-error');
const validateDataverseRelationships = args.includes('--validate-dataverse-relationships');
const envUrlArg = getArg('envUrl');

if (!projectRoot) {
  console.error('Usage: node validate-permissions-schema.js --projectRoot <path> [--fail-on-error] [--validate-dataverse-relationships] [--envUrl <url>]');
  process.exit(1);
}

function createDataverseRelationshipResolver(envUrl) {
  const normalizedEnvUrl = envUrl.replace(/\/+$/, '');
  const cache = new Map();
  const dataverseRequestScript = path.join(__dirname, 'dataverse-request.js');

  return (entityLogicalName) => {
    const key = String(entityLogicalName || '').toLowerCase();
    if (cache.has(key)) {
      return cache.get(key);
    }

    const apiPath = `EntityDefinitions(LogicalName='${key}')/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute`;
    const output = execFileSync(process.execPath, [dataverseRequestScript, normalizedEnvUrl, 'GET', apiPath], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output);
    if (parsed.status !== 200) {
      throw new Error(parsed.error || `Dataverse returned status ${parsed.status}`);
    }

    const relationships = Array.isArray(parsed.data?.value) ? parsed.data.value.map(relationship => ({
      schemaName: relationship.SchemaName,
      referencedEntity: relationship.ReferencedEntity,
      referencingEntity: relationship.ReferencingEntity,
      referencingAttribute: relationship.ReferencingAttribute,
    })) : [];

    cache.set(key, relationships);
    return relationships;
  };
}

const validationOptions = {};
if (validateDataverseRelationships) {
  const envUrl = envUrlArg || getEnvironmentUrl();
  if (!envUrl) {
    console.error('Failed to determine Dataverse environment URL. Pass --envUrl <url> or run `pac env who` locally.');
    process.exit(1);
  }

  validationOptions.resolveRelationships = createDataverseRelationshipResolver(envUrl);
}

const result = validatePowerPagesSchema(path.resolve(projectRoot), validationOptions);
process.stdout.write(JSON.stringify(result, null, 2));

if (failOnError && result.summary.error > 0) {
  process.exit(2);
}

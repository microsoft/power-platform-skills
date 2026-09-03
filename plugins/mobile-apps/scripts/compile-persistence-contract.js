#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalJson,
  contractRevision,
  sha256Hex,
} = require('./lib/product-experience-contracts');

const DEFAULT_SCOPE = '.tmp/product-scope-contract.json';
const DEFAULT_ARCHITECTURE = '.tmp/architecture-decisions.json';
const DEFAULT_OUTPUT = '.tmp/persistence-contract.json';
const DATAVERSE_REALIZATIONS = new Set([
  'new-table',
  'existing-table',
  'choice-column',
  'parent-column',
  'child-rows',
]);
const LOCAL_REALIZATIONS = new Set(['local-configuration', 'view-model-only']);
const TRANSIENT_REALIZATIONS = new Set(['transient-ui-state', 'view-model-only']);
const FORBIDDEN_NON_DATAVERSE_ARTIFACTS = [
  '.tmp/dataverse-concepts.json',
  '.tmp/dataverse-foreground-planning-snapshot.json',
  '.tmp/dataverse-architect-evidence.json',
  '.tmp/dataverse-schema-contract.json',
  '.tmp/dataverse-reconciliation-scope.json',
  '.tmp/dataverse-execution-reconciliation.json',
  '.tmp/dataverse-operation-manifest.json',
  '.tmp/dataverse-publish-pending.json',
  '.datamodel-manifest.json',
  'offline-profile.json',
];

function conceptId(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) throw new Error(`Cannot derive a concept ID from ${value || '(empty)'}`);
  return normalized;
}

function ownerKind(owner) {
  if (owner === 'dataverse' || owner === 'local' || owner === 'transient') return owner;
  if (/^connector:[a-z0-9][a-z0-9-]*$/.test(owner)) return 'connector';
  throw new Error(`Unsupported persistence owner ${owner || '(missing)'}`);
}

function assertCompatible(entity, owner) {
  const kind = ownerKind(owner);
  const realization = entity.realization;
  const compatible = kind === 'dataverse' ? DATAVERSE_REALIZATIONS.has(realization)
    : kind === 'connector' ? realization === 'connector-source'
      : kind === 'local' ? LOCAL_REALIZATIONS.has(realization)
        : TRANSIENT_REALIZATIONS.has(realization);
  if (!compatible) {
    throw new Error(
      `${entity.name} realization ${realization} is incompatible with owner ${owner}`,
    );
  }
}

function deriveMode(owners) {
  const durableKinds = new Set(owners
    .map((entry) => ownerKind(entry.owner))
    .filter((kind) => kind !== 'transient'));
  if (durableKinds.has('dataverse') && durableKinds.size > 1) return 'mixed';
  if (durableKinds.has('dataverse')) return 'dataverse';
  if (durableKinds.has('connector')) return durableKinds.size > 1 ? 'mixed' : 'connector-only';
  return 'local-prototype';
}

function compilePersistenceContract(scope, architecture) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('Product Scope must be an object');
  }
  if (!architecture || typeof architecture !== 'object' || Array.isArray(architecture)) {
    throw new Error('Architecture decisions must be an object');
  }
  if (architecture.schemaVersion !== 1) {
    throw new Error('Architecture decisions schemaVersion must equal 1');
  }
  const entities = Array.isArray(scope.dataEntities) ? scope.dataEntities : [];
  if (entities.length === 0) throw new Error('Product Scope declares no data concepts');
  const entityById = new Map();
  for (const entity of entities) {
    const id = conceptId(entity.name);
    if (entityById.has(id)) {
      throw new Error(`Product Scope concept IDs collide at ${id}`);
    }
    entityById.set(id, entity);
  }

  const connectors = Array.isArray(architecture.connectors) ? architecture.connectors : [];
  const approvedConnectorNames = new Set(connectors
    .filter((connector) => connector.approved === true)
    .map((connector) => String(connector.apiName || '').trim().toLowerCase()));
  const suppliedOwners = Array.isArray(architecture.conceptOwners)
    ? architecture.conceptOwners
    : [];
  const ownerById = new Map();
  for (const owner of suppliedOwners) {
    const id = String(owner.conceptId || '').trim().toLowerCase();
    if (!entityById.has(id)) throw new Error(`Unknown persistence concept ${id || '(missing)'}`);
    if (ownerById.has(id)) throw new Error(`${id} has more than one persistence owner`);
    if (typeof owner.reason !== 'string' || owner.reason.trim().length < 10) {
      throw new Error(`${id} persistence owner requires a plain-language reason`);
    }
    const normalizedOwner = String(owner.owner || '').trim().toLowerCase();
    const kind = ownerKind(normalizedOwner);
    if (kind === 'connector') {
      const apiName = normalizedOwner.slice('connector:'.length);
      if (!approvedConnectorNames.has(apiName)) {
        throw new Error(`${id} references connector ${apiName} without an approved connector decision`);
      }
    }
    assertCompatible(entityById.get(id), normalizedOwner);
    ownerById.set(id, {
      conceptId: id,
      conceptName: entityById.get(id).name,
      role: entityById.get(id).role,
      realization: entityById.get(id).realization,
      owner: normalizedOwner,
      reason: owner.reason.trim(),
    });
  }
  for (const [id, entity] of entityById) {
    if (!ownerById.has(id)) throw new Error(`${entity.name} requires exactly one persistence owner`);
  }

  const conceptOwners = [...ownerById.values()].sort(
    (left, right) => left.conceptId.localeCompare(right.conceptId),
  );
  const idsFor = (kind) => conceptOwners
    .filter((entry) => ownerKind(entry.owner) === kind)
    .map((entry) => entry.conceptId);
  const contract = {
    schemaVersion: 1,
    contractType: 'persistence-contract',
    scopeRevision: contractRevision(scope),
    mode: deriveMode(conceptOwners),
    conceptOwners,
    connectors: connectors
      .filter((connector) => connector.approved === true)
      .map((connector) => ({
        apiName: String(connector.apiName).trim().toLowerCase(),
        displayName: String(connector.displayName || connector.apiName).trim(),
      }))
      .sort((left, right) => left.apiName.localeCompare(right.apiName)),
    nativeCapabilities: (architecture.nativeCapabilities || [])
      .filter((capability) => capability.approved === true)
      .map((capability) => ({
        id: String(capability.id).trim(),
        displayName: String(capability.displayName || capability.id).trim(),
        persistenceConsequence: String(capability.persistenceConsequence || '').trim(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    dataverseConceptIds: idsFor('dataverse'),
    connectorConceptIds: idsFor('connector'),
    localConceptIds: idsFor('local'),
    transientConceptIds: idsFor('transient'),
  };
  contract.persistenceRevision = sha256Hex(canonicalJson(contract));
  return contract;
}

function validatePersistenceArtifacts(projectRoot, contract) {
  const errors = [];
  if (['connector-only', 'local-prototype'].includes(contract.mode)) {
    for (const relativePath of FORBIDDEN_NON_DATAVERSE_ARTIFACTS) {
      const file = path.resolve(projectRoot, relativePath);
      if (!fs.existsSync(file)) continue;
      errors.push({
        code: 'forbidden-dataverse-artifact',
        message: `${contract.mode} mode cannot contain ${relativePath}`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--scope') args.scope = argv[++index];
    else if (argv[index] === '--architecture') args.architecture = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--check-artifacts') args.checkArtifacts = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const output = path.resolve(projectRoot, args.output || DEFAULT_OUTPUT);
    const contract = compilePersistenceContract(
      JSON.parse(fs.readFileSync(path.resolve(projectRoot, args.scope || DEFAULT_SCOPE), 'utf8')),
      JSON.parse(fs.readFileSync(
        path.resolve(projectRoot, args.architecture || DEFAULT_ARCHITECTURE),
        'utf8',
      )),
    );
    if (args.checkArtifacts) {
      const artifactResult = validatePersistenceArtifacts(projectRoot, contract);
      if (!artifactResult.ok) {
        artifactResult.errors.forEach((item) => process.stderr.write(`${item.code}: ${item.message}\n`));
        return 1;
      }
    }
    atomicWriteJson(output, contract);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      output,
      mode: contract.mode,
      revision: contract.persistenceRevision,
      conceptCount: contract.conceptOwners.length,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compile-persistence-contract: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  FORBIDDEN_NON_DATAVERSE_ARTIFACTS,
  compilePersistenceContract,
  conceptId,
  main,
  validatePersistenceArtifacts,
};

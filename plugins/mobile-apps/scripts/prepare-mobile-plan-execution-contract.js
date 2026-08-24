#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');
const {
  extractBriefRequirements,
  packageCatalogRevision,
  sha256,
} = require('./lib/mobile-plan-execution-contract');
const PREFLIGHT_CATALOG = require('./mobile-plan-preflight-catalog.json');

const NATIVE_CAPABILITIES = PREFLIGHT_CATALOG.nativeCapabilities.map((item) => ({
  capability: item.capability,
  pattern: new RegExp(item.pattern, 'i'),
  packageName: item.package,
}));

const CONNECTOR_HINTS = PREFLIGHT_CATALOG.connectorHints.map((item) => ({
  connector: item.connector,
  apiName: item.apiName,
  pattern: new RegExp(item.pattern, 'i'),
}));

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'requirement';
}

function requirementKind(source) {
  if (NATIVE_CAPABILITIES.some((item) => item.pattern.test(source))) return 'native';
  if (CONNECTOR_HINTS.some((item) => item.pattern.test(source))) return 'connector';
  if (/\b(?:accessible|accessibility|large text|screen reader|contrast)\b/i.test(source)) return 'quality';
  if (/\b(?:offline|no connection|airplane mode|cache|cached)\b/i.test(source)) return 'constraint';
  if (/\b(?:table|record|field|relationship|store|persist|track data)\b/i.test(source)) return 'data';
  if (/\b(?:screen|page|view|navigation|tab)\b/i.test(source)) return 'screen';
  return 'job';
}

function packageVersion(packageJson, packageName) {
  return packageJson.dependencies?.[packageName] || packageJson.devDependencies?.[packageName] || null;
}

function prepareExecutionPreflight(briefText, experienceContract, packageJson, connectorMetadata = { operations: [] }) {
  const sources = extractBriefRequirements(briefText);
  const requirements = sources.map((source, index) => ({
    id: `req-${slug(source)}-${sha256(source).slice(0, 8)}`,
    source,
    priority: 'required',
    kind: requirementKind(source),
    ordinal: index,
  }));
  const catalogRevision = packageCatalogRevision(packageJson);
  const nativeCapabilities = [];
  for (const candidate of NATIVE_CAPABILITIES) {
    const requiredBy = requirements.filter((requirement) => candidate.pattern.test(requirement.source)).map((requirement) => requirement.id);
    if (!requiredBy.length) continue;
    const version = packageVersion(packageJson, candidate.packageName);
    nativeCapabilities.push({
      id: `native-${candidate.capability}`,
      capability: candidate.capability,
      requiredBy,
      platforms: ['ios', 'android'],
      support: {
        status: version && candidate.packageName !== 'expo-haptics' ? 'supported' : 'unsupported',
        templatePackage: candidate.packageName,
        templateVersion: version,
        catalogRevision,
        ...(version ? {} : { reason: `${candidate.packageName} is absent from the selected template package.json` }),
      },
      execution: version ? 'add-native' : 'none',
    });
  }
  const connectorHints = CONNECTOR_HINTS.flatMap((candidate) => {
    const requiredBy = requirements.filter((requirement) => candidate.pattern.test(requirement.source)).map((requirement) => requirement.id);
    return requiredBy.length ? [{ ...candidate, pattern: undefined, requiredBy, status: 'operation-metadata-required' }] : [];
  }).map(({ pattern, ...candidate }) => candidate);
  const connectorOperations = [];
  const connectorBlockers = [];
  for (const hint of connectorHints) {
    const metadata = (connectorMetadata.operations || []).filter((operation) => operation.apiName === hint.apiName);
    if (!metadata.length) {
      connectorBlockers.push(`Connector ${hint.apiName} requires read-only operation metadata before planning.`);
      continue;
    }
    for (const operation of metadata) {
      if (!operation.id || !operation.connector || !operation.service || !operation.operation || !operation.input || !operation.output || !operation.failure) {
        connectorBlockers.push(`Connector metadata for ${hint.apiName} is incomplete.`);
        continue;
      }
      connectorOperations.push({
        id: operation.id,
        connector: operation.connector,
        apiName: hint.apiName,
        service: operation.service,
        operation: operation.operation,
        requiredBy: hint.requiredBy,
        input: operation.input,
        output: operation.output,
        failure: operation.failure,
        prototype: { behavior: 'typed-throw-stub' },
      });
    }
  }
  const javascriptDependencies = PREFLIGHT_CATALOG.javascriptDependencies.flatMap((candidate) => {
    const pattern = new RegExp(candidate.pattern, 'i');
    if (!pattern.test(briefText)) return [];
    return [{ package: candidate.package, version: candidate.version, classification: 'pure-js', resolution: 'approved-before-build', requiredBy: requirements.filter((item) => pattern.test(item.source)).map((item) => item.id) }];
  });
  return {
    schemaVersion: 1,
    kind: 'mobile-plan-execution-preflight',
    experienceContractSha256: contractHash(experienceContract),
    briefSha256: sha256(briefText),
    templateCatalogRevision: catalogRevision,
    requirements,
    nativeCapabilities,
    javascriptDependencies,
    connectorHints,
    connectorOperations,
    blockers: [
      ...nativeCapabilities.filter((item) => item.support.status !== 'supported').map((item) => item.support.reason),
      ...connectorBlockers,
    ],
  };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--brief') args.brief = argv[++index];
    else if (argv[index] === '--experience-contract') args.experienceContract = argv[++index];
    else if (argv[index] === '--package') args.package = argv[++index];
    else if (argv[index] === '--connector-metadata') args.connectorMetadata = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot || !args.brief) {
    process.stderr.write('Usage: node prepare-mobile-plan-execution-contract.js --project-root <dir> --brief <path> [--experience-contract <path>] [--package <path>] [--connector-metadata <path>] [--output <path>] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const briefPath = path.resolve(root, args.brief);
    const experiencePath = path.resolve(root, args.experienceContract || '.tmp/experience-contract.json');
    const packagePath = path.resolve(root, args.package || 'package.json');
    const outputPath = path.resolve(root, args.output || '.tmp/mobile-plan-execution-preflight.json');
    const preflight = prepareExecutionPreflight(
      fs.readFileSync(briefPath, 'utf8'),
      JSON.parse(fs.readFileSync(experiencePath, 'utf8')),
      JSON.parse(fs.readFileSync(packagePath, 'utf8')),
      args.connectorMetadata ? JSON.parse(fs.readFileSync(path.resolve(root, args.connectorMetadata), 'utf8')) : { operations: [] },
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(preflight, null, 2)}\n`);
    if (args.json) process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
    else process.stdout.write(`Mobile plan execution preflight written: ${outputPath}\n`);
    if (preflight.blockers.length) {
      preflight.blockers.forEach((blocker) => process.stderr.write(`BLOCKED: ${blocker}\n`));
      return 3;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`prepare-mobile-plan-execution-contract: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { prepareExecutionPreflight, requirementKind };
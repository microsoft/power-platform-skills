#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { domainModelRevision, validatePrototypeDomainModel } = require('../../../scripts/lib/prototype-domain-model');
const { generateDataLayer } = require('./gen-data-layer');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function projectFile(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new Error(`unsafe legacy path: ${relativePath}`);
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`legacy path escapes the project: ${relativePath}`);
  return target;
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

function restoreArchive(projectRoot, archiveRoot, archivedFiles, generatedFiles) {
  for (const relativePath of generatedFiles) {
    const target = projectFile(projectRoot, relativePath);
    if (fs.existsSync(target)) fs.rmSync(target, { force: true, recursive: true });
  }
  for (const relativePath of archivedFiles) {
    const source = projectFile(archiveRoot, relativePath);
    const target = projectFile(projectRoot, relativePath);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function removeEmptyParents(filePath, stopAt) {
  let directory = path.dirname(filePath);
  while (directory.startsWith(stopAt) && directory !== stopAt) {
    if (!fs.existsSync(directory) || fs.readdirSync(directory).length) return;
    fs.rmdirSync(directory);
    directory = path.dirname(directory);
  }
}

function migrateLegacyPrototype(projectRoot) {
  const root = path.resolve(projectRoot);
  const legacyManifestPath = path.join(root, 'src', 'generated', '.prototype-manifest.json');
  if (!fs.existsSync(legacyManifestPath)) return { status: 'not-needed', migrated: false };
  const domainPath = path.join(root, '.tmp', 'prototype-domain-model.json');
  if (!fs.existsSync(domainPath)) throw new Error('prototype domain model is required before legacy migration');
  const model = readJson(domainPath, 'Prototype domain model');
  const validation = validatePrototypeDomainModel(model);
  if (!validation.valid) throw new Error(`prototype domain model is invalid: ${validation.errors.join('; ')}`);
  const existingDataRoot = path.join(root, 'src', 'data');
  if (fs.existsSync(existingDataRoot)) throw new Error('src/data already exists; resolve or remove the partial domain migration before retrying');

  const legacyManifestBytes = fs.readFileSync(legacyManifestPath);
  const legacyManifest = readJson(legacyManifestPath, 'Legacy prototype manifest');
  if (legacyManifest.generator !== 'create-mobile-prototype/gen-mock-services.js' || !Array.isArray(legacyManifest.files)) {
    throw new Error('legacy prototype manifest is not owned by the supported mock-service generator');
  }
  const archiveRoot = path.join(root, '.mobile-app', 'legacy-prototype-archive');
  if (fs.existsSync(archiveRoot)) throw new Error('.mobile-app/legacy-prototype-archive already exists; restore or remove the interrupted migration archive before retrying');

  const relativeManifestPath = 'src/generated/.prototype-manifest.json';
  const ownedFiles = [...new Set([...legacyManifest.files, relativeManifestPath])];
  const archivedFiles = [];
  const missingFiles = [];
  let generatedFiles = [];
  const preservedFixtureTargets = [];
  fs.mkdirSync(archiveRoot, { recursive: true });
  try {
    for (const relativePath of ownedFiles) {
      const source = projectFile(root, relativePath);
      if (!fs.existsSync(source)) {
        missingFiles.push(relativePath);
        continue;
      }
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`legacy artifact must be a regular non-symlink file: ${relativePath}`);
      copyFile(source, projectFile(archiveRoot, relativePath));
      archivedFiles.push(relativePath);
    }

    const preservedFixtures = [];
    for (const table of legacyManifest.tableSchemas || []) {
      if (!table.seedFile) continue;
      const seedPath = projectFile(root, table.seedFile);
      if (!fs.existsSync(seedPath)) continue;
      const records = readJson(seedPath, `Legacy fixtures ${table.logicalName}`);
      if (!Array.isArray(records)) throw new Error(`legacy fixtures ${table.logicalName} must be an array`);
      const safeName = String(table.logicalName || table.serviceName || 'legacy').replace(/[^A-Za-z0-9_-]+/g, '-');
      const relativePath = `src/data/legacy-fixtures/${safeName}.json`;
      preservedFixtures.push({ sourceTable: table.logicalName, source: table.seedFile, target: relativePath, records: records.length, sha256: sha256(fs.readFileSync(seedPath)) });
    }

    const experiencePath = path.join(root, '.tmp', 'experience-contract.json');
    const experience = fs.existsSync(experiencePath) ? readJson(experiencePath, 'Experience contract') : null;
    const screenPath = path.join(root, '.tmp', 'experience-screen-contract.json');
    const executionPath = path.join(root, '.tmp', 'mobile-plan-execution-contract.json');
    const screen = fs.existsSync(screenPath) ? readJson(screenPath, 'Experience Screen Contract') : null;
    const execution = fs.existsSync(executionPath) ? readJson(executionPath, 'Mobile Plan Execution Contract') : null;
    const generatedManifest = generateDataLayer(root, model, experience, screen, execution);
    generatedFiles = [...generatedManifest.files, '.mobile-app/prototype-domain-manifest.json'];
    for (const fixture of preservedFixtures) {
      const source = projectFile(root, fixture.source);
      const target = projectFile(root, fixture.target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      preservedFixtureTargets.push(fixture.target);
      if (sha256(fs.readFileSync(target)) !== fixture.sha256) throw new Error(`preserved fixture hash mismatch for ${fixture.sourceTable}`);
    }

    const generatedManifestPath = path.join(root, '.mobile-app', 'prototype-domain-manifest.json');
    const persistedManifest = readJson(generatedManifestPath, 'Prototype domain manifest');
    if (persistedManifest.domainModelRevision !== domainModelRevision(model)) throw new Error('generated domain manifest revision does not match the prototype domain model');
    for (const relativePath of generatedManifest.files) {
      if (!fs.existsSync(projectFile(root, relativePath))) throw new Error(`generated domain file is missing: ${relativePath}`);
    }

    const generatedSet = new Set([...generatedManifest.files, ...preservedFixtures.map((fixture) => fixture.target)]);
    for (const relativePath of archivedFiles) {
      if (generatedSet.has(relativePath)) continue;
      const target = projectFile(root, relativePath);
      const archived = projectFile(archiveRoot, relativePath);
      if (fs.existsSync(target) && sha256(fs.readFileSync(target)) !== sha256(fs.readFileSync(archived))) throw new Error(`legacy artifact changed during migration: ${relativePath}`);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        removeEmptyParents(target, path.join(root, 'src', 'generated'));
      }
    }

    const report = {
      schemaVersion: 1,
      status: 'completed',
      sourceManifestSha256: sha256(legacyManifestBytes),
      domainModelRevision: domainModelRevision(model),
      preservedFixtures,
      removedLegacyFiles: archivedFiles.filter((relativePath) => !generatedSet.has(relativePath)).sort(),
      missingLegacyFiles: missingFiles.sort(),
    };
    fs.writeFileSync(path.join(root, '.mobile-app', 'prototype-domain-migration.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.rmSync(archiveRoot, { recursive: true, force: true });
    return { status: 'completed', migrated: true, ...report };
  } catch (error) {
    restoreArchive(root, archiveRoot, archivedFiles, [...generatedFiles, ...preservedFixtureTargets, 'src/data', '.mobile-app/prototype-domain-manifest.json']);
    fs.rmSync(path.join(root, '.mobile-app', 'prototype-domain-migration.json'), { force: true });
    throw error;
  }
}

function main(argv) {
  if (!argv[0]) {
    process.stderr.write('Usage: node migrate-legacy-prototype.js <project-dir>\n');
    return 2;
  }
  try {
    const result = migrateLegacyPrototype(argv[0]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: legacy prototype migration: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { migrateLegacyPrototype };
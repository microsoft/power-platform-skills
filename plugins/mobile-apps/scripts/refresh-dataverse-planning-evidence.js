#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateSnapshot } = require('./create-dataverse-snapshot');
const {
  buildArchitectEvidenceBundle,
  loadAndValidateArchitectEvidence,
  validateArchitectEvidence,
  writeArchitectEvidenceBundle,
} = require('./render-dataverse-architect-evidence');
const { stableJson } = require('./lib/dataverse-evidence-projection');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicWriteJson(file, value, fileSystem = fs) {
  const resolved = path.resolve(file);
  fileSystem.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, stableJson(value), 'utf8');
    fileSystem.renameSync(temporary, resolved);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function manifestWithIntegrity(core) {
  return { ...core, integritySha256: sha256(stableJson(core)) };
}

function pointerWithIntegrity(core) {
  return { ...core, integritySha256: sha256(stableJson(core)) };
}

function verifyIntegrity(value, label) {
  const withoutIntegrity = { ...value };
  delete withoutIntegrity.integritySha256;
  if (!/^[a-f0-9]{64}$/.test(String(value.integritySha256 || ''))
    || value.integritySha256 !== sha256(stableJson(withoutIntegrity))) {
    throw new Error(`${label} integrity hash does not match`);
  }
}

function generationResult(directory, pointerFile, manifest) {
  return {
    generationId: manifest.generationId,
    generationDirectory: directory,
    snapshotPath: path.join(directory, manifest.files.snapshot.file),
    evidencePath: path.join(directory, manifest.files.evidence.file),
    manifestPath: path.join(directory, 'generation-manifest.json'),
    pointerPath: path.resolve(pointerFile),
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    evidenceSha256: manifest.files.evidence.sha256,
    shardCount: manifest.files.shards.length,
  };
}

function validatePlanningGenerationDirectory(directory, pointerFile, fileSystem = fs) {
  const resolved = path.resolve(directory);
  const manifestPath = path.join(resolved, 'generation-manifest.json');
  if (!fileSystem.existsSync(manifestPath)) throw new Error('planning generation manifest is missing');
  const manifest = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1) throw new Error('planning generation schemaVersion must be 1');
  verifyIntegrity(manifest, 'planning generation manifest');
  if (manifest.generationId !== manifest.sourceSnapshotSha256) {
    throw new Error('planning generation identity does not match its snapshot hash');
  }
  const snapshotPath = path.join(resolved, manifest.files?.snapshot?.file || '');
  const evidencePath = path.join(resolved, manifest.files?.evidence?.file || '');
  const snapshotSource = fileSystem.readFileSync(snapshotPath, 'utf8');
  if (sha256(snapshotSource) !== manifest.sourceSnapshotSha256) {
    throw new Error('planning generation snapshot hash does not match');
  }
  const evidenceSource = fileSystem.readFileSync(evidencePath, 'utf8');
  if (sha256(evidenceSource) !== manifest.files.evidence.sha256) {
    throw new Error('planning generation evidence hash does not match');
  }
  const validated = loadAndValidateArchitectEvidence(snapshotPath, evidencePath, fileSystem);
  const actualShardHashes = new Map(validated.shards.map(
    (shard) => [shard.tableLogicalName, shard.integritySha256],
  ));
  if (manifest.files.shards.length !== actualShardHashes.size
    || manifest.files.shards.some((shard) => (
      actualShardHashes.get(shard.tableLogicalName) !== shard.integritySha256
    ))) {
    throw new Error('planning generation shard manifest does not match');
  }
  return generationResult(resolved, pointerFile, manifest);
}

function validatePlanningGenerationPointer(pointerFile, fileSystem = fs) {
  const resolvedPointer = path.resolve(pointerFile);
  if (!fileSystem.existsSync(resolvedPointer)) throw new Error('planning generation pointer is missing');
  const pointer = JSON.parse(fileSystem.readFileSync(resolvedPointer, 'utf8'));
  if (pointer.schemaVersion !== 1) throw new Error('planning generation pointer schemaVersion must be 1');
  verifyIntegrity(pointer, 'planning generation pointer');
  if (!/^[a-f0-9]{64}$/.test(String(pointer.generationId || ''))) {
    throw new Error('planning generation pointer generationId is invalid');
  }
  if (path.isAbsolute(pointer.relativeDirectory || '')) {
    throw new Error('planning generation pointer directory must be relative');
  }
  const directory = path.resolve(path.dirname(resolvedPointer), pointer.relativeDirectory || '');
  if (path.basename(directory) !== pointer.generationId) {
    throw new Error('planning generation pointer directory does not match generationId');
  }
  const result = validatePlanningGenerationDirectory(directory, resolvedPointer, fileSystem);
  const manifest = JSON.parse(fileSystem.readFileSync(result.manifestPath, 'utf8'));
  if (manifest.integritySha256 !== pointer.manifestSha256) {
    throw new Error('planning generation pointer manifest hash is stale');
  }
  return result;
}

function promotePlanningGeneration({
  snapshotFile,
  generationsDir,
  pointerFile,
  fileSystem = fs,
  buildBundle = buildArchitectEvidenceBundle,
  nowIso = () => new Date().toISOString(),
}) {
  if (!snapshotFile || !generationsDir || !pointerFile) {
    throw new Error('snapshotFile, generationsDir, and pointerFile are required');
  }
  const snapshotSource = fileSystem.readFileSync(path.resolve(snapshotFile), 'utf8');
  const snapshot = JSON.parse(snapshotSource);
  const validation = validateSnapshot(snapshot);
  if (!validation.valid) {
    throw new Error(`Invalid Dataverse snapshot: ${validation.errors.join('; ')}`);
  }
  const generationId = sha256(snapshotSource);
  const root = path.resolve(generationsDir);
  const finalDirectory = path.join(root, generationId);
  const temporaryDirectory = path.join(root, `.tmp-${generationId}-${process.pid}-${Date.now()}`);
  fileSystem.mkdirSync(root, { recursive: true });
  try {
    fileSystem.mkdirSync(temporaryDirectory, { recursive: false });
    const generatedSnapshot = path.join(temporaryDirectory, 'snapshot.json');
    fileSystem.writeFileSync(generatedSnapshot, snapshotSource, 'utf8');
    const bundle = buildBundle(snapshot, generationId);
    const evidenceValidation = validateArchitectEvidence(bundle.evidence, snapshot, generationId);
    if (!evidenceValidation.valid) {
      throw new Error(`Invalid architect evidence: ${evidenceValidation.errors.join('; ')}`);
    }
    const evidencePath = path.join(temporaryDirectory, 'architect-evidence.json');
    writeArchitectEvidenceBundle(evidencePath, bundle, fileSystem);
    loadAndValidateArchitectEvidence(generatedSnapshot, evidencePath, fileSystem);
    const evidenceSource = fileSystem.readFileSync(evidencePath, 'utf8');
    const manifest = manifestWithIntegrity({
      schemaVersion: 1,
      generationId,
      sourceSnapshotSha256: generationId,
      snapshotGeneratedAt: snapshot.generatedAt,
      purpose: snapshot.purpose,
      files: {
        snapshot: { file: 'snapshot.json', sha256: generationId },
        evidence: {
          file: 'architect-evidence.json',
          sha256: sha256(evidenceSource),
        },
        shards: bundle.shards.map((shard) => ({
          tableLogicalName: shard.tableLogicalName,
          file: `architect-evidence.json.shards/${shard.tableLogicalName}.json`,
          integritySha256: shard.integritySha256,
        })),
      },
    });
    atomicWriteJson(
      path.join(temporaryDirectory, 'generation-manifest.json'),
      manifest,
      fileSystem,
    );
    validatePlanningGenerationDirectory(temporaryDirectory, pointerFile, fileSystem);
    if (fileSystem.existsSync(finalDirectory)) {
      validatePlanningGenerationDirectory(finalDirectory, pointerFile, fileSystem);
      fileSystem.rmSync(temporaryDirectory, { recursive: true, force: true });
    } else {
      fileSystem.renameSync(temporaryDirectory, finalDirectory);
    }
    const pointer = pointerWithIntegrity({
      schemaVersion: 1,
      generationId,
      relativeDirectory: path.relative(path.dirname(path.resolve(pointerFile)), finalDirectory),
      manifestSha256: manifest.integritySha256,
      promotedAt: nowIso(),
    });
    atomicWriteJson(pointerFile, pointer, fileSystem);
    return validatePlanningGenerationPointer(pointerFile, fileSystem);
  } catch (error) {
    if (fileSystem.existsSync(temporaryDirectory)) {
      fileSystem.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--snapshot') args.snapshotFile = argv[++index];
    else if (argv[index] === '--generations-dir') args.generationsDir = argv[++index];
    else if (argv[index] === '--pointer') args.pointerFile = argv[++index];
    else if (argv[index] === '--validate-current') args.validateCurrent = true;
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  try {
    const result = args.validateCurrent
      ? validatePlanningGenerationPointer(args.pointerFile)
      : promotePlanningGeneration(args);
    process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : result.generationId}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`refresh-dataverse-planning-evidence: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  main,
  promotePlanningGeneration,
  validatePlanningGenerationDirectory,
  validatePlanningGenerationPointer,
};

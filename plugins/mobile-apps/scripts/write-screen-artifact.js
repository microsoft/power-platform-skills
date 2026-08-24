#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256, validateScreenArtifact } = require('./validate-screen-artifact');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function writeScreenArtifact(projectRoot, pack, artifact, expectedScreenId) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  if (!expectedScreenId) throw new Error('foreground-authorized screen ID is required');
  const validation = validateScreenArtifact(root, pack, artifact, expectedScreenId);
  if (!validation.valid) throw new Error(`invalid screen artifact: ${validation.errors.join('; ')}`);

  const target = validation.target;
  const source = artifact.source.endsWith('\n') ? artifact.source : `${artifact.source}\n`;
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const backup = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.backup`);
  let targetMoved = false;
  let replacementWritten = false;
  try {
    fs.writeFileSync(temp, source, { flag: 'wx' });
    if (sha256(fs.readFileSync(target)) !== artifact.inputFileSha256) {
      throw new Error(`typed screen skeleton changed before persistence: ${validation.screen.file}`);
    }
    fs.renameSync(target, backup);
    targetMoved = true;
    fs.renameSync(temp, target);
    replacementWritten = true;
    fs.rmSync(backup, { force: true });
    targetMoved = false;
  } catch (error) {
    if (replacementWritten) fs.rmSync(target, { force: true });
    if (targetMoved && fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
    fs.rmSync(backup, { force: true });
  }
  return {
    screenId: validation.screen.id,
    written: validation.screen.file,
    sourceSha256: sha256(Buffer.from(source, 'utf8')),
    warnings: artifact.warnings,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--artifact') args.artifact = argv[++index];
    else if (argv[index] === '--screen-id') args.screenId = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !args.artifact || !args.screenId) {
    process.stderr.write('Usage: node write-screen-artifact.js --project-root <dir> --screen-id <id> --artifact <artifact.json> [--pack <path>]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const packPath = path.resolve(root, args.pack || '.tmp/screen-build-pack.json');
    const result = writeScreenArtifact(
      root,
      readJson(packPath, 'Screen build pack'),
      readJson(path.resolve(args.artifact), 'Screen artifact'),
      args.screenId,
    );
    process.stdout.write(`${JSON.stringify({ status: 'ok', ...result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`write-screen-artifact: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { writeScreenArtifact };

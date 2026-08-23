#!/usr/bin/env node
'use strict';

/**
 * Runs every TypeScript phase gate while reusing TypeScript's own incremental
 * graph under .tmp. The gate is never skipped. --clean deletes compiler state
 * first and is required for final validation.
 *
 * Usage:
 *   node run-tsc-gate.js --project-root <dir> --gate <name> [--clean]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  hashFile,
  hashFiles,
  readJson,
  sha256,
  stableJson,
  walkFiles,
  writeJsonAtomic,
} = require('./lib/workflow-artifacts');

function fail(message) {
  console.error(`tsc-gate: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const parsed = { clean: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--clean') parsed.clean = true;
    else if (arg === '--project-root' || arg === '--gate') {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function hashInputs(projectRoot) {
  const files = walkFiles(projectRoot, {
    include: (filePath) => /\.(?:ts|tsx|json)$/i.test(filePath),
    excludeDirectory: (filePath, name) => (
      name === 'node_modules' || name === '.git' || name === '.expo'
      || filePath === path.join(projectRoot, '.tmp')
    ),
  });
  return hashFiles(projectRoot, files);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['project-root'] || !args.gate) fail('usage: --project-root <dir> --gate <name> [--clean]');
  const projectRoot = path.resolve(args['project-root']);
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(tsconfigPath) || !fs.existsSync(packagePath)) fail('tsconfig.json or package.json is missing');
  const tscEntry = process.env.MOBILE_TSC_ENTRY
    ? path.resolve(process.env.MOBILE_TSC_ENTRY)
    : path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscEntry)) fail(`TypeScript entry not found: ${tscEntry}`);

  const cacheRoot = path.join(projectRoot, '.tmp', 'tsc');
  const buildInfoPath = path.join(cacheRoot, 'mobile.tsbuildinfo');
  const cacheManifestPath = path.join(projectRoot, '.tmp', 'tsc-cache-manifest.json');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const compilerSignature = sha256(stableJson({
    tsconfig: hashFile(tsconfigPath),
    package: hashFile(packagePath),
    tsc: hashFile(tscEntry),
  }));
  const previous = fs.existsSync(cacheManifestPath)
    ? readJson(cacheManifestPath, '.tmp/tsc-cache-manifest.json')
    : null;
  const incompatible = !previous || previous.compilerSignature !== compilerSignature;
  if (args.clean || incompatible) fs.rmSync(buildInfoPath, { force: true });
  const reusedIncrementalState = fs.existsSync(buildInfoPath);

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [
    tscEntry,
    '--project', tsconfigPath,
    '--noEmit',
    '--incremental',
    '--tsBuildInfoFile', buildInfoPath,
    '--pretty', 'false',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const inputs = hashInputs(projectRoot);
  const receipt = {
    schemaVersion: 1,
    gate: args.gate,
    mode: args.clean ? 'clean' : 'incremental',
    executed: true,
    reusedIncrementalState,
    compilerSignature,
    sourceSha256: inputs.sha256,
    status: result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status ?? 2,
    durationMs,
    stdout: (result.stdout || '').slice(-20000),
    stderr: (result.stderr || '').slice(-20000),
    completedAt: new Date().toISOString(),
  };
  receipt.receiptSha256 = sha256(stableJson(receipt));
  const receiptPath = path.join(projectRoot, '.tmp', 'tsc-gates', `${args.gate}.json`);
  writeJsonAtomic(receiptPath, receipt);
  if (result.status === 0) {
    writeJsonAtomic(cacheManifestPath, {
      schemaVersion: 1,
      compilerSignature,
      buildInfoSha256: fs.existsSync(buildInfoPath) ? hashFile(buildInfoPath) : null,
      lastGate: args.gate,
      updatedAt: new Date().toISOString(),
    });
    console.log(`tsc-gate: PASS ${args.gate} (${durationMs}ms, ${reusedIncrementalState ? 'warm' : 'cold'})`);
    return;
  }
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status || 2;
}

main();

#!/usr/bin/env node
'use strict';

/**
 * Binds a generated preview to a hash of all relevant source inputs. If sources
 * change while preview and final checks run concurrently, finalize deletes the
 * stale preview and exits 2 so the orchestrator regenerates it.
 *
 * Usage:
 *   node preview-lock.js <project-dir> begin [preview-path]
 *   node preview-lock.js <project-dir> finalize [preview-path]
 *   node preview-lock.js <project-dir> check [preview-path]
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  hashFile,
  readJson,
  sha256,
  sourceSnapshot,
  stableJson,
  writeJsonAtomic,
} = require('./lib/workflow-artifacts');

function fail(message, code = 2) {
  console.error(`preview-lock: ${message}`);
  process.exit(code);
}

function safePreview(projectRoot, previewArg) {
  const relativePath = previewArg || 'preview.html';
  const filePath = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('preview path must stay inside project root', 1);
  }
  if (!/\.html$/i.test(filePath)) fail('preview path must be an HTML file', 1);
  return { filePath, relativePath: relative.split(path.sep).join('/') };
}

function main() {
  const projectArg = process.argv[2];
  const action = process.argv[3];
  if (!projectArg || !['begin', 'finalize', 'check'].includes(action)) {
    fail('usage: node preview-lock.js <project-dir> <begin|finalize|check> [preview-path]', 1);
  }
  const projectRoot = path.resolve(projectArg);
  const preview = safePreview(projectRoot, process.argv[4]);
  const lockPath = path.join(projectRoot, '.tmp', 'preview-lock.json');

  if (action === 'begin') {
    const snapshot = sourceSnapshot(projectRoot);
    writeJsonAtomic(lockPath, {
      schemaVersion: 1,
      previewPath: preview.relativePath,
      status: 'generating',
      sourceSha256: snapshot.sha256,
      sources: snapshot.files,
      begunAt: new Date().toISOString(),
    });
    console.log(`preview-lock: begun ${snapshot.sha256.slice(0, 12)}`);
    return;
  }

  if (!fs.existsSync(lockPath)) fail('.tmp/preview-lock.json is missing');
  const lock = readJson(lockPath, '.tmp/preview-lock.json');
  if (lock.previewPath !== preview.relativePath) fail('preview path does not match lock');
  const current = sourceSnapshot(projectRoot);

  if (action === 'finalize') {
    if (!fs.existsSync(preview.filePath)) fail(`preview was not generated: ${preview.relativePath}`);
    if (current.sha256 !== lock.sourceSha256) {
      fs.rmSync(preview.filePath, { force: true });
      writeJsonAtomic(lockPath, {
        ...lock,
        status: 'invalidated',
        currentSourceSha256: current.sha256,
        invalidatedAt: new Date().toISOString(),
      });
      fail('source changed during preview generation; stale preview deleted');
    }
    const finalized = {
      ...lock,
      status: 'valid',
      previewSha256: hashFile(preview.filePath),
      finalizedAt: new Date().toISOString(),
    };
    finalized.lockSha256 = sha256(stableJson(finalized));
    writeJsonAtomic(lockPath, finalized);
    console.log(`preview-lock: valid ${finalized.previewSha256.slice(0, 12)}`);
    return;
  }

  if (lock.status !== 'valid') fail(`preview lock is not valid: ${lock.status}`);
  if (current.sha256 !== lock.sourceSha256) fail('preview source hash is stale');
  if (!fs.existsSync(preview.filePath) || hashFile(preview.filePath) !== lock.previewSha256) {
    fail('preview file hash is stale');
  }
  const withoutLock = { ...lock };
  delete withoutLock.lockSha256;
  if (lock.lockSha256 !== sha256(stableJson(withoutLock))) fail('preview lock integrity hash is invalid');
  console.log('preview-lock: PASS');
}

main();

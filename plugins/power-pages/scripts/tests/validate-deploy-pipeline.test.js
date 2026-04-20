#!/usr/bin/env node
/**
 * Tests for deploy-pipeline/scripts/validate-deploy-pipeline.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const VALIDATOR = path.join(
  __dirname,
  '../../skills/deploy-pipeline/scripts/validate-deploy-pipeline.js'
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-deploy-pipeline-'));
}

function writeMarker(dir, data) {
  fs.writeFileSync(path.join(dir, '.last-deploy.json'), JSON.stringify(data), 'utf8');
}

function writeHistoryFile(dir, relPath) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // Must be > 500 bytes to pass the size check
  fs.writeFileSync(full, '<html><body>' + 'deploy history content '.repeat(30) + '</body></html>', 'utf8');
}

function runValidator(cwd) {
  const result = spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('validate-deploy-pipeline: exits 0 when no .last-deploy.json found', () => {
  const dir = makeTempDir();
  const result = runValidator(dir);
  assert.equal(result.code, 0);
});

test('validate-deploy-pipeline: exits 0 for valid succeeded marker with history file', () => {
  const dir = makeTempDir();
  const historyFile = 'docs/deploy-history/2026-04-10-staging-1.0.0.3.html';
  writeHistoryFile(dir, historyFile);
  writeMarker(dir, {
    pipelineId: 'pipe-1',
    stageRunId: 'run-1',
    solutionName: 'MySolution',
    status: 'Succeeded',
    deployedAt: '2026-04-10T00:00:00.000Z',
    deployHistoryFile: historyFile,
  });
  const result = runValidator(dir);
  assert.equal(result.code, 0, result.stderr);
});

test('validate-deploy-pipeline: blocks when status is Failed', () => {
  const dir = makeTempDir();
  writeMarker(dir, {
    pipelineId: 'pipe-1',
    stageRunId: 'run-1',
    solutionName: 'MySolution',
    status: 'Failed',
    deployedAt: '2026-04-10T00:00:00.000Z',
    stageName: 'Staging',
  });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /failed/i);
});

test('validate-deploy-pipeline: blocks when pipelineId missing', () => {
  const dir = makeTempDir();
  writeMarker(dir, {
    stageRunId: 'run-1',
    solutionName: 'MySolution',
    status: 'Succeeded',
    deployedAt: '2026-04-10T00:00:00.000Z',
  });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /pipelineId/);
});

test('validate-deploy-pipeline: blocks when stageRunId missing', () => {
  const dir = makeTempDir();
  writeMarker(dir, {
    pipelineId: 'pipe-1',
    solutionName: 'MySolution',
    status: 'Succeeded',
    deployedAt: '2026-04-10T00:00:00.000Z',
  });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /stageRunId/);
});

test('validate-deploy-pipeline: blocks when deployHistoryFile referenced but missing', () => {
  const dir = makeTempDir();
  writeMarker(dir, {
    pipelineId: 'pipe-1',
    stageRunId: 'run-1',
    solutionName: 'MySolution',
    status: 'Succeeded',
    deployedAt: '2026-04-10T00:00:00.000Z',
    deployHistoryFile: 'docs/deploy-history/missing.html',
  });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /Deploy history file not found/);
});

test('validate-deploy-pipeline: exits 0 when deployHistoryFile field absent (older marker)', () => {
  const dir = makeTempDir();
  writeMarker(dir, {
    pipelineId: 'pipe-1',
    stageRunId: 'run-1',
    solutionName: 'MySolution',
    status: 'Succeeded',
    deployedAt: '2026-04-10T00:00:00.000Z',
    // no deployHistoryFile field — older marker, skip the check
  });
  const result = runValidator(dir);
  assert.equal(result.code, 0, result.stderr);
});

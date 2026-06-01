#!/usr/bin/env node
/**
 * Tests for force-link-environment/scripts/validate-force-link.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const VALIDATOR = path.join(
  __dirname,
  '../../skills/force-link-environment/scripts/validate-force-link.js',
);

const VALIDATION_STATUS_SUCCEEDED = 200000001;
const VALIDATION_STATUS_FAILED = 200000002;
const VALIDATION_STATUS_PENDING = 200000000;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-force-link-'));
}

function writeMarker(dir, data) {
  const almDir = path.join(dir, 'docs', 'alm');
  fs.mkdirSync(almDir, { recursive: true });
  fs.writeFileSync(path.join(almDir, 'last-force-link.json'), JSON.stringify(data), 'utf8');
}

function runValidator(cwd) {
  const result = spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const VALID_MARKER = {
  schemaVersion: 1,
  hostEnvUrl: 'https://host.crm.dynamics.com',
  deploymentEnvironmentId: 'c44399fe-bf4a-f111-bec6-7ced8d42befa',
  bapEnvId: 'ed99292f-1616-e227-bc38-663b2f07304e',
  previousHostEnvUrl: null,
  validationStatus: VALIDATION_STATUS_SUCCEEDED,
  forcedAt: '2026-05-11T04:22:09.000Z',
};

test('exits 0 when no docs/alm/last-force-link.json present (not a force-link session)', () => {
  const dir = makeTempDir();
  const result = runValidator(dir);
  assert.equal(result.code, 0, result.stderr);
});

test('exits 0 when marker is valid and validationStatus is Succeeded', () => {
  const dir = makeTempDir();
  writeMarker(dir, VALID_MARKER);
  const result = runValidator(dir);
  assert.equal(result.code, 0, result.stderr);
});

test('blocks when validationStatus is Failed (200000002)', () => {
  const dir = makeTempDir();
  writeMarker(dir, { ...VALID_MARKER, validationStatus: VALIDATION_STATUS_FAILED });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /validationStatus=Failed/);
});

test('blocks when validationStatus is non-terminal Pending (200000000)', () => {
  const dir = makeTempDir();
  writeMarker(dir, { ...VALID_MARKER, validationStatus: VALIDATION_STATUS_PENDING });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /non-terminal validationStatus/);
});

test('blocks when schemaVersion is unsupported', () => {
  const dir = makeTempDir();
  writeMarker(dir, { ...VALID_MARKER, schemaVersion: 99 });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unsupported schemaVersion: 99/);
});

function withoutField(obj, field) {
  const copy = { ...obj };
  delete copy[field];
  return copy;
}

test('blocks when hostEnvUrl is missing', () => {
  const dir = makeTempDir();
  writeMarker(dir, withoutField(VALID_MARKER, 'hostEnvUrl'));
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /hostEnvUrl/);
});

test('blocks when deploymentEnvironmentId is missing', () => {
  const dir = makeTempDir();
  writeMarker(dir, withoutField(VALID_MARKER, 'deploymentEnvironmentId'));
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /deploymentEnvironmentId/);
});

test('blocks when forcedAt is missing', () => {
  const dir = makeTempDir();
  writeMarker(dir, withoutField(VALID_MARKER, 'forcedAt'));
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /forcedAt/);
});

test('blocks when validationStatus is not a number', () => {
  const dir = makeTempDir();
  writeMarker(dir, { ...VALID_MARKER, validationStatus: 'Succeeded' });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /validationStatus \(number\)/);
});

test('blocks when marker is not valid JSON', () => {
  const dir = makeTempDir();
  const almDir = path.join(dir, 'docs', 'alm');
  fs.mkdirSync(almDir, { recursive: true });
  fs.writeFileSync(path.join(almDir, 'last-force-link.json'), '{ not valid json', 'utf8');
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /could not be parsed as JSON/);
});

test('silent-approves when .alm-deferred is present, even with Failed marker', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, '.alm-deferred'), 'deferred for refactor', 'utf8');
  writeMarker(dir, { ...VALID_MARKER, validationStatus: VALIDATION_STATUS_FAILED });
  const result = runValidator(dir);
  assert.equal(result.code, 0, result.stderr);
});

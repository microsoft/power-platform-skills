#!/usr/bin/env node
// Tests for skills/ensure-pipelines-host/scripts/validate-ensure-host.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const VALIDATOR = path.join(
  __dirname,
  '../../skills/ensure-pipelines-host/scripts/validate-ensure-host.js',
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-ensure-host-'));
}

function writeMarker(dir, data) {
  fs.writeFileSync(path.join(dir, '.last-host-check.json'), JSON.stringify(data), 'utf8');
}

function runValidator(cwd) {
  const result = spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function validV2Marker(overrides = {}) {
  return {
    schemaVersion: 2,
    checkedAt: '2026-04-28T00:00:00.000Z',
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    sourceEnvUrl: 'https://org1e98cc97.crm.dynamics.com',
    sourceEnvId: 'src',
    resolutionStatus: 'AvailableUsingCustomHost',
    finalHostEnvUrl: 'https://pascalepipelineshost.crm.dynamics.com/',
    finalHostEnvId: '0817fd3d',
    finalHostInstanceApiUrl: 'https://pascalepipelineshost.api.crm.dynamics.com',
    isPlatformHost: false,
    actionTaken: 'none',
    pipelinesSolutionVersion: '9.1.2026034.260325188',
    ready: true,
    warnings: [],
    candidates: { existingCustomHosts: [], existingPlatformHost: null, eligibleForAppInstall: [], inaccessibleEnvs: [] },
    telemetry: { correlationId: null },
    ...overrides,
  };
}

test('exits 0 when no .last-host-check.json found', () => {
  const dir = makeTempDir();
  const r = runValidator(dir);
  assert.equal(r.code, 0);
});

test('exits 0 for valid v2 marker with ready: true', () => {
  const dir = makeTempDir();
  writeMarker(dir, validV2Marker());
  const r = runValidator(dir);
  assert.equal(r.code, 0, r.stderr);
});

test('exits 0 for valid v1 marker (forward-compatible)', () => {
  const dir = makeTempDir();
  const m = validV2Marker();
  m.schemaVersion = 1;
  delete m.candidates;
  writeMarker(dir, m);
  const r = runValidator(dir);
  assert.equal(r.code, 0, r.stderr);
});

test('exits 0 for terminal error CannotRedirect even when ready: false', () => {
  const dir = makeTempDir();
  writeMarker(dir, validV2Marker({ resolutionStatus: 'CannotRedirect', ready: false, finalHostEnvUrl: null }));
  const r = runValidator(dir);
  assert.equal(r.code, 0, r.stderr);
});

test('exits 0 for terminal error OrgSettingStale even when ready: false', () => {
  const dir = makeTempDir();
  writeMarker(dir, validV2Marker({ resolutionStatus: 'OrgSettingStale', ready: false, finalHostEnvUrl: null }));
  const r = runValidator(dir);
  assert.equal(r.code, 0);
});

test('exits 0 for terminal error PermissionDenied even when ready: false', () => {
  const dir = makeTempDir();
  writeMarker(dir, validV2Marker({ resolutionStatus: 'PermissionDenied', ready: false, finalHostEnvUrl: null }));
  const r = runValidator(dir);
  assert.equal(r.code, 0);
});

test('blocks when schemaVersion is invalid', () => {
  const dir = makeTempDir();
  writeMarker(dir, validV2Marker({ schemaVersion: 99 }));
  const r = runValidator(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /unsupported schemaVersion/);
});

test('blocks when tenantId missing', () => {
  const dir = makeTempDir();
  const m = validV2Marker();
  delete m.tenantId;
  writeMarker(dir, m);
  const r = runValidator(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /tenantId/);
});

test('blocks when sourceEnvUrl missing', () => {
  const dir = makeTempDir();
  const m = validV2Marker();
  delete m.sourceEnvUrl;
  writeMarker(dir, m);
  const r = runValidator(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /sourceEnvUrl/);
});

test('blocks when resolutionStatus missing', () => {
  const dir = makeTempDir();
  const m = validV2Marker();
  delete m.resolutionStatus;
  writeMarker(dir, m);
  const r = runValidator(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /resolutionStatus/);
});

test('blocks when resolutionStatus is unknown', () => {
  const dir = makeTempDir();
  writeMarker(dir, validV2Marker({ resolutionStatus: 'TotallyMadeUp' }));
  const r = runValidator(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /unknown resolutionStatus/);
});

test('blocks when ready: false on a non-terminal status', () => {
  const dir = makeTempDir();
  writeMarker(dir, validV2Marker({ ready: false }));
  const r = runValidator(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /requires a usable host/);
});

test('blocks when ready: true but finalHostEnvUrl missing', () => {
  const dir = makeTempDir();
  writeMarker(dir, validV2Marker({ finalHostEnvUrl: null }));
  const r = runValidator(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /finalHostEnvUrl is missing/);
});

test('blocks on malformed JSON', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, '.last-host-check.json'), '{not json', 'utf8');
  const r = runValidator(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /could not be parsed/);
});

test('NoHost status is non-terminal-error and requires ready=true (i.e. should not happen) — blocks', () => {
  const dir = makeTempDir();
  // NoHost typically means user cancelled provisioning. The skill should NOT mark ready=true with NoHost.
  writeMarker(dir, validV2Marker({ resolutionStatus: 'NoHost', ready: false, finalHostEnvUrl: null }));
  const r = runValidator(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /requires a usable host/);
});

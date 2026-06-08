'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const VALIDATOR_ENV = path.join(
  __dirname, '..', '..',
  'skills', 'setup-git-integration', 'scripts', 'validate-setup-git-integration.js',
);
const VALIDATOR_SOL = path.join(
  __dirname, '..', '..',
  'skills', 'connect-solution-to-git', 'scripts', 'validate-connect-solution-to-git.js',
);

function mkProject(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-setup-git-validator-'));
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({
    $schema: 'https://aka.ms/powerpages-config',
    siteName: 'test', compiledPath: 'dist', defaultLandingPage: 'index.html',
  }));
  if (setup) setup(dir);
  return dir;
}

function writeManifest(dir, obj) {
  fs.writeFileSync(path.join(dir, '.git-integration-manifest.json'), JSON.stringify(obj));
}

function writeMarker(dir, obj) {
  const innerDir = path.join(dir, 'docs', 'inner-loop');
  fs.mkdirSync(innerDir, { recursive: true });
  fs.writeFileSync(path.join(innerDir, 'last-setup.json'), JSON.stringify(obj));
}

function runValidator(validator, cwd) {
  return spawnSync(process.execPath, [validator], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 5000,
  });
}

const validEnvManifest = () => ({
  bindingType:     'environment',
  envUrl:          'https://contoso.crm.dynamics.com',
  organization:    'myorg',
  project:         'myproj',
  repository:      'myrepo',
  branch:          'main',
  gitFolder:       'src',
  boundAt:         '2026-05-30T00:00:00Z',
  manifestVersion: '1',
});

const validSolManifest = () => ({
  ...validEnvManifest(),
  bindingType:        'solution',
  solutionUniqueName: 'MySolution',
});

// ---------- Shared validator (setup-git-integration) ----------

test('validate-setup-git-integration: file exists and is executable', () => {
  assert.ok(fs.existsSync(VALIDATOR_ENV));
  const c = fs.readFileSync(VALIDATOR_ENV, 'utf8');
  assert.match(c, /runValidation/);
  assert.match(c, /\.git-integration-manifest\.json/);
});

test('validate-setup-git-integration: no project root → approves silently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-no-root-'));
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: manifest missing → approves silently', () => {
  const dir = mkProject();
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: valid environment manifest → approves', () => {
  const dir = mkProject((d) => writeManifest(d, validEnvManifest()));
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: valid solution manifest → approves', () => {
  const dir = mkProject((d) => writeManifest(d, validSolManifest()));
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: manifest with malformed JSON → blocks (exit 2)', () => {
  const dir = mkProject((d) => {
    fs.writeFileSync(path.join(d, '.git-integration-manifest.json'), '{not json');
  });
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: missing required field → blocks', () => {
  const m = validEnvManifest();
  delete m.organization;
  const dir = mkProject((d) => writeManifest(d, m));
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /missing required fields.*organization/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: invalid bindingType → blocks', () => {
  const m = validEnvManifest();
  m.bindingType = 'bogus';
  const dir = mkProject((d) => writeManifest(d, m));
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /bindingType/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: solution binding without solutionUniqueName → blocks', () => {
  const m = validSolManifest();
  delete m.solutionUniqueName;
  const dir = mkProject((d) => writeManifest(d, m));
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /solutionUniqueName/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: solution binding with empty solutionUniqueName → blocks', () => {
  const m = validSolManifest();
  m.solutionUniqueName = '   ';
  const dir = mkProject((d) => writeManifest(d, m));
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /solutionUniqueName/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: marker envUrl mismatch → blocks', () => {
  const dir = mkProject((d) => {
    writeManifest(d, validEnvManifest());
    writeMarker(d, { skill: 'setup-git-integration', envUrl: 'https://OTHER.crm.dynamics.com', status: 'succeeded' });
  });
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /envUrl/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: matching marker → approves', () => {
  const dir = mkProject((d) => {
    const m = validEnvManifest();
    writeManifest(d, m);
    writeMarker(d, { skill: 'setup-git-integration', envUrl: m.envUrl, status: 'succeeded' });
  });
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: malformed marker JSON → blocks', () => {
  const dir = mkProject((d) => {
    writeManifest(d, validEnvManifest());
    const innerDir = path.join(d, 'docs', 'inner-loop');
    fs.mkdirSync(innerDir, { recursive: true });
    fs.writeFileSync(path.join(innerDir, 'last-setup.json'), '{not json');
  });
  try {
    const r = runValidator(VALIDATOR_ENV, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /last-setup\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-setup-git-integration: malformed stdin → approves silently', () => {
  const r = spawnSync(process.execPath, [VALIDATOR_ENV], {
    input: 'not-json', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(r.status, 0);
});

// ---------- Alias validator (connect-solution-to-git) ----------

test('validate-connect-solution-to-git: alias file exists and re-requires shared validator', () => {
  assert.ok(fs.existsSync(VALIDATOR_SOL));
  const c = fs.readFileSync(VALIDATOR_SOL, 'utf8');
  assert.match(c, /require\(.+validate-setup-git-integration/);
});

test('validate-connect-solution-to-git: alias approves on valid solution manifest', () => {
  const dir = mkProject((d) => writeManifest(d, validSolManifest()));
  try {
    const r = runValidator(VALIDATOR_SOL, dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-connect-solution-to-git: alias blocks on missing solutionUniqueName', () => {
  const m = validSolManifest();
  delete m.solutionUniqueName;
  const dir = mkProject((d) => writeManifest(d, m));
  try {
    const r = runValidator(VALIDATOR_SOL, dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /solutionUniqueName/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

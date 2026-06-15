'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'git-configure',
  'scripts', 'validate-git-configure.js',
);

function run(cwd) {
  return spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

function makeProject(t, { marker, manifest, writeValidationMarker } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-git-configure-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const innerLoopDir = path.join(tmpDir, 'docs', 'inner-loop');
  fs.mkdirSync(innerLoopDir, { recursive: true });
  // findProjectRoot heuristic — drop a powerpages.config.json so the validator's
  // root finder locks onto this tmp dir (matches validate-branch-switch tests).
  fs.writeFileSync(
    path.join(tmpDir, 'powerpages.config.json'),
    JSON.stringify({ siteName: 'test', compiledPath: 'dist' }),
  );
  if (marker !== undefined) {
    fs.writeFileSync(
      path.join(innerLoopDir, 'last-git-configure.json'),
      typeof marker === 'string' ? marker : JSON.stringify(marker),
    );
  }
  if (writeValidationMarker !== undefined) {
    fs.writeFileSync(
      path.join(innerLoopDir, 'last-git-configure-validation.json'),
      JSON.stringify(writeValidationMarker),
    );
  }
  if (manifest !== undefined) {
    fs.writeFileSync(
      path.join(innerLoopDir, '.git-integration-manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
  }
  return tmpDir;
}

const COMMON = {
  skill: 'git-configure',
  ranAt: '2026-06-13T00:00:00Z',
  envUrl: 'https://env.crm.dynamics.com',
  status: 'ok',
};

const SETUP_MARKER = {
  ...COMMON,
  mode: 'setup',
  organization: 'contoso',
  project: 'PowerSite',
  repository: 'site-repo',
  branch: 'main',
  gitFolder: 'solutions',
  bindingType: 'environment',
};

const SETUP_MANIFEST = {
  bindingType: 'environment',
  envUrl: 'https://env.crm.dynamics.com',
  organization: 'contoso',
  project: 'PowerSite',
  repository: 'site-repo',
  branch: 'main',
  bound: true,
};

const SWITCH_MARKER = {
  ...COMMON,
  mode: 'switch-branch',
  organization: 'contoso',
  project: 'PowerSite',
  repository: 'site-repo',
  oldBranch: 'main',
  newBranch: 'feature/new-ui',
  gitFolder: 'solutions',
};

const REBIND_MARKER = {
  ...COMMON,
  mode: 'rebind',
  organization: 'contoso',
  project: 'NewProj',
  repository: 'new-site-repo',
  branch: 'main',
  gitFolder: 'solutions',
  oldOrganization: 'contoso',
  oldProject: 'OldProj',
  oldRepository: 'old-site-repo',
};

const DISCONNECT_MARKER = {
  ...COMMON,
  mode: 'disconnect',
  organization: 'contoso',
  project: 'PowerSite',
  repository: 'site-repo',
  branch: 'main',
  gitFolder: 'solutions',
};

describe('validate-git-configure: graceful approvals', () => {
  it('approves when no marker exists', (t) => {
    const dir = makeProject(t);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when a stray validation-marker file exists but no real marker (validate mode removed — file ignored)', (t) => {
    const dir = makeProject(t, {
      writeValidationMarker: { skill: 'git-configure', mode: 'validate', ranAt: '2026-06-13T00:00:00Z' },
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when cwd is not a Power Pages project (no project root found)', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-project-root-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('validate-git-configure: malformed marker', () => {
  it('blocks when marker is not valid JSON', (t) => {
    const dir = makeProject(t, { marker: '{not json' });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not valid JSON/);
  });

  it('blocks when skill field != "git-configure"', (t) => {
    const dir = makeProject(t, { marker: { ...SETUP_MARKER, skill: 'something-else' } });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /skill="something-else"/);
  });

  it('blocks when mode is not one of the 4 valid modes', (t) => {
    const dir = makeProject(t, { marker: { ...SETUP_MARKER, mode: 'bogus' } });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /mode="bogus"/);
  });

  it('blocks when status=failed', (t) => {
    const dir = makeProject(t, {
      marker: { ...SETUP_MARKER, status: 'failed' },
      manifest: SETUP_MANIFEST,
    });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /status=failed/);
  });

  it('blocks when mode=validate appears (validate mode removed — now an invalid mode)', (t) => {
    const dir = makeProject(t, { marker: { ...SETUP_MARKER, mode: 'validate' } });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /mode="validate".*not one of|not one of.*validate/i);
  });
});

describe('validate-git-configure: setup mode', () => {
  it('approves a valid setup marker with consistent manifest', (t) => {
    const dir = makeProject(t, { marker: SETUP_MARKER, manifest: SETUP_MANIFEST });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks when manifest is missing after a setup', (t) => {
    const dir = makeProject(t, { marker: SETUP_MARKER });  // no manifest
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /manifest.*missing/);
  });

  it('blocks when manifest.organization disagrees with marker.organization', (t) => {
    const dir = makeProject(t, {
      marker: SETUP_MARKER,
      manifest: { ...SETUP_MANIFEST, organization: 'rogue-org' },
    });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /organization.*does not match/);
  });

  it('blocks when manifest.branch disagrees with marker.branch', (t) => {
    const dir = makeProject(t, {
      marker: SETUP_MARKER,
      manifest: { ...SETUP_MANIFEST, branch: 'develop' },
    });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /branch.*does not match/);
  });

  it('blocks when required setup field is missing (bindingType)', (t) => {
    const m = { ...SETUP_MARKER };
    delete m.bindingType;
    const dir = makeProject(t, { marker: m, manifest: SETUP_MANIFEST });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /missing required fields.*bindingType/);
  });
});

describe('validate-git-configure: switch-branch mode', () => {
  it('approves a valid switch-branch with consistent manifest (manifest.branch === newBranch)', (t) => {
    const dir = makeProject(t, {
      marker: SWITCH_MARKER,
      manifest: { ...SETUP_MANIFEST, branch: 'feature/new-ui' },
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks no-op switch (oldBranch === newBranch)', (t) => {
    const dir = makeProject(t, {
      marker: { ...SWITCH_MARKER, oldBranch: 'main', newBranch: 'main' },
      manifest: SETUP_MANIFEST,
    });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /no-op switch/);
  });

  it('normalises refs/heads/ prefix when comparing branches', (t) => {
    const dir = makeProject(t, {
      marker: { ...SWITCH_MARKER, oldBranch: 'refs/heads/main', newBranch: 'feature/new-ui' },
      manifest: { ...SETUP_MANIFEST, branch: 'refs/heads/feature/new-ui' },
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks when manifest.branch does not match marker.newBranch', (t) => {
    const dir = makeProject(t, {
      marker: SWITCH_MARKER,
      manifest: { ...SETUP_MANIFEST, branch: 'main' },  // stale; should be feature/new-ui
    });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /branch.*does not match/);
  });

  it('blocks when oldBranch field is missing', (t) => {
    const m = { ...SWITCH_MARKER };
    delete m.oldBranch;
    const dir = makeProject(t, { marker: m, manifest: SETUP_MANIFEST });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /missing required fields.*oldBranch/);
  });
});

describe('validate-git-configure: rebind mode', () => {
  it('approves a valid rebind with manifest showing the NEW coords', (t) => {
    const dir = makeProject(t, {
      marker: REBIND_MARKER,
      manifest: {
        ...SETUP_MANIFEST,
        project: 'NewProj',  // matches marker.project
        repository: 'new-site-repo',  // matches marker.repository
      },
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks when manifest still shows the OLD project (rebind didn\'t reconcile)', (t) => {
    const dir = makeProject(t, {
      marker: REBIND_MARKER,
      manifest: { ...SETUP_MANIFEST, project: 'OldProj' },  // old, not new
    });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /project.*does not match/);
  });

  it('blocks when oldOrganization field is missing (audit trail required)', (t) => {
    const m = { ...REBIND_MARKER };
    delete m.oldOrganization;
    const dir = makeProject(t, { marker: m, manifest: SETUP_MANIFEST });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /missing required fields.*oldOrganization/);
  });
});

describe('validate-git-configure: disconnect mode', () => {
  it('approves when manifest is absent (disconnect deleted it)', (t) => {
    const dir = makeProject(t, { marker: DISCONNECT_MARKER });  // no manifest
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when manifest has bound:false (disconnect updated it in place)', (t) => {
    const dir = makeProject(t, {
      marker: DISCONNECT_MARKER,
      manifest: { ...SETUP_MANIFEST, bound: false },
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks when manifest still reports bound:true after disconnect', (t) => {
    const dir = makeProject(t, {
      marker: DISCONNECT_MARKER,
      manifest: { ...SETUP_MANIFEST, bound: true },
    });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /still.*bound:true/);
  });

  it('blocks when manifest is unreadable JSON after disconnect', (t) => {
    const dir = makeProject(t, {
      marker: DISCONNECT_MARKER,
      manifest: '{ corrupt',
    });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not valid JSON after disconnect/);
  });
});

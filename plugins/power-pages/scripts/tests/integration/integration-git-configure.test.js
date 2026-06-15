'use strict';

/*
 * Live Dataverse/Azure DevOps integration smoke tests for git-configure.
 *
 * These tests are intentionally opt-in only:
 *   $env:RUN_INTEGRATION=1
 *   $env:INTEGRATION_ENV_URL='https://<env>.crm.dynamics.com'
 *   $env:INTEGRATION_ADO_ORG='<ado-org>'
 *   $env:INTEGRATION_ADO_PROJECT='<ado-project>'
 *   $env:INTEGRATION_ADO_REPO='<ado-repo>'
 *   $env:INTEGRATION_BRANCH='main'
 *   $env:INTEGRATION_GIT_FOLDER='solutions/<folder>'
 *   node --test plugins/power-pages/scripts/tests/integration/integration-git-configure.test.js
 *
 * Optional env vars:
 *   INTEGRATION_ADO_TOKEN / ADO_TOKEN             ADO PAT or OAuth token for ADO preflights.
 *   INTEGRATION_DATAVERSE_TOKEN                  Dataverse token; otherwise helpers use az.
 *   INTEGRATION_BAP_TOKEN / INTEGRATION_ENVIRONMENT_ID  BYOK/CMK probe inputs.
 *   INTEGRATION_BINDING_TYPE                     "env" (default) or "solution".
 *   INTEGRATION_SOLUTION_UNIQUE_NAME             Required for solution binding and scoped disconnect.
 *   INTEGRATION_ROOT_FOLDER                      Required for first solution binding.
 *   INTEGRATION_NEW_BRANCH                       Required for switch-branch; must differ.
 *   INTEGRATION_PROJECT_ROOT                     Power Pages project root for marker/validator checks.
 *   INTEGRATION_SWITCH_BACK=1                    Switch back to the original branch after switch smoke.
 *
 * Scenarios:
 *   1. setup mode: requires an unbound env; binds it and leaves it bound.
 *   2. switch-branch mode: requires a bound env; replaces the bound branch.
 *   3. disconnect mode: requires a bound env; unbinds it.
 *   4. validate mode: works bound or unbound; read-only helper envelope sanity.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { detectGitBinding } = require('../../lib/detect-git-binding');
const { connectToGit } = require('../../lib/connect-to-git');
const { connectSolutionToGit } = require('../../lib/connect-solution-to-git');
const { switchBranch } = require('../../lib/switch-branch');
const { disconnectFromGit } = require('../../lib/disconnect-from-git');
const { verifyByokCmk } = require('../../lib/verify-byok-cmk');
const { verifyLicense } = require('../../lib/verify-license');
const { verifyAdoPermissions } = require('../../lib/verify-ado-permissions');
const { verifyRepoInitialized } = require('../../lib/verify-repo-initialized');
const { detectGitConfigureMode, VALID_MODES } = require('../../lib/detect-git-configure-mode');
const { ensureGitConfigureDir, gitConfigurePath } = require('../../lib/git-configure-paths');

const integrationEnabled = process.env.RUN_INTEGRATION === '1';
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const VALIDATOR = path.join(
  PLUGIN_ROOT,
  'skills',
  'git-configure',
  'scripts',
  'validate-git-configure.js',
);

if (!integrationEnabled) {
  test('integration-git-configure (skipped — set RUN_INTEGRATION=1 to run)', { skip: true }, () => {});
} else {
  test.describe('integration-git-configure', () => {
    test.before(() => {
      // Per-test guards below skip when their required variables are missing.
    });

    test('setup mode binds an UNBOUND env to ADO', async (t) => {
      if (!requireEnvOrSkip(t, [
        'INTEGRATION_ENV_URL',
        'INTEGRATION_ADO_ORG',
        'INTEGRATION_ADO_PROJECT',
        'INTEGRATION_ADO_REPO',
        'INTEGRATION_BRANCH',
        'INTEGRATION_GIT_FOLDER',
      ])) return;
      if (!requireAdoTokenOrSkip(t)) return;

      const cfg = config();
      if (cfg.bindingType === 'solution') {
        if (!requireEnvOrSkip(t, ['INTEGRATION_SOLUTION_UNIQUE_NAME', 'INTEGRATION_ROOT_FOLDER'])) return;
      }
      const before = await detectGitBinding({ envUrl: cfg.envUrl, token: cfg.dataverseToken });
      assertNoHelperError(before, 'detect-git-binding pre-check');
      if (before.bound) {
        t.skip('env already bound; setup smoke requires unbound state');
        return;
      }

      const preflight = await runSetupPreflights(cfg);
      assertEnvelope(preflight.byok, ['ok', 'keyManagedBy'], 'verify-byok-cmk');
      assertEnvelope(preflight.license, ['ok', 'gitIntegrationAvailable'], 'verify-license');
      assert.equal(preflight.ado.hasAccess, true, preflight.ado.error || preflight.ado.hint);
      assert.equal(preflight.repo.initialized, true, preflight.repo.error || preflight.repo.hint);

      const result = cfg.bindingType === 'solution'
        ? await connectSolutionToGit({
          envUrl: cfg.envUrl,
          token: cfg.dataverseToken,
          solutionUniqueName: cfg.solutionUniqueName,
          branch: cfg.branch,
          gitFolder: cfg.gitFolder,
          organization: cfg.organization,
          project: cfg.project,
          repository: cfg.repository,
          rootFolder: cfg.rootFolder,
        })
        : await connectToGit({
          envUrl: cfg.envUrl,
          token: cfg.dataverseToken,
          organization: cfg.organization,
          project: cfg.project,
          repository: cfg.repository,
          branch: cfg.branch,
          gitFolder: cfg.gitFolder,
          verify: true,
        });
      assertNoHelperError(result, 'connect-to-git');
      assert.equal(result.bound, true);

      const after = await detectGitBinding(detectArgs(cfg));
      assertBindingMatches(after, cfg, cfg.branch);

      writeMutationArtifacts(cfg, {
        mode: 'setup',
        branch: cfg.branch,
        status: 'ok',
      });
      assertValidatorApproves(cfg.projectRoot);
    });

    test('switch-branch mode replaces the bound branch', async (t) => {
      if (!requireEnvOrSkip(t, ['INTEGRATION_ENV_URL', 'INTEGRATION_NEW_BRANCH'])) return;

      const cfg = config();
      const current = await detectGitBinding(detectArgs(cfg));
      assertNoHelperError(current, 'detect-git-binding pre-check');
      if (!current.bound) {
        t.skip('env is not bound; switch-branch smoke requires bound state');
        return;
      }
      if (sameBranch(current.branch, cfg.newBranch)) {
        t.skip('INTEGRATION_NEW_BRANCH must differ from the currently bound branch');
        return;
      }
      const targetSolution = resolveTargetSolution(t, current, cfg);
      if (current.bindingType === 'solution' && !targetSolution) return;

      const switched = await switchBranch({
        envUrl: cfg.envUrl,
        token: cfg.dataverseToken,
        newBranch: cfg.newBranch,
        solutionUniqueName: targetSolution,
      });
      assertNoHelperError(switched, 'switch-branch');
      assert.equal(switched.switched, true);

      const after = await detectGitBinding(detectArgs({ ...cfg, solutionUniqueName: targetSolution }));
      assertBindingMatches(after, {
        ...cfg,
        bindingType: after.bindingType || cfg.bindingType,
        organization: switched.organization || cfg.organization,
        project: switched.project || cfg.project,
        repository: switched.repository || cfg.repository,
        gitFolder: switched.gitFolder || cfg.gitFolder,
        solutionUniqueName: targetSolution,
      }, cfg.newBranch);
      assert.equal(sameBranch(after.branch, current.branch), false, 'old branch should be replaced');

      writeMutationArtifacts({
        ...cfg,
        organization: switched.organization || cfg.organization,
        project: switched.project || cfg.project,
        repository: switched.repository || cfg.repository,
        gitFolder: switched.gitFolder || cfg.gitFolder,
        solutionUniqueName: targetSolution,
        bindingType: switched.bindingType || after.bindingType || cfg.bindingType,
      }, {
        mode: 'switch-branch',
        oldBranch: current.branch,
        newBranch: cfg.newBranch,
        status: 'ok',
      });
      assertValidatorApproves(cfg.projectRoot);

      if (process.env.INTEGRATION_SWITCH_BACK === '1') {
        const rollback = await switchBranch({
          envUrl: cfg.envUrl,
          token: cfg.dataverseToken,
          newBranch: current.branch,
          solutionUniqueName: targetSolution,
        });
        assertNoHelperError(rollback, 'switch-branch rollback');
        writeMutationArtifacts({
          ...cfg,
          organization: rollback.organization || switched.organization || cfg.organization,
          project: rollback.project || switched.project || cfg.project,
          repository: rollback.repository || switched.repository || cfg.repository,
          gitFolder: rollback.gitFolder || switched.gitFolder || cfg.gitFolder,
          solutionUniqueName: targetSolution,
          bindingType: rollback.bindingType || switched.bindingType || cfg.bindingType,
        }, {
          mode: 'switch-branch',
          oldBranch: cfg.newBranch,
          newBranch: current.branch,
          status: 'ok',
        });
        assertValidatorApproves(cfg.projectRoot);
      }
    });

    test('disconnect mode unbinds the env', async (t) => {
      if (!requireEnvOrSkip(t, ['INTEGRATION_ENV_URL'])) return;

      const cfg = config();
      const current = await detectGitBinding(detectArgs(cfg));
      assertNoHelperError(current, 'detect-git-binding pre-check');
      if (!current.bound) {
        t.skip('env is not bound; disconnect smoke requires bound state');
        return;
      }
      const targetSolution = resolveTargetSolution(t, current, cfg);
      if (current.bindingType === 'solution' && !targetSolution) return;

      const disconnected = await disconnectFromGit({
        envUrl: cfg.envUrl,
        token: cfg.dataverseToken,
        solutionUniqueName: targetSolution,
        verify: true,
      });
      assertNoHelperError(disconnected, 'disconnect-from-git');
      assert.equal(disconnected.disconnected, true);

      const after = await detectGitBinding({
        envUrl: cfg.envUrl,
        token: cfg.dataverseToken,
        ...(targetSolution ? { solutionUniqueName: targetSolution } : {}),
      });
      assertNoHelperError(after, 'detect-git-binding post-check');
      assert.equal(after.bound, false);

      writeMutationArtifacts({
        ...cfg,
        organization: current.organization || cfg.organization,
        project: current.project || cfg.project,
        repository: current.repository || cfg.repository,
        branch: current.branch || cfg.branch,
        gitFolder: current.gitFolder || cfg.gitFolder,
        solutionUniqueName: targetSolution,
        bindingType: current.bindingType || cfg.bindingType,
      }, {
        mode: 'disconnect',
        branch: current.branch || cfg.branch,
        status: 'ok',
        disconnected: true,
      });
      assertValidatorApproves(cfg.projectRoot);
    });

    test('validate mode runs helpers without mutation', async (t) => {
      if (!process.env.INTEGRATION_ENV_URL) {
        t.skip('missing required env vars: INTEGRATION_ENV_URL');
        return;
      }
      const cfg = config();
      const markerPath = gitConfigurePath(cfg.projectRoot, 'lastGitConfigure');
      const markerBefore = snapshotFile(markerPath);

      const binding = await detectGitBinding({ envUrl: cfg.envUrl, token: cfg.dataverseToken });
      assertNoHelperError(binding, 'detect-git-binding validate pre-check');

      const mode = detectGitConfigureMode({ binding, args: ['--mode=validate'] });
      assert.ok(VALID_MODES.includes(mode.mode), `unexpected mode: ${mode.mode}`);
      assert.equal(mode.mode, 'validate');

      const byok = await verifyByokCmk({
        envUrl: cfg.envUrl,
        bapToken: cfg.bapToken,
        environmentId: cfg.environmentId,
      });
      const license = await verifyLicense({ envUrl: cfg.envUrl, token: cfg.dataverseToken });
      assertEnvelope(byok, ['ok', 'keyManagedBy', 'byokEnabled'], 'verify-byok-cmk');
      assertEnvelope(license, ['ok', 'gitIntegrationAvailable', 'checkMethod'], 'verify-license');

      assert.deepEqual(snapshotFile(markerPath), markerBefore,
        'validate mode must not write last-git-configure.json');
    });
  });
}

function config() {
  const rawBindingType = (process.env.INTEGRATION_BINDING_TYPE || 'env').toLowerCase();
  return {
    envUrl: process.env.INTEGRATION_ENV_URL,
    dataverseToken: process.env.INTEGRATION_DATAVERSE_TOKEN || null,
    bapToken: process.env.INTEGRATION_BAP_TOKEN || null,
    environmentId: process.env.INTEGRATION_ENVIRONMENT_ID || null,
    adoToken: process.env.INTEGRATION_ADO_TOKEN || process.env.ADO_TOKEN || null,
    organization: process.env.INTEGRATION_ADO_ORG,
    project: process.env.INTEGRATION_ADO_PROJECT,
    repository: process.env.INTEGRATION_ADO_REPO,
    branch: process.env.INTEGRATION_BRANCH,
    newBranch: process.env.INTEGRATION_NEW_BRANCH,
    gitFolder: process.env.INTEGRATION_GIT_FOLDER,
    rootFolder: process.env.INTEGRATION_ROOT_FOLDER || null,
    solutionUniqueName: process.env.INTEGRATION_SOLUTION_UNIQUE_NAME || null,
    bindingType: rawBindingType === 'solution' ? 'solution' : 'environment',
    projectRoot: process.env.INTEGRATION_PROJECT_ROOT || process.cwd(),
  };
}

function requireEnvOrSkip(t, names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    t.skip(`missing required env vars: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

function requireAdoTokenOrSkip(t) {
  if (!process.env.INTEGRATION_ADO_TOKEN && !process.env.ADO_TOKEN) {
    t.skip('missing ADO token; set INTEGRATION_ADO_TOKEN or ADO_TOKEN');
    return false;
  }
  return true;
}

function detectArgs(cfg) {
  return {
    envUrl: cfg.envUrl,
    token: cfg.dataverseToken,
    ...(cfg.solutionUniqueName
      ? { solutionUniqueName: cfg.solutionUniqueName }
      : {}),
  };
}

async function runSetupPreflights(cfg) {
  const [byok, license, ado, repo] = await Promise.all([
    verifyByokCmk({
      envUrl: cfg.envUrl,
      bapToken: cfg.bapToken,
      environmentId: cfg.environmentId,
    }),
    verifyLicense({ envUrl: cfg.envUrl, token: cfg.dataverseToken }),
    verifyAdoPermissions({
      organization: cfg.organization,
      project: cfg.project,
      repository: cfg.repository,
      token: cfg.adoToken,
    }),
    verifyRepoInitialized({
      organization: cfg.organization,
      project: cfg.project,
      repository: cfg.repository,
      token: cfg.adoToken,
    }),
  ]);
  return { byok, license, ado, repo };
}

function assertNoHelperError(result, label) {
  assert.ok(result, `${label} returned no result`);
  assert.equal(result.error, undefined, `${label} failed: ${result.error || JSON.stringify(result)}`);
}

function assertEnvelope(result, fields, label) {
  assert.ok(result && typeof result === 'object', `${label} must return an object`);
  for (const field of fields) {
    assert.ok(Object.hasOwn(result, field), `${label} missing field ${field}`);
  }
}

function assertBindingMatches(binding, cfg, expectedBranch) {
  assertNoHelperError(binding, 'detect-git-binding');
  assert.equal(binding.bound, true);
  assert.equal(canonical(binding.organization), canonical(cfg.organization), 'organization mismatch');
  assert.equal(canonical(binding.project), canonical(cfg.project), 'project mismatch');
  assert.equal(canonical(binding.repository), canonical(cfg.repository), 'repository mismatch');
  assert.equal(stripRefs(binding.branch), stripRefs(expectedBranch), 'branch mismatch');
  assert.equal(canonicalFolder(binding.gitFolder), canonicalFolder(cfg.gitFolder), 'gitFolder mismatch');
  if (cfg.bindingType === 'solution') {
    assert.equal(binding.bindingType, 'solution');
    if (cfg.solutionUniqueName) {
      assert.equal(binding.solutionUniqueName, cfg.solutionUniqueName);
    }
  }
}

function resolveTargetSolution(t, current, cfg) {
  if (current.bindingType !== 'solution') return null;
  if (cfg.solutionUniqueName) return cfg.solutionUniqueName;
  if (Array.isArray(current.boundSolutions) && current.boundSolutions.length === 1) {
    return current.boundSolutions[0].uniqueName;
  }
  if (current.solutionUniqueName) return current.solutionUniqueName;
  t.skip('solution binding is ambiguous; set INTEGRATION_SOLUTION_UNIQUE_NAME');
  return null;
}

function writeMutationArtifacts(cfg, extra) {
  ensureProjectRoot(cfg.projectRoot);
  ensureGitConfigureDir(cfg.projectRoot);

  const marker = {
    skill: 'git-configure',
    mode: extra.mode,
    ranAt: new Date().toISOString(),
    envUrl: cfg.envUrl,
    organization: cfg.organization,
    project: cfg.project,
    repository: cfg.repository,
    branch: extra.branch || cfg.branch,
    gitFolder: cfg.gitFolder,
    bindingType: cfg.bindingType,
    solutionUniqueName: cfg.solutionUniqueName || undefined,
    status: extra.status || 'ok',
  };
  if (extra.oldBranch) marker.oldBranch = extra.oldBranch;
  if (extra.newBranch) marker.newBranch = extra.newBranch;

  fs.writeFileSync(gitConfigurePath(cfg.projectRoot, 'lastGitConfigure'), JSON.stringify(marker, null, 2));

  const manifestPath = path.join(cfg.projectRoot, '.git-integration-manifest.json');
  const manifest = {
    bound: extra.disconnected ? false : true,
    bindingType: cfg.bindingType,
    envUrl: cfg.envUrl,
    organization: cfg.organization,
    project: cfg.project,
    repository: cfg.repository,
    branch: extra.newBranch || extra.branch || cfg.branch,
    gitFolder: cfg.gitFolder,
    solutionUniqueName: cfg.solutionUniqueName || undefined,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function assertValidatorApproves(projectRoot) {
  ensureProjectRoot(projectRoot);
  const result = spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function ensureProjectRoot(projectRoot) {
  const configPath = path.join(projectRoot, 'powerpages.config.json');
  assert.ok(
    fs.existsSync(configPath),
    `INTEGRATION_PROJECT_ROOT (${projectRoot}) must contain powerpages.config.json for validator coverage`,
  );
}

function snapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  return { exists: true, content: fs.readFileSync(filePath, 'utf8') };
}

function stripRefs(branch) {
  return (branch || '').replace(/^refs\/heads\//, '');
}

function sameBranch(a, b) {
  return stripRefs(a) === stripRefs(b);
}

function canonical(value) {
  return (value || '').trim();
}

function canonicalFolder(value) {
  return canonical(value).replace(/^\/+|\/+$/g, '');
}

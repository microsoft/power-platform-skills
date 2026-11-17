'use strict';
// The RELEASED plugin's own code, for the downgrade tests: a binding store this release wrote must be read safely by the
// release before it, run unchanged (configuration-protected.test.js, the variable value records of #847). Its modules are
// loaded from a folder of their own, so each requires its own siblings and never this release's.
//
// Where it comes from, in order: the `scripts` directory MODEL_APPS_DOWNGRADE_SCRIPTS names (CI fetches the release commit
// by hash and extracts it there: .github/workflows/model-apps-script-tests.yml), else the release commit in this checkout's
// git history, extracted with `git archive` (its bytes as committed, no checkout filter). Either way the plugin manifest
// beside it must carry the release's version, so a wrong folder or commit fails loudly instead of proving a downgrade to
// something else. Where neither is there, the tests skip — except in CI (GITHUB_ACTIONS), where a missing release is a
// failure: the proof must run there.
//
// On the next release, point DOWNGRADE_RELEASE and DOWNGRADE_VERSION at the release being replaced (and the workflow's
// fetch at the same commit: tests/run-tests.test.js holds them equal).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeTempDir } = require('./temp-dirs.js');

const DOWNGRADE_RELEASE = 'cb07d811d384ebec4ef29be589539c08f2db7833'; // model-apps 2.27.0
const DOWNGRADE_VERSION = '2.27.0';
const PATHS = ['plugins/model-apps/.plugin/plugin.json', 'plugins/model-apps/scripts/lib', 'plugins/model-apps/scripts/vendor'];
const IN_CI = Boolean(process.env.GITHUB_ACTIONS);

function extracted() {
  try {
    const dir = makeTempDir('downgrade-release-');
    const tar = path.join(dir, 'release.tar');
    // `git archive` reads its paths from the top of the work tree only when run there.
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    execFileSync('git', ['archive', '--format=tar', '-o', tar, DOWNGRADE_RELEASE, ...PATHS], { cwd: top, stdio: ['ignore', 'ignore', 'ignore'] });
    // Relative names, run in the folder: GNU tar reads a `C:` in a file name as a remote host.
    execFileSync('tar', ['-xf', 'release.tar'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    return { scripts: path.join(dir, 'plugins', 'model-apps', 'scripts'), from: `git ${DOWNGRADE_RELEASE}` };
  } catch {
    return null;
  }
}

let found;
// The release's `scripts` directory, or null where it is not available.
function downgradeScripts() {
  if (found !== undefined) return found;
  const named = process.env.MODEL_APPS_DOWNGRADE_SCRIPTS;
  const at = named ? { scripts: path.resolve(named), from: named } : extracted();
  if (!at) return (found = null);
  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(at.scripts, '..', '.plugin', 'plugin.json'), 'utf8')).version;
  } catch {
    version = undefined;
  }
  if (version !== DOWNGRADE_VERSION) throw new Error(`the release from ${at.from} is version ${version}, not ${DOWNGRADE_VERSION}`);
  return (found = at.scripts);
}

// The `skip` option of a test that needs the release: false where it is available, and in CI (where its absence then fails
// the test, through requireDowngrade); the reason elsewhere.
function skipWithoutDowngrade() {
  if (downgradeScripts() || IN_CI) return false;
  return `model-apps ${DOWNGRADE_VERSION} is not available (no git history for ${DOWNGRADE_RELEASE}; set MODEL_APPS_DOWNGRADE_SCRIPTS)`;
}

// A module of the release by its path under `scripts` (e.g. 'lib/managed-bindings.js'), or a failure that says what CI must
// provide.
function requireDowngrade(rel) {
  const scripts = downgradeScripts();
  if (!scripts) throw new Error(`model-apps ${DOWNGRADE_VERSION} is required here: fetch ${DOWNGRADE_RELEASE} and set MODEL_APPS_DOWNGRADE_SCRIPTS to its plugins/model-apps/scripts`);
  return require(path.join(scripts, ...rel.split('/')));
}

module.exports = { DOWNGRADE_RELEASE, DOWNGRADE_VERSION, downgradeScripts, skipWithoutDowngrade, requireDowngrade };

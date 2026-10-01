'use strict';

// Guards the plugin's BUNDLED copies of shared code and shared skill text.
//
// Marketplace installs copy only the plugin directory, so model-apps carries physical copies of
//   * `shared/telemetry/lib` at `scripts/lib/telemetry/lib` (the 1DS library its hooks require), and
//   * the shared skill workflows at `skills/telemetry/` and `skills/report-issue/`.
// Nothing else in model-apps CI compares them with their source: `shared/telemetry/tests` has no
// workflow of its own. So an edit to one side that forgets the other gives a green build while the
// plugin ships stale code, or a stale disclosure. That happened to the telemetry workflow's
// disclosure: a Power Pages change updated its own copy and not the shared source. This suite turns
// that silent drift into a failure. It mirrors the Power Pages guard of the same name. The workflow's
// path filter includes `shared/telemetry/**` and `shared/skills/**`, so a change on either side runs it.
//
// This plugin's own `ikey.json` is deliberately NOT compared: each plugin provisions its own key and
// event stream, and copying another plugin's is exactly the mistake the repo rules forbid.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const PLUGIN_LIB = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'telemetry', 'lib');
const SHARED_LIB = path.join(REPO_ROOT, 'shared', 'telemetry', 'lib');

// Line endings are a checkout detail (a Windows checkout may convert them), so text is compared with
// them normalized. The library comparison is byte-for-byte as committed, like the Power Pages guard.
const text = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

test('bundled telemetry lib is identical to shared/telemetry/lib', (t) => {
  // An installed plugin has no `shared/` next to it; the check means something only in a repo checkout.
  if (!fs.existsSync(SHARED_LIB)) {
    t.skip('shared/telemetry/lib not present (installed plugin, not a repo checkout)');
    return;
  }
  const sharedFiles = fs.readdirSync(SHARED_LIB).filter((f) => f.endsWith('.js')).sort();
  const pluginFiles = fs.readdirSync(PLUGIN_LIB).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(pluginFiles, sharedFiles, 'plugin copy and shared source must contain the same modules — refresh the copy');
  const drifted = sharedFiles.filter((f) => text(path.join(SHARED_LIB, f)) !== text(path.join(PLUGIN_LIB, f)));
  assert.deepEqual(drifted, [], 'bundled copy has drifted from shared/telemetry/lib — re-copy these files');
});

test('bundled shared skill workflows match their shared source', (t) => {
  const pairs = [
    ['telemetry', 'telemetry-workflow.md'],
    ['report-issue', 'report-issue-workflow.md'],
  ];
  if (!fs.existsSync(path.join(REPO_ROOT, 'shared', 'skills'))) {
    t.skip('shared/skills not present (installed plugin, not a repo checkout)');
    return;
  }
  const drifted = pairs.filter(([skill, file]) =>
    text(path.join(REPO_ROOT, 'shared', 'skills', skill, file)) !== text(path.join(PLUGIN_ROOT, 'skills', skill, file)));
  assert.deepEqual(drifted.map(([skill, file]) => `skills/${skill}/${file}`), [],
    'edit shared/skills first, then copy the workflow into every plugin that bundles it');
});

test('the telemetry status disclosure says Model Apps sends no user identifier', () => {
  // The /telemetry skill shows this output verbatim, so it is the user-facing privacy statement. The
  // Power Pages-only fields (the Entra object id and the site framework) must never be claimed here.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apps-disclosure-'));
  try {
    const result = spawnSync(process.execPath, [path.join(PLUGIN_LIB, 'telemetry-config.js'), '--action', 'status', '--plugin', 'model-apps'], {
      encoding: 'utf8',
      env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Model Apps excludes the signed-in user's Entra object ID/);
    assert.doesNotMatch(result.stdout, /aadObjectId|eventInfo\.framework/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

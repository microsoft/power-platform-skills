'use strict';
// REAL BUNDLES: a `.maker-workspace` the PREVIOUS release wrote, and a download or a teardown as the FIRST thing this release does
// with it — no build of this release has re-read a copy first. Each path starts from the state the previous release's bundle left
// (helpers/workspace-upgrade.js) and is compared with the same step on a workspace this release's bundle wrote. See
// workspace-upgrade-real-bundle.test.js for why every copy is "old" after the upgrade, and for the rebuilds.
//   DOWNLOAD  reads the environment through a throwaway workspace and writes the spec and its baseline into the app folder that holds
//             the old workspace: it writes nothing to the environment and gives the spec a current workspace gives
//   TEARDOWN  fences the old workspace while it deletes: it deletes what it deletes after a current build, and leaves the environment
//             as it was before the build (but the build's publisher)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { diffContents } = require('./helpers/lifecycle-harness.js');
const { skipWithoutPrevious } = require('./helpers/previous-bundle.js');
const { startFrom, stage, withoutIds, appUniqueName, kitchenSinkSpec } = require('./helpers/workspace-upgrade.js');

const SKIP = skipWithoutPrevious();

let downloadP;
const downloadPaths = () => downloadP || (downloadP = (async () => {
  const run = async (which) => {
    const s = await startFrom(which);
    // Into the app folder itself, beside the old workspace: the download's baseline goes into that workspace.
    s.download = await s.next.measure(() => s.next.download(appUniqueName(kitchenSinkSpec()), s.next.appDir));
    s.afterDownload = s.org.inventory();
    return s;
  };
  return { upgrade: await run('previous'), control: await run('current') };
})());

test('upgrade: a first download beside the old workspace writes nothing to the environment and gives the spec a current workspace gives', { skip: SKIP }, async () => {
  const { upgrade, control } = await downloadPaths();
  stage(upgrade.build, 'previous release\'s build');
  const download = stage(upgrade.download, 'download').value;
  const current = stage(control.download, 'control download').value;
  assert.equal(download.emitted.ok, true, download.stderr);
  assert.deepEqual(upgrade.download.writes, {}, 'a download writes nothing');
  assert.deepEqual(upgrade.afterDownload, upgrade.afterBuild);
  assert.equal(withoutIds(download.spec), withoutIds(current.spec), 'the same spec, but for the ids the fake mints at random');
  assert.deepEqual(download.stderr.split('\n').sort(), current.stderr.split('\n').sort(), 'and the same warnings');
  assert.ok(fs.existsSync(path.join(upgrade.next.workspaceDir, 'last-applied.json')), 'its baseline is written into the old workspace');
});

let teardownP;
const teardownPaths = () => teardownP || (teardownP = (async () => {
  const run = async (which) => {
    const s = await startFrom(which);
    s.teardown = await s.next.measure(() => s.next.teardown(kitchenSinkSpec()));
    s.afterTeardown = s.org.inventory();
    s.afterTeardownContents = s.org.contents();
    return s;
  };
  return { upgrade: await run('previous'), control: await run('current') };
})());

test('upgrade: a first teardown over the old workspace deletes what it deletes after a current build, and leaves the environment as it was', { skip: SKIP }, async () => {
  const { upgrade, control } = await teardownPaths();
  stage(upgrade.build, 'previous release\'s build');
  const { value: { result } } = stage(upgrade.teardown, 'teardown');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(upgrade.teardown.writes, stage(control.teardown, 'control teardown').writes, 'the same deletes as after a current build');
  const builtPublisher = upgrade.afterBuild.rows.publishers.filter((p) => !upgrade.seed.rows.publishers.includes(p));
  const now = upgrade.afterTeardown;
  assert.deepEqual({ ...now, rows: { ...now.rows, publishers: now.rows.publishers.filter((p) => !builtPublisher.includes(p)) } }, upgrade.seed, 'every row but the build\'s publisher is as it was before the build');
  assert.deepEqual(diffContents(upgrade.seedContents, upgrade.afterTeardownContents, { added: false }), [], 'and holds exactly what it held');
});

'use strict';
// How the tests of solution-settings.js find, recognise and read the folder a pac fallback works in.
//
// The script makes that folder with lib/temp-workspace.js (`makeTempWorkspace('solution-settings-', { lent: true })`), so that the folder of a run that is KILLED — which runs nothing — can be found and
// removed by a later run's sweep: it is `<temp>/power-platform-skills-model-apps/solution-settings-<pid>-<six characters>` and holds an owner record, `.owner.json`. Where the plugin's own folder cannot be
// used the maker falls back to the temp folder itself, as the script always did — `<temp>/solution-settings-<six characters>`, with no record, and never swept. What the script guarantees about the
// folder (it is its owner's alone, emptied when it stays, said, and removed however the run ends) does not depend on which of the two it was made in, so a test that finds a work folder by its name accepts
// both (`WORK_FOLDER`), and the tests that are about where it is made say which they mean (`assertMadeByTheMaker`).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OWNER_FILE, workspaceParent } = require('../../lib/temp-workspace.js');

// `solution-settings-4242-AbC123`: the pid of the run that made the folder, then the six characters mkdtemp adds.
const RECORDED_WORK_FOLDER = /^solution-settings-(\d+)-[A-Za-z0-9]{6}$/;
// `solution-settings-AbC123`: what the maker falls back to in the temp folder itself.
const PLAIN_WORK_FOLDER = /^solution-settings-[A-Za-z0-9]{6}$/;
// Either of the two: a work folder is recognised by its name wherever the run made it.
const WORK_FOLDER = /^solution-settings-(?:\d+-)?[A-Za-z0-9]{6}$/;
// What the name of a work folder starts with, as `fs.mkdtempSync` is given it (it adds the six characters): `solution-settings-4242-` in the plugin's folder, `solution-settings-` in the temp folder. A test's own
// folders (`solution-settings-test-…`, `solution-settings-real-…`) are not work folders.
const WORK_FOLDER_START = /^solution-settings-(?:\d+-)?$/;

// The plugin's own folder of a process whose temp folder (TEMP and TMP, or TMPDIR) is `temp`.
const pluginFolderOf = (temp = os.tmpdir()) => workspaceParent({ os: { tmpdir: () => temp } });

// A folder's entries, or none when there is no folder to list: the plugin's folder is removed by a process that ends with nothing in it, and a test that makes the plugin's folder unusable puts a file where it would be.
function listing(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

// The work folders of a process whose temp folder is `temp`: in the plugin's folder and, where the plugin's folder could not be used, in the temp folder itself.
function workFoldersIn(temp = os.tmpdir()) {
  return [pluginFolderOf(temp), temp].flatMap((dir) => listing(dir).filter((name) => WORK_FOLDER.test(name)).map((name) => path.join(dir, name))).sort();
}

// Every file under `dir`, whatever its name, as a path (a folder that is empty has none).
function filesUnder(dir) {
  return listing(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return fs.lstatSync(full).isDirectory() ? filesUnder(full) : [full];
  }).sort();
}

// What is in a work folder but for the owner record: the files this script and pac wrote. The record (lib/temp-workspace.js) is the plugin's own — the pid and the host of the process that made the folder,
// when, and that the folder was lent to pac — and holds nothing that the run read or pac wrote, so it is neither a file the script empties nor one that a test of what stayed is about. A test that reads
// every file of the folder for a value reads it with the rest (`assertNoneOnDisk` of solution-settings-tokens.test.js does).
const entriesOf = (folder) => fs.readdirSync(folder).filter((name) => name !== OWNER_FILE).sort();

// The owner record of a work folder, parsed, or null when it has none (a folder the maker made in the plain temp folder is not recorded).
function ownerRecordOf(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, OWNER_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// That `folder` is made as the maker makes the work folder of a run: in the plugin's own folder of the temp folder `temp`, named for the pid of the run, recorded under that pid, and LENT — pac is given paths in it,
// and a sweep keeps a lent folder from under a pac that a killed run left running until the folder is old. `pid` is the run's, when the test knows it. The record is read from the folder, unless the test
// read it while the folder was there (`record`: a folder that is removed has none). Answers the record.
function assertMadeByTheMaker(folder, { temp = os.tmpdir(), pid, record = ownerRecordOf(folder) } = {}) {
  assert.strictEqual(path.dirname(folder), pluginFolderOf(temp), `${folder} is in the plugin's own folder of the temp folder, not loose in it`);
  const named = RECORDED_WORK_FOLDER.exec(path.basename(folder));
  assert.ok(named, `${path.basename(folder)} is named for the pid of the run that made it`);
  assert.ok(record, 'and holds the owner record a sweep reads');
  assert.strictEqual(record.pid, Number(named[1]), 'which names the pid the folder is named for');
  if (pid !== undefined) assert.strictEqual(record.pid, pid, 'the pid of the run');
  assert.strictEqual(record.lent, true, 'and says the folder was lent to pac');
  return record;
}

/**
 * Makes the work folder fail to be made, in each of the two ways the maker tries: `fs.mkdtempSync`, which it calls for both, refuses a folder whose name starts as a work folder's does, and the test sees
 * the refusals in the returned list. `plugin` is the code of the system that the plugin's own folder answers with and `plain` the code of the call it falls back to in the temp folder itself; the error a run
 * reports is the one that fails last, so two different codes show which one it was. A `null` code lets that way through: the run goes on there.
 *
 * Not EACCES for the plugin's folder: on Windows that code (like EPERM and EBUSY) is a refusal of the kind a folder that is being removed gives for a moment, so the plugin's folder is asked again six times
 * over three quarters of a second, and then not at all by the rest of the process — which would move every later run of the test file to the temp folder itself (lib/temp-workspace.js
 * `windowsRefusesForAMoment`, `refusing`). A disk that is full there (ENOSPC) is a plain no.
 * @param {import('node:test').TestContext} t - the test the refusal lasts for
 */
function refusingWorkFolders(t, { plugin = 'ENOSPC', plain = 'EACCES' } = {}) {
  const real = fs.mkdtempSync;
  const refused = [];
  fs.mkdtempSync = function mkdtempSync(prefix, ...rest) {
    if (WORK_FOLDER_START.test(path.basename(String(prefix)))) {
      const way = path.dirname(String(prefix)) === pluginFolderOf() ? 'plugin' : 'plain';
      const code = way === 'plugin' ? plugin : plain;
      if (code) {
        refused.push({ way, code, prefix: String(prefix) });
        throw Object.assign(new Error(`${code}: cannot make a folder, mkdtemp '${prefix}XXXXXX'`), { code });
      }
    }
    return real.call(this, prefix, ...rest);
  };
  t.after(() => {
    fs.mkdtempSync = real;
    // The maker makes the plugin's folder before it asks it for a workspace, and takes it away when the process ends if nothing is in it, a refused workspace included: the tests that follow in this process should not find it
    // either, so it is this test's to remove now (`rmdir` takes an empty folder and nothing else).
    try { fs.rmdirSync(pluginFolderOf()); } catch { /* not there, or something is in it */ }
  });
  return refused;
}

module.exports = { WORK_FOLDER, RECORDED_WORK_FOLDER, PLAIN_WORK_FOLDER, pluginFolderOf, workFoldersIn, filesUnder, entriesOf, ownerRecordOf, assertMadeByTheMaker, refusingWorkFolders };

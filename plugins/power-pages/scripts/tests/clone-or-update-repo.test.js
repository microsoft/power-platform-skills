'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { cloneOrUpdateRepo } = require('../lib/clone-or-update-repo');

// Flat layout: cloneDir chosen by the user at git-configure time.
const CLONE_DIR = 'C:\\pp-clones\\my-repo';
const REPO_DIR = path.join(CLONE_DIR, 'repo');
const PP_MERGE_DIR = path.join(CLONE_DIR, '.pp-merge');
const REPO_URL = 'https://dev.azure.com/org/project/_git/repo';
const TOKEN = 'SECRET_TOKEN';

function ok(stdout = '') {
  return { ok: true, code: 0, stdout, stderr: '' };
}

function fail(stderr = 'failed') {
  return { ok: false, code: 1, stdout: '', stderr };
}

function eexistError() {
  const error = new Error('file exists');
  error.code = 'EEXIST';
  return error;
}

function fakeFs({ gitDir = false } = {}) {
  const files = new Set(gitDir ? [path.join(REPO_DIR, '.git')] : []);
  return {
    existsSync(filePath) {
      return files.has(filePath);
    },
    statSync() {
      return { mtimeMs: 0 };
    },
    writeFileSync(filePath) {
      files.add(filePath);
    },
    unlinkSync(filePath) {
      files.delete(filePath);
    },
  };
}

function makeDeps({
  fsImpl = fakeFs(),
  remoteUrl = REPO_URL,
  mergeState = { inProgressMerge: false, unmergedPaths: [], markerFiles: [], clean: true },
  branchResolvable = true,
  revParseGitDirOk = true,
} = {}) {
  const calls = [];
  const deps = {
    fsImpl,
    cloneDirLayout(dir) {
      calls.push(['cloneDirLayout', dir]);
      return { cloneDir: dir, repoDir: REPO_DIR, ppMergeDir: PP_MERGE_DIR };
    },
    prepareCacheDirs(paths, receivedFs) {
      calls.push(['prepareCacheDirs', paths, receivedFs === fsImpl]);
      return paths;
    },
    wipeClone(args) {
      calls.push(['wipeClone', args]);
      return { wiped: true };
    },
    detectMergeState(args) {
      calls.push(['detectMergeState', args]);
      return mergeState;
    },
    git: {
      scrubToken(text, token) {
        return String(text || '').split(String(token || '')).join('***');
      },
      clone(args) {
        calls.push(['clone', args]);
        return ok();
      },
      fetch(args) {
        calls.push(['fetch', args]);
        return ok();
      },
      runGit(args) {
        calls.push(['runGit', args]);
        const joined = args.args.join(' ');
        if (joined === 'rev-parse --git-dir') return revParseGitDirOk ? ok('.git\n') : fail();
        if (joined === 'remote get-url origin') return ok(`${remoteUrl}\n`);
        if (joined === 'rev-parse --verify origin/main') return branchResolvable ? ok('origin-sha\n') : fail();
        if (joined === 'rev-parse --verify main') return branchResolvable ? ok('local-sha\n') : fail();
        if (joined === 'checkout -B main origin/main') return ok();
        if (joined === 'reset --hard origin/main') return ok();
        if (joined === 'clean -fd') return ok();
        if (joined === 'config core.longpaths true') return ok();
        if (joined === 'rev-parse origin/main') return ok('branch-tip-sha\n');
        if (joined === 'rev-parse HEAD') return ok('head-sha\n');
        return fail(`unexpected git args: ${joined}`);
      },
    },
  };
  return { deps, calls };
}

function baseArgs(deps, fsImpl) {
  return {
    cloneDir: CLONE_DIR,
    repoUrl: REPO_URL,
    branch: 'main',
    token: TOKEN,
    deps,
    fsImpl,
  };
}

test('flat layout: repoDir = <cloneDir>/repo and ppMergeDir = <cloneDir>/.pp-merge', async () => {
  const fsImpl = fakeFs({ gitDir: false });
  const { deps } = makeDeps({ fsImpl });

  const result = await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

  assert.equal(result.cloneDir, CLONE_DIR);
  assert.equal(result.repoDir, REPO_DIR);
  assert.equal(result.ppMergeDir, PP_MERGE_DIR);
});

test('fresh clone calls git.clone with branch, target dir, and token', async () => {
  const fsImpl = fakeFs({ gitDir: false });
  const { deps, calls } = makeDeps({ fsImpl });

  const result = await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

  assert.equal(result.cloned, true);
  assert.equal(result.reused, false);
  assert.equal(result.reCloned, false);
  assert.equal(result.locked, false);
  assert.equal(result.branchTip, 'branch-tip-sha');
  const cloneCall = calls.find((c) => c[0] === 'clone')[1];
  assert.deepEqual(cloneCall, { repoUrl: REPO_URL, dir: REPO_DIR, branch: 'main', token: TOKEN });
});

test('all 9 contract fields present on fresh clone', async () => {
  const fsImpl = fakeFs({ gitDir: false });
  const { deps } = makeDeps({ fsImpl });

  const result = await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

  for (const field of ['cloneDir', 'repoDir', 'ppMergeDir', 'branchTip', 'cloned', 'reused', 'reCloned', 'inProgressMerge', 'locked']) {
    assert.ok(Object.prototype.hasOwnProperty.call(result, field), `missing field: ${field}`);
  }
});

test('existing valid clean clone fetches and resets to origin branch', async () => {
  const fsImpl = fakeFs({ gitDir: true });
  const { deps, calls } = makeDeps({ fsImpl });

  const result = await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

  assert.equal(result.reused, true);
  assert.equal(result.cloned, false);
  assert.equal(result.reCloned, false);
  assert.equal(result.locked, false);
  assert.ok(calls.some((c) => c[0] === 'fetch' && c[1].cwd === REPO_DIR && c[1].remote === 'origin' && c[1].token === TOKEN));
  assert.ok(calls.some((c) => c[0] === 'runGit' && c[1].args.join(' ') === 'reset --hard origin/main'));
  assert.ok(calls.some((c) => c[0] === 'runGit' && c[1].args.join(' ') === 'clean -fd'));
});

test('existing in-progress merge returns without fetch or reset', async () => {
  const fsImpl = fakeFs({ gitDir: true });
  const mergeState = { inProgressMerge: true, unmergedPaths: ['a.txt'], markerFiles: [], clean: false };
  const { deps, calls } = makeDeps({ fsImpl, mergeState });

  const result = await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

  assert.equal(result.inProgressMerge, true);
  assert.equal(result.reused, true);
  assert.equal(result.cloned, false);
  assert.equal(result.reCloned, false);
  assert.equal(result.locked, false);
  assert.deepEqual(result.mergeState, mergeState);
  assert.equal(calls.some((c) => c[0] === 'fetch'), false);
  assert.equal(calls.some((c) => c[0] === 'runGit' && c[1].args.join(' ') === 'reset --hard origin/main'), false);
});

test('remote URL mismatch wipes and re-clones using cloneDir', async () => {
  const fsImpl = fakeFs({ gitDir: true });
  const { deps, calls } = makeDeps({ fsImpl, remoteUrl: 'https://dev.azure.com/other/project/_git/repo' });

  const result = await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

  assert.equal(result.reCloned, true);
  assert.equal(result.cloned, false);
  assert.equal(result.locked, false);
  const wipeCall = calls.find((c) => c[0] === 'wipeClone');
  assert.ok(wipeCall, 'wipeClone should have been called');
  assert.equal(wipeCall[1].cloneDir, CLONE_DIR);
  assert.ok(calls.some((c) => c[0] === 'clone' && c[1].dir === REPO_DIR && c[1].branch === 'main'));
});

test('fresh existing lock returns locked:true with other 8 fields false/null', async () => {
  const originalNow = Date.now;
  Date.now = () => 2_000_000;
  const fsImpl = {
    existsSync() {
      return false;
    },
    statSync(filePath) {
      assert.equal(filePath, path.join(PP_MERGE_DIR, 'run.lock'));
      return { mtimeMs: 2_000_000 - 1000 };
    },
    writeFileSync(filePath, _contents, options) {
      assert.equal(filePath, path.join(PP_MERGE_DIR, 'run.lock'));
      assert.equal(options.flag, 'wx');
      throw eexistError();
    },
    unlinkSync() {
      assert.fail('fresh lock must not be unlinked');
    },
  };
  const { deps, calls } = makeDeps({ fsImpl });
  try {
    const result = await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

    assert.equal(result.locked, true);
    assert.equal(result.cloned, false);
    assert.equal(result.reused, false);
    assert.equal(result.reCloned, false);
    assert.equal(result.inProgressMerge, false);
    assert.equal(result.branchTip, null);
    assert.equal(result.cloneDir, CLONE_DIR);
    assert.equal(result.repoDir, REPO_DIR);
    assert.equal(result.ppMergeDir, PP_MERGE_DIR);
    assert.equal(calls.some((c) => c[0] === 'clone'), false);
  } finally {
    Date.now = originalNow;
  }
});

test('stale existing lock is unlinked and acquired with one retry', async () => {
  const originalNow = Date.now;
  Date.now = () => 2_000_000;
  let writeAttempts = 0;
  let unlinkCount = 0;
  const fsImpl = {
    existsSync() {
      return false;
    },
    statSync(filePath) {
      assert.equal(filePath, path.join(PP_MERGE_DIR, 'run.lock'));
      return { mtimeMs: 0 };
    },
    writeFileSync(filePath, _contents, options) {
      assert.equal(filePath, path.join(PP_MERGE_DIR, 'run.lock'));
      assert.equal(options.flag, 'wx');
      writeAttempts += 1;
      if (writeAttempts === 1) throw eexistError();
    },
    unlinkSync(filePath) {
      assert.equal(filePath, path.join(PP_MERGE_DIR, 'run.lock'));
      unlinkCount += 1;
    },
  };
  const { deps } = makeDeps({ fsImpl });
  try {
    const result = await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

    assert.equal(result.locked, false);
    assert.equal(result.cloned, true);
    assert.equal(writeAttempts, 2);
    assert.equal(unlinkCount, 2); // one for stale lock, one from releaseLock
  } finally {
    Date.now = originalNow;
  }
});

test('stale existing lock retry returns locked when another process wins create race', async () => {
  const originalNow = Date.now;
  Date.now = () => 2_000_000;
  let writeAttempts = 0;
  let unlinkCount = 0;
  const fsImpl = {
    existsSync() {
      return false;
    },
    statSync(filePath) {
      assert.equal(filePath, path.join(PP_MERGE_DIR, 'run.lock'));
      return { mtimeMs: 0 };
    },
    writeFileSync(filePath, _contents, options) {
      assert.equal(filePath, path.join(PP_MERGE_DIR, 'run.lock'));
      assert.equal(options.flag, 'wx');
      writeAttempts += 1;
      throw eexistError();
    },
    unlinkSync(filePath) {
      assert.equal(filePath, path.join(PP_MERGE_DIR, 'run.lock'));
      unlinkCount += 1;
    },
  };
  const { deps, calls } = makeDeps({ fsImpl });
  try {
    const result = await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

    assert.equal(result.locked, true);
    assert.equal(writeAttempts, 2);
    assert.equal(unlinkCount, 1);
    assert.equal(calls.some((c) => c[0] === 'clone'), false);
  } finally {
    Date.now = originalNow;
  }
});

test('prepareCacheDirs called with flat layout before locking', async () => {
  const fsImpl = fakeFs({ gitDir: false });
  const { deps, calls } = makeDeps({ fsImpl });

  await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

  const prepareCall = calls.find((c) => c[0] === 'prepareCacheDirs');
  assert.ok(prepareCall, 'prepareCacheDirs should be called');
  assert.deepEqual(prepareCall[1], { cloneDir: CLONE_DIR, repoDir: REPO_DIR, ppMergeDir: PP_MERGE_DIR });
  assert.equal(prepareCall[2], true, 'fsImpl identity should match');
});

test('wipeAndClone calls prepareCacheDirs again after wipe', async () => {
  const fsImpl = fakeFs({ gitDir: true });
  const { deps, calls } = makeDeps({ fsImpl, remoteUrl: 'https://dev.azure.com/different/_git/repo' });

  await cloneOrUpdateRepo(baseArgs(deps, fsImpl));

  const prepareCalls = calls.filter((c) => c[0] === 'prepareCacheDirs');
  assert.ok(prepareCalls.length >= 2, 'prepareCacheDirs called at least twice (initial + after wipe)');
  const wipeIdx = calls.findIndex((c) => c[0] === 'wipeClone');
  const secondPrepareIdx = calls.findIndex((c, i) => i > wipeIdx && c[0] === 'prepareCacheDirs');
  assert.ok(secondPrepareIdx > wipeIdx, 'prepareCacheDirs called after wipeClone');
});


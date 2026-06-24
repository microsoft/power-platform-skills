'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gitExec = require('../lib/git-exec');
const { stageGitMerge } = require('../lib/stage-git-merge');

const REL = 'web-templates/Tpl/Tpl.webtemplate.source.html';
const ADO_PATH = `/${REL}`;
const GIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'Power Pages Test',
  GIT_AUTHOR_EMAIL: 'powerpages-test@localhost',
  GIT_COMMITTER_NAME: 'Power Pages Test',
  GIT_COMMITTER_EMAIL: 'powerpages-test@localhost',
});

const gitProbe = gitExec.runGit({ args: ['--version'], retries: 0, timeoutMs: 5000 });

function git(repoDir, args) {
  return gitExec.runGit({
    cwd: repoDir,
    args,
    env: GIT_IDENTITY,
    retries: 0,
    timeoutMs: 10000,
  });
}

function assertGit(repoDir, args, label) {
  const result = git(repoDir, args);
  assert.strictEqual(result.ok, true, `${label || args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result;
}

function writeText(repoDir, rel, content) {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function commitAll(repoDir, message) {
  assertGit(repoDir, ['add', '--all'], 'git add');
  assertGit(repoDir, ['commit', '-m', message], 'git commit');
  return assertGit(repoDir, ['rev-parse', 'HEAD'], 'git rev-parse HEAD').stdout.trim();
}

function initRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpages-stage-git-merge-'));
  assertGit(repoDir, ['init'], 'git init');
  assertGit(repoDir, ['config', 'user.email', 'powerpages-test@localhost'], 'git config user.email');
  assertGit(repoDir, ['config', 'user.name', 'Power Pages Test'], 'git config user.name');
  assertGit(repoDir, ['config', 'core.autocrlf', 'false'], 'git config core.autocrlf');
  return repoDir;
}

function removeRepo(repoDir) {
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
}

function buildBaseAndTheirs({ baseContent, theirsContent }) {
  const repoDir = initRepo();
  writeText(repoDir, REL, baseContent);
  const base = commitAll(repoDir, 'BASE');
  assertGit(repoDir, ['checkout', '-b', 'ado-tip'], 'git checkout -b ado-tip');
  writeText(repoDir, REL, theirsContent);
  const theirs = commitAll(repoDir, 'THEIRS');
  assertGit(repoDir, ['checkout', base], 'git checkout BASE');
  return { repoDir, base, theirs };
}

test('stageGitMerge real git integration', { skip: gitProbe.ok ? false : 'git is not on PATH' }, async (t) => {
  await t.test('conflicted merge writes real markers and unmerged UU status', () => {
    const eol = '\n';
    let repoDir, base, theirs;
    try {
      ({ repoDir, base, theirs } = buildBaseAndTheirs({
        baseContent: ['A', 'B', 'C', ''].join(eol),
        theirsContent: ['A', 'B-theirs', 'C', ''].join(eol),
      }));

      const result = stageGitMerge({
        repoDir,
        baseCommit: base,
        theirsRef: theirs,
        textUnits: [{ adoPath: ADO_PATH, oursContent: ['A', 'B-mine', 'C', ''].join(eol) }],
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.merge.conflicted, true);
      assert.strictEqual(result.merge.clean, false);

      const merged = fs.readFileSync(path.join(repoDir, REL), 'utf8');
      assert.match(merged, /<<<<<<< /);
      assert.match(merged, /=======/);
      assert.match(merged, />>>>>>> /);
      assert.match(merged, /B-mine/);
      assert.match(merged, /B-theirs/);

      const status = gitExec.status({ cwd: repoDir });
      assert.strictEqual(status.ok, true, status.stderr);
      assert.match(status.stdout, new RegExp(`(^|\\n)UU ${REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`));
    } finally {
      removeRepo(repoDir);
    }
  });

  await t.test('clean non-overlapping merge auto-commits without markers', () => {
    const eol = '\n';
    let repoDir, base, theirs;
    try {
      ({ repoDir, base, theirs } = buildBaseAndTheirs({
        baseContent: ['A', 'B', 'C', ''].join(eol),
        theirsContent: ['A', 'B', 'C-theirs', ''].join(eol),
      }));

      const result = stageGitMerge({
        repoDir,
        baseCommit: base,
        theirsRef: theirs,
        textUnits: [{ adoPath: ADO_PATH, oursContent: ['A-mine', 'B', 'C', ''].join(eol) }],
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.merge.clean, true);
      assert.strictEqual(result.merge.conflicted, false);
      assert.match(result.mergeCommit, /^[0-9a-f]{40}$/);

      const merged = fs.readFileSync(path.join(repoDir, REL), 'utf8');
      assert.doesNotMatch(merged, /<<<<<<<|=======|>>>>>>>/);
      assert.match(merged, /A-mine/);
      assert.match(merged, /C-theirs/);
    } finally {
      removeRepo(repoDir);
    }
  });
});

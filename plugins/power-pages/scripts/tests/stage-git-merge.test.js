'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { stageGitMerge, pickBaseCommit, parseUnmergedPaths, DATAVERSE_BRANCH, THEIRS_BRANCH } = require('../lib/stage-git-merge');

// Build a mocked git-exec + fs. `merge` outcome, `show` (THEIRS) content, status
// porcelain and HEAD sha are configurable per test.
function makeMocks({ mergeOk = false, theirs = 'a\r\nb\r\nc\r\n', porcelain = '', headSha = 'mergedsha' } = {}) {
  const calls = [];
  const writes = new Map();
  const gitImpl = {
    runGit({ cwd, args }) {
      calls.push(args);
      const sub = args[0];
      if (sub === 'show') return { ok: true, code: 0, stdout: theirs, stderr: '' };
      if (sub === 'rev-parse') return { ok: true, code: 0, stdout: 'resolvedsha\n', stderr: '' };
      if (sub === 'cat-file') return { ok: true, code: 0, stdout: '', stderr: '' };
      if (sub === 'merge') return mergeOk ? { ok: true, code: 0, stdout: '', stderr: '' } : { ok: false, code: 1, stdout: '', stderr: 'CONFLICT' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
    addAll({ cwd }) { calls.push(['addAll']); return { ok: true, code: 0, stdout: '', stderr: '' }; },
    status({ cwd }) { calls.push(['status']); return { ok: true, code: 0, stdout: porcelain, stderr: '' }; },
    revParse({ cwd, rev }) { calls.push(['revParse', rev]); return { ok: true, code: 0, stdout: headSha + '\n', stderr: '' }; },
  };
  const fsImpl = {
    mkdirSync() {},
    writeFileSync(p, content) { writes.set(String(p).replace(/\\/g, '/'), content); },
  };
  return { gitImpl, fsImpl, calls, writes };
}

const REL = 'solutions/RetailOS/powerpagesites/site/web-templates/Search-Results/Search-Results.webtemplate.source.html';

test('parseUnmergedPaths picks only unmerged states', () => {
  assert.deepStrictEqual(parseUnmergedPaths('UU a\nAA b\n M c\nUD d\nDD e\n'), ['a', 'b', 'd', 'e']);
  assert.deepStrictEqual(parseUnmergedPaths(''), []);
});

test('pickBaseCommit picks the first candidate containing all conflicted files', () => {
  const has = { A: [], B: ['p1', 'p2'], C: ['p1'] };
  const git = (args) => {
    if (args[0] === 'rev-parse') { const c = String(args[3]).replace('^{commit}', ''); return { ok: ['A', 'B', 'C'].includes(c), stdout: c }; }
    if (args[0] === 'cat-file') { const [commit, p] = String(args[2]).split(':'); return { ok: (has[commit] || []).includes(p) }; }
    return { ok: false };
  };
  assert.strictEqual(pickBaseCommit({ candidates: ['A', 'B', 'C'], relPaths: ['p1', 'p2'], git }), 'B'); // B has all
  assert.strictEqual(pickBaseCommit({ candidates: ['C', 'B'], relPaths: ['p1', 'p2'], git }), 'B');      // C has 1, B has all → B
  assert.strictEqual(pickBaseCommit({ candidates: ['A', 'C'], relPaths: ['p1', 'p2'], git }), 'C');      // none has all → most (C=1)
  assert.strictEqual(pickBaseCommit({ candidates: ['Z'], relPaths: ['p1'], git }), null);                // none valid
});

// ---- A2: auto-discovery + add/add detection ----
test('A2 pickBaseCommit: auto-discovers a containing ANCESTOR (never the THEIRS tip) when candidates miss files', () => {
  // candidates A/B don't contain p1; THEIRS history newest-first = [tip, H1, H2].
  // tip + H1 both contain all files, but the tip must be EXCLUDED (base==THEIRS would
  // make the merge "already up to date" and drop incoming edits) → expect H1.
  const has = { A: [], B: ['p1'], tip: ['p1', 'p2'], H1: ['p1', 'p2'], H2: [] };
  const git = (args) => {
    if (args[0] === 'rev-parse') {
      const ref = String(args[args.length - 1]).replace('^{commit}', '');
      if (ref === 'origin/main') return { ok: true, stdout: 'tip' }; // THEIRS tip resolves to 'tip'
      return { ok: has[ref] !== undefined, stdout: ref };
    }
    if (args[0] === 'cat-file') { const [commit, p] = String(args[2]).split(':'); return { ok: (has[commit] || []).includes(p) }; }
    if (args[0] === 'rev-list') return { ok: true, stdout: 'tip\nH1\nH2\n' };
    return { ok: false };
  };
  assert.strictEqual(pickBaseCommit({ candidates: ['A', 'B'], relPaths: ['p1', 'p2'], git, discoverRef: 'origin/main' }), 'H1');
});

test('A2 discoverBaseCommit: returns null (→ orphan add/add) rather than the tip when only the tip has the files', () => {
  const { discoverBaseCommit } = require('../lib/stage-git-merge');
  const has = { tip: ['p1'], older: [] };
  const git = (args) => {
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'tip' };
    if (args[0] === 'rev-list') return { ok: true, stdout: 'tip\nolder\n' };
    if (args[0] === 'cat-file') { const [commit, p] = String(args[2]).split(':'); return { ok: (has[commit] || []).includes(p) }; }
    return { ok: false };
  };
  // tip contains the file but is excluded; no ancestor has it → null (caller goes orphan)
  assert.strictEqual(discoverBaseCommit({ discoverRef: 'origin/main', relPaths: ['p1'], git }), null);
});

test('A2 pickBaseCommit: discovery returns null when no commit in history contains all files', () => {
  const has = { A: ['p1'], c1: ['p1'], c2: [] };
  const git = (args) => {
    if (args[0] === 'rev-parse') { const c = String(args[3]).replace('^{commit}', ''); return { ok: has[c] !== undefined, stdout: c }; }
    if (args[0] === 'cat-file') { const [commit, p] = String(args[2]).split(':'); return { ok: (has[commit] || []).includes(p) }; }
    if (args[0] === 'rev-list') return { ok: true, stdout: 'c1\nc2\n' };
    return { ok: false };
  };
  // no candidate or history commit has BOTH p1+p2 → best-covering candidate 'A' (p1)
  assert.strictEqual(pickBaseCommit({ candidates: ['A'], relPaths: ['p1', 'p2'], git, discoverRef: 'origin/main' }), 'A');
});

test('A2 detectAddAddPaths: flags conflicted paths with stages 2/3 but no stage 1', () => {
  const { detectAddAddPaths } = require('../lib/stage-git-merge');
  // foo.html has stages 1/2/3 (real 3-way, has base); bar.html has only 2/3 (add/add).
  const lsOut =
    '100644 aaa 1\tfoo.html\n100644 bbb 2\tfoo.html\n100644 ccc 3\tfoo.html\n' +
    '100644 ddd 2\tbar.html\n100644 eee 3\tbar.html\n';
  const git = (args) => (args[0] === 'ls-files' ? { ok: true, stdout: lsOut } : { ok: false });
  assert.deepStrictEqual(detectAddAddPaths(git), ['bar.html']);
});

test('A2 detectAddAddPaths: empty when every conflicted path has a base stage', () => {
  const { detectAddAddPaths } = require('../lib/stage-git-merge');
  const lsOut = '100644 aaa 1\tfoo.html\n100644 bbb 2\tfoo.html\n100644 ccc 3\tfoo.html\n';
  const git = (args) => (args[0] === 'ls-files' ? { ok: true, stdout: lsOut } : { ok: false });
  assert.deepStrictEqual(detectAddAddPaths(git), []);
});

test('A2 stageGitMerge: conflicted result reports addAddPaths + hasBaseStage', () => {
  const { gitImpl, fsImpl } = makeMocks({ mergeOk: false, theirs: 'a\r\nb\r\nc\r\n', porcelain: `UU ${REL}\n` });
  // make ls-files -u return a proper 3-stage entry (has base)
  const baseRunGit = gitImpl.runGit;
  gitImpl.runGit = ({ cwd, args }) => {
    if (args[0] === 'ls-files') return { ok: true, code: 0, stdout: `100644 a 1\t${REL}\n100644 b 2\t${REL}\n100644 c 3\t${REL}\n`, stderr: '' };
    return baseRunGit({ cwd, args });
  };
  const res = stageGitMerge({
    repoDir: '/clone/repo', baseCommit: 'basesha', theirsRef: 'origin/main',
    textUnits: [{ adoPath: '/' + REL, oursContent: 'a\nb-mine\nc\n', name: 'Search Results' }],
    gitImpl, fsImpl,
  });
  assert.strictEqual(res.merge.conflicted, true);
  assert.deepStrictEqual(res.merge.addAddPaths, []);
  assert.strictEqual(res.merge.hasBaseStage, true);
});

test('conflicted merge: writes EOL-matched OURS, reports unmerged paths, no commit', () => {
  const { gitImpl, fsImpl, calls, writes } = makeMocks({ mergeOk: false, theirs: 'a\r\nb-theirs\r\nc\r\n', porcelain: `UU ${REL}\n` });
  const res = stageGitMerge({
    repoDir: '/clone/repo', baseCommit: 'basesha', theirsRef: 'origin/main',
    textUnits: [{ adoPath: '/' + REL, oursContent: 'a\nb-mine\nc\n', name: 'Search Results' }],
    gitImpl, fsImpl,
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.baseUsed, 'commit');
  assert.strictEqual(res.merge.conflicted, true);
  assert.strictEqual(res.merge.clean, false);
  assert.deepStrictEqual(res.merge.conflictedPaths, [REL]);
  assert.deepStrictEqual(res.wrote, [REL]);
  assert.strictEqual(res.mergeCommit, null);
  // OURS written shaped to THEIRS (CRLF, no BOM).
  assert.strictEqual(writes.get('/clone/repo/' + REL), 'a\r\nb-mine\r\nc\r\n');
  // -B (force) used for the dataverse branch; azure-devops ref pointed at THEIRS; no unrelated-histories.
  assert.ok(calls.some((a) => a[0] === 'checkout' && a[1] === '-B' && a[2] === DATAVERSE_BRANCH && a[3] === 'basesha'));
  assert.ok(calls.some((a) => a[0] === 'branch' && a[1] === '-f' && a[2] === THEIRS_BRANCH && a[3] === 'origin/main'));
  const mergeCall = calls.find((a) => a[0] === 'merge');
  assert.ok(mergeCall.includes(THEIRS_BRANCH));
  assert.ok(!mergeCall.includes('--allow-unrelated-histories'));
});

test('clean (non-overlapping) merge auto-commits and returns mergeCommit', () => {
  const { gitImpl, fsImpl } = makeMocks({ mergeOk: true, headSha: 'cleanmerge1' });
  const res = stageGitMerge({
    repoDir: '/clone/repo', baseCommit: 'basesha', theirsRef: 'origin/main',
    textUnits: [{ adoPath: '/' + REL, oursContent: 'x\n' }], gitImpl, fsImpl,
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.merge.clean, true);
  assert.strictEqual(res.merge.conflicted, false);
  assert.strictEqual(res.mergeCommit, 'cleanmerge1');
});

test('empty BASE uses an orphan branch + --allow-unrelated-histories (add/add)', () => {
  const { gitImpl, fsImpl, calls } = makeMocks({ mergeOk: false, porcelain: `AA ${REL}\n` });
  const res = stageGitMerge({
    repoDir: '/clone/repo', baseCommit: null, theirsRef: 'origin/main',
    textUnits: [{ adoPath: '/' + REL, oursContent: 'a\n' }], gitImpl, fsImpl,
  });
  assert.strictEqual(res.baseUsed, 'empty');
  assert.strictEqual(res.merge.conflicted, true);
  assert.ok(calls.some((a) => a[0] === 'checkout' && a[1] === '--orphan'));
  assert.ok(calls.find((a) => a[0] === 'merge').includes('--allow-unrelated-histories'));
  const detachIndex = calls.findIndex((a) => a[0] === 'checkout' && a[1] === '--detach');
  const deleteIndex = calls.findIndex((a) => a[0] === 'branch' && a[1] === '-D' && a[2] === DATAVERSE_BRANCH);
  const orphanIndex = calls.findIndex((a) => a[0] === 'checkout' && a[1] === '--orphan' && a[2] === DATAVERSE_BRANCH);
  assert.ok(detachIndex >= 0, 'expected empty-BASE path to detach HEAD before deleting dataverse');
  assert.ok(deleteIndex > detachIndex, 'expected dataverse delete after detach');
  assert.ok(orphanIndex > deleteIndex, 'expected orphan checkout after dataverse delete');
});

test('merge failure with no unmerged paths is a real error, not a conflict', () => {
  const { gitImpl, fsImpl } = makeMocks({ mergeOk: false, porcelain: '' });
  const res = stageGitMerge({
    repoDir: '/clone/repo', baseCommit: 'basesha', theirsRef: 'origin/main',
    textUnits: [{ adoPath: '/' + REL, oursContent: 'a\n' }], gitImpl, fsImpl,
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /git merge failed/);
});

test('throws on missing required inputs', () => {
  assert.throws(() => stageGitMerge({ theirsRef: 'x', textUnits: [] }), /repoDir is required/);
  assert.throws(() => stageGitMerge({ repoDir: '/r', textUnits: [] }), /theirsRef is required/);
});

// ---- Task 1/3: extractMergeStages — stage→side mapping (Env left, ADO right) ----
test('Task 3 extractMergeStages: left=ENV(:2), right=ADO(:3), base=:1, result=worktree file', () => {
  const { extractMergeStages } = require('../lib/stage-git-merge');
  const writes = new Map();
  const shown = {};
  const gitImpl = {
    runGit({ cwd, args }) {
      // args = ['show', ':<stage>:<rel>']
      const m = String(args[1]).match(/^:([123]):(.+)$/);
      if (m) { shown[m[1]] = true; return { ok: true, stdout: `STAGE${m[1]}-content`, stderr: '' }; }
      return { ok: false };
    },
  };
  const fsImpl = { mkdirSync() {}, writeFileSync(p, c) { writes.set(String(p).replace(/\\/g, '/'), c); } };
  const r = extractMergeStages({ repoDir: 'C:/clone/repo', relPath: 'site/page.html', outDir: 'C:/clone/.pp-merge/stages', gitImpl, fsImpl });
  assert.equal(r.error, undefined);
  // result is the actual worktree file (resolved output written there)
  assert.equal(String(r.result).replace(/\\/g, '/'), 'C:/clone/repo/site/page.html');
  // LEFT carries the ENV (stage 2) content; RIGHT carries the ADO (stage 3) content
  assert.equal(writes.get(String(r.left).replace(/\\/g, '/')), 'STAGE2-content');
  assert.equal(writes.get(String(r.right).replace(/\\/g, '/')), 'STAGE3-content');
  assert.equal(writes.get(String(r.base).replace(/\\/g, '/')), 'STAGE1-content');
  // Friendly merge-editor panel titles: Dataverse / ADO / Base (real ext kept for highlighting)
  assert.match(String(r.left), /[\\/]Dataverse\.html$/);
  assert.match(String(r.right), /[\\/]ADO\.html$/);
  assert.match(String(r.base), /[\\/]Base\.html$/);
  assert.equal(r.hasBase, true);
});

test('Task 3 extractMergeStages: add/add (no stage 1) → empty base file, hasBase=false', () => {
  const { extractMergeStages } = require('../lib/stage-git-merge');
  const writes = new Map();
  const gitImpl = {
    runGit({ args }) {
      const m = String(args[1]).match(/^:([123]):/);
      if (m && m[1] === '1') return { ok: false }; // no base stage (add/add)
      if (m) return { ok: true, stdout: `s${m[1]}`, stderr: '' };
      return { ok: false };
    },
  };
  const fsImpl = { mkdirSync() {}, writeFileSync(p, c) { writes.set(String(p).replace(/\\/g, '/'), c); } };
  const r = extractMergeStages({ repoDir: 'C:/r', relPath: 'a/b.html', gitImpl, fsImpl });
  assert.equal(r.hasBase, false);
  assert.equal(writes.get(String(r.base).replace(/\\/g, '/')), ''); // empty base file
});

test('Task 3 invariance: stageGitMerge still stages Current=Dataverse(HEAD) — extract maps it to LEFT, no staging swap', () => {
  // Asserts the side-order is achieved purely by extract mapping, NOT by changing
  // which branch is HEAD. The merge construction is unchanged → pushed tree/base
  // correctness/reconcile contract are untouched.
  const { gitImpl, fsImpl, calls } = makeMocks({ mergeOk: false, theirs: 'a\r\nb\r\nc\r\n', porcelain: `UU ${REL}\n` });
  const res = stageGitMerge({
    repoDir: '/clone/repo', baseCommit: 'basesha', theirsRef: 'origin/main',
    textUnits: [{ adoPath: '/' + REL, oursContent: 'a\nb-mine\nc\n', name: 'Search Results' }],
    gitImpl, fsImpl,
  });
  assert.strictEqual(res.dataverseBranch, 'dataverse'); // HEAD branch unchanged
  assert.strictEqual(res.theirsBranch, 'azure-devops');
  // dataverse branch is still checked out at BASE (Current=Dataverse), then azure-devops merged in
  const checkout = calls.find((a) => a[0] === 'checkout' && a[1] === '-B' && a[2] === 'dataverse');
  assert.ok(checkout, 'dataverse still checked out as HEAD (no staging swap)');
});

test('flat-yml: stageGitMerge synthesizes OURS = yml skeleton with the env value substituted', () => {
  // The site setting's OURS isn't the raw scalar — it's the WHOLE .sitesetting.yml with
  // only the `value:` line set to the env value, so OURS/THEIRS differ on that line only.
  const theirsYml = 'name: HTTP/X-Frame-Options\nvalue: SAMEORIGIN\nwebsiteid: abc-123\n';
  const rel = 'solutions/RetailOS/powerpagesites/RetailOS/site-settings/HTTP-X-Frame-Options.sitesetting.yml';
  const { gitImpl, fsImpl, writes } = makeMocks({ mergeOk: false, theirs: theirsYml, porcelain: `UU ${rel}\n` });
  stageGitMerge({
    repoDir: '/clone/repo', baseCommit: 'basesha', theirsRef: 'origin/main',
    textUnits: [{ adoPath: '/' + rel, oursContent: 'DENY', flatYml: true, field: 'value', name: 'HTTP/X-Frame-Options' }],
    gitImpl, fsImpl,
  });
  const written = [...writes.values()].find((c) => /^value:/m.test(c));
  assert.ok(written, 'OURS file written');
  assert.match(written, /^value: DENY$/m);                 // env value substituted in
  assert.match(written, /name: HTTP\/X-Frame-Options/);    // metadata preserved
  assert.match(written, /websiteid: abc-123/);             // metadata preserved
  assert.equal((written.match(/^value:/gm) || []).length, 1);
});

test('containerized web file guard: a write target that is a DIRECTORY → clear error, not raw EISDIR', () => {
  // Simulates an unresolved container folder path slipping through to staging. The
  // write loop must surface a `containerized-webfile` reason instead of EISDIR.
  const rel = 'solutions/RetailOS/powerpagesites/RetailOS/web-files/theme.css';
  const fsImpl = {
    mkdirSync() {},
    writeFileSync() { const e = new Error('EISDIR: illegal operation on a directory'); e.code = 'EISDIR'; throw e; },
    statSync() { return { isDirectory: () => true, isFile: () => false }; }, // target is a folder
  };
  const gitImpl = {
    runGit({ args }) {
      const sub = args[0];
      if (sub === 'show') return { ok: true, code: 0, stdout: 'a\nb\n', stderr: '' };
      if (sub === 'cat-file') return { ok: true, code: 0, stdout: '', stderr: '' };
      if (sub === 'rev-parse') return { ok: true, code: 0, stdout: 'basesha\n', stderr: '' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
    addAll() { return { ok: true, code: 0, stdout: '', stderr: '' }; },
    status() { return { ok: true, code: 0, stdout: '', stderr: '' }; },
    revParse() { return { ok: true, code: 0, stdout: 'sha\n', stderr: '' }; },
  };
  const res = stageGitMerge({
    repoDir: '/clone/repo', baseCommit: 'basesha', theirsRef: 'origin/main',
    textUnits: [{ adoPath: '/' + rel, oursContent: 'x', webfile: true }],
    gitImpl, fsImpl,
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /containerized-webfile/);
  assert.match(res.error, /directory, not a file/);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeMergeWorkspace, readMergeCompletion, wipeMergeRun, mergeRunDir, URI_AUTHORITY } = require('../lib/merge-workspace');
const { CONFLICT_START, CONFLICT_MID, CONFLICT_END } = require('../lib/propose-merge');

// Isolate the secure artifact store for this test file: point its base at a
// throwaway dir so fixed runIds can't collide with a developer's real merges or
// across test runs. (Each test FILE runs in its own process under node:test.)
const STORE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-merge-store-'));
process.env.PP_MERGE_STORE_ROOT = STORE_BASE;
process.on('exit', () => { try { fs.rmSync(STORE_BASE, { recursive: true, force: true }); } catch { /* best-effort */ } });

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'merge-ws-')); }

function manifestWith(units, runId = 'run-1') {
  return {
    runId,
    binding: { organization: 'o', project: 'p', repository: 'r', branch: 'feature/dev-a' },
    components: [{
      conflictId: 'g1', componentId: 'c1', name: 'Search', type: 8, typeLabel: 'Web Template',
      mergeStrategy: 'text', routedTo: 'selective-merge', units,
    }],
  };
}

test('writeMergeWorkspace: materializes files + manifest + launch URI', () => {
  const root = tmpRoot();
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x/Search.webtemplate.source.html', status: 'mergeable',
    base: { present: true, content: 'A\nB\nC\n' },
    ours: { content: 'A2\nB\nC\n' },
    theirs: { present: true, content: 'A\nB\nC2\n' },
  }]);
  const r = writeMergeWorkspace({ projectRoot: root, manifest });
  assert.equal(r.units.length, 1);
  const u = r.units[0];
  assert.equal(u.hasConflicts, false); // non-overlapping → clean merge
  // files exist (proposed.txt removed 2026-06-19)
  for (const k of ['base', 'ours', 'theirs', 'result']) {
    assert.ok(fs.existsSync(path.join(r.runDir, u.files[k])), `${k} file exists`);
  }
  assert.equal(u.files.proposed, undefined, 'proposed file removed');
  // real extensions for syntax highlighting; Dataverse/ADO friendly names
  assert.match(u.files.ours, /dataverse\.html$/);
  assert.match(u.files.theirs, /ado\.html$/);
  assert.match(u.files.result, /merged\.html$/);
  // result is the deterministic git-style working file (clean merge here)
  assert.equal(fs.readFileSync(path.join(r.runDir, u.files.result), 'utf8'), 'A2\nB\nC2\n');
  // manifest written
  const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'));
  assert.equal(m.schemaVersion, 2);
  assert.equal(m.unitCount, 1);
  // labels relabeled to Dataverse / Azure DevOps
  assert.match(u.labels.ours, /Dataverse/);
  assert.match(u.labels.theirs, /Azure DevOps/);
  // launch URI
  assert.match(r.launchUri, new RegExp(`^vscode://${URI_AUTHORITY.replace('.', '\\.')}/open\\?runId=run-1`));
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeMergeWorkspace: conflicting unit pre-seeds result WITH markers', () => {
  const root = tmpRoot();
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base: { present: true, content: 'A\nB\nC\n' },
    ours: { content: 'A\nX\nC\n' },
    theirs: { present: true, content: 'A\nY\nC\n' },
  }]);
  const r = writeMergeWorkspace({ projectRoot: root, manifest });
  assert.equal(r.units[0].hasConflicts, true);
  assert.equal(r.units[0].conflictCount, 1);
  const result = fs.readFileSync(path.join(r.runDir, r.units[0].files.result), 'utf8');
  assert.match(result, new RegExp(CONFLICT_START));
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeMergeWorkspace: binary components are recorded separately, not as units', () => {
  const root = tmpRoot();
  const manifest = {
    runId: 'run-2',
    binding: {},
    components: [
      { componentId: 'w1', name: 'app.css', type: 3, typeLabel: 'Web File', routedTo: 'binary-keep-accept', units: [] },
    ],
  };
  const r = writeMergeWorkspace({ projectRoot: root, manifest });
  assert.equal(r.units.length, 0);
  assert.equal(r.binaryComponents.length, 1);
  assert.equal(r.binaryComponents[0].name, 'app.css');
  fs.rmSync(root, { recursive: true, force: true });
});

test('readMergeCompletion: clean result.txt → resolved with merged content', () => {
  const root = tmpRoot();
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base: { present: true, content: 'A\nB\nC\n' }, ours: { content: 'A2\nB\nC\n' }, theirs: { present: true, content: 'A\nB\nC2\n' },
  }], 'run-3');
  const w = writeMergeWorkspace({ projectRoot: root, manifest });
  // simulate the user editing/saving result.txt
  fs.writeFileSync(path.join(w.runDir, w.units[0].files.result), 'FINAL MERGED\n', 'utf8');
  fs.writeFileSync(path.join(w.runDir, 'completion.json'), JSON.stringify({ status: 'done' }), 'utf8');

  const r = readMergeCompletion({ projectRoot: root, runId: 'run-3' });
  assert.equal(r.complete, true);
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0].mergedContent, 'FINAL MERGED\n');
  assert.equal(r.resolved[0].adoPath, '/x.html');
  assert.equal(r.resolved[0].conflictId, 'g1');
  assert.equal(r.extensionReported, 'done');
  fs.rmSync(root, { recursive: true, force: true });
});

test('readMergeCompletion: leftover conflict markers → unresolved, NOT applied (D6)', () => {
  const root = tmpRoot();
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base: { present: true, content: 'A\nB\nC\n' }, ours: { content: 'A\nX\nC\n' }, theirs: { present: true, content: 'A\nY\nC\n' },
  }], 'run-4');
  const w = writeMergeWorkspace({ projectRoot: root, manifest });
  // user left the conflict markers in
  const stillConflicted = `${CONFLICT_START} ours\nX\n${CONFLICT_MID}\nY\n${CONFLICT_END} theirs\n`;
  fs.writeFileSync(path.join(w.runDir, w.units[0].files.result), stillConflicted, 'utf8');

  const r = readMergeCompletion({ projectRoot: root, runId: 'run-4' });
  assert.equal(r.complete, false);
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].reason, /conflict markers/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readMergeCompletion: missing result.txt → unresolved', () => {
  const root = tmpRoot();
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base: { present: true, content: 'A\n' }, ours: { content: 'B\n' }, theirs: { present: true, content: 'C\n' },
  }], 'run-5');
  const w = writeMergeWorkspace({ projectRoot: root, manifest });
  fs.rmSync(path.join(w.runDir, w.units[0].files.result), { force: true });
  const r = readMergeCompletion({ projectRoot: root, runId: 'run-5' });
  assert.equal(r.complete, false);
  assert.match(r.unresolved[0].reason, /missing/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readMergeCompletion: throws when manifest absent', () => {
  const root = tmpRoot();
  assert.throws(() => readMergeCompletion({ projectRoot: root, runId: 'nope' }), /No merge manifest/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mergeRunDir: secure default → OS-temp store (off project tree); legacy opt-in → docs/inner-loop/merge', () => {
  const sec = mergeRunDir('/proj', 'run-x').replace(/\\/g, '/');
  assert.match(sec, /\/pp-merge\/run-x$/);
  assert.ok(!sec.includes('/proj/'), 'secure store must not be under the project tree');
  const legacy = mergeRunDir('/proj', 'run-x', { secure: false }).replace(/\\/g, '/');
  assert.match(legacy, /\/proj\/docs\/inner-loop\/merge\/run-x$/);
});

test('writeMergeWorkspace: validation', () => {
  // secure-by-default: manifest is required; projectRoot is not (artifacts go to the store)
  assert.throws(() => writeMergeWorkspace({ manifest: {} }), /manifest.components/);
  assert.throws(() => writeMergeWorkspace({ projectRoot: '/x', manifest: {} }), /manifest.components/);
  // legacy in-tree mode (secure:false) requires projectRoot
  assert.throws(() => writeMergeWorkspace({ secure: false, manifest: manifestWith([]) }), /projectRoot/);
});

// ---- Wave 1 #1: secure ephemeral artifact store integration ----
test('secure default: artifacts land in the OS-temp store, off the project tree; cross-process read works', () => {
  const root = tmpRoot();
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base: { present: true, content: 'A\nB\nC\n' }, ours: { content: 'A2\nB\nC\n' }, theirs: { present: true, content: 'A\nB\nC2\n' },
  }], 'secure-run-1');
  const w = writeMergeWorkspace({ manifest }); // no projectRoot needed in secure mode
  try {
    assert.equal(w.secure, true);
    assert.ok(w.runDir.replace(/\\/g, '/').includes('/pp-merge/secure-run-1'), 'under the secure store');
    assert.ok(!w.runDir.includes(root), 'must not write under the project/session tree');
    assert.ok(fs.existsSync(path.join(w.runDir, w.units[0].files.result)));
    // simulate the extension/apply running in a SEPARATE process: only runId, no projectRoot
    const r = readMergeCompletion({ runId: 'secure-run-1' });
    assert.equal(r.runDir, w.runDir);
    assert.equal(r.resolved.length, 1);
    assert.equal(r.resolved[0].mergedContent, fs.readFileSync(path.join(w.runDir, w.units[0].files.result), 'utf8'));
  } finally { wipeMergeRun('secure-run-1'); fs.rmSync(root, { recursive: true, force: true }); }
});

test('secure store files are owner-only (0o600) on POSIX', { skip: process.platform === 'win32' }, () => {
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base: { present: true, content: 'A\n' }, ours: { content: 'B\n' }, theirs: { present: true, content: 'C\n' },
  }], 'secure-perm-1');
  const w = writeMergeWorkspace({ manifest });
  try {
    const mode = fs.statSync(path.join(w.runDir, w.units[0].files.result)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally { wipeMergeRun('secure-perm-1'); }
});

test('secret scan surfaces inline credentials as warnings (warn, not block)', () => {
  const secretLine = 'var k = "AKIAIOSFODNN7EXAMPLE";\n';
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base: { present: true, content: 'A\n' },
    ours: { content: 'A\n' + secretLine },     // OURS introduces a secret-like token
    theirs: { present: true, content: 'A\nB\n' },
  }], 'secure-secret-1');
  const w = writeMergeWorkspace({ manifest });
  try {
    assert.ok(Array.isArray(w.secretWarnings) && w.secretWarnings.length >= 1, 'a warning was raised');
    const hit = w.secretWarnings.find((s) => s.side === 'ours');
    assert.ok(hit && hit.patterns.includes('aws-access-key'), 'matched the AWS key pattern on OURS');
    // still materialized (warn-not-block) so the maker can resolve it
    assert.ok(fs.existsSync(path.join(w.runDir, w.units[0].files.ours)));
  } finally { wipeMergeRun('secure-secret-1'); }
});

test('wipeMergeRun removes all run artifacts', () => {
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base: { present: true, content: 'A\n' }, ours: { content: 'B\n' }, theirs: { present: true, content: 'C\n' },
  }], 'secure-wipe-1');
  const w = writeMergeWorkspace({ manifest });
  assert.ok(fs.existsSync(w.runDir));
  const res = wipeMergeRun('secure-wipe-1');
  assert.equal(res.wiped, true);
  assert.ok(!fs.existsSync(w.runDir));
});

// ---- fix #1: EOL/BOM skew must not force a whole-field conflict ----
test('EOL skew (CRLF theirs/base + LF ours), independent edits → clean auto-merge; output preserves CRLF', () => {
  const root = tmpRoot();
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base:   { present: true, content: 'A\r\nB\r\nC\r\n' },  // CRLF (ADO)
    ours:   { content: 'A2\nB\nC\n' },                       // LF (Dataverse), changed line 1
    theirs: { present: true, content: 'A\r\nB\r\nC2\r\n' },  // CRLF, changed line 3
  }]);
  const r = writeMergeWorkspace({ projectRoot: root, manifest });
  assert.equal(r.units[0].hasConflicts, false, 'independent edits must auto-merge despite EOL skew');
  assert.equal(r.units[0].eol, 'crlf');
  const result = fs.readFileSync(path.join(r.runDir, r.units[0].files.result), 'utf8');
  assert.equal(result, 'A2\r\nB\r\nC2\r\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('BOM on one side does not force a conflict', () => {
  const root = tmpRoot();
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base:   { present: true, content: '\uFEFFA\nB\nC\n' },
    ours:   { content: 'A2\nB\nC\n' },
    theirs: { present: true, content: 'A\nB\nC2\n' },
  }]);
  const r = writeMergeWorkspace({ projectRoot: root, manifest });
  assert.equal(r.units[0].hasConflicts, false);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- fix #2: non-mergeable units in a selective-merge component are not dropped ----
test('deferred units: a deleted-in-git field inside a selective-merge component is surfaced, not dropped', () => {
  const root = tmpRoot();
  const manifest = {
    runId: 'run-def', binding: {},
    components: [{
      conflictId: 'g', componentId: 'p1', name: 'Home', type: 2, typeLabel: 'Web Page',
      routedTo: 'selective-merge',
      units: [
        { field: 'copy', adoPath: '/c.html', status: 'mergeable', base: { present: true, content: 'A\nB\n' }, ours: { content: 'A2\nB\n' }, theirs: { present: true, content: 'A\nB2\n' } },
        { field: 'summary', adoPath: null, status: 'deleted-in-git', note: 'summary removed in Git', ours: { content: 'sum' } },
      ],
    }],
  };
  const r = writeMergeWorkspace({ projectRoot: root, manifest });
  assert.equal(r.units.length, 1, 'only the mergeable copy field materializes as a unit');
  const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'));
  assert.equal(m.deferredUnits.length, 1);
  assert.equal(m.deferredUnits[0].field, 'summary');
  assert.equal(m.deferredUnits[0].status, 'deleted-in-git');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- fix #4: oursContent carried for the apply snapshot ----
test('readMergeCompletion carries oursContent so the apply snapshot is not empty', () => {
  const root = tmpRoot();
  const manifest = manifestWith([{
    field: 'source', adoPath: '/x.html', status: 'mergeable',
    base: { present: true, content: 'A\nB\nC\n' }, ours: { content: 'OURS\nB\nC\n' }, theirs: { present: true, content: 'A\nB\nC2\n' },
  }], 'run-ours');
  const w = writeMergeWorkspace({ projectRoot: root, manifest });
  fs.writeFileSync(path.join(w.runDir, w.units[0].files.result), 'MERGED\n', 'utf8');
  const r = readMergeCompletion({ projectRoot: root, runId: 'run-ours' });
  assert.equal(r.resolved[0].mergedContent, 'MERGED\n');
  assert.ok(r.resolved[0].oursContent && r.resolved[0].oursContent.includes('OURS'), 'oursContent must be carried through');
  fs.rmSync(root, { recursive: true, force: true });
});

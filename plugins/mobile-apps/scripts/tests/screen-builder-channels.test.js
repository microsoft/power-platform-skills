'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  delimiters,
  parseReturnOnly,
  sealWorkOrder,
  validateDirectWrite,
  validateGeneratedScreenContent,
} = require('../lib/screen-builder-work-order');
const {
  canSkipValidation,
  captureDirectWriteSnapshot,
  createRunState,
  diffDirectWriteSnapshot,
  pendingScreens,
  recordChannelFailure,
  recordScreenSuccess,
  recordValidation,
  restoreOutOfScopeChanges,
  restoreSnapshotPaths,
  workspaceFingerprint,
} = require('../lib/screen-builder-runtime');

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-builder-channel-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  return root;
}

function workOrder(root, screenId = 'home') {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    screenId,
    route: `/${screenId}`,
    targetPath: path.join(root, 'app', `${screenId}.tsx`),
    pack: { screenId, purpose: `Implement ${screenId}` },
    routeContract: { route: `/${screenId}`, params: [] },
    typedSkeleton: `export default function ${screenId}() { return null; }`,
    serviceSignatures: ['RecordsService.getAll(options)'],
    tokenInterfaces: ['tokens.color.primary'],
    signatureComponentInterfaces: ['SignatureHero(props)'],
    states: { loading: 'skeleton', empty: 'empty', error: 'retry', populated: 'content' },
    testIds: [`screen-${screenId}`],
    accessibilityRequirements: ['Primary action has an accessible label'],
  };
}

test('direct-write and return-only channels consume the same sealed work order', (context) => {
  const root = project(context);
  const first = sealWorkOrder(workOrder(root), { projectRoot: root });
  const second = sealWorkOrder(workOrder(root), { projectRoot: root });
  assert.equal(first.sealed.inputFingerprint, second.sealed.inputFingerprint);
  assert.deepEqual(first.sealed, second.sealed);
});

test('return-only parser accepts one run-scoped TSX result', (context) => {
  const root = project(context);
  const { sealed } = sealWorkOrder(workOrder(root), { projectRoot: root });
  const marker = delimiters(sealed);
  const response = [
    marker.resultBegin,
    'STATUS: DONE',
    `TARGET: ${sealed.targetPath}`,
    'CONCERNS: []',
    marker.contentBegin,
    'export default function Home() { return <main data-testid="screen-home" />; }',
    marker.contentEnd,
    marker.resultEnd,
  ].join('\n');
  const result = parseReturnOnly(response, sealed, { projectRoot: root });
  assert.equal(result.status, 'DONE');
  assert.match(result.content, /function Home/);
  assert.equal(result.inputFingerprint, sealed.inputFingerprint);
});

test('return-only parser rejects mismatched delimiters and oversized output', (context) => {
  const root = project(context);
  const { sealed } = sealWorkOrder(workOrder(root), { projectRoot: root });
  assert.throws(
    () => parseReturnOnly('DONE', sealed, { projectRoot: root }),
    /missing or mismatched run-scoped delimiters/,
  );
  assert.throws(
    () => parseReturnOnly('x'.repeat(100), sealed, { projectRoot: root, maxOutputBytes: 50 }),
    /maximum is 50/,
  );
});

test('direct-write validation permits exactly the assigned screen', (context) => {
  const root = project(context);
  const { sealed } = sealWorkOrder(workOrder(root), { projectRoot: root });
  fs.writeFileSync(sealed.targetPath, 'export default function Home() { return "screen-home"; }\n');
  const valid = {
    status: 'DONE',
    targetPath: sealed.targetPath,
    inputFingerprint: sealed.inputFingerprint,
    changedFiles: [sealed.targetPath],
    concerns: [],
  };
  assert.equal(validateDirectWrite(sealed, valid, { projectRoot: root }).status, 'DONE');
  assert.throws(() => validateDirectWrite(sealed, {
    ...valid,
    changedFiles: [sealed.targetPath, path.join(root, 'app', '_layout.tsx')],
  }, { projectRoot: root }), /may change only/);
  assert.equal(validateDirectWrite(sealed, {
    ...valid,
    status: 'NEEDS_CONTEXT',
    changedFiles: [],
  }, { projectRoot: root }).status, 'NEEDS_CONTEXT');
  assert.throws(() => validateDirectWrite(sealed, {
    ...valid,
    status: 'BLOCKED',
  }, { projectRoot: root }), /must not report partial direct-write changes/);
  assert.throws(() => validateDirectWrite(sealed, {
    ...valid,
    status: 'DONE_WITH_CONCERNS',
  }, { projectRoot: root }), /requires at least one concern/);
});

test('both channels enforce sealed test IDs, named tokens, and offline state', (context) => {
  const root = project(context);
  const order = workOrder(root);
  order.tokenInterfaces = ['$surface0', '$text0', '$accentBase'];
  const { sealed } = sealWorkOrder(order, { projectRoot: root });
  assert.doesNotThrow(() => validateGeneratedScreenContent(
    'const screen = <View testID="screen-home" bg="$surface0" color="$text0" />;',
    sealed,
  ));
  assert.throws(
    () => validateGeneratedScreenContent(
      'const screen = <View testID="screen-home" bg="$blue3" />;',
      sealed,
    ),
    /tokens outside the sealed interface: \$blue3/,
  );
  assert.throws(
    () => validateGeneratedScreenContent('const screen = <View bg="$surface0" />;', sealed),
    /missing required test IDs: screen-home/,
  );
  assert.throws(
    () => validateGeneratedScreenContent(
      'const screen = <Text testID="screen-home">Offline snapshot</Text>;',
      sealed,
    ),
    /no offline state/,
  );
  assert.throws(
    () => validateGeneratedScreenContent(
      'const RecordsService = {}; function SignatureHero() {} const screen = "screen-home";',
      sealed,
    ),
    /locally reimplements supplied interfaces: RecordsService, SignatureHero/,
  );
});

test('direct-write audit preserves the assigned screen and restores actual out-of-scope writes', (context) => {
  const root = project(context);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default function Home() { return null; }\n');
  fs.writeFileSync(path.join(root, 'app', '_layout.tsx'), 'export const protectedLayout = true;\n');
  const snapshot = captureDirectWriteSnapshot(root, ['app', 'src'], '.tmp/backups/wave-0');

  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default function Home() { return <main />; }\n');
  fs.writeFileSync(path.join(root, 'app', '_layout.tsx'), 'export const protectedLayout = false;\n');
  fs.writeFileSync(path.join(root, 'src', 'unapproved.ts'), 'export const leaked = true;\n');
  fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'src', 'broken-link'));

  const audit = restoreOutOfScopeChanges(root, snapshot, ['app/home.tsx']);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.allowedChangedFiles, ['app/home.tsx']);
  assert.deepEqual(audit.outOfScopeFiles, ['app/_layout.tsx', 'src/broken-link', 'src/unapproved.ts']);
  assert.match(fs.readFileSync(path.join(root, 'app', 'home.tsx'), 'utf8'), /<main \/>/);
  assert.equal(fs.readFileSync(path.join(root, 'app', '_layout.tsx'), 'utf8'), 'export const protectedLayout = true;\n');
  assert.equal(fs.existsSync(path.join(root, 'src', 'unapproved.ts')), false);
  assert.equal(fs.lstatSync(path.join(root, 'src')).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(root, 'src', 'broken-link')), false);
  assert.deepEqual(diffDirectWriteSnapshot(root, snapshot).map((change) => change.path), ['app/home.tsx']);
  assert.deepEqual(restoreSnapshotPaths(root, snapshot, ['app/home.tsx']), {
    restoredFiles: ['app/home.tsx'],
  });
  assert.equal(
    fs.readFileSync(path.join(root, 'app', 'home.tsx'), 'utf8'),
    'export default function Home() { return null; }\n',
  );
  assert.deepEqual(diffDirectWriteSnapshot(root, snapshot), []);
});

test('direct-write audit rejects a no-op target and tampered backup metadata', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default function Home() { return null; }\n');
  const snapshot = captureDirectWriteSnapshot(root, ['app'], '.tmp/backups/no-op');
  const noOp = restoreOutOfScopeChanges(root, snapshot, ['app/home.tsx']);
  assert.equal(noOp.ok, false);
  assert.deepEqual(noOp.changedFiles, []);

  const tampered = structuredClone(snapshot);
  tampered.entries[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => restoreOutOfScopeChanges(root, tampered, ['app/home.tsx']),
    /snapshot revision does not match/,
  );
  assert.throws(
    () => restoreSnapshotPaths(root, snapshot, ['outside.tsx']),
    /was not protected by the snapshot/,
  );
});

test('screen-builder contract CLI audits actual direct-write paths', (context) => {
  const root = project(context);
  const cli = path.resolve(__dirname, '..', 'screen-builder-contract.js');
  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default null;\n');
  fs.writeFileSync(path.join(root, 'app', '_layout.tsx'), 'export const shell = true;\n');
  const snapshotPath = '.tmp/snapshots/wave.json';
  const captured = spawnSync(process.execPath, [
    cli,
    '--project-root', root,
    '--capture-direct-snapshot',
    '--snapshot', snapshotPath,
    '--backup-dir', '.tmp/backups/wave',
    '--path', 'app',
  ], { encoding: 'utf8' });
  assert.equal(captured.status, 0, captured.stderr);

  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default function Home() { return null; }\n');
  fs.writeFileSync(path.join(root, 'app', '_layout.tsx'), 'export const shell = false;\n');
  const audited = spawnSync(process.execPath, [
    cli,
    '--project-root', root,
    '--audit-direct-writes',
    '--snapshot', snapshotPath,
    '--allowed-path', 'app/home.tsx',
  ], { encoding: 'utf8' });
  assert.equal(audited.status, 1, audited.stderr);
  const result = JSON.parse(audited.stdout);
  assert.deepEqual(result.allowedChangedFiles, ['app/home.tsx']);
  assert.deepEqual(result.outOfScopeFiles, ['app/_layout.tsx']);
  assert.equal(fs.readFileSync(path.join(root, 'app', '_layout.tsx'), 'utf8'), 'export const shell = true;\n');

  const restored = spawnSync(process.execPath, [
    cli,
    '--project-root', root,
    '--restore-direct-paths',
    '--snapshot', snapshotPath,
    '--restore-path', 'app/home.tsx',
  ], { encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(JSON.parse(restored.stdout).restoredFiles, ['app/home.tsx']);
  assert.equal(fs.readFileSync(path.join(root, 'app', 'home.tsx'), 'utf8'), 'export default null;\n');
});

test('channel failure falls back per screen and preserves successful siblings', (context) => {
  const root = project(context);
  const home = sealWorkOrder(workOrder(root, 'home'), { projectRoot: root }).sealed;
  const history = sealWorkOrder(workOrder(root, 'history'), { projectRoot: root }).sealed;
  const state = createRunState('run-1', [home, history]);
  recordScreenSuccess(state, 'home', 'direct-write', 'home-hash');
  assert.equal(recordChannelFailure(state, 'history', 'direct-write', 'tool mapping'), 'return-only');
  assert.equal(state.screens.home.status, 'complete');
  assert.deepEqual(pendingScreens(state).map((item) => item.screenId), ['history']);
  assert.equal(recordChannelFailure(state, 'history', 'return-only', 'malformed output'), 'foreground');
  assert.equal(state.screens.home.outputHash, 'home-hash');
});

test('unchanged final validation skips only an identical successful fingerprint', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default null;\n');
  const fingerprint = workspaceFingerprint(root, ['app']);
  const validators = ['tsc', 'routes', 'screen-quality'];
  const state = recordValidation(fingerprint, validators);
  assert.equal(canSkipValidation(state, fingerprint, validators), true);
  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default function Home() { return null; }\n');
  const changed = workspaceFingerprint(root, ['app']);
  assert.equal(canSkipValidation(state, changed, validators), false);
  assert.equal(canSkipValidation(state, fingerprint, [...validators, 'contrast']), false);
});
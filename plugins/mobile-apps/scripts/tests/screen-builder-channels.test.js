'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const { readDesignTokenContract } = require('../lib/design-token-contract');
const { canonicalJson, sha256Hex } = require('../lib/product-experience-contracts');
const { buildSharedDesignInputs } = require('../lib/shared-design-inputs');
const { projectScreenFacts } = require('../validate-fixture-scenarios');

const {
  delimiters,
  parseReturnOnly,
  sealWorkOrder,
  validateDirectWrite,
  workOrderFingerprint,
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
const { bundleFor } = require('./helpers/product-experience-scenarios');

const EXPERIENCE_DIRECTIVE = {
  tone: 'quiet',
  expressiveness: 'restrained',
  density: 'dense',
  tempo: 'steady',
  emphasis: 'status-signals',
  mediaNecessity: 'none',
  riskLevel: 'low',
  regionOrder: ['context', 'focal-content', 'primary-action'],
  accessibilityPriorities: ['high-contrast'],
  forbiddenDefaults: ['Generic dashboard'],
};
const COMPILED_REVISION = 'b'.repeat(64);
const NAVIGATION = {
  manifestRevision: 'c'.repeat(64),
  pattern: 'stack-only',
  visibleTabs: [],
  durableDestinations: [{
    destinationId: 'home',
    label: 'Home',
    rootScreenId: 'home',
    targetPath: '/home',
  }],
  returnHomeMechanism: 'Back returns to Home',
};
const TOKENS_SOURCE = `export const tokens = {
  color: {
    bg: '#f7f7f7', surface: '#ffffff', primary: '#123456', accent: '#abcdef',
    text: '#111111', textMuted: '#666666', border: '#dddddd',
    statusSuccess: '#187a50', statusWarning: '#9a650d', statusDanger: '#b4232f',
    statusInfo: '#176b87',
  },
  typography: {
    heading: { family: 'Test Sans', size: 22, weight: 700, lineHeight: 1.2, tracking: 0 },
  },
  space: {}, size: {}, radius: {},
} as const;
export type BrandTokens = typeof tokens;
`;
const SIGNATURE_COMPONENTS_SOURCE = 'export interface SignatureHeroProps { state: "ready" | "busy"; }\n';

function sharedDesignInputs(experienceDirective = EXPERIENCE_DIRECTIVE, tokensPath = null) {
  const tokenContract = tokensPath
    ? readDesignTokenContract(tokensPath)
    : {
      ok: true,
      revision: sha256Hex(TOKENS_SOURCE),
      colors: {
        bg: '#f7f7f7', surface: '#ffffff', primary: '#123456', accent: '#abcdef',
        text: '#111111', textMuted: '#666666', border: '#dddddd',
        statusSuccess: '#187a50', statusWarning: '#9a650d', statusDanger: '#b4232f',
        statusInfo: '#176b87',
      },
      typography: { family: 'Test Sans', size: 22, weight: 700, lineHeight: 1.2, tracking: 0 },
    };
  return buildSharedDesignInputs({
    experienceDirective,
    navigation: NAVIGATION,
    tokenContract,
    signatureComponentsSource: SIGNATURE_COMPONENTS_SOURCE,
  });
}

function canonicalPackEntry(screenId) {
  return {
    screenId,
    route: `/${screenId}`,
    implementationContract: { routeParams: [] },
    pack: { screenId, purpose: `Implement ${screenId}` },
  };
}

function compiledPack(
  experienceDirective = EXPERIENCE_DIRECTIVE,
  screenIds = ['home', 'history'],
) {
  return {
    contractType: 'compiled-screen-build-pack',
    compiledRevision: COMPILED_REVISION,
    experienceDirective,
    screens: screenIds.map(canonicalPackEntry),
  };
}

function scenarioContract(screenIds = ['home', 'history'], screenPackRevision = COMPILED_REVISION) {
  const scenario = {
    schemaVersion: 1,
    contractType: 'scenario-facts',
    screenPackRevision,
    records: [],
    relationships: [],
    scenarios: [],
    mediaAssets: [],
    screenBindings: screenIds.map((screenId) => ({
      screenId,
      scenarioId: `${screenId}-scenario`,
      recordIds: [],
      mediaAssetKeys: [],
      preview: { headline: `${screenId} fixture` },
    })),
    invariants: [],
  };
  scenario.scenarioRevision = sha256Hex(canonicalJson(scenario));
  return scenario;
}

function contractOptions(
  root,
  experienceDirective = EXPERIENCE_DIRECTIVE,
  screenIds = ['home', 'history'],
) {
  return {
    projectRoot: root,
    compiledScreenBuildPack: compiledPack(experienceDirective, screenIds),
    compiledScenarioFacts: scenarioContract(screenIds),
    sharedDesignInputs: sharedDesignInputs(experienceDirective),
  };
}

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-builder-channel-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), TOKENS_SOURCE);
  fs.writeFileSync(
    path.join(root, 'brand', 'signature-components.ts'),
    SIGNATURE_COMPONENTS_SOURCE,
  );
  fs.writeFileSync(
    path.join(root, '.tmp', 'compiled-screen-build-pack.json'),
    `${JSON.stringify(compiledPack(), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, '.tmp', 'scenario-facts.json'),
    `${JSON.stringify(scenarioContract(), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, '.tmp', 'navigation-manifest.json'),
    `${JSON.stringify(NAVIGATION, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, '.tmp', 'product-experience-final-preview-contract.json'),
    `${JSON.stringify({
      sharedDesignInputs: sharedDesignInputs(
        EXPERIENCE_DIRECTIVE,
        path.join(root, 'brand', 'tokens.ts'),
      ),
    }, null, 2)}\n`,
  );
  return root;
}

function workOrder(root, screenId = 'home') {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    screenId,
    route: `/${screenId}`,
    targetPath: path.join(root, 'app', `${screenId}.tsx`),
    compiledRevision: COMPILED_REVISION,
    experienceDirective: EXPERIENCE_DIRECTIVE,
    sharedDesignInputs: sharedDesignInputs(),
    pack: canonicalPackEntry(screenId),
    scenarioFacts: projectScreenFacts(scenarioContract(), screenId),
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
  const first = sealWorkOrder(workOrder(root), contractOptions(root));
  const second = sealWorkOrder(workOrder(root), contractOptions(root));
  assert.equal(first.sealed.inputFingerprint, second.sealed.inputFingerprint);
  assert.deepEqual(first.sealed, second.sealed);
});

test('Product Experience directive reaches the sealed return-only builder input unchanged', (context) => {
  const root = project(context);
  const bundle = bundleFor('commerce');
  const result = compileScreenBuildPack(bundle.buildPack, bundle);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const compiled = result.compiled;
  const screen = compiled.screens[0];
  const scenario = scenarioContract([screen.screenId], compiled.compiledRevision);
  const order = {
    ...workOrder(root, screen.screenId),
    route: screen.route,
    targetPath: path.join(root, 'app', `${screen.screenId}.tsx`),
    compiledRevision: compiled.compiledRevision,
    experienceDirective: compiled.experienceDirective,
    pack: screen,
    scenarioFacts: projectScreenFacts(scenario, screen.screenId),
    states: screen.pack.states,
    testIds: Object.values(screen.implementationContract.testIds),
  };
  const options = {
    projectRoot: root,
    compiledScreenBuildPack: compiled,
    compiledScenarioFacts: scenario,
    sharedDesignInputs: sharedDesignInputs(compiled.experienceDirective),
  };
  order.sharedDesignInputs = options.sharedDesignInputs;
  const { sealed } = sealWorkOrder(order, options);

  assert.deepEqual(sealed.experienceDirective, compiled.experienceDirective);
  assert.deepEqual(sealed.sharedDesignInputs, options.sharedDesignInputs);
  assert.deepEqual(Object.keys(sealed.experienceDirective).sort(), [
    'accessibilityPriorities',
    'density',
    'emphasis',
    'expressiveness',
    'forbiddenDefaults',
    'mediaNecessity',
    'regionOrder',
    'riskLevel',
    'tempo',
    'tone',
  ]);
  const changed = structuredClone(sealed);
  delete changed.inputFingerprint;
  changed.experienceDirective.tone = 'changed-after-compilation';
  assert.notEqual(workOrderFingerprint(changed), sealed.inputFingerprint);
  assert.throws(
    () => sealWorkOrder(changed, options),
    /experienceDirective does not match the current compiled screen build pack/,
  );
  assert.throws(
    () => sealWorkOrder({ ...order, compiledRevision: 'c'.repeat(64) }, options),
    /compiledRevision does not match the current compiled screen build pack/,
  );
  assert.throws(
    () => sealWorkOrder({
      ...order,
      pack: { ...order.pack, title: 'Tampered title' },
    }, options),
    /pack must be the assigned screen build-pack entry/,
  );
  assert.throws(
    () => sealWorkOrder({
      ...order,
      route: '/stale-route',
    }, options),
    /route does not match the assigned screen build-pack entry/,
  );
  assert.throws(
    () => sealWorkOrder({
      ...order,
      routeContract: { route: '/stale-route', params: ['unexpected'] },
    }, options),
    /routeContract does not match the assigned screen build-pack entry/,
  );
  assert.throws(
    () => sealWorkOrder({
      ...order,
      scenarioFacts: { ...order.scenarioFacts, headline: 'Stale fixture' },
    }, options),
    /scenarioFacts must be the assigned canonical screen projection/,
  );
  const changedDesign = structuredClone(order);
  changedDesign.sharedDesignInputs.tokens.colors.primary = '#654321';
  assert.throws(
    () => sealWorkOrder(changedDesign, options),
    /sharedDesignInputs must match the validated final preview contract/,
  );
});

test('return-only parser accepts one run-scoped TSX result', (context) => {
  const root = project(context);
  const { sealed } = sealWorkOrder(workOrder(root), contractOptions(root));
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
  const result = parseReturnOnly(response, sealed, contractOptions(root));
  assert.equal(result.status, 'DONE');
  assert.match(result.content, /function Home/);
  assert.equal(result.inputFingerprint, sealed.inputFingerprint);
});

test('return-only parser rejects mismatched delimiters and oversized output', (context) => {
  const root = project(context);
  const { sealed } = sealWorkOrder(workOrder(root), contractOptions(root));
  assert.throws(
    () => parseReturnOnly('DONE', sealed, contractOptions(root)),
    /missing or mismatched run-scoped delimiters/,
  );
  assert.throws(
    () => parseReturnOnly('x'.repeat(100), sealed, {
      ...contractOptions(root),
      maxOutputBytes: 50,
    }),
    /maximum is 50/,
  );
});

test('direct-write validation permits exactly the assigned screen', (context) => {
  const root = project(context);
  const { sealed } = sealWorkOrder(workOrder(root), contractOptions(root));
  fs.writeFileSync(sealed.targetPath, 'export default function Home() { return "screen-home"; }\n');
  const valid = {
    status: 'DONE',
    targetPath: sealed.targetPath,
    inputFingerprint: sealed.inputFingerprint,
    changedFiles: [sealed.targetPath],
    concerns: [],
  };
  assert.equal(validateDirectWrite(sealed, valid, contractOptions(root)).status, 'DONE');
  assert.throws(() => validateDirectWrite(sealed, {
    ...valid,
    changedFiles: [sealed.targetPath, path.join(root, 'app', '_layout.tsx')],
  }, contractOptions(root)), /may change only/);
  assert.equal(validateDirectWrite(sealed, {
    ...valid,
    status: 'NEEDS_CONTEXT',
    changedFiles: [],
  }, contractOptions(root)).status, 'NEEDS_CONTEXT');
  assert.throws(() => validateDirectWrite(sealed, {
    ...valid,
    status: 'BLOCKED',
  }, contractOptions(root)), /must not report partial direct-write changes/);
  assert.throws(() => validateDirectWrite(sealed, {
    ...valid,
    status: 'DONE_WITH_CONCERNS',
  }, contractOptions(root)), /requires at least one concern/);
});

test('channels do not replace TypeScript and quality gates with regex TSX inspection', (context) => {
  const root = project(context);
  const order = workOrder(root);
  order.tokenInterfaces = ['$surface0', '$text0', '$accentBase'];
  const { sealed } = sealWorkOrder(order, contractOptions(root));
  const marker = delimiters(sealed);
  const content = 'export default function Home() { return <View bg="$blue3">Offline snapshot</View>; }';
  const response = [
    marker.resultBegin,
    'STATUS: DONE',
    `TARGET: ${sealed.targetPath}`,
    'CONCERNS: []',
    marker.contentBegin,
    content,
    marker.contentEnd,
    marker.resultEnd,
  ].join('\n');
  const result = parseReturnOnly(response, sealed, contractOptions(root));
  assert.equal(result.content, content);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
});

test('generated screen channels reject test fixture imports', (context) => {
  const root = project(context);
  const { sealed } = sealWorkOrder(workOrder(root), contractOptions(root));
  const marker = delimiters(sealed);
  const response = [
    marker.resultBegin,
    'STATUS: DONE',
    `TARGET: ${sealed.targetPath}`,
    'CONCERNS: []',
    marker.contentBegin,
    "import { flightPreview } from '../scripts/tests/fixtures/final-preview-model-outputs';",
    'export default function Home() { return null; }',
    marker.contentEnd,
    marker.resultEnd,
  ].join('\n');
  assert.throws(
    () => parseReturnOnly(response, sealed, contractOptions(root)),
    /imports prohibited test, snapshot, or benchmark code/,
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

test('whole-project direct-write audit catches omitted root and offline files', (context) => {
  const root = project(context);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default null;\n');
  fs.writeFileSync(path.join(root, 'offline-profile.json'), '{"profile":"before"}\n');
  const snapshot = captureDirectWriteSnapshot(
    root,
    ['.'],
    '.tmp/screen-builder-backups/wave',
    ['.tmp/screen-builder-snapshots/wave.json'],
  );

  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default function Home() {}\n');
  fs.writeFileSync(path.join(root, 'offline-profile.json'), '{"profile":"after"}\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'unexpected\n');
  const audit = restoreOutOfScopeChanges(root, snapshot, ['app/home.tsx']);

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.outOfScopeFiles, ['README.md', 'offline-profile.json']);
  assert.equal(fs.existsSync(path.join(root, 'README.md')), false);
  assert.equal(
    fs.readFileSync(path.join(root, 'offline-profile.json'), 'utf8'),
    '{"profile":"before"}\n',
  );
});

test('snapshot and Build Plan paths reject symlinked parent directories', (context) => {
  const root = project(context);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-builder-outside-'));
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.join(root, '.tmp'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(root, '.tmp'), 'dir');

  assert.throws(
    () => captureDirectWriteSnapshot(root, ['app'], '.tmp/backups/wave'),
    /traverses a symbolic link/,
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

test('screen-builder seal CLI binds current compiled and preview design inputs', (context) => {
  const root = project(context);
  const cli = path.resolve(__dirname, '..', 'screen-builder-contract.js');
  const input = path.join(root, '.tmp', 'home.unsealed.json');
  const output = path.join(root, '.tmp', 'home.json');
  fs.writeFileSync(input, `${JSON.stringify(workOrder(root), null, 2)}\n`);

  const sealedResult = spawnSync(process.execPath, [
    cli,
    '--project-root', root,
    '--seal',
    '--input', '.tmp/home.unsealed.json',
    '--output', '.tmp/home.json',
  ], { encoding: 'utf8' });
  assert.equal(sealedResult.status, 0, sealedResult.stderr);
  const sealed = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(sealed.experienceDirective, EXPERIENCE_DIRECTIVE);
  assert.deepEqual(sealed.sharedDesignInputs, sharedDesignInputs());
  assert.equal(sealed.compiledRevision, COMPILED_REVISION);

  const drifted = workOrder(root);
  drifted.experienceDirective = { ...drifted.experienceDirective, tone: 'warm' };
  fs.writeFileSync(input, `${JSON.stringify(drifted, null, 2)}\n`);
  const rejected = spawnSync(process.execPath, [
    cli,
    '--project-root', root,
    '--seal',
    '--input', '.tmp/home.unsealed.json',
    '--output', '.tmp/home.json',
  ], { encoding: 'utf8' });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /experienceDirective does not match/);

  const sidecarPath = path.join(
    root,
    '.tmp',
    'product-experience-final-preview-contract.json',
  );
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  sidecar.sharedDesignInputs.tokens.colors.primary = '#654321';
  const revisionContent = structuredClone(sidecar.sharedDesignInputs);
  delete revisionContent.designInputRevision;
  sidecar.sharedDesignInputs.designInputRevision = sha256Hex(canonicalJson(revisionContent));
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  const tamperedOrder = workOrder(root);
  tamperedOrder.sharedDesignInputs = sidecar.sharedDesignInputs;
  fs.writeFileSync(input, `${JSON.stringify(tamperedOrder, null, 2)}\n`);
  const tampered = spawnSync(process.execPath, [
    cli,
    '--project-root', root,
    '--seal',
    '--input', '.tmp/home.unsealed.json',
    '--output', '.tmp/home.json',
  ], { encoding: 'utf8' });
  assert.equal(tampered.status, 2);
  assert.match(
    tampered.stderr,
    /final preview shared design inputs do not match current design artifacts/,
  );
});

test('channel failure falls back per screen and preserves successful siblings', (context) => {
  const root = project(context);
  const home = sealWorkOrder(workOrder(root, 'home'), contractOptions(root)).sealed;
  const history = sealWorkOrder(workOrder(root, 'history'), contractOptions(root)).sealed;
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
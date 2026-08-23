'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const scripts = path.join(pluginRoot, 'scripts');

function write(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function run(scriptName, args, options = {}) {
  return spawnSync(process.execPath, [path.join(scripts, scriptName), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optimized-mobile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const templateRoot = path.join(pluginRoot, 'template');
  fs.cpSync(templateRoot, root, {
    recursive: true,
    filter: (sourcePath) => {
      const relative = path.relative(templateRoot, sourcePath);
      return !relative.startsWith(`node_modules${path.sep}`)
        && !relative.startsWith(`.expo${path.sep}`)
        && !relative.startsWith(`dist${path.sep}`);
    },
  });
  fs.mkdirSync(path.join(root, 'node_modules', 'expo'), { recursive: true });
  return root;
}

function prepare(root) {
  return run('prepare-mobile-template.js', [
    '--project-root', root,
    '--display-name', 'Equipment Care',
    '--slug', 'equipment-care',
    '--mode', 'prototype',
  ]);
}

function addScreenContract(root) {
  const plan = '# Equipment Care\n\n## Screens\n\nApproved structured contract.\n';
  write(root, 'native-app-plan.md', plan);
  const { createHash } = require('node:crypto');
  const planHash = createHash('sha256').update(plan).digest('hex');
  write(root, 'src/generated/services/EquipmentService.ts', `
export const EquipmentService = {
  async getAll() { return []; },
  async get(id) { return { id }; },
};
`);
  write(root, 'src/generated/services/IssueService.ts', `
export const IssueService = {
  async create(input) { return input; },
};
`);
  write(root, '.tmp/screen-contract.json', {
    schemaVersion: 1,
    approvedPlanSha256: planHash,
    navigation: {
      pattern: 'tabs',
      roots: ['home', 'equipment', 'report-issue'],
      hidden: [],
    },
    screens: [
      {
        id: 'home',
        name: 'Overview',
        title: 'Overview',
        icon: 'home-outline',
        route: '/(app)/home',
        file: 'app/(app)/home.tsx',
        source: 'replace',
        presentation: 'tab-root',
        archetype: 'dashboard',
        services: ['EquipmentService'],
        nativeCapabilities: [],
        scaffold: {
          componentName: 'HomeScreen',
          imports: ["import { EquipmentService } from '@/generated/services/EquipmentService';"],
          statements: ['void EquipmentService;'],
        },
      },
      {
        id: 'equipment',
        name: 'Equipment',
        route: '/(app)/equipment',
        file: 'app/(app)/equipment/index.tsx',
        source: 'new',
        presentation: 'tab-root',
        archetype: 'list',
        services: ['EquipmentService'],
        nativeCapabilities: [],
        scaffold: {
          componentName: 'EquipmentScreen',
          imports: ["import { EquipmentService } from '@/generated/services/EquipmentService';"],
          statements: ['void EquipmentService;'],
        },
      },
      {
        id: 'report-issue',
        name: 'Report issue',
        route: '/(app)/issues/new',
        file: 'app/(app)/issues/new.tsx',
        source: 'new',
        presentation: 'modal',
        archetype: 'form',
        services: ['IssueService'],
        nativeCapabilities: [],
        scaffold: {
          componentName: 'ReportIssueScreen',
          imports: ["import { IssueService } from '@/generated/services/IssueService';"],
          statements: ['void IssueService;'],
        },
      },
    ],
  });
  write(root, 'brand/design-decision.json', {
    schemaVersion: 1,
    finalSelection: { direction: 'polished-inspection' },
    userConfirmation: { status: 'confirmed' },
  });
}

test('template preparation is deterministic and emits a stable receipt', (t) => {
  const root = project(t);
  const first = prepare(root);
  assert.equal(first.status, 0, first.stderr);
  const firstReceipt = readJson(root, '.tmp/template-prep-receipt.json');
  assert.equal(firstReceipt.mode, 'prototype');
  assert.equal(firstReceipt.slug, 'equipment-care');
  assert.match(firstReceipt.totalChecksum, /^[a-f0-9]{64}$/);
  assert.equal(readJson(root, 'package.json').name, 'equipment-care');
  assert.equal(readJson(root, 'tsconfig.json').compilerOptions.paths['@/components'][0], 'src/components');
  assert.match(fs.readFileSync(path.join(root, 'app/(app)/_layout.tsx'), 'utf8'), /MOBILE NAVIGATION START/);

  const second = prepare(root);
  assert.equal(second.status, 0, second.stderr);
  const secondReceipt = readJson(root, '.tmp/template-prep-receipt.json');
  assert.equal(secondReceipt.totalChecksum, firstReceipt.totalChecksum);

  write(root, 'src/generated/services/RealService.ts', 'export const RealService = {};\n');
  const unsafeRerun = prepare(root);
  assert.equal(unsafeRerun.status, 1);
  assert.match(unsafeRerun.stderr, /fresh-create only/);
  assert.equal(fs.existsSync(path.join(root, 'src/generated/services/RealService.ts')), true);
});

test('screen artifacts, builder packets, and balanced waves are hash-bound', (t) => {
  const root = project(t);
  assert.equal(prepare(root).status, 0);
  addScreenContract(root);

  const generated = run('build-screen-artifacts.js', [root, 'generate']);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(fs.existsSync(path.join(root, '.tmp/service-inventory.json')), true);
  assert.equal(fs.existsSync(path.join(root, '.tmp/navigation-contract.json')), true);
  assert.match(fs.readFileSync(path.join(root, 'app/(app)/_layout.tsx'), 'utf8'), /<Tabs/);
  assert.match(fs.readFileSync(path.join(root, 'app/(app)/equipment/index.tsx'), 'utf8'), /return null/);

  const contexts = run('build-builder-context.js', [root, 'build']);
  assert.equal(contexts.status, 0, contexts.stderr);
  const contextPath = '.tmp/builder-context/equipment.json';
  const checked = run('build-builder-context.js', [root, 'check', contextPath]);
  assert.equal(checked.status, 0, checked.stderr);
  fs.appendFileSync(path.join(root, 'app/(app)/equipment/index.tsx'), '// drift\n');
  const stale = run('build-builder-context.js', [root, 'check', contextPath]);
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /target hash mismatch/);

  const waves = run('pack-screen-waves.js', [root, '--max-concurrency', '2']);
  assert.equal(waves.status, 0, waves.stderr);
  const waveReceipt = readJson(root, '.tmp/screen-waves.json');
  assert.equal(waveReceipt.waves.length, 2);
  assert.ok(waveReceipt.waves.every((wave) => wave.screens.length <= 2));
  assert.equal(waveReceipt.algorithm, 'longest-processing-time-balanced');
});

test('native capabilities deduplicate into batches and pass one join gate', (t) => {
  const root = project(t);
  write(root, '.tmp/native-capabilities-contract.json', {
    schemaVersion: 1,
    capabilities: [
      { capability: 'camera', package: 'expo-camera', wrapperFiles: ['src/native/camera.ts'] },
      { capability: 'qr-scanner', package: 'expo-camera', wrapperFiles: ['src/native/barcodeScanner.tsx'] },
    ],
  });
  const planned = run('plan-native-batches.js', [root, 'plan']);
  assert.equal(planned.status, 0, planned.stderr);
  const batches = readJson(root, '.tmp/native-batches.json');
  assert.equal(batches.batches.length, 1);
  assert.equal(batches.batches[0].id, 'camera-suite');
  assert.equal(run('plan-native-batches.js', [root, 'check']).status, 0);

  write(root, 'src/native/camera.ts', 'export const camera = true;\n');
  write(root, 'src/native/barcodeScanner.tsx', 'export const scanner = true;\n');
  const verified = run('plan-native-batches.js', [root, 'verify']);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(readJson(root, '.tmp/native-bundle-validation.json').wrappers.length, 2);
});

test('preview locks invalidate and delete stale output', (t) => {
  const root = project(t);
  write(root, 'native-app-plan.md', '# Plan\n');
  const begun = run('preview-lock.js', [root, 'begin', 'preview.html']);
  assert.equal(begun.status, 0, begun.stderr);
  write(root, 'preview.html', '<!doctype html><title>Preview</title>\n');
  const finalized = run('preview-lock.js', [root, 'finalize', 'preview.html']);
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(run('preview-lock.js', [root, 'check', 'preview.html']).status, 0);

  fs.appendFileSync(path.join(root, 'native-app-plan.md'), 'changed\n');
  assert.equal(run('preview-lock.js', [root, 'check', 'preview.html']).status, 2);
  assert.equal(run('preview-lock.js', [root, 'begin', 'preview.html']).status, 0);
  fs.appendFileSync(path.join(root, 'app/index.tsx'), '// changed\n');
  const invalidated = run('preview-lock.js', [root, 'finalize', 'preview.html']);
  assert.equal(invalidated.status, 2);
  assert.equal(fs.existsSync(path.join(root, 'preview.html')), false);
});

test('validation receipts cache identical passes and TypeScript gates always execute', (t) => {
  const root = project(t);
  const firstValidation = run('run-validation-batch.js', ['--project-root', root, '--file', 'README.md']);
  assert.equal(firstValidation.status, 0, firstValidation.stderr);
  const secondValidation = run('run-validation-batch.js', ['--project-root', root, '--file', 'README.md']);
  assert.equal(secondValidation.status, 0, secondValidation.stderr);
  assert.ok(readJson(root, '.tmp/validation-receipt.json').cachedCount > 0);
  write(root, 'native-app-plan.md', '# Changed plan context\n');
  const contextChanged = run('run-validation-batch.js', ['--project-root', root, '--file', 'README.md']);
  assert.equal(contextChanged.status, 0, contextChanged.stderr);
  assert.ok(readJson(root, '.tmp/validation-receipt.json').executedCount > 0);

  const fakeTsc = path.join(root, 'fake-tsc.js');
  write(root, 'fake-tsc.js', `
const fs = require('node:fs');
const path = require('node:path');
const index = process.argv.indexOf('--tsBuildInfoFile');
const target = process.argv[index + 1];
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, 'build-info');
const countFile = path.join(path.dirname(target), 'count.txt');
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(count + 1));
`);
  const env = { MOBILE_TSC_ENTRY: fakeTsc };
  const firstGate = run('run-tsc-gate.js', ['--project-root', root, '--gate', 'scaffold'], { env });
  assert.equal(firstGate.status, 0, firstGate.stderr);
  const secondGate = run('run-tsc-gate.js', ['--project-root', root, '--gate', 'navigation'], { env });
  assert.equal(secondGate.status, 0, secondGate.stderr);
  const cleanGate = run('run-tsc-gate.js', ['--project-root', root, '--gate', 'final', '--clean'], { env });
  assert.equal(cleanGate.status, 0, cleanGate.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.tmp/tsc/count.txt'), 'utf8'), '3');
  assert.equal(readJson(root, '.tmp/tsc-gates/navigation.json').reusedIncrementalState, true);
  assert.equal(readJson(root, '.tmp/tsc-gates/final.json').mode, 'clean');
});

test('concurrent final checks preserve repair order and run a clean TypeScript gate', (t) => {
  const root = project(t);
  assert.equal(prepare(root).status, 0);
  addScreenContract(root);
  assert.equal(run('build-screen-artifacts.js', [root, 'generate']).status, 0);

  const fakeTsc = path.join(root, 'fake-tsc.js');
  write(root, 'fake-tsc.js', `
const fs = require('node:fs');
const path = require('node:path');
const index = process.argv.indexOf('--tsBuildInfoFile');
const target = process.argv[index + 1];
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, 'final-build-info');
`);
  const result = run('run-final-checks.js', ['--project-root', root, '--all-source'], {
    env: { MOBILE_TSC_ENTRY: fakeTsc },
  });
  assert.equal(result.status, 2, 'empty skeleton screens should fail final quality checks');
  const receipt = readJson(root, '.tmp/final-checks-receipt.json');
  assert.equal(receipt.status, 'fail');
  assert.deepEqual(receipt.repairOrder, ['route', 'contract', 'quality', 'contrast', 'typescript', 'changed-file']);
  assert.equal(receipt.results.some((entry) => entry.category === 'typescript' && entry.status === 'pass'), true);
  assert.equal(readJson(root, '.tmp/tsc-gates/final.json').mode, 'clean');
  assert.match(fs.readFileSync(path.join(root, '.tmp/final-validation.md'), 'utf8'), /^Overall: FAIL/m);
});

test('optimization state is recorded atomically only after final PASS', (t) => {
  const root = project(t);
  write(root, 'native-app-plan.md', '# Approved plan\n');
  const { createHash } = require('node:crypto');
  const stable = (value) => `${JSON.stringify(value, Object.keys(value).sort(), 2)}\n`;
  const passReceipt = {
    schemaVersion: 1,
    status: 'pass',
  };
  passReceipt.receiptSha256 = createHash('sha256').update(stable(passReceipt)).digest('hex');
  write(root, '.tmp/final-checks-receipt.json', passReceipt);
  write(root, '.tmp/template-prep-receipt.json', { schemaVersion: 1, status: 'pass' });
  const recorded = run('record-optimization-state.js', [root, '--data-mode', 'prototype']);
  assert.equal(recorded.status, 0, recorded.stderr);
  const state = readJson(root, '.mobile-app/state.json');
  assert.equal(state.dataMode, 'prototype');
  assert.match(state.lastSyncedPlanHash, /^[a-f0-9]{64}$/);
  assert.match(state.optimizationReceipts.templatePrep, /^[a-f0-9]{64}$/);
  assert.match(state.optimizationReceipts.finalChecks, /^[a-f0-9]{64}$/);
  assert.equal(state.lastDataverseManifestHash, null);

  write(root, '.tmp/final-checks-receipt.json', { schemaVersion: 1, status: 'fail' });
  const blocked = run('record-optimization-state.js', [root, '--data-mode', 'prototype']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /not PASS/);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const extractor = require('../extract-msapp-brief.v2.cjs');
const legacyAlias = require('../extract-msapp-brief.cjs');
const adapter = require('../adapt-app-brief-for-mobile-plugin.js');
const importer = require('../import-mobile-plugin-input.js');
const workflowPlanLib = require('../lib/workflow-plan.js');

function withoutControlFlowId(frame) {
  const { id, ...rest } = frame;
  assert.match(id, /^[a-zA-Z]+-[0-9a-f]{8}$/);
  return rest;
}

test('legacy extractor filename forwards to canonical v2 implementation', () => {
  assert.equal(legacyAlias.classifyFormulaIntents, extractor.classifyFormulaIntents);
  assert.equal(legacyAlias.main, extractor.main);
});

test('source reader rejects archive-shaped disk path escapes', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msapp-source-reader-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(tmp, 'outside.json'), '{"secret":"must-not-read"}');
  const reader = extractor.createSourceReader(source);
  assert.throws(() => reader.readJson('../outside.json'), /escapes root/);
});

test('extractor rejects malformed MSAPR sidecars and source symlinks', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msapp-hostile-source-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const malformedRoot = path.join(tmp, 'malformed');
  fs.mkdirSync(path.join(malformedRoot, 'Src'), { recursive: true });
  fs.writeFileSync(path.join(malformedRoot, 'Src', 'Home.pa.yaml'), 'Screens:\n  Home:\n    Children: []\n');
  fs.writeFileSync(path.join(malformedRoot, 'bad.msapr'), 'not-a-zip');
  const malformed = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'extract-msapp-brief.v2.cjs'),
    '--extracted', malformedRoot,
    '--out', path.join(tmp, 'malformed-out'),
  ], { encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /not a readable ZIP archive/i);

  const symlinkRoot = path.join(tmp, 'symlink');
  fs.mkdirSync(path.join(symlinkRoot, 'Src'), { recursive: true });
  const outside = path.join(tmp, 'outside.pa.yaml');
  fs.writeFileSync(outside, 'Screens:\n  Outside:\n    Children: []\n');
  try {
    fs.symlinkSync(outside, path.join(symlinkRoot, 'Src', 'Linked.pa.yaml'), 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlink creation unavailable on this runner');
    throw error;
  }
  const linked = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'extract-msapp-brief.v2.cjs'),
    '--extracted', symlinkRoot,
    '--out', path.join(tmp, 'symlink-out'),
  ], { encoding: 'utf8' });
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /symbolic links are not allowed/i);
});

test('PCF sidecar extraction creates Gate 2b contract and YAML-only PCF signals block generation', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msapp-pcf-e2e-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const extractorPath = path.resolve(__dirname, '..', 'extract-msapp-brief.v2.cjs');
  const adapterPath = path.resolve(__dirname, '..', 'adapt-app-brief-for-mobile-plugin.js');
  const validatorPath = path.resolve(__dirname, '..', 'validate-mobile-plugin-input.js');
  const yaml = [
    'App:',
    '  Properties:',
    '    StartScreen: =Home',
    'Screens:',
    '  Home:',
    '    Children:',
    '      - SideNavigation:',
    '          Control: CodeComponent@1.0.0',
    '          Properties:',
    '            Items: =col_navigation',
    '            OnSelect: =Navigate(Home)',
    '',
  ].join('\n');

  const enrichedRoot = path.join(tmp, 'enriched');
  fs.mkdirSync(path.join(enrichedRoot, 'Src'), { recursive: true });
  fs.mkdirSync(path.join(enrichedRoot, 'Controls'));
  fs.mkdirSync(path.join(enrichedRoot, 'Components'));
  fs.writeFileSync(path.join(enrichedRoot, 'Src', 'App.pa.yaml'), yaml);
  fs.writeFileSync(path.join(enrichedRoot, 'Properties.json'), JSON.stringify({ ContainsThirdPartyPcfControls: true }));
  fs.writeFileSync(path.join(enrichedRoot, 'Controls', 'Home.json'), JSON.stringify({
    TopParent: {
      Name: 'Home',
      Template: { FirstParty: true },
      Children: [{
        Name: 'SideNavigation',
        Template: {
          FirstParty: false,
          IsPremiumPcfControl: true,
          Name: 'Contoso.SideNavigation',
          Id: 'source-template-guid',
        },
        Children: [],
      }],
    },
  }));
  const briefDir = path.join(tmp, 'brief');
  const adaptedDir = path.join(tmp, 'adapted');
  const extracted = spawnSync(process.execPath, [extractorPath, '--extracted', enrichedRoot, '--out', briefDir], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
  const brief = JSON.parse(fs.readFileSync(path.join(briefDir, 'app-brief.json'), 'utf8'));
  assert.equal(brief.app.pcfControls.length, 1);
  assert.equal(brief.app.pcfControls[0].templateName, 'Contoso.SideNavigation');
  assert.equal(brief.app.pcfControls[0].isPremiumPcf, true);
  const adapted = spawnSync(process.execPath, [adapterPath, '--input', path.join(briefDir, 'app-brief.json'), '--screens-dir', path.join(briefDir, 'screens'), '--out-dir', adaptedDir], { encoding: 'utf8' });
  assert.equal(adapted.status, 0, adapted.stderr || adapted.stdout);
  const pcfPlan = JSON.parse(fs.readFileSync(path.join(adaptedDir, 'pcf-plan.json'), 'utf8'));
  assert.equal(pcfPlan.discovery.complete, true);
  assert.equal(pcfPlan.controls.length, 1);
  assert.match(pcfPlan.controls[0].pcfId, /^pcf-[0-9a-f]{16}$/);
  assert.equal(pcfPlan.controls[0].proposal.disposition, 'native-replacement');
  assert.equal(pcfPlan.controls[0].approval.status, 'pending');
  assert.equal(JSON.stringify(pcfPlan).includes('source-template-guid'), false);

  const yamlOnlyRoot = path.join(tmp, 'yaml-only');
  fs.mkdirSync(path.join(yamlOnlyRoot, 'Src'), { recursive: true });
  fs.writeFileSync(path.join(yamlOnlyRoot, 'Src', 'App.pa.yaml'), yaml);
  fs.writeFileSync(path.join(yamlOnlyRoot, 'Properties.json'), JSON.stringify({ ContainsThirdPartyPcfControls: true }));
  const yamlBrief = path.join(tmp, 'yaml-brief');
  const yamlAdapted = path.join(tmp, 'yaml-adapted');
  const extractedYaml = spawnSync(process.execPath, [extractorPath, '--extracted', yamlOnlyRoot, '--out', yamlBrief], { encoding: 'utf8' });
  assert.equal(extractedYaml.status, 0, extractedYaml.stderr || extractedYaml.stdout);
  const adaptedYaml = spawnSync(process.execPath, [adapterPath, '--input', path.join(yamlBrief, 'app-brief.json'), '--screens-dir', path.join(yamlBrief, 'screens'), '--out-dir', yamlAdapted], { encoding: 'utf8' });
  assert.equal(adaptedYaml.status, 0, adaptedYaml.stderr || adaptedYaml.stdout);
  const incompletePlan = JSON.parse(fs.readFileSync(path.join(yamlAdapted, 'pcf-plan.json'), 'utf8'));
  assert.equal(incompletePlan.discovery.complete, false);
  assert.equal(incompletePlan.controls.length, 0);
  assert.match(incompletePlan.discovery.blockers[0].code, /PCF_INVENTORY_INCOMPLETE/);
  const baseValidation = spawnSync(process.execPath, [validatorPath, '--dir', yamlAdapted, '--json'], { encoding: 'utf8' });
  assert.equal(baseValidation.status, 0, baseValidation.stderr || baseValidation.stdout);
  assert.match(JSON.parse(baseValidation.stdout).warnings.join('\n'), /PCF content.*incomplete/i);
  const strictValidation = spawnSync(process.execPath, [validatorPath, '--dir', yamlAdapted, '--json', '--require-pcf-approval'], { encoding: 'utf8' });
  assert.equal(strictValidation.status, 1);
  assert.match(JSON.parse(strictValidation.stdout).errors.join('\n'), /PCF discovery is incomplete|source reports PCF content/);
});

test('screen names cannot traverse extractor or adapter output paths', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msapp-screen-path-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, 'Src');
  const briefDir = path.join(tmp, 'brief');
  const adaptedDir = path.join(tmp, 'adapted');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'Screens.pa.yaml'), [
    'Screens:',
    '  ../Escape:',
    '    Children:',
    '      - Label:',
    '          Control: Label@2.5.1',
    '          Properties:',
    '            Text: ="Safe"',
    '',
  ].join('\n'));

  const extract = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'extract-msapp-brief.v2.cjs'),
    '--extracted', tmp,
    '--out', briefDir,
    '--app-name', 'Path Safety',
  ], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr || extract.stdout);
  const brief = JSON.parse(fs.readFileSync(path.join(briefDir, 'app-brief.json'), 'utf8'));
  assert.equal(brief.screens[0].name, '../Escape');
  assert.doesNotMatch(brief.screens[0].briefPath, /\.\./);
  assert.ok(fs.existsSync(path.resolve(briefDir, brief.screens[0].briefPath)));

  const adapt = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'adapt-app-brief-for-mobile-plugin.js'),
    '--input', path.join(briefDir, 'app-brief.json'),
    '--screens-dir', path.join(briefDir, 'screens'),
    '--out-dir', adaptedDir,
  ], { encoding: 'utf8' });
  assert.equal(adapt.status, 0, adapt.stderr || adapt.stdout);
  const input = JSON.parse(fs.readFileSync(path.join(adaptedDir, 'mobile-plugin-input.json'), 'utf8'));
  assert.doesNotMatch(input.screenPlan.screens[0].planFile, /\.\./);
  assert.equal(input.screenPlan.screens[0].route, '/(app)/home');
  assert.equal(input.screenPlan.screens[0].file, 'app/(app)/home.tsx');
  assert.ok(fs.existsSync(path.resolve(adaptedDir, input.screenPlan.screens[0].planFile)));
  assert.equal(fs.existsSync(path.join(tmp, 'Escape.json')), false);
});

test('workflow Gate 2c validation blocks pending plans and rejects behavior or path tampering', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msapp-workflow-gate-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, 'Src');
  const briefDir = path.join(tmp, 'brief');
  const adaptedDir = path.join(tmp, 'adapted');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'App.pa.yaml'), [
    'App:',
    '  Properties:',
    '    StartScreen: =OrderConfirm',
    'Screens:',
    '  OrderConfirm:',
    '    Children:',
    '      - ConfirmButton:',
    '          Control: Button@1.0.0',
    '          Properties:',
    '            OnSelect: =Confirm("Submit order?"); Patch(Orders, Defaults(Orders), {name: var_name}); ForAll(col_lines As line, Patch(OrderLines, Defaults(OrderLines), {name: line.name})); \'Approval Flow\'.Run(var_orderId); Set(var_submitted, true); Refresh(Orders); Notify("Order submitted"); Navigate(OrderComplete)',
    '  OrderComplete:',
    '    Children: []',
    '',
  ].join('\n'));

  const extract = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'extract-msapp-brief.v2.cjs'),
    '--extracted', tmp,
    '--out', briefDir,
    '--app-name', 'Workflow Gate App',
  ], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr || extract.stdout);
  const adapt = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'adapt-app-brief-for-mobile-plugin.js'),
    '--input', path.join(briefDir, 'app-brief.json'),
    '--screens-dir', path.join(briefDir, 'screens'),
    '--out-dir', adaptedDir,
  ], { encoding: 'utf8' });
  assert.equal(adapt.status, 0, adapt.stderr || adapt.stdout);

  const validatorPath = path.resolve(__dirname, '..', 'validate-mobile-plugin-input.js');
  const base = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json'], { encoding: 'utf8' });
  assert.equal(base.status, 0, base.stderr || base.stdout);
  const pending = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json', '--require-workflow-approval'], { encoding: 'utf8' });
  assert.equal(pending.status, 1);
  assert.match(JSON.parse(pending.stdout).errors.join('\n'), /still requires explicit workflow approval/);

  const reportPath = path.join(tmp, 'workflow-assessment.html');
  const report = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'render-mobile-migration-report.js'),
    '--dir', adaptedDir,
    '--out', reportPath,
  ], { encoding: 'utf8' });
  assert.equal(report.status, 0, report.stderr || report.stdout);
  const reportHtml = fs.readFileSync(reportPath, 'utf8');
  assert.match(reportHtml, /Pathological event workflows/);
  assert.match(reportHtml, /correctness-critical workflow answer/);

  const workflowsPath = path.join(adaptedDir, 'workflows.json');
  const inputPath = path.join(adaptedDir, 'mobile-plugin-input.json');
  const workflowPlan = JSON.parse(fs.readFileSync(workflowsPath, 'utf8'));
  const pluginInput = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const workflow = workflowPlan.workflows[0];
  workflow.approval = {
    status: 'approved',
    approvedStepIds: workflow.proposal.steps.map((step) => step.stepId),
    decisions: workflow.requiredDecisions.map((decision) => ({
      decisionId: decision.decisionId,
      status: 'resolved',
      value: decision.recommended,
      resolvedBy: 'user',
      reason: 'User selected the recommended source-parity policy.',
    })),
    executionOwner: 'client-orchestrator',
    uxMode: 'single-action-with-progress',
    serverDependency: null,
    compensationPlan: null,
    reason: 'User approved the named-step workflow decomposition.',
    approvedBy: 'user',
    approvedAt: '2026-07-15T00:00:00.000Z',
  };
  workflowPlan.stats = workflowPlanLib.deriveWorkflowStats(workflowPlan.workflows, workflowPlan.stats);
  pluginInput.workflowPlan.stats = JSON.parse(JSON.stringify(workflowPlan.stats));
  fs.writeFileSync(workflowsPath, JSON.stringify(workflowPlan, null, 2));
  fs.writeFileSync(inputPath, JSON.stringify(pluginInput, null, 2));

  const approved = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json', '--require-workflow-approval'], { encoding: 'utf8' });
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);

  const target = path.join(tmp, 'fresh-template');
  fs.mkdirSync(path.join(target, 'node_modules', 'expo'), { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), '{"name":"workflow-target"}\n');
  fs.writeFileSync(path.join(target, 'app.config.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(target, 'auth.config.json'), '{"msal":{"clientId":"","tenantId":""}}\n');
  fs.writeFileSync(path.join(target, 'tamagui.config.ts'), 'export default {};\n');
  const imported = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'import-mobile-plugin-input.js'),
    '--source', adaptedDir,
    '--target', target,
  ], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  assert.equal(JSON.parse(imported.stdout).workflowApprovalsReset, 1);
  const importedWorkflows = JSON.parse(fs.readFileSync(path.join(target, 'workflows.json'), 'utf8'));
  const importedInput = JSON.parse(fs.readFileSync(path.join(target, 'mobile-plugin-input.json'), 'utf8'));
  assert.equal(importedWorkflows.workflows[0].approval.status, 'pending');
  assert.deepEqual(importedWorkflows.workflows[0].approval.decisions, []);
  assert.equal(importedWorkflows.stats.pendingApproval, 1);
  assert.equal(importedInput.workflowPlan.stats.pendingApproval, 1);

  const unownedSource = path.join(tmp, 'unowned-source');
  fs.cpSync(adaptedDir, unownedSource, { recursive: true });
  fs.rmSync(path.join(unownedSource, '.mobile-app-modernizer-output'));
  const unownedTarget = path.join(tmp, 'unowned-target');
  fs.mkdirSync(path.join(unownedTarget, 'node_modules', 'expo'), { recursive: true });
  fs.writeFileSync(path.join(unownedTarget, 'package.json'), '{"name":"unowned-target"}\n');
  fs.writeFileSync(path.join(unownedTarget, 'app.config.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(unownedTarget, 'auth.config.json'), '{"msal":{"clientId":"","tenantId":""}}\n');
  fs.writeFileSync(path.join(unownedTarget, 'tamagui.config.ts'), 'export default {};\n');
  const unownedImport = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'import-mobile-plugin-input.js'),
    '--source', unownedSource,
    '--target', unownedTarget,
  ], { encoding: 'utf8' });
  assert.equal(unownedImport.status, 1);
  assert.match(unownedImport.stderr, /adapter ownership marker/);
  assert.equal(fs.existsSync(path.join(unownedTarget, 'native-app-plan.md')), false);

  const originalSteps = JSON.stringify(workflow.proposal.steps);
  workflow.proposal.steps[0].behaviorIds = [];
  fs.writeFileSync(workflowsPath, JSON.stringify(workflowPlan, null, 2));
  const missingBehavior = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json'], { encoding: 'utf8' });
  assert.equal(missingBehavior.status, 1);
  assert.match(JSON.parse(missingBehavior.stdout).errors.join('\n'), /behaviorIds must not be empty|account for every source behavior/);
  workflow.proposal.steps = JSON.parse(originalSteps);

  const loopStepIndex = workflow.proposal.steps.findIndex((step) => step.controlFlowKinds.includes('forAll'));
  workflow.proposal.steps[loopStepIndex].controlFlow[0].source = 'col_tampered';
  fs.writeFileSync(workflowsPath, JSON.stringify(workflowPlan, null, 2));
  const controlFlowDrift = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json'], { encoding: 'utf8' });
  assert.equal(controlFlowDrift.status, 1);
  assert.match(JSON.parse(controlFlowDrift.stdout).errors.join('\n'), /controlFlow differs from behavior/);
  workflow.proposal.steps = JSON.parse(originalSteps);

  workflow.proposal.target.module = '../escape.ts';
  workflow.proposal.target.importPath = '@/escape';
  fs.writeFileSync(workflowsPath, JSON.stringify(workflowPlan, null, 2));
  const unsafePath = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json'], { encoding: 'utf8' });
  assert.equal(unsafePath.status, 1);
  assert.match(JSON.parse(unsafePath.stdout).errors.join('\n'), /target\.module is unsafe or invalid/);
});

test('extractor accepts lowercase src directory on case-sensitive filesystems', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msapp-lowercase-src-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const srcDir = path.join(tmp, 'src');
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'App.pa.yaml'), [
    'App:',
    '  Properties:',
    '    StartScreen: =Home',
    'Screens:',
    '  Home:',
    '    Children:',
    '      - Title:',
    '          Control: Label@2.5.1',
    '          Properties:',
    '            Text: ="Hello"',
    '            OnSelect: =Notify("```source text```")',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'Properties.json'), JSON.stringify({
    InstrumentationKey: 'source-instrumentation-key',
    AuthorEmail: 'maker@contoso.example',
    ManualOfflineProfileId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  }));

  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'extract-msapp-brief.v2.cjs'),
    '--extracted', tmp,
    '--out', outDir,
    '--app-name', 'Lowercase Source App',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const brief = JSON.parse(fs.readFileSync(path.join(outDir, 'app-brief.json'), 'utf8'));
  assert.equal(brief.generatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(brief.app.name, 'Lowercase Source App');
  assert.deepEqual(brief.screens.map((screen) => screen.name), ['Home']);
  assert.equal(path.isAbsolute(brief.source.extractedPath), false);
  assert.equal(brief.app.settings.hasInstrumentationKey, true);
  assert.equal(brief.app.settings.hasAuthorMetadata, true);
  assert.equal(brief.app.settings.hasManualOfflineProfile, true);
  const serializedBrief = JSON.stringify(brief);
  assert.doesNotMatch(serializedBrief, /source-instrumentation-key|maker@contoso\.example|aaaaaaaa-bbbb/);

  const adaptedDir = path.join(tmp, 'adapted');
  const adapted = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'adapt-app-brief-for-mobile-plugin.js'),
    '--input', path.join(outDir, 'app-brief.json'),
    '--screens-dir', path.join(outDir, 'screens'),
    '--out-dir', adaptedDir,
  ], { encoding: 'utf8' });

  assert.equal(adapted.status, 0, adapted.stderr || adapted.stdout);
  const pluginInput = JSON.parse(fs.readFileSync(path.join(adaptedDir, 'mobile-plugin-input.json'), 'utf8'));
  assert.equal(pluginInput.schemaVersion, '3');
  assert.match(pluginInput.$schema, /mobile-plugin-input\.v3\.schema\.json$/);
  assert.equal(path.isAbsolute(pluginInput.source.appBriefPath), false);
  assert.deepEqual(pluginInput.screenPlan.screens.map((screen) => screen.name), ['Home']);
  assert.equal(pluginInput.screenPlan.screens[0].route, '/(app)/home');
  assert.equal(pluginInput.screenPlan.screens[0].file, 'app/(app)/home.tsx');
  assert.deepEqual(pluginInput.screenPlan.screens[0].nativeCapabilities, []);
  assert.deepEqual(pluginInput.screenPlan.screens[0].sourceNativeIntents, ['notification']);
  assert.deepEqual(pluginInput.nativePlan.capabilities, []);
  assert.deepEqual(pluginInput.nativePlan.sourceIntents, ['notification']);
  assert.equal(pluginInput.controlIntentCoverage.stats.totalControls, 1);
  assert.equal(pluginInput.pcfPlan.file, 'pcf-plan.json');
  assert.equal(pluginInput.pcfPlan.stats.total, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(adaptedDir, 'pcf-plan.json'), 'utf8')).controls, []);
  assert.equal(pluginInput.workflowPlan.file, 'workflows.json');
  assert.equal(pluginInput.workflowPlan.stats.total, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(adaptedDir, 'workflows.json'), 'utf8')).workflows, []);
  const adaptedScreenPlan = fs.readFileSync(path.resolve(adaptedDir, pluginInput.screenPlan.screens[0].planFile), 'utf8');
  assert.match(adaptedScreenPlan, /    ````pfx\n    Notify\("```source text```"\)\n    ````/);
  const nativePlan = fs.readFileSync(path.join(adaptedDir, 'native-app-plan.md'), 'utf8');
  assert.deepEqual(
    [...nativePlan.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ['Overview', 'App Requirements', 'Data Model', 'Native Capabilities', 'Design Direction', 'Connectors', 'Screens']
  );
  assert.match(nativePlan, /\| Screen \| Route \| File \| Presentation \| Purpose \| Data \| Native \| Source \|/);
  assert.match(nativePlan, /### Navigation Contracts/);
  assert.match(nativePlan, /Query params \(UNION across all senders\)/);
  assert.match(nativePlan, /### Per-Screen Specs/);
  assert.match(nativePlan, /## Native Capabilities\nNone — this app uses only standard React Native components and Power Platform connectors\./);
  assert.match(nativePlan, /## Source Native and UI Intents — Builder\/Review Only/);
  assert.match(nativePlan, /- \*\*File:\*\* `app\/\(app\)\/home\.tsx`/);

  const validatorPath = path.resolve(__dirname, '..', 'validate-mobile-plugin-input.js');
  const validation = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json'], { encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  assert.equal(JSON.parse(validation.stdout).ok, true);
  const strictPcfValidation = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json', '--require-pcf-approval'], { encoding: 'utf8' });
  assert.equal(strictPcfValidation.status, 0, strictPcfValidation.stderr || strictPcfValidation.stdout);

  const firstPluginInput = fs.readFileSync(path.join(adaptedDir, 'mobile-plugin-input.json'), 'utf8');
  const firstNativePlan = fs.readFileSync(path.join(adaptedDir, 'native-app-plan.md'), 'utf8');
  const repeatedAdapt = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'adapt-app-brief-for-mobile-plugin.js'),
    '--input', path.join(outDir, 'app-brief.json'),
    '--screens-dir', path.join(outDir, 'screens'),
    '--out-dir', adaptedDir,
  ], { encoding: 'utf8' });
  assert.equal(repeatedAdapt.status, 0, repeatedAdapt.stderr || repeatedAdapt.stdout);
  assert.equal(fs.readFileSync(path.join(adaptedDir, 'mobile-plugin-input.json'), 'utf8'), firstPluginInput);
  assert.equal(fs.readFileSync(path.join(adaptedDir, 'native-app-plan.md'), 'utf8'), firstNativePlan);

  const pcfPlanPath = path.join(adaptedDir, 'pcf-plan.json');
  const coveragePath = path.join(adaptedDir, 'control-intent-coverage.json');
  const originalPcfPlan = fs.readFileSync(pcfPlanPath, 'utf8');
  const originalCoverage = fs.readFileSync(coveragePath, 'utf8');
  const pendingInput = JSON.parse(firstPluginInput);
  pendingInput.pcfPlan.stats.total = 1;
  pendingInput.pcfPlan.stats.pendingApproval = 1;
  pendingInput.pcfPlan.stats.approved = 0;
  pendingInput.pcfPlan.stats.blocked = 0;
  pendingInput.pcfPlan.stats.byDisposition = { 'native-replacement': 0, 'server-dependency': 0, 'explicit-unsupported': 0, blocker: 0 };
  const pendingCoverage = JSON.parse(originalCoverage);
  pendingCoverage.rows.push({
    screen: 'Home',
    control: 'TestPCF',
    path: 'Home/TestPCF',
    businessRisk: 'high',
    nativeSuggestion: 'Tamagui Switch',
    flags: { isPcf: true },
  });
  pendingCoverage.stats.totalControls = pendingCoverage.rows.length;
  pendingCoverage.stats.pcfControls = 1;
  const pendingPcf = {
    $schema: 'pcf-plan-v1',
    generatedAt: '1970-01-01T00:00:00.000Z',
    allowedDispositions: ['native-replacement', 'server-dependency', 'explicit-unsupported', 'blocker'],
    discovery: {
      complete: true,
      sourceSignals: { containsThirdPartyPcfControls: true, extractedPackageCount: 0, extractedControlCount: 1 },
      blockers: [],
    },
    stats: {
      total: 1,
      discoveryComplete: true,
      pendingApproval: 1,
      approved: 0,
      blocked: 0,
      byDisposition: { 'native-replacement': 0, 'server-dependency': 0, 'explicit-unsupported': 0, blocker: 0 },
      proposed: { 'native-replacement': 1, 'server-dependency': 0, 'explicit-unsupported': 0, blocker: 0 },
    },
    controls: [{
      pcfId: 'pcf-1111111111111111',
      screen: 'Home',
      control: 'TestPCF',
      path: 'Home/TestPCF',
      proposal: { disposition: 'native-replacement', targetStrategy: { primitive: 'Tamagui Switch', packages: ['tamagui'] } },
      approval: { status: 'pending', disposition: null },
    }],
  };
  fs.writeFileSync(path.join(adaptedDir, 'mobile-plugin-input.json'), JSON.stringify(pendingInput));
  fs.writeFileSync(coveragePath, JSON.stringify(pendingCoverage));
  fs.writeFileSync(pcfPlanPath, JSON.stringify(pendingPcf));
  const pendingBaseValidation = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json'], { encoding: 'utf8' });
  assert.equal(pendingBaseValidation.status, 0, pendingBaseValidation.stderr || pendingBaseValidation.stdout);
  const pendingStrictValidation = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json', '--require-pcf-approval'], { encoding: 'utf8' });
  assert.equal(pendingStrictValidation.status, 1);
  assert.match(JSON.parse(pendingStrictValidation.stdout).errors.join('\n'), /still requires explicit PCF approval/);
  pendingPcf.controls[0].approval = {
    status: 'approved',
    disposition: 'explicit-unsupported',
    essentiality: 'essential',
    targetStrategy: null,
    unsupportedUx: 'This required capability is unavailable.',
    reason: 'Invalid attempted waiver.',
    approvedBy: 'user',
    approvedAt: '2026-07-14T00:00:00.000Z',
  };
  pendingPcf.stats.pendingApproval = 0;
  pendingPcf.stats.approved = 1;
  pendingPcf.stats.byDisposition['explicit-unsupported'] = 1;
  pendingInput.pcfPlan.stats.pendingApproval = 0;
  pendingInput.pcfPlan.stats.approved = 1;
  pendingInput.pcfPlan.stats.byDisposition['explicit-unsupported'] = 1;
  fs.writeFileSync(path.join(adaptedDir, 'mobile-plugin-input.json'), JSON.stringify(pendingInput));
  fs.writeFileSync(pcfPlanPath, JSON.stringify(pendingPcf));
  const invalidWaiver = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json', '--require-pcf-approval'], { encoding: 'utf8' });
  assert.equal(invalidWaiver.status, 1);
  assert.match(JSON.parse(invalidWaiver.stdout).errors.join('\n'), /explicit unsupported is allowed only/);
  pendingPcf.controls[0].approval = {
    status: 'approved',
    disposition: 'native-replacement',
    essentiality: 'essential',
    targetStrategy: { primitive: 'Tamagui Switch', packages: ['tamagui'] },
    unsupportedUx: null,
    reason: 'User approved the native switch replacement.',
    approvedBy: 'user',
    approvedAt: '2026-07-14T00:00:00.000Z',
  };
  pendingPcf.stats.pendingApproval = 0;
  pendingPcf.stats.approved = 1;
  pendingPcf.stats.byDisposition['explicit-unsupported'] = 0;
  pendingPcf.stats.byDisposition['native-replacement'] = 1;
  pendingInput.pcfPlan.stats.pendingApproval = 0;
  pendingInput.pcfPlan.stats.approved = 1;
  pendingInput.pcfPlan.stats.byDisposition['explicit-unsupported'] = 0;
  pendingInput.pcfPlan.stats.byDisposition['native-replacement'] = 1;
  fs.writeFileSync(path.join(adaptedDir, 'mobile-plugin-input.json'), JSON.stringify(pendingInput));
  fs.writeFileSync(pcfPlanPath, JSON.stringify(pendingPcf));
  const approvedStrictValidation = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json', '--require-pcf-approval'], { encoding: 'utf8' });
  assert.equal(approvedStrictValidation.status, 0, approvedStrictValidation.stderr || approvedStrictValidation.stdout);
  fs.writeFileSync(path.join(adaptedDir, 'mobile-plugin-input.json'), firstPluginInput);
  fs.writeFileSync(coveragePath, originalCoverage);
  fs.writeFileSync(pcfPlanPath, originalPcfPlan);

  const extractedImageDir = path.join(tmp, 'extracted', 'Assets', 'Images');
  fs.mkdirSync(extractedImageDir, { recursive: true });
  fs.writeFileSync(path.join(extractedImageDir, 'sample.png'), 'portable-asset-bytes');
  fs.writeFileSync(path.join(adaptedDir, 'assets.json'), JSON.stringify({
    images: [
      { name: 'Sample', fileName: 'sample.png', diskPath: 'Assets/Images/sample.png' },
      { name: 'Sample duplicate', fileName: 'sample.png', diskPath: 'Assets/Images/sample.png' },
      { name: 'Nonportable', fileName: 'CON.png', diskPath: 'Assets/Images/CON.png' },
    ],
  }));

  const target = path.join(tmp, 'fresh-template');
  fs.mkdirSync(path.join(target, 'node_modules', 'expo'), { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), '{"name":"fresh-template"}\n');
  fs.writeFileSync(path.join(target, 'app.config.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(target, 'auth.config.json'), '{"msal":{"clientId":"","tenantId":""}}\n');
  fs.writeFileSync(path.join(target, 'tamagui.config.ts'), 'export default {};\n');
  const importerPath = path.resolve(__dirname, '..', 'import-mobile-plugin-input.js');
  const imported = spawnSync(process.execPath, [importerPath, '--source', adaptedDir, '--target', target], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  const importResult = JSON.parse(imported.stdout);
  assert.equal(importResult.appName, 'Lowercase Source App');
  assert.equal(importResult.screenCount, 1);
  assert.equal(importResult.assetsCopied, 1);
  assert.equal(importResult.assetsMissing, 1);
  assert.equal(importResult.workflowApprovalsReset, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).name, 'fresh-template');
  assert.ok(fs.existsSync(path.join(target, 'native-app-plan.md')));
  assert.ok(fs.existsSync(path.join(target, 'workflows.json')));
  assert.equal(fs.readFileSync(path.join(target, 'assets', 'images', 'sample.png'), 'utf8'), 'portable-asset-bytes');
  const importedMemory = fs.readFileSync(path.join(target, 'memory-bank.md'), 'utf8');
  assert.match(importedMemory, /Imported from adapted brief at: adapted/);
  assert.match(importedMemory, /Resume from: Step 3/);
  assert.equal(importedMemory.includes(tmp), false);

  const rollbackSource = path.join(tmp, 'rollback-source');
  fs.cpSync(adaptedDir, rollbackSource, { recursive: true });
  fs.rmSync(path.join(rollbackSource, 'assets.json'));
  fs.writeFileSync(path.join(rollbackSource, 'screens', 'unexpected.txt'), 'reject me');
  const rollbackTarget = path.join(tmp, 'rollback-target');
  fs.mkdirSync(path.join(rollbackTarget, 'node_modules', 'expo'), { recursive: true });
  fs.mkdirSync(path.join(rollbackTarget, 'assets', 'images'), { recursive: true });
  fs.writeFileSync(path.join(rollbackTarget, 'assets', 'images', 'keep.png'), 'keep-existing');
  fs.writeFileSync(path.join(rollbackTarget, 'package.json'), '{"name":"rollback-target"}\n');
  fs.writeFileSync(path.join(rollbackTarget, 'app.config.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(rollbackTarget, 'auth.config.json'), '{"msal":{"clientId":"","tenantId":""}}\n');
  fs.writeFileSync(path.join(rollbackTarget, 'tamagui.config.ts'), 'export default {};\n');
  const rolledBack = spawnSync(process.execPath, [importerPath, '--source', rollbackSource, '--target', rollbackTarget], { encoding: 'utf8' });
  assert.equal(rolledBack.status, 1);
  assert.match(rolledBack.stderr, /unexpected file in migration package tree/i);
  assert.equal(fs.readFileSync(path.join(rollbackTarget, 'assets', 'images', 'keep.png'), 'utf8'), 'keep-existing');
  assert.equal(fs.existsSync(path.join(rollbackTarget, 'native-app-plan.md')), false);

  const reportPath = path.join(tmp, 'migration-assessment.html');
  const report = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'render-mobile-migration-report.js'),
    '--dir', adaptedDir,
    '--out', reportPath,
  ], { encoding: 'utf8' });
  assert.equal(report.status, 0, report.stderr || report.stdout);
  const reportHtml = fs.readFileSync(reportPath, 'utf8');
  assert.match(reportHtml, /Lowercase Source App/);
  assert.match(reportHtml, /behavior ledger/i);
  assert.match(reportHtml, /Ready for guided generation|Ready with review/);

  const protectedOut = path.join(tmp, 'protected-output');
  fs.mkdirSync(protectedOut);
  fs.writeFileSync(path.join(protectedOut, 'keep.txt'), 'do not delete');
  fs.writeFileSync(path.join(protectedOut, '.mobile-app-modernizer-output'), 'forged marker');
  const refused = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'extract-msapp-brief.v2.cjs'),
    '--extracted', tmp,
    '--out', protectedOut,
  ], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to replace non-generated output directory/i);
  assert.equal(fs.readFileSync(path.join(protectedOut, 'keep.txt'), 'utf8'), 'do not delete');

  const nested = spawnSync(process.execPath, [importerPath, '--source', adaptedDir, '--target', adaptedDir], { encoding: 'utf8' });
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /separate, non-nested directories/);

  const pluginInputPath = path.join(adaptedDir, 'mobile-plugin-input.json');
  const validPluginInputText = fs.readFileSync(pluginInputPath, 'utf8');
  const duplicateTargetInput = JSON.parse(validPluginInputText);
  duplicateTargetInput.screenPlan.screens.push({
    ...duplicateTargetInput.screenPlan.screens[0],
    name: 'DuplicateTarget',
  });
  fs.writeFileSync(pluginInputPath, JSON.stringify(duplicateTargetInput));
  const duplicateTarget = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json'], { encoding: 'utf8' });
  assert.equal(duplicateTarget.status, 1);
  assert.match(JSON.parse(duplicateTarget.stdout).errors.join('\n'), /duplicate native route|duplicate native target file/);
  fs.writeFileSync(pluginInputPath, validPluginInputText);

  const behaviorsPath = path.join(adaptedDir, 'behaviors.json');
  const validBehaviorsText = fs.readFileSync(behaviorsPath, 'utf8');
  const secretBehaviors = JSON.parse(validBehaviorsText);
  secretBehaviors.actions[0].sourceFormula = 'Launch("https://example.invalid", { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345" })';
  fs.writeFileSync(behaviorsPath, JSON.stringify(secretBehaviors));
  const secretValidation = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json'], { encoding: 'utf8' });
  assert.equal(secretValidation.status, 1);
  assert.match(JSON.parse(secretValidation.stdout).errors.join('\n'), /secret-like text must be removed/);
  fs.writeFileSync(behaviorsPath, validBehaviorsText);

  const behaviors = JSON.parse(fs.readFileSync(behaviorsPath, 'utf8'));
  behaviors.stats.droppedEventActionCount = 1;
  fs.writeFileSync(behaviorsPath, JSON.stringify(behaviors));
  const invalid = spawnSync(process.execPath, [validatorPath, '--dir', adaptedDir, '--json'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1, invalid.stderr || invalid.stdout);
  assert.match(JSON.parse(invalid.stdout).errors.join('\n'), /droppedEventActionCount/);
});

test('quote-aware parsing preserves URLs and quoted flow names', () => {
  assert.deepEqual(
    extractor.classifyFormulaIntents('=Launch("https://contoso.example/path?q=1")'),
    [{
      intent: 'launch',
      target: '"https://contoso.example/path?q=1"',
      sourceStatement: 'Launch("https://contoso.example/path?q=1")',
      sourceStatementIndex: 0,
    }]
  );

  assert.deepEqual(
    extractor.classifyFormulaIntents("='My Approval Flow'.Run(Record.Id, \"subject\")"),
    [{
      intent: 'flowCall',
      flow: 'My Approval Flow',
      action: 'Run',
      args: ['Record.Id', '"subject"'],
      sourceStatement: '\'My Approval Flow\'.Run(Record.Id, "subject")',
      sourceStatementIndex: 0,
    }]
  );
});

test('nested Power Fx actions retain branch, loop, and concurrency context', () => {
  const ifActions = extractor.classifyFormulaIntents(
    '=If(a, Set(var_x, 1), b, Set(var_x, 2), Set(var_x, 3))'
  );
  assert.equal(ifActions.length, 3);
  assert.deepEqual(
    ifActions.map((action) => withoutControlFlowId(action.controlFlow[0])),
    [
      { kind: 'if', branchIndex: 0, role: 'then', condition: 'a' },
      { kind: 'if', branchIndex: 1, role: 'then', condition: 'b' },
      { kind: 'if', role: 'else' },
    ]
  );
  assert.deepEqual(
    ifActions.map((action) => action.sourceStatement),
    ['Set(var_x, 1)', 'Set(var_x, 2)', 'Set(var_x, 3)']
  );

  const loopAction = extractor.classifyFormulaIntents(
    '=ForAll(col_rows As row, Patch(Orders, Defaults(Orders), {name: row.name}))'
  )[0];
  assert.deepEqual(loopAction.controlFlow.map(withoutControlFlowId), [
    { kind: 'forAll', source: 'col_rows', alias: 'row' },
  ]);

  const concurrent = extractor.classifyFormulaIntents(
    '=Concurrent(Refresh(Orders), Refresh(Products))'
  );
  assert.deepEqual(
    concurrent.map((action) => withoutControlFlowId(action.controlFlow[0])),
    [
      { kind: 'concurrent', branchIndex: 0 },
      { kind: 'concurrent', branchIndex: 1 },
    ]
  );

  const chainedBranch = extractor.classifyFormulaIntents(
    '=If(a, Set(var_x, 1); Notify("saved"), Set(var_x, 0))'
  );
  assert.equal(chainedBranch.length, 3);
  assert.deepEqual(
    chainedBranch.slice(0, 2).map((action) => withoutControlFlowId(action.controlFlow[0])),
    [
      { kind: 'if', branchIndex: 0, role: 'then', condition: 'a' },
      { kind: 'if', branchIndex: 0, role: 'then', condition: 'a' },
    ]
  );
  assert.deepEqual(
    chainedBranch.slice(0, 2).map((action) => action.sourceStatement),
    ['Set(var_x, 1)', 'Notify("saved")']
  );

  const nestedFrames = extractor.classifyFormulaIntents(
    '=With({limit: 5}, Switch(mode, "a", Set(var_x, limit), IfError(Patch(Orders, ThisItem, {statuscode: 1}), Notify("failed"))))'
  );
  assert.equal(nestedFrames.length, 3);
  assert.deepEqual(
    nestedFrames.map((action) => action.controlFlow.map((frame) => withoutControlFlowId(frame))),
    [
      [
        { kind: 'with', bindingsExpression: '{limit: 5}', bindings: { limit: '5' } },
        { kind: 'switch', expression: 'mode', caseIndex: 0, role: 'case', match: '"a"' },
      ],
      [
        { kind: 'with', bindingsExpression: '{limit: 5}', bindings: { limit: '5' } },
        { kind: 'switch', expression: 'mode', role: 'default' },
        { kind: 'ifError', clauseIndex: 0, role: 'try' },
      ],
      [
        { kind: 'with', bindingsExpression: '{limit: 5}', bindings: { limit: '5' } },
        { kind: 'switch', expression: 'mode', role: 'default' },
        { kind: 'ifError', clauseIndex: 0, role: 'fallback' },
      ],
    ]
  );
});

test('SaveData and LoadData retain collection, key, and fallback behavior', () => {
  assert.deepEqual(
    extractor.classifyFormulaIntents('=SaveData(col_cache, "orders-cache")')[0],
    {
      intent: 'saveData',
      collection: 'col_cache',
      name: 'orders-cache',
      key: 'orders-cache',
      sourceStatement: 'SaveData(col_cache, "orders-cache")',
      sourceStatementIndex: 0,
    }
  );
  assert.deepEqual(
    extractor.classifyFormulaIntents('=LoadData(col_cache, "orders-cache", true)')[0],
    {
      intent: 'loadData',
      collection: 'col_cache',
      name: 'orders-cache',
      key: 'orders-cache',
      ignoreNonexistentFile: 'true',
      sourceStatement: 'LoadData(col_cache, "orders-cache", true)',
      sourceStatementIndex: 0,
    }
  );
});

test('adapter redacts source connection IDs and requires target resolution', () => {
  const brief = {
    dataModel: {
      connectorInventory: [{
        name: 'Office365Users',
        apiId: '/providers/microsoft.powerapps/apis/shared_office365users',
        connectionId: 'source-tenant-connection-id',
        dataSources: [],
        actions: [{ operationId: 'UserProfileV2' }],
        screens: ['Home'],
      }],
      sharepointLists: [],
      flows: [],
      customConnectors: [],
    },
    screens: [],
  };
  const inventory = adapter.collectConnectorInventory(brief);
  assert.equal(inventory[0].connectionId, null);
  assert.equal(inventory[0].sourceConnectionPresent, true);
  const requirements = adapter.buildConnectionRequirements(brief, inventory);
  assert.equal(requirements[0].connectionId, null);
  assert.equal(requirements[0].status, 'needs-connection-id');
  assert.deepEqual(requirements[0].usedOperations, ['UserProfileV2']);

  const portableCustom = adapter.sanitizeConnectorInventoryForTarget([{
    name: 'Source Custom API',
    apiId: '/providers/Microsoft.PowerApps/apis/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    classification: 'custom',
    connectionId: 'source-custom-connection',
    dataSources: [],
  }]);
  assert.equal(portableCustom[0].apiId, null);
  assert.equal(portableCustom[0].connectionId, null);
  assert.equal(portableCustom[0].sourceApiIdPresent, true);
  const customRequirement = adapter.buildConnectionRequirements({ dataModel: { sharepointLists: [], flows: [] } }, portableCustom)[0];
  assert.equal(customRequirement.status, 'needs-api-id');
  assert.equal(customRequirement.apiId, null);

  const flowBrief = {
    dataModel: {
      connectorInventory: [],
      sharepointLists: [],
      flows: [{
        name: 'Approval Flow',
        flowId: '11111111-2222-3333-4444-555555555555',
        workflowEntityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        actions: [{ name: 'Run' }],
        screens: ['Home'],
      }],
    },
  };
  const flowRequirement = adapter.buildConnectionRequirements(flowBrief, [])[0];
  assert.equal(flowRequirement.status, 'needs-flow-id');
  assert.equal(flowRequirement.parameters.flowId, null);
  assert.equal(flowRequirement.parameters.workflowEntityId, null);
  assert.equal(flowRequirement.parameters.sourceFlowIdPresent, true);
  const flows = adapter.extractFlows(flowBrief, []);
  assert.equal(flows.flows[0].flowId, null);
  assert.equal(flows.flows[0].workflowEntityId, null);
  assert.equal(flows.flows[0].sourceFlowIdPresent, true);
  assert.deepEqual(flows.commands, []);
});

test('native execution filters screen-level intent and unavailable host packages', () => {
  const plan = adapter.buildNativeExecutionPlan(
    ['form', 'list', 'notification', 'camera', 'persistence', 'signature', 'pdf-viewer'],
    new Set(['expo-camera', 'expo-file-system'])
  );
  assert.deepEqual(plan.capabilities, ['camera', 'file-system']);
  assert.deepEqual(plan.handledSourceTags, ['camera', 'persistence']);
  assert.deepEqual(plan.sourceIntents, ['camera', 'form', 'list', 'notification', 'pdf-viewer', 'persistence', 'signature']);
});

test('PCF plan proposes safe native/server outcomes and blocks unknown controls', () => {
  const requirements = [{ id: 'office365users', connector: 'Office365Users', classification: 'action' }];
  const loadedScreens = [{
    name: 'Home',
    controls: [
      {
        name: 'SideNavigation',
        path: 'Home/SideNavigation',
        kind: 'CodeComponent',
        templateName: 'Contoso.SideNavigation',
        isPcf: true,
        properties: { Items: '=col_navigation', OnSelect: '=Navigate(ThisItem.Screen)' },
        events: { OnSelect: [{ intent: 'navigate', target: 'ThisItem.Screen' }] },
      },
      {
        name: 'PeopleLookup',
        path: 'Home/PeopleLookup',
        kind: 'CodeComponent',
        templateName: 'Contoso.PeopleLookup',
        isPcf: true,
        isPremiumPcf: true,
        properties: { Text: '=var_query', Items: '=Office365Users.SearchUser(var_query)' },
        events: {},
      },
      {
        name: 'ColorSwitchSelector',
        path: 'Home/PricingEngine',
        kind: 'CodeComponent',
        templateName: 'Contoso.PricingEngine',
        isPcf: true,
        properties: { Required: '=true' },
        events: {},
      },
    ],
  }];
  const brief = {
    app: {
      pcfControls: loadedScreens[0].controls.map((control) => ({
        screen: 'Home',
        control: control.name,
        path: control.path,
        templateName: control.templateName,
        templateId: 'source-template-guid',
        isPremiumPcf: !!control.isPremiumPcf,
        properties: control.properties,
      })),
    },
  };
  const pcfPlan = adapter.buildPcfPlan(brief, loadedScreens, requirements, new Set(['expo-router', 'tamagui']));
  assert.equal(pcfPlan.stats.total, 3);
  assert.equal(pcfPlan.stats.pendingApproval, 3);
  assert.deepEqual(pcfPlan.controls.map((row) => row.proposal.disposition), [
    'server-dependency',
    'blocker',
    'native-replacement',
  ]);
  const people = pcfPlan.controls.find((row) => row.control === 'PeopleLookup');
  assert.equal(people.isPremium, true);
  assert.equal(people.proposal.targetStrategy.dependencies[0].connectionRequirementId, 'office365users');
  assert.equal(people.proposal.targetStrategy.dependencies[0].operation, 'SearchUser');
  assert.equal(people.approval.status, 'pending');
  assert.equal(people.sourceTemplateIdPresent, true);
  assert.equal(JSON.stringify(pcfPlan).includes('source-template-guid'), false);
  const unknown = pcfPlan.controls.find((row) => row.control === 'ColorSwitchSelector');
  assert.equal(unknown.essentiality.level, 'essential');
  assert.equal(unknown.proposal.disposition, 'blocker');
  const coverage = adapter.buildControlIntentCoverage(loadedScreens);
  assert.equal(coverage.stats.pcfControls, 3);
  assert.equal(coverage.rows.filter((row) => row.flags.isPcf && row.businessRisk === 'high').length, 3);
  assert.equal(new Set(pcfPlan.controls.map((row) => row.pcfId)).size, 3);
});

test('import resets stale PCF approvals before Gate 2b', () => {
  const input = {
    pcfPlan: {
      stats: { total: 1, pendingApproval: 0, approved: 1, blocked: 0, byDisposition: { 'native-replacement': 1 } },
    },
  };
  const pcfPlan = {
    discovery: { complete: true },
    stats: { total: 1, pendingApproval: 0, approved: 1, blocked: 0, byDisposition: { 'native-replacement': 1 } },
    controls: [{
      pcfId: 'pcf-1111111111111111',
      approval: {
        status: 'approved',
        disposition: 'native-replacement',
        essentiality: 'essential',
        targetStrategy: { primitive: 'Tamagui Switch', packages: ['tamagui'] },
        reason: 'Crafted stale approval.',
        approvedBy: 'user',
        approvedAt: '2026-07-01T00:00:00.000Z',
      },
    }],
  };
  assert.equal(importer.resetPcfApprovals(input, pcfPlan), 1);
  assert.deepEqual(pcfPlan.controls[0].approval, {
    status: 'pending',
    disposition: null,
    essentiality: null,
    targetStrategy: null,
    unsupportedUx: null,
    reason: null,
    approvedBy: null,
    approvedAt: null,
  });
  assert.equal(pcfPlan.stats.pendingApproval, 1);
  assert.equal(pcfPlan.stats.approved, 0);
  assert.deepEqual(input.pcfPlan.stats, pcfPlan.stats);
});

test('native route map reserves home for the actual source start screen', () => {
  const routes = adapter.buildNativeRouteMap({
    app: { startScreen: 'Dashboard' },
    screens: [{ name: 'Home' }, { name: 'Dashboard' }, { name: 'home' }, { name: 'CON' }],
  });
  assert.equal(routes.get('Dashboard').route, '/(app)/home');
  assert.equal(routes.get('Dashboard').source, 'replace template');
  assert.equal(routes.get('Home').route, '/(app)/home-2');
  assert.equal(routes.get('home').route, '/(app)/home-3');
  assert.equal(routes.get('CON').file, 'app/(app)/screen-con.tsx');
});

test('Dataverse File/Image types and RequiredLevel override Virtual metadata', () => {
  const file = extractor.slimAttribute({
    '@odata.type': '#Microsoft.Dynamics.CRM.FileAttributeMetadata',
    AttributeType: 'Virtual',
    AttributeTypeName: { Value: 'FileType' },
    LogicalName: 'cr_document',
    SchemaName: 'cr_Document',
    RequiredLevel: { Value: 'ApplicationRequired' },
    IsValidForCreate: false,
    IsValidForUpdate: false,
    MaxSizeInKB: 32768,
  }, new Map());
  assert.equal(file.attributeType, 'File');
  assert.equal(file.isRequired, true);
  assert.equal(file.requiredLevel, 'ApplicationRequired');
  assert.equal(file.isReadOnly, false);
  assert.equal(file.writeMode, 'block-upload');
  assert.equal(file.maxSizeInKB, 32768);

  const image = extractor.slimAttribute({
    '@odata.type': '#Microsoft.Dynamics.CRM.ImageAttributeMetadata',
    AttributeType: 'Virtual',
    AttributeTypeName: { Value: 'ImageType' },
    LogicalName: 'cr_photo',
    SchemaName: 'cr_Photo',
    RequiredLevel: { Value: 'None' },
    IsValidForCreate: true,
    IsValidForUpdate: true,
    MaxHeight: 144,
    MaxWidth: 144,
  }, new Map());
  assert.equal(image.attributeType, 'Image');
  assert.equal(image.maxHeight, 144);
  assert.equal(image.maxWidth, 144);
});

test('form-bound fields survive schema slicing and consume DataCard scaffold', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msapp-adapter-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.writeFileSync(path.join(tmp, 'cr_item.json'), JSON.stringify({
    logicalName: 'cr_item',
    entitySetName: 'cr_items',
    primaryIdAttribute: 'cr_itemid',
    primaryNameAttribute: 'cr_name',
    attributes: [
      {
        logicalName: 'cr_itemid',
        schemaName: 'cr_ItemId',
        displayName: 'Item',
        attributeType: 'Uniqueidentifier',
        isPrimaryId: true,
      },
      {
        logicalName: 'cr_name',
        schemaName: 'cr_Name',
        displayName: 'Name',
        attributeType: 'String',
        isPrimaryName: true,
        maxLength: 200,
      },
      {
        logicalName: 'cr_attachment',
        schemaName: 'cr_Attachment',
        displayName: 'Attachment File',
        attributeType: 'File',
        requiredLevel: 'ApplicationRequired',
        isRequired: true,
        isReadOnly: false,
        isValidForCreate: false,
        isValidForUpdate: false,
        writeMode: 'block-upload',
        maxSizeInKB: 32768,
      },
    ],
  }));

  const brief = {
    dataModel: {
      dataverseTables: [{
        logicalName: 'cr_item',
        displayName: 'Items',
        columnsUsed: [],
        operations: ['Patch'],
        screens: ['EditItem'],
      }],
      localCollections: [],
      flows: [],
    },
    forms: [{
      screen: 'EditItem',
      formControl: 'EditItem/Form1',
      formKind: 'Form',
      dataSource: 'Items',
      table: 'cr_item',
      fields: [{
        control: 'EditItem/Form1/Attachment_DataCard1',
        dataField: 'CR_Attachment',
      }],
    }],
  };

  const tables = adapter.collectTables(brief, tmp, false);
  const attachment = tables[0].columns.find((column) => column.name === 'cr_attachment');
  assert.ok(attachment, 'form-bound column should survive the lean schema slice');
  assert.equal(attachment.type, 'file');
  assert.equal(adapter.classifyServerSideColumn(attachment), null);

  const loadedScreens = [{
    name: 'EditItem',
    controls: [
      {
        path: 'EditItem/Form1',
        kind: 'Form',
        properties: { DefaultMode: '=FormMode.New' },
      },
      {
        path: 'EditItem/Form1/Attachment_DataCard1',
        kind: 'TypedDataCard',
        template: 'TypedDataCard@1.0.7',
        properties: {
          DisplayName: '=DataSourceInfo([@Items], DataSourceInfo.DisplayName, cr_attachment)',
          Required: '=Parent.Required',
        },
        scaffold: {
          labelText: '=Parent.DisplayName',
          valueTemplate: 'attachments',
          valueDefault: null,
          valueItems: '=Parent.Default',
          valueOnChange: null,
        },
      },
    ],
  }];

  const forms = adapter.collectForms(brief, loadedScreens, tables, []);
  assert.equal(forms.length, 1);
  assert.deepEqual(
    {
      name: forms[0].fields[0].name,
      label: forms[0].fields[0].label,
      type: forms[0].fields[0].type,
      required: forms[0].fields[0].required,
      control: forms[0].fields[0].control,
    },
    {
      name: 'CR_Attachment',
      label: 'Attachment File',
      type: 'file',
      required: true,
      control: 'host:FilePicker',
    }
  );
});

test('adapter behaviors retain extractor control-flow and leaf source statement', () => {
  const formula = '=If(isReady, Patch(Orders, ThisItem, {statuscode: 1}), Notify("Not ready"))';
  const actions = extractor.classifyFormulaIntents(formula);
  const behaviors = adapter.extractBehaviors([{
    name: 'Orders',
    controls: [{
      name: 'SaveButton',
      template: 'Button@1',
      properties: { OnSelect: formula },
      events: { OnSelect: actions },
    }],
  }], { app: {} });

  assert.equal(behaviors.actions.length, 2);
  assert.deepEqual(withoutControlFlowId(behaviors.actions[0].controlFlow[0]), {
    kind: 'if', branchIndex: 0, role: 'then', condition: 'isReady',
  });
  assert.equal(behaviors.actions[0].sourceStatement, 'Patch(Orders, ThisItem, {statuscode: 1})');
  assert.match(behaviors.actions[0].behaviorId, /^b-[0-9a-f]{16}$/);
  assert.deepEqual(withoutControlFlowId(behaviors.actions[1].controlFlow[0]), { kind: 'if', role: 'else' });
  assert.equal(behaviors.actions[1].sourceStatement, 'Notify("Not ready")');
  assert.notEqual(behaviors.actions[0].behaviorId, behaviors.actions[1].behaviorId);
  const repeated = adapter.extractBehaviors([{
    name: 'Orders',
    controls: [{ name: 'SaveButton', template: 'Button@1', properties: { OnSelect: formula }, events: { OnSelect: actions } }],
  }], { app: {} });
  assert.deepEqual(repeated.actions.map((action) => action.behaviorId), behaviors.actions.map((action) => action.behaviorId));

  const duplicateNames = adapter.extractBehaviors([{
    name: 'Orders',
    controls: [
      { name: 'SaveButton', path: 'Orders/Header/SaveButton', properties: { OnSelect: formula }, events: { OnSelect: actions } },
      { name: 'SaveButton', path: 'Orders/Footer/SaveButton', properties: { OnSelect: formula }, events: { OnSelect: actions } },
    ],
  }], { app: {} });
  assert.equal(new Set(duplicateNames.actions.map((action) => action.behaviorId)).size, 4);
});

test('adapter decomposes pathological handlers into stable named workflow steps and only critical questions', () => {
  const formula = [
    '=Confirm("Submit order?")',
    'Patch(Orders, Defaults(Orders), {name: var_name})',
    'ForAll(col_lines As line, Patch(OrderLines, Defaults(OrderLines), {name: line.name}))',
    "'Approval Flow'.Run(var_orderId)",
    'Set(var_submitted, true)',
    'Refresh(Orders)',
    'Notify("Order submitted")',
    'Navigate(OrderComplete)',
  ].join('; ');
  const actions = extractor.classifyFormulaIntents(formula);
  const behaviors = adapter.extractBehaviors([{
    name: 'OrderConfirm',
    controls: [{
      name: 'ConfirmButton',
      path: 'OrderConfirm/Footer/ConfirmButton',
      properties: { OnSelect: formula },
      events: { OnSelect: actions },
    }],
  }], { app: {} });
  const screenRows = [{ name: 'OrderConfirm', file: 'app/(app)/order-confirm.tsx' }];
  const workflowPlan = adapter.buildWorkflowPlan(behaviors, screenRows);

  assert.equal(workflowPlan.$schema, 'workflow-plan-v1');
  assert.equal(workflowPlan.workflows.length, 1);
  const workflow = workflowPlan.workflows[0];
  assert.match(workflow.workflowId, /^wf-[0-9a-f]{16}$/);
  assert.deepEqual(workflow.source.behaviorIds, behaviors.actions.map((action) => action.behaviorId));
  assert.ok(workflow.detection.reasons.includes('ACTION_COUNT'));
  assert.ok(workflow.detection.reasons.includes('MULTI_SYSTEM_SIDE_EFFECTS'));
  assert.ok(workflow.detection.reasons.includes('LOOPED_MUTATION'));
  assert.equal(workflow.proposal.target.implementationOwner, 'workflow-orchestrator');
  assert.equal(workflow.proposal.target.callSiteFile, 'app/(app)/order-confirm.tsx');
  assert.match(workflow.proposal.target.module, /^src\/features\/order-confirm\/workflows\//);
  assert.equal(workflow.proposal.steps.length, 6);
  assert.deepEqual(
    workflow.proposal.steps.flatMap((step) => step.behaviorIds),
    behaviors.actions.map((action) => action.behaviorId)
  );
  const loopStep = workflow.proposal.steps.find((step) => step.controlFlowKinds.includes('forAll'));
  assert.deepEqual(withoutControlFlowId(loopStep.controlFlow[0]), { kind: 'forAll', source: 'col_lines', alias: 'line' });
  assert.deepEqual(
    workflow.requiredDecisions.map((decision) => decision.type),
    ['partial-failure-policy', 'retry-policy', 'batch-failure-policy']
  );
  assert.equal(workflow.requiredDecisions.every((decision) => decision.requiresUserInput === true), true);
  assert.equal(workflow.requiredDecisions.some((decision) => /helper|function name|spinner|color/i.test(decision.prompt)), false);
  assert.equal(workflow.approval.status, 'pending');
  assert.equal(workflowPlan.stats.mappedBehaviors, behaviors.actions.length);
  assert.equal(workflowPlan.stats.requiredDecisions, 3);
  assert.equal(workflowPlan.stats.unresolvedDecisions, 3);

  const repeated = adapter.buildWorkflowPlan(behaviors, screenRows);
  assert.deepEqual(repeated, workflowPlan);

  const unambiguousFormula = '=Set(var_a, 1); Set(var_b, 2); Set(var_c, 3); Set(var_d, 4); Set(var_e, 5); Set(var_f, 6); Set(var_g, 7); Set(var_h, 8)';
  const unambiguousBehaviors = adapter.extractBehaviors([{
    name: 'OrderConfirm',
    controls: [{
      name: 'PrepareButton',
      path: 'OrderConfirm/PrepareButton',
      properties: { OnSelect: unambiguousFormula },
      events: { OnSelect: extractor.classifyFormulaIntents(unambiguousFormula) },
    }],
  }], { app: {} });
  const unambiguous = adapter.buildWorkflowPlan(unambiguousBehaviors, screenRows);
  assert.equal(unambiguous.workflows.length, 1);
  assert.deepEqual(unambiguous.workflows[0].requiredDecisions, []);
  assert.equal(unambiguous.stats.pendingApproval, 1);
  assert.equal(unambiguous.stats.requiredDecisions, 0);

  const exclusiveFormula = '=If(var_useA, Patch(OrdersA, Defaults(OrdersA), {name: "A"}), Patch(OrdersB, Defaults(OrdersB), {name: "B"})); Set(var_a, 1); Set(var_b, 2); Set(var_c, 3); Set(var_d, 4); Set(var_e, 5); Set(var_f, 6)';
  const exclusiveBehaviors = adapter.extractBehaviors([{
    name: 'OrderConfirm',
    controls: [{
      name: 'BranchButton',
      path: 'OrderConfirm/BranchButton',
      properties: { OnSelect: exclusiveFormula },
      events: { OnSelect: extractor.classifyFormulaIntents(exclusiveFormula) },
    }],
  }], { app: {} });
  const exclusive = adapter.buildWorkflowPlan(exclusiveBehaviors, screenRows);
  assert.equal(exclusive.workflows.length, 1);
  assert.deepEqual(exclusive.workflows[0].requiredDecisions, []);

  const errorHandledFormula = '=IfError(Patch(Orders, Defaults(Orders), {name: var_name}); \'Approval Flow\'.Run(var_orderId), Notify("Submission failed")); Set(var_a, 1); Set(var_b, 2); Set(var_c, 3); Set(var_d, 4); Set(var_e, 5)';
  const errorHandledBehaviors = adapter.extractBehaviors([{
    name: 'OrderConfirm',
    controls: [{
      name: 'HandledButton',
      path: 'OrderConfirm/HandledButton',
      properties: { OnSelect: errorHandledFormula },
      events: { OnSelect: extractor.classifyFormulaIntents(errorHandledFormula) },
    }],
  }], { app: {} });
  const errorHandled = adapter.buildWorkflowPlan(errorHandledBehaviors, screenRows);
  assert.equal(errorHandled.workflows.length, 1);
  assert.deepEqual(errorHandled.workflows[0].requiredDecisions.map((decision) => decision.type), ['retry-policy']);
  assert.ok(errorHandled.workflows[0].proposal.steps.some((step) => step.controlFlow.some((frame) => frame.kind === 'ifError' && frame.role === 'fallback')));

  const ordinary = adapter.buildWorkflowPlan(adapter.extractBehaviors([{
    name: 'OrderConfirm',
    controls: [{
      name: 'CancelButton',
      path: 'OrderConfirm/CancelButton',
      properties: { OnSelect: '=Back(); Notify("Canceled")' },
      events: { OnSelect: extractor.classifyFormulaIntents('=Back(); Notify("Canceled")') },
    }],
  }], { app: {} }), screenRows);
  assert.deepEqual(ordinary.workflows, []);
});

test('workflow approval reset clears stale answers and recomputes summaries', () => {
  const workflow = {
    workflowId: 'wf-1111111111111111',
    requiredDecisions: [{ decisionId: 'wfd-1111111111111111', type: 'retry-policy' }],
    proposal: { steps: [{ stepId: 'wfs-1111111111111111', behaviorIds: ['b-1111111111111111'] }] },
    approval: {
      status: 'approved',
      approvedStepIds: ['wfs-1111111111111111'],
      decisions: [{ decisionId: 'wfd-1111111111111111', status: 'resolved', value: 'no-retry', resolvedBy: 'user', reason: 'stale' }],
      executionOwner: 'client-orchestrator',
      uxMode: 'single-action-with-progress',
      reason: 'Crafted stale approval.',
      approvedBy: 'user',
      approvedAt: '2026-07-01T00:00:00.000Z',
    },
  };
  const workflowPlan = { stats: { handlersScanned: 1 }, workflows: [workflow] };
  const input = { workflowPlan: { stats: { approved: 1 } } };
  assert.equal(importer.resetWorkflowApprovals(input, workflowPlan), 1);
  assert.deepEqual(workflow.approval, workflowPlanLib.emptyWorkflowApproval());
  assert.equal(workflowPlan.stats.pendingApproval, 1);
  assert.equal(workflowPlan.stats.approved, 0);
  assert.equal(workflowPlan.stats.unresolvedDecisions, 1);
  assert.deepEqual(input.workflowPlan.stats, workflowPlan.stats);
});

test('behavior coverage resolves kebab-case routes and requires critical actions', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-coverage-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'app', '(app)'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'behaviors.json'), JSON.stringify({
    actions: [
      { behaviorId: 'b-1111111111111111', screen: 'App', intent: 'setVar', name: 'var_ready' },
      { behaviorId: 'b-2222222222222222', screen: 'CustomerList', intent: 'navigate', target: 'CustomerDetail' },
      { behaviorId: 'b-3333333333333333', screen: 'Dashboard', intent: 'navigate', target: 'CustomerList' },
      { behaviorId: 'b-4444444444444444', screen: 'CustomerList', intent: 'flowCall', target: 'Missing Flow' },
    ],
  }));
  fs.writeFileSync(path.join(tmp, 'mobile-plugin-input.json'), JSON.stringify({
    screenPlan: {
      screens: [
        { name: 'CustomerList', file: 'app/(app)/customer-list.tsx' },
        { name: 'Dashboard', file: 'app/(app)/home.tsx' },
      ],
    },
  }));
  fs.writeFileSync(path.join(tmp, 'src', 'bootstrap.ts'), '// source-behavior: b-1111111111111111\nsetAppState({ var_ready: true });\n');
  const route = path.join(tmp, 'app', '(app)', 'customer-list.tsx');
  fs.writeFileSync(route, '// source-behavior: b-2222222222222222\n// source-unsupported: b-4444444444444444 — target flow unavailable\nexport default function CustomerList(){ router.navigate("/customer-detail"); return <Text>Approval flow unavailable</Text>; }\n');
  fs.writeFileSync(path.join(tmp, 'app', '(app)', 'home.tsx'), '// source-behavior: b-3333333333333333\nexport default function Home(){ router.navigate("/customer-list"); return null; }\n');

  const coverageScript = path.resolve(__dirname, '..', '..', 'shared', 'samples', 'scripts', 'check-behavior-coverage.js');
  const pass = spawnSync(process.execPath, [coverageScript, '--min', '80'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  assert.equal(pass.status, 0, pass.stderr || pass.stdout);
  assert.match(pass.stdout, /critical behavior accounting: PASS/);
  assert.match(pass.stdout, /explicit unsupported: 1/);

  fs.writeFileSync(route, 'export default function CustomerList(){ router.navigate("/customer-detail"); return null; }\n');
  const fail = spawnSync(process.execPath, [coverageScript, '--min', '40'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  assert.equal(fail.status, 1, fail.stderr || fail.stdout);
  assert.match(fail.stdout, /critical behavior accounting: FAIL/);
});

test('workflow coverage requires named steps, exact markers, and a real screen invocation', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-coverage-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const screenDir = path.join(tmp, 'app', '(app)');
  const moduleDir = path.join(tmp, 'src', 'features', 'order-confirm', 'workflows');
  fs.mkdirSync(screenDir, { recursive: true });
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'mobile-plugin-input.json'), JSON.stringify({
    screenPlan: { screens: [{ name: 'OrderConfirm', file: 'app/(app)/order-confirm.tsx' }] },
  }));
  fs.writeFileSync(path.join(tmp, 'behaviors.json'), JSON.stringify({
    actions: [
      { behaviorId: 'b-1111111111111111', screen: 'OrderConfirm', intent: 'patch', source: 'Orders' },
      { behaviorId: 'b-2222222222222222', screen: 'OrderConfirm', intent: 'navigate', target: 'Complete' },
    ],
  }));
  fs.writeFileSync(path.join(tmp, 'workflows.json'), JSON.stringify({
    $schema: 'workflow-plan-v1',
    workflows: [{
      workflowId: 'wf-1111111111111111',
      source: { screen: 'OrderConfirm', control: 'ConfirmButton', event: 'OnSelect' },
      proposal: {
        target: {
          module: 'src/features/order-confirm/workflows/confirm.ts',
          importPath: '@/features/order-confirm/workflows/confirm',
          exportName: 'runConfirmWorkflow',
          callSiteFile: 'app/(app)/order-confirm.tsx',
        },
        steps: [
          { stepId: 'wfs-1111111111111111', targetFunction: 'step01PersistData', behaviorIds: ['b-1111111111111111'] },
          { stepId: 'wfs-2222222222222222', targetFunction: 'step02CompleteWorkflow', behaviorIds: ['b-2222222222222222'] },
        ],
      },
      approval: { status: 'approved' },
    }],
  }));
  const modulePath = path.join(moduleDir, 'confirm.ts');
  fs.writeFileSync(modulePath, [
    '// source-workflow-step: wfs-1111111111111111',
    'async function step01PersistData() {',
    '  // source-behavior: b-1111111111111111',
    '  await OrdersService.create({ name: "Order" });',
    '}',
    '// source-workflow-step: wfs-2222222222222222',
    'async function step02CompleteWorkflow() {',
    '  // source-behavior: b-2222222222222222',
    '  router.navigate("/complete");',
    '}',
    '// source-workflow: wf-1111111111111111',
    'export async function runConfirmWorkflow() {',
    '  await step01PersistData();',
    '  await step02CompleteWorkflow();',
    '}',
    '',
  ].join('\n'));
  const screenPath = path.join(screenDir, 'order-confirm.tsx');
  fs.writeFileSync(screenPath, [
    "import { runConfirmWorkflow } from '@/features/order-confirm/workflows/confirm';",
    'export default function OrderConfirm() {',
    '  const submit = async () => {',
    '    // source-workflow-call: wf-1111111111111111',
    '    await runConfirmWorkflow();',
    '  };',
    '  return <Button onPress={submit}>Confirm</Button>;',
    '}',
    '',
  ].join('\n'));

  const workflowChecker = path.resolve(__dirname, '..', '..', 'shared', 'samples', 'scripts', 'check-workflow-coverage.js');
  const pass = spawnSync(process.execPath, [workflowChecker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr || pass.stdout);
  assert.match(pass.stdout, /implemented: 1\/1/);

  const behaviorChecker = path.resolve(__dirname, '..', '..', 'shared', 'samples', 'scripts', 'check-behavior-coverage.js');
  const behaviorPass = spawnSync(process.execPath, [behaviorChecker, '--min', '100'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(behaviorPass.status, 0, behaviorPass.stderr || behaviorPass.stdout);
  assert.match(behaviorPass.stdout, /critical behavior accounting: PASS/);

  const framedPlanPath = path.join(tmp, 'workflows.json');
  const framedPlan = JSON.parse(fs.readFileSync(framedPlanPath, 'utf8'));
  framedPlan.workflows[0].proposal.steps[0].controlFlow = [{ id: 'if-12345678', kind: 'if', role: 'then', branchIndex: 0 }];
  fs.writeFileSync(framedPlanPath, JSON.stringify(framedPlan));
  const missingFrame = spawnSync(process.execPath, [workflowChecker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(missingFrame.status, 1);
  assert.match(missingFrame.stdout + missingFrame.stderr, /lacks an exact source-control-flow marker|lack a native if condition/);
  fs.writeFileSync(modulePath, fs.readFileSync(modulePath, 'utf8').replace(
    '  await step01PersistData();',
    '  // source-control-flow: if-12345678 if then-0\n  if (shouldPersist) { await step01PersistData(); }'
  ));
  const framedPass = spawnSync(process.execPath, [workflowChecker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(framedPass.status, 0, framedPass.stderr || framedPass.stdout);

  fs.writeFileSync(screenPath, 'export default function OrderConfirm(){ return null; }\n');
  const uninvoked = spawnSync(process.execPath, [workflowChecker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(uninvoked.status, 1);
  assert.match(uninvoked.stdout + uninvoked.stderr, /lacks exact source-workflow-call marker/);

  fs.writeFileSync(screenPath, [
    "import { runConfirmWorkflow } from '@/features/order-confirm/workflows/confirm';",
    '// source-workflow-call: wf-1111111111111111',
    'runConfirmWorkflow();',
    '',
  ].join('\n'));
  fs.writeFileSync(modulePath, [
    '// source-workflow-step: wfs-1111111111111111',
    '// source-behavior: b-1111111111111111',
    '// source-workflow-step: wfs-2222222222222222',
    '// source-behavior: b-2222222222222222',
    '// source-workflow: wf-1111111111111111',
    'export async function runConfirmWorkflow() { await OrdersService.create({}); router.navigate("/complete"); }',
    '',
  ].join('\n'));
  const monolithic = spawnSync(process.execPath, [workflowChecker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(monolithic.status, 1);
  assert.match(monolithic.stdout + monolithic.stderr, /lacks named function/);
});

test('PCF coverage requires approved implementation markers and visible unsupported UX', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-coverage-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const screenDir = path.join(tmp, 'app', '(app)');
  fs.mkdirSync(screenDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'mobile-plugin-input.json'), JSON.stringify({
    screenPlan: { screens: [{ name: 'Home', file: 'app/(app)/home.tsx' }] },
  }));
  fs.writeFileSync(path.join(tmp, 'pcf-plan.json'), JSON.stringify({
    controls: [
      {
        pcfId: 'pcf-1111111111111111',
        screen: 'Home',
        approval: { status: 'approved', disposition: 'native-replacement' },
      },
      {
        pcfId: 'pcf-2222222222222222',
        screen: 'Home',
        approval: { status: 'approved', disposition: 'explicit-unsupported' },
      },
    ],
  }));
  const screenPath = path.join(screenDir, 'home.tsx');
  fs.writeFileSync(screenPath, [
    '// source-pcf: pcf-1111111111111111 native-replacement',
    'const replacement = <Switch />;',
    '// source-pcf-unsupported: pcf-2222222222222222 — optional 3D viewer unavailable',
    'const fallback = <Text>3D preview is unavailable on mobile</Text>;',
    'export default function Home(){ return <>{replacement}{fallback}</>; }',
    '',
  ].join('\n'));
  const checker = path.resolve(__dirname, '..', '..', 'shared', 'samples', 'scripts', 'check-pcf-coverage.js');
  const pass = spawnSync(process.execPath, [checker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr || pass.stdout);
  assert.match(pass.stdout, /implemented: 1 .* explicit unsupported: 1/);

  fs.writeFileSync(screenPath, [
    '// source-pcf: pcf-1111111111111111',
    'const replacement = <Switch />;',
    '// source-pcf-unsupported: pcf-2222222222222222 — optional 3D viewer unavailable',
    'const fallback = <Text>3D preview is unavailable on mobile</Text>;',
    'export default function Home(){ return <>{replacement}{fallback}</>; }',
    '',
  ].join('\n'));
  const missingDisposition = spawnSync(process.execPath, [checker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(missingDisposition.status, 1);
  assert.match(missingDisposition.stdout, /lacks exact source-pcf ID\/disposition marker/);

  fs.writeFileSync(screenPath, [
    '// source-pcf: pcf-1111111111111111 native-replacement',
    'const replacement = <Switch />;',
    '// source-pcf-unsupported: pcf-2222222222222222 — optional viewer unavailable',
    '// This unavailable feature is intentionally not rendered.',
    'export default function Home(){ return replacement; }',
    '',
  ].join('\n'));
  const commentOnly = spawnSync(process.execPath, [checker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(commentOnly.status, 1);
  assert.match(commentOnly.stdout, /lacks marker plus visible unavailable UX/);

  fs.writeFileSync(screenPath, 'export default function Home(){ return null; }\n');
  const fail = spawnSync(process.execPath, [checker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /lacks exact source-pcf ID\/disposition marker|lacks marker plus visible unavailable UX/);

  fs.writeFileSync(path.join(tmp, 'pcf-plan.json'), JSON.stringify({ discovery: { complete: false }, controls: [] }));
  const incomplete = spawnSync(process.execPath, [checker, '--strict'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /PCF discovery is incomplete/);
});

test('asset binding safely quotes source filenames and resolves name collisions', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-binding-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const imagesDir = path.join(tmp, 'assets', 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const hostileFile = "odd');globalThis.injected=true;.png";
  fs.writeFileSync(path.join(imagesDir, hostileFile), 'not-a-real-png');
  fs.writeFileSync(path.join(tmp, 'assets.json'), JSON.stringify({
    images: [
      { name: 'Logo primary', fileName: hostileFile },
      { name: 'Logo-primary', fileName: hostileFile },
    ],
  }));

  const generator = path.resolve(__dirname, '..', '..', 'shared', 'samples', 'scripts', 'generate-asset-binding.js');
  const result = spawnSync(process.execPath, [generator], { cwd: tmp, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const generated = fs.readFileSync(path.join(tmp, 'src', 'generated', 'assets.ts'), 'utf8');
  assert.match(generated, /"Logo_primary": require\("\.\.\/\.\.\/assets\/images\/odd'\);globalThis\.injected=true;\.png"\)/);
  assert.match(generated, /"Logo_primary_2": require/);
  assert.equal((generated.match(/globalThis\.injected=true/g) || []).length, 2);
});

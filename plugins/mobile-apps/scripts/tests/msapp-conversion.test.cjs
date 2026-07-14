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
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).name, 'fresh-template');
  assert.ok(fs.existsSync(path.join(target, 'native-app-plan.md')));
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

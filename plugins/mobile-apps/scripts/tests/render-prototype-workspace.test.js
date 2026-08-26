'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildWorkspaceModel, renderWorkspace, writeWorkspace } = require('../render-prototype-workspace');

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-workspace-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['.tmp', '.mobile-app', 'brand', 'app/(app)', 'src/generated']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'brief.md'), 'Build <script>alert("no")</script> a useful product.');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture-app"}\n');
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), [
    '# Fixture - Native App Plan',
    '## Native Capabilities',
    '| Capability | Used by screens |',
    '| --- | --- |',
    '| camera | Capture |',
    '## Connectors',
    'None',
    '## Screens',
    '### Navigation Pattern',
    '**Tabs + Stack** - durable destinations.',
    '### Screen Map',
    '| Screen | Route | File | Purpose | Native |',
    '| --- | --- | --- | --- | --- |',
    '| Home | /(app)/home | app/(app)/home.tsx | See current work | - |',
    '| Capture | /(app)/capture | app/(app)/capture.tsx | Capture evidence | camera |',
    '| Profile | /(app)/profile | app/(app)/profile.tsx | User context | - |',
  ].join('\n'));
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), JSON.stringify({ audience: 'employee', primaryJob: 'Complete current work.', confidence: 'high', entryMode: 'overview', navigationModel: 'tabs-stack', assumptions: [], signatureMotifs: ['priority-callout'], visualCharacter: 'confident-utility' }));
  fs.writeFileSync(path.join(root, '.tmp', 'dataverse-schema-contract.json'), JSON.stringify({ tables: [{ displayName: 'Task', logicalName: 'cr_task', columns: [{ logicalName: 'name' }], relationships: [] }] }));
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-status.json'), '{"status":"approved"}');
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-validation-manifest.json'), '{"phases":{"final":{"status":"passed","fingerprint":"abc","validatedAt":"2026-08-26T00:00:00.000Z"}}}');
  fs.writeFileSync(path.join(root, '.mobile-app', 'metro-session.json'), JSON.stringify({ schemaVersion: 1, status: 'ready', port: 8081, url: 'exp+fixture://ready', command: 'npx expo start --port 8081', terminalId: 'terminal-1' }));
  fs.writeFileSync(path.join(root, 'src', 'generated', '.prototype-manifest.json'), '{"tables":["cr_task"]}');
  fs.writeFileSync(path.join(root, 'brand', 'design-system.md'), '# Design');
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), 'export const tokens = {};');
  fs.writeFileSync(path.join(root, 'app', '(app)', 'home.tsx'), 'export default null;');
  return root;
}

test('workspace derives progress, screens, data, capabilities, validation, and Metro state', (context) => {
  const root = fixture(context);
  const model = buildWorkspaceModel(root);
  assert.equal(model.title, 'Fixture');
  assert.equal(model.experience.navigation, 'tabs-stack');
  assert.equal(model.screens.find((screen) => screen.id === 'Home').status, 'built');
  assert.equal(model.screens.find((screen) => screen.id === 'Capture').nativeIntent, 'camera');
  assert.deepEqual(model.dataModel, [{ name: 'Task', logicalName: 'cr_task', fields: 1, relationships: 0 }]);
  assert.equal(model.capabilities[0].Capability, 'camera');
  assert.equal(model.validation.final, 'passed');
  assert.equal(model.metro.status, 'ready');
});

test('workspace HTML is self-contained, editable, responsive, and script-safe', (context) => {
  const root = fixture(context);
  const html = renderWorkspace(buildWorkspaceModel(root));
  assert.match(html, /id="export-review"/);
  assert.match(html, /id="export-status" role="status" aria-live="polite"/);
  assert.match(html, /id="review-payload" hidden/);
  assert.match(html, /id="review-json" readonly/);
  assert.match(html, /document\.body\.append\(link\)/);
  assert.match(html, /id="data-model"/);
  assert.match(html, /@media \(max-width:620px\)/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /Not native UX evidence/);
  assert.match(html, /\.split > \* \{ min-width:0; \}/);
  assert.match(html, /\.pill\.complete/);
  assert.doesNotMatch(html, /\n    \.complete,\.built/);
  assert.doesNotMatch(html, /<script>alert\("no"\)<\/script>/);
  assert.match(html, /\\u003cscript\\u003ealert/);
});

test('workspace writer stays inside the project and replaces its output atomically', (context) => {
  const root = fixture(context);
  const output = writeWorkspace(root);
  assert.equal(output, path.join(root, '_prototype_workspace.html'));
  assert.equal(fs.existsSync(output), true);
  assert.equal(fs.readdirSync(root).some((entry) => entry.includes('.tmp-')), false);
  assert.throws(() => writeWorkspace(root, '../outside.html'), /inside the project root/);
});
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeProject, renderReport } = require('../generate-mobile-trust-report');

test('trust report detects capabilities without exposing auth values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-trust-'));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'generated', 'services'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'capture.tsx'), "import { CameraView } from 'expo-camera';\n");
  fs.writeFileSync(path.join(root, 'src', 'generated', 'services', 'OrdersService.ts'), 'export class OrdersService {}');
  fs.writeFileSync(path.join(root, 'auth.config.json'), JSON.stringify({ msal: { clientId: 'secret-client-id' } }));
  fs.writeFileSync(path.join(root, 'offline-profile.json'), JSON.stringify({ tables: [{ logicalName: 'order' }] }));

  const report = analyzeProject(root, '## Native Capabilities\nCamera\n## Connectors\nDataverse');
  const html = renderReport(report);
  assert.strictEqual(report.capabilities.find((item) => item.id === 'camera').state, 'used');
  assert.strictEqual(report.offline.tableCount, 1);
  assert.strictEqual(report.authenticationConfigured, true);
  assert.match(html, /Purposeful access/);
  assert.match(html, /Camera \/ barcode capture/);
  assert.doesNotMatch(html, /secret-client-id/);
});

test('trust report flags direct network and background evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-trust-network-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'worker.ts'), "TaskManager.defineTask('sync', () => fetch('https://example.com'));\n");
  const report = analyzeProject(root);
  assert.deepStrictEqual(report.backgroundEvidence, ['src/worker.ts']);
  assert.deepStrictEqual(report.directNetworkEvidence, ['src/worker.ts']);
  assert.match(renderReport(report), /Verify every endpoint and data boundary/);
});

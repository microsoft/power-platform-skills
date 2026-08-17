'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeLaunch, renderLaunchPage, safeLaunchUrl } = require('../generate-mobile-launch-page');

test('launch page presents readiness without exposing client ID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-launch-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'field-app' }));
  fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({ environmentId: 'env-123' }));
  fs.writeFileSync(path.join(root, 'auth.config.json'), JSON.stringify({
    msal: { clientId: 'private-client-id' },
    environment: { environmentUrl: 'https://example.crm.dynamics.com' },
  }));
  const model = analyzeLaunch(root, {
    metroUrl: 'exp+field-app://expo-development-client/?url=http%3A%2F%2F10.0.0.2%3A8081',
    terminalId: 'metro-1',
  });
  const html = renderLaunchPage(model);
  assert.strictEqual(model.authenticationConfigured, true);
  assert.strictEqual(model.metroRunning, true);
  assert.match(html, /Run field-app on your phone/);
  assert.match(html, /Authentication ready/);
  assert.doesNotMatch(html, /private-client-id/);
});

test('launch page rejects unsafe launch URLs and shows setup issues', () => {
  assert.strictEqual(safeLaunchUrl('javascript:alert(1)'), '');
  const html = renderLaunchPage({
    appName: 'Test',
    appSlug: 'test',
    environmentId: '',
    environmentUrl: '',
    authenticationConfigured: false,
    metroRunning: false,
    metroUrl: '',
    terminalId: '',
    qrData: '',
    qrFile: '',
    planUrl: '',
    trustUrl: '',
    generatedAt: '2026-08-17T00:00:00.000Z',
  });
  assert.match(html, /Setup required/);
  assert.match(html, /Authentication client ID is not configured/);
  assert.match(html, /QR image is unavailable/);
});

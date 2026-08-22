#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BLOCK_START = '<!-- PROTOTYPE CAPABILITY WARNINGS START - managed by check-prototype-capabilities.js -->';
const BLOCK_END = '<!-- PROTOTYPE CAPABILITY WARNINGS END -->';

const CAPABILITIES = [
  {
    key: 'raw-printer',
    label: 'Raw barcode/label printing',
    pattern: /\b(?:zpl|thermal printer|label printer|bluetooth print|raw print(?:ing)?)\b/i,
    packages: ['expo-print'],
    route: '/add-native pdf-report',
    partial: 'PDF generation and the OS print dialog are available; raw ZPL/Bluetooth printer transport is not in the template allowlist.',
  },
  { key: 'barcode', label: 'Barcode/QR scanning', pattern: /\b(?:barcodes?|bar codes?|qr codes?|qr scanner|scan(?:ning)? (?:codes?|skus?))\b/i, packages: ['expo-camera'], route: '/add-native barcode-scanner' },
  { key: 'camera', label: 'Camera/photo capture', pattern: /\b(?:camera|take photos?|capture photos?|photo evidence)\b/i, packages: ['expo-camera'], route: '/add-native camera' },
  { key: 'image-picker', label: 'Image/gallery picker', pattern: /\b(?:image picker|pick images?|photo library|gallery)\b/i, packages: ['expo-image-picker'], route: '/add-native image-picker' },
  { key: 'pdf-report', label: 'PDF report generation', pattern: /\b(?:pdf report|pdf export|generate (?:a )?pdf|print reports?)\b/i, packages: ['expo-print'], optionalPackages: ['expo-sharing'], route: '/add-native pdf-report' },
  { key: 'pdf-viewer', label: 'Native PDF viewing', pattern: /\b(?:view|open|preview) (?:an? )?pdf\b/i, packages: ['@microsoft/power-apps-native-pdf-viewer'], route: '/add-native pdf-viewer' },
  { key: 'signature', label: 'Signature/pen capture', pattern: /\b(?:signature|sign-off|pen input|ink capture|handwritten)\b/i, packages: ['@microsoft/power-apps-native-pen-input'], route: '/add-native pen-input' },
  { key: 'background-location', label: 'Background GPS tracking', pattern: /\b(?:background|continuous|live) (?:gps|location|geolocation)|\btrack(?:ing)? location\b/i, packages: ['@microsoft/power-apps-native-bglocation'], route: '/add-native geolocation' },
  { key: 'location', label: 'Foreground location', pattern: /\b(?:current location|one-time location|foreground gps|location fix)\b/i, packages: ['expo-location'], route: '/add-native location' },
  { key: 'document-picker', label: 'Document/file picker', pattern: /\b(?:document picker|file picker|pick (?:a )?(?:document|file)|upload (?:a )?(?:document|file))\b/i, packages: ['expo-document-picker'], route: '/add-native document-picker' },
  { key: 'sharing', label: 'Native share sheet', pattern: /\b(?:share sheet|native sharing|share (?:a )?(?:file|report|document))\b/i, packages: ['expo-sharing'], route: '/add-native sharing' },
  { key: 'secure-store', label: 'Secure local storage', pattern: /\b(?:secure storage|secure store|keychain|keystore)\b/i, packages: ['expo-secure-store'], route: '/add-native secure-store' },
  { key: 'biometrics', label: 'Biometric authentication', pattern: /\b(?:biometric|face id|touch id|fingerprint)\b/i, packages: ['expo-local-authentication'], route: '/add-native biometrics' },
  { key: 'bluetooth', label: 'Bluetooth/BLE', pattern: /\b(?:bluetooth|ble)\b/i, packages: [], route: null, unavailable: 'Bluetooth/BLE is not in the template allowlist.' },
  { key: 'nfc', label: 'NFC', pattern: /\bnfc\b|near-field communication/i, packages: [], route: null, unavailable: 'NFC is not in the template allowlist.' },
  { key: 'push', label: 'Push notifications', pattern: /\bpush notifications?\b/i, packages: ['expo-notifications'], route: '/add-native push' },
];

function dependencies(packageJson) {
  return { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
}

function assess(brief, packageJson) {
  const installed = dependencies(packageJson);
  const rawPrinterRequested = CAPABILITIES[0].pattern.test(brief);
  const rows = [];
  for (const capability of CAPABILITIES) {
    if (!capability.pattern.test(brief)) continue;
    if (capability.key === 'pdf-report' && rawPrinterRequested && !/\b(?:pdf report|pdf export|generate (?:a )?pdf|print reports?)\b/i.test(brief)) continue;
    const present = capability.packages.filter((name) => installed[name]);
    const missing = capability.packages.filter((name) => !installed[name]);
    let status = 'AVAILABLE';
    let resolution;
    if (capability.partial) {
      status = present.length === capability.packages.length ? 'PARTIAL' : 'UNAVAILABLE';
      resolution = status === 'PARTIAL' ? capability.partial : `Missing ${missing.join(', ')}; ${capability.partial}`;
    } else if (capability.unavailable || capability.packages.length === 0) {
      status = 'UNAVAILABLE';
      resolution = capability.unavailable || 'No matching template package is allowlisted.';
    } else if (missing.length > 0) {
      status = 'UNAVAILABLE';
      resolution = `Missing template package ${missing.join(', ')}; do not install native code.`;
    } else {
      const versions = present.map((name) => `${name} ${installed[name]}`).join(' + ');
      const optional = (capability.optionalPackages || []).filter((name) => installed[name]);
      resolution = `${versions}${optional.length ? ` + ${optional.map((name) => `${name} ${installed[name]}`).join(' + ')}` : ''} -> ${capability.route}`;
    }
    rows.push({ capability: capability.label, key: capability.key, status, resolution, route: capability.route });
  }
  return { schemaVersion: 1, rows };
}

function table(report) {
  if (report.rows.length === 0) return 'Capability check: no native device capabilities detected.\n';
  const lines = ['Capability check', '| Capability | Status | Resolution |', '|---|---|---|'];
  for (const row of report.rows) {
    lines.push(`| ${row.capability} | ${row.status} | ${row.resolution.replace(/\|/g, '\\|')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function warningBlock(report) {
  const warnings = report.rows.filter((row) => row.status !== 'AVAILABLE');
  if (warnings.length === 0) return '';
  return `${BLOCK_START}\n### Capability Warnings\n\n| Requested capability | Status | Resolution |\n|---|---|---|\n${warnings.map((row) => `| ${row.capability} | ${row.status} | ${row.resolution.replace(/\|/g, '\\|')} |`).join('\n')}\n${BLOCK_END}`;
}

function persist(planPath, report) {
  const source = fs.readFileSync(planPath, 'utf8');
  const withoutManaged = source.replace(new RegExp(`\\n?${BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g'), '\n');
  const block = warningBlock(report);
  if (!block) {
    fs.writeFileSync(planPath, withoutManaged);
    return 0;
  }
  const heading = /^## Native Capabilities\s*$/m.exec(withoutManaged);
  if (!heading) throw new Error('native-app-plan.md is missing ## Native Capabilities');
  const bodyStart = heading.index + heading[0].length;
  const remainder = withoutManaged.slice(bodyStart);
  const next = remainder.search(/^##\s+/m);
  const end = next < 0 ? withoutManaged.length : bodyStart + next;
  const updated = `${withoutManaged.slice(0, end).trimEnd()}\n\n${block}\n\n${withoutManaged.slice(end).replace(/^\s*/, '')}`;
  fs.writeFileSync(planPath, updated);
  return report.rows.filter((row) => row.status !== 'AVAILABLE').length;
}

function run(projectDir, { persistPlan = false } = {}) {
  const root = path.resolve(projectDir);
  const briefPath = path.join(root, 'brief.md');
  const packagePath = path.join(root, 'package.json');
  const reportPath = path.join(root, '.tmp', 'prototype-capability-check.json');
  if (!fs.existsSync(briefPath)) throw new Error('brief.md is required');
  if (!fs.existsSync(packagePath)) throw new Error('package.json is required');
  const report = assess(fs.readFileSync(briefPath, 'utf8'), JSON.parse(fs.readFileSync(packagePath, 'utf8')));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const persisted = persistPlan ? persist(path.join(root, 'native-app-plan.md'), report) : 0;
  return { report, reportPath, persisted };
}

function main() {
  const projectDir = process.argv[2];
  if (!projectDir) throw new Error('usage: node check-prototype-capabilities.js <project-dir> [--persist]');
  const result = run(projectDir, { persistPlan: process.argv.includes('--persist') });
  process.stdout.write(table(result.report));
  if (process.argv.includes('--persist')) process.stdout.write(`Capability warnings persisted: ${result.persisted}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`prototype-capabilities: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { BLOCK_END, BLOCK_START, CAPABILITIES, assess, persist, run, table, warningBlock };
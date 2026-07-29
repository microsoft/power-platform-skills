'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { localizePreviewImages, parseArgs, renderTemplateImportStatus } = require('../render-template-import-status');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'template-import-status-test-'));
}

test('parseArgs accepts import status page inputs', () => {
  assert.deepEqual(parseArgs([
    '--templateName', 'Supplier Portal',
    '--statusPath', '/tmp/status.json',
    '--outputPath', '/tmp/import.html',
    '--previewImagesJson', '["file:///tmp/a.png"]',
    '--open',
  ]), {
    templateName: 'Supplier Portal',
    statusPath: '/tmp/status.json',
    outputPath: '/tmp/import.html',
    previewImages: ['file:///tmp/a.png'],
    open: true,
  });
});

test('renderTemplateImportStatus renders scaffold-style slideshow, progress, and toast status UI', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'import.html');
  const statusPath = path.join(dir, 'status.json');

  const result = renderTemplateImportStatus({
    templateName: 'Supplier Portal',
    statusPath,
    outputPath,
    previewImages: ['file:///tmp/a.png', 'file:///tmp/b.png'],
  });
  const html = fs.readFileSync(outputPath, 'utf8');

  assert.deepEqual(result, { status: 'ok', output: outputPath, statusPath });
  assert.match(html, /Importing Supplier Portal template/);
  assert.equal(html.includes('file:///tmp/a.png'), true);
  assert.equal(html.includes('const STATUS_URL = "status.json"'), true);
  assert.match(html, /loading-wrapper/);
  assert.match(html, /ambient/);
  assert.match(html, /grid-overlay/);
  assert.match(html, /orbit-system/);
  assert.match(html, /core-shape/);
  assert.match(html, /preview-showcase/);
  assert.match(html, /previewFrame/);
  assert.match(html, /preview-track/);
  assert.match(html, /preview-card/);
  assert.match(html, /previewPrev/);
  assert.match(html, /previewNext/);
  assert.match(html, /previewPaused/);
  assert.match(html, /mouseenter/);
  assert.match(html, /translateX/);
  assert.match(html, /Enterprise-grade security/);
  assert.match(html, /Lightning-fast performance/);
  assert.match(html, /Ready to scale globally/);
  assert.match(html, /progressFill/);
  assert.match(html, /scaleX/);
  assert.match(html, /progressFromStatus/);
  assert.match(html, /status\.progress/);
  assert.match(html, /status\.percentComplete/);
  assert.match(html, /--progress-scale/);
  assert.match(html, /setInterval\(pollStatus, 30000\)/);
  assert.match(html, /Template import complete/);
  assert.match(html, /Template import needs attention/);
});

test('localizePreviewImages copies local preview images beside the served page', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'preview.png');
  const outputPath = path.join(dir, 'site', 'import.html');
  fs.writeFileSync(sourcePath, 'fake image bytes');

  const localized = localizePreviewImages([sourcePath], outputPath);

  assert.deepEqual(localized, ['preview-images/preview-01.png']);
  assert.equal(
    fs.readFileSync(path.join(dir, 'site', 'preview-images', 'preview-01.png'), 'utf8'),
    'fake image bytes'
  );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, renderTemplateImportStatus } = require('../render-template-import-status');

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

test('renderTemplateImportStatus renders slideshow, progress, and toast status UI', (t) => {
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
  assert.match(html, /progressFill/);
  assert.match(html, /scaleX/);
  assert.match(html, /Template import complete/);
  assert.match(html, /Template import needs attention/);
});

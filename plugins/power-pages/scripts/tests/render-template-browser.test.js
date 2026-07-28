'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  renderTemplateBrowser,
} = require('../render-template-browser');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'template-browser-test-'));
}

test('parseArgs accepts templates JSON, output path, and open switch', () => {
  assert.deepEqual(parseArgs([
    '--templatesJsonPath', '/tmp/templates.json',
    '--outputPath', '/tmp/browser.html',
    '--open',
  ]), {
    templatesJsonPath: '/tmp/templates.json',
    outputPath: '/tmp/browser.html',
    open: true,
  });
});

test('renderTemplateBrowser renders static template details and preview images', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'templates.json');
  const outputPath = path.join(dir, 'browser.html');
  fs.writeFileSync(dataPath, JSON.stringify({
    TEMPLATES_JSON: [
      {
        displayName: 'Company "Portal"',
        description: 'Internal site',
        framework: 'react',
        audience: ['makers', 'developers'],
        keywords: ['portal', 'directory'],
        previewImages: [
          'https://raw.githubusercontent.com/o/r/sha/templates/spa/company/previews/home.png',
          'https://raw.githubusercontent.com/o/r/sha/templates/spa/company/previews/detail.png',
        ],
      },
      {
        displayName: '311 Portal',
        description: 'Citizen service request portal',
        framework: 'react',
        audience: ['makers'],
        keywords: ['311'],
        previewImages: [
          'https://raw.githubusercontent.com/o/r/sha/templates/spa/311/previews/home.png',
        ],
      },
    ],
  }));

  const result = renderTemplateBrowser({ templatesJsonPath: dataPath, outputPath, open: false });
  const html = fs.readFileSync(outputPath, 'utf8');

  assert.deepEqual(result, { status: 'ok', output: outputPath, opened: false });
  assert.match(html, /Browse Power Pages templates/);
  assert.match(html, /Company &quot;Portal&quot;/);
  assert.match(html, /311 Portal/);
  assert.match(html, /home\.png/);
  assert.match(html, /detail\.png/);
  assert.match(html, /data-carousel/);
  assert.match(html, /data-carousel-next/);
  assert.match(html, /1 of 2/);
  assert.match(html, /Preview 2 of Company &quot;Portal&quot;/);
  assert.match(html, /Citizen service request portal/);
  assert.doesNotMatch(html, /Audience/);
  assert.doesNotMatch(html, /makers/);
  assert.doesNotMatch(html, /developers/);
  assert.doesNotMatch(html, /picker/i);
  assert.doesNotMatch(html, /templates\.map/);
});

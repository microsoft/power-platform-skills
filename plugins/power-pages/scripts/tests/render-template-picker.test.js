'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  openFileInDefaultBrowser,
  renderTemplatePicker,
} = require('../render-template-picker');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'template-picker-test-'));
}

test('parseArgs accepts templates JSON, output path, and open switch', () => {
  assert.deepEqual(parseArgs([
    '--templatesJsonPath', '/tmp/templates.json',
    '--outputPath', '/tmp/picker.html',
    '--open',
  ]), {
    templatesJsonPath: '/tmp/templates.json',
    outputPath: '/tmp/picker.html',
    open: true,
  });
});

test('openFileInDefaultBrowser uses platform-specific default-browser commands', () => {
  const calls = [];
  const execFileSync = (...args) => calls.push(args);

  openFileInDefaultBrowser('/tmp/picker.html', { os: { platform: () => 'darwin' }, execFileSync });
  openFileInDefaultBrowser('C:\\tmp\\picker.html', { os: { platform: () => 'win32' }, execFileSync });
  openFileInDefaultBrowser('/tmp/picker.html', { os: { platform: () => 'linux' }, execFileSync });

  assert.deepEqual(calls, [
    ['open', ['/tmp/picker.html'], { stdio: 'ignore' }],
    ['cmd', ['/c', 'start', '', 'C:\\tmp\\picker.html'], { stdio: 'ignore', windowsHide: true }],
    ['xdg-open', ['/tmp/picker.html'], { stdio: 'ignore' }],
  ]);
});

test('renderTemplatePicker renders all preview images and can skip opening', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'templates.json');
  const outputPath = path.join(dir, 'picker.html');
  fs.writeFileSync(dataPath, JSON.stringify({
    TEMPLATES_JSON: [
      {
        displayName: 'Company Portal',
        description: 'Internal site',
        framework: 'react',
        audience: 'internal',
        keywords: ['portal', 'directory'],
        previewImages: [
          'https://raw.githubusercontent.com/o/r/sha/templates/spa/company/previews/home.png',
          'https://raw.githubusercontent.com/o/r/sha/templates/spa/company/previews/detail.png',
        ],
      },
    ],
  }));

  const result = renderTemplatePicker({ templatesJsonPath: dataPath, outputPath, open: false });
  const html = fs.readFileSync(outputPath, 'utf8');

  assert.deepEqual(result, { status: 'ok', output: outputPath, opened: false });
  assert.match(html, /Company Portal/);
  assert.match(html, /home\.png/);
  assert.match(html, /detail\.png/);
  assert.match(html, /images\.map/);
  assert.match(html, /Preview \$\{index \+ 1\}/);
});

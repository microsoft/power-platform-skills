'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const {
  buildModel,
  localizePreviewImages,
  parseArgs,
  renderTemplateImportStatus,
} = require('../render-template-import-status');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'template-import-status-test-'));
}

test('parseArgs accepts import status page inputs', () => {
  assert.deepEqual(parseArgs([
    '--templateName', 'Supplier Portal',
    '--templateDescription', 'Manage supplier requests.',
    '--statusPath', '/tmp/status.json',
    '--outputPath', '/tmp/import.html',
    '--previewImagesJson', '["file:///tmp/a.png"]',
    '--solutionCount', '2',
    '--open',
  ]), {
    templateName: 'Supplier Portal',
    templateDescription: 'Manage supplier requests.',
    statusPath: '/tmp/status.json',
    outputPath: '/tmp/import.html',
    previewImages: ['file:///tmp/a.png'],
    solutionCount: 2,
    open: true,
  });
});

test('renderTemplateImportStatus renders the shared SPA and non-SPA provisioning UI', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'import.html');
  const statusPath = path.join(dir, 'status.json');

  const result = renderTemplateImportStatus({
    templateName: 'Supplier Portal',
    statusPath,
    outputPath,
    previewImages: ['file:///tmp/a.png', 'file:///tmp/b.png'],
    solutionCount: 2,
  });
  const html = fs.readFileSync(outputPath, 'utf8');

  assert.deepEqual(result, { status: 'ok', output: outputPath, statusPath });
  assert.match(html, /class="shell"/);
  assert.match(html, /Your selected SPA template/);
  assert.match(html, /"templateCategory":"SPA"/);
  assert.equal(html.includes('file:///tmp/a.png'), true);
  assert.match(html, /"statusFeed":\{"url":"status\.json","intervalMs":1500\}/);
  assert.match(html, /preview-card/);
  assert.match(html, /Install supporting solutions/);
  assert.match(html, /Create SPA site/);
  assert.match(html, /Apply seed data/);
  assert.match(html, /Activate site/);
  assert.match(html, /pollStatusFeed/);
  assert.match(html, /Open website/);
  assert.match(html, /Template site is ready/);
  assert.match(html, /Template setup needs attention/);
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
    .replace(/&#39;/g, "'");
  assert.match(policy, /img-src 'self' data:/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'nonce-[^']+'/);
  assert.doesNotMatch(html, /window\.location\.assign/);
  assert.doesNotMatch(html, /Git baseline/);
});

test('renderTemplateImportStatus uses singular solution copy for one solution', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'import.html');
  const statusPath = path.join(dir, 'status.json');

  renderTemplateImportStatus({
    templateName: '311 Portal',
    statusPath,
    outputPath,
    solutionCount: 1,
  });
  const html = fs.readFileSync(outputPath, 'utf8');

  assert.match(html, /Install supporting solution/);
  assert.doesNotMatch(html, /Install supporting solutions/);
});

test('renderTemplateImportStatus rejects invalid solution counts', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () => renderTemplateImportStatus({
      templateName: '311 Portal',
      statusPath: path.join(dir, 'status.json'),
      outputPath: path.join(dir, 'import.html'),
      solutionCount: 0,
    }),
    /positive integer/
  );
});

test('renderTemplateImportStatus does not print the shared renderTemplate status line', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'import.html');
  const statusPath = path.join(dir, 'status.json');
  const originalLog = console.log;
  const logs = [];
  console.log = (value) => logs.push(value);
  t.after(() => { console.log = originalLog; });

  renderTemplateImportStatus({ templateName: 'Supplier Portal', statusPath, outputPath });

  assert.deepEqual(logs, []);
});

test('localizePreviewImages copies local preview images beside the served page', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'preview.png');
  const outputPath = path.join(dir, 'site', 'import.html');
  const imageBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('fake png payload'),
  ]);
  fs.writeFileSync(sourcePath, imageBytes);

  const localized = localizePreviewImages([sourcePath], outputPath);

  assert.deepEqual(localized, ['preview-images/preview-01.png']);
  assert.deepEqual(
    fs.readFileSync(path.join(dir, 'site', 'preview-images', 'preview-01.png')),
    imageBytes
  );
});

test('localizePreviewImages rejects non-images, directories, and symlinks', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'site', 'import.html');
  const textPath = path.join(dir, 'secret.txt');
  const fakePngPath = path.join(dir, 'fake.png');
  const imagePath = path.join(dir, 'preview.png');
  const imageLink = path.join(dir, 'preview-link.png');
  fs.writeFileSync(textPath, 'secret');
  fs.writeFileSync(fakePngPath, 'not a png');
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const inputs = [textPath, fakePngPath, dir];
  try {
    fs.symlinkSync(imagePath, imageLink);
    inputs.push(imageLink);
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
  }

  assert.deepEqual(
    localizePreviewImages(inputs, outputPath),
    []
  );
});

test('buildModel uses an Open website result instead of automatic redirect metadata', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = buildModel({
    templateName: 'Supplier Portal',
    statusPath: path.join(dir, 'status.json'),
    outputPath: path.join(dir, 'status.html'),
    previewImages: [],
    solutionCount: 1,
  });

  assert.equal(model.presentation.templateCategory, 'SPA');
  assert.equal(model.presentation.allowRefreshPause, false);
  assert.equal(model.presentation.showPreviewNotice, false);
  assert.equal(model.statusFeed.url, 'status.json');
  assert.equal(model.status.openWebsiteUrl, null);
  assert.deepEqual(model.timeline.map(([title]) => title), [
    'Install supporting solution',
    'Create SPA site',
    'Apply seed data',
    'Activate site',
  ]);
});

function runStatusPage(html, saved = {}) {
  const elements = new Map();
  function element(id) {
    return {
      dataset: {},
      listeners: {},
      classList: { toggle() {} },
      setAttribute() {},
      replaceChildren() {},
      append() {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      remove() { elements.delete(id); },
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, element(id));
  let polls = 0;
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
      },
      createElement: () => element(),
      querySelectorAll: () => [],
    },
    location: { pathname: '/import.html' },
    sessionStorage: {
      getItem: () => JSON.stringify(saved),
      setItem() {},
    },
    window: {
      clearTimeout() {},
      clearInterval() {},
      setTimeout() {},
      setInterval() {},
    },
    fetch: async () => {
      polls++;
      return { ok: true, json: async () => ({ phase: 'solutions', state: 'working' }) };
    },
  });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context);
  return { elements, context, polls: () => polls };
}

test('template heading groups the category pill and keeps preview images unobstructed', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'import.html');
  renderTemplateImportStatus({
    templateName: '311 Portal',
    statusPath: path.join(dir, 'status.json'),
    outputPath,
    previewImages: ['https://example.com/home.png'],
  });
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.doesNotMatch(html, /preview-label|previewLabel/);
  assert.match(html, /<div class="template-heading">\s*<h1 id="templateDisplayName"><\/h1>\s*<span class="template-category" id="templateCategory">Non-SPA<\/span>\s*<\/div>/);
  const page = runStatusPage(html);
  assert.equal(page.elements.get('previewImage').src, 'https://example.com/home.png');
  assert.equal(page.elements.get('previewImage').alt, 'desktop preview of 311 Portal: home.png');
  assert.equal(page.elements.has('previewLabel'), false);
});

test('SPA import removes the pause button and ignores a previously saved pause', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'import.html');
  renderTemplateImportStatus({
    templateName: 'Supplier Portal',
    statusPath: path.join(dir, 'status.json'),
    outputPath,
  });
  const page = runStatusPage(fs.readFileSync(outputPath, 'utf8'), { autoRefreshPaused: true });
  assert.equal(page.elements.has('refreshToggle'), false);
  assert.equal(page.elements.has('previewNoticeBanner'), false);
  await vm.runInContext('pollStatusFeed()', page.context);
  assert.equal(page.polls(), 2);
  assert.match(page.elements.get('refreshNote').textContent, /updates automatically/);
});

test('shared status UI retains the pause control when the presentation does not disable it', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = buildModel({
    templateName: 'Supplier Portal',
    statusPath: path.join(dir, 'status.json'),
    outputPath: path.join(dir, 'import.html'),
    previewImages: [],
    solutionCount: 1,
  });
  delete model.presentation.allowRefreshPause;
  model.statusFeed = null;
  model.refresh = true;
  const template = fs.readFileSync(path.join(
    __dirname, '..', '..', 'skills', 'create-site', 'assets', 'non-spa-creation-status-template.html',
  ), 'utf8');
  const page = runStatusPage(template.replace('__JSON_MODEL__', JSON.stringify(model)), { autoRefreshPaused: true });
  const button = page.elements.get('refreshToggle');
  assert.equal(button.textContent, 'Resume auto-refresh');
  button.listeners.click();
  assert.equal(button.textContent, 'Pause auto-refresh');
});

test('SPA previews retain original filenames after localization and filtering', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = path.join(__dirname, '..', '..', 'skills', 'create-site', 'assets', 'shared', 'power-pages-icon.png');
  const source = path.join(dir, 'Home page.png');
  fs.copyFileSync(image, source);
  const invalid = path.join(dir, 'invalid.png');
  fs.writeFileSync(invalid, 'not a PNG');
  const model = buildModel({
    templateName: 'Supplier Portal',
    templateDescription: 'Track requests and manage supplier accounts.',
    statusPath: path.join(dir, 'status.json'),
    outputPath: path.join(dir, 'import.html'),
    previewImages: [invalid, source, 'https://example.com/previews/Service%20requests.png?version=1'],
    solutionCount: 1,
  });
  assert.deepEqual(model.template.previews.map(({ displayName }) => displayName), [
    'Home page.png', 'Service requests.png',
  ]);
  assert.equal(model.template.previews[0].desktop, 'preview-images/preview-02.png');
  assert.equal(model.template.description, 'Track requests and manage supplier accounts.');
});

test('SPA image policy allows only the supplied remote preview origins', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'import.html');
  renderTemplateImportStatus({
    templateName: 'Supplier Portal',
    statusPath: path.join(dir, 'status.json'),
    outputPath,
    previewImages: ['https://images.example.com/Home.png', 'https://images.example.com/Requests.png'],
  });
  const html = fs.readFileSync(outputPath, 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
    .replace(/&#39;/g, "'");
  assert.match(policy, /img-src 'self' data: https:\/\/images\.example\.com;/);
  assert.match(policy, /connect-src 'self';/);
});

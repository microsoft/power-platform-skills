'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  renderTemplateBrowser,
  validateRenderedTemplateBrowser,
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
  assert.match(html, /Company "Portal"/);
  assert.match(html, /311 Portal/);
  assert.match(html, /home\.png/);
  assert.match(html, /detail\.png/);
  assert.match(html, /data-tab="template-1"/);
  assert.match(html, /data-tab="template-2"/);
  assert.match(html, /class="template-section active" id="template-1"/);
  assert.match(html, /class="template-section" id="template-2"/);
  assert.match(html, /class="preview-boundary"/);
  assert.match(html, /<figcaption>Preview 2<\/figcaption>/);
  assert.match(html, /class="preview-image"/);
  assert.match(html, /Preview 2 of Company "Portal"/);
  assert.match(html, /Citizen service request portal/);
  assert.doesNotMatch(html, /data-carousel/);
  assert.doesNotMatch(html, /carousel/);
  assert.doesNotMatch(html, /Audience/);
  assert.doesNotMatch(html, /makers/);
  assert.doesNotMatch(html, /developers/);
  assert.doesNotMatch(html, /picker/i);
  assert.doesNotMatch(html, /templates\.map/);
});

test('renderTemplateBrowser does not print the shared renderTemplate status line', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'templates.json');
  const outputPath = path.join(dir, 'browser.html');
  fs.writeFileSync(dataPath, JSON.stringify({
    TEMPLATES_JSON: [
      { displayName: 'Company Portal', description: 'Internal site', framework: 'react', previewImages: [] },
    ],
  }));
  const originalLog = console.log;
  const logs = [];
  console.log = (value) => logs.push(value);
  t.after(() => { console.log = originalLog; });

  renderTemplateBrowser({ templatesJsonPath: dataPath, outputPath, open: false });

  assert.deepEqual(logs, []);
});

test('renderTemplateBrowser renders one family with read-only framework variants', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'families.json');
  const outputPath = path.join(dir, 'browser.html');
  fs.writeFileSync(dataPath, JSON.stringify({
    TEMPLATES_JSON: [
      {
        id: 'supplier-portal',
        displayName: 'Supplier Portal',
        description: 'Supplier invoice portal',
        kind: 'spa',
        keywords: ['supplier', 'invoice'],
        previewImages: ['https://raw.githubusercontent.com/o/r/sha/templates/spa/supplier/previews/home.png'],
        variants: [
          { variantId: 'supplier-portal/react', variantKey: 'react', framework: 'react', templateVersion: '1.0.0' },
          { variantId: 'supplier-portal/vue', variantKey: 'vue', framework: 'vue', templateVersion: '1.0.1' },
        ],
      },
    ],
  }));

  const result = renderTemplateBrowser({ templatesJsonPath: dataPath, outputPath, open: false });
  const html = fs.readFileSync(outputPath, 'utf8');

  assert.deepEqual(result, { status: 'ok', output: outputPath, opened: false });
  assert.match(html, /Supplier Portal/);
  assert.match(html, /supplier invoice portal/i);
  assert.match(html, /React/);
  assert.match(html, /Vue/);
  assert.match(html, /Available frameworks/);
  assert.match(html, /data-tab="template-1"/);
  assert.doesNotMatch(html, /data-tab="template-2"/);
});

test('renderTemplateBrowser accepts raw nested variant maps from the manifest', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'families-raw.json');
  const outputPath = path.join(dir, 'browser.html');
  fs.writeFileSync(dataPath, JSON.stringify({
    TEMPLATES_JSON: [
      {
        id: 'supplier-portal',
        displayName: 'Supplier Portal',
        description: 'Supplier invoice portal',
        kind: 'spa',
        keywords: ['supplier'],
        previewImages: [],
        variants: {
          react: { templateVersion: '1.0.0', solutionPath: 'variants/react/solution.zip' },
          vue: { templateVersion: '1.0.0', solutionPath: 'variants/vue/solution.zip' },
        },
      },
    ],
  }));

  renderTemplateBrowser({ templatesJsonPath: dataPath, outputPath, open: false });
  const html = fs.readFileSync(outputPath, 'utf8');

  assert.match(html, /Available frameworks/);
  assert.match(html, /React/);
  assert.match(html, /Vue/);
  // Regression: the hero summary label must also read the object-map variants,
  // not just the "Available frameworks" chip row. Multiple variants collapse to
  // a count in the hero.
  assert.match(html, /template-framework">2 frameworks</);
});

test('renderTemplateBrowser shows a single object-map variant in the hero label', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'families-single.json');
  const outputPath = path.join(dir, 'browser.html');
  fs.writeFileSync(dataPath, JSON.stringify({
    TEMPLATES_JSON: [
      {
        id: '311-portal',
        displayName: '311 Portal',
        description: 'Citizen service requests',
        kind: 'spa',
        keywords: ['311'],
        previewImages: [],
        variants: {
          react: { templateVersion: '1.0.0.1', solutionPath: 'variants/react/solution.zip' },
        },
      },
    ],
  }));

  renderTemplateBrowser({ templatesJsonPath: dataPath, outputPath, open: false });
  const html = fs.readFileSync(outputPath, 'utf8');

  // Regression for the empty hero label: a single-variant object map must render
  // the framework name (not an empty string) in the hero.
  assert.match(html, /template-framework">React</);
});

test('renderTemplateBrowser reports opener failures without failing render', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'templates.json');
  const outputPath = path.join(dir, 'browser.html');
  fs.writeFileSync(dataPath, JSON.stringify({
    TEMPLATES_JSON: [{
      displayName: 'Company Portal',
      description: 'Internal site',
      framework: 'react',
      keywords: ['portal'],
      previewImages: [],
    }],
  }));

  const result = renderTemplateBrowser({
    templatesJsonPath: dataPath,
    outputPath,
    open: true,
  }, {
    execFileSync: () => { throw new Error('no opener'); },
  });

  assert.deepEqual(result, { status: 'ok', output: outputPath, opened: false, openError: 'no opener' });
  assert.equal(fs.existsSync(outputPath), true);
});

test('renderTemplateBrowser refuses to open an empty template browser', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'templates.json');
  const outputPath = path.join(dir, 'browser.html');
  fs.writeFileSync(dataPath, JSON.stringify({ TEMPLATES_JSON: [] }));

  const result = renderTemplateBrowser({ templatesJsonPath: dataPath, outputPath, open: true }, {
    execFileSync: () => { throw new Error('should not open invalid browser'); },
  });

  assert.equal(result.status, 'invalid');
  assert.equal(result.opened, false);
  assert.match(result.validation.errors.join('\n'), /must contain at least one template family/);
  assert.match(result.validation.errors.join('\n'), /empty-state/);
});

test('validateRenderedTemplateBrowser catches missing framework labels', () => {
  const result = validateRenderedTemplateBrowser({
    templates: [{ displayName: 'Supplier Portal', variants: { react: {}, vue: {} } }],
    html: '<h2>Supplier Portal</h2><span>React</span>',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /missing framework Vue/);
});

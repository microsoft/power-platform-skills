const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(
  __dirname, '..', '..', 'skills', 'migrate-webapi-selectall', 'scripts', 'render-migration-report.js'
);

const attack = '<img src=x onerror="globalThis.pwned=1"> \' "</script><script>globalThis.pwned=2</script>';

function baseData(overrides = {}) {
  return Object.assign({
    REPORT_STATUS: 'Complete',
    SCOPE_NOTE: 'Reviewed 1 configuration scope and 4 source call sites.',
    WILDCARD_DATA: [],
    EXPLICIT_DATA: [],
  }, overrides);
}

function render(data) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-report-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'migration-report.html');
  fs.writeFileSync(dataPath, JSON.stringify(data), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { html: fs.readFileSync(outputPath, 'utf8'), outputPath, dataPath };
}

class FakeElement {
  constructor() {
    this.innerHTML = '';
    this.textContent = '';
  }
}

// Runs the inline renderer against a stub DOM.
function executeInlineRenderer(html) {
  const inline = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(inline, 'expected an inline report renderer');

  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };

  const fakeWindow = { scrollTo() {}, matchMedia: () => ({ matches: false }) };
  vm.runInNewContext(inline[1], { document, console, window: fakeWindow });
  return elements;
}

test('render-migration-report keeps hostile setting and column values inert', () => {
  const { html } = render(baseData({
    WILDCARD_DATA: [{
      setting: attack,
      status: 'Migrated',
      usages: [{ location: attack, detail: attack }],
      fields: [attack, 'new_name'],
      finding: attack,
      fix: attack,
    }],
    EXPLICIT_DATA: [{
      setting: 'Webapi/contact/fields',
      status: 'Overbroad',
      usages: [{ location: 'sitesetting.yml:12', detail: attack }],
      fields: [attack],
      finding: attack,
      fix: attack,
    }],
  }));

  const elements = executeInlineRenderer(html);
  const rendered = elements.get('wildcardList').innerHTML + elements.get('explicitList').innerHTML;
  assert.doesNotMatch(rendered, /<img\b|<script\b|onclick=/i);
  assert.match(rendered, /&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/);
});

test('render-migration-report counts resolved and blocked wildcards by status', () => {
  const { html } = render(baseData({
    WILDCARD_DATA: [
      { setting: 'Webapi/a/fields', status: 'Migrated', fields: ['a_name'] },
      { setting: 'Webapi/b/fields', status: 'Removed', fields: [] },
      { setting: 'Webapi/c/fields', status: 'Blocked', fields: [] },
      { setting: 'Webapi/d/fields', status: 'Pending', fields: [] },
    ],
    EXPLICIT_DATA: [{ setting: 'Webapi/e/fields', status: 'Least privilege', fields: ['e_name'] }],
  }));

  const elements = executeInlineRenderer(html);
  const stats = [...elements.get('statsGrid').innerHTML.matchAll(/stat-num[^>]*>(\d+)</g)].map(m => m[1]);
  // Found, resolved (Migrated + Removed), blocked, explicit.
  assert.deepEqual(stats, ['4', '2', '1', '1']);
  assert.equal(elements.get('badgeWildcard').textContent, 4);
  assert.equal(elements.get('badgeExplicit').textContent, 1);
});

test('render-migration-report omits zero-valued stat cards', () => {
  const { html } = render(baseData({
    WILDCARD_DATA: [{ setting: 'Webapi/a/fields', status: 'Migrated', fields: ['a_name'] }],
  }));

  const elements = executeInlineRenderer(html);
  const labels = [...elements.get('statsGrid').innerHTML.matchAll(/stat-label">([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(labels, ['Wildcards Found', 'Wildcards Resolved']);
});

test('render-migration-report renders empty-state cards instead of entries', () => {
  const { html } = render(baseData());

  const elements = executeInlineRenderer(html);
  for (const id of ['wildcardList', 'explicitList']) {
    assert.match(elements.get(id).innerHTML, /class="card empty-note"/);
    assert.doesNotMatch(elements.get(id).innerHTML, /mig-table/);
  }
});

test('render-migration-report pairs each summary row with a hidden detail row', () => {
  const { html } = render(baseData({
    WILDCARD_DATA: [{
      setting: 'Webapi/account/fields',
      status: 'Migrated',
      usages: [{ location: 'src/a.js:4', detail: 'list view' }, { location: 'src/b.js:9', detail: 'detail view' }],
      fields: ['name', 'accountnumber', 'telephone1'],
    }],
  }));

  const rendered = executeInlineRenderer(html).get('wildcardList').innerHTML;
  const controls = rendered.match(/aria-controls="([^"]+)"/)[1];
  assert.match(rendered, new RegExp(`<tr class="row-detail" id="${controls}" hidden>`));
  assert.match(rendered, /aria-expanded="false"/);
  // Counts summarise the hidden detail row.
  assert.match(rendered, /<td class="col-num">2<\/td><td class="col-num">3<\/td>/);
});

test('render-migration-report stamps a human-readable UTC generated time', () => {
  const { html } = render(baseData());

  // Renderer supplies the stamp, not the caller.
  assert.match(html, /Generated [A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2}\s?[AP]M UTC/);
});

test('render-migration-report fails with no arguments', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test('render-migration-report answers --help before requiring flags', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.ok(result.stdout);
});

test('render-migration-report fails when a required key is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-report-'));
  const dataPath = path.join(tempDir, 'data.json');
  const data = baseData();
  delete data.WILDCARD_DATA;
  fs.writeFileSync(dataPath, JSON.stringify(data), 'utf8');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', path.join(tempDir, 'report.html'), '--data', dataPath],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required keys/);
  assert.match(result.stderr, /WILDCARD_DATA/);
});

test('render-migration-report refuses to overwrite an existing report', () => {
  const { outputPath, dataPath } = render(baseData());
  const original = fs.readFileSync(outputPath, 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Output file already exists/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), original);
});

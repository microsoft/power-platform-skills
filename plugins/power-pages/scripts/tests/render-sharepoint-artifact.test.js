const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateArtifact, renderArtifact, readArtifact } = require('../render-sharepoint-artifact');

const script = path.join(__dirname, '..', 'render-sharepoint-artifact.js');
const kinds = ['requirements', 'discovery', 'plan', 'sharing', 'progress'];
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture(artifact = 'requirements') {
  return {
    version: 1, artifact, title: 'Portal report', updatedAt: '2026-09-16T14:00:00Z', phase: 'Phase 2',
    links: kinds.map((kind) => ({ artifact: kind, label: kind, href: `sharepoint-${kind}.html` })),
    summary: 'A local working record.',
    sections: [{
      id: 'decisions', title: 'Decisions',
      blocks: [
        { type: 'heading', text: 'Audience' },
        { type: 'paragraph', content: [{ kind: 'strong', text: 'Authenticated partners' }] },
        { type: 'list', items: ['Read-only access', [{ kind: 'code', text: 'new_article' }]] },
        { type: 'table', columns: ['Decision', 'Status'], rows: [['Audience', [{ kind: 'badge', text: 'Approved', tone: 'success' }]]] },
        { type: 'callout', tone: 'info', blocks: [{ type: 'paragraph', content: 'Source access is not publication consent.' }] },
        { type: 'code', text: 'Example only' },
      ],
    }],
  };
}

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharepoint-artifact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('every artifact uses the same branded, offline report template and round-trips its data', (t) => {
  const dir = directory(t);
  for (const kind of kinds) {
    const data = fixture(kind);
    const result = renderArtifact({ outputPath: path.join(dir, `${kind}.html`), data });
    const html = fs.readFileSync(result.output, 'utf8');
    assert.match(html, /class="topbar"/);
    assert.match(html, /class="sidebar"/);
    assert.match(html, /class="logo" src="data:image\/png;base64,/);
    assert.match(html, /--accent:#0078d4/);
    assert.match(html, /id="record-nav"/);
    assert.match(html, /id="section-nav"/);
    assert.match(html, /@media\(max-width:640px\)/);
    assert.match(html, /@media print/);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/i);
    assert.deepEqual(readArtifact(result.output), { data, sha256: result.sha256, integrity: 'valid' });
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), kinds.map((kind) => `${kind}.html`).sort());
});

test('record text remains data in both HTML text and embedded script contexts', (t) => {
  const dir = directory(t);
  const data = fixture();
  const unusual = '</script><p>Not markup</p> & "quoted" \u2028 text';
  data.title = unusual;
  data.sections[0].blocks[1].content = unusual;
  const result = renderArtifact({ outputPath: path.join(dir, 'report.html'), data });
  const html = fs.readFileSync(result.output, 'utf8');
  assert.match(html, /<title>&lt;\/script&gt;&lt;p&gt;Not markup&lt;\/p&gt;/);
  assert.doesNotMatch(html, /<\/script><p>Not markup/);
  assert.match(html, /\\u003c\/script\\u003e/);
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
  assert.deepEqual(readArtifact(result.output).data, data);
});

test('reader content is present in static HTML rather than hidden behind an index', (t) => {
  const data = fixture();
  data.sections[0].blocks.push({
    type: 'facts',
    items: [{ label: 'Next action', value: 'Confirm the source account before retrying discovery.' }],
  });
  data.sections.push({
    id: 'history', title: 'Earlier intake', detail: true,
    blocks: [{ type: 'paragraph', content: 'Historical evidence is retained.' }],
  });
  const result = renderArtifact({ outputPath: path.join(directory(t), 'report.html'), data });
  const html = fs.readFileSync(result.output, 'utf8');
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1];
  assert.match(main, /<p class="lead rich">A local working record\.<\/p>/);
  assert.match(main, /<dt>Next action<\/dt>/);
  assert.match(main, /<dd class="rich">Confirm the source account/);
  assert.match(main, /Authenticated partners/);
  assert.match(main, /<details class="supporting-record"[^>]*>/);
  assert.match(main, /Historical evidence is retained/);
  assert.doesNotMatch(main, /\bhidden\b|Read section|overview-grid/);
  assert.match(html, /href="#decisions"/);
  assert.match(main, /data-label="Decision"/);
});

test('summary-less records can be read, but must be improved before regeneration', (t) => {
  const outputPath = path.join(directory(t), 'legacy-model.html');
  const data = fixture();
  delete data.summary;
  const body = `<!doctype html><script id="sharepoint-report-data" type="application/json">${JSON.stringify(data)}</script>\n`;
  fs.writeFileSync(outputPath, `${body}<!-- power-pages-sharepoint-report-sha256:${digest(body)} -->\n`);
  const current = readArtifact(outputPath);
  assert.equal(current.integrity, 'valid');
  assert.equal(current.data.summary, undefined);
  assert.throws(() => renderArtifact({ outputPath, data, expectedSha256: current.sha256 }), /reader-facing summary/);
  data.summary = 'An authenticated partner portal is planned. Source discovery is pending; confirm read access next.';
  renderArtifact({ outputPath, data, expectedSha256: current.sha256 });
  assert.equal(readArtifact(outputPath).data.summary, data.summary);
});

test('updates require the current fingerprint and preserve the prior report on conflict', (t) => {
  const outputPath = path.join(directory(t), 'report.html');
  const data = fixture();
  const first = renderArtifact({ outputPath, data });
  const original = fs.readFileSync(outputPath, 'utf8');
  assert.throws(() => renderArtifact({ outputPath, data }), /already exists/);
  assert.throws(() => renderArtifact({ outputPath, data, expectedSha256: '0'.repeat(64) }), /changed since/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), original);
  data.sections[0].blocks.push({ type: 'paragraph', content: 'A newly recorded answer.' });
  const second = renderArtifact({ outputPath, data, expectedSha256: first.sha256 });
  assert.notEqual(second.sha256, first.sha256);
  assert.deepEqual(readArtifact(outputPath).data, data);
  assert.throws(() => renderArtifact({ outputPath, data, expectedSha256: first.sha256 }), /changed since/);
});

test('manual edits are visible to readers and block automatic regeneration', (t) => {
  const outputPath = path.join(directory(t), 'report.html');
  renderArtifact({ outputPath, data: fixture() });
  const edited = fs.readFileSync(outputPath, 'utf8').replace('<title>Portal report</title>', '<title>Edited title</title>');
  fs.writeFileSync(outputPath, edited);
  const read = readArtifact(outputPath);
  assert.equal(read.integrity, 'modified-or-unmanaged');
  assert.throws(() => renderArtifact({ outputPath, data: read.data, expectedSha256: read.sha256 }), /manual edits/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), edited);
  read.data.title = 'Edited title';
  renderArtifact({ outputPath, data: read.data, expectedSha256: read.sha256, allowUnmanaged: true });
  assert.equal(readArtifact(outputPath).data.title, 'Edited title');
});

test('legacy HTML can be adopted only with its exact fingerprint and explicit permission', (t) => {
  const outputPath = path.join(directory(t), 'legacy.html');
  const html = '<!doctype html><title>Legacy notes</title><p>Preserve this text.</p>';
  fs.writeFileSync(outputPath, html);
  assert.throws(() => readArtifact(outputPath), /no managed data/);
  assert.throws(() => renderArtifact({ outputPath, data: fixture(), expectedSha256: digest(html) }), /unmanaged/);
  const data = fixture();
  data.summary = 'Preserve this text.';
  renderArtifact({ outputPath, data, expectedSha256: digest(html), allowUnmanaged: true });
  assert.equal(readArtifact(outputPath).data.summary, 'Preserve this text.');
});

test('invalid structured data fails before creating output', (t) => {
  const outputPath = path.join(directory(t), 'report.html');
  const mutations = [
    (data) => { data.version = 2; },
    (data) => { data.artifact = 'unknown'; },
    (data) => { data.title = ''; },
    (data) => { data.summary = '   '; },
    (data) => { data.unknownContent = 'would be silently dropped'; },
    (data) => { data.links.pop(); },
    (data) => { data.links[1].artifact = data.links[0].artifact; },
    (data) => { data.links[0].href = '../elsewhere.html'; },
    (data) => { data.links[0].href = 'https://contoso.com/report.html'; },
    (data) => { data.sections[0].id = 'overview'; },
    (data) => { data.sections[0].detail = 'yes'; },
    (data) => { data.sections.push(data.sections[0]); },
    (data) => { data.sections[0].blocks = [{ type: 'html', content: '<p>Raw</p>' }]; },
    (data) => { data.sections[0].blocks = [{ type: 'paragraph', content: [{ kind: 'link', text: 'Link', href: 'javascript:void(0)' }] }]; },
    (data) => { data.sections[0].blocks = [{ type: 'paragraph', content: [{ kind: 'link', text: 'Link', href: '../private.html' }] }]; },
    (data) => { data.sections[0].blocks = [{ type: 'paragraph', content: [{ kind: 'badge', text: 'Bad', tone: 'custom' }] }]; },
    (data) => { data.sections[0].blocks = [{ type: 'table', columns: ['One'], rows: [['A', 'B']] }]; },
    (data) => { data.sections[0].blocks = [{ type: 'facts', items: [{ label: '', value: 'Unknown' }] }]; },
    (data) => { data.sections[0].blocks = [{ type: 'facts', items: [{ label: 'Source', value: true }] }]; },
  ];
  for (const mutate of mutations) {
    const data = fixture();
    mutate(data);
    assert.throws(() => renderArtifact({ outputPath, data }));
    assert.equal(fs.existsSync(outputPath), false);
  }
});

test('valid rich links and empty tables are accepted', () => {
  const data = fixture();
  data.sections[0].blocks = [
    { type: 'paragraph', content: [{ kind: 'link', text: 'Learn', href: 'https://learn.microsoft.com/' }] },
    { type: 'paragraph', content: [{ kind: 'link', text: 'Implementation plan', href: 'create-site-plan.html' }] },
    { type: 'table', columns: ['Decision'], rows: [], emptyMessage: 'Not started.' },
  ];
  assert.equal(validateArtifact(data), data);
});

test('output path and missing replacement checks fail closed', (t) => {
  const dir = directory(t);
  assert.throws(() => renderArtifact({ outputPath: dir, data: fixture() }), /end in .html/);
  assert.throws(() => renderArtifact({ outputPath: path.join(dir, 'missing.html'), data: fixture(), expectedSha256: '0'.repeat(64) }), /output is missing/);
  const outputPath = path.join(dir, 'folder.html');
  fs.mkdirSync(outputPath);
  assert.throws(() => renderArtifact({ outputPath, data: fixture() }), /regular file/);
});

test('symbolic-link outputs are refused without touching their target', { skip: process.platform === 'win32' }, (t) => {
  const dir = directory(t);
  const target = path.join(dir, 'target.html');
  const outputPath = path.join(dir, 'link.html');
  fs.writeFileSync(target, 'Keep this file');
  fs.symlinkSync(target, outputPath);
  assert.throws(() => renderArtifact({ outputPath, data: fixture() }), /regular file/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Keep this file');
});

test('CLI writes one final status line and reads the embedded model', (t) => {
  const dir = directory(t);
  const outputPath = path.join(dir, 'report.html');
  const dataPath = path.join(dir, 'input.json');
  fs.writeFileSync(dataPath, JSON.stringify(fixture()));
  const write = spawnSync(process.execPath, [script, '--output', outputPath, '--data', dataPath], { encoding: 'utf8' });
  assert.equal(write.status, 0, write.stderr);
  assert.equal(write.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(write.stdout).output, outputPath);
  const read = spawnSync(process.execPath, [script, '--mode', 'read', '--output', outputPath], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout).data, fixture());
});

test('CLI supports stdin without printing the report contents in write mode', (t) => {
  const outputPath = path.join(directory(t), 'stdin.html');
  const result = spawnSync(process.execPath, [script, '--output', outputPath, '--data', '-'], {
    input: JSON.stringify(fixture()), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Authenticated partners/);
  assert.equal(readArtifact(outputPath).integrity, 'valid');
});

test('CLI reports invalid options and input with a nonzero exit', (t) => {
  const outputPath = path.join(directory(t), 'report.html');
  for (const args of [
    [], ['--output'], ['--other', 'value'], ['--mode', 'unknown', '--output', outputPath],
    ['--output', outputPath, '--output', outputPath], ['--output', outputPath, '--data', '-'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { input: 'invalid JSON', encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SharePoint report:/);
    assert.equal(fs.existsSync(outputPath), false);
  }
});

test('invalid JSON diagnostics do not quote report content', (t) => {
  const outputPath = path.join(directory(t), 'report.html');
  const result = spawnSync(process.execPath, [script, '--output', outputPath, '--data', '-'], {
    input: 'private-report-value-not-json', encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /input is not valid JSON/);
  assert.doesNotMatch(result.stderr, /private-report-value/);
});

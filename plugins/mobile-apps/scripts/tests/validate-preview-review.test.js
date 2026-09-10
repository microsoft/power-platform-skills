'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validatePreviewReview } = require('../validate-preview-review');
const { writeProvenance } = require('../preview-provenance');

const cli = path.resolve(__dirname, '../validate-preview-review.js');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function symlink(t, target, link, type = 'file') {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('This Windows account cannot create symlinks');
      return false;
    }
    throw error;
  }
}

function fixture(t, mode = 'intent') {
  const base = path.join(__dirname, `.preview-review-${crypto.randomUUID()}`);
  const root = path.join(base, 'project');
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (file, bytes) => fs.writeFileSync(path.join(root, file), bytes);
  write('plan.md', '# Fixture source\n');
  write('preview.html', '<!doctype html><html><body><main>Fixture only</main></body></html>\n');
  write('screen.png', png);
  const stamp = (overrides = {}) => writeProvenance({
    projectRoot: root, preview: 'preview.html', mode, scope: 'full-screens', sources: ['plan.md'], ...overrides,
  });
  stamp();
  const options = {
    projectRoot: root, preview: 'preview.html', reviewPath: 'review.json', expectedMode: mode,
    screenIds: ['home'], viewports: [{ width: 390, height: 844 }], themes: ['light'], requiredSources: ['plan.md'],
  };
  // These are evidence-record fixtures, not claims that a browser or native app was run.
  const entry = (overrides = {}) => ({
    previewSha256: digest(fs.readFileSync(path.join(root, 'preview.html'))),
    screenId: 'home', viewport: { width: 390, height: 844 }, theme: 'light', state: 'initial',
    renderedViewport: { ...(overrides.viewport || { width: 390, height: 844 }) },
    status: 'pass', observation: 'The heading and primary button are visible without overlap.',
    interaction: 'Clicked Continue normally, then pressed Tab; the next panel opened and focus moved to Back.',
    screenshots: [{ kind: 'file', path: 'screen.png', sha256: digest(png) }], ...overrides,
  });
  const review = (observations = [entry()], overrides = {}) => {
    write('review.json', JSON.stringify({
      version: 1, previewSha256: digest(fs.readFileSync(path.join(root, 'preview.html'))), observations, ...overrides,
    }));
  };
  review();
  const validate = (overrides = {}) => validatePreviewReview({ ...options, ...overrides });
  const baseArgs = ['--project-root', root, '--preview', 'preview.html', '--mode', mode];
  const reviewArgs = [...baseArgs, '--review', 'review.json', '--screen-id', 'home', '--viewport', '390x844', '--theme', 'light'];
  const run = (args = reviewArgs) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  return { base, root, write, stamp, options, entry, review, validate, baseArgs, reviewArgs, run };
}

test('complete means declared evidence covers the exact screen × viewport × theme matrix', t => {
  const f = fixture(t);
  const screenIds = ['home', 'detail'];
  const viewports = [{ width: 390, height: 844 }, { width: 820, height: 1180 }];
  const themes = ['light', 'dark'];
  f.review(screenIds.flatMap(screenId => viewports.flatMap(viewport => themes.map(theme => f.entry({ screenId, viewport, theme })))));
  const result = f.validate({ screenIds, viewports, themes });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.coverage, { required: 8, observed: 8, passed: 8, failed: 0, unverified: 0, incomplete: 0, missing: 0 });
  assert.match(result.limitations.join(' '), /declared evidence.*freshness only/);
  assert.match(result.limitations.join(' '), /not aesthetic quality, semantic accuracy, approval or native execution/);
  assert.match(result.limitations.join(' '), /not decoded or visually judged/);
  const child = f.run([
    ...f.reviewArgs, '--screen-id', 'detail', '--viewport', '820x1180', '--theme', 'dark',
    '--require-source', 'plan.md',
  ]);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).coverage.passed, 8);
});

test('missing required cases and an empty graph-like evidence record are incomplete', t => {
  const f = fixture(t);
  let result = f.validate({ screenIds: ['home', 'detail'] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.coverage.missing, 1);
  assert.match(result.reasons.join(' '), /Missing observation case.*detail/);
  f.review([], { nodes: [{ id: 'home', approved: true }], edges: [], status: 'complete' });
  result = f.validate();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.coverage.observed, 0);
  assert.equal(result.coverage.missing, 1);
});

test('pass requires screenshot, observation and actual-step declarations, not empty assertions', t => {
  const f = fixture(t);
  for (const [field, value] of [
    ['screenshots', []], ['screenshots', undefined],
    ['interaction', ' \n'], ['interaction', undefined],
    ['observation', ''], ['observation', undefined],
    ['previewSha256', undefined], ['renderedViewport', undefined],
  ]) {
    f.review([f.entry({ [field]: value })]);
    const result = f.validate();
    assert.equal(result.status, 'incomplete', field);
    assert.equal(result.coverage.passed, 0);
    assert.equal(result.coverage.incomplete, 1);
    assert.match(result.reasons.join(' '), /missing/);
  }
});

test('restamping the review cannot make older or mixed-version observations current', t => {
  const f = fixture(t);
  const previous = f.entry();
  f.write('preview.html', '<html><body>A different selected record</body></html>');
  f.stamp();
  f.review([previous]);
  let result = f.validate();
  assert.equal(result.status, 'stale');
  assert.equal(result.coverage.passed, 0);
  assert.match(result.reasons.join(' '), /Observation preview byte hash differs/);
  assert.equal(f.run().status, 2);

  f.review([f.entry(), { ...previous, screenId: 'detail' }]);
  result = f.validate({ screenIds: ['home', 'detail'] });
  assert.equal(result.status, 'stale');
  assert.equal(result.coverage.passed, 1);
  assert.match(result.reasons.join(' '), /detail/);

  f.review();
  assert.equal(f.validate().status, 'complete');
});

test('declared viewport cannot substitute for measured app-frame dimensions', t => {
  const f = fixture(t);
  for (const renderedViewport of [
    { width: 284, height: 844 }, { width: 390, height: 740 }, { width: 1800, height: 1100 },
  ]) {
    f.review([f.entry({ renderedViewport })]);
    const result = f.validate();
    assert.equal(result.status, 'incomplete');
    assert.equal(result.coverage.passed, 0);
    assert.match(result.reasons.join(' '), /Rendered viewport differs/);
  }
  f.review([f.entry({ renderedViewport: { width: 389.5, height: 844.5 } })]);
  assert.equal(f.validate().status, 'complete');
  for (const renderedViewport of [null, {}, { width: '390', height: 844 }, { width: 0, height: 844 }]) {
    f.review([f.entry({ renderedViewport })]);
    assert.throws(() => f.validate(), /Rendered viewport/);
  }
});

test('file screenshots require inspected-byte hashes and changed images invalidate evidence', t => {
  const f = fixture(t);
  f.review([f.entry({ screenshots: [{ kind: 'file', path: 'screen.png' }] })]);
  assert.equal(f.validate().status, 'incomplete');
  assert.match(f.validate().reasons.join(' '), /screenshot sha256/);
  f.review();
  // A valid signature still cannot prove this is the image originally inspected.
  f.write('screen.png', Buffer.concat([png, Buffer.from('changed capture')]));
  const result = f.validate();
  assert.equal(result.status, 'stale');
  assert.equal(result.coverage.passed, 0);
  assert.match(result.reasons.join(' '), /Screenshot byte hash differs/);
});

test('unavailable capture needs no invented per-observation hash or measurement', t => {
  const f = fixture(t);
  f.review([f.entry({
    status: 'unverified', previewSha256: undefined, renderedViewport: undefined,
    screenshots: [], interaction: '', observation: 'Browser capture unavailable.',
  })]);
  assert.equal(f.validate().status, 'incomplete');
  assert.equal(f.validate().coverage.unverified, 1);
});

test('capture hashes reject malformed values rather than treating them as evidence', t => {
  const f = fixture(t);
  for (const value of ['', 'not-a-hash', null, 42, 'A'.repeat(64)]) {
    f.review([f.entry({ previewSha256: value })]);
    assert.throws(() => f.validate(), /Observation previewSha256/);
    f.review([f.entry({ screenshots: [{ kind: 'file', path: 'screen.png', sha256: value }] })]);
    assert.throws(() => f.validate(), /Screenshot sha256/);
  }
});

test('unverified stays incomplete even with all evidence fields populated', t => {
  const f = fixture(t);
  f.review([f.entry({ status: 'unverified', observation: 'Browser image output was unavailable.' })]);
  const result = f.validate();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.coverage.unverified, 1);
  assert.equal(result.coverage.incomplete, 1);
});

test('a declared fail wins over incomplete evidence and missing coverage', t => {
  const f = fixture(t);
  f.review([f.entry({ status: 'fail', observation: '', interaction: undefined, screenshots: undefined })]);
  const result = f.validate({ screenIds: ['home', 'detail'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.coverage.failed, 1);
  assert.equal(result.coverage.missing, 1);
  assert.match(result.reasons.join(' '), /fail/);
});

test('HTML edits, old review hashes and changed source bytes make a review stale', t => {
  const f = fixture(t);
  f.write('preview.html', fs.readFileSync(path.join(f.root, 'preview.html'), 'utf8').replace('Fixture only', 'Changed'));
  assert.equal(f.validate().status, 'stale');
  f.review();
  let result = f.validate();
  assert.equal(result.status, 'stale');
  assert.match(result.reasons.join(' '), /document changed/);
  f.stamp();
  result = f.validate();
  assert.equal(result.status, 'stale');
  assert.match(result.reasons.join(' '), /byte hash differs/);
  f.review();
  assert.equal(f.validate().status, 'complete');
  f.write('plan.md', '# Changed source\n');
  result = f.validate();
  assert.equal(result.status, 'stale');
  assert.match(result.reasons.join(' '), /Source changed: plan.md/);
});

test('missing provenance, wrong mode, component scope or unrecorded required sources are incomplete', t => {
  const f = fixture(t);
  assert.equal(f.validate({ expectedMode: 'implementation' }).status, 'incomplete');
  f.stamp({ scope: 'components' });
  f.review();
  assert.equal(f.validate().status, 'incomplete');
  f.stamp();
  f.review();
  f.write('theme.ts', 'export const color = "blue";\n');
  const result = f.validate({ requiredSources: ['plan.md', 'theme.ts'] });
  assert.equal(result.status, 'incomplete');
  assert.match(result.reasons.join(' '), /Required source not recorded/);
  f.write('preview.html', '<html><body>No provenance</body></html>');
  f.review();
  assert.equal(f.validate().status, 'incomplete');
});

test('current implementation full-screen provenance is supported', t => {
  assert.equal(fixture(t, 'implementation').validate().status, 'complete');
});

test('exact raw HTML bytes, including inert provenance and byte encoding, bind the record', t => {
  const f = fixture(t);
  const bytes = fs.readFileSync(path.join(f.root, 'preview.html'));
  const changed = Buffer.concat([bytes, Buffer.from([0x80])]);
  f.write('preview.html', changed);
  f.stamp();
  f.review();
  const stamped = fs.readFileSync(path.join(f.root, 'preview.html'));
  // Both invalid bytes decode to the same replacement character, but are distinct evidence.
  f.write('preview.html', Buffer.concat([stamped.subarray(0, stamped.length - 3), Buffer.from([0x81])]));
  const result = f.validate();
  assert.equal(result.status, 'stale');
  assert.match(result.reasons.join(' '), /byte hash differs/);
});

test('duplicate observations (even different states) and unexpected cases are errors', t => {
  const f = fixture(t);
  f.review([f.entry(), f.entry({ state: 'opened' })]);
  assert.throws(() => f.validate(), /Duplicate observation case/);
  for (const extra of [{ screenId: 'other' }, { theme: 'dark' }, { viewport: { width: 391, height: 844 } }]) {
    f.review([f.entry(extra)]);
    assert.throws(() => f.validate(), /Unexpected observation case/);
  }
});

test('version, malformed records and non-string evidence are explicit errors', t => {
  const f = fixture(t);
  for (const version of [undefined, 0, 2, '1']) {
    f.review([], { version });
    assert.throws(() => f.validate(), /version must be 1/);
  }
  f.review([], { previewSha256: 'not-a-hash' });
  assert.throws(() => f.validate(), /previewSha256/);
  f.review(undefined, { observations: { nodes: [], edges: [] } });
  assert.throws(() => f.validate(), /observations must be an array/);
  for (const entry of [null, f.entry({ state: '' }), f.entry({ status: 'approved' }),
    f.entry({ interaction: true }), f.entry({ observation: {} }), f.entry({ screenshots: {} })]) {
    f.review([entry]);
    assert.throws(() => f.validate(), /observation|state|interaction|screenshots/);
  }
  f.write('review.json', '{ broken');
  assert.throws(() => f.validate(), /Invalid review JSON/);
});

test('API requires explicit unique, non-empty dimensions and positive finite integer viewports', t => {
  const f = fixture(t);
  for (const name of ['screenIds', 'viewports', 'themes']) {
    for (const value of [undefined, [], null, 'home']) {
      assert.throws(() => f.validate({ [name]: value }), /explicit non-empty array/);
    }
    assert.throws(() => f.validate({ [name]: [f.options[name][0], f.options[name][0]] }), /Duplicate/);
  }
  for (const value of [0, -1, 1.5, Infinity, NaN, '390', undefined]) {
    assert.throws(() => f.validate({ viewports: [{ width: value, height: 844 }] }), /positive finite integer/);
    assert.throws(() => f.validate({ viewports: [{ width: 390, height: value }] }), /positive finite integer/);
  }
  assert.throws(() => f.validate({ screenIds: [' '] }), /non-empty strings/);
  assert.throws(() => f.validate({ themes: [false] }), /non-empty strings/);
  assert.throws(() => f.validate({ expectedMode: undefined }), /Mode must be/);
  assert.throws(() => f.validate({ requiredSources: 'plan.md' }), /Required sources/);
});

test('PNG/JPEG/WebP signatures and declared tool references are accepted without judging image content', t => {
  const f = fixture(t);
  for (const [file, bytes] of [
    ['image.png', png], ['image.jpg', Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex')],
    ['image.jpeg', Buffer.from('ffd8ffdb00040000ffd9', 'hex')], ['image.webp', Buffer.from('RIFFxxxxWEBPVP8 ')],
  ]) {
    f.write(file, bytes);
    f.review([f.entry({ screenshots: [{ kind: 'file', path: file, sha256: digest(bytes) }] })]);
    assert.equal(f.validate().status, 'complete');
  }
  f.review([f.entry({ screenshots: [{ kind: 'tool', reference: 'browser_take_screenshot:call-42:image-1' }] })]);
  const result = f.validate();
  assert.equal(result.status, 'complete');
  assert.match(result.limitations.join(' '), /references are declared evidence and cannot be independently authenticated/);
});

test('fake, empty, unsupported or malformed screenshots are errors, not complete evidence', t => {
  const f = fixture(t);
  for (const [file, bytes] of [
    ['empty.png', ''], ['graph.png', '{"nodes":[],"edges":[]}'], ['page.png', '<html>not an image</html>'],
    ['wrong.jpg', png], ['graph.svg', '<svg></svg>'], ['fake.webp', 'RIFFxxxxxxxx'],
    ['high-bits.webp', Buffer.from('d2c9c6c600000000d7c5c2d0', 'hex')],
  ]) {
    f.write(file, bytes);
    f.review([f.entry({ screenshots: [{ kind: 'file', path: file }] })]);
    assert.throws(() => f.validate(), /Screenshot must be/);
  }
  for (const screenshot of [null, {}, { kind: 'url', path: 'screen.png' }, { kind: 'tool', reference: ' ' }]) {
    f.review([f.entry({ screenshots: [screenshot] })]);
    assert.throws(() => f.validate(), /Screenshot|screenshot reference/);
  }
});

test('all input paths stay inside the real root, including sources and symlink targets', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.base, 'outside.html'), fs.readFileSync(path.join(f.root, 'preview.html')));
  fs.writeFileSync(path.join(f.base, 'outside.json'), fs.readFileSync(path.join(f.root, 'review.json')));
  fs.writeFileSync(path.join(f.base, 'outside.png'), png);
  fs.writeFileSync(path.join(f.base, 'outside.md'), 'Outside source');
  for (const [name, outside] of [['preview', 'outside.html'], ['reviewPath', 'outside.json']]) {
    assert.throws(() => f.validate({ [name]: `../${outside}` }), /inside the real project root/);
    if (!symlink(t, path.join(f.base, outside), path.join(f.root, `linked-${outside}`))) return;
    assert.throws(() => f.validate({ [name]: `linked-${outside}` }), /inside the real project root/);
  }
  if (!symlink(t, path.join(f.base, 'outside.png'), path.join(f.root, 'linked.png'))) return;
  if (!symlink(t, f.base, path.join(f.root, 'linked-directory'), 'dir')) return;
  for (const file of ['../outside.png', 'linked.png', 'linked-directory/outside.png']) {
    f.review([f.entry({ screenshots: [{ kind: 'file', path: file }] })]);
    assert.throws(() => f.validate(), /inside the real project root/);
  }
  f.review();
  assert.throws(() => f.validate({ requiredSources: ['../outside.md'] }), /inside the project root/);
  if (!symlink(t, path.join(f.base, 'outside.md'), path.join(f.root, 'source-link.md'))) return;
  assert.throws(() => f.validate({ requiredSources: ['source-link.md'] }), /inside the project root/);
  const html = fs.readFileSync(path.join(f.root, 'preview.html'), 'utf8').replace('"file": "plan.md"', '"file": "../outside.md"');
  f.write('preview.html', html);
  f.review();
  assert.throws(() => f.validate({ requiredSources: [] }), /inside the project root/);
});

test('internal symlinks and a symlinked project root resolve safely', t => {
  const f = fixture(t);
  if (!symlink(t, path.join(f.root, 'screen.png'), path.join(f.root, 'internal.png'))) return;
  if (!symlink(t, f.root, path.join(f.base, 'root-link'), 'dir')) return;
  f.review([f.entry({ screenshots: [{ kind: 'file', path: 'internal.png', sha256: digest(png) }] })]);
  assert.equal(f.validate({ projectRoot: path.join(f.base, 'root-link') }).status, 'complete');
});

test('require regular HTML/JSON/image files and never let review or screenshot alias the preview', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'directory.png'));
  assert.throws(() => f.validate({ preview: 'plan.md' }), /HTML|html/);
  assert.throws(() => f.validate({ reviewPath: 'plan.md' }), /json/);
  assert.throws(() => f.validate({ reviewPath: 'preview.html' }), /preview itself/);
  if (!symlink(t, path.join(f.root, 'preview.html'), path.join(f.root, 'alias.json'))) return;
  assert.throws(() => f.validate({ reviewPath: 'alias.json' }), /preview itself/);
  fs.linkSync(path.join(f.root, 'preview.html'), path.join(f.root, 'hardlink.png'));
  for (const file of ['preview.html', 'hardlink.png', 'directory.png', path.join(f.root, 'screen.png')]) {
    f.review([f.entry({ screenshots: [{ kind: 'file', path: file }] })]);
    assert.throws(() => f.validate(), /preview itself|regular file|project-relative/);
  }
  assert.throws(() => f.validate({ preview: 'missing.html' }), /ENOENT/);
});

test('fingerprint CLI returns only the exact byte hash after fresh full-screen provenance', t => {
  const f = fixture(t);
  const args = [...f.baseArgs, '--fingerprint', '--require-source', 'plan.md'];
  let child = f.run(args);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { previewSha256: digest(fs.readFileSync(path.join(f.root, 'preview.html'))) });
  f.write('plan.md', 'Changed');
  child = f.run(args);
  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /Cannot fingerprint.*Source changed/);
  f.stamp({ scope: 'components' });
  assert.equal(f.run(args).status, 2);
  f.write('preview.html', '<html><body>Unverified</body></html>');
  assert.equal(f.run(args).status, 2);
});

test('review CLI exits 0 only for complete evidence and 2 for incomplete, failed, stale or invalid', t => {
  const f = fixture(t);
  for (const [status, observations] of [
    ['complete', [f.entry()]], ['incomplete', []], ['failed', [f.entry({ status: 'fail' })]],
  ]) {
    f.review(observations);
    const child = f.run();
    assert.equal(child.status, status === 'complete' ? 0 : 2, child.stderr);
    assert.equal(JSON.parse(child.stdout).status, status);
  }
  f.review([f.entry()], { previewSha256: '0'.repeat(64) });
  let child = f.run();
  assert.equal(child.status, 2);
  assert.equal(JSON.parse(child.stdout).status, 'stale');
  f.review([f.entry(), f.entry()]);
  child = f.run();
  assert.equal(child.status, 2);
  assert.match(child.stderr, /Duplicate observation/);
});

test('CLI rejects unknown, missing, duplicate scalar, incompatible and malformed arguments', t => {
  const f = fixture(t);
  const invalid = [
    [], [...f.reviewArgs, '--unknown'], [...f.reviewArgs, '--theme'],
    [...f.reviewArgs, '--fingerprint'], [...f.baseArgs, '--fingerprint', '--fingerprint'],
    [...f.baseArgs, '--fingerprint', '--screen-id', 'home'],
    [...f.baseArgs, '--review', 'review.json'],
    ...['--project-root', '--preview', '--mode', '--review'].map(arg => [...f.reviewArgs, arg, 'duplicate']),
    ...['0x844', '-1x844', '390.5x844', '390X844', '390xInfinity', '390x'].map(value => [...f.reviewArgs, '--viewport', value]),
    ...['--project-root', '--preview', '--mode', '--review', '--screen-id', '--viewport', '--theme'].map(arg => {
      const index = f.reviewArgs.indexOf(arg);
      return f.reviewArgs.filter((_, position) => position !== index && position !== index + 1);
    }),
    [...f.baseArgs.slice(0, -1), 'native', '--fingerprint'],
  ];
  for (const args of invalid) {
    const child = f.run(args);
    assert.equal(child.status, 2, JSON.stringify(args));
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /validate-preview-review:/);
  }
});

test('validation and fingerprinting preserve every input byte and create no output files', t => {
  const f = fixture(t);
  f.write('preview.html', '<html><body><script>throw new Error("must not execute");</script>Fixture</body></html>\r\n');
  f.stamp();
  f.review();
  const snapshot = () => fs.readdirSync(f.root).sort().map(file => [file, fs.readFileSync(path.join(f.root, file))]);
  const before = snapshot();
  assert.equal(f.validate().status, 'complete');
  assert.equal(f.run().status, 0);
  assert.equal(f.run([...f.baseArgs, '--fingerprint']).status, 0);
  assert.deepEqual(snapshot(), before);
});

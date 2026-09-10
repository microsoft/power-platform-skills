'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { writeProvenance, checkProvenance } = require('../preview-provenance');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'index.tsx'), 'export default () => null;');
  fs.writeFileSync(path.join(root, 'preview.html'), '<!doctype html><html><body><h1>Example</h1></body></html>');
  return { projectRoot: root, preview: 'preview.html', sources: ['app/index.tsx'], mode: 'implementation', scope: 'full-screens' };
}

test('recording and checking bind preview content, mode, scope and exact sources', t => {
  const options = fixture(t);
  writeProvenance(options);
  const result = checkProvenance(options);
  assert.equal(result.status, 'current');
  assert.equal(result.scope, 'full-screens');
  assert.equal(result.mode, 'implementation');
  assert.equal(result.sourceCount, 1);
  assert.match(result.limitations, /not dependency completeness, visual quality, approval or native execution/);
  const before = fs.readFileSync(path.join(options.projectRoot, options.preview), 'utf8');
  writeProvenance(options);
  assert.equal(checkProvenance(options).status, 'current');
  assert.equal(before.match(/id="mobile-preview-provenance"/g).length, 1);
});

test('edits to a source or preview invalidate freshness without granting new approval', t => {
  const options = fixture(t);
  writeProvenance(options);
  fs.appendFileSync(path.join(options.projectRoot, options.sources[0]), '\n// edited');
  assert.equal(checkProvenance(options).status, 'stale');
  writeProvenance(options);
  const preview = path.join(options.projectRoot, options.preview);
  fs.writeFileSync(preview, fs.readFileSync(preview, 'utf8').replace('Example', 'Changed example'));
  assert.deepEqual(checkProvenance(options).reasons, ['Preview document changed after recording']);
});

test('required handoff sources reject fresh but incomplete evidence without rewriting it', t => {
  const options = fixture(t);
  fs.mkdirSync(path.join(options.projectRoot, 'brand'));
  fs.writeFileSync(path.join(options.projectRoot, 'brand/tokens.ts'), 'export const tokens = {};');
  const requiredSources = [...options.sources, 'brand/tokens.ts'];
  writeProvenance(options);
  const file = path.join(options.projectRoot, options.preview);
  const before = fs.readFileSync(file, 'utf8');

  assert.equal(checkProvenance(options).status, 'current', 'legacy freshness checks stay compatible');
  const result = checkProvenance({ ...options, requiredSources });
  assert.equal(result.status, 'mismatch');
  assert.deepEqual(result.reasons, ['Required source not recorded: brand/tokens.ts']);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'check must not add the missing source');
  assert.match(result.limitations, /not dependency completeness, visual quality, approval or native execution/);

  writeProvenance({ ...options, sources: requiredSources });
  assert.equal(checkProvenance({ ...options, requiredSources }).status, 'current');
  fs.appendFileSync(path.join(options.projectRoot, 'brand/tokens.ts'), '\n// changed');
  assert.equal(checkProvenance({ ...options, requiredSources }).status, 'stale');
});

test('required source assertions normalize paths and allow extra reviewed inputs', t => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.projectRoot, 'tamagui.config.ts'), 'export default {};');
  writeProvenance({ ...options, sources: [...options.sources, 'tamagui.config.ts'] });
  const result = checkProvenance({
    ...options,
    requiredSources: ['./app/index.tsx', path.join(options.projectRoot, 'app/index.tsx')],
  });
  assert.equal(result.status, 'current');
  assert.equal(result.sourceCount, 2);
});

test('required sources must be existing regular inputs inside the project', t => {
  const options = fixture(t);
  writeProvenance(options);
  const other = fixture(t);
  for (const requiredSources of [
    ['missing.tsx'], ['app'], ['preview.html'],
    [path.join(other.projectRoot, 'app/index.tsx')], [''], [null], 'app/index.tsx', null,
  ]) assert.throws(() => checkProvenance({ ...options, requiredSources }));
});

test('missing provenance is unverified, not a visual pass', t => {
  assert.equal(checkProvenance(fixture(t)).status, 'unverified');
});

test('only HTML outputs are written and similarly named data attributes are preserved', t => {
  const options = fixture(t);
  assert.throws(() => writeProvenance({ ...options, preview: 'app/index.tsx' }), /HTML file/);
  const file = path.join(options.projectRoot, options.preview);
  const script = '<script type="application/json" data-id="mobile-preview-provenance">{"unrelated":true}</script>';
  fs.writeFileSync(file, `<html><body>${script}</body></html>`);
  writeProvenance(options);
  assert.ok(fs.readFileSync(file, 'utf8').includes(script));
  assert.equal(checkProvenance(options).status, 'current');
});

test('component-only evidence remains explicitly partial', t => {
  const options = { ...fixture(t), scope: 'components' };
  writeProvenance(options);
  assert.equal(checkProvenance(options).scope, 'components');
  assert.equal(checkProvenance({ ...options, expectedScope: 'full-screens' }).status, 'mismatch');
  assert.equal(checkProvenance({ ...options, expectedMode: 'intent' }).status, 'mismatch');
});

test('missing, directory, self and escaping source paths are errors', t => {
  const options = fixture(t);
  for (const source of ['missing.tsx', 'app', 'preview.html']) {
    assert.throws(() => writeProvenance({ ...options, sources: [source] }));
  }
  const other = fixture(t);
  assert.throws(() => writeProvenance({ ...options, sources: [path.join(other.projectRoot, 'app/index.tsx')] }), /inside the project/);
  assert.throws(() => writeProvenance({ ...options, sources: [] }), /At least one/);
});

test('source symlinks cannot escape the project', t => {
  const options = fixture(t);
  const other = fixture(t);
  try {
    fs.symlinkSync(path.join(other.projectRoot, 'app/index.tsx'), path.join(options.projectRoot, 'outside.tsx'));
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('This Windows account cannot create file symlinks');
      return;
    }
    throw error;
  }
  assert.throws(() => writeProvenance({ ...options, sources: ['outside.tsx'] }), /inside the project/);
  writeProvenance(options);
  assert.throws(() => checkProvenance({ ...options, requiredSources: ['outside.tsx'] }), /inside the project/);
});

test('malformed and duplicate embedded metadata do not pass', t => {
  const options = fixture(t);
  writeProvenance(options);
  const file = path.join(options.projectRoot, options.preview);
  const html = fs.readFileSync(file, 'utf8');
  const block = html.match(/<script[\s\S]*?<\/script>/)[0];
  fs.writeFileSync(file, html.replace('</body>', `${block}</body>`));
  assert.throws(() => checkProvenance(options), /Duplicate/);
  fs.writeFileSync(file, html.replace('"version": 1', '"version": 42'));
  assert.throws(() => checkProvenance(options), /Invalid/);
});

test('CLI returns nonzero for stale evidence and invalid inputs', t => {
  const options = fixture(t);
  const command = path.resolve(__dirname, '../preview-provenance.js');
  const run = args => spawnSync(process.execPath, [command, '--project-root', options.projectRoot, '--preview', options.preview, ...args], { encoding: 'utf8' });
  assert.equal(run(['--check']).status, 2);
  assert.equal(run(['--write', '--mode', 'implementation', '--scope', 'full-screens', '--source', options.sources[0]]).status, 0);
  assert.equal(run(['--check']).status, 0);
  assert.equal(run(['--check', '--expect-mode', 'implementation', '--expect-scope', 'full-screens']).status, 0);
  assert.equal(run(['--check', '--require-source', options.sources[0]]).status, 0);
  fs.writeFileSync(path.join(options.projectRoot, 'tamagui.config.ts'), 'export default {};');
  const incomplete = run(['--check', '--require-source', options.sources[0], '--require-source', 'tamagui.config.ts']);
  assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stdout).status, 'mismatch');
  assert.equal(run(['--check', '--require-source']).status, 2);
  assert.equal(run(['--check', '--require-source', 'missing.ts']).status, 2);
  assert.equal(run(['--write', '--mode', 'intent', '--scope', 'full-screens', '--source', options.sources[0], '--require-source', options.sources[0]]).status, 2);
  assert.equal(run(['--check', '--expect-mode', 'intent']).status, 2);
  assert.equal(run(['--check', '--write']).status, 2);
  assert.equal(run(['--check', '--source', options.sources[0]]).status, 2);
  fs.unlinkSync(path.join(options.projectRoot, options.sources[0]));
  assert.equal(run(['--check']).status, 2);
});

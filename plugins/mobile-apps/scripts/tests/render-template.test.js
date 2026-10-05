'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applyStep, initState, outputPath, save, setSection } = require('../app-docs');
const { publishAtomic, renderTemplate } = require('../lib/render-template');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('plan text shaped like a placeholder is rendered, not rejected', () => {
  // `__DEV__` is React Native's development flag, so a note or a trust entry can name it. The
  // renderer used to scan its own output, find it, and fail the write - and because the value
  // was already saved, every later write failed with it.
  const root = tempDir('render-dev-');
  let state = initState(root, { appName: 'Placeholder', dataPlatform: 'dataverse' });
  state = applyStep(state, { id: 'requirements', status: 'active', note: 'Debug logging only under __DEV__' });
  state = setSection(state, 'trust', {
    battery: [{ name: 'Verbose logging', detail: 'Enabled only when __DEV__ is true.' }],
  });

  assert.doesNotThrow(() => save(root, state));
  // And the next write, with the value still in the state, succeeds too.
  state = applyStep(state, { id: 'requirements', status: 'done' });
  assert.doesNotThrow(() => save(root, state));

  const html = fs.readFileSync(outputPath(root), 'utf8');
  assert.match(html, /Enabled only when __DEV__ is true\./);
});

test('a placeholder the template names but the data lacks still fails the render', () => {
  const dir = tempDir('render-missing-');
  const templatePath = path.join(dir, 'template.html');
  fs.writeFileSync(templatePath, '<p>__HTML_PRESENT__ __HTML_ABSENT__</p>');

  assert.throws(
    () => renderTemplate({
      templatePath, outputPath: path.join(dir, 'out.html'), dataObject: { PRESENT: 'yes' },
    }),
    /Unreplaced placeholders: __HTML_ABSENT__/,
  );
  assert.ok(!fs.existsSync(path.join(dir, 'out.html')), 'nothing is published on failure');
});

/** Replace `fs.renameSync` for one test, failing the first `failures` calls with `code`. */
function failingRename(t, code, failures) {
  const real = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    calls += 1;
    if (calls <= failures) {
      const error = new Error(`${code}: simulated`);
      error.code = code;
      throw error;
    }
    return real(from, to);
  });
  return () => calls;
}

test('a rename refused by a momentary Windows lock is retried, not dropped', (t) => {
  const dir = tempDir('render-lock-');
  const target = path.join(dir, 'plan.html');
  fs.writeFileSync(target, 'previous');
  const calls = failingRename(t, 'EPERM', 2);

  publishAtomic(target, 'next');

  assert.equal(fs.readFileSync(target, 'utf8'), 'next');
  assert.equal(calls(), 3);
  assert.deepEqual(fs.readdirSync(dir), ['plan.html'], 'no temporary file is left behind');
});

test('a rename that keeps failing gives up, leaving the previous file and no temporary', (t) => {
  const dir = tempDir('render-held-');
  const target = path.join(dir, 'plan.html');
  fs.writeFileSync(target, 'previous');
  failingRename(t, 'EBUSY', Infinity);

  assert.throws(() => publishAtomic(target, 'next'), /EBUSY/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
  assert.deepEqual(fs.readdirSync(dir), ['plan.html']);
});

test('a rename error that is not a lock is not retried', (t) => {
  const dir = tempDir('render-other-');
  const calls = failingRename(t, 'EXDEV', 1);

  assert.throws(() => publishAtomic(path.join(dir, 'plan.html'), 'next'), /EXDEV/);
  assert.equal(calls(), 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

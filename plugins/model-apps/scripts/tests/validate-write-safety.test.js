const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'validate-write-safety.js');

function runHook(payload, env) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
  return { status: res.status, stderr: res.stderr || '' };
}

let cwd;
test.beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-ws-'));
  // Mark this as an active genpage session so the (session-scoped) guard engages.
  fs.writeFileSync(path.join(cwd, 'genpage-plan.md'), '# plan\n', 'utf8');
});
test.afterEach(() => {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('write inside the working directory is allowed (exit 0)', () => {
  const payload = {
    tool_name: 'Write',
    tool_input: { file_path: path.join(cwd, 'sub', 'page.tsx'), content: 'x' },
    cwd,
  };
  assert.equal(runHook(payload).status, 0);
});

test('relative path resolving under cwd is allowed (exit 0)', () => {
  const payload = { tool_name: 'Edit', tool_input: { file_path: 'RuntimeTypes.ts', new_string: 'x' }, cwd };
  assert.equal(runHook(payload).status, 0);
});

test('write escaping the working directory is flagged, non-blocking (exit 1)', () => {
  // Target the drive/filesystem root so the path is outside BOTH cwd and the
  // tmpdir scratch exception (cwd itself lives under tmpdir here).
  const outside = path.join(path.parse(cwd).root, 'model-apps-guard-evil', 'evil.ts');
  const payload = { tool_name: 'Write', tool_input: { file_path: outside, content: 'x' }, cwd };
  const { status, stderr } = runHook(payload);
  assert.equal(status, 1); // non-blocking: exit 1 (only exit 2 would block)
  assert.match(stderr, /outside your project folder/);
});

test('parent-traversal path escaping to the root is flagged, non-blocking (exit 1)', () => {
  const target = path.join(path.parse(cwd).root, 'model-apps-guard-evil2.ts');
  const rel = path.relative(cwd, target); // e.g. ..\..\..\model-apps-guard-evil2.ts
  const payload = { tool_name: 'Edit', tool_input: { file_path: rel, new_string: 'x' }, cwd };
  assert.equal(runHook(payload).status, 1);
});

test('outside-cwd write is NOT flagged when there is no genpage session (exit 0)', () => {
  fs.rmSync(path.join(cwd, 'genpage-plan.md'), { force: true }); // no active genpage run
  const outside = path.join(path.parse(cwd).root, 'model-apps-guard-evil', 'evil.ts');
  const payload = { tool_name: 'Write', tool_input: { file_path: outside, content: 'x' }, cwd };
  assert.equal(runHook(payload).status, 0);
});

test('genpage-plan.md in a working subdir activates the guard (exit 1)', () => {
  fs.rmSync(path.join(cwd, 'genpage-plan.md'), { force: true });
  const wd = path.join(cwd, 'my-page');
  fs.mkdirSync(wd);
  fs.writeFileSync(path.join(wd, 'genpage-plan.md'), '# plan\n', 'utf8');
  const outside = path.join(path.parse(cwd).root, 'model-apps-guard-evil', 'evil.ts');
  const payload = { tool_name: 'Write', tool_input: { file_path: outside, content: 'x' }, cwd };
  assert.equal(runHook(payload).status, 1);
});

// /app-builder runs the same runaway-sub-agent risk (its generate-pages phase dispatches
// PARALLEL page-builder workers), but its working dir carries app-spec.json +
// model-app-plan.md rather than genpage-plan.md — so those markers must activate the guard too.
for (const marker of ['app-spec.json', 'model-app-plan.md']) {
  test(`app-builder marker ${marker} at cwd activates the guard (exit 1)`, () => {
    fs.rmSync(path.join(cwd, 'genpage-plan.md'), { force: true });
    fs.writeFileSync(path.join(cwd, marker), '{}\n', 'utf8');
    const outside = path.join(path.parse(cwd).root, 'model-apps-guard-evil', 'evil.ts');
    const payload = { tool_name: 'Write', tool_input: { file_path: outside, content: 'x' }, cwd };
    assert.equal(runHook(payload).status, 1);
  });

  test(`app-builder marker ${marker} in a working subdir activates the guard (exit 1)`, () => {
    fs.rmSync(path.join(cwd, 'genpage-plan.md'), { force: true });
    const wd = path.join(cwd, 'my-app');
    fs.mkdirSync(wd);
    fs.writeFileSync(path.join(wd, marker), '{}\n', 'utf8');
    const outside = path.join(path.parse(cwd).root, 'model-apps-guard-evil', 'evil.ts');
    const payload = { tool_name: 'Write', tool_input: { file_path: outside, content: 'x' }, cwd };
    assert.equal(runHook(payload).status, 1);
  });
}

test('tmpdir scratch writes are allowed (exit 0)', () => {
  const payload = {
    tool_name: 'Write',
    tool_input: { file_path: path.join(os.tmpdir(), 'scratch-xyz.txt'), content: 'x' },
    cwd,
  };
  assert.equal(runHook(payload).status, 0);
});

test('non-write tools are ignored (exit 0)', () => {
  const payload = { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' }, cwd };
  assert.equal(runHook(payload).status, 0);
});

test('MODEL_APPS_SKIP_WRITE_GUARD=1 bypasses the guard (exit 0)', () => {
  const outside = path.join(path.dirname(cwd), 'sibling', 'evil.ts');
  const payload = { tool_name: 'Write', tool_input: { file_path: outside, content: 'x' }, cwd };
  assert.equal(runHook(payload, { MODEL_APPS_SKIP_WRITE_GUARD: '1' }).status, 0);
});

test('MODEL_APPS_SKIP_WRITE_GUARD=true also bypasses the guard (exit 0)', () => {
  const outside = path.join(path.parse(cwd).root, 'model-apps-guard-evil', 'evil.ts');
  const payload = { tool_name: 'Write', tool_input: { file_path: outside, content: 'x' }, cwd };
  assert.equal(runHook(payload, { MODEL_APPS_SKIP_WRITE_GUARD: 'true' }).status, 0);
});

test('missing file_path is not our concern (exit 0)', () => {
  const payload = { tool_name: 'Write', tool_input: { content: 'x' }, cwd };
  assert.equal(runHook(payload).status, 0);
});

test('Windows: in-cwd target with different drive-letter casing is allowed (exit 0)', { skip: process.platform !== 'win32' }, () => {
  // A tool may emit `d:\...` while cwd is `D:\...`; case-insensitive containment
  // on Windows must not reject a legitimate in-project write.
  const target = path.join(cwd, 'sub', 'page.tsx');
  const lowered = target.charAt(0).toLowerCase() + target.slice(1);
  const payload = { tool_name: 'Write', tool_input: { file_path: lowered, content: 'x' }, cwd };
  assert.equal(runHook(payload).status, 0);
});

test('MODEL_APPS_DISABLE_HOOKS=1 disables the guard (exit 0 for an outside write)', () => {
  const outside = path.join(path.parse(cwd).root, 'model-apps-guard-evil', 'evil.ts');
  const payload = { tool_name: 'Write', tool_input: { file_path: outside, content: 'x' }, cwd };
  assert.equal(runHook(payload, { MODEL_APPS_DISABLE_HOOKS: '1' }).status, 0);
});

test('unparseable stdin does not block (exit 0)', () => {
  const res = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(res.status, 0);
});

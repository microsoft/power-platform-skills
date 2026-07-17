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

test('write escaping the working directory is blocked (exit 2)', () => {
  // Target the drive/filesystem root so the path is outside BOTH cwd and the
  // tmpdir scratch exception (cwd itself lives under tmpdir here).
  const outside = path.join(path.parse(cwd).root, 'model-apps-guard-evil', 'evil.ts');
  const payload = { tool_name: 'Write', tool_input: { file_path: outside, content: 'x' }, cwd };
  const { status, stderr } = runHook(payload);
  assert.equal(status, 2);
  assert.match(stderr, /outside the project root/);
});

test('parent-traversal path escaping to the root is blocked (exit 2)', () => {
  const target = path.join(path.parse(cwd).root, 'model-apps-guard-evil2.ts');
  const rel = path.relative(cwd, target); // e.g. ..\..\..\model-apps-guard-evil2.ts
  const payload = { tool_name: 'Edit', tool_input: { file_path: rel, new_string: 'x' }, cwd };
  assert.equal(runHook(payload).status, 2);
});

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

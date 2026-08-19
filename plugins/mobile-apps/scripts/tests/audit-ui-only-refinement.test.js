'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureSnapshot, verifySnapshot } = require('../audit-ui-only-refinement');

function projectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-only-audit-'));
  fs.mkdirSync(path.join(root, 'app', '(app)'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', '(app)', 'home.tsx'), 'export default function Home(){ return null; }\n');
  fs.writeFileSync(path.join(root, 'src', 'generated', 'service.ts'), 'export const service = {};\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  return root;
}

test('allows edits confined to the exact UI scope', () => {
  const root = projectFixture();
  const snapshot = captureSnapshot(root, ['app/(app)/home.tsx']);
  fs.writeFileSync(path.join(root, 'app', '(app)', 'home.tsx'), 'export default function Home(){ return <Text>Home</Text>; }\n');
  const result = verifySnapshot(snapshot, root);
  assert.strictEqual(result.status, 'ok');
  assert.deepStrictEqual(result.changed, ['app/(app)/home.tsx']);
  assert.deepStrictEqual(result.violations, []);
});

test('blocks an undisclosed generated-service edit', () => {
  const root = projectFixture();
  const snapshot = captureSnapshot(root, ['app/(app)/home.tsx']);
  fs.writeFileSync(path.join(root, 'src', 'generated', 'service.ts'), 'export const service = { changed: true };\n');
  const result = verifySnapshot(snapshot, root);
  assert.strictEqual(result.status, 'blocked');
  assert.ok(result.violations.some((issue) => issue.rule === 'scope-escape' && issue.file === 'src/generated/service.ts'));
});

test('blocks deleting even a scoped screen', () => {
  const root = projectFixture();
  const snapshot = captureSnapshot(root, ['app/(app)/home.tsx']);
  fs.unlinkSync(path.join(root, 'app', '(app)', 'home.tsx'));
  const result = verifySnapshot(snapshot, root);
  assert.strictEqual(result.status, 'blocked');
  assert.ok(result.violations.some((issue) => issue.rule === 'scoped-file-deleted'));
});
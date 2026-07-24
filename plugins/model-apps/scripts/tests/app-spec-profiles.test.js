const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateAppSpec, normalizePageSource } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

// Minimal valid spec (solution + app + one entity) we can attach pages to.
function base() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso' },
    entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
  };
}

test('normalizePageSource: legacy codeFile -> tsx; explicit source passes through; neither -> null', () => {
  assert.deepStrictEqual(normalizePageSource({ name: 'A', codeFile: 'a.tsx' }), { kind: 'tsx', codeFile: 'a.tsx' });
  assert.deepStrictEqual(normalizePageSource({ name: 'A', source: { kind: 'intent' } }), { kind: 'intent' });
  assert.deepStrictEqual(normalizePageSource({ name: 'A', source: { kind: 'tsx', codeFile: 'a.tsx' } }), { kind: 'tsx', codeFile: 'a.tsx' });
  assert.strictEqual(normalizePageSource({ name: 'A' }), null);
});

test('deploy profile (default) requires every page implemented (tsx)', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  const r = validateAppSpec(s); // default profile = deploy
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /page 'ov': must be implemented/.test(e)), JSON.stringify(r.errors));
});

test('plan/design profile allows an intent page', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));
  assert.strictEqual(validateAppSpec(s, { profile: 'design' }).ok, true);
});

test('deploy profile accepts an implemented page (explicit tsx and legacy codeFile)', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }];
  assert.strictEqual(validateAppSpec(s).ok, true, JSON.stringify(validateAppSpec(s).errors));
  const legacy = base();
  delete legacy.schemaVersion; // legacy spec, top-level codeFile
  legacy.pages = [{ name: 'Overview', codeFile: 'overview.tsx' }];
  assert.strictEqual(validateAppSpec(legacy).ok, true, JSON.stringify(validateAppSpec(legacy).errors));
});

test('malformed source is rejected regardless of profile', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'tsx' } }]; // tsx with no codeFile
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /page 'ov': source.kind 'tsx' needs a codeFile/.test(e)), JSON.stringify(r.errors));

  const s2 = base();
  s2.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'nope' } }];
  assert.ok(validateAppSpec(s2, { profile: 'plan' }).errors.some((e) => /page 'ov': source.kind must be 'intent' or 'tsx'/.test(e)));
});

test('structural profile ignores page implementation entirely', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  assert.strictEqual(validateAppSpec(s, { profile: 'structural' }).ok, true);
});

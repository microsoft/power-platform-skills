// Guards the guard. validate-hooks-manifests.js exists to stop a plugin shipping a hooks.json
// key the host does not recognise, because the only symptom is a warning line in somebody
// else's terminal at every session start — invisible in review, and caught by no other test.
// The cases that matter most are therefore the ones asserting it does NOT stay silent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { checkManifest, findHookManifests, ALLOWED_TOP_LEVEL_KEYS } = require('../validate-hooks-manifests.js');

test('a manifest with only "hooks" passes', () => {
  assert.deepEqual(checkManifest({ hooks: {} }, 'x/hooks.json'), []);
});

test('a manifest with "hooks" and the recognised "description" passes', () => {
  assert.deepEqual(checkManifest({ description: 'what these do', hooks: {} }, 'x/hooks.json'), []);
});

test('the "_comment" key that caused #555/#558 is rejected, and the message says where prose goes', () => {
  const problems = checkManifest({ _comment: 'prose', hooks: {} }, 'plugins/p/hooks/hooks.json');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown top-level key "_comment"/);
  assert.match(problems[0], /hooks\/README\.md/);
  // The message must quote the host's own wording so a reader can connect it to the
  // warning they actually saw in their terminal.
  assert.match(problems[0], /unknown key "_comment" ignored/);
});

test('any other unrecognised key is rejected too (the rule is an allow-list, not a _comment blocklist)', () => {
  for (const key of ['comment', '//', 'notes', 'x-docs', 'readme']) {
    const problems = checkManifest({ [key]: 'prose', hooks: {} }, 'x/hooks.json');
    assert.equal(problems.length, 1, `${key} should be rejected`);
    assert.match(problems[0], new RegExp(`unknown top-level key "${key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`));
  }
});

test('a manifest missing "hooks" is rejected', () => {
  const problems = checkManifest({ description: 'only prose' }, 'x/hooks.json');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing the required "hooks" key/);
});

test('a non-object manifest is rejected without throwing', () => {
  for (const value of [null, [], 'string', 42]) {
    const problems = checkManifest(value, 'x/hooks.json');
    assert.equal(problems.length, 1, JSON.stringify(value));
    assert.match(problems[0], /expected a JSON object/);
  }
});

// The real repository must satisfy the rule. This is what actually fails a PR that
// reintroduces the key, so it is asserted against the committed files rather than fixtures.
test('every committed plugin hooks.json passes', () => {
  const files = findHookManifests();
  assert.ok(files.length >= 3, `expected to find plugin hooks manifests, found ${files.length}`);
  for (const filePath of files) {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rel = path.relative(path.resolve(__dirname, '..', '..'), filePath);
    assert.deepEqual(checkManifest(manifest, rel), [], rel);
  }
});

test('the allow-list stays tight — widening it silently re-creates the bug', () => {
  assert.deepEqual([...ALLOWED_TOP_LEVEL_KEYS].sort(), ['description', 'hooks']);
});

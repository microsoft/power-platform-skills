const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSimpleYaml } = require('../lib/powerpages-config');

test('parseSimpleYaml handles arrays and block-scalar descriptions', () => {
  const parsed = parseSimpleYaml(
    [
      'description: >-',
      '  First line',
      '',
      '  Second line',
      'id: e7c06211-0cb1-4096-b3f8-9b7f91f3a133',
      'adx_entitypermission_webrole:',
      '- 997e7996-e241-4117-9c09-28e90a1fcdbc',
    ].join('\n'),
    'sample.yml'
  );

  assert.equal(parsed.description, 'First line\n\nSecond line');
  assert.deepEqual(parsed.adx_entitypermission_webrole, ['997e7996-e241-4117-9c09-28e90a1fcdbc']);
});

// --- Quoted scalar unwrap (round-trip symmetry with create-site-setting writer) ---

test('parseSimpleYaml unwraps double-quoted scalars and unescapes \\\\ and \\"', () => {
  // The writer in create-site-setting.js wraps values like "-foo", "'foo",
  // '"foo', and YAML 1.2 reserved barewords ("true", "false", "null") in
  // double quotes. The loader must return the original UNQUOTED string so a
  // read-modify-write cycle doesn't silently mutate the value.
  const parsed = parseSimpleYaml(
    [
      'a: "-foo"',
      'b: "\'foo"',
      'c: "\\"foo"',
      'd: "true"',
      'e: "false"',
      'f: "null"',
      'g: "back\\\\slash"',
    ].join('\n'),
    'sample.yml'
  );

  assert.equal(parsed.a, '-foo');
  assert.equal(parsed.b, "'foo");
  assert.equal(parsed.c, '"foo');
  // These three would be parsed as boolean / null if unwrapping happened after
  // the bareword tests. The order in parseYamlScalar is deliberate.
  assert.equal(parsed.d, 'true');
  assert.equal(parsed.e, 'false');
  assert.equal(parsed.f, 'null');
  assert.equal(parsed.g, 'back\\slash');
});

test('parseSimpleYaml unwraps single-quoted scalars and unescapes \'\' as a literal quote', () => {
  const parsed = parseSimpleYaml(
    [
      "a: '-foo'",
      "b: 'hello ''world'''",
    ].join('\n'),
    'sample.yml'
  );
  assert.equal(parsed.a, '-foo');
  assert.equal(parsed.b, "hello 'world'");
});

test('parseSimpleYaml leaves plain (unquoted) scalars untouched', () => {
  // Regression guard: the unwrap logic must only fire when both ends are the
  // SAME quote character.
  const parsed = parseSimpleYaml(
    [
      'a: hello world',
      'b: contains "quote" mid-string',
      'c: ends with "',
      'd: "no matching close',
    ].join('\n'),
    'sample.yml'
  );
  assert.equal(parsed.a, 'hello world');
  assert.equal(parsed.b, 'contains "quote" mid-string');
  assert.equal(parsed.c, 'ends with "');
  assert.equal(parsed.d, '"no matching close');
});

test('parseYamlScalar bareword coercion still works for actually-bareword values', () => {
  // Regression guard: the unwrap path is for QUOTED values. Unquoted true /
  // false / null / digits must still coerce to JS booleans / null / number.
  const parsed = parseSimpleYaml(
    [
      'a: true',
      'b: false',
      'c: null',
      'd: 42',
      'e: -7',
    ].join('\n'),
    'sample.yml'
  );
  assert.equal(parsed.a, true);
  assert.equal(parsed.b, false);
  assert.equal(parsed.c, null);
  assert.equal(parsed.d, 42);
  assert.equal(parsed.e, -7);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractYamlValue, substituteYamlValue, yamlScalar, unquoteYamlScalar, isFlatYmlUnit } = require('../lib/flat-yml-merge');

const YML = [
  'description: \'A header value\'',
  'name: HTTP/X-Frame-Options',
  'value: SAMEORIGIN',
  'websiteid: 624e58a6-0eec-403a-a422-f3611d3de1a6',
  'componentid: 8ec1e069-c2c6-4839-9b7a-1b930f385d32',
].join('\n') + '\n';

test('extractYamlValue: reads the value: scalar (plain/quoted)', () => {
  assert.equal(extractYamlValue(YML), 'SAMEORIGIN');
  assert.equal(extractYamlValue('value: 500\nname: x\n'), '500');
  assert.equal(extractYamlValue("value: 'a: b'\n"), 'a: b');
  assert.equal(extractYamlValue('value: "He said \\"hi\\""\n'), 'He said "hi"');
  assert.equal(extractYamlValue('name: x\n'), null); // no value line
});

test('substituteYamlValue: replaces ONLY the value: line, preserving metadata', () => {
  const out = substituteYamlValue(YML, 'DENY');
  assert.match(out, /^value: DENY$/m);
  assert.match(out, /name: HTTP\/X-Frame-Options/);          // metadata preserved
  assert.match(out, /websiteid: 624e58a6/);                  // metadata preserved
  assert.match(out, /componentid: 8ec1e069/);                // metadata preserved
  assert.equal((out.match(/^value:/gm) || []).length, 1);    // exactly one value line
  assert.equal(extractYamlValue(out), 'DENY');               // round-trips
});

test('substituteYamlValue: quotes only when needed (plain scalars match Dataverse style)', () => {
  assert.match(substituteYamlValue(YML, 'SAMEORIGIN'), /^value: SAMEORIGIN$/m); // plain
  assert.match(substituteYamlValue(YML, '500'), /^value: 500$/m);               // plain number
  assert.match(substituteYamlValue(YML, 'a: b'), /^value: 'a: b'$/m);           // colon → quoted
  assert.match(substituteYamlValue(YML, "it's"), /^value: 'it''s'$/m);          // apostrophe doubled
});

test('substituteYamlValue: a $ in the value is literal (no regex backreference)', () => {
  const out = substituteYamlValue(YML, '$1.00');
  assert.equal(extractYamlValue(out), '$1.00');
});

test('substituteYamlValue: round-trips a value containing the word value', () => {
  const out = substituteYamlValue('name: X\nvalue: old\n', 'value-of-x');
  assert.equal(extractYamlValue(out), 'value-of-x');
  assert.match(out, /name: X/);
});

test('yamlScalar / unquoteYamlScalar', () => {
  assert.equal(yamlScalar('DENY'), 'DENY');
  assert.equal(yamlScalar('true'), "'true'");          // yaml keyword → quoted
  assert.equal(yamlScalar('a#b'), "'a#b'");            // comment char → quoted
  assert.equal(unquoteYamlScalar("'a''b'"), "a'b");
  assert.equal(unquoteYamlScalar('plain'), 'plain');
});

test('isFlatYmlUnit: flag, numeric type 9, or .sitesetting.yml path', () => {
  assert.equal(isFlatYmlUnit({ flatYml: true }), true);
  assert.equal(isFlatYmlUnit({ format: 'flat-yml' }), true);
  assert.equal(isFlatYmlUnit({ type: 9 }), true);
  assert.equal(isFlatYmlUnit({ type: '9' }), true);
  assert.equal(isFlatYmlUnit({ adoPath: '/x/site-settings/Foo.sitesetting.yml' }), true);
  assert.equal(isFlatYmlUnit({ type: 8, adoPath: '/x/Foo.webtemplate.source.html' }), false);
  assert.equal(isFlatYmlUnit(null), false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXml, findAll, findFirst, attr, textOf, childElements } = require('../lib/xml-lite.js');

const MANIFEST = `<?xml version="1.0" encoding="utf-8" ?>
<manifest>
  <control namespace="Contoso.Controls" constructor="StarRating" version="0.0.1" display-name-key="StarRating" control-type="standard">
    <property name="value" display-name-key="Value" of-type="Whole.None" usage="bound" required="true" />
    <resources>
      <code path="index.ts" order="1"/>
      <!-- UNCOMMENT TO ADD MORE RESOURCES
      <css path="css/StarRating.css" order="1" />
      -->
    </resources>
  </control>
</manifest>`;

test('parses a manifest and ignores resources inside a comment block', () => {
  const root = parseXml(MANIFEST);
  assert.equal(root.name, 'manifest');
  const control = findFirst(root, (e) => e.name === 'control');
  assert.equal(attr(control, 'constructor'), 'StarRating');
  const res = findFirst(root, (e) => e.name === 'resources');
  assert.deepEqual(childElements(res).map((e) => e.name), ['code']);
});

test('attribute dictionaries do not inherit Object prototype members', () => {
  const root = parseXml('<control namespace="Contoso.Controls" />');

  assert.equal(attr(root, 'constructor'), undefined);
  assert.equal(attr(root, 'toString'), undefined);
});

test('decodes entities and keeps CDATA raw; attribute lookup can be case-insensitive', () => {
  const root = parseXml('<a X="1 &amp; 2"><b><![CDATA[<raw>&amp;]]></b><c>&#x41;&#66;&lt;</c></a>');
  assert.equal(attr(root, 'x', { caseInsensitive: true }), '1 & 2');
  assert.equal(textOf(findFirst(root, (e) => e.name === 'b')), '<raw>&amp;');
  assert.equal(textOf(findFirst(root, (e) => e.name === 'c')), 'AB<');
});

test('does not expand a DOCTYPE entity (XXE-safe)', () => {
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>'), /entity/i);
});

test('reports line and column for a mismatched tag', () => {
  assert.throws(() => parseXml('<a>\n  <b></c>\n</a>'), (e) => e.name === 'XmlError' && e.line === 2);
});

test('rejects duplicate attributes and text after the root', () => {
  assert.throws(() => parseXml('<a x="1" x="2"/>'), /duplicate/i);
  assert.throws(() => parseXml('<a/>trailing'), /after the root/i);
});

test('rejects raw less-than signs inside attribute values with XmlError location', () => {
  assert.throws(
    () => parseXml('<a x="bad<value"/>'),
    (e) => e.name === 'XmlError' && e.line === 1 && e.column === 10 && /attribute value/i.test(e.message)
  );
});

test('rejects invalid numeric character references with XmlError location', () => {
  for (const value of ['&#x110000;', '&#xD800;', '&#;', '&#xZZ;']) {
    assert.throws(
      () => parseXml(`<a>\n  ${value}\n</a>`),
      (e) => e.name === 'XmlError' && e.line === 2 && e.column === 3 && /entity|character reference/i.test(e.message),
      value
    );
  }
});

test('findAll includes the root when it matches and returns document order', () => {
  const root = parseXml('<f><c id="1"/><x><c id="2"/></x><c id="3"/></f>');
  assert.deepEqual(findAll(root, (e) => e.name === 'f' || e.name === 'c').map((e) => e.name === 'f' ? 'root' : attr(e, 'id')), ['root', '1', '2', '3']);
});

test('parses a large form document', () => {
  const cells = Array.from({ length: 4000 }, (_, i) => `<cell id="{${i}}"><control id="f${i}" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="f${i}"/></cell>`).join('');
  const root = parseXml(`<form><tabs><tab><columns><column><sections><section><rows><row>${cells}</row></rows></section></sections></column></columns></tab></tabs></form>`);
  assert.equal(findAll(root, (e) => e.name === 'cell').length, 4000);
});

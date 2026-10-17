'use strict';
// Tests of the strict XML reader (lib/strict-xml.js): what it accepts and what it refuses, what it answers, and what it costs. The generated corpus that holds it to the SDK's own parser is in
// strict-xml-oracle.test.js; what a page is deleted by is in sitemap-pages.test.js and teardown-navigation-proof-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { readXmlElements, XML_PREDEFINED } = require('../lib/strict-xml.js');

const all = () => true;
const ok = (xml, wanted = all) => {
  const r = readXmlElements(xml, wanted);
  assert.strictEqual(r.ok, true, `${JSON.stringify(xml)}: ${r.detail}`);
  return r.elements;
};
const refused = (xml) => {
  const r = readXmlElements(xml, all);
  assert.strictEqual(r.ok, false, `${JSON.stringify(xml)} was read`);
  assert.deepStrictEqual(Object.keys(r).sort(), ['detail', 'ok'], 'a document that is not read answers no element at all');
  return r.detail;
};

test('readXmlElements: it answers the elements the caller asks for, in document order, with their path and their decoded attributes', () => {
  const xml = '<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="1" GenPageId="x"/><Other><SubArea Id="2"/></Other><SubArea Id="3"></SubArea></Group></Area><SubArea Id="4"/></SiteMap>';
  const found = ok(xml, (name) => name === 'SubArea');
  assert.deepStrictEqual(found.map((e) => [e.name, e.path, e.attrs.Id]), [
    ['SubArea', 'SiteMap/Area/Group', '1'],
    ['SubArea', 'SiteMap/Area/Group/Other', '2'],
    ['SubArea', 'SiteMap/Area/Group', '3'],
    ['SubArea', 'SiteMap', '4'],
  ]);
  assert.deepStrictEqual({ ...found[0].attrs }, { Id: '1', GenPageId: 'x' });
  assert.strictEqual(Object.getPrototypeOf(found[0].attrs), null, 'no prototype: an attribute called constructor or __proto__ is an attribute');
  assert.deepStrictEqual(ok(xml, (name) => name === 'SiteMap').map((e) => e.path), [''], 'the root has no path');
  assert.deepStrictEqual(ok(xml, () => false), []);
  // An attribute named like a member of Object.prototype is not read here at all: the SDK's parser (xmldom) keeps a tag's attribute names in a plain object and cannot read some such
  // documents, so none is one a page may be deleted on. (The map above has no prototype, so such a name could never confuse this reader itself.)
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.match(refused(`<a ${name}="1" b="2"/>`), new RegExp(`an attribute named ${name}, which the SDK's parser cannot read`), name);
  }
});

// `spans` is for a caller that must take elements OUT of the text and compare what is left (formxml-layers.js: a dashboard's saved and published FormXML, without
// the labels of a language one read does not carry). Where an element is comes from the reader, so markup that is data is never one.
test('readXmlElements { spans: true }: each element answered says where it is in the text, from its "<" to the end of its empty-element tag or of its end tag', () => {
  const xml = '\uFEFF<?xml version="1.0"?>\n<form><labels><label description="a &gt; b" languagecode="1033" /><label description=\'x\' languagecode="3082"></label>'
    + '\r\n<label languagecode="1036">t<b/></label></labels><!-- <label languagecode="1036"/> --><x a="/>"><![CDATA[<label/>]]><?p <label/> ?></x ></form>';
  const r = readXmlElements(xml, (name) => name === 'label', { spans: true });
  assert.strictEqual(r.ok, true, r.detail);
  assert.deepStrictEqual(r.elements.map((e) => [e.path, xml.slice(e.start, e.end)]), [
    ['form/labels', '<label description="a &gt; b" languagecode="1033" />'],
    ['form/labels', "<label description='x' languagecode=\"3082\"></label>"],
    ['form/labels', '<label languagecode="1036">t<b/></label>'],
  ], 'a comment, a CDATA section and a processing instruction are data, and a ">" in a value ends nothing');
  assert.deepStrictEqual(readXmlElements(xml, (name) => name === 'x', { spans: true }).elements.map((e) => xml.slice(e.start, e.end)),
    ['<x a="/>"><![CDATA[<label/>]]><?p <label/> ?></x >'], 'an end tag with white space before its ">" ends at the ">"');
  assert.deepStrictEqual({ ...r.elements[0].attrs }, { description: 'a > b', languagecode: '1033' }, 'with the attributes, as without it');
  // An element inside another of the same name: the outer one spans the inner one.
  const nested = '<a><b x="1"><b/></b><b></b></a>';
  assert.deepStrictEqual(readXmlElements(nested, (name) => name === 'b', { spans: true }).elements.map((e) => [e.path, nested.slice(e.start, e.end)]),
    [['a', '<b x="1"><b/></b>'], ['a/b', '<b/>'], ['a', '<b></b>']]);
  assert.deepStrictEqual(readXmlElements('<r/>', () => true, { spans: true }).elements.map((e) => [e.start, e.end]), [[0, 4]], 'the root, an empty-element tag');
  // Without it the answer is what it always was: the name, the path and the attributes, and nothing else.
  for (const options of [undefined, {}, { spans: false }]) {
    assert.deepStrictEqual(readXmlElements(xml, () => true, options).elements.map((e) => Object.keys(e)), Array(7).fill(['name', 'path', 'attrs']), JSON.stringify(options));
  }
  // A document that is not read answers no element, with it as without it.
  const bad = readXmlElements('<a><label/><b></a>', () => true, { spans: true });
  assert.deepStrictEqual(Object.keys(bad).sort(), ['detail', 'ok']);
  assert.match(bad.detail, /closing tag <\/a> where <\/b> is expected/);
});

test('readXmlElements: a document that is not read answers no element — not the ones before the fault — and says what is wrong and where', () => {
  const detail = refused('<a>\n  <b x="1"/>\r\n  <c y="2"></d>\n</a>');
  assert.match(detail, /closing tag <\/d> where <\/c> is expected, at line 3, column 12/);
  assert.match(refused(''), /no root element, at line 1, column 1/);
  assert.match(refused(undefined), /not text/);
  assert.match(refused(null), /not text/);
  assert.match(refused(42), /not text/);
  assert.match(refused('<a>\r<b/>\r</a> text'), /text after the root element, at line 3, column 6/, 'a lone CR ends a line');
  assert.match(refused('<a>\r\n\r\n<b x=1/></a>'), /at line 3, column 6/, 'CR LF ends one line');
});

test('readXmlElements: attribute values are decoded as an XML parser decodes them — references, and the white space written in a value', () => {
  const [e] = ok('<a q="&lt;&gt;&amp;&quot;&apos;" n="&#65;&#x42;&#x1F600;" s=\'x &amp;lt; y\' t="a\tb\nc\r\nd\re" r="a&#9;b&#10;c&#13;d" e="" b="--&gt; ]]&gt; > ?>"/>');
  assert.strictEqual(e.attrs.q, '<>&"\'');
  assert.strictEqual(e.attrs.n, 'AB\u{1F600}', 'decimal, hex and a character beyond U+FFFF');
  assert.strictEqual(e.attrs.s, 'x &lt; y', 'one pass: a decoded "&" starts nothing');
  assert.strictEqual(e.attrs.t, 'a b c d e', 'a tab, a line feed, CR LF (one) and a lone CR in the text of a value are one space each');
  assert.strictEqual(e.attrs.r, 'a\tb\nc\rd', 'but a character written as a reference is that character');
  assert.strictEqual(e.attrs.e, '');
  assert.strictEqual(e.attrs.b, '--> ]]> > ?>', '">" and "]]>" are legal in a value');
  assert.strictEqual(XML_PREDEFINED.lt, '<');
  assert.deepStrictEqual(Object.keys(XML_PREDEFINED), ['lt', 'gt', 'amp', 'quot', 'apos']);
  assert.ok(Object.isFrozen(XML_PREDEFINED));
});

// Documents that are well-formed XML, in the shapes a platform, a serializer or a person may write them.
const WELL_FORMED = [
  ['an empty root', '<a/>'],
  ['an empty root with a start and an end tag', '<a></a>'],
  ['white space inside tags, around "=", and an end tag with white space', '<a\n\t b = "1"\r\n c=\'2\'\t><b\r\n/></a\n>'],
  ['text and references in content', '<a>text &amp; &#38; &#x26; &lt;b&gt; ]] > ] ]] </a>'],
  ['nested elements and siblings', '<a><b><c/></b><b/><d></d></a>'],
  ['comments, processing instructions and white space around the root', '\n<!-- c --><?pi data?> <a/> <!-- c -->\n<?pi?>\t'],
  ['an empty comment, an empty CDATA section, a comment that starts with a ">" and one with a single "-"', '<a><!----><![CDATA[]]><!--> x--><!-- a-b --></a>'],
  ['a CDATA section that holds markup and the markers of everything', '<a><![CDATA[ <b> </a> <!-- <? ?> --> ]] ]> ]]></a>'],
  ['a processing instruction that holds markup', '<a><?pi <b/> <!-- ]]> ?></a>'],
  ['a comment that holds markup', '<a><!-- <b/> <![CDATA[ <?x ?> ]]> --></a>'],
  ['a byte order mark and an XML declaration', '\uFEFF<?xml version="1.0" encoding="utf-8" standalone="yes"?>\r\n<a/>'],
  ['an XML declaration in single quotes with only a version', "<?xml version='1.0'?><a/>"],
  ['a processing instruction whose target starts with xml', '<?xml-stylesheet href="x"?><a/>'],
  ['names with colons, dots, dashes, digits and non-ASCII letters', '<a:b c.d-e_1="1" xml:space="preserve" ü="2"><保存/><Ü1/></a:b>'],
  ['namespace declarations', '<a xmlns="urn:x" xmlns:m="urn:y" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><m:b/></a>'],
  ['a prefix that is not declared (a name is a name here)', '<m:a><m:b/></m:a>'],
  ['an element named script in no namespace, holding a CDATA section with its own end tag', '<a><script><![CDATA[ </script> ]]></script></a>'],
  ['an element of the XHTML namespace that is not script or textarea', '<a xmlns="http://www.w3.org/1999/xhtml"><p>text</p><b/></a>'],
  ['a self-closing script in the XHTML namespace', '<a xmlns="http://www.w3.org/1999/xhtml"><script/></a>'],
  ['an end tag with white space, for a name that has no other end tag', '<a><b></b ><c></c></a >'],
  ['every end tag of a name with white space before its ">"', '<a><b x="1"></b ><b x="2"></b >\n</a>'],
  ['an exact end tag text after the last start tag of its name', '<a><b></b ><b></b ><!-- </b> --></a>'],
  ['CR LF, CR and LF line ends in the content', '<a>\r\n<b/>\r<c/>\n</a>'],
  ['a long attribute value and long text', `<a v="${'x'.repeat(100000)}">${'y'.repeat(100000)}</a>`],
  ['a character beyond U+FFFF in text and in a value', '<a v="\u{1F600}">\u{1F600}</a>'],
  ['a name that is a prefix of another', '<a><ab/><a1></a1></a>'],
];
for (const [what, xml] of WELL_FORMED) {
  test(`readXmlElements reads a well-formed document: ${what}`, () => {
    ok(xml);
  });
}

// Documents that are not one well-formed XML document, or that this reader does not understand — each is "not readable". [what, document, the words its detail has].
const NOT_READ = [
  ['no text', '', /no root element/],
  ['white space only', ' \r\n\t ', /no root element/],
  ['only a comment', '<!-- a -->', /no root element/],
  ['only a processing instruction', '<?a b?>', /no root element/],
  ['text before the root', 'x<a/>', /text before the root element/],
  ['text after the root', '<a/>x', /text after the root element/],
  ['a character reference outside the root', '&#65;<a/>', /text before the root element/],
  ['a second root', '<a/><b/>', /second root element/],
  ['a second root after a comment', '<a/><!-- c --><b/>', /second root element/],
  ['a second root with a closing tag', '<a></a><a></a>', /second root element/],
  ['a closing tag after the root', '<a/></a>', /no element open/],
  ['a closing tag before the root', '</a><a/>', /no element open/],
  ['a CDATA section before the root', '<![CDATA[x]]><a/>', /CDATA section outside the root element/],
  ['a CDATA section after the root', '<a/><![CDATA[x]]>', /CDATA section outside the root element/],
  ['an element never closed', '<a><b></a>', /closing tag <\/a> where <\/b> is expected/],
  ['an element never closed, at the end', '<a><b>', /element <b> is never closed/],
  ['a start tag cut short', '<a><b x="1"', /tag that is never closed/],
  ['a start tag cut after its name', '<a', /tag that is never closed/],
  ['an attribute value cut short', '<a b="1', /attribute value that is never closed/],
  ['an end tag cut short', '<a></a', /closing tag that holds more than the element name/],
  ['a mismatched end tag', '<a><b></a></b>', /closing tag <\/a> where <\/b> is expected/],
  ['an end tag that differs in case', '<a></A>', /closing tag <\/A> where <\/a> is expected/],
  ['an end tag with an attribute', '<a></a b="1">', /holds more than the element name/],
  ['an end tag with text', '<a></a x>', /holds more than the element name/],
  ['an end tag with no name', '<a></>', /no element name/],
  ['a slash that does not close the tag', '<a / >', /not followed by ">"/],
  ['a slash inside a tag', '<a b="1" / ></a>', /not followed by ">"/],
  ['an attribute with no value', '<a b/>', /no value/],
  ['an attribute with no value before another', '<a b c="1"/>', /no value/],
  ['an attribute with no "="', '<a b "1"/>', /no value/],
  ['an unquoted value', '<a b=1/>', /not in quotes/],
  ['a missing value', '<a b=/>', /not in quotes/],
  ['a value that starts with a different quote than it ends', '<a b="1\'/>', /never closed/],
  ['attributes with no white space between them', '<a b="1"c="2"/>', /not separated by white space/],
  ['a name with no white space before the first attribute', '<ab="1"/>', /not separated by white space/],
  ['an attribute twice', '<a b="1" b="2"/>', /attribute b twice/],
  ['an attribute twice in different quotes', '<a b="1" b=\'1\'/>', /attribute b twice/],
  ['a "<" in a value', '<a b="<"/>', /"<" inside an attribute value/],
  ['a "<" in a value in single quotes', "<a b='x<y'/>", /"<" inside an attribute value/],
  ['a "<" that starts nothing', '<a> < </a>', /starts no element/],
  ['a "<" before a digit', '<a><1/></a>', /starts no element/],
  ['a bare ampersand', '<a>a & b</a>', /not one of the predefined entities/],
  ['a bare ampersand in a value', '<a b="a & b"/>', /not one of the predefined entities/],
  ['an ampersand with no semicolon', '<a>&amp</a>', /not one of the predefined entities/],
  ['an entity that is not predefined', '<a>&nbsp;</a>', /not one of the predefined entities/],
  ['an entity of the wrong case', '<a>&AMP;</a>', /not one of the predefined entities/],
  ['an entity with white space', '<a>& amp;</a>', /not one of the predefined entities/],
  ['an empty character reference', '<a>&#;</a>', /neither &#digits; nor &#xhexdigits;/],
  ['an empty hex reference', '<a>&#x;</a>', /neither &#digits; nor &#xhexdigits;/],
  ['a hex reference with an upper-case X', '<a>&#X41;</a>', /neither &#digits; nor &#xhexdigits;/],
  ['a hex digit in a decimal reference', '<a>&#4a;</a>', /neither &#digits; nor &#xhexdigits;/],
  ['a character reference with no semicolon', '<a>&#65</a>', /neither &#digits; nor &#xhexdigits;/],
  ['a reference to NUL', '<a>&#0;</a>', /character that XML does not allow/],
  ['a reference to a control character', '<a b="&#x1;"/>', /character that XML does not allow/],
  ['a reference to a surrogate', '<a>&#xD800;</a>', /character that XML does not allow/],
  ['a reference to U+FFFE', '<a>&#xFFFE;</a>', /character that XML does not allow/],
  ['a reference beyond U+10FFFF', '<a>&#x110000;</a>', /character that XML does not allow/],
  ['a reference of absurd length', `<a>&#${'9'.repeat(500)};</a>`, /character that XML does not allow/],
  ['"]]>" in text', '<a>x ]]> y</a>', /\]\]> in character data/],
  ['"]]>" right after a reference', '<a>&amp;]]></a>', /\]\]> in character data/],
  ['"--" in a comment', '<a><!-- a -- b --></a>', /'--' inside a comment/],
  ['a comment that ends in three dashes', '<a><!-- a ---></a>', /'--' inside a comment/],
  ['a comment that never ends', '<a><!-- a', /comment that is never closed/],
  ['a comment that is not one', '<a><!- a --></a>', /neither a comment nor a CDATA section/],
  ['a CDATA section that never ends', '<a><![CDATA[ a ]]', /CDATA section that is never closed/],
  ['a misspelled CDATA section', '<a><![cdata[ a ]]></a>', /neither a comment nor a CDATA section/],
  ['a processing instruction that never ends', '<a><?p a', /processing instruction that is never closed/],
  ['a processing instruction with no target', '<a><? a ?></a>', /no target/],
  ['an empty processing instruction', '<a><?></a>', /no target/],
  ['a processing instruction whose target runs into its data', '<a><?pi?x?></a>', /not followed by white space/],
  ['a processing instruction target with a colon', '<a><?p:q x?></a>', /not followed by white space/],
  ['a processing instruction named xml inside the root', '<a><?xml version="1.0"?></a>', /named "xml"/],
  ['a processing instruction named XML', '<a><?XML x?></a>', /named "xml"/],
  ['an XML declaration after white space', ' <?xml version="1.0"?><a/>', /named "xml"/],
  ['an XML declaration after a comment', '<!-- c --><?xml version="1.0"?><a/>', /named "xml"/],
  ['two XML declarations', '<?xml version="1.0"?><?xml version="1.0"?><a/>', /named "xml"/],
  ['an XML declaration with no version', '<?xml encoding="utf-8"?><a/>', /XML declaration that is not/],
  ['an XML declaration of version 1.1', '<?xml version="1.1"?><a/>', /XML declaration that is not/],
  ['an XML declaration with its parts in the wrong order', '<?xml encoding="utf-8" version="1.0"?><a/>', /XML declaration that is not/],
  ['an XML declaration with a bad standalone', '<?xml version="1.0" standalone="maybe"?><a/>', /XML declaration that is not/],
  ['an XML declaration that never ends', '<?xml version="1.0"', /XML declaration that is never closed/],
  ['a document type declaration', '<!DOCTYPE a><a/>', /document type declaration/],
  ['a document type declaration with an internal subset', '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>', /document type declaration/],
  ['a document type declaration in the root', '<a><!DOCTYPE b></a>', /document type declaration/],
  ['an element declaration', '<a><!ELEMENT b EMPTY></a>', /neither a comment nor a CDATA section/],
  ['a conditional section', '<a><![INCLUDE[ x ]]></a>', /neither a comment nor a CDATA section/],
  ['a name with two colons', '<a:b:c/>', /not separated by white space/],
  ['an attribute name with two colons', '<a b:c:d="1"/>', /no value/],
  ['a name that starts with a colon', '<:a/>', /starts no element/],
  ['a name that starts with a digit', '<1a/>', /starts no element/],
  ['a name that starts with a dash', '<-a/>', /starts no element/],
  ['a name that ends in a colon', '<a:/>', /not separated by white space/],
  ['a name with a character beyond U+FFFF', '<\u{10000}a/>', /starts no element/],
  ['a name with a special character (U+FEFF)', '<a\uFEFFb/>', /not separated by white space/],
  ['a name with a symbol (U+2192)', '<a\u2192b/>', /not separated by white space/],
  ['a name with white space that is not XML white space (U+00A0)', '<a\u00A0b="1"/>', /not separated by white space/],
  ['a start tag with a quote in it', '<a "b"/>', /not an attribute/],
  ['an equals sign where a name should be', '<a ="1"/>', /not an attribute/],
  ['a control character in text', '<a>x\u0001y</a>', /character that XML does not allow/],
  ['NUL in a value', '<a b="\u0000"/>', /character that XML does not allow/],
  ['a lone high surrogate', '<a>\uD800</a>', /character that XML does not allow/],
  ['a lone low surrogate', '<a>\uDC00x</a>', /character that XML does not allow/],
  ['U+FFFE', '<a>\uFFFE</a>', /character that XML does not allow/],
  ['U+FFFF in a comment', '<a><!-- \uFFFF --></a>', /character that XML does not allow/],
  ['a control character in a processing instruction', '<a><?p \u0008?></a>', /character that XML does not allow/],
  ['a byte order mark that is not first', ' \uFEFF<a/>', /text before the root element/],
  ['a byte order mark and then another one', '\uFEFF\uFEFF<a/>', /text before the root element/],
  // What the SDK's parser misreads (see the oracle test): a document that is well-formed XML and is not read because that parser does not read it as XML does.
  ['end tags of one name that mix "</b>" and "</b >"', '<a><b x="1"></b><b x="2"></b ></a>', /cannot be found by the SDK's parser/],
  ['a "</b>" in a comment before the last start tag of b, with the real end tags written "</b >"', '<a><b></b ><!-- </b> --><b></b ></a>', /cannot be found by the SDK's parser/],
  ['a "</b>" in a CDATA section before the last start tag of b', '<a><b></b ><![CDATA[ </b> ]]><b></b ></a>', /cannot be found by the SDK's parser/],
  ['a "</b>" in a processing instruction before the last start tag of b', '<a><b></b ><?p </b> ?><b></b ></a>', /cannot be found by the SDK's parser/],
  ['an XHTML script element', '<a xmlns="http://www.w3.org/1999/xhtml"><script>x</script></a>', /XHTML <script> element/],
  ['an XHTML script element that holds a CDATA section with its own end tag', '<a xmlns="http://www.w3.org/1999/xhtml"><script><![CDATA[ </script> ]]></script><b/></a>', /XHTML <script> element/],
  ['an XHTML textarea element', '<a><textarea xmlns="http://www.w3.org/1999/xhtml">x</textarea></a>', /XHTML <textarea> element/],
  ['an XHTML SCRIPT element in upper case', '<a xmlns="http://www.w3.org/1999/xhtml"><SCRIPT></SCRIPT></a>', /XHTML <SCRIPT> element/],
  ['an XHTML script element that inherits its namespace from a distant ancestor', '<a xmlns="http://www.w3.org/1999/xhtml"><b><c><script/></c><script>x</script></b></a>', /XHTML <script> element/],
];
for (const [what, xml, detail] of NOT_READ) {
  test(`readXmlElements does not read: ${what}`, () => {
    assert.match(refused(xml), detail);
  });
}

test('readXmlElements: a document that is well-formed but read differently by the SDK\'s parser is refused only when nothing is wrong with it as XML — a document that is not well-formed says so', () => {
  assert.match(refused('<a><b x="1"></b><b x="2"></b ><c></d></a>'), /closing tag <\/d> where <\/c> is expected/);
  assert.match(refused('<a xmlns="http://www.w3.org/1999/xhtml"><script>x</script><b x=1/></a>'), /not in quotes/);
});

test('readXmlElements: the namespace an XHTML check goes by is the one in scope — a script in another namespace, a default namespace that is reset, a prefixed script and a sibling of an XHTML element are read', () => {
  ok('<a xmlns="urn:x"><script>x</script></a>');
  ok('<a xmlns="http://www.w3.org/1999/xhtml"><b xmlns=""><script>x</script></b></a>');
  ok('<a xmlns:h="http://www.w3.org/1999/xhtml"><h:script>x</h:script></a>');
  ok('<a><b xmlns="http://www.w3.org/1999/xhtml"><p/></b><script>x</script></a>');
  assert.match(refused('<a><b xmlns="http://www.w3.org/1999/xhtml"><b xmlns="urn:x"/><script>x</script></b></a>'), /XHTML <script> element/);
});

test('readXmlElements: it is linear — a large flat document and a deeply nested one are read at once, and a document of many kinds of element is bounded', () => {
  const flat = `<SiteMap><Area><Group>${'<SubArea Id="s" GenPageId="11111111-1111-4111-8111-111111111111" Title="Page &amp; Page"/>'.repeat(20000)}</Group></Area></SiteMap>`;
  let started = Date.now();
  assert.strictEqual(ok(flat, (name) => name === 'SubArea').length, 20000);
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms for ${flat.length} characters`);

  const depth = 50000;
  const nested = `${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`;
  started = Date.now();
  assert.strictEqual(ok(nested, () => false).length, 0, 'no recursion: a nesting depth costs one array slot');
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms for ${depth} levels`);
  assert.strictEqual(ok(`${'<a>'.repeat(depth)}<b/>${'</a>'.repeat(depth)}`, (name) => name === 'b')[0].path.split('/').length, depth);

  const kinds = (count) => `<r>${Array.from({ length: count }, (_, i) => `<k${i}>x</k${i}>`).join('')}</r>`;
  assert.strictEqual(ok(kinds(200)).length, 201);
  assert.match(refused(kinds(300)), /more than 256 different element names/);

  const aLot = `<a>${'&#38;'.repeat(100000)}${'<!-- x -->'.repeat(20000)}${'<![CDATA[x]]>'.repeat(20000)}${'<?p x?>'.repeat(20000)}</a>`;
  started = Date.now();
  ok(aLot);
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms for ${aLot.length} characters of references, comments, CDATA and PIs`);
});

test('readXmlElements: it never reads past a refusal, so a hostile document cannot make it slow — text that is nothing but "<" or "&" is refused at once', () => {
  const started = Date.now();
  for (const xml of [`<a>${'<'.repeat(200000)}`, `<a>${'&'.repeat(200000)}`, `<a ${'b="1" '.repeat(1000)}>`, `<${'a'.repeat(200000)} `, `<a b="${'&amp;'.repeat(100000)}`, '<a>'.repeat(10000)]) readXmlElements(xml, all);
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
});

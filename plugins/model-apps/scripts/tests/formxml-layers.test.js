'use strict';
// Tests of lib/formxml-layers.js: whether the SAVED FormXML of a systemform (a dashboard's, as verify reads it) is its PUBLISHED one when
// the two reads carry the labels of different languages. What verify does with the answer — the dashboard's tiles, read only when it is
// yes — is tested through the reader itself in verify-model-app.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { sameFormXmlAcrossLayers } = require('../lib/formxml-layers.js');

// A dashboard's FormXML in the shape the platform answers it: a tab and a section with a caption each, and cells whose captions are
// in their <labels>, each followed by the tile's control. `extra` is more labels for that cell, after its 1033 caption.
const cell = (caption, extra = '', view = '11111111-0000-4000-8000-000000000001') => `<cell id="{c-${caption}}" colspan="1" rowspan="1" showlabel="true">`
  + `<labels><label description="${caption}" languagecode="1033" />${extra}</labels>`
  + `<control id="{k-${caption}}" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}"><parameters><TargetEntityType>new_ticket</TargetEntityType><ViewId>${view}</ViewId></parameters></control></cell>`;
const form = (cells, tabExtra = '') => '<form><tabs><tab id="{t}" name="General" showlabel="true"><labels><label description="" languagecode="1033" />'
  + `${tabExtra}</labels><columns><column width="100%"><sections><section id="{s}" name="Section 1" showlabel="false" columns="2"><labels>`
  + `<label description="" languagecode="1033" /></labels><rows><row>${cells.join('')}</row></rows></section></sections></column></columns></tab></tabs></form>`;
const label = (lcid, text = 'Órdenes') => `<label description="${text}" languagecode="${lcid}" />`;
const PUBLISHED = form([cell('By Priority'), cell('Open')]);
const same = (published, saved) => sameFormXmlAcrossLayers(published, saved);

test('sameFormXmlAcrossLayers: two equal texts are the same document, as they always were — nothing is parsed', () => {
  assert.strictEqual(same(PUBLISHED, PUBLISHED), true);
  // Equal bytes cannot be two documents, whatever they hold: what is in them is for the reader of the tiles to say, as before.
  for (const text of ['<form>', 'not xml', '']) assert.strictEqual(same(text, text), true, JSON.stringify(text));
  for (const [published, saved] of [[null, null], [undefined, PUBLISHED], [PUBLISHED, undefined], [42, 42], [{}, PUBLISHED]]) {
    assert.strictEqual(same(published, saved), false, 'a read that is not text is no FormXML');
  }
});

test('sameFormXmlAcrossLayers: a saved read that is the published one plus labels in languages the published read carries none of is the published one', () => {
  // The live shape: a 3082 caption beside each cell's 1033 one, in the saved read only.
  assert.strictEqual(same(PUBLISHED, form([cell('By Priority', label(3082)), cell('Open', label(3082))])), true);
  // Before the base-language label, on a tab or a section, in two languages, and on some cells only: each is a label the published read could not show.
  assert.strictEqual(same(PUBLISHED, form([cell('By Priority', label(3082)), cell('Open')], label(3082))), true);
  assert.strictEqual(same(PUBLISHED, form([cell('By Priority', label(3082) + label(1036, 'Ordres')), cell('Open', label(1036, 'Ouvert'))])), true);
  assert.strictEqual(same(PUBLISHED, PUBLISHED.replace('<labels><label description="By Priority" languagecode="1033" />', `<labels>${label(3082)}<label description="By Priority" languagecode="1033" />`)), true);
  // A language is the LCID the label names, however it is written: " 3082 " is 3082.
  assert.strictEqual(same(PUBLISHED, form([cell('By Priority', '<label description="x" languagecode=" 3082 " />'), cell('Open')])), true);
  // A published read that carries two languages sets aside a third.
  const bilingual = form([cell('By Priority', label(3082)), cell('Open', label(3082))]);
  assert.strictEqual(same(bilingual, form([cell('By Priority', label(3082) + label(1036, 'Ordres')), cell('Open', label(3082))])), true);
});

test('sameFormXmlAcrossLayers: anything else that differs is a difference — a tile, a cell, an element, an attribute, a text, a caption in a language the published read carries', () => {
  const es = label(3082);
  for (const [what, saved] of [
    ['a cell added', form([cell('By Priority', es), cell('Open', es), cell('Closed', es)])],
    ['a cell removed', form([cell('By Priority', es)])],
    ['two cells swapped', form([cell('Open', es), cell('By Priority', es)])],
    ['a tile\u2019s view', form([cell('By Priority', es, '11111111-0000-4000-8000-000000000002'), cell('Open', es)])],
    ['a 1033 caption', form([cell('By Owner', es), cell('Open', es)])],
    ['a 1033 caption removed', form([cell('By Priority', es), cell('Open', es)]).replace('<label description="Open" languagecode="1033" />', '')],
    ['a 1033 caption added', form([cell('By Priority', es + label(1033, 'Second')), cell('Open', es)])],
    ['an attribute changed', form([cell('By Priority', es), cell('Open', es)]).replace('columns="2"', 'columns="1"')],
    ['an attribute added', form([cell('By Priority', es), cell('Open', es)]).replace('name="General"', 'name="General" visible="false"')],
    ['an element added', form([cell('By Priority', es), cell('Open', es)]).replace('</parameters>', '<RecordsPerPage>10</RecordsPerPage></parameters>')],
    ['a comment added', form([cell('By Priority', es), cell('Open', es)]).replace('<rows>', '<!-- x --><rows>')],
  ]) {
    assert.strictEqual(same(PUBLISHED, saved), false, what);
  }
  // A published read that carries 3082 too: its 3082 captions are compared like any other — changed, removed or added.
  const bilingual = form([cell('By Priority', es), cell('Open', es)]);
  for (const [what, saved] of [
    ['a 3082 caption changed', form([cell('By Priority', label(3082, 'Pedidos')), cell('Open', es)])],
    ['a 3082 caption removed', form([cell('By Priority', es), cell('Open')])],
    ['a 3082 caption added', form([cell('By Priority', es + label(3082, 'Otra')), cell('Open', es)])],
  ]) {
    assert.strictEqual(same(bilingual, saved), false, what);
  }
  // A language the published read carries ANYWHERE is compared everywhere: a 3082 label on its tab makes a cell's 3082 caption a change.
  assert.strictEqual(same(form([cell('By Priority'), cell('Open')], label(3082)), form([cell('By Priority', es), cell('Open')], label(3082))), false);
});

test('sameFormXmlAcrossLayers: only a label the platform writes — an empty <label … /> of a <labels>, in a language named by a valid LCID — is set aside', () => {
  for (const [what, extra] of [
    ['a label with content', '<label description="x" languagecode="3082"><x/></label>'],
    ['a label with text', '<label languagecode="3082">x</label>'],
    ['an empty label written with an end tag', '<label description="x" languagecode="3082"></label>'],
    ['a label with no language', '<label description="x" />'],
    ['a label whose language is no LCID', '<label description="x" languagecode="es-ES" />'],
    ['a label whose language is empty', '<label description="x" languagecode="" />'],
    ['a label whose language is 0', '<label description="x" languagecode="0" />'],
    ['a label whose language is beyond an LCID', '<label description="x" languagecode="65536" />'],
    ['a label whose language attribute is spelled otherwise', '<label description="x" LanguageCode="3082" />'],
  ]) {
    assert.strictEqual(same(PUBLISHED, form([cell('By Priority', extra), cell('Open')])), false, what);
  }
  // A <label> that is not a <labels> element's — here, a tile's parameter — is not a caption: it is compared.
  const parameter = PUBLISHED.replace('</parameters>', '<label languagecode="3082" description="x" /></parameters>');
  assert.strictEqual(same(PUBLISHED, parameter), false, 'a label outside <labels>');
  // Markup that only looks like a label — in a comment, a CDATA section, an attribute value — is text, and compared.
  assert.strictEqual(same(PUBLISHED, PUBLISHED.replace('<rows>', '<!-- <label description="x" languagecode="3082" /> --><rows>')), false, 'in a comment');
  assert.strictEqual(same(PUBLISHED, PUBLISHED.replace('<ViewId>', '<ViewId><![CDATA[<label languagecode="3082"/>]]>')), false, 'in a CDATA section');
});

test('sameFormXmlAcrossLayers: a published read that carries no language at all sets nothing aside — it does not say which it shows', () => {
  const noLanguage = (xml) => xml.replace(/ languagecode="1033"/g, '');
  assert.strictEqual(same(noLanguage(PUBLISHED), noLanguage(form([cell('By Priority', label(3082)), cell('Open')]))), false, 'labels that name no language');
  const bare = '<form><tabs><tab name="General"><columns><column><sections><section name="s"><rows><row><cell id="{c}"><control id="{k}" /></cell></row></rows></section></sections></column></columns></tab></tabs></form>';
  assert.strictEqual(same(bare, bare.replace('<control', `<labels>${label(3082)}</labels><control`)), false, 'no label at all');
});

test('sameFormXmlAcrossLayers: a FormXML that is not one well-formed XML document, on either side, is a difference — never the same document', () => {
  const saved = form([cell('By Priority', label(3082)), cell('Open', label(3082))]);
  for (const [what, published, other] of [
    ['a saved read with a label left open', PUBLISHED, saved.replace('languagecode="3082" />', 'languagecode="3082">')],
    ['a saved read with a bare "&"', PUBLISHED, saved.replace('Órdenes', 'Órdenes & co')],
    ['a saved read with a second root element', PUBLISHED, `${saved}<form/>`],
    ['a saved read with a document type declaration', PUBLISHED, `<!DOCTYPE form>${saved}`],
    ['a published read cut short', PUBLISHED.slice(0, -1), saved.slice(0, -1)],
    ['a published read with an end tag missing', PUBLISHED.replace('</rows>', ''), saved.replace('</rows>', '')],
    ['a published read that is no XML', 'not xml', saved],
    ['an empty saved read', PUBLISHED, ''],
  ]) {
    assert.strictEqual(same(published, other), false, what);
  }
});

test('sameFormXmlAcrossLayers: what is left is compared as text, byte for byte, as before — only a label\u2019s own tag is set aside', () => {
  const es = label(3082);
  // Quote style, attribute order and white space are the text's, and a difference in them is one, as it was.
  assert.strictEqual(same(PUBLISHED, form([cell('By Priority', es), cell('Open', es)]).replace('name="General"', "name='General'")), false, 'quote style');
  assert.strictEqual(same(PUBLISHED, form([cell('By Priority', es), cell('Open', es)]).replace('showlabel="true"><labels>', 'showlabel="true" ><labels>')), false, 'white space in a tag');
  // The white space around a label set aside stays: a read laid out on lines is not one with the label's line taken out.
  assert.strictEqual(same(PUBLISHED, form([cell('By Priority', `\n  ${es}`), cell('Open')])), false, 'the line a label was on');
  // The text of a label set aside is not read at all: its description may hold anything an attribute may.
  assert.strictEqual(same(PUBLISHED, form([cell('By Priority', label(3082, 'a &lt; b &amp; &quot;c&quot; &#x1F600;')), cell('Open')])), true);
});

'use strict';
// Tests of lib/formxml-layers.js: whether the SAVED FormXML of a systemform (a dashboard's, as verify reads it) is its PUBLISHED one when
// the two reads carry the labels of different languages — by the text of the two reads, and, when the platform's own version token says
// the saved layer is the published row, by the structure alone. What verify does with the answer — the dashboard's tiles, read only when
// it is yes — is tested through the reader itself in verify-model-app.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { sameFormXmlAcrossLayers } = require('../lib/formxml-layers.js');
const reads = require('./helpers/dashboard-two-language-reads.js');

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
const same = (published, saved, versions) => sameFormXmlAcrossLayers(published, saved, versions);

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

// ── The same dashboard, read by a user whose own language is the organization's second one ──────────────────────────────────────
// What the platform answered live for each kind of user is in helpers/dashboard-two-language-reads.js. For the second-language user the
// published read carries both languages, the user's own first, and words one caption another way than the saved layer does, while the
// published row and the saved layer were at the very same version (`@odata.etag`) and nothing had written either: a read is the platform's
// projection for its reader, and no text can say which of two captions is "the" caption. The version can say that the saved layer IS the row.
const { BASE_LANGUAGE_USER: BASE_USER, SECOND_LANGUAGE_USER: SECOND_USER, ROW_VERSION, MOVED_VERSION } = reads;
const AT_ROW_VERSION = { published: ROW_VERSION, saved: ROW_VERSION };
const AFTER_A_SAVE = { published: ROW_VERSION, saved: MOVED_VERSION };
// The label groups of a read in document order: each <labels> as the list of `lcid:caption` it holds.
const groupsOf = (xml) => [...xml.matchAll(/<labels>(.*?)<\/labels>/g)]
  .map((group) => [...group[1].matchAll(/<label description="([^"]*)" languagecode="(\d+)" \/>/g)].map((l) => `${l[2]}:${l[1]}`));
const withoutLabels = (xml) => xml.replace(/<label\b[^>]*\/>/g, '');
const { cellOf, swapFirstTwoCells: swapCells } = reads;

test('the captured reads of one dashboard: the 3082 user\u2019s two layers differ in the order of two languages and in one caption\u2019s text — and in nothing else', () => {
  // Every caption taken out, the four reads are one document: the tiles are the same.
  for (const xml of [BASE_USER.published, BASE_USER.saved, SECOND_USER.published, SECOND_USER.saved]) assert.strictEqual(withoutLabels(xml), withoutLabels(BASE_USER.published));
  // The 1033 user, the case measured before: the saved read is the published one plus a 3082 caption in each of the four cells.
  assert.strictEqual(BASE_USER.saved.replace(/<label description="Work Orders" languagecode="3082" \/>/g, ''), BASE_USER.published);
  // The 3082 user: both languages in every cell of both layers (the tab and the section are in the user's language, empty).
  assert.deepStrictEqual(groupsOf(SECOND_USER.published), [['3082:'], ['3082:'], ['3082:Work Orders', '1033:By Priority'], ['3082:Work Orders', '1033:By Status'],
    ['3082:Work Orders', '1033:Critical Queue'], ['3082:Customers', '1033:Gold Customers']]);
  assert.deepStrictEqual(groupsOf(SECOND_USER.saved), [['3082:'], ['3082:'], ['1033:By Priority', '3082:Work Orders'], ['1033:By Status', '3082:Work Orders'],
    ['1033:Critical Queue', '3082:Work Orders'], ['1033:Gold Customers', '3082:Work Orders']]);
  // Put in one order, the cells' groups are the same but for the last cell's 3082 text.
  const sorted = (xml) => groupsOf(xml).map((group) => [...group].sort());
  assert.deepStrictEqual(sorted(SECOND_USER.published).slice(0, 5), sorted(SECOND_USER.saved).slice(0, 5));
  assert.deepStrictEqual([sorted(SECOND_USER.published)[5], sorted(SECOND_USER.saved)[5]], [['1033:Gold Customers', '3082:Customers'], ['1033:Gold Customers', '3082:Work Orders']]);
});

test('sameFormXmlAcrossLayers: a user whose own language is the second one reads the published dashboard in another order and with a caption worded another way — at the same row version it is the published dashboard', () => {
  const { published, saved } = SECOND_USER;
  // By the text alone it is not: both languages are carried, so none is set aside, and the reads differ in an order and in a caption.
  assert.strictEqual(same(published, saved), false);
  assert.strictEqual(same(published, saved, undefined), false);
  // The platform's own token says the saved layer has not been written since the publish: the two reads are one row, shown to its reader.
  assert.strictEqual(same(published, saved, AT_ROW_VERSION), true);
  // The 1033 user's reads are the same dashboard by the text, as before, at the same version or not.
  assert.strictEqual(same(BASE_USER.published, BASE_USER.saved), true);
  assert.strictEqual(same(BASE_USER.published, BASE_USER.saved, AT_ROW_VERSION), true);
});

test('sameFormXmlAcrossLayers: only two versions that are the same text excuse the captions — a version that moved, or is missing, blank or not text, excuses nothing', () => {
  const { published, saved } = SECOND_USER;
  for (const [what, versions] of [
    ['a saved layer whose version moved', AFTER_A_SAVE],
    ['a published row whose version is another', { published: MOVED_VERSION, saved: ROW_VERSION }],
    ['no versions', undefined],
    ['an empty object', {}],
    ['null', null],
    ['no published version', { saved: ROW_VERSION }],
    ['no saved version', { published: ROW_VERSION }],
    ['two empty versions', { published: '', saved: '' }],
    ['two versions that are numbers', { published: 1001, saved: 1001 }],
    ['two null versions', { published: null, saved: null }],
    // The token is opaque: a weak validator and the same number without its W/ are two tokens, not one.
    ['two spellings of one number', { published: 'W/"1001"', saved: '"1001"' }],
  ]) {
    assert.strictEqual(same(published, saved, versions), false, what);
  }
});

test('sameFormXmlAcrossLayers: at the same row version a tile, a cell, an element or an attribute that differs is still a difference — only the captions are excused', () => {
  const { published, saved } = SECOND_USER;
  const first = (xml, from, to) => { assert.ok(xml.includes(from), from); return xml.replace(from, to); };
  const extraCell = `<cell id="${reads.dashId(5)}" colspan="1" rowspan="1" showlabel="true"><labels>${reads.label(1033, 'By Region')}</labels></cell>`;
  for (const [what, other] of [
    ['a cell added', first(saved, '</row></rows>', `${extraCell}</row></rows>`)],
    ['a cell removed', saved.replace(cellOf(saved, 4), '')],
    ['two cells swapped', swapCells(saved)],
    ['a tile\u2019s view', first(saved, `<ViewId>${reads.VIEW_CRITICAL}</ViewId>`, `<ViewId>${reads.VIEW_GOLD}</ViewId>`)],
    ['a tile\u2019s table', first(saved, '<TargetEntityType>new_customer</TargetEntityType>', '<TargetEntityType>new_workorder</TargetEntityType>')],
    ['a tile\u2019s chart', first(saved, `<VisualizationId>${reads.CHART_STATUS}</VisualizationId>`, `<VisualizationId>${reads.CHART_PRIORITY}</VisualizationId>`)],
    ['an attribute changed', first(saved, 'columns="2"', 'columns="1"')],
    ['an attribute added', first(saved, 'name="General"', 'name="General" visible="false"')],
    ['an element added', first(saved, '</parameters>', '<RecordsPerPage>5</RecordsPerPage></parameters>')],
    ['a comment added', first(saved, '<rows>', '<!-- x --><rows>')],
    ['white space in a tag', first(saved, 'showlabel="true"><labels>', 'showlabel="true" ><labels>')],
    ['quote style', first(saved, 'name="General"', "name='General'")],
    ['the labels of a cell removed', saved.replace(/(<cell id="[^"]*" colspan="1" rowspan="1" showlabel="true">)<labels>.*?<\/labels>/, '$1')],
    ['a second labels element in a cell', first(saved, '</labels><control id', '</labels><labels></labels><control id')],
  ]) {
    assert.notStrictEqual(other, saved, what);
    assert.strictEqual(same(published, other, AT_ROW_VERSION), false, what);
  }
  // The same holds for the 1033 user's reads, whose text already said "the same": a structure that differs is a difference at any version.
  assert.strictEqual(same(BASE_USER.published, swapCells(BASE_USER.saved), AT_ROW_VERSION), false);
  // A caption the reader\u2019s projection could not have made — one that is no empty tag of a <labels>, or names no language — is no caption to excuse.
  for (const [what, tag] of [
    ['a caption with an end tag', '<label description="x" languagecode="3082"></label>'],
    ['a caption with no language', '<label description="x" />'],
    ['a caption whose language is no LCID', '<label description="x" languagecode="es-ES" />'],
  ]) {
    const other = first(saved, reads.label(3082, 'Work Orders'), tag);
    assert.strictEqual(same(published, other, AT_ROW_VERSION), false, what);
  }
});

test('sameFormXmlAcrossLayers: at the same row version what is excused is what the reads show of the captions, in any order — nothing the row says', () => {
  const { published, saved } = SECOND_USER;
  for (const [what, other] of [
    ['the order of the languages', saved],
    ['a 3082 caption worded another way', saved.replace('description="Work Orders" languagecode="3082"', 'description="Pedidos" languagecode="3082"')],
    ['a 3082 caption left out', saved.replace(reads.label(3082, 'Work Orders'), '')],
    ['a language the published read has none of', saved.replace(reads.label(3082, 'Work Orders'), reads.label(3082, 'Work Orders') + reads.label(1036, 'Ordres'))],
  ]) {
    assert.strictEqual(same(published, other, AT_ROW_VERSION), true, what);
  }
});

test('sameFormXmlAcrossLayers: a published read of one language is judged by the text alone, at any version — the token is for a read that carries more than one', () => {
  // The 1033 user's published read carries 1033 alone: whatever the two tokens say, a 1033 caption that differs is a change, as it always was,
  // and the result for that user is the text rule's, by construction.
  const { published, saved } = BASE_USER;
  for (const [what, other] of [
    ['a 1033 caption changed', saved.replace('description="By Priority"', 'description="By Owner"')],
    ['a 1033 caption removed', saved.replace(reads.label(1033, 'By Status'), '')],
    ['a 1033 caption added', saved.replace(reads.label(1033, 'By Status'), reads.label(1033, 'By Status') + reads.label(1033, 'Second'))],
  ]) {
    for (const [tokens, versions] of [['no tokens', undefined], ['the same token', AT_ROW_VERSION], ['another token', AFTER_A_SAVE]]) {
      assert.strictEqual(same(published, other, versions), false, `${what}, ${tokens}`);
    }
  }
  // A published read of one language that is not the base one is no different: the texts decide.
  const spanishOnly = SECOND_USER.published.replace(/<label description="[^"]*" languagecode="1033" \/>/g, '');
  assert.strictEqual(same(spanishOnly, SECOND_USER.saved, AT_ROW_VERSION), false);
  // The 1033 user's own reads, which the text rule already says are the same, are the same at any version.
  for (const versions of [undefined, AT_ROW_VERSION, AFTER_A_SAVE]) assert.strictEqual(same(published, saved, versions), true);
});

test('sameFormXmlAcrossLayers: after a write to the saved layer the reads are compared by their text, as before — a real change is found for either user', () => {
  // The 1033 user: a saved 3082 caption alone is still not seen (the limit documented since the second-language fix), anything else is.
  assert.strictEqual(same(BASE_USER.published, BASE_USER.saved, AFTER_A_SAVE), true);
  assert.strictEqual(same(BASE_USER.published, BASE_USER.saved.replace('description="Work Orders" languagecode="3082"', 'description="Pedidos" languagecode="3082"'), AFTER_A_SAVE), true);
  for (const [what, saved] of [
    ['a 1033 caption', BASE_USER.saved.replace('description="By Priority"', 'description="By Owner"')],
    ['a 1033 caption removed', BASE_USER.saved.replace(reads.label(1033, 'By Status'), '')],
    ['a tile moved', swapCells(BASE_USER.saved)],
    ['a tile\u2019s view', BASE_USER.saved.replace(`<ViewId>${reads.VIEW_CRITICAL}</ViewId>`, `<ViewId>${reads.VIEW_GOLD}</ViewId>`)],
  ]) {
    assert.strictEqual(same(BASE_USER.published, saved, AFTER_A_SAVE), false, `the 1033 user: ${what}`);
  }
  // The 3082 user: the saved layer was written, so the token excuses nothing and the two reads — which differ — are not the same text.
  // Whatever was saved (a tile, a 1033 caption, a 3082 caption), the dashboard is not the published one: it fails closed.
  for (const [what, saved] of [
    ['nothing that shows', SECOND_USER.saved],
    ['a 1033 caption', SECOND_USER.saved.replace('description="By Priority"', 'description="By Owner"')],
    ['a 3082 caption', SECOND_USER.saved.replace('description="Work Orders" languagecode="3082"', 'description="Pedidos" languagecode="3082"')],
    ['a tile moved', swapCells(SECOND_USER.saved)],
  ]) {
    assert.strictEqual(same(SECOND_USER.published, saved, AFTER_A_SAVE), false, `the 3082 user: ${what}`);
  }
});

test('sameFormXmlAcrossLayers: the version never makes a read that is not one well-formed XML document, or names no language, the published dashboard', () => {
  const { published, saved } = SECOND_USER;
  for (const [what, a, b] of [
    ['a saved read with a label left open', published, saved.replace('languagecode="3082" />', 'languagecode="3082">')],
    ['a saved read with a bare "&"', published, saved.replace('Work Orders', 'Work & Orders')],
    ['a saved read with a second root element', published, `${saved}<form/>`],
    ['a published read cut short', published.slice(0, -1), saved.slice(0, -1)],
    ['a published read that is no XML', 'not xml', saved],
    ['an empty saved read', published, ''],
    ['a published read that names no language', published.replace(/ languagecode="\d+"/g, ''), saved],
    ['a published read with no caption at all', withoutLabels(published), saved],
  ]) {
    assert.strictEqual(same(a, b, AT_ROW_VERSION), false, what);
  }
  // Two equal texts stay the same document at any version, as they always were.
  assert.strictEqual(same('not xml', 'not xml', AFTER_A_SAVE), true);
});

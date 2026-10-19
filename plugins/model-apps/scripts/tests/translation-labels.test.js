'use strict';
// lib/translation-labels.js: the captions of a solution's forms, read from ONE translation export.
//
// The platform's form reads carry the labels of some languages only (a form built with Spanish captions in an English-language organization reads back
// in English alone), and a translation export is the one read that carries every provisioned language. This module turns the export into an answer to
// "what is the caption of this tab or section, in this language": the workbook the export holds is read by the plugin's strict XML reader and by rules
// of its own, and ANYTHING it does not recognise — a structure, a type, a reference, a row it cannot place — is "not readable", never a guess. These
// tests drive the whole path with synthesized exports (helpers/translation-export.js), from the answer of the request down to a cell.
const test = require('node:test');
const assert = require('node:assert');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { parseTranslationWorkbook, readTranslationLabels, settleCaption, isTranslationExport, WORKBOOK_ENTRY, LABELS_SHEET } = require('../lib/translation-labels.js');
const { workbookXml, zipOf, exportZip, exportAnswer, EXPORT_PATH, SPREADSHEET_NAMESPACE } = require('./helpers/translation-export.js');

const TAB = '0a0a0a0a-0000-4000-8000-000000000001';
const SECTION = '0a0a0a0a-0000-4000-8000-000000000002';
const OTHER = '0a0a0a0a-0000-4000-8000-000000000003';
const CELL = '0a0a0a0a-0000-4000-8000-000000000004';
const rows = () => [
  { entity: 'new_ticket', id: TAB, texts: { 1033: 'Tab One', 3082: 'Pestana Uno' } },
  { entity: 'new_ticket', id: SECTION, texts: { 1033: 'Details', 3082: 'Detalles' } },
  { entity: 'new_ticket', id: OTHER, texts: { 1033: 'Notes' } },
  { entity: 'new_ticket', id: CELL, column: 'DisplayName', texts: { 1033: 'Name', 3082: 'Nombre' } },
];
const parsed = (over) => {
  const read = parseTranslationWorkbook(workbookXml({ captions: rows(), ...over }));
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  return read;
};
const refused = (xml) => {
  const read = parseTranslationWorkbook(xml);
  assert.strictEqual(read.ok, false, 'a workbook it cannot read with certainty is refused');
  assert.strictEqual(typeof read.detail, 'string');
  return read.detail;
};
// The workbook has the same header texts in `Display Strings` and `Localized Labels`; the last one is the sheet that is read.
const replaceLast = (text, from, to) => {
  const at = text.lastIndexOf(from);
  assert.ok(at >= 0, `${from} is in the workbook`);
  return text.slice(0, at) + to + text.slice(at + from.length);
};

test('translation workbook: the captions of the measured shape are found by the id of the tab or section, in every language column', () => {
  const read = parsed();
  assert.deepStrictEqual(read.languages, [1033, 3082]);
  assert.deepStrictEqual([...read.lookup('new_ticket', TAB).texts], [[1033, 'Tab One'], [3082, 'Pestana Uno']]);
  assert.deepStrictEqual([...read.lookup('new_ticket', SECTION).texts], [[1033, 'Details'], [3082, 'Detalles']]);
  // A caption with no translation is an EMPTY cell: the row is there, and says nothing in that language.
  assert.deepStrictEqual([...read.lookup('new_ticket', OTHER).texts], [[1033, 'Notes'], [3082, '']]);
  assert.strictEqual(WORKBOOK_ENTRY, 'CrmTranslations.xml');
  assert.strictEqual(LABELS_SHEET, 'Localized Labels');
});

test('translation workbook: a row is found by its table and its id, whatever the case of either and whether the id has braces — and by nothing else', () => {
  const read = parsed();
  for (const [entity, id] of [['NEW_TICKET', TAB.toUpperCase()], ['new_ticket', `{${TAB}}`], ['New_Ticket', `{${TAB.toUpperCase()}}`]]) {
    assert.strictEqual(read.lookup(entity, id).found, true, `${entity} ${id}`);
  }
  assert.deepStrictEqual(read.lookup('new_other', TAB), { found: false }, 'the id of another table\u2019s form is not this form\u2019s');
  assert.deepStrictEqual(read.lookup('new_ticket', '11111111-2222-3333-4444-555555555555'), { found: false });
  for (const bad of [undefined, null, '', 'not-a-guid', 123, {}]) assert.deepStrictEqual(read.lookup('new_ticket', bad), { found: false }, String(bad));
  assert.deepStrictEqual(read.lookup(undefined, TAB), { found: false });
});

test('translation workbook: only the rows of the column `displayname` are captions — a table\u2019s or a column\u2019s display name, keyed by another id, is not', () => {
  const read = parsed({ captions: [...rows(), { entity: 'new_ticket', id: TAB, column: 'description', texts: { 1033: 'Not a caption', 3082: 'No es un titulo' } }, { entity: 'new_ticket', id: SECTION, column: 'DisplayName', texts: { 1033: 'Wrong case', 3082: 'Mayuscula' } }] });
  assert.strictEqual(read.lookup('new_ticket', TAB).ambiguous, false, 'a `description` row of the same id is not a second caption');
  assert.strictEqual(read.lookup('new_ticket', TAB).texts.get(1033), 'Tab One');
  assert.strictEqual(read.lookup('new_ticket', SECTION).texts.get(1033), 'Details', 'the column is spelled `displayname`, and only that');
  assert.deepStrictEqual(read.lookup('new_ticket', CELL), { found: false });
});

test('translation workbook: an id that two rows of one table carry is ambiguous, and no text is given for it', () => {
  const read = parsed({ captions: [...rows(), { entity: 'new_ticket', id: TAB.toUpperCase(), texts: { 1033: 'A copy of the form', 3082: 'Una copia' } }] });
  assert.deepStrictEqual(read.lookup('new_ticket', TAB), { found: true, ambiguous: true });
  assert.strictEqual(read.lookup('new_ticket', SECTION).ambiguous, false, 'the others are untouched');
  // The same id under another table is another row.
  const split = parsed({ captions: [...rows(), { entity: 'new_other', id: TAB, texts: { 1033: 'Same id, other table', 3082: 'Otra tabla' } }] });
  assert.strictEqual(split.lookup('new_ticket', TAB).texts.get(1033), 'Tab One');
  assert.strictEqual(split.lookup('new_other', TAB).texts.get(1033), 'Same id, other table');
});

test('translation workbook: the language columns are the LCIDs of the header row, in its order — one, or many', () => {
  assert.deepStrictEqual(parsed({ languages: [1033] , captions: [{ entity: 'new_ticket', id: TAB, texts: { 1033: 'Tab One' } }] }).languages, [1033]);
  const three = parsed({ languages: [3082, 1033, 1036], captions: [{ entity: 'new_ticket', id: TAB, texts: { 1033: 'One', 1036: 'Un', 3082: 'Uno' } }] });
  assert.deepStrictEqual(three.languages, [3082, 1033, 1036]);
  assert.deepStrictEqual([...three.lookup('new_ticket', TAB).texts], [[3082, 'Uno'], [1033, 'One'], [1036, 'Un']]);
});

test('translation workbook: a cell is its text exactly — references decoded, white space kept, a line end read as XML reads it', () => {
  const xml = workbookXml({ captions: [{ entity: 'new_ticket', id: TAB, texts: { 1033: ' R & D <1> "q" ', 3082: 'Pesta\u00f1a' } }] })
    .replace('R &amp; D', 'R &amp; D &#233;&#x41;&#10;x')
    .replace('Pesta\u00f1a', 'Pesta&#241;a\r\nb\rc&#13;d');
  const read = parseTranslationWorkbook(xml);
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  const texts = read.lookup('new_ticket', TAB).texts;
  assert.strictEqual(texts.get(1033), ' R & D \u00e9A\nx <1> "q" ');
  assert.strictEqual(texts.get(3082), 'Pesta\u00f1a\nb\nc\rd', 'a literal CR LF and a lone CR are line feeds, as in any XML parser; a CR written as a reference stays one');
});

test('translation workbook: a cell may leave out its Data, its type or its tail — an empty cell is the empty text, and ss:Index skips to a column', () => {
  const sheet = (body) => workbookXml({ captions: [] }).replace(/(<Worksheet ss:Name="Localized Labels"[\s\S]*?<\/Row>)([\s\S]*?)(<\/Table>)/, `$1${body}$3`);
  const empties = parseTranslationWorkbook(sheet(`<Row><Cell><Data ss:Type="String">new_ticket</Data></Cell><Cell><Data ss:Type="String">${TAB}</Data></Cell><Cell><Data ss:Type="String">displayname</Data></Cell><Cell/><Cell ss:StyleID="s24"></Cell></Row>`));
  assert.strictEqual(empties.ok, true, JSON.stringify(empties));
  assert.deepStrictEqual([...empties.lookup('new_ticket', TAB).texts], [[1033, ''], [3082, '']]);
  const short = parseTranslationWorkbook(sheet(`<Row><Cell><Data ss:Type="String">new_ticket</Data></Cell><Cell><Data ss:Type="String">${TAB}</Data></Cell><Cell><Data ss:Type="String">displayname</Data></Cell><Cell><Data ss:Type="String">Only English</Data></Cell></Row>`));
  assert.deepStrictEqual([...short.lookup('new_ticket', TAB).texts], [[1033, 'Only English'], [3082, '']], 'a row that ends before the last column is empty there');
  const skipped = parseTranslationWorkbook(sheet(`<Row><Cell><Data ss:Type="String">new_ticket</Data></Cell><Cell><Data ss:Type="String">${TAB}</Data></Cell><Cell><Data ss:Type="String">displayname</Data></Cell><Cell ss:Index="5"><Data ss:Type="String">Solo espanol</Data></Cell></Row>`));
  assert.deepStrictEqual([...skipped.lookup('new_ticket', TAB).texts], [[1033, ''], [3082, 'Solo espanol']]);
  const blank = parseTranslationWorkbook(sheet(`<Row/><Row><Cell><Data ss:Type="String">new_ticket</Data></Cell><Cell><Data ss:Type="String">${TAB}</Data></Cell><Cell><Data ss:Type="String">displayname</Data></Cell><Cell><Data ss:Type="Number">2024</Data></Cell></Row>`));
  assert.strictEqual(blank.lookup('new_ticket', TAB).texts.get(1033), '2024', 'a Number cell is its text; an empty row is skipped');
});

test('translation workbook: a document that is not one well-formed XML document is not read — whatever it would have said', () => {
  const good = workbookXml({ captions: rows() });
  assert.match(refused('not xml'), /one XML document/);
  assert.match(refused(good.slice(0, good.length - 12)), /one XML document/, 'cut short');
  assert.match(refused(`<!DOCTYPE Workbook [<!ENTITY x "y">]>${good.replace('<?xml version="1.0"?>', '')}`), /one XML document/, 'a document type declaration');
  assert.match(refused(good.replace('Tab One', 'Tab &nbsp; One')), /one XML document/, 'an entity that is not predefined');
  assert.match(refused(good.replace('Tab One', 'Tab \u0001 One')), /one XML document/, 'a character XML does not allow');
  assert.match(refused(`${good}<Workbook/>`), /one XML document/, 'a second root element');
  assert.match(refused(''), /one XML document/);
  assert.match(refused(undefined), /one XML document/);
});

test('translation workbook: it is read as the platform\u2019s spreadsheet and nothing else — the root, its namespace, the sheet, its header', () => {
  const good = workbookXml({ captions: rows() });
  assert.match(refused(good.replace('<Workbook ', '<Book ').replace('</Workbook>', '</Book>')), /not a spreadsheet workbook/);
  assert.match(refused(good.replace(`<Workbook xmlns="${SPREADSHEET_NAMESPACE}"`, '<Workbook xmlns="urn:example:other"')), /not a spreadsheet workbook/);
  assert.match(refused(good.replace(`xmlns:ss="${SPREADSHEET_NAMESPACE}"`, 'xmlns:ss="urn:example:other"')), /not a spreadsheet workbook/);
  assert.match(refused(good.replace('ss:Name="Localized Labels"', 'ss:Name="Labels"')), /no worksheet named 'Localized Labels'/);
  assert.match(refused(good.replace(/<Worksheet ss:Name="Information"/, '<Worksheet ss:Name="Localized Labels"')), /more than one worksheet named 'Localized Labels'/);
  assert.match(refused(good.replace('>Object ID<', '>Object Id<')), /header of 'Localized Labels' is not/);
  assert.match(refused(replaceLast(good, '>Entity name<', '>Table<')), /header of 'Localized Labels' is not/);
  assert.match(refused(good.replace('>Object Column Name<', '>Column<')), /header of 'Localized Labels' is not/);
  assert.match(refused(replaceLast(good, '<Data ss:Type="Number">3082</Data>', '<Data ss:Type="Number">Spanish</Data>')), /header of 'Localized Labels' names a language that is not an LCID/);
  assert.match(refused(replaceLast(good, '<Data ss:Type="Number">3082</Data>', '<Data ss:Type="Number">1033</Data>')), /header of 'Localized Labels' names language 1033 twice/);
  assert.match(refused(workbookXml({ languages: [], captions: [] })), /header of 'Localized Labels' names no language/);
  const noHeader = good.replace(/(<Worksheet ss:Name="Localized Labels"[\s\S]*?)<Row[\s\S]*<\/Table>/, '$1</Table>');
  assert.match(refused(noHeader), /has no header row/);
});

test('translation workbook: a row it cannot place with certainty makes the whole export unreadable', () => {
  const good = workbookXml({ captions: rows() });
  const inSheet = (body) => good.replace(/(<Worksheet ss:Name="Localized Labels"[\s\S]*?)(<\/Table>)/, `$1${body}$2`);
  const cell = (text) => `<Cell><Data ss:Type="String">${text}</Data></Cell>`;
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}</Row>`)), /row 6 .*fewer than the three cells/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}${cell('a')}${cell('b')}${cell('c')}</Row>`)), /row 6 has more cells than the header/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell ss:Index="9">${''}</Cell></Row>`)), /row 6 has more cells than the header/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell ss:Index="3">${''}</Cell></Row>`)), /ss:Index/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell ss:Index="x"/></Row>`)), /ss:Index/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell ss:MergeAcross="1">${''}</Cell></Row>`)), /merged|formula|ss:MergeAcross/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell ss:Formula="=1"><Data ss:Type="String">x</Data></Cell></Row>`)), /merged|formula|ss:Formula/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell><Data ss:Type="String">a</Data><Data ss:Type="String">b</Data></Cell></Row>`)), /more than one Data/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell><Data ss:Type="Boolean">1</Data></Cell></Row>`)), /type 'Boolean'/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell><Data ss:Type="String">a <B>b</B></Data></Cell></Row>`)), /markup inside a cell/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell><Data ss:Type="String"><![CDATA[a]]></Data></Cell></Row>`)), /markup inside a cell/);
  assert.match(refused(inSheet(`<Row>${cell('new_ticket')}${cell(TAB)}${cell('displayname')}<Cell><Data>a</Data></Cell></Row>`)), /no ss:Type/);
  assert.match(refused(inSheet('<Row><Row/></Row>')), /is not where the spreadsheet puts one/);
  assert.match(refused(good.replace(/(<Worksheet ss:Name="Localized Labels"[\s\S]*?<\/Table>)/, '$1<Table></Table>')), /more than one Table/);
});

test('translation workbook: a table of the workbook other than the Localized Labels sheet is none of its business, whatever it holds', () => {
  const strange = workbookXml({ captions: rows() }).replace(/(<Worksheet ss:Name="Information"[\s\S]*?<Table>)/, '$1<Row><Cell ss:Formula="=1"><Data ss:Type="Boolean">1</Data><Data>2</Data></Cell></Row>');
  const read = parseTranslationWorkbook(strange);
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  assert.strictEqual(read.lookup('new_ticket', TAB).texts.get(1033), 'Tab One');
});

test('translation workbook: a large export is read in one pass', () => {
  const many = [];
  for (let i = 0; i < 4000; i += 1) many.push({ entity: 'new_ticket', id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, texts: { 1033: `Caption ${i}`, 3082: `Titulo ${i}` } });
  const read = parseTranslationWorkbook(workbookXml({ captions: many }));
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  assert.strictEqual(read.lookup('new_ticket', '00000000-0000-4000-8000-000000003999').texts.get(3082), 'Titulo 3999');
});

// --- settleCaption: one caption against the export ---------------------------------------------------------------------------------------------

test('settleCaption: the same text is settled, a different one or an empty cell is a difference, and the others are not settled at all', () => {
  const read = parsed();
  const settle = (over) => settleCaption(read, { entity: 'new_ticket', id: TAB, lcid: 3082, text: 'Pestana Uno', ...over });
  assert.deepStrictEqual(settle({}), { state: 'same' });
  assert.deepStrictEqual(settle({ text: 'Pestana Dos' }), { state: 'different', have: 'Pestana Uno', others: [{ lcid: 1033, text: 'Tab One' }] });
  assert.deepStrictEqual(settle({ id: OTHER, text: 'Notas' }), { state: 'different', have: '', others: [{ lcid: 1033, text: 'Notes' }] }, 'an empty cell is a caption that is not there');
  assert.deepStrictEqual(settle({ lcid: 1033, text: 'Tab One' }), { state: 'same' });
  assert.deepStrictEqual(settle({ text: 'pestana uno' }), { state: 'different', have: 'Pestana Uno', others: [{ lcid: 1033, text: 'Tab One' }] }, 'a caption is compared exactly');
  assert.match(settle({ id: '11111111-2222-3333-4444-555555555555' }).why, /no caption row for the tab or section \(id 11111111-2222-3333-4444-555555555555, table new_ticket\)/);
  assert.strictEqual(settle({ id: undefined }).state, 'unsettled');
  assert.match(settle({ id: undefined }).why, /gives a tab or section no id/);
  assert.match(settle({ lcid: 1036 }).why, /no column for language 1036/);
  assert.match(settle({ id: OTHER, what: 'section \'sec_notes\'' }).state, /same|different/);
  assert.match(settle({ id: '11111111-2222-3333-4444-555555555555', what: 'section \'sec_notes\'' }).why, /no caption row for section 'sec_notes' \(id 11111111-2222-3333-4444-555555555555, table new_ticket\)/);
  const twice = parsed({ captions: [...rows(), { entity: 'new_ticket', id: TAB, texts: { 1033: 'again' } }] });
  assert.match(settleCaption(twice, { entity: 'new_ticket', id: TAB, lcid: 3082, text: 'Pestana Uno' }).why, /more than one caption row for the tab or section \(id 0a0a0a0a-0000-4000-8000-000000000001, table new_ticket\)/);
});

// --- readTranslationLabels: the request, the answer and the archive ---------------------------------------------------------------------------

const clientAnswering = (answer, seen = []) => ({ post: async (path, body, options) => { seen.push({ path, body, options }); return typeof answer === 'function' ? answer(path, body) : answer; } });
const workbook = () => workbookXml({ captions: rows() });

test('readTranslationLabels: asks the solutions collection to export the solution\u2019s translations once, and reads the workbook out of the answer', async () => {
  const seen = [];
  const read = await readTranslationLabels(clientAnswering(exportAnswer(exportZip(workbook())), seen), 'Contoso_Tickets');
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  assert.deepStrictEqual(read.languages, [1033, 3082]);
  assert.strictEqual(read.lookup('new_ticket', SECTION).texts.get(3082), 'Detalles');
  assert.strictEqual(seen.length, 1, 'one request');
  assert.match(seen[0].path, EXPORT_PATH);
  assert.strictEqual(seen[0].path, '/solutions/Microsoft.Dynamics.CRM.ExportTranslation', 'bound to the solutions collection — the unbound action answers 404');
  assert.deepStrictEqual(seen[0].body, { SolutionName: 'Contoso_Tickets' });
});

test('readTranslationLabels: an answer it cannot use is a reason, never an exception and never an answer', async () => {
  const good = exportAnswer(exportZip(workbook()));
  const withFile = (file) => ({ status: 200, headers: {}, body: { ExportTranslationFile: file } });
  const failures = [
    ['no client', undefined, /no Dataverse client/],
    ['a client that cannot post', {}, /no Dataverse client/],
    ['a request that fails', { post: async () => { throw new Error('socket hang up'); } }, /socket hang up/],
    ['a request that fails before it returns', { post: () => { throw new Error('refused to send'); } }, /refused to send/],
    ['no answer', clientAnswering(undefined), /no answer/],
    ['a 403 with the platform\u2019s message', clientAnswering({ status: 403, headers: {}, body: { error: { code: '0x80040220', message: 'Principal user is missing prvExportTranslation privilege' } } }), /HTTP 403: Principal user is missing prvExportTranslation privilege/],
    ['a 404', clientAnswering({ status: 404, headers: {}, body: { error: { message: 'Resource not found for the segment' } } }), /HTTP 404: Resource not found for the segment/],
    ['a 500 with no body', clientAnswering({ status: 500, headers: {}, body: undefined }), /HTTP 500/],
    ['a 200 with no file', clientAnswering({ status: 200, headers: {}, body: { '@odata.context': 'x' } }), /ExportTranslationFile/],
    ['a 200 with a body that is text', clientAnswering({ status: 200, headers: {}, body: '<html>sign in</html>' }), /ExportTranslationFile/],
    ['a file that is not text', clientAnswering(withFile(42)), /ExportTranslationFile/],
    ['an empty file', clientAnswering(withFile('')), /ExportTranslationFile/],
    ['a file that is not base64', clientAnswering(withFile('not base64 !!')), /not base64/],
    ['a file with a bad length', clientAnswering(withFile('QUJD=')), /not base64/],
    ['bytes that are no zip', clientAnswering(withFile(Buffer.from('not a zip file at all, only text that goes on').toString('base64'))), /archive of the export is not readable: .*end-of-central-directory/],
    ['a zip without the workbook', clientAnswering(exportAnswer(zipOf([{ name: 'Other.xml', data: '<a/>' }]))), /archive of the export is not readable: .*no entry named 'CrmTranslations\.xml'/],
    ['a workbook that is not XML', clientAnswering(exportAnswer(zipOf([{ name: 'CrmTranslations.xml', data: 'plain text' }]))), /workbook of the export is not readable: .*one XML document/],
    ['a workbook in bytes that are not UTF-8', clientAnswering(exportAnswer(zipOf([{ name: 'CrmTranslations.xml', data: Buffer.from([0x3c, 0x61, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x61, 0x3e]) }]))), /not valid UTF-8/],
    ['a workbook that declares another encoding', clientAnswering(exportAnswer(zipOf([{ name: 'CrmTranslations.xml', data: workbook().replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="utf-16"?>') }]))), /declares the encoding utf-16/],
  ];
  for (const [what, client, reason] of failures) {
    const read = await readTranslationLabels(client, 'Contoso_Tickets');
    assert.strictEqual(read.ok, false, what);
    assert.match(read.reason, reason, what);
    assert.strictEqual(read.lookup, undefined, `${what}: nothing is answered from it`);
  }
  // A solution that is named by no text is not asked about.
  const asked = [];
  for (const name of [undefined, null, '', '   ', 42]) {
    const read = await readTranslationLabels(clientAnswering(good, asked), name);
    assert.strictEqual(read.ok, false, String(name));
    assert.match(read.reason, /no solution name/);
  }
  assert.deepStrictEqual(asked, [], 'no request was made');
});

test('readTranslationLabels: an export larger than it will read is left unread, with the size said — before anything is inflated', async () => {
  const archive = exportZip(workbook());
  const directory = archive.readUInt32LE(archive.length - 22 + 16);
  const huge = 32 * 1024 * 1024 + 1;
  archive.writeUInt32LE(huge, directory + 24);
  archive.writeUInt32LE(huge, 22);
  const read = await readTranslationLabels(clientAnswering(exportAnswer(archive)), 'Contoso_Tickets');
  assert.strictEqual(read.ok, false);
  assert.match(read.reason, /archive of the export is not readable: the entry 'CrmTranslations\.xml' is larger than 33554432 bytes/);
});

test('readTranslationLabels: reads the workbook of an archive with a byte order mark, an XML declaration naming UTF-8, and non-ASCII captions', async () => {
  const text = workbook().replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="UTF-8"?>').replace('Detalles', 'Pesta\u00f1a \u2014 \u65e5\u672c');
  const read = await readTranslationLabels(clientAnswering(exportAnswer(zipOf([{ name: 'CrmTranslations.xml', data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) }]))), 'Contoso_Tickets');
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  assert.strictEqual(read.lookup('new_ticket', SECTION).texts.get(3082), 'Pesta\u00f1a \u2014 \u65e5\u672c');
});

// --- the request is sent once ------------------------------------------------------------------------------------------------------------------

test('isTranslationExport: names the ExportTranslation request of the solutions collection, and no other', () => {
  const base = 'https://contoso.crm.dynamics.com/api/data/v9.2';
  assert.strictEqual(isTranslationExport('POST', `${base}/solutions/Microsoft.Dynamics.CRM.ExportTranslation`), true);
  assert.strictEqual(isTranslationExport('post', 'https://contoso.crm.dynamics.com/api/data/v9.0/solutions/Microsoft.Dynamics.CRM.ExportTranslation'), true);
  for (const [method, url] of [
    ['GET', `${base}/solutions/Microsoft.Dynamics.CRM.ExportTranslation`],
    ['POST', `${base}/ExportTranslation`],
    ['POST', `${base}/solutions/Microsoft.Dynamics.CRM.ImportTranslation`],
    ['POST', `${base}/solutions/Microsoft.Dynamics.CRM.ExportTranslationX`],
    ['POST', `${base}/ExportSolution`],
    ['POST', `${base}/$batch`],
    ['POST', 'not a url'],
    ['POST', undefined],
  ]) assert.strictEqual(isTranslationExport(method, url), false, `${method} ${url}`);
});

test('the translation export is sent exactly once by the plugin\u2019s client — a gateway error ends it, a retry would run a second export of the same solution', async () => {
  const sent = [];
  const request = async (r) => { sent.push(`${r.method} ${r.url}`); return { statusCode: 503, headers: {}, body: JSON.stringify({ error: { message: 'Service Unavailable' } }) }; };
  const once = createAzHttpClient('https://contoso.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {}, sendOnce: isTranslationExport });
  const read = await readTranslationLabels({ post: (path, body) => once.post(`https://contoso.crm.dynamics.com/api/data/v9.2${path}`, body) }, 'Contoso_Tickets');
  assert.strictEqual(read.ok, false);
  assert.match(read.reason, /HTTP 503: Service Unavailable/);
  assert.strictEqual(sent.length, 1, sent.join(' | '));
  // …where the same client, told nothing, sends a throttled or unavailable request again, as it does every other request of the plugin.
  sent.length = 0;
  const usual = createAzHttpClient('https://contoso.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  await usual.post('https://contoso.crm.dynamics.com/api/data/v9.2/solutions/Microsoft.Dynamics.CRM.ExportTranslation', { SolutionName: 'x' });
  assert.ok(sent.length > 1, 'the policy is the one the export is taken out of');
});

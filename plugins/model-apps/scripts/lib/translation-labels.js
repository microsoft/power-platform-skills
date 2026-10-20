'use strict';
// The captions of a solution's forms, in EVERY provisioned language, from ONE translation export — what `--verify` reads a tab's or a section's caption from
// in a language the form's own read cannot show (lib/verify-spec.js, `labelProblem`).
//
// WHY AN EXPORT. The platform decides which languages' labels go into the FormXML a caller reads, and it returns fewer than the form stores: measured live, a
// form built and published with Spanish (3082) captions in an English-language (1033) organization keeps both languages, and its published FormXML —
// with or without an Accept-Language for the other language, unpublished or published — carries every label in 1033 alone. Neither does `RetrieveLocLabels` read
// them (a form's `formxml` "does not support localized labels": HTTP 400), nor any other column of the form row. A translation export is the one read that does:
//
//   POST {env}/api/data/v9.2/solutions/Microsoft.Dynamics.CRM.ExportTranslation        { "SolutionName": "<uniquename>" }
//   → 200 { "@odata.context": "…#Microsoft.Dynamics.CRM.ExportTranslationResponse", "ExportTranslationFile": "<base64 of a zip>" }
//
// The action is BOUND to the `solutions` collection: the unbound `POST …/ExportTranslation` answers 404. It exports the PUBLISHED layer (a caption changed in a
// draft and not published is not in it, which is the layer `--verify` checks), for the tables of the solution — Microsoft Learn: even a solution that holds
// one form exports the labels of every form of its table — and Learn documents it for an unmanaged solution, which is what the build makes. It costs ONE request that took 7.5–11.2 s for a solution of
// one table (a 5 KB zip, 44 KB of XML) and grows with the solution, because it exports every label of it.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/exporttranslation
//      https://learn.microsoft.com/en-us/power-apps/maker/data-platform/export-customized-entity-field-text-translation
//
// THE ARCHIVE holds `CrmTranslations.xml` and `[Content_Types].xml` (lib/zip-read.js reads it). The first is an Excel 2003 XML spreadsheet
// (https://learn.microsoft.com/en-us/previous-versions/office/developer/office-xp/aa140066(v=office.10)), shortened here to what matters:
//
//   <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" …>
//     <Worksheet ss:Name="Information">…</Worksheet>          the organization, the base language, the solution — read by nobody here
//     <Worksheet ss:Name="Display Strings">…</Worksheet>
//     <Worksheet ss:Name="Localized Labels"><Table>
//       <Row><Cell><Data ss:Type="String">Entity name</Data></Cell><Cell><Data ss:Type="String">Object ID</Data></Cell><Cell><Data ss:Type="String">Object Column Name</Data></Cell>
//            <Cell><Data ss:Type="Number">1033</Data></Cell><Cell><Data ss:Type="Number">3082</Data></Cell></Row>              ← the header: one column per language
//       <Row><Cell><Data ss:Type="String">new_ticket</Data></Cell><Cell><Data ss:Type="String">11111111-2222-3333-4444-555555555555</Data></Cell>
//            <Cell><Data ss:Type="String">displayname</Data></Cell><Cell><Data ss:Type="String">Tab One</Data></Cell><Cell><Data ss:Type="String">Pestana Uno</Data></Cell></Row>
//     </Table></Worksheet>
//   </Workbook>
//
// A tab's or a section's caption is a row of `Localized Labels` whose `Object ID` is the `id` the element has in the form's FormXML — not the form's id, and with no
// label id of its own — and whose `Object Column Name` is `displayname`. An empty cell is `<Data ss:Type="String"></Data>`: the row says the element has NO caption in
// that language. A form's own name is a row with the column `name`, keyed by the form's id; an attribute's, a view's and a field's caption on a form are rows of their
// own (`DisplayName`, `displayname` keyed by the cell's id). Only the rows of the column `displayname` are read, and they are looked up by (table, id).
//
// THE READ IS STRICT, because a pass is decided from it: the document must be one well-formed XML document of the plugin's strict reader (lib/strict-xml.js: no
// document type declaration, no entity but the predefined ones, nothing it would read differently from the SDK's parser), the workbook must be the platform's
// (its namespace, its sheet, its header), and a row, a cell or a type this does not understand makes the WHOLE export unreadable — never a skipped row, because the row
// skipped could be the one that was needed. What `--verify` does with an export it cannot read is leave the captions UNVERIFIED, where they were before it read exports.
//
// THE SHEET IS VALIDATED WHOLE, BEFORE ANYTHING IS READ FROM IT. The strict reader does not resolve namespaces — `ss:Row` is a name to it, not the `Row` of the
// spreadsheet namespace that it means to Excel — so a reader that picked out `Table`, `Row`, `Cell` and `Data` by name would pass over a row written `<ss:Row>`
// (a second, conflicting caption) or a sheet that declares another namespace, and settle a caption from what is left. So every element of `Localized Labels` is
// one of the platform's, by its name as written, in the place the platform puts it, with the attributes it writes — and the one namespace declaration in the sheet
// is the one the platform writes (Excel's, on WorksheetOptions). The platform writes the sheet that way (measured: no prefix on any element, `ss:` on every
// attribute, the `ss` prefix and the default namespace bound once, on the root), and a sheet written any other way is not one this reads. The worksheets are found
// the same way: any element whose name ends in `Worksheet`, with or without a prefix and wherever it is, must be a plain `<Worksheet>` child of the root that declares
// no namespace, and no prefix but `ss` may name the spreadsheet namespace.
//
// THE COST IS BOUNDED BEFORE IT IS PAID. The strict reader gives each element it answers the names of its ancestors, so a document of a few hundred kilobytes that
// nests deep, or under ancestors with long names, would cost gigabytes: such a document is refused while it is read — by its depth, by the length of a name, and by the
// number of elements answered — not after, when the process may already have run out of memory.
const { readXmlElements, XML_PREDEFINED } = require('./strict-xml.js');
const { readZipEntry } = require('./zip-read.js');

const WORKBOOK_ENTRY = 'CrmTranslations.xml';
const LABELS_SHEET = 'Localized Labels';
const CAPTION_COLUMN = 'displayname';
const SPREADSHEET_NAMESPACE = 'urn:schemas-microsoft-com:office:spreadsheet';
const HEADER = ['Entity name', 'Object ID', 'Object Column Name'];
const EXPORT_ACTION = '/solutions/Microsoft.Dynamics.CRM.ExportTranslation';
const EXPORT_PATH = /\/solutions\/Microsoft\.Dynamics\.CRM\.ExportTranslation$/;
// An LCID is at most 65535 (app-spec.js MAX_LCID); a header with more language columns than this is not the platform's.
const MAX_LANGUAGE_COLUMNS = 512;
// What one read may cost. Measured on a made-up workbook of 100,000 caption rows (41 MB of XML): 4.5 s and about 630 MB of memory, because the strict reader holds an
// object for every row, cell and cell text of the sheet. So the workbook is read up to 32 MiB of XML (some 75,000 rows, which no app's solution comes near), and an export
// that is larger is left unread — its captions stay unverified, with that said — rather than risk the memory of the process that is running the build.
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 32 * 1024 * 1024;
// Cell attributes of a spreadsheet that make a cell something other than its own text.
const UNSUPPORTED_CELL_ATTRIBUTES = ['ss:MergeAcross', 'ss:MergeDown', 'ss:ArrayRange', 'ss:Formula'];
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const EXCEL_NAMESPACE = 'urn:schemas-microsoft-com:office:excel';

// The shape of the `Localized Labels` sheet, as the platform writes it (measured on every export the lane captured): for each element, where it is (the names of its
// ancestors in the sheet) and the attributes it may have. `ss:Index` on a cell is the spreadsheet's own way to leave cells out (forward only, see cellsOf); the
// merge and formula attributes are named so that a cell that has one is refused for that, with its name. Nothing else is in the sheet, and nothing else is read.
const SHEET_SHAPE = new Map([
  ['Worksheet', { at: '', attributes: ['ss:Name', 'ss:Id', 'ss:Protected'] }],
  ['Table', { at: 'Worksheet', attributes: [] }],
  ['Column', { at: 'Worksheet/Table', attributes: ['ss:AutoFitWidth', 'ss:Width', 'ss:Span'] }],
  ['Row', { at: 'Worksheet/Table', attributes: ['ss:AutoFitHeight'] }],
  ['Cell', { at: 'Worksheet/Table/Row', attributes: ['ss:StyleID', 'ss:Index', ...UNSUPPORTED_CELL_ATTRIBUTES] }],
  ['Data', { at: 'Worksheet/Table/Row/Cell', attributes: ['ss:Type'] }],
  // The sheet's options, in Excel's namespace (declared on the element itself): flags, none of them read, each with no attribute and at most a word of text.
  ['WorksheetOptions', { at: 'Worksheet', attributes: ['xmlns'] }],
  ...['Unsynced', 'Selected', 'ProtectObjects', 'ProtectScenarios', 'AllowFormatCells', 'AllowSizeCols', 'AllowSizeRows', 'AllowInsertCols', 'AllowInsertRows', 'AllowDeleteCols',
    'AllowDeleteRows', 'AllowSort', 'AllowFilter', 'AllowUsePivotTables'].map((name) => [name, { at: 'Worksheet/WorksheetOptions', attributes: [] }]),
].map(([name, shape]) => [name, { ...shape, attributes: new Set(shape.attributes) }]));
// The elements of the sheet that hold elements and white space only: text, a comment or a CDATA section directly inside one is not something this reads past.
const HOLDS_ELEMENTS_ONLY = new Set(['Worksheet', 'Table', 'Column', 'Row', 'Cell', 'WorksheetOptions']);
// The attributes a worksheet element may have, in the whole workbook: what the platform writes on its three sheets. Its name is `ss:Name`, and no other attribute
// can give it one.
const WORKSHEET_ATTRIBUTES = SHEET_SHAPE.get('Worksheet').attributes;

// Bounds of the read, each checked WHILE the strict reader reads, so that a hostile workbook costs no more than they allow (see the header). The platform's workbook
// nests 6 deep (Workbook/Worksheet/Table/Row/Cell/Data), and its sheet 5 (the same, from the Worksheet) — the sheet's bound is one more, so that an element inside a
// cell's Data is refused as the markup in a cell it is; its longest element name is 19 characters; it has 3 worksheets; and a sheet at the byte limit holds about
// 1.1 million elements (a row of five short cells is some 330 bytes and 11 elements). Measured: a sheet of 1.6 million empty rows (9 MB) is refused at the element
// budget after 2 s and 530 MB of heap — about what a legitimate 29 MB workbook of 70,000 rows costs to read (410 MB) — where 32 MB of such rows would take some 2 GB.
const MAX_WORKBOOK_DEPTH = 16;
const MAX_SHEET_DEPTH = 6;
const MAX_NAME_LENGTH = 64;
const MAX_WORKSHEETS = 64;
const MAX_SHEET_ELEMENTS = 1500000;

class Unreadable extends Error {}
const refuse = (message) => { throw new Unreadable(message); };

// A GUID as FormXML and the export both write them — with or without braces, in either case — as the one form the lookup is made by; null for anything else.
function guidOf(value) {
  if (typeof value !== 'string') return null;
  const bare = value.trim().replace(/^\{(.*)\}$/, '$1').toLowerCase();
  return GUID.test(bare) ? bare : null;
}
const keyOf = (entity, id) => (typeof entity === 'string' && entity !== '' && id ? `${entity.toLowerCase()}|${id}` : undefined);

// The text of a <Data> element — `<Data ss:Type="String">Tab One</Data>`, or `<Data ss:Type="String"/>` — whose place in `sheet` the strict reader gave (`spans`).
// The strict reader has checked every reference in it is a predefined entity or a character reference to a character XML allows, so they are decoded here and nothing
// else is: markup in a cell (a child element, a CDATA section, a comment) is not text this reads. Line ends are read as an XML parser reads them (a CR LF and a lone CR
// are a line feed, and `&#13;` stays a carriage return), so a caption compares as the SDK's own FormXML parser gives it.
function dataText(sheet, data) {
  const type = data.attrs['ss:Type'];
  if (type === undefined) refuse('a Data element has no ss:Type');
  if (type !== 'String' && type !== 'Number') refuse(`a cell has the type '${type}', and only String and Number cells are read`);
  const whole = sheet.slice(data.start, data.end);
  let quote = '';
  let close = -1;
  for (let i = 1; i < whole.length; i += 1) {
    const c = whole[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === '\'') {
      quote = c;
    } else if (c === '>') {
      close = i;
      break;
    }
  }
  if (close < 0) refuse('a Data element is not closed');
  if (whole[close - 1] === '/') return '';
  const inner = whole.slice(close + 1, whole.lastIndexOf('</'));
  if (inner.includes('<')) refuse('there is markup inside a cell');
  return inner.replace(/\r\n?/g, '\n').replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|amp|quot|apos));/g, (ref, hex, dec, name) => (name
    ? XML_PREDEFINED[name]
    : String.fromCodePoint(parseInt(hex !== undefined ? hex : dec, hex !== undefined ? 16 : 10))));
}

// The cells of a row, by column: `{ text, type }`, the type of the cell's Data (`String` or `Number`) or null for a cell with none. A cell may say where it is
// (`ss:Index`, 1-based, forward only) and leave the ones before it out; a cell left out, or with no Data, is empty. A column past `limit` is a row with more cells than
// the header, which is refused; so is a cell that is merged or holds a formula.
function cellsOf(sheet, row, number, limit) {
  const cells = [];
  let column = 0;
  for (const cell of row.cells) {
    for (const name of UNSUPPORTED_CELL_ATTRIBUTES) if (cell.attrs[name] !== undefined) refuse(`row ${number} has a cell that is merged or holds a formula (${name})`);
    const index = cell.attrs['ss:Index'];
    if (index !== undefined) {
      if (!/^[1-9][0-9]{0,5}$/.test(index)) refuse(`row ${number} has an ss:Index that is not a column number ('${index}')`);
      if (Number(index) - 1 < column) refuse(`row ${number} has an ss:Index that goes back to a column the row has used already`);
      column = Number(index) - 1;
    }
    if (column >= limit) refuse(`row ${number} has more cells than the header names columns`);
    cells[column] = cell.data ? { text: dataText(sheet, cell.data), type: cell.data.attrs['ss:Type'] } : { text: '', type: null };
    column += 1;
  }
  return Array.from(cells, (cell) => cell || { text: '', type: null });
}

// The rows of the sheet, each with its cells and their Data elements, from EVERY element of the sheet, in document order (the strict reader has answered them all,
// and refused any name SHEET_SHAPE does not have) — once each one is found where the platform puts it, with only the attributes the platform writes on it, in the
// platform's order: one Table, its Columns before its Rows, then at most one WorksheetOptions, in Excel's namespace. An element is only ever the child of the last one
// opened at the place its path names, so a Cell belongs to the last Row and a Data to the last Cell.
function rowsOf(elements) {
  const rows = [];
  let row = null;
  let cell = null;
  let tables = 0;
  let options = 0;
  for (const element of elements) {
    const shape = SHEET_SHAPE.get(element.name);
    if (element.path !== shape.at) refuse(`a ${element.name} is not where the spreadsheet puts one (found in ${element.path || 'the root'})`);
    for (const attribute of Object.keys(element.attrs)) {
      if (!shape.attributes.has(attribute)) refuse(`a ${element.name} has the attribute ${attribute}, which the platform's sheet does not have`);
    }
    if (element.name === 'Table') {
      tables += 1;
      if (tables > 1) refuse('the worksheet has more than one Table');
    } else if (element.name === 'WorksheetOptions') {
      options += 1;
      if (options > 1 || tables === 0) refuse('the worksheet\'s WorksheetOptions are not one element after its Table');
      if (element.attrs.xmlns !== EXCEL_NAMESPACE) refuse(`the worksheet's WorksheetOptions are not in Excel's namespace (${EXCEL_NAMESPACE})`);
    } else if (element.name === 'Column') {
      if (rows.length > 0) refuse('a Column comes after a Row (a table\'s columns come before its rows)');
    } else if (element.name === 'Row') {
      row = { cells: [] };
      rows.push(row);
      cell = null;
    } else if (element.name === 'Cell') {
      cell = { attrs: element.attrs, data: null };
      row.cells.push(cell);
    } else if (element.name === 'Data') {
      if (cell.data) refuse('a cell has more than one Data element');
      cell.data = element;
    }
  }
  if (tables === 0) refuse('the worksheet has no Table');
  return rows;
}

// The language columns of the header row: the three fixed names, then one LCID for each language the environment has provisioned.
function languagesOf(cells) {
  if (cells.length < HEADER.length || HEADER.some((name, i) => cells[i] !== name)) refuse(`the header of '${LABELS_SHEET}' is not ${HEADER.join(', ')} and a column for each language`);
  const languages = [];
  for (const text of cells.slice(HEADER.length)) {
    const lcid = /^[1-9][0-9]{0,4}$/.test(text) ? Number(text) : 0;
    if (lcid < 1 || lcid > 65535) refuse(`the header of '${LABELS_SHEET}' names a language that is not an LCID ('${text}')`);
    if (languages.includes(lcid)) refuse(`the header of '${LABELS_SHEET}' names language ${lcid} twice`);
    languages.push(lcid);
  }
  if (languages.length === 0) refuse(`the header of '${LABELS_SHEET}' names no language`);
  return languages;
}

/**
 * Reads the text of a CrmTranslations.xml and answers where the caption of a tab or a section is, by the table and the id the element has in its form's FormXML.
 *
 *   parseTranslationWorkbook(xml)
 *     → { ok: true, languages: [1033, 3082], lookup(entity, id) }
 *     → { ok: false, detail }                 the workbook is not one this reads with certainty — nothing is answered from it
 *
 * `lookup` answers `{ found: false }` (no caption row for that table and id), `{ found: true, ambiguous: true }` (more than one: the export cannot say which is the
 * form's) or `{ found: true, ambiguous: false, texts: Map<lcid, text> }`, a text for every language column, `''` where the cell is empty.
 *
 * @param {string} xml
 */
function parseTranslationWorkbook(xml) {
  try {
    // The whole document, for its root and its worksheets: every element whose name ends in `Worksheet`, prefixed or not and wherever it is, is answered, so that
    // a sheet the spreadsheet would see is never one this passes over. While it reads, no element name may be long and no element deep (see the header): only these
    // few elements are kept, but each carries the names of its ancestors.
    let workbooks = 0;
    let worksheets = 0;
    const workbookPart = (name) => {
      if (name.length > MAX_NAME_LENGTH) refuse(`it has an element whose name is longer than ${MAX_NAME_LENGTH} characters`);
      if (name === 'Workbook') {
        workbooks += 1;
        if (workbooks > 1) refuse('it has more than one Workbook element');
        return true;
      }
      if (name !== 'Worksheet' && !name.endsWith(':Worksheet')) return false;
      worksheets += 1;
      if (worksheets > MAX_WORKSHEETS) refuse(`it has more than ${MAX_WORKSHEETS} worksheets`);
      return true;
    };
    const whole = readXmlElements(xml, workbookPart, { spans: true, maxDepth: MAX_WORKBOOK_DEPTH });
    if (!whole.ok) refuse(`it is not one XML document the plugin reads (${whole.detail})`);
    const roots = whole.elements.filter((e) => e.name === 'Workbook');
    if (roots.length !== 1 || roots[0].path !== '' || roots[0].attrs.xmlns !== SPREADSHEET_NAMESPACE || roots[0].attrs['xmlns:ss'] !== SPREADSHEET_NAMESPACE) {
      refuse(`it is not a spreadsheet workbook of the namespace the platform writes (${SPREADSHEET_NAMESPACE}, with ss: for it)`);
    }
    // A second prefix for the spreadsheet namespace would make `x:Name` a sheet's name and `x:Row` a row as much as `ss:Name` and `Row` are.
    for (const [attribute, value] of Object.entries(roots[0].attrs)) {
      if (attribute.startsWith('xmlns:') && attribute !== 'xmlns:ss' && value === SPREADSHEET_NAMESPACE) refuse(`it names the spreadsheet namespace with a prefix other than ss: (${attribute})`);
    }
    const sheets = whole.elements.filter((e) => e.name !== 'Workbook');
    for (const sheet of sheets) {
      // A worksheet that declares a namespace, or is written with a prefix, is either not a spreadsheet's worksheet at all or one under another name: never read.
      if (sheet.name !== 'Worksheet' || sheet.path !== 'Workbook') refuse(`it has a worksheet that is not where the spreadsheet puts one (<${sheet.name}> in ${sheet.path || 'the root'})`);
      for (const attribute of Object.keys(sheet.attrs)) {
        if (!WORKSHEET_ATTRIBUTES.has(attribute)) refuse(`it has a worksheet with the attribute ${attribute}, which the platform's worksheets do not have`);
      }
      if (sheet.attrs['ss:Name'] === undefined) refuse('it has a worksheet with no ss:Name');
    }
    const labelSheets = sheets.filter((e) => e.attrs['ss:Name'] === LABELS_SHEET);
    if (labelSheets.length === 0) refuse(`it has no worksheet named '${LABELS_SHEET}'`);
    // Excel tells sheet names apart without regard to case: a sheet named this one in other letters is the same sheet to it.
    if (sheets.filter((e) => e.attrs['ss:Name'].toLowerCase() === LABELS_SHEET.toLowerCase()).length > 1) refuse(`it has more than one worksheet named '${LABELS_SHEET}'`);

    // The sheet is read on its own, from the text of its element: the strict reader answers elements of the whole document, and this keeps the elements of the other
    // sheets (which can be far larger) out of memory. A fragment that is one well-formed element reads like a document. EVERY element of it is answered, and any
    // name the platform's sheet does not have ends the read at once: it is not skipped, and nothing under it is kept.
    let answered = 0;
    const sheetPart = (name) => {
      if (!SHEET_SHAPE.has(name)) {
        refuse(`the worksheet '${LABELS_SHEET}' has an element <${name.slice(0, MAX_NAME_LENGTH)}>, which the platform's sheet does not have (markup inside a cell, or an element of another kind or namespace)`);
      }
      answered += 1;
      if (answered > MAX_SHEET_ELEMENTS) refuse(`the worksheet '${LABELS_SHEET}' has more than ${MAX_SHEET_ELEMENTS} elements`);
      return true;
    };
    const sheet = xml.slice(labelSheets[0].start, labelSheets[0].end);
    const parts = readXmlElements(sheet, sheetPart, { spans: true, maxDepth: MAX_SHEET_DEPTH, elementOnly: (name) => HOLDS_ELEMENTS_ONLY.has(name) });
    if (!parts.ok) refuse(`the worksheet '${LABELS_SHEET}' is not read (${parts.detail})`);
    const rows = rowsOf(parts.elements);
    if (rows.length === 0) refuse(`the worksheet '${LABELS_SHEET}' has no header row`);
    const header = cellsOf(sheet, rows[0], 1, MAX_LANGUAGE_COLUMNS + HEADER.length);
    // The header's names are text; a language is an LCID, which the platform writes as a Number (and which reads the same as text).
    header.forEach((cell, column) => {
      if (cell.type === 'Number' && column < HEADER.length) refuse(`the header of '${LABELS_SHEET}' has a Number where it names a column (${HEADER[column]})`);
    });
    const languages = languagesOf(header.map((cell) => cell.text));

    const captions = new Map();
    const ambiguous = new Set();
    for (let i = 1; i < rows.length; i += 1) {
      const number = i + 1;
      const row = cellsOf(sheet, rows[i], number, HEADER.length + languages.length);
      // A caption is text: a Number cell would be read by its digits as written ("1.50", "1E3"), which is not what a form shows, and the platform writes none.
      if (row.some((cell) => cell.type === 'Number')) refuse(`row ${number} has a Number cell, and the cells of a row are text (String)`);
      const cells = row.map((cell) => cell.text);
      if (cells.length === 0) continue;
      if (cells.length < HEADER.length) refuse(`row ${number} has fewer than the three cells (${HEADER.join(', ')}) that say what a row is about`);
      if (cells[2] !== CAPTION_COLUMN) continue;
      // A row whose Object ID is no GUID cannot be the caption of an element that has one.
      const key = keyOf(cells[0], guidOf(cells[1]));
      if (key === undefined) continue;
      if (captions.has(key)) {
        ambiguous.add(key);
        continue;
      }
      captions.set(key, new Map(languages.map((lcid, column) => [lcid, cells[HEADER.length + column] || ''])));
    }
    const lookup = (entity, id) => {
      const key = keyOf(entity, guidOf(id));
      if (key === undefined) return { found: false };
      if (ambiguous.has(key)) return { found: true, ambiguous: true };
      const texts = captions.get(key);
      return texts ? { found: true, ambiguous: false, texts } : { found: false };
    };
    return { ok: true, languages, lookup };
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, detail: err.message };
    throw err;
  }
}

/**
 * Whether one caption — `text`, in `lcid`, of the tab or section `id` of a form of `entity` — is what the export holds.
 *
 *   { state: 'same' }                                        the export has this text
 *   { state: 'different', have, others: [{ lcid, text }] }   it has `have` (an empty string: no caption in that language), and these in other languages
 *   { state: 'unsettled', why }                              the export cannot say: no such column, no id to look up, no row, or more than one
 *
 * `what` names the element in a reason ("tab 'tab_main'").
 * @param {{ languages: number[], lookup: Function }} exported what `readTranslationLabels` answered
 */
function settleCaption(exported, { entity, id, lcid, text, what = 'the tab or section' }) {
  if (!exported.languages.includes(lcid)) return { state: 'unsettled', why: `the export has no column for language ${lcid}` };
  if (guidOf(id) === null) return { state: 'unsettled', why: 'the form\'s FormXML gives a tab or section no id to look it up by' };
  const hit = exported.lookup(entity, id);
  const named = `${what} (id ${guidOf(id)}, table ${entity})`;
  if (!hit.found) return { state: 'unsettled', why: `the export has no caption row for ${named}` };
  if (hit.ambiguous) return { state: 'unsettled', why: `the export has more than one caption row for ${named}` };
  const have = hit.texts.get(lcid);
  if (have === text) return { state: 'same' };
  return { state: 'different', have, others: [...hit.texts].filter(([other, otherText]) => other !== lcid && otherText !== '').map(([other, otherText]) => ({ lcid: other, text: otherText })) };
}

// A message is what an error says, and only its first 300 characters: a platform answer can be a page of text.
const said = (err) => String((err && err.message) || err).slice(0, 300);

/**
 * Asks the platform for the translation export of a solution and reads the workbook out of it. Never throws: whatever goes wrong — no client, a request that fails, an
 * answer that is an error or not an export, an archive or a workbook that is not read with certainty — is `{ ok: false, reason }`, which `--verify` reports as the reason
 * a caption stays unverified.
 *
 *   readTranslationLabels(sdk.dataverse, 'Contoso_Tickets') → { ok: true, languages, lookup } | { ok: false, reason }
 *
 * @param {{ post: Function }} client the SDK's Dataverse client: `post(path, body)` resolves `{ status, headers, body }` and does not throw on a non-2xx
 * @param {string} solutionUniqueName
 */
async function readTranslationLabels(client, solutionUniqueName) {
  try {
    const name = typeof solutionUniqueName === 'string' ? solutionUniqueName.trim() : '';
    if (!name) return { ok: false, reason: 'there is no solution name to export the translations of' };
    if (!client || typeof client.post !== 'function') return { ok: false, reason: 'the SDK has no Dataverse client that can post a translation export request' };
    let answer;
    try {
      answer = await client.post(EXPORT_ACTION, { SolutionName: name });
    } catch (err) {
      return { ok: false, reason: `the request failed: ${said(err)}` };
    }
    if (!answer || typeof answer !== 'object') return { ok: false, reason: 'the platform gave no answer' };
    if (!(answer.status >= 200 && answer.status < 300)) {
      const message = answer.body && answer.body.error && answer.body.error.message;
      return { ok: false, reason: `HTTP ${answer.status}${typeof message === 'string' && message ? `: ${message.slice(0, 300)}` : ''}` };
    }
    const file = answer.body && answer.body.ExportTranslationFile;
    if (typeof file !== 'string' || file === '') return { ok: false, reason: 'the answer holds no ExportTranslationFile' };
    if (file.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file)) return { ok: false, reason: 'ExportTranslationFile is not base64' };
    let bytes;
    try {
      bytes = readZipEntry(Buffer.from(file, 'base64'), WORKBOOK_ENTRY, { maxArchiveBytes: MAX_ARCHIVE_BYTES, maxEntryBytes: MAX_WORKBOOK_BYTES });
    } catch (err) {
      return { ok: false, reason: `the archive of the export is not readable: ${said(err)}` };
    }
    let xml;
    try {
      xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: 'the workbook of the export is not valid UTF-8' };
    }
    // The bytes were read as UTF-8, so a document that says it is in another encoding is not the one that was read.
    const declared = /^\s*<\?xml\b[^?]*?\bencoding\s*=\s*["']([^"']+)["']/i.exec(xml.slice(0, 300));
    if (declared && !/^utf-8$/i.test(declared[1])) return { ok: false, reason: `the workbook of the export declares the encoding ${declared[1]}, and only UTF-8 is read` };
    const workbook = parseTranslationWorkbook(xml);
    if (!workbook.ok) return { ok: false, reason: `the workbook of the export is not readable: ${workbook.detail}` };
    return { ok: true, languages: workbook.languages, lookup: workbook.lookup };
  } catch (err) {
    return { ok: false, reason: `the export could not be read: ${said(err)}` };
  }
}

/**
 * Whether a request is the ExportTranslation of a solution — `sendOnce` for the plugin's HTTP client (lib/sdk-http-client.js), which otherwise sends a request again on a
 * throttled or unavailable answer and on a timeout. That is right for most requests and wrong for this one: it is a long action (the export of a large solution outlives the
 * client's five-minute wait, and a re-send then starts a SECOND export of the same solution beside the first, which is still running), and the answer to a failure is
 * `--verify` leaving the captions unverified, which costs nothing to repeat by running it again.
 */
function isTranslationExport(method, url) {
  if (String(method).toUpperCase() !== 'POST' || typeof url !== 'string') return false;
  try {
    return EXPORT_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

module.exports = { parseTranslationWorkbook, readTranslationLabels, settleCaption, isTranslationExport, WORKBOOK_ENTRY, LABELS_SHEET, CAPTION_COLUMN };

'use strict';
// A SYNTHESIZED translation export, for the tests of what `--verify` reads captions from. Every name, id and caption in it is invented: an
// export a real environment answers carries that environment's organization id, so none is ever stored here — what is stored is the SHAPE
// the platform was measured to answer, made again from made-up rows.
//
//   POST …/api/data/v9.2/solutions/Microsoft.Dynamics.CRM.ExportTranslation   { "SolutionName": "<uniquename>" }
//   → 200 { "@odata.context": "…#Microsoft.Dynamics.CRM.ExportTranslationResponse", "ExportTranslationFile": "<base64 of a zip>" }
//
// The zip holds `CrmTranslations.xml` (an Excel 2003 XML spreadsheet) and `[Content_Types].xml`, each deflated, with flags 0x0002, version needed 20,
// version made by 45, and — what a reader that takes the data's place from the CENTRAL directory gets wrong — an extra field of 28 bytes on each LOCAL
// header and none on the central one. The workbook has three worksheets, `Information`, `Display Strings` and `Localized Labels`; a caption is a row
// of the last, `Entity name | Object ID | Object Column Name | <one column per language, headed by its LCID>`, keyed by the `id` the tab or section has
// in the form's FormXML, and an empty cell is `<Data ss:Type="String"></Data>`.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/exporttranslation
//      https://learn.microsoft.com/en-us/power-apps/maker/data-platform/export-customized-entity-field-text-translation
const zlib = require('node:zlib');

const SPREADSHEET_NAMESPACE = 'urn:schemas-microsoft-com:office:spreadsheet';

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cellOf = (text, { type = 'String', style = 's24' } = {}) => `<Cell ss:StyleID="${style}"><Data ss:Type="${type}">${escapeXml(text)}</Data></Cell>`;
const rowOf = (cells) => `<Row ss:AutoFitHeight="0">${cells.join('')}</Row>`;
// What the platform writes around a sheet's rows, as measured: column widths (`ss:Span` for a run of columns) before them and, after the table, the sheet's options in Excel's own namespace —
// elements with no attribute, some of them empty. None of it is read; the reader holds the sheet to this shape, so a sheet made here is one it reads.
const COLUMNS = '<Column ss:AutoFitWidth="0" ss:Width="105.75" /><Column ss:Width="224.25" /><Column ss:AutoFitWidth="0" ss:Width="105.75" /><Column ss:AutoFitWidth="0" ss:Width="114.75" ss:Span="2" />';
const WORKSHEET_OPTIONS = '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><Unsynced /><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios>'
  + '<AllowFormatCells /><AllowSizeCols /><AllowSizeRows /><AllowInsertCols /><AllowInsertRows /><AllowDeleteCols /><AllowDeleteRows /><AllowSort /><AllowFilter /><AllowUsePivotTables /></WorksheetOptions>';
const sheetOf = (name, rows) => `<Worksheet ss:Name="${name}" ss:Id="${name}" ss:Protected="1"><Table>${COLUMNS}${rows.join('')}</Table>${WORKSHEET_OPTIONS}</Worksheet>`;

/**
 * The text of a CrmTranslations.xml: the platform's three worksheets, with `captions` as the rows of `Localized Labels`.
 * @param {object} [options]
 * @param {number[]} [options.languages] the language columns of `Localized Labels`, in order
 * @param {{ entity: string, id: string, column?: string, texts?: Object<number, string> }[]} [options.captions] one row each; a language with no text is an empty cell
 * @param {string} [options.sheetsAfter] raw XML put after the last worksheet
 */
function workbookXml({ languages = [1033, 3082], captions = [], sheetsAfter = '' } = {}) {
  const header = rowOf([
    cellOf('Entity name', { style: 's21' }), cellOf('Object ID', { style: 's21' }), cellOf('Object Column Name', { style: 's21' }),
    ...languages.map((lcid) => cellOf(String(lcid), { type: 'Number', style: 's21' })),
  ]);
  const labels = captions.map(({ entity, id, column = 'displayname', texts = {} }) => rowOf([
    cellOf(entity, { style: 's22' }), cellOf(id, { style: 's22' }), cellOf(column, { style: 's22' }),
    ...languages.map((lcid) => cellOf(texts[lcid] === undefined ? '' : texts[lcid])),
  ]));
  const information = [
    rowOf([cellOf('Organization ID:', { style: 's21' }), cellOf('00000000-0000-0000-0000-000000000000', { style: 's22' })]),
    rowOf([cellOf('Exported on:', { style: 's21' }), cellOf('2030-01-01T00:00:00', { type: 'DateTime', style: 's23' })]),
    rowOf([cellOf('Base language ID:', { style: 's21' }), cellOf('1033', { type: 'Number', style: 's22' })]),
  ];
  const displayStrings = [rowOf([cellOf('Entity name', { style: 's21' }), cellOf('Display String Key', { style: 's21' }), ...languages.map((lcid) => cellOf(String(lcid), { type: 'Number', style: 's21' }))])];
  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="${SPREADSHEET_NAMESPACE}" xmlns:o="urn:schemas-microsoft-com:office:office" `
    + `xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="${SPREADSHEET_NAMESPACE}" xmlns:html="http://www.w3.org/TR/REC-html40">`
    + '<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"></DocumentProperties>'
    + '<ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel"><ActiveSheet>0</ActiveSheet><ProtectStructure>False</ProtectStructure></ExcelWorkbook>'
    + '<Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom" /></Style></Styles>'
    + `${sheetOf('Information', information)}${sheetOf('Display Strings', displayStrings)}${sheetOf('Localized Labels', [header, ...labels])}${sheetsAfter}</Workbook>`;
}

// CRC-32 of the ZIP format (reflected, polynomial 0xEDB88320). `zlib.crc32` only exists from Node 22.2, and the suite runs on Node 20 as well.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

/**
 * A ZIP archive of `entries` ({ name, data }), laid out the way the platform's export is: a local header (30 bytes, the name, `localExtra` bytes of
 * extra field) and the data of each entry, then the central directory (46 bytes and the name each, no extra field), then the end record.
 * @param {{ name: string, data: string | Buffer }[]} entries
 * @param {object} [options]
 * @param {0 | 8} [options.method] 8 deflates the data (as the platform does); 0 stores it
 * @param {number} [options.localExtra] the size of the extra field of each local header
 * @param {number} [options.flags] the general-purpose flags both headers carry
 * @param {'signed' | 'unsigned' | 'missing'} [options.descriptor] the way a streaming writer lays an entry out: flag bit 3 set, the checksum and the sizes zero in the local header, and — for
 *   'signed' (what every writer in use produces) and 'unsigned' (the shorter form the format also allows) — a data descriptor after the data holding them; 'missing' is the damaged archive that says
 *   a descriptor follows and has none
 * @param {number} [options.versionMadeBy]
 * @param {string} [options.comment] the archive comment
 */
function zipOf(entries, { method = 8, localExtra = 28, flags = 0x0002, versionMadeBy = 45, comment = '', descriptor } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const entryFlags = descriptor === undefined ? flags : flags | 0x0008;
  for (const { name, data } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const stored = method === 8 ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entryFlags, 6);
    local.writeUInt16LE(method, 8);
    if (descriptor === undefined) {
      local.writeUInt32LE(crc32(raw), 14);
      local.writeUInt32LE(stored.length, 18);
      local.writeUInt32LE(raw.length, 22);
    }
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(localExtra, 28);
    const after = Buffer.alloc(descriptor === 'signed' ? 16 : descriptor === 'unsigned' ? 12 : 0);
    const values = descriptor === 'signed' ? 4 : 0;
    if (descriptor === 'signed') after.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
    if (after.length > 0) {
      after.writeUInt32LE(crc32(raw), values);
      after.writeUInt32LE(stored.length, values + 4);
      after.writeUInt32LE(raw.length, values + 8);
    }
    const body = Buffer.concat([local, nameBytes, Buffer.alloc(localExtra), stored, after]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entryFlags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));
    locals.push(body);
    offset += body.length;
  }
  const directory = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, directory, end, commentBytes]);
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/octet-stream" /></Types>';

/** The zip the platform answers with: the workbook, then the content-types part. */
const exportZip = (workbook, options) => zipOf([{ name: 'CrmTranslations.xml', data: workbook }, { name: '[Content_Types].xml', data: CONTENT_TYPES }], options);

/** The HTTP answer (`{ status, headers, body }`, as the plugin's client gives it) of a successful ExportTranslation holding `archive`. */
const exportAnswer = (archive) => ({
  status: 200,
  headers: {},
  body: { '@odata.context': 'https://contoso.crm.dynamics.com/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.ExportTranslationResponse', ExportTranslationFile: archive.toString('base64') },
});

// The path the plugin POSTs to, and the one request this test double understands.
const EXPORT_PATH = /\/solutions\/Microsoft\.Dynamics\.CRM\.ExportTranslation(?:\?|$)/;

module.exports = { workbookXml, zipOf, exportZip, exportAnswer, crc32, escapeXml, EXPORT_PATH, CONTENT_TYPES, SPREADSHEET_NAMESPACE };

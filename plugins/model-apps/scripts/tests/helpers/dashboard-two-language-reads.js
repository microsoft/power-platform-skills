'use strict';
// ONE dashboard, as the platform answered it live in an organization whose base language is English (1033) and which has Spanish
// (3082) provisioned too — the FormXML of its published row (a plain read) and of its saved layer (RetrieveUnpublished), once for a
// user whose own UI language is 1033 and once for a user whose own UI language is 3082. The dashboard had not been written since its
// build published it, and it has one tab, one section and four tiles (two charts and two lists). Ids, tables and names are replaced
// by placeholders; the label groups, which are what the reads differ in, are exactly as read. The one cell this module spells out
// four times, the fourth (a list of customers), read:
//   1033 user, published  <labels><label description="Gold Customers" languagecode="1033" /></labels>
//   1033 user, saved      <labels><label description="Gold Customers" languagecode="1033" /><label description="Work Orders" languagecode="3082" /></labels>
//   3082 user, published  <labels><label description="Customers" languagecode="3082" /><label description="Gold Customers" languagecode="1033" /></labels>
//   3082 user, saved      <labels><label description="Gold Customers" languagecode="1033" /><label description="Work Orders" languagecode="3082" /></labels>
// and on both layers, whoever read them, `@odata.etag` was the same token: the published row's and the saved layer's.
//
// A write to the saved layer moves its token and not the published row's; a publish moves both to the same new one. The tests
// that need "the dashboard as the platform's own token says it was published" give both reads `ROW_VERSION`, and "a draft saved
// after the publish" `MOVED_VERSION` for the saved read.
const ROW_VERSION = 'W/"1001"';
const MOVED_VERSION = 'W/"1002"';

const dashId = (n) => `{aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}}`;
const label = (lcid, text) => `<label description="${text}" languagecode="${lcid}" />`;
const TILE_CLASS = '{E7A81278-8635-4D9E-8D4D-59480B391C5B}';
const VIEW_OPEN = '11111111-0000-4000-8000-000000000001';
const VIEW_CRITICAL = '11111111-0000-4000-8000-000000000002';
const VIEW_GOLD = '11111111-0000-4000-8000-000000000003';
const CHART_PRIORITY = '22222222-0000-4000-8000-000000000001';
const CHART_STATUS = '22222222-0000-4000-8000-000000000002';

const chartTile = (n, table, view, chart) => `<control id="${dashId(n + 100)}" classid="${TILE_CLASS}"><parameters><TargetEntityType>${table}</TargetEntityType>`
  + `<ViewId>${view}</ViewId><VisualizationId>${chart}</VisualizationId><ChartGridMode>Chart</ChartGridMode></parameters></control>`;
const listTile = (n, table, view) => `<control id="${dashId(n + 100)}" classid="${TILE_CLASS}"><parameters><TargetEntityType>${table}</TargetEntityType>`
  + `<ViewId>${view}</ViewId><IsUserView>false</IsUserView><ChartGridMode>Grid</ChartGridMode><RecordsPerPage>10</RecordsPerPage></parameters></control>`;
const cell = (n, labels, tile) => `<cell id="${dashId(n)}" colspan="1" rowspan="1" showlabel="true"><labels>${labels}</labels>${tile}</cell>`;
// The text of cell `n` (1 to 4) in a read of the dashboard, and the same read with its first two cells, the two chart tiles, in the other order.
const cellOf = (xml, n) => { const found = new RegExp(`<cell id="${dashId(n)}".*?</cell>`).exec(xml); if (!found) throw new Error(`no cell ${n}`); return found[0]; };
const swapFirstTwoCells = (xml) => xml.replace(cellOf(xml, 1), '\u0000').replace(cellOf(xml, 2), cellOf(xml, 1)).replace('\u0000', cellOf(xml, 2));

// A read of the dashboard: the label groups (the XML inside each <labels>) of its tab, its section and its four cells, in that order.
function dashboardRead({ tab, section, cells }) {
  return `<form><tabs><tab id="${dashId(90)}" name="General" showlabel="true" expanded="true" verticallayout="true"><labels>${tab}</labels>`
    + `<columns><column width="100%"><sections><section id="${dashId(91)}" name="Section 1" showlabel="false" columns="2"><labels>${section}</labels><rows>`
    + `<row>${cell(1, cells[0], chartTile(1, 'new_workorder', VIEW_OPEN, CHART_PRIORITY))}${cell(2, cells[1], chartTile(2, 'new_workorder', VIEW_OPEN, CHART_STATUS))}</row>`
    + `<row>${cell(3, cells[2], listTile(3, 'new_workorder', VIEW_CRITICAL))}${cell(4, cells[3], listTile(4, 'new_customer', VIEW_GOLD))}</row>`
    + '</rows></section></sections></column></columns></tab></tabs></form>';
}

const CAPTIONS = ['By Priority', 'By Status', 'Critical Queue', 'Gold Customers'];
// The saved layer holds a 3082 caption in each cell, "Work Orders" in all four (the platform made them: the SDK writes one caption per cell,
// in the base language). The published read of the 3082 user words the last one as the name of its table, "Customers".
const SAVED_3082 = ['Work Orders', 'Work Orders', 'Work Orders', 'Work Orders'];
const PUBLISHED_3082 = ['Work Orders', 'Work Orders', 'Work Orders', 'Customers'];

// The user whose own language is the organization's base one: the published read carries 1033 alone, the saved read both languages.
const BASE_LANGUAGE_USER = {
  published: dashboardRead({ tab: label(1033, ''), section: label(1033, ''), cells: CAPTIONS.map((caption) => label(1033, caption)) }),
  saved: dashboardRead({ tab: label(1033, ''), section: label(1033, ''), cells: CAPTIONS.map((caption, i) => label(1033, caption) + label(3082, SAVED_3082[i])) }),
};
// The user whose own language is the second one: the published read carries both languages, the user's own first, and the empty captions of
// the tab and the section are in the user's language on both layers; the saved read is in the stored order, base language first.
const SECOND_LANGUAGE_USER = {
  published: dashboardRead({ tab: label(3082, ''), section: label(3082, ''), cells: CAPTIONS.map((caption, i) => label(3082, PUBLISHED_3082[i]) + label(1033, caption)) }),
  saved: dashboardRead({ tab: label(3082, ''), section: label(3082, ''), cells: CAPTIONS.map((caption, i) => label(1033, caption) + label(3082, SAVED_3082[i])) }),
};

module.exports = {
  BASE_LANGUAGE_USER, SECOND_LANGUAGE_USER, ROW_VERSION, MOVED_VERSION, dashboardRead, label, dashId, cellOf, swapFirstTwoCells,
  VIEW_OPEN, VIEW_CRITICAL, VIEW_GOLD, CHART_PRIORITY, CHART_STATUS,
};

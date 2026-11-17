'use strict';
// Whether a generative page may be deleted without leaving a form that still embeds it: the guard every page-delete path runs before it asks the SDK to delete
// a page (genpage-sdk.js `delete`, and teardown's page prelude through the integration contract).
//
// WHY. A Main form can embed a generative page (the SDK's FormControl.genPage: a cell control plus a `controlDescription` whose UxAgentControl names the page
// by id). Dataverse does not refuse to delete a page a form embeds, and the form then shows an error where the page was. The navigation check the delete
// already makes (an app's sitemap naming the page) does not see forms, so a page that only a form shows was deleted with nothing said.
//
// WHAT IS READ. Every system form of every table, in BOTH layers, followed to the last page of each answer:
//   GET /systemforms?$select=formid,objecttypecode,name,type,formxml                                                     the PUBLISHED layer
//   GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode,name,type,formxml  the SAVED layer
//   Prefer: odata.maxpagesize=100                                                            on both, and on every continuation read
//   { "value": [ … up to 100 rows: { "formid": "…", "objecttypecode": "account", "name": "Account", "type": 2, "formxml": "<form>…</form>" } … ],
//     "@odata.nextLink": "https://contoso.crm.dynamics.com/api/data/v9.0/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=…&$skiptoken=…" }
//   (with the header `Preference-Applied: odata.maxpagesize=100`; the last page has no `@odata.nextLink`)
// See https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublishedmultiple. A reference saved and not published is as
// real as a published one (the next publish of that form shows it), and one published but since removed from the saved copy is what users see until then, so
// either blocks. No table filter is applied: a page can be embedded in a form of a table the deleting app never named, and a narrow scan that finds nothing
// proves nothing. The reads are made only when there is a page to delete — none on any other path — and they are shared by every page of one delete.
//
// WHY 100 FORMS AT A TIME. With no page size Dataverse answers up to 5000 rows at once, and the saved layer costs about 22 ms per form with its formxml
// (measured on an environment of 3700 forms: one unpaged saved-layer answer took 80 s, above the 60 s read timeout of lib/sdk-http-client.js, so it was cut
// off with ECONNRESET on every attempt and the guard could never finish). `Prefer: odata.maxpagesize` asks for smaller pages, and Dataverse follows it on both
// layers (measured: `Preference-Applied` in each answer, an `@odata.nextLink` on each page, no form twice, the same first page when it is read again). A page
// of 100 took 2.2 to 3.8 s in the saved layer and under 0.3 s in the published one once warm. The paging rule says to send the same preference on every
// continuation read and to follow the link as it is: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results
// The guard reads EVERY page: a filter on the form XML (`contains(formxml, …)`) cannot see a control name written with a character reference, so it never
// replaces the full read.
//
// THE BUDGET. The reads grow with the forms (one read per 100 forms in each layer), under an absolute cap of MAX_FORMS_PER_LAYER forms in each layer and the
// reads those take (MAX_READS_PER_LAYER). A layer that answers more forms than that, or needs one more read, is refused before that read is sent — never cut
// short, which would answer "no reference" about forms that were never looked at.
//
// HOW A REFERENCE IS RECOGNISED. Each form is read as ONE complete XML document by the strict reader (strict-xml.js), so a comment, a CDATA section or a GUID
// that only appears in some text is never taken for an element. A reference is
//   <controlDescription forControl="{…}"><customControl name="MscrmControls.UxAgentControl" formFactor="2">
//     <parameters><RefId type="SingleLine.Text" static="true">11111111-0000-4000-8000-000000000001</RefId>…</parameters></customControl></controlDescription>
// (the shape the SDK writes: cds-maker-sdk adapters/formGenPageEmbed.ts). What such a control holds that is not one plain static page id — a RefId bound to a
// column (no `static="true"`), a value written with a character reference or a CDATA section, an empty value, no RefId at all — could name ANY page, so it is
// UNKNOWN, and an unknown blocks every delete as a reference would: the guard never answers "safe" about a form it could not read to the end.
//
// FAIL CLOSED. A read that fails, an answer that is no list, pages that are not one complete list of a layer (a form twice, a form with no id, fewer forms than an
// answer counts — see `budgeted`), a form whose XML the strict reader refuses, or a layer that would go past the budget (above) is a
// refusal (GENPAGE_FORM_REFERENCES_UNREADABLE), never an empty result. There is no flag that skips the guard: the maker takes the page out of the form (or deletes
// the form, if it is theirs) and runs the delete again. The reads are not atomic against a maker editing forms at the same moment, so a delete should still run
// in a quiet window; a dependency-aware delete in the platform would close that gap.
const { readXmlElements } = require('./strict-xml.js');
const { readSystemFormLayer, FORMS_PER_READ } = require('./systemform-inventory.js');

const UX_AGENT_CONTROL = 'mscrmcontrols.uxagentcontrol';
const GUID_TEXT = /^[ \t\r\n]*\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?[ \t\r\n]*$/;
const GUID = /^\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?$/;
const SELECT = 'formid,objecttypecode,name,type,formxml';
const LAYERS = Object.freeze([
  { layer: 'published', path: `/systemforms?$select=${SELECT}` },
  { layer: 'saved', path: `/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${SELECT}` },
]);
// How many forms one read asks for is the shared reader's (systemform-inventory.js FORMS_PER_READ, `Prefer: odata.maxpagesize=100`), and so is how long one
// read takes: about 22 ms a form in the saved layer as measured, so a page of 100 was 2 to 4 s against the 60 s a read may take. That is a measurement,
// not a bound: a read that is slower still, or fails, refuses the delete.
// The most forms the scan reads in one layer: more than five times the largest environment measured (3700 forms). A layer with more is refused rather than
// cut short. At the measured cost that is about ten minutes of saved-layer reads, so the cap bounds how long a delete can spend here.
const MAX_FORMS_PER_LAYER = 20000;
// The reads those forms take, plus one for a last page the platform may answer empty.
const MAX_READS_PER_LAYER = Math.ceil(MAX_FORMS_PER_LAYER / FORMS_PER_READ) + 1;

function guardError(message, props) {
  return Object.assign(new Error(message), { transient: false, outcome: 'nothing' }, props);
}

function pageIdOf(value) {
  const match = GUID.exec(String(value === undefined || value === null ? '' : value).trim());
  if (!match) throw guardError(`'${value}' is not a page id`, { code: 'GENPAGE_ID_INVALID' });
  return match[1].toLowerCase();
}

// The paging, the budget and the check that the pages are ONE complete listing of a layer (a form twice or with no id, fewer forms than an answer
// declares) are the shared reader's: systemform-inventory.js. What is this guard's own is that it reads every table, and the words of a refusal:
// every one is GENPAGE_FORM_REFERENCES_UNREADABLE, and nothing is deleted. A layer past the budget is `budgetExhausted`, pages that are not one listing
// `incompleteScan`; any other failure keeps the reader's error as `cause`.
function refusals(layer) {
  const code = 'GENPAGE_FORM_REFERENCES_UNREADABLE';
  return {
    code,
    budget: (why) => guardError(`the forms in the ${layer} layer could not all be read ${why}, so it is not known whether one embeds the page. Nothing was deleted.`, { code, budgetExhausted: true }),
    incomplete: (why) => guardError(`the forms in the ${layer} layer could not all be read: ${why}, so the pages are not one complete list of the forms and it is not known whether one embeds the page. Nothing was deleted.`, { code, incompleteScan: true }),
    short: (declared, held) => guardError(`the forms in the ${layer} layer could not all be read: the answers declare at least ${declared} forms but the pages held ${held}, so the pages are not one complete list of the forms and it is not known whether one embeds the page. Nothing was deleted.`, { code, incompleteScan: true }),
    failed: (error) => guardError(`the forms in the ${layer} layer could not be read (${String((error && error.message) || error)}), so it is not known whether one embeds the page`, { code, cause: error }),
  };
}

/**
 * Every system form of every table, in the published and the saved layer, each read to its last page, FORMS_PER_READ forms a read.
 * @param {{ get: Function, getAbsolute?: Function }} client the SDK's Dataverse client (`sdk.dataverse`)
 * @param {{ maxForms?: number, maxReads?: number }} [options] the most forms, and reads, the scan may take in EACH layer (default MAX_FORMS_PER_LAYER, and the
 *   reads those need); a test lowers them
 * @returns {Promise<{ forms: Array<{ formid: string, table: string, name: string, type: *, layer: 'published'|'saved', formxml: * }>, reads: number }>}
 * @throws GENPAGE_FORM_REFERENCES_UNREADABLE when a read fails, answers no list, a layer's pages are not one complete list (`incompleteScan`), or a layer goes
 *   past the budget (`budgetExhausted`)
 */
async function readAllFormLayers(client, { maxForms = MAX_FORMS_PER_LAYER, maxReads = Math.ceil(maxForms / FORMS_PER_READ) + 1 } = {}) {
  if (!client || typeof client.get !== 'function') throw guardError('the forms cannot be read: no Dataverse client', { code: 'GENPAGE_FORM_REFERENCES_UNREADABLE' });
  let reads = 0;
  const forms = [];
  for (const { layer, path } of LAYERS) {
    const stats = { reads: 0 };
    let rows;
    try {
      ({ rows } = await readSystemFormLayer(client, { path, label: `the forms in the ${layer} layer`, maxForms, maxReads, errors: refusals(layer), stats }));
    } finally {
      reads += stats.reads;
    }
    for (const row of rows) {
      forms.push({
        formid: row && row.formid !== undefined ? String(row.formid).toLowerCase() : '',
        table: row && row.objecttypecode !== undefined ? String(row.objecttypecode) : '',
        name: row && typeof row.name === 'string' ? row.name : '',
        type: row ? row.type : undefined,
        layer,
        formxml: row ? row.formxml : undefined,
      });
    }
  }
  return { forms, reads };
}

// The text an element holds, given its span in `xml` (strict-xml.js, `spans`): what is between the end of its start tag and the start of its end tag, or '' for
// an empty-element tag. The strict reader has already accepted the document, so the start tag ends at the first ">" outside a quoted value (a value may hold
// ">", never "<"), and the end tag is the last "</" of the span.
function elementText(xml, start, end) {
  let quote = 0;
  let at = start + 1;
  for (; at < end; at += 1) {
    const c = xml.charCodeAt(at);
    if (quote) { if (c === quote) quote = 0; } else if (c === 0x22 || c === 0x27) quote = c; else if (c === 0x3E) break;
  }
  if (xml.charCodeAt(at - 1) === 0x2F) return '';
  return xml.slice(at + 1, xml.lastIndexOf('</', end - 1));
}

/**
 * The pages one form's XML embeds, and the UxAgentControl bindings in it that could name any page.
 * @param {*} formxml
 * @returns {{ ok: true, pageIds: string[], unknown: string[] } | { ok: false, detail: string }} page ids in lower case; `unknown` describes each binding that is not one static page id
 */
function embeddedPageReferences(formxml) {
  const read = readXmlElements(formxml, (name) => name === 'customControl' || name === 'RefId', { spans: true });
  if (!read.ok) return { ok: false, detail: read.detail };
  const controls = read.elements.filter((e) => e.name === 'customControl' && String(e.attrs.name || '').toLowerCase() === UX_AGENT_CONTROL);
  const refIds = read.elements.filter((e) => e.name === 'RefId' && /(?:^|\/)customControl\/parameters$/.test(e.path));
  const pageIds = new Set();
  const unknown = [];
  for (const control of controls) {
    const inside = refIds.filter((r) => r.start > control.start && r.end <= control.end);
    const where = `the UxAgentControl${control.attrs.formFactor !== undefined ? ` for form factor ${control.attrs.formFactor}` : ''}`;
    if (!inside.length) { unknown.push(`${where} names no page`); continue; }
    for (const ref of inside) {
      if (ref.attrs.static !== 'true') { unknown.push(`${where} takes its page from a column, not a fixed page id`); continue; }
      const match = GUID_TEXT.exec(elementText(formxml, ref.start, ref.end));
      if (!match) { unknown.push(`${where} holds a page id that is not written as one plain id`); continue; }
      pageIds.add(match[1].toLowerCase());
    }
  }
  return { ok: true, pageIds: [...pageIds], unknown };
}

/**
 * What stands in the way of deleting `pageIds`: the forms that embed each, and the forms that cannot be read or hold a binding that could name any page.
 * Reads nothing when `pageIds` is empty. `budget` is readAllFormLayers' options ({ maxForms, maxReads }), for a test.
 * @returns {Promise<{ safe: boolean, references: Map<string, object[]>, unknown: object[], reads: number, formsScanned: number }>}
 * @throws GENPAGE_FORM_REFERENCES_UNREADABLE when the forms cannot all be read (see readAllFormLayers)
 */
async function pageDeletionReferences(client, pageIds, budget = {}) {
  const ids = [...new Set((pageIds || []).map(pageIdOf))];
  const references = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return { safe: true, references, unknown: [], reads: 0, formsScanned: 0 };
  // ONE scan for every page of the delete: what it costs depends on the forms the environment holds, not on how many pages are deleted.
  const { forms, reads } = await readAllFormLayers(client, budget);
  const unknown = [];
  for (const form of forms) {
    const where = { formid: form.formid, table: form.table, name: form.name, layer: form.layer };
    const found = embeddedPageReferences(form.formxml);
    if (!found.ok) { unknown.push({ ...where, detail: `its XML cannot be read (${found.detail})` }); continue; }
    for (const detail of found.unknown) unknown.push({ ...where, detail });
    for (const id of found.pageIds) if (references.has(id)) references.get(id).push(where);
  }
  const safe = !unknown.length && [...references.values()].every((list) => !list.length);
  return { safe, references, unknown, reads, formsScanned: forms.length };
}

const formText = (f) => `${f.name ? `${JSON.stringify(f.name)} ` : ''}(form ${f.formid || '?'} of table ${f.table || '?'}, ${f.layer} layer)`;

/**
 * Refuses, before anything is deleted, a delete of `pageIds` that would leave a form embedding one of them — or that cannot be proven not to.
 * @returns {Promise<{ reads: number, formsScanned: number }>} when no form embeds any of the pages
 * @throws GENPAGE_EMBEDDED_IN_FORM (with `references`: [{ pageId, forms }]) or GENPAGE_FORM_REFERENCES_UNREADABLE (with `unknown`)
 */
async function assertPageDeletionSafe(client, pageIds, options) {
  const result = await pageDeletionReferences(client, pageIds, options);
  const embedded = [...result.references].filter(([, forms]) => forms.length).map(([pageId, forms]) => ({ pageId, forms }));
  if (embedded.length) {
    const text = embedded.map((e) => `page ${e.pageId} is embedded in ${e.forms.map(formText).join(', ')}`).join('; ');
    throw guardError(`${text}. A form left embedding a deleted page shows an error where the page was. Take the page out of each form (or delete the form, if it is yours), publish it, then delete the page again.`, { code: 'GENPAGE_EMBEDDED_IN_FORM', references: embedded, unknown: result.unknown, reads: result.reads });
  }
  if (result.unknown.length) {
    const text = result.unknown.slice(0, 5).map((u) => `${formText(u)}: ${u.detail}`).join('; ');
    throw guardError(`it is not known whether a form embeds the page: ${text}${result.unknown.length > 5 ? `; and ${result.unknown.length - 5} more` : ''}. Nothing was deleted; fix or remove the binding, then delete the page again.`, { code: 'GENPAGE_FORM_REFERENCES_UNREADABLE', unknown: result.unknown, reads: result.reads });
  }
  return { reads: result.reads, formsScanned: result.formsScanned };
}

module.exports = { readAllFormLayers, embeddedPageReferences, pageDeletionReferences, assertPageDeletionSafe, formText, elementText, FORMS_PER_READ, MAX_FORMS_PER_LAYER, MAX_READS_PER_LAYER };

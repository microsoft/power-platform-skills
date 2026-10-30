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
//   { "value": [ { "formid": "…", "objecttypecode": "account", "name": "Account", "type": 2, "formxml": "<form>…</form>" } ], "@odata.nextLink": "…" }
// See https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublishedmultiple. A reference saved and not published is as
// real as a published one (the next publish of that form shows it), and one published but since removed from the saved copy is what users see until then, so
// either blocks. No table filter is applied: a page can be embedded in a form of a table the deleting app never named, and a narrow scan that finds nothing
// proves nothing. The reads are made only when there is a page to delete — none on any other path — and they are shared by every page of one delete.
//
// HOW A REFERENCE IS RECOGNISED. Each form is read as ONE complete XML document by the strict reader (strict-xml.js), so a comment, a CDATA section or a GUID
// that only appears in some text is never taken for an element. A reference is
//   <controlDescription forControl="{…}"><customControl name="MscrmControls.UxAgentControl" formFactor="2">
//     <parameters><RefId type="SingleLine.Text" static="true">11111111-0000-4000-8000-000000000001</RefId>…</parameters></customControl></controlDescription>
// (the shape the SDK writes: cds-maker-sdk adapters/formGenPageEmbed.ts). What such a control holds that is not one plain static page id — a RefId bound to a
// column (no `static="true"`), a value written with a character reference or a CDATA section, an empty value, no RefId at all — could name ANY page, so it is
// UNKNOWN, and an unknown blocks every delete as a reference would: the guard never answers "safe" about a form it could not read to the end.
//
// FAIL CLOSED. A read that fails, an answer that is no list, a form whose XML the strict reader refuses, or a scan that would go past its read budget is a
// refusal (GENPAGE_FORM_REFERENCES_UNREADABLE), never an empty result. There is no flag that skips the guard: the maker takes the page out of the form (or deletes
// the form, if it is theirs) and runs the delete again. The reads are not atomic against a maker editing forms at the same moment, so a delete should still run
// in a quiet window; a dependency-aware delete in the platform would close that gap.
const { readXmlElements } = require('./strict-xml.js');
const { collectionRows } = require('./app-components.js');

const UX_AGENT_CONTROL = 'mscrmcontrols.uxagentcontrol';
const GUID_TEXT = /^[ \t\r\n]*\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?[ \t\r\n]*$/;
const GUID = /^\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?$/;
const SELECT = 'formid,objecttypecode,name,type,formxml';
const LAYERS = Object.freeze([
  { layer: 'published', path: `/systemforms?$select=${SELECT}` },
  { layer: 'saved', path: `/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${SELECT}` },
]);
// The most reads the scan may make for each page it guards (both layers, every continuation page): a Dataverse answer holds up to 5000 rows, so this is far
// more than an environment's forms need, and a scan that would need more is refused rather than cut short.
const DEFAULT_READS_PER_PAGE = 40;

function guardError(message, props) {
  return Object.assign(new Error(message), { transient: false, outcome: 'nothing' }, props);
}

function pageIdOf(value) {
  const match = GUID.exec(String(value === undefined || value === null ? '' : value).trim());
  if (!match) throw guardError(`'${value}' is not a page id`, { code: 'GENPAGE_ID_INVALID' });
  return match[1].toLowerCase();
}

// The client as the scan uses it: every read counted, and the read that would go past `maxReads` refused before it is sent.
function budgeted(client, maxReads, counter) {
  const spend = () => {
    if (counter.reads >= maxReads) {
      throw guardError(`the forms could not all be read within ${maxReads} reads, so it is not known whether one embeds the page`, { code: 'GENPAGE_FORM_REFERENCES_UNREADABLE', budgetExhausted: true });
    }
    counter.reads += 1;
  };
  const wrapped = { get: async (path, ...rest) => { spend(); return client.get(path, ...rest); } };
  if (typeof client.getAbsolute === 'function') wrapped.getAbsolute = async (url, ...rest) => { spend(); return client.getAbsolute(url, ...rest); };
  if (typeof client.apiUrl === 'function') wrapped.apiUrl = (path) => client.apiUrl(path);
  return wrapped;
}

/**
 * Every system form of every table, in the published and the saved layer, each read to its last page.
 * @param {{ get: Function, getAbsolute?: Function }} client the SDK's Dataverse client (`sdk.dataverse`)
 * @param {{ maxReads?: number }} [options] the most reads the scan may make (default DEFAULT_READS_PER_PAGE)
 * @returns {Promise<{ forms: Array<{ formid: string, table: string, name: string, type: *, layer: 'published'|'saved', formxml: * }>, reads: number }>}
 * @throws GENPAGE_FORM_REFERENCES_UNREADABLE when a read fails, answers no list, or the budget runs out
 */
async function readAllFormLayers(client, { maxReads = DEFAULT_READS_PER_PAGE } = {}) {
  if (!client || typeof client.get !== 'function') throw guardError('the forms cannot be read: no Dataverse client', { code: 'GENPAGE_FORM_REFERENCES_UNREADABLE' });
  const counter = { reads: 0 };
  const reader = budgeted(client, maxReads, counter);
  const forms = [];
  for (const { layer, path } of LAYERS) {
    let rows;
    try {
      rows = await collectionRows(reader, path, `the forms in the ${layer} layer`, { code: 'GENPAGE_FORM_REFERENCES_UNREADABLE' });
    } catch (error) {
      if (error && error.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && error.budgetExhausted) throw error;
      throw guardError(`the forms in the ${layer} layer could not be read (${String((error && error.message) || error)}), so it is not known whether one embeds the page`, { code: 'GENPAGE_FORM_REFERENCES_UNREADABLE', cause: error });
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
  return { forms, reads: counter.reads };
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
 * Reads nothing when `pageIds` is empty.
 * @returns {Promise<{ safe: boolean, references: Map<string, object[]>, unknown: object[], reads: number, formsScanned: number }>}
 * @throws GENPAGE_FORM_REFERENCES_UNREADABLE when the forms cannot all be read (see readAllFormLayers)
 */
async function pageDeletionReferences(client, pageIds, { maxReadsPerPage = DEFAULT_READS_PER_PAGE } = {}) {
  const ids = [...new Set((pageIds || []).map(pageIdOf))];
  const references = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return { safe: true, references, unknown: [], reads: 0, formsScanned: 0 };
  const { forms, reads } = await readAllFormLayers(client, { maxReads: maxReadsPerPage * ids.length });
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

module.exports = { readAllFormLayers, embeddedPageReferences, pageDeletionReferences, assertPageDeletionSafe, DEFAULT_READS_PER_PAGE };

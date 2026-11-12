'use strict';
// systemform-inventory.js — read the system forms of an organization (or of one table), one layer at a time, page by page, under a
// budget, and hold the pages to being ONE complete listing of the layer. Shared by two callers that need different words when it fails:
//   page-reference-guard.js readAllFormLayers   every form of every table, before a generative page is deleted (a refusal stops the delete)
//   form-caption-sharing.js                     the forms of ONE table, for a diagnostic at a form publication stop (a failure is reported, never thrown on)
// Each caller passes its own error factory, so the guard's refusal wording and code are its own, and the diagnostic never throws the guard's code.
//
// WHAT IS READ, for a layer:
//   GET /systemforms?$select=…[&$filter=…]                                                        the PUBLISHED layer
//   GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=…[&$filter=…]   the SAVED layer
//   Prefer: odata.maxpagesize=100                                                        on the first read and on every continuation read
//   { "value": [ … up to 100 rows: { "formid": "…", "objecttypecode": "account", "name": "Account", "type": 2, "formxml": "<form>…</form>" } … ],
//     "@odata.nextLink": "https://contoso.crm.dynamics.com/api/data/v9.0/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=…&$skiptoken=…" }
// The paging rule says to send the same preference on every continuation read and to follow the link as it is:
// https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results. The link is followed by collectionRows
// (app-components.js), which refuses a repeated or malformed link and reads an absolute one through the client's same-origin `getAbsolute`.
// See https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublishedmultiple for the saved layer.
//
// THE BUDGET is the caller's: the most forms a layer may answer and the reads that may take. The read past either is refused BEFORE it is sent —
// a listing is never cut short, which would answer "nothing found" about forms that were never looked at.
const { collectionRows } = require('./app-components.js');

const GUID = /^\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?$/;
// How many forms one read asks for (`Prefer: odata.maxpagesize`). Measured on an environment of 3700 forms: about 22 ms a form in the saved layer
// with its formxml, so a page of 100 took 2 to 4 s against the 60 s a read may take (lib/sdk-http-client.js). See page-reference-guard.js.
const FORMS_PER_READ = 100;
const PAGED = Object.freeze({ headers: Object.freeze({ Prefer: `odata.maxpagesize=${FORMS_PER_READ}` }) });

// The fewest forms an answer declares its query matches, or undefined when it declares none. Dataverse sends a count only to a query that asks ($count=true,
// which neither caller does), so a count is evidence used when an answer carries one, never something required:
//   { "@odata.count": 251, "value": [ … ] }                                                                   (251 forms: at least 251)
//   { "@odata.count": 5000, "@Microsoft.Dynamics.CRM.totalrecordcount": 5000, "@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded": true, … }
//                                                                                                            (more than 5000: at least 5001)
//   { "@odata.count": 5000, "@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded": false, … }               (exactly 5000: at least 5000)
//   { "@Microsoft.Dynamics.CRM.totalrecordcount": -1, … }                                                    (-1: not counted)
// The count stops at 5000 (500 for an elastic table). With no `totalrecordcountlimitexceeded` it is "that many, or more", so a LOWER bound: fewer forms read
// than it says is a scan that missed some; more is not a contradiction. `totalrecordcountlimitexceeded: true` says the forms are MORE than the count, so the
// bound is one more than it — a scan that stops at exactly the cap missed some. Only the boolean `true` raises the bound; `false`, or any other value, leaves
// the count as it is (never lowers it, and never reads a count where there is none).
// See https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/count-rows
function declaredCount(body) {
  const exceeded = body['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'] === true ? 1 : 0;
  const counts = [body['@odata.count'], body['@Microsoft.Dynamics.CRM.totalrecordcount']].filter((n) => Number.isSafeInteger(n) && n >= 0);
  return counts.length ? Math.max(...counts) + exceeded : undefined;
}

// A form id as one key whatever its letter case or braces ("{CCCC…}" and "cccc…" are one form), or '' when the row holds none.
const formKey = (row) => {
  const text = String(row && row.formid !== undefined && row.formid !== null ? row.formid : '').trim();
  const match = GUID.exec(text);
  return match ? match[1].toLowerCase() : text.toLowerCase();
};

// The client as the scan of ONE layer uses it: every read asks for FORMS_PER_READ forms (the first and every continuation — the paging rule above), every read
// and every form is counted, and the read past `maxReads` — or any read once more than `maxForms` forms have come back — is refused before it is sent.
//
// It also holds the pages to being ONE listing of the layer. Paging makes a scan many answers, and the platform's continuation (`$skiptoken`) is opaque, so the
// only evidence that the pages fit together is in the rows: each form once, and at least as many forms as an answer declares (`declaredCount`). A form that
// comes back twice is a page that repeats another — and a page that repeats one may have taken the place of the forms that should have been there — and
// a row with no form id cannot be told apart from one; either is refused, never deduplicated. The layers are checked apart: a form is in both layers as a rule,
// and a layer may hold forms the other does not. `onRow(row, refuse)`, optional, sees each row as its page arrives and may refuse the rest of the layer
// (a caller's own budget, e.g. of XML bytes) by throwing `refuse(why)`.
function budgeted(client, { maxReads, maxForms, refuse, incomplete, onRow }, counter) {
  const spend = () => {
    if (counter.reads >= maxReads) throw refuse(`within ${maxReads} reads`);
    counter.reads += 1;
  };
  const tally = (response) => {
    const body = response && response.body;
    const value = body && body.value;
    if (Array.isArray(value)) {
      counter.forms += value.length;
      if (counter.forms > maxForms) throw refuse(`— the layer holds more than ${maxForms} forms, the most this check reads`);
      for (const row of value) {
        const key = formKey(row);
        if (!key) throw incomplete(`a form came back with no form id (${JSON.stringify(row && row.formid !== undefined ? row.formid : null)})`);
        if (counter.ids.has(key)) throw incomplete(`form ${key} came back twice`);
        counter.ids.add(key);
        if (onRow) onRow(row, refuse);
      }
      const declared = declaredCount(body);
      if (declared !== undefined) counter.declared = Math.max(counter.declared, declared);
    }
    return response;
  };
  const paged = () => ({ headers: { ...PAGED.headers } });
  const wrapped = { get: async (path) => { spend(); return tally(await client.get(path, paged())); } };
  if (typeof client.getAbsolute === 'function') wrapped.getAbsolute = async (url) => { spend(); return tally(await client.getAbsolute(url, paged())); };
  if (typeof client.apiUrl === 'function') wrapped.apiUrl = (path) => client.apiUrl(path);
  return wrapped;
}

/**
 * Read ONE layer to its last page, FORMS_PER_READ forms a read, held to one complete listing (budgeted, above).
 * @param {{ get: Function, getAbsolute?: Function }} client the SDK's Dataverse client (`sdk.dataverse`)
 * @param {object} options
 *   path      below the API root, e.g. `/systemforms?$select=formid,name`
 *   label     what is read, for collectionRows' messages (e.g. `the forms in the saved layer`)
 *   maxForms  the most forms the layer may answer; maxReads: the most reads it may take
 *   errors    the caller's words, each answering the Error to throw:
 *               code                     collectionRows' `code` for a read that fails or answers no list
 *               budget(why)              a read or form past the budget (refused before it is sent)
 *               incomplete(why)          pages that are not one listing (a form twice, or with no id)
 *               short(declared, held)    fewer forms than an answer declared
 *               failed(error)            any other failure of a read, with collectionRows' (or the client's) error
 *   onRow     optional, see budgeted
 *   stats     optional: its `reads` is set to the reads this layer took, whether it succeeded or not
 * @returns {Promise<{ rows: object[], reads: number }>} the rows as answered
 */
async function readSystemFormLayer(client, { path, label, maxForms, maxReads, errors, onRow, stats }) {
  const own = new WeakSet();
  const mark = (error) => { if (error && typeof error === 'object') own.add(error); return error; };
  const counter = { reads: 0, forms: 0, ids: new Set(), declared: 0 };
  const reader = budgeted(client, { maxReads, maxForms, refuse: (why) => mark(errors.budget(why)), incomplete: (why) => mark(errors.incomplete(why)), onRow }, counter);
  let rows;
  try {
    rows = await collectionRows(reader, path, label, { code: errors.code });
  } catch (error) {
    if (own.has(error)) throw error;
    throw errors.failed(error);
  } finally {
    if (stats) stats.reads = counter.reads;
  }
  // Checked once the last page is in: a count an answer declared is a lower bound on the forms (declaredCount), so a scan that ends with fewer missed some.
  if (counter.ids.size < counter.declared) throw errors.short(counter.declared, counter.ids.size);
  return { rows, reads: counter.reads };
}

module.exports = { readSystemFormLayer, declaredCount, formKey, FORMS_PER_READ, PAGED };

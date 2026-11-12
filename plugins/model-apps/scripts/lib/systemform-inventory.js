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
//
// THE XML BYTE BUDGET (createXmlBudget, chargeXml), optional, is ONE object for every read of a caller that bounds the form XML it takes in — the
// diagnostic's fresh reads of a stopped form (meteredClient) and every page of both its listings (readSystemFormLayer's `xmlBudget`). It is the
// ONLY place those bytes are measured: each answer is charged once, as it arrives and BEFORE anything else sees it (the page checks, the
// caller's onRow, the conflict record, a fingerprint or a parser), and an answer past the budget is refused whole, so nothing of it is handed
// on. The deletion guard passes none: its reads are budgeted in forms and reads only, as before.
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

// The form XML budget of one caller (see THE XML BYTE BUDGET above): `maxXmlBytes` a document, `maxTotalXmlBytes` in all. `total` is the
// bytes taken in against the aggregate (never more than maxTotalXmlBytes), `received` every byte of form XML the reads answered (the answers
// refused too), and `exhausted` the reason once the aggregate refused an answer: from then on every read is refused before it is sent.
function createXmlBudget({ maxXmlBytes, maxTotalXmlBytes }) {
  return { maxXmlBytes, maxTotalXmlBytes, total: 0, received: 0, exhausted: null };
}
const isXmlBudget = (budget) => !!budget && typeof budget === 'object' && Number.isFinite(budget.maxXmlBytes) && Number.isFinite(budget.maxTotalXmlBytes)
  && typeof budget.total === 'number' && typeof budget.received === 'number';

// Set on a listing row whose form XML was past the one-document budget: the row is handed on with `formxml: null`, so its XML is never
// read, and the caller can tell it from a row that came back with none.
const XML_OVER_BUDGET = Symbol('systemform-xml-over-budget');
// The code of the error meteredClient throws for an answer the budget refused.
const XML_BUDGET_CODE = 'SYSTEMFORM_XML_BUDGET';

// The rows of one answer body, which is a list (`{ "value": [ { "formxml": "<form>…</form>", … }, … ] }`), one row
// (`{ "formid": "…", "formxml": "<form>…</form>", … }`, a fresh read of one form), or the JSON text of either (a client that hands the text
// on). Answers { body, rows, list }: `body` parsed, `rows` its rows (none for anything else, e.g. a 404's error envelope), `list` whether
// it is a list. A text that does not parse holds no rows: whoever reads it next refuses it as it would have.
function rowsOfAnswer(body) {
  let parsed = body;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return { body, rows: [], list: false }; }
  }
  if (!parsed || typeof parsed !== 'object') return { body, rows: [], list: false };
  if (Array.isArray(parsed.value)) return { body: parsed, rows: parsed.value, list: true };
  return { body: parsed, rows: [parsed], list: false };
}

// Charges ONE answer to `budget`, before anything else reads it. Every form XML document of the answer is measured (UTF-8 bytes) and
// counted in `received`. Answers:
//   { ok: false, why, rows }   the budget was already exhausted, or the answer would take `total` past maxTotalXmlBytes (it then exhausts
//                              the budget and adds nothing to `total`), or, with oversize 'refuse', one document is past maxXmlBytes.
//                              `rows` is for form ids only (refusedRepeats): no XML of a refused answer may be read.
//   { ok: true, body }         charged to `total`; with oversize 'strip' each document past maxXmlBytes is taken out of its row (a copy,
//                              formxml null, XML_OVER_BUDGET set) and `body` is a copy holding those rows; else `body` is the answer's own.
function chargeXml(budget, body, { oversize }) {
  const { body: parsed, rows, list } = rowsOfAnswer(body);
  const sizes = rows.map((row) => (row && typeof row === 'object' && typeof row.formxml === 'string' ? Buffer.byteLength(row.formxml, 'utf8') : 0));
  const incoming = sizes.reduce((a, b) => a + b, 0);
  budget.received += incoming;
  if (budget.exhausted) return { ok: false, why: budget.exhausted, rows };
  if (budget.total + incoming > budget.maxTotalXmlBytes) {
    budget.exhausted = `more than ${budget.maxTotalXmlBytes} bytes of form XML`;
    return { ok: false, why: budget.exhausted, rows };
  }
  budget.total += incoming;
  const over = sizes.findIndex((size) => size > budget.maxXmlBytes);
  if (over < 0) return { ok: true, body };
  if (oversize !== 'strip') return { ok: false, why: `a form XML of ${sizes[over]} bytes, more than the ${budget.maxXmlBytes} this check reads`, rows };
  const kept = rows.map((row, i) => (sizes[i] > budget.maxXmlBytes ? { ...row, formxml: null, [XML_OVER_BUDGET]: true } : row));
  return { ok: true, body: list ? { ...parsed, value: kept } : kept[0] };
}

// The client a caller reads single forms through under `budget` (the diagnostic's fresh reads of a stopped form): a read is refused before it
// is sent once the budget is exhausted, and an answer is charged (chargeXml, a document past maxXmlBytes refused) before the caller's reader
// sees it. A refusal throws `{ code: XML_BUDGET_CODE }`. `onRead`, optional, is called for each read sent.
function meteredClient(client, budget, { onRead } = {}) {
  const refused = (why) => Object.assign(new Error(`a form was not read: ${why}`), { code: XML_BUDGET_CODE });
  const metered = (send) => async (...args) => {
    if (budget.exhausted) throw refused(budget.exhausted);
    if (onRead) onRead();
    const response = await send(...args);
    const charged = chargeXml(budget, response && response.body, { oversize: 'refuse' });
    if (!charged.ok) throw refused(charged.why);
    return response;
  };
  const out = { get: metered((...a) => client.get(...a)) };
  if (typeof client.getAbsolute === 'function') out.getAbsolute = metered((...a) => client.getAbsolute(...a));
  if (typeof client.apiUrl === 'function') out.apiUrl = (path) => client.apiUrl(path);
  return out;
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
//
// `progress`, optional, is the channel for a caller that can use PART of a layer (the diagnostic; never the deletion guard, which must refuse on any gap):
// a page's rows are added to `progress.rows` only once collectionRows has ACCEPTED that page, which it shows by asking for the next one (or by returning).
// So a page whose own answer is refused (a malformed continuation, a row past a budget, a repeat) never adds a row, and the rows of the pages before a
// failure stay. EVERY form a returned page repeats (of an earlier page or within itself) is put in `progress.conflicts`, and that page's copies of it in
// `progress.conflictRows` (the earlier copies are in `progress.rows`): no copy says which is current, so the caller must not use any of them as evidence,
// and must treat a copy that differs from what it read itself as a contradiction.
//
// `xmlBudget`, optional (createXmlBudget), is charged with each page as it arrives, before the checks above or anything else read it (chargeXml):
// a page past the aggregate is refused whole (`refuse`), and once the budget is exhausted no further read is sent. A form such a refused page
// repeats is still a known contradiction, so it goes to `progress.conflicts` and `progress.uncheckable` (its form id only: none of that page's
// XML is kept) — never an innocuous unread page. A document past the one-document budget is taken out of its row (XML_OVER_BUDGET).
function budgeted(client, { maxReads, maxForms, refuse, incomplete, onRow, progress, xmlBudget }, counter) {
  const commit = () => {
    if (progress && counter.pending) progress.rows.push(...counter.pending);
    counter.pending = null;
  };
  const spend = () => {
    commit();
    if (xmlBudget && xmlBudget.exhausted) throw refuse(`within ${xmlBudget.exhausted}`);
    if (counter.reads >= maxReads) throw refuse(`within ${maxReads} reads`);
    counter.reads += 1;
  };
  const refusedRepeats = (rows) => {
    if (!progress) return;
    const seen = new Set();
    for (const row of rows) {
      const key = formKey(row);
      if (key && (counter.ids.has(key) || seen.has(key))) { progress.conflicts.add(key); progress.uncheckable.add(key); }
      seen.add(key);
    }
  };
  const meter = (response) => {
    if (!xmlBudget) return response;
    const charged = chargeXml(xmlBudget, response && response.body, { oversize: 'strip' });
    if (!charged.ok) {
      refusedRepeats(charged.rows);
      throw refuse(`within ${charged.why}`);
    }
    return charged.body === (response && response.body) ? response : { ...response, body: charged.body };
  };
  const tally = (response) => {
    const body = response && response.body;
    const value = body && body.value;
    if (Array.isArray(value)) {
      // The whole page is in hand, so every form it repeats — of an earlier page or of itself — is known before any row is
      // refused below: the first repeat stops the reading, but every repeated form, and each of its copies, goes to `progress`.
      if (progress) {
        const seen = new Set();
        for (const row of value) {
          const key = formKey(row);
          if (key && (counter.ids.has(key) || seen.has(key))) progress.conflicts.add(key);
          seen.add(key);
        }
        for (const row of value) if (progress.conflicts.has(formKey(row))) progress.conflictRows.push(row);
      }
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
      counter.pending = value;
    }
    return response;
  };
  const paged = () => ({ headers: { ...PAGED.headers } });
  const wrapped = { get: async (path) => { spend(); return tally(meter(await client.get(path, paged()))); } };
  if (typeof client.getAbsolute === 'function') wrapped.getAbsolute = async (url) => { spend(); return tally(meter(await client.getAbsolute(url, paged()))); };
  if (typeof client.apiUrl === 'function') wrapped.apiUrl = (path) => client.apiUrl(path);
  wrapped.commit = commit;
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
 *   progress  optional `{ rows: [], conflicts: new Set(), conflictRows: [], uncheckable: new Set() }`, see budgeted: the rows of the pages accepted before a
 *             failure. It changes nothing about what this function answers or throws
 *   xmlBudget optional, from createXmlBudget, see budgeted: a page past it is refused through errors.budget
 *   stats     optional: its `reads` is set to the reads this layer took, whether it succeeded or not
 * @returns {Promise<{ rows: object[], reads: number }>} the rows as answered
 */
async function readSystemFormLayer(client, { path, label, maxForms, maxReads, errors, onRow, progress, stats, xmlBudget }) {
  if (xmlBudget !== undefined && !isXmlBudget(xmlBudget)) throw new TypeError('readSystemFormLayer: xmlBudget must come from createXmlBudget');
  const own = new WeakSet();
  const mark = (error) => { if (error && typeof error === 'object') own.add(error); return error; };
  const counter = { reads: 0, forms: 0, ids: new Set(), declared: 0, pending: null };
  const reader = budgeted(client, { maxReads, maxForms, refuse: (why) => mark(errors.budget(why)), incomplete: (why) => mark(errors.incomplete(why)), onRow, progress, xmlBudget }, counter);
  let rows;
  try {
    rows = await collectionRows(reader, path, label, { code: errors.code });
    reader.commit();
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

module.exports = {
  readSystemFormLayer, declaredCount, formKey, FORMS_PER_READ, PAGED,
  createXmlBudget, chargeXml, meteredClient, XML_OVER_BUDGET, XML_BUDGET_CODE,
};

'use strict';
// form-caption-sharing.js — at a form publication stop that has ALREADY been decided, say which other forms of the same table
// hold a cell with the same cell id as the stopped form, and what each of them reads in its saved and published layer.
//
// WHY. A form cell is matched across a form's two layers by its id (form-caption-diagnostics.js). When two forms of one table
// hold a cell with the SAME id, the platform has been observed to read that cell's caption in the saved layer of BOTH forms as
// the value one of them saved, with equal ETags on every read, and a publish of the table did not change what was published:
//   form A (stopped)   saved <cell id="{C}"><labels><label description="RRR shared" languagecode="1033" /></labels>…   published … "ZZZ old"
//   form B (other)     saved <cell id="{C}"><labels><label description="RRR shared" languagecode="1033" /></labels>…   published … "ZZZ old"
// The stop that names form A cannot show the maker form B; this module reads it and says so, beside the stop.
//
// DIAGNOSTIC ONLY. Nothing here decides, hashes for a decision, writes to the store, publishes, or sends any request but a GET.
// Its answer never changes a stop's message, code, data, approval or remedy: the stop is built first, and this module's text
// travels on a separate non-enumerable property of the error (attachFormCaptionSharing) and in a separate barrier label, both
// display-only. Every failure — a read, a budget, a parse, a bug — answers "could not be determined" or nothing at all, never
// "no other form shares the cell", and never throws to the stop it explains.
//
// WHAT IS READ, and only after a stop was decided on a table scope for a stored managed form whose saved and published layers
// differ:
//   1. each stopped form (at most 8), afresh, both layers:   readSystemFormPublication(client, id, { rootFields: true })
//      The two hashes of that read must be the ones the stop was decided on, else the explanation would join two moments.
//   2. only when a stopped form has a cell whose caption differs between its own layers (captionPairDifferences, the same
//      test as the legacy diagnostic), the forms of THAT table, one layer at a time (systemform-inventory.js):
//        GET /systemforms?$select=formid,objecttypecode,type,name,description,formxml&$filter=objecttypecode eq '<table>'
//        GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=…&$filter=objecttypecode eq '<table>'
//        Prefer: odata.maxpagesize=100 on every page
//      at most 200 forms and 3 reads a layer, 8 MiB of form XML a form and 32 MiB in all.
// A form shares a cell only when the strict XML reader finds a <cell> whose id IS that cell id (form-caption-diagnostics.js
// readFormCaptionCells) — never a GUID found as text anywhere else in the XML.
//
// NOTHING IS PERSISTED. The raw XML is dropped once each form is parsed; the answer lives in memory for one stop's message.
const { normalizeGuid } = require('./reconcile-common.js');
const { odataLit } = require('./odata.js');

const LIMITS = Object.freeze({
  maxRoots: 8,
  maxForms: 200,
  maxReads: 3,
  maxXmlBytes: 8 * 1024 * 1024,
  maxTotalXmlBytes: 32 * 1024 * 1024,
  maxEntries: 8,
  maxFormsPerEntry: 20,
  maxTextCodePoints: 256,
  maxNoteBytes: 32 * 1024,
});
// systemform `type` values: 2 Main, 6 Quick View, 7 Quick Create, 11 Card are form layouts with cells (the codes
// form-layout-reconcile.js recognizes); 0 Dashboard and 10 Interactive experience dashboard are not forms of a table's
// layout and are counted, then skipped unread. Any other type is counted and leaves the scan partial.
// See https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/systemform#type-choicesoptions
const FORM_TYPES = new Set([2, 6, 7, 11]);
const DASHBOARD_TYPES = new Set([0, 10]);
// A table logical name, as Dataverse accepts one (app-components.js TABLE_NAME): only such a name goes into the filter.
const TABLE = /^[a-z_][a-z0-9_]*$/;
const SELECT = 'formid,objecttypecode,type,name,description,formxml';
const LAYERS = Object.freeze(['saved', 'published']);
const REASONS = new Set(['read-failed', 'malformed-list', 'invalid-row', 'invalid-xml', 'ambiguous-xml', 'incomplete-pages', 'budget', 'observations-changed', 'unsupported-form-type']);

const limitsOf = (limits) => ({ ...LIMITS, ...(limits && typeof limits === 'object' ? limits : {}) });
const bytes = (text) => Buffer.byteLength(text, 'utf8');
// `type` is an OData Int32 option set ("type": 2), but a client that echoes what was sent may hold the string "2".
const typeOf = (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);

// The stopped forms an observation may explain: a stored managed FORM group whose root is a form id, on a table scope, read by
// the stop that decided with a saved layer that is not the published one. Answers [{ formId, key, savedSha256, publishedSha256 }],
// one per form (the first observation of a form wins).
function eligibleRoots(entries, scope) {
  if (!scope || scope.type !== 'table' || typeof scope.table !== 'string' || !TABLE.test(scope.table)) return [];
  const out = [];
  const seen = new Set();
  for (const o of Array.isArray(entries) ? entries : []) {
    if (!o || o.family !== 'form' || !o.group || !o.group.root) continue;
    const formId = normalizeGuid(o.group.root.id);
    if (!formId || seen.has(formId)) continue;
    if (typeof o.savedSha256 !== 'string' || typeof o.publishedSha256 !== 'string' || o.savedSha256 === o.publishedSha256) continue;
    seen.add(formId);
    out.push({ formId, key: typeof o.key === 'string' ? o.key : '', savedSha256: o.savedSha256, publishedSha256: o.publishedSha256 });
  }
  return out;
}

// One stopped form, read afresh. Answers { saved: { name, cells }, published: { name, cells }, pairs: [{ cellId, languageCode }] }
// or { reason } when it cannot explain the stop: the read failed, it is no longer a form of this table with both layers, or the
// two hashes are not the ones the stop was decided on. The hashes are compared EXACTLY as the publication readers record them:
// systemFormLayerSha256 of `savedCompared` (the saved row with untranslatable captions set aside) and of `published` — never of
// the raw saved row, and never the dashboard root hash, or an organization with a second language would never match. The cell
// comparison below then uses the RAW saved XML, so what is shown is what the saved read holds.
async function readRoot(client, root, table) {
  const { readSystemFormPublication, systemFormLayerSha256 } = require('./systemform-published.js');
  const { readFormCaptionCells, captionPairDifferences } = require('./form-caption-diagnostics.js');
  let fresh;
  try {
    fresh = await readSystemFormPublication(client, root.formId, { rootFields: true });
  } catch {
    return { reason: 'read-failed' };
  }
  if (!fresh || !fresh.published) return { reason: 'observations-changed' };
  for (const row of [fresh.saved, fresh.published]) {
    if (!FORM_TYPES.has(row.type) || typeof row.objecttypecode !== 'string' || row.objecttypecode.toLowerCase() !== table) return { reason: 'observations-changed' };
  }
  if (systemFormLayerSha256(fresh.savedCompared) !== root.savedSha256 || systemFormLayerSha256(fresh.published) !== root.publishedSha256) return { reason: 'observations-changed' };
  const saved = readFormCaptionCells(fresh.saved.formxml);
  if (!saved.ok) return { reason: saved.reason };
  const published = readFormCaptionCells(fresh.published.formxml);
  if (!published.ok) return { reason: published.reason };
  return {
    saved: { name: fresh.saved.name, cells: saved.cells },
    published: { name: fresh.published.name, cells: published.cells },
    pairs: captionPairDifferences(saved.cells, published.cells),
  };
}

// The reason a layer read stopped, from the error the shared reader threw (systemform-inventory.js): its own budget and
// paging refusals carry `sharingReason`; anything else is collectionRows' (app-components.js) or the client's error, e.g.
//   "the forms of table account in the saved layer: repeated @odata.nextLink"   a page that loops
//   "…: no readable result set" / "…: malformed @odata.nextLink"               an answer that is not one list
//   "…: HTTP 403 from …"                                                       a refusal (any other failure)
function layerReason(error) {
  if (error && REASONS.has(error.sharingReason)) return error.sharingReason;
  const cause = error && error.cause;
  const text = String((cause && cause.message) || (error && error.message) || '');
  if (/repeated @odata\.nextLink/.test(text)) return 'incomplete-pages';
  if (/no readable result set|malformed/.test(text)) return 'malformed-list';
  return 'read-failed';
}

// The forms of `table` in both layers. Answers { layers: { saved, published }, reasons, reads, formsRead, dashboards, unsupported }
// where a layer is null when it could not be read as one complete listing, else a Map<formId, { name, cells | null, reason? }>
// (cells null: that form's XML was not read, for `reason`). A row that is not a form of this table is left out with a reason.
async function readInventory(client, table, lim) {
  const { readSystemFormLayer, formKey } = require('./systemform-inventory.js');
  const { readFormCaptionCells } = require('./form-caption-diagnostics.js');
  const filter = `$filter=objecttypecode eq '${odataLit(table)}'`;
  const paths = {
    published: `/systemforms?$select=${SELECT}&${filter}`,
    saved: `/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${SELECT}&${filter}`,
  };
  const out = { layers: {}, reasons: [], reads: { saved: 0, published: 0 }, formsRead: { saved: 0, published: 0 }, dashboards: new Set(), unsupported: new Set() };
  const xmlBudget = { total: 0 };
  for (const layer of LAYERS) {
    const stats = { reads: 0 };
    const overSized = new Set();
    const stop = (reason, why) => Object.assign(new Error(`the forms of table ${table} in the ${layer} layer could not all be read${why ? ` (${why})` : ''}`), { code: 'FORM_CAPTION_SHARING_UNREADABLE', sharingReason: reason });
    const errors = {
      code: 'FORM_CAPTION_SHARING_UNREADABLE',
      budget: (why) => stop('budget', why),
      incomplete: (why) => stop('incomplete-pages', why),
      short: (declared, held) => stop('incomplete-pages', `the answers declare at least ${declared} forms, the pages held ${held}`),
      failed: (error) => Object.assign(stop(layerReason(error)), { cause: error }),
    };
    // Counted as each page arrives, before any XML is parsed: one form past its own budget is left unread; the layers past the
    // budget in all stop the scan of that layer (a partial answer, never a shorter "complete" one).
    const onRow = (row, refuse) => {
      const xml = row && row.formxml;
      if (typeof xml !== 'string') return;
      const size = bytes(xml);
      xmlBudget.total += size;
      if (xmlBudget.total > lim.maxTotalXmlBytes) throw refuse(`more than ${lim.maxTotalXmlBytes} bytes of form XML`);
      if (size > lim.maxXmlBytes) overSized.add(formKey(row));
    };
    let rows;
    try {
      ({ rows } = await readSystemFormLayer(client, { path: paths[layer], label: `the forms of table ${table} in the ${layer} layer`, maxForms: lim.maxForms, maxReads: lim.maxReads, errors, onRow, stats }));
    } catch (error) {
      out.reasons.push(layerReason(error));
      out.layers[layer] = null;
      continue;
    } finally {
      out.reads[layer] = stats.reads;
    }
    out.formsRead[layer] = rows.length;
    const forms = new Map();
    for (const row of rows) {
      const formId = normalizeGuid(row && row.formid);
      const type = typeOf(row && row.type);
      if (!formId || typeof row.objecttypecode !== 'string' || row.objecttypecode.toLowerCase() !== table || !Number.isInteger(type)) {
        out.reasons.push('invalid-row');
        continue;
      }
      if (DASHBOARD_TYPES.has(type)) { out.dashboards.add(formId); continue; }
      if (!FORM_TYPES.has(type)) { out.unsupported.add(formId); out.reasons.push('unsupported-form-type'); continue; }
      if (typeof row.formxml !== 'string' || (row.name !== null && row.name !== undefined && typeof row.name !== 'string')) {
        out.reasons.push('invalid-row');
        continue;
      }
      const name = typeof row.name === 'string' ? row.name : null;
      if (overSized.has(formKey(row))) {
        out.reasons.push('budget');
        forms.set(formId, { name, cells: null, reason: 'budget' });
        continue;
      }
      const parsed = readFormCaptionCells(row.formxml);
      if (!parsed.ok) {
        out.reasons.push(parsed.reason);
        forms.set(formId, { name, cells: null, reason: parsed.reason });
        continue;
      }
      forms.set(formId, { name, cells: parsed.cells });
    }
    out.layers[layer] = forms;
  }
  return out;
}

// What one layer of one form holds for (cellId, languageCode): `caption` (with its text, '' included), `description-missing`
// (a label with no description ATTRIBUTE), `label-missing` (no label in that language), `cell-missing`, `not-returned` (the
// layer was read and did not list the form — not proof the form has no such layer) or `unreadable`.
function stateIn(layerForms, formId, cellId, languageCode) {
  if (!layerForms) return { state: 'unreadable' };
  const form = layerForms.get(formId);
  if (!form) return { state: 'not-returned' };
  return stateOfCells(form.cells, cellId, languageCode);
}

function stateOfCells(cells, cellId, languageCode) {
  if (!cells) return { state: 'unreadable' };
  const cell = cells.get(cellId);
  if (!cell) return { state: 'cell-missing' };
  if (!cell.captions.has(languageCode)) return { state: 'label-missing' };
  const text = cell.captions.get(languageCode);
  return text === null ? { state: 'description-missing' } : { state: 'caption', text };
}

const sameState = (a, b) => a.state === b.state && a.text === b.text;

/**
 * Observe the forms of the scope's table that share a cell id with a stopped form. Read-only; never throws for a read.
 * @param {{ get: Function, getAbsolute?: Function }} client the SDK's Dataverse client
 * @param {{ scope: { type: 'table', table: string }, roots: Array<{ formId, key, savedSha256, publishedSha256 }>, limits?: object, cache?: object }} options
 *   `cache` (from createFormCaptionSharingContext) keeps the fresh root reads and the table's listing for one stop's presentation.
 * @returns {Promise<object|null>} null when there is nothing to say: no stopped form with a caption that differs between its
 *   layers, or a complete scan that found no other form holding such a cell. Otherwise the in-memory answer
 *   { table, roots, cells, scan, display } (see the module header and docs); `scan.status` is 'complete', 'partial' or 'unavailable'.
 */
async function readFormCaptionSharing(client, { scope, roots, limits, cache } = {}) {
  const lim = limitsOf(limits);
  if (!scope || scope.type !== 'table' || typeof scope.table !== 'string' || !TABLE.test(scope.table) || !client || typeof client.get !== 'function') return null;
  const table = scope.table;
  const store = cache && typeof cache === 'object' ? cache : {};
  if (!(store.roots instanceof Map)) store.roots = new Map();
  const list = Array.isArray(roots) ? roots : [];
  const inspected = list.slice(0, lim.maxRoots);
  const omittedRoots = Math.max(0, list.length - inspected.length);
  const reasons = [];
  let rootReads = 0;
  // Counts the GETs of the root reads; the inventory counts its own.
  const counting = { get: (...a) => { rootReads += 1; return client.get(...a); } };
  const outcomes = [];
  for (const root of inspected) {
    const id = `${root.formId}|${root.savedSha256}|${root.publishedSha256}`;
    if (!store.roots.has(id)) store.roots.set(id, readRoot(counting, root, table));
    const outcome = await store.roots.get(id);
    if (outcome.reason) reasons.push(outcome.reason);
    else if (outcome.pairs.length) outcomes.push({ root, outcome });
  }
  const scan = (status, reason, inv) => ({
    status,
    reason,
    reads: { roots: rootReads, saved: inv ? inv.reads.saved : 0, published: inv ? inv.reads.published : 0 },
    formsRead: { saved: inv ? inv.formsRead.saved : 0, published: inv ? inv.formsRead.published : 0 },
    omittedRoots,
    skippedRows: { dashboards: inv ? inv.dashboards.size : 0, unsupportedFormTypes: inv ? inv.unsupported.size : 0 },
  });
  const display = () => ({ omittedCells: 0, omittedForms: 0, truncatedTexts: 0, truncated: false });
  const rootList = inspected.map(({ formId, key }) => ({ formId, key }));
  // No stopped form has a cell caption that reads apart: there is nothing a sharing form could explain, so nothing is listed.
  if (!outcomes.length) {
    if (!reasons.length) return null;
    return { table, roots: rootList, cells: [], scan: scan('unavailable', reasons[0], null), display: display() };
  }
  if (!store.inventory) store.inventory = readInventory(client, table, lim);
  const inv = await store.inventory;
  reasons.push(...inv.reasons);
  const cells = [];
  for (const { root, outcome } of outcomes) {
    const entries = [];
    let consistent = true;
    for (const { cellId, languageCode } of outcome.pairs) {
      const fresh = { saved: stateOfCells(outcome.saved.cells, cellId, languageCode), published: stateOfCells(outcome.published.cells, cellId, languageCode) };
      // The listing must show the stopped form as the fresh read did: a layer that lists it otherwise was read at another
      // moment, and the two are never joined into one explanation. A layer read whole that does not list it is incomplete.
      for (const layer of LAYERS) {
        const forms = inv.layers[layer];
        if (!forms) continue;
        const listed = forms.get(root.formId);
        if (!listed) { reasons.push('incomplete-pages'); continue; }
        if (!listed.cells) continue;
        if (!sameState(stateOfCells(listed.cells, cellId, languageCode), fresh[layer])) consistent = false;
      }
      const sharers = [];
      const ids = new Set();
      for (const layer of LAYERS) for (const [formId] of inv.layers[layer] || []) ids.add(formId);
      for (const formId of [...ids].sort()) {
        if (formId === root.formId) continue;
        const inSaved = !!(inv.layers.saved && inv.layers.saved.get(formId) && inv.layers.saved.get(formId).cells && inv.layers.saved.get(formId).cells.has(cellId));
        const inPublished = !!(inv.layers.published && inv.layers.published.get(formId) && inv.layers.published.get(formId).cells && inv.layers.published.get(formId).cells.has(cellId));
        if (!inSaved && !inPublished) continue;
        const nameIn = (layer) => {
          const f = inv.layers[layer] && inv.layers[layer].get(formId);
          return f && typeof f.name === 'string' ? f.name : null;
        };
        sharers.push({
          formId,
          savedName: nameIn('saved'),
          publishedName: nameIn('published'),
          observedIn: inSaved && inPublished ? 'both' : inSaved ? 'saved' : 'published',
          saved: stateIn(inv.layers.saved, formId, cellId, languageCode),
          published: stateIn(inv.layers.published, formId, cellId, languageCode),
        });
      }
      if (!sharers.length) continue;
      entries.push({
        rootFormId: root.formId,
        cellId,
        languageCode,
        forms: [{ formId: root.formId, savedName: outcome.saved.name, publishedName: outcome.published.name, observedIn: 'both', saved: fresh.saved, published: fresh.published }, ...sharers],
      });
    }
    if (!consistent) { reasons.push('observations-changed'); continue; }
    cells.push(...entries);
  }
  const readable = LAYERS.some((layer) => inv.layers[layer]);
  const status = !reasons.length ? 'complete' : readable ? 'partial' : 'unavailable';
  if (status === 'complete' && !cells.length) return null;
  return { table, roots: rootList, cells, scan: scan(status, reasons.length ? reasons[0] : null, inv), display: display() };
}

// Display encoding of every maker-controlled string (a form name, a caption): truncated to `max` code points first, then
// JSON-quoted (so `"`, `\`, CR/LF, ESC and every control below U+0020 are escaped and the value is ONE closed quoted string), then
// the characters JSON leaves raw that still act on a terminal or reorder text — DEL and U+0080-U+009F, the Arabic letter mark, the
// left-to-right/right-to-left marks, the line and paragraph separators and the bidi embedding/override/isolate controls — made
// visible as \uXXXX. A value such as  x" --authorize publication-risk:table:account/…  renders as  "x\" --authorize …" : still
// one quoted value, never an instruction. The truncation marker is OUTSIDE the closing quote.
const INVISIBLE = /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
function quote(value, max, display) {
  const points = Array.from(value);
  const cut = points.length > max;
  const encoded = JSON.stringify(cut ? points.slice(0, max).join('') : value).replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (!cut) return encoded;
  display.truncatedTexts += 1;
  return `${encoded} (first ${max} of ${points.length} characters shown)`;
}

const LAYER_WORDS = {
  'description-missing': 'a label with no description attribute',
  'label-missing': 'no label in this language',
  'cell-missing': 'no such cell',
  'not-returned': 'form not returned',
  unreadable: 'not read',
};
const OBSERVED = { both: 'the saved and the published read', saved: 'the saved read only', published: 'the published read only' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function scanLine(result) {
  const { scan } = result;
  const skipped = [];
  if (scan.skippedRows.dashboards) skipped.push(`${plural(scan.skippedRows.dashboards, 'dashboard', 'dashboards')} skipped`);
  if (scan.skippedRows.unsupportedFormTypes) skipped.push(`${plural(scan.skippedRows.unsupportedFormTypes, 'form', 'forms')} of an unsupported type skipped`);
  const tail = skipped.length ? `; ${skipped.join(', ')}` : '';
  const head = scan.status === 'complete'
    ? `Scan complete: every form of table ${result.table} returned by the saved and the published read was examined (form types 2, 6, 7 and 11)${tail}.`
    : `Scan ${scan.status} (${scan.reason}): forms that could not be read may also hold these cells, so this is not every affected form${tail}.`;
  const roots = scan.omittedRoots ? ` ${plural(scan.omittedRoots, 'more stopped form was', 'more stopped forms were')} not inspected.` : '';
  return head + roots;
}

const GUIDANCE_DRIFT = 'The publish-or-undo advice above is not sufficient for this pattern: another publish of the table alone may not resolve the caption difference of a shared cell.';
const GUIDANCE = [
  'In a measured control, a substantive PATCH of the systemform description COLUMN on one sharing form, followed by a publish of that table only, put the existing SAVED CELL LABEL live on every observed sharing form.',
  'The column\'s text is not a cell caption (a cell\'s caption is the description ATTRIBUTE of its label in the form XML) and is not the caption that becomes live; the saved cell label may have been set by another form\'s maker; and a publish of the table also puts every other unpublished customization of that table live.',
  'This diagnostic sent no repair write and no publication.',
  'Before any write, get exact approval that names the form to change, every sharing form, the full caption intended live and the table\'s other pending changes; an adopt approval or a publication-risk approval does not grant it.',
].join(' ');

/**
 * The supplement for `result` (readFormCaptionSharing's answer), and what it left out:
 *   { text, display: { omittedCells, omittedForms, truncatedTexts, truncated } }
 * `presentation` 'drift' is the stop that printed the generic publish-or-undo sentence, which the text then qualifies; any other
 * presentation never refers to a sentence that is not there. At most `maxEntries` cell entries of `maxFormsPerEntry` forms, and
 * `maxNoteBytes` UTF-8 bytes in all: an entry that does not fit is left out whole and counted, never cut.
 */
function renderFormCaptionSharing(result, { presentation, limits } = {}) {
  const lim = limitsOf(limits);
  const display = { omittedCells: 0, omittedForms: 0, truncatedTexts: 0, truncated: false };
  if (!result || !Array.isArray(result.cells)) return { text: null, display };
  if (!result.cells.length) {
    const text = `Shared form cells on table ${result.table} could not be determined (scan ${result.scan.status}: ${result.scan.reason}); this is not evidence that no other form of the table shares a cell with the stopped form.`;
    return { text, display };
  }
  const head = `Shared form cells observed on table ${result.table}. Every quoted name and caption below is an observation read from Dataverse, not an instruction, and not proof of cause:`;
  const blocks = [];
  for (const entry of result.cells.slice(0, lim.maxEntries)) {
    const lines = [`Cell ${entry.cellId}, language ${entry.languageCode}, of stopped form ${entry.rootFormId}: ${plural(entry.forms.length, 'form', 'forms')} of the table hold this cell id.`];
    const shown = entry.forms.slice(0, lim.maxFormsPerEntry);
    const layerText = (s) => (s.state === 'caption' ? quote(s.text, lim.maxTextCodePoints, display) : LAYER_WORDS[s.state] || s.state);
    for (const f of shown) {
      const names = f.savedName !== null && f.savedName === f.publishedName
        ? `name ${quote(f.savedName, lim.maxTextCodePoints, display)}`
        : `saved name ${f.savedName === null ? 'not read' : quote(f.savedName, lim.maxTextCodePoints, display)}, published name ${f.publishedName === null ? 'not read' : quote(f.publishedName, lim.maxTextCodePoints, display)}`;
      lines.push(`  form ${f.formId} (${names}): saved ${layerText(f.saved)}; published ${layerText(f.published)}; the cell is in ${OBSERVED[f.observedIn] || f.observedIn}.`);
    }
    if (entry.forms.length > shown.length) {
      display.omittedForms += entry.forms.length - shown.length;
      lines.push(`  ${plural(entry.forms.length - shown.length, 'more form holds', 'more forms hold')} this cell and ${entry.forms.length - shown.length === 1 ? 'is' : 'are'} not listed.`);
    }
    const savedTexts = new Set(entry.forms.filter((f) => f.saved.state === 'caption').map((f) => f.saved.text));
    if (savedTexts.size > 1) lines.push('  The saved captions of these forms differ: each is shown as observed, and none is chosen as the caption that would go live.');
    blocks.push(lines.join('\n'));
  }
  const omittedByCount = Math.max(0, result.cells.length - lim.maxEntries);
  const tail = [scanLine(result), ...(presentation === 'drift' ? [GUIDANCE_DRIFT] : []), GUIDANCE];
  // The room the cell entries may take: the cap less the fixed text, and less a line that counts the entries left out.
  const reserve = bytes(`\n${plural(result.cells.length, 'more cell entry is', 'more cell entries are')} not listed.`);
  let room = lim.maxNoteBytes - bytes([head, ...tail].join('\n')) - reserve;
  const kept = [];
  for (const block of blocks) {
    const size = bytes(block) + 1;
    if (size > room) break;
    kept.push(block);
    room -= size;
  }
  display.omittedCells = omittedByCount + (blocks.length - kept.length);
  const omitted = display.omittedCells ? [`${plural(display.omittedCells, 'more cell entry is', 'more cell entries are')} not listed.`] : [];
  display.truncated = display.omittedCells > 0 || display.omittedForms > 0 || display.truncatedTexts > 0;
  return { text: [head, ...kept, ...omitted, ...tail].join('\n'), display };
}

/** The supplement's text alone, or null (renderFormCaptionSharing). */
function formatFormCaptionSharing(result, options) {
  return renderFormCaptionSharing(result, options).text;
}

// The barrier label: ONE line, no maker text (no name, no caption), short, display-only — never an approval input.
function sharingLabel(result) {
  const { table, cells, scan } = result;
  if (!cells.length) return `shared form cells on table ${table} could not be determined (${scan.status}: ${scan.reason})`;
  const partial = scan.status === 'complete' ? '' : ` (scan ${scan.status}: ${scan.reason})`;
  return `shared form cells observed on table ${table}: ${plural(cells.length, 'cell entry', 'cell entries')} reused by other forms of the table${partial} (read-only observation; see the stop for recovery guidance)`;
}

/**
 * One stop's presentation: reads at most once per stopped form and once per table listing, whatever the number of observe calls.
 * Create one per presentation and never across a publish or a write: what it cached would be another moment.
 *   observe(entries, presentation)  entries [{ family, key, group, savedSha256, publishedSha256 }] as the stop read them;
 *                                   answers { note, label } or null, and never throws
 *   note                            the last note observed, or null — for a later throw of the same presentation, with no new read
 */
function createFormCaptionSharingContext({ client, scope, limits } = {}) {
  const cache = { roots: new Map(), inventory: null };
  let note = null;
  return {
    async observe(entries, presentation) {
      try {
        const roots = eligibleRoots(entries, scope);
        if (!roots.length) return null;
        const result = await readFormCaptionSharing(client, { scope, roots, limits, cache });
        if (!result) return null;
        const rendered = renderFormCaptionSharing(result, { presentation, limits });
        result.display = rendered.display;
        if (typeof rendered.text !== 'string' || !rendered.text) return null;
        note = rendered.text;
        return { note: rendered.text, label: sharingLabel(result) };
      } catch {
        return null;
      }
    },
    get note() { return note; },
  };
}

/**
 * Put `text` on `error` as a non-enumerable, read-only `formCaptionSharingNote`, for the final halt to show after its own
 * message (sdk-build.js managedStop). Never changes the error's message, code, cause or any other field, and never replaces a
 * note already there. Answers the error.
 */
function attachFormCaptionSharing(error, text) {
  try {
    if (error && typeof error === 'object' && Object.isExtensible(error) && typeof text === 'string' && text
      && !Object.prototype.hasOwnProperty.call(error, 'formCaptionSharingNote')) {
      Object.defineProperty(error, 'formCaptionSharingNote', { value: text, enumerable: false, configurable: true, writable: false });
    }
  } catch {
    // A proxy or frozen error keeps its stop as it is.
  }
  return error;
}

module.exports = {
  readFormCaptionSharing,
  renderFormCaptionSharing,
  formatFormCaptionSharing,
  sharingLabel,
  createFormCaptionSharingContext,
  attachFormCaptionSharing,
  eligibleRoots,
  FORM_CAPTION_SHARING_LIMITS: LIMITS,
};

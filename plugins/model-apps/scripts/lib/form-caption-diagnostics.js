'use strict';

// form-caption-diagnostics.js — name the form cells whose caption reads one way in a form's saved layer and another
// way in its published layer, for the message of a publish that a fresh read did not prove live.
//
// DIAGNOSTIC ONLY. This module decides nothing. Its answer is never hashed, never compared for a publication decision,
// never written to the binding store, and never makes a publish confirmed. A saved layer has no version, so the same
// observed pair — saved "Inspections", published "Issues" in one cell — is what a platform read that projects the two
// layers apart shows AND what a maker's unpublished caption edit shows; nothing read here tells them apart. The answer
// only tells the maker WHERE to look. Every caller treats a throw or an unusable answer as "no diagnostic"
// (systemform-published.js readSystemFormLayers, managed-feature-contract.js), so nothing here can change a stop.
//
// What is compared, in each layer's form XML (strict-xml.js; a document it does not read answers no diagnostic):
//   <tab id="{…}"> … <section id="{…}"> … <cell id="{0f3c…}">
//                                            <labels><label description="Inspections" languagecode="1033" /></labels>
//                                            <control id="subgrid_inspections" … />
//                                          </cell>
// A cell is matched across the layers by its id (a GUID, in any spelling) only — never by its caption, its position or
// a name — and only when the tab and section that contain it and the control it holds have the same ids in both
// layers. Within a matched cell, a caption is compared only for a language code that has exactly ONE label on each
// side; a language present on one side only is not reported (no base language is inferred from label order). Any
// ambiguity — a cell id twice in one layer, a language code twice in one cell, a language code that is not a whole
// number — answers no diagnostic at all rather than a guess.

const { readXmlElements } = require('./strict-xml.js');
const { normalizeGuid } = require('./reconcile-common.js');

// The most entries an answer names; the rest are counted (`omittedCount`). A message names a handful of cells.
const MAX_ENTRIES = 8;
// A form's XML is tens of kilobytes; a document far beyond that is not read for a diagnostic.
const MAX_XML_CHARS = 8 * (1 << 20);
const WANTED = new Set(['tab', 'section', 'cell', 'control', 'label']);
// A Windows locale id (LCID) as Dataverse writes `languagecode`, e.g. "1033" (English) or "3082" (Spanish).
// See: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-lcid/
const LCID = /^[1-9]\d{3,4}$/;

class Ambiguous extends Error {}

// An element id as compared across the layers: a GUID in its normalized spelling, any other id as written, or null.
const idOf = (attrs) => {
  const raw = attrs && typeof attrs.id === 'string' ? attrs.id : null;
  if (raw === null) return null;
  return normalizeGuid(raw) || raw;
};

// The cells of one layer: Map<cellId, { tab, section, controls, captions: Map<lcid, description> }>, or null when the
// document is not read. Elements are answered in document order (by their start), so one pass with a stack of the
// open tab / section / cell elements finds the innermost container of each element in linear time.
function cellsOf(xml) {
  if (typeof xml !== 'string' || xml.length > MAX_XML_CHARS) return null;
  const read = readXmlElements(xml, (name) => WANTED.has(name), { spans: true });
  if (!read.ok) return null;
  const cells = new Map();
  const stack = [];
  const innermost = (name) => {
    for (let i = stack.length - 1; i >= 0; i -= 1) if (stack[i].el.name === name) return stack[i];
    return null;
  };
  for (const el of read.elements) {
    while (stack.length && stack[stack.length - 1].el.end <= el.start) stack.pop();
    const top = stack.length ? stack[stack.length - 1] : null;
    if (el.name === 'tab' || el.name === 'section') {
      stack.push({ el, id: idOf(el.attrs) });
    } else if (el.name === 'cell') {
      const cellId = normalizeGuid(el.attrs.id);
      const tab = innermost('tab');
      const section = innermost('section');
      const entry = { el, id: cellId, tab: tab ? tab.id : null, section: section ? section.id : null, controls: [], captions: new Map() };
      if (cellId) {
        if (cells.has(cellId)) throw new Ambiguous();
        cells.set(cellId, entry);
      }
      stack.push(entry);
    } else if (top && top.el.name === 'cell' && top.id) {
      // Only what sits directly in the cell: its own control, and the labels of its own <labels> element.
      if (el.name === 'control' && el.path.endsWith('/cell')) top.controls.push(idOf(el.attrs));
      if (el.name === 'label' && el.path.endsWith('/cell/labels')) {
        const code = el.attrs.languagecode;
        if (typeof code !== 'string' || !LCID.test(code)) throw new Ambiguous();
        const lcid = Number(code);
        if (top.captions.has(lcid)) throw new Ambiguous();
        top.captions.set(lcid, typeof el.attrs.description === 'string' ? el.attrs.description : null);
      }
    }
  }
  return cells;
}

const sameControls = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * The cells of ONE form XML document, for a caller that needs more than the pair answer below (form-caption-sharing.js):
 *   { ok: true, cells: Map<cellId, { tab, section, controls, captions: Map<lcid, description | null> }> }
 *   { ok: false, reason: 'invalid-xml' | 'ambiguous-xml' }
 * `cellId` is the cell's normalized GUID; a cell whose id is not a GUID is not in the map. `captions` maps each language
 * code of the cell's own labels to the label's `description` ATTRIBUTE, or null when the label has none — a language
 * with no label is simply absent. 'invalid-xml': not text, too long, or not one document the strict reader accepts;
 * 'ambiguous-xml': a cell id twice, a language twice in one cell, or a language code that is not a whole number. The
 * same reading rules as cellCaptionDifferences, so the two never disagree about one document.
 */
function readFormCaptionCells(xml) {
  let cells;
  try {
    cells = cellsOf(xml);
  } catch (e) {
    if (e instanceof Ambiguous) return { ok: false, reason: 'ambiguous-xml' };
    throw e;
  }
  return cells ? { ok: true, cells } : { ok: false, reason: 'invalid-xml' };
}

/**
 * The same-form caption pairs that differ, given the two layers' cell maps (readFormCaptionCells' `cells`):
 * [{ cellId, languageCode }] in saved-layer document order, every one of them. A pair needs the cell in both layers, in
 * the same tab and section and holding the same controls, and exactly one label in that language on each side.
 */
function captionPairDifferences(saved, published) {
  const found = [];
  for (const [cellId, s] of saved) {
    const p = published.get(cellId);
    if (!p || s.tab !== p.tab || s.section !== p.section || !sameControls(s.controls, p.controls)) continue;
    for (const [lcid, text] of s.captions) {
      if (p.captions.has(lcid) && p.captions.get(lcid) !== text) found.push({ cellId, languageCode: lcid });
    }
  }
  return found;
}

/**
 * The cells whose caption in one language reads differently in `savedXml` and `publishedXml`:
 *   { entries: [{ cellId: '<normalized GUID>', languageCode: 1033 }], omittedCount: 0 }
 * sorted by cell id then language code, at most MAX_ENTRIES named. Answers null when there is no such cell, or when
 * either document is not read or anything in it is ambiguous (see the header). No caption text is answered.
 */
function cellCaptionDifferences(savedXml, publishedXml) {
  let saved;
  let published;
  try {
    saved = cellsOf(savedXml);
    published = cellsOf(publishedXml);
  } catch (e) {
    if (e instanceof Ambiguous) return null;
    throw e;
  }
  if (!saved || !published) return null;
  const found = captionPairDifferences(saved, published);
  if (!found.length) return null;
  found.sort((a, b) => (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : a.languageCode - b.languageCode));
  return { entries: found.slice(0, MAX_ENTRIES), omittedCount: Math.max(0, found.length - MAX_ENTRIES) };
}

/**
 * The sentence a stop appends for `differences` (cellCaptionDifferences' answer), e.g.
 *   Caption difference at cell 0f3c…-… (language 1033). This observation does not show whether the difference is an
 *   unpublished edit or a platform read projection.
 * Answers null for anything that is not such an answer.
 */
function formatCaptionDifferences(differences) {
  if (!differences || typeof differences !== 'object' || !Array.isArray(differences.entries) || !differences.entries.length) return null;
  const { entries, omittedCount } = differences;
  if (entries.length > MAX_ENTRIES || !Number.isSafeInteger(omittedCount) || omittedCount < 0) return null;
  const named = [];
  for (const e of entries) {
    if (!e || normalizeGuid(e.cellId) !== e.cellId || !Number.isSafeInteger(e.languageCode) || !LCID.test(String(e.languageCode))) return null;
    named.push(`cell ${e.cellId} (language ${e.languageCode})`);
  }
  const more = omittedCount ? `, and ${omittedCount} more` : '';
  const plural = named.length + omittedCount > 1;
  return `Caption difference${plural ? 's' : ''} at ${named.join(', ')}${more}. This observation does not show whether the difference is an unpublished edit or a platform read projection.`;
}

module.exports = { cellCaptionDifferences, formatCaptionDifferences, readFormCaptionCells, captionPairDifferences, MAX_CAPTION_DIFFERENCES: MAX_ENTRIES };

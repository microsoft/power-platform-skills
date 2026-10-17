'use strict';
// Whether the SAVED FormXML of a systemform is its PUBLISHED one, when the two reads carry the labels of different languages.
//
// verify reads a dashboard's tiles through the SDK, whose read is the saved layer (RetrieveUnpublished), and checks them only when that layer
// IS the dashboard users see: the published row's FormXML (verify-model-app.js, readerFor → dashboardComponents). That comparison used to be
// the two texts, byte for byte, and the two reads do not carry the same languages. Measured live, in an organization whose base language is
// 1033 and which has Spanish (3082) provisioned too, on a dashboard nothing had written since its build created and published it, a cell read:
//   published (a plain read of the row)  <cell id="{…}" colspan="1" rowspan="1" showlabel="true"><labels><label description="By Priority" languagecode="1033" /></labels><control …
//   saved (RetrieveUnpublished)          <cell id="{…}" colspan="1" rowspan="1" showlabel="true"><labels><label description="By Priority" languagecode="1033" /><label description="Work Orders" languagecode="3082" /></labels><control …
// — a 3082 label in each of its four cells, in the saved read only, and nothing else: without them the saved read was the published FormXML
// exactly. Compared as text, every dashboard of such an organization was "not published", and the jobs whose surface it is failed with it.
// A form's published read does the same: it carries fewer languages than the form stores (verify-spec.js, "A language the form's read does not
// carry"; AGENTS.md). See https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublished
//
// THE RULE. Two equal texts are the same document, as they always were, and nothing is parsed. Otherwise each must be ONE well-formed XML
// document, read by the plugin's strict XML reader (strict-xml.js); a read that is not one is a difference — the verdict the texts gave before.
// The languages the published read CARRIES are the ones its labels name, anywhere in it. A label of the saved read in any other language is one
// the published read could not show, so it is set aside: its own `<label … />` tag and nothing else, and only a label the platform writes —
// an empty `<label>` of a `<labels>` element whose `languagecode` is a valid LCID (normalizeLanguageCode). Everything that is left is compared as
// text, byte for byte, as before: a tile, a cell, any element, attribute or text, and a label in a language the published read carries — added,
// removed or changed — is a change. A published read that carries no language at all sets nothing aside: it does not say which one it shows.
//
// What this cannot see is a change to a label in a language the published read does not carry (a translation saved and not published): no read
// verify makes shows it, and it changes nothing verify proves of a dashboard — its tiles' tables, views and charts.
const { readXmlElements } = require('./strict-xml.js');
const { normalizeLanguageCode } = require('./app-spec.js');

const isLabel = (name) => name === 'label';
// A caption is a <label> of a <labels> element (`path` is the names of its ancestors, so its parent is the last of them). A <label> anywhere else —
// a control's parameter, say — is not one, and is compared like any other element.
const isCaption = (element) => element.path === 'labels' || element.path.endsWith('/labels');
const languageOf = (caption) => normalizeLanguageCode(caption.attrs.languagecode);

// The captions of one FormXML, each with where it is in the text, or null when the text is not one well-formed XML document.
function captionsOf(xml) {
  const read = readXmlElements(xml, isLabel, { spans: true });
  return read.ok ? read.elements.filter(isCaption) : null;
}

// `xml` without its captions in a language `carried` does not hold. Only an empty-element tag (`<label … />`) is taken out: the strict reader refuses
// a "<" inside an attribute value, so a caption whose span holds no "<" after its own is one tag, with no content and no end tag.
function withoutCaptionsOutside(xml, captions, carried) {
  let out = '';
  let at = 0;
  for (const caption of captions) {
    const lcid = languageOf(caption);
    if (lcid === null || carried.has(lcid)) continue;
    const inner = xml.indexOf('<', caption.start + 1);
    if (inner !== -1 && inner < caption.end) continue;
    out += xml.slice(at, caption.start);
    at = caption.end;
  }
  return out + xml.slice(at);
}

/**
 * Whether `saved` (a systemform's FormXML as RetrieveUnpublished answers it) is `published` (the FormXML a plain read of the row answers), in the
 * languages the published read carries.
 *
 *   sameFormXmlAcrossLayers('<form>…<labels><label description="Open" languagecode="1033" /></labels>…</form>',
 *                           '<form>…<labels><label description="Open" languagecode="1033" /><label description="Abierto" languagecode="3082" /></labels>…</form>')
 *     → true   (the published read carries 1033 alone, so the 3082 caption is set aside)
 *
 * @param {*} published the published read's FormXML
 * @param {*} saved the saved read's FormXML
 * @returns {boolean} false for anything that is not text, and for a text that is not one well-formed XML document unless the two are equal
 */
function sameFormXmlAcrossLayers(published, saved) {
  if (typeof published !== 'string' || typeof saved !== 'string') return false;
  if (published === saved) return true;
  const publishedCaptions = captionsOf(published);
  const savedCaptions = captionsOf(saved);
  if (!publishedCaptions || !savedCaptions) return false;
  const carried = new Set(publishedCaptions.map(languageOf).filter((lcid) => lcid !== null));
  if (!carried.size) return false;
  // Set aside from both reads, as the rule says — the published read has, by what `carried` is, no caption in another language to set aside.
  return withoutCaptionsOutside(published, publishedCaptions, carried) === withoutCaptionsOutside(saved, savedCaptions, carried);
}

module.exports = { sameFormXmlAcrossLayers };

'use strict';
// What the platform does to the captions of a systemform's FormXML on its own, as live-measured, for the fakes to mirror. Each
// function takes a FormXML text and answers it changed; anything that is not a string is answered unchanged.

// A create of a form or dashboard whose tab or section carries no <labels>: the saved row holds an empty caption as the
// first child of each, e.g.
//   sent   <tab id="{…}" name="General" showlabel="true" …><columns>…
//   saved  <tab id="{…}" name="General" showlabel="true" …><labels><label description="" languagecode="1033" /></labels><columns>…
function withEmptyContainerCaptions(xml) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(/<(tab|section)\b([^>]*[^/])>(?!<labels>)/g, '<$1$2><labels><label description="" languagecode="1033" /></labels>');
}

// An organization with a second language provisioned: the SAVED read (RetrieveUnpublished) carries a caption in it beside the
// base-language one on SOME <labels> elements — those of a cell whose caption has text and carries none in that language yet,
// never a tab's or a section's. Its text is the platform's own, not a copy of the one sent: live, a tile sent as "By Priority"
// in 1033 read back with "Work Orders" in 3082 (lib/formxml-layers.js), so the fake answers a fixed text of its own, e.g.
//   sent   <cell …><labels><label description="Site Name" languagecode="1033" /></labels>
//   saved  <cell …><labels><label description="Site Name" languagecode="1033" /><label description="Platform caption" languagecode="3082" /></labels>
// A cell sent with a caption in that language already is read back as sent. The PUBLISHED read (a plain GET of the row) never
// returns a caption in it.
const PLATFORM_CAPTION = 'Platform caption';
// A cell whose control is an IFRAME tile (helpers/dashboard-formxml.js IFRAME_CLASS).
const IFRAME_CONTROL = /^<control\b[^>]*\bclassid="\{FD2A7985-3187-444E-908D-6624B21F69C0\}"/i;
function withSecondLanguageCaptions(xml, lcid, { iframeBaseOnly = false } = {}) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(/(<cell\b[^>]*>)<labels>((?:<label [^>]*\/>)+)<\/labels>(?=(<control\b[^>]*>)?)/g, (all, cell, labels, control) => {
    const base = /<label description="([^"]+)" languagecode="1033" \/>/.exec(labels);
    if (!base || labels.includes(`languagecode="${lcid}"`)) return all;
    if (iframeBaseOnly && control && IFRAME_CONTROL.test(control)) return all;
    return `${cell}<labels>${labels}<label description="${PLATFORM_CAPTION}" languagecode="${lcid}" /></labels>`;
  });
}

// The same organization, as a write of a dashboard stores it (live-measured: a create that sent each new tile its caption
// in 1033 and 3082): a view-list tile's cell keeps every caption sent; an IFRAME tile's cell keeps only its base-language
// one, and the platform adds none of its own to it (withSecondLanguageCaptions with `iframeBaseOnly`). No sent caption is
// stored with other text:
//   sent   <cell …><labels><label description="Crew map" languagecode="1033" /><label description="Crew map" languagecode="3082" /></labels><control … classid="{FD2A7985-…}">
//   saved  <cell …><labels><label description="Crew map" languagecode="1033" /></labels><control … classid="{FD2A7985-…}">
function withIframeCaptionsInBaseLanguageOnly(xml) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(/(<cell\b[^>]*><labels>)((?:<label [^>]*\/>)+)(<\/labels>)(?=(<control\b[^>]*>))/g, (all, pre, labels, post, control) => {
    if (!IFRAME_CONTROL.test(control)) return all;
    const kept = (labels.match(/<label [^>]*\/>/g) || []).filter((l) => /languagecode="1033"/.test(l));
    return `${pre}${kept.join('')}${post}`;
  });
}function withoutLanguage(xml, lcid) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(new RegExp(`<label [^>]*languagecode="${lcid}" \\/>`, 'g'), '');
}

// The published read straight after a publish answers: a cell's caption still being rewritten — empty here — while a read
// some seconds later is the saved layer exactly.
function withRewritingCellCaptions(xml) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(/(<cell\b[^>]*><labels><label description=")[^"]*(")/g, '$1$2');
}

module.exports = { PLATFORM_CAPTION, withEmptyContainerCaptions, withSecondLanguageCaptions, withIframeCaptionsInBaseLanguageOnly, withoutLanguage, withRewritingCellCaptions };

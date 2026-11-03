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
// base-language one on SOME <labels> elements — those of a cell whose caption has text, never a tab's or a section's — e.g.
//   <cell …><labels><label description="Site Name" languagecode="1033" /><label description="Site Name" languagecode="3082" /></labels>
// and the PUBLISHED read (a plain GET of the row) never returns a caption in it.
function withSecondLanguageCaptions(xml, lcid) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(/(<cell\b[^>]*>)<labels>((?:<label [^>]*\/>)+)<\/labels>/g, (all, cell, labels) => {
    const base = /<label description="([^"]+)" languagecode="1033" \/>/.exec(labels);
    if (!base || labels.includes(`languagecode="${lcid}"`)) return all;
    return `${cell}<labels>${labels}<label description="${base[1]} (${lcid})" languagecode="${lcid}" /></labels>`;
  });
}
function withoutLanguage(xml, lcid) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(new RegExp(`<label [^>]*languagecode="${lcid}" \\/>`, 'g'), '');
}

// The published read straight after a publish answers: a cell's caption still being rewritten — empty here — while a read
// some seconds later is the saved layer exactly.
function withRewritingCellCaptions(xml) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(/(<cell\b[^>]*><labels><label description=")[^"]*(")/g, '$1$2');
}

module.exports = { withEmptyContainerCaptions, withSecondLanguageCaptions, withoutLanguage, withRewritingCellCaptions };

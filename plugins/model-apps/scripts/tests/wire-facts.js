'use strict';
// Parity oracle — pure normalizer that extracts SEMANTIC facts from the wire payloads the SDK
// pushes, so the hardening-2 migration can prove the rewired engine produces the same observable
// output as the pre-swap engine (no user-visible regression). Facts are the things a user would
// notice; incidental serialization details (minted layout GUIDs, attribute ordering, and — for
// bound fields — the control classId, which the new adapter legitimately derives from the Dataverse
// attribute type rather than the old one-size textbox id) are deliberately EXCLUDED so an intended
// improvement doesn't read as a regression.
//
// Inputs are the exact request bodies captured from a fake HttpClient (see parity capture); the XML
// is parsed with narrow regexes (no XML dep, no SDK) — the shapes are small and code-controlled.

// formxml (abridged real capture):
//   <form><tabs><tab ...><columns><column ...><sections>
//     <section ... columns="1"><rows><row>
//       <cell ...><control id="new_name" classid="{4273...}" datafieldname="new_name" isrequired="true"/></cell>
//     </row></rows></section>
//     <section name="section_notes" ...><rows><row><cell><control classid="{06375649-...}" .../></cell></row></rows></section>
//   </sections></column></columns></tab></tabs>
//   <header>...</header><footer>...</footer></form>
// Only <control> elements carrying datafieldname are bound fields; header/footer cells and the notes
// control have no datafieldname. The Notes/Timeline control is identified by its fixed classId, which
// is stable across the SDK swap (ControlClassId.TimelineControl).
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E';

function attr(tag, name) {
  // Match name="value" within a single element's opening tag text.
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : undefined;
}

// Ordered bound fields + whether the Notes/Timeline control is present. Order is user-observable
// (it is the top-to-bottom field order on the form), so it is a fact; classId is not.
function formFacts(formxml) {
  const xml = String(formxml || '');
  const controls = xml.match(/<control\b[^>]*>/gi) || [];
  const fields = [];
  let notesControl = false;
  for (const c of controls) {
    const field = attr(c, 'datafieldname');
    const classId = (attr(c, 'classid') || '').replace(/[{}]/g, '').toUpperCase();
    if (field) {
      fields.push({ name: field.toLowerCase(), required: attr(c, 'isrequired') === 'true' });
    } else if (classId === NOTES_CLASS_ID) {
      notesControl = true;
    }
  }
  // Section grid-column counts, in document order (a user notices a 2-column vs 1-column section).
  const sectionColumns = (xml.match(/<section\b[^>]*>/gi) || []).map((s) => Number(attr(s, 'columns') || '1'));
  // Sub-grid controls carry a RelationshipName parameter — capture (relationship,target,view) as facts.
  const subgrids = [];
  for (const p of xml.match(/<control\b[^>]*>[\s\S]*?<\/control>/gi) || []) {
    const rel = /RelationshipName<\/[^>]*>\s*<[^>]*>([^<]+)/i.exec(p) || /RelationshipName["'\s>]+([^<"']+)/i.exec(p);
    if (rel) subgrids.push(rel[1]);
  }
  return { fields, notesControl, sectionColumns, subgrids };
}

// layoutxml (real capture):
//   <grid ...><row name="result" id="new_customerid"><cell name="new_name" width="100"/>...</row></grid>
// fetchxml carries the entity name.
function viewFacts(layoutxml, fetchxml) {
  const cols = (String(layoutxml || '').match(/<cell\b[^>]*>/gi) || []).map((c) => ({
    name: (attr(c, 'name') || '').toLowerCase(),
    width: Number(attr(c, 'width') || '100'),
  }));
  const entity = attr(/<entity\b[^>]*>/i.exec(String(fetchxml || ''))?.[0] || '', 'name');
  return { entity: entity && entity.toLowerCase(), columns: cols };
}

// datadescription (real capture): an aggregate <attribute aggregate="count"> is the measure; a
// <attribute groupby="true"> is the category.
function chartFacts(datadescription) {
  const xml = String(datadescription || '');
  const measure = (/<attribute\b[^>]*aggregate="([^"]+)"[^>]*>/i.exec(xml) || [])[1];
  const groupTag = /<attribute\b[^>]*groupby="true"[^>]*>/i.exec(xml)?.[0] || '';
  const entity = attr(/<entity\b[^>]*>/i.exec(xml)?.[0] || '', 'name');
  return { entity: entity && entity.toLowerCase(), measure, groupBy: (attr(groupTag, 'name') || '').toLowerCase() };
}

// sitemapxml (real capture): Area > Group > SubArea; the semantic facts currently captured per
// SubArea are its Entity/Url bindings (localized titles are intentionally not normalized here).
function sitemapFacts(sitemapxml) {
  const xml = String(sitemapxml || '');
  const areas = [];
  for (const areaBlock of xml.match(/<Area\b[\s\S]*?<\/Area>/gi) || []) {
    const groups = [];
    for (const groupBlock of areaBlock.match(/<Group\b[\s\S]*?<\/Group>/gi) || []) {
      const subAreas = (groupBlock.match(/<SubArea\b[^>]*>/gi) || []).map((s) => ({
        entity: (attr(s, 'Entity') || '').toLowerCase() || undefined,
        url: attr(s, 'Url'),
      }));
      groups.push({ subAreas });
    }
    areas.push({ groups });
  }
  return { areas };
}

module.exports = { formFacts, viewFacts, chartFacts, sitemapFacts, NOTES_CLASS_ID };

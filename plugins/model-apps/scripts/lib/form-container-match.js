'use strict';

// How an AUTHORED form container (a tab or a section) is matched to a DEPLOYED one.
//
// This is shared deliberately. The build reconciles an existing form by matching containers
// name -> label -> position, and a position- or label-matched container KEEPS ITS DEPLOYED NAME: it
// is not renamed, because form scripts and business rules can reference a section by name. A
// verifier that looks containers up by the AUTHORED name therefore reports a perfectly good
// auto-to-explicit migration as "section absent" and fails a build that did exactly what was asked.
// Live-reproduced. Both sides now use this one function, so they cannot drift apart again.

// Find the deployed container matching `want`, preferring an exact name, then a label, then the
// positional slot. `claimed` (a Set of already-taken indices) keeps two authored containers from
// resolving to the same deployed one; `skip` hides containers the LABEL and POSITION passes must
// not claim; `nameSkip` hides containers from the NAME pass as well — an authored section passes
// `isEngineOwnedSection` there, since it may legally share a name with the engine's own host.
// Returns `{ index, item }` or null.
function matchContainer(list, want, wantIndex, opts) {
  const items = list || [];
  const claimed = (opts && opts.claimed) || null;
  const skip = (opts && opts.skip) || (() => false);
  const nameSkip = (opts && opts.nameSkip) || (() => false);
  const eq = (a, b) => a !== undefined && a !== null && String(a).toLowerCase() === String(b || '').toLowerCase();
  const free = (i) => !claimed || !claimed.has(i);
  let idx = items.findIndex((x, i) => free(i) && want.name && eq(x.name, want.name) && !nameSkip(x));
  if (idx < 0) idx = items.findIndex((x, i) => free(i) && !skip(x) && want.label && eq(x.label, want.label));
  if (idx < 0 && wantIndex < items.length && free(wantIndex) && !skip(items[wantIndex])) idx = wantIndex;
  return idx < 0 ? null : { index: idx, item: items[idx] };
}

// A section the ENGINE owns rather than one the author laid out: a sub-grid host, or the
// notes/timeline section. `addSubgrids` appends one such section per authored sub-grid on EVERY
// layout (auto included), and `compileFormIntent` appends the notes section — so they sit in the
// same `sections[]` array as the author's own, just after them.
//
// They must be invisible to the LABEL and POSITION passes. Otherwise, as soon as an explicit layout
// declares as many sections as the index of the first appended one, the positional fallback claims
// the sub-grid: it gets relabelled to the author's section title, bound field controls are injected
// into the row holding the grid control, and the author's section is never created. The build is
// green and a rebuild converges on the same wrong shape, so nothing downstream reports it.
//
// Detected structurally (every cell carries a control with no `fieldName`) rather than by name, so
// it holds for a sub-grid whose section the author renamed in Maker. An EMPTY section has no cells
// and is deliberately NOT engine-owned — it stays matchable so a vacated section can be reused.
function isEngineOwnedSection(s) {
  const cells = ((s && s.rows) || []).flatMap((r) => (r && r.cells) || []);
  return cells.length > 0 && cells.every((c) => c && c.control && !c.control.fieldName);
}

// A control class id as compared: the SDK projects `classid` without its braces and in its original case,
// FormXML carries it in braces, and the compiler writes the constant in upper case.
const classIdOf = (c) => String((c && c.control && c.control.classId) || '').replace(/[{}]/g, '').trim().toLowerCase();
const cellsOf = (s) => ((s && s.rows) || []).flatMap((r) => (r && r.cells) || []);

// The names the COMPILER gives the sections it adds itself — `section_notes` (notesSectionIntent) and
// `section_grid_<relationship>` (subgridSectionIntent), both in artifact-intent.js — each with the control
// that host exists to hold: the notes timeline and a sub-grid. These are the stable platform class ids
// sdk-build.js pins as NOTES_CLASS_ID and SUBGRID_CLASS_ID (the SDK's ControlClassIds).
const ENGINE_HOSTS = [
  { name: /^section_notes$/i, classId: '06375649-c143-495e-a496-c962e5b4488e' },
  { name: /^section_grid_.*$/i, classId: 'e7a81278-8635-4d9e-8d4d-59480b391c5b' },
];

// An engine HOST: a section that still carries the name the compiler gave it, and is either engine-owned
// or holds the control that name's host exists for — never a bound field: a bound control's class id comes
// from its attribute's type. This — not isEngineOwnedSection alone — is what an AUTHORED want never takes,
// by name, label or position.
//
// The structure alone is not enough, in either direction. It says a section holds only unbound controls;
// it cannot say who laid the section out. An authored section declared with no fields that a maker then
// filled with a web resource, an iframe or a sub-grid is structurally the same, and its name is the one
// positive evidence that it is the author's: skipping it created an empty duplicate beside it, and when
// the spec moved it, left the maker's control behind in the old tab. And a host a maker added a bound
// field to is no longer engine-owned, yet still the host — it holds the timeline or the sub-grid the
// engine put it there for. Taking it, an authored `section_notes` moved the timeline into the author's
// tab and poured the author's fields into it.
//
// Limit: an authored section that takes an engine name cannot be told from the host when it holds no
// bound field, or holds that host's own control, so it is treated as one. An authored section with fields
// and no such control never is.
function isEngineHostSection(s) {
  const host = ENGINE_HOSTS.find((h) => h.name.test(String((s && s.name) || '')));
  if (!host) return false;
  return isEngineOwnedSection(s) || cellsOf(s).some((c) => classIdOf(c) === host.classId);
}

// The host an ENGINE want is recognised by: a section holding, unbound, the want's OWN control — the notes
// timeline's class id. The compiler's notes want shares its name with any authored `section_notes`, and
// taking one of those for its host — any unbound control once qualified, a maker's web resource beside the
// author's field included — meant the form never got its timeline, and the want re-patched the author's
// section on every build. A timeline host a maker added a field to still holds the control, so it is still
// found. A want whose cells name no class id falls back to any unbound control.
function holdsControlOf(want) {
  const ids = new Set(cellsOf(want).map(classIdOf).filter(Boolean));
  return (s) => cellsOf(s).some((c) => c && c.control && !c.control.fieldName && (!ids.size || ids.has(classIdOf(c))));
}

// A deployed section an authored section claims BY NAME: the LABEL and POSITION passes must not hand
// it to a different want. Its own want finds it through the name pass, which `skip` does not apply to
// — and the build MOVES a named section to the tab and form-column the spec places it in — so a label
// or position claim by another want would be followed by that move and route two authored sections'
// fields into one. `authoredNames` is every authored section name on the form, lower-cased
// (validation keeps them unique). Build and verify both pass it, so they keep matching the same
// containers.
function claimedByAuthoredName(authoredNames) {
  return (s) => {
    const name = String((s && s.name) || '').toLowerCase();
    return !!name && authoredNames.has(name);
  };
}

module.exports = { matchContainer, isEngineOwnedSection, isEngineHostSection, holdsControlOf, claimedByAuthoredName };

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

// The names the COMPILER gives the sections it adds itself: `section_notes` (notesSectionIntent) and
// `section_grid_<relationship>` (subgridSectionIntent), both in artifact-intent.js.
const ENGINE_SECTION_NAME = /^(?:section_notes|section_grid_.*)$/i;

// An engine HOST: an engine-owned section that still carries the name the compiler gave it. This — not
// isEngineOwnedSection alone — is what an AUTHORED want's NAME pass skips. The structure says a section
// holds only unbound controls; it cannot say who laid the section out. An authored section declared with
// no fields that a maker then filled with a web resource, an iframe or a sub-grid is structurally the
// same, and its name is the one positive evidence that it is the author's: skipping it created an empty
// duplicate beside it, and when the spec moved it, left the maker's control behind in the old tab. The
// label and position passes still skip every engine-owned section — those carry no such evidence.
//
// Limit: an authored section that takes an engine name AND holds no bound field cannot be told from the
// host, so it is treated as one. An authored section with fields never is.
function isEngineHostSection(s) {
  return isEngineOwnedSection(s) && ENGINE_SECTION_NAME.test(String((s && s.name) || ''));
}

// Does the section hold a control that binds no field — the notes timeline, a sub-grid, a web resource?
// An ENGINE want's host is recognised by that. The compiler's notes want shares its name with any
// authored `section_notes`, and taking the author's field section for its host meant an existing form
// never got its timeline: every build "found" the host there.
function holdsUnboundControl(s) {
  return ((s && s.rows) || []).some((r) => ((r && r.cells) || []).some((c) => c && c.control && !c.control.fieldName));
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

module.exports = { matchContainer, isEngineOwnedSection, isEngineHostSection, holdsUnboundControl, claimedByAuthoredName };

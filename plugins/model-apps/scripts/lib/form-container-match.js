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
// not claim. Returns `{ index, item }` or null.
function matchContainer(list, want, wantIndex, opts) {
  const items = list || [];
  const claimed = (opts && opts.claimed) || null;
  const skip = (opts && opts.skip) || (() => false);
  const eq = (a, b) => a !== undefined && a !== null && String(a).toLowerCase() === String(b || '').toLowerCase();
  const free = (i) => !claimed || !claimed.has(i);
  let idx = items.findIndex((x, i) => free(i) && want.name && eq(x.name, want.name));
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

module.exports = { matchContainer, isEngineOwnedSection };

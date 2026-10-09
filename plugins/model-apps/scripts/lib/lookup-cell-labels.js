'use strict';
// Repair, on a deployed form, the label an older build gave a lookup cell (ADO 6691205).
//
// Kept apart from lookup-labels.js on purpose: this half needs the form-topology helpers in
// artifact-intent.js, which itself requires entity-provision.js — and entity-provision.js requires
// lookup-labels.js. Folding the two together would close that loop.

const { lookupColumnsFor, isOldLookupFieldLabel } = require('./app-spec.js');
const { findFieldCellLocation } = require('./artifact-intent.js');
const { lookupKey } = require('./lookup-labels.js');

// The value at a JSON pointer such as `/tabs/0/columns/0/sections/0/rows/0/cells/0` — the form of
// pointer findFieldCellLocation returns, which only ever holds array indices and plain keys.
function atPointer(root, pointer) {
  let cur = root;
  for (const token of String(pointer).split('/').slice(1)) {
    if (cur == null) return undefined;
    cur = cur[token];
  }
  return cur;
}

// A bound cell's label is stored in the form. The SDK derives it from the column's DisplayName only
// when the cell has none, so a form built while the lookup column still carried the SDK's old default
// (the parent's logical name) keeps that name on the cell after the COLUMN is relabelled. A cell the SDK
// could not resolve a column for at push carries the field's own lower-case logical name instead — its
// control normalization defaults `label` to `fieldName`.
//
// Same rule as the column repair, and for the same reason — only the old default is touched. A cell is
// rewritten only when the spec sets no lookup.displayName AND its label is exactly an old default
// (isOldLookupFieldLabel: the parent's or the lookup's own lower-case logical name — a column's old default is
// only the first of these, which is why the two are separate predicates). It becomes what the column carries
// NOW (`lookupLabels`, from the data-model phase): the repaired label, or a maker's if the maker relabelled the
// column. With no record of the column's label — the phase did not run, or could not read it — the cell is left
// as it is rather than given a label nothing proves.
//
// Returns the logical names of the cells it relabelled.
async function repairLookupCellLabels({ provision, formId, entityLogical, spec, lookupLabels }) {
  const repaired = [];
  const child = String(entityLogical || '').toLowerCase();
  for (const lookup of lookupColumnsFor(spec, child)) {
    if (lookup.source === 'explicit') continue;
    const column = lookupLabels && lookupLabels[lookupKey(lookup.rel)];
    if (!column || !column.label) continue;
    // Re-read per cell: each updateElement rewrites the artifact, so an earlier pointer may be stale.
    // `await` is load-bearing — the SDK's artifact reads are async, and a bare call hands the pure
    // helpers below a Promise that silently matches nothing.
    const form = (await provision.getArtifact('form', formId)) || {};
    const location = findFieldCellLocation(form, lookup.logical);
    const cell = location && atPointer(form, location.cellPointer);
    const deployed = cell && cell.control && cell.control.label;
    if (typeof deployed !== 'string' || deployed === column.label || !isOldLookupFieldLabel(lookup.rel, deployed)) continue;
    // updateElement MERGES an object patch, so classId, isRequired and the rest of the control survive.
    await provision.updateElement('form', formId, `${location.cellPointer}/control`, { label: column.label });
    repaired.push(lookup.logical);
  }
  return repaired;
}

module.exports = { repairLookupCellLabels };

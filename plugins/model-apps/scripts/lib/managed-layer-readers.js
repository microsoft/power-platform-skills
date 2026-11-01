'use strict';

// managed-layer-readers.js — the ONE place that says how the saved and published layers of a managed group are read,
// by the group's family.
//
// WHY A SHARED MAP. A table publish ships the saved layer of everything on the table, so before a managed publish is sent,
// publishManagedScope (lib/managed-feature-contract.js) reads every committed group the store has on the scope — a form's
// publish also reads the table's managed views and charts, a sibling form, and so on. If each caller passed its own
// reader, every feature would have to read every other family's rows, and a feature that did not know a family would
// skip it. Instead each family registers its reader here once, and every publish reads each covered group with its own
// family's reader. A family with no entry is not read and not skipped: the publish fences the scope
// (`managed-publication-reader-missing`).
//
// A reader is `async (client, group) => ({ savedSha256, publishedSha256 })`:
//   client  a Dataverse client whose `get(path)` answers { status, body } (lib/sdk-http-client.js, sdk.dataverse);
//   group   the committed group (lib/managed-bindings.js): `root.id` is the row, `publication.desiredSha256` the hash
//           the family recorded, which the reader's hashes must be comparable with;
// and throws (`managed-publication-unverified`) for any read it cannot prove. Each entry is required lazily, so loading
// this map loads no family's code.
//
// Families add their entry with the change that commits their groups with a publication scope. A form and a dashboard
// are both systemform rows. A form's `desiredSha256` is the layer hash of its content (systemform-published.js
// systemFormLayerSha256). A dashboard's also covers the row's `type` and `objecttypecode`, read in the same GET
// (systemFormRootLayerSha256): which kind of dashboard it is and whether it belongs to a table decide whether it may be
// published as the one proved, so a change of either after the proof is drift, never published. A view or chart group
// owes no publish of its own (its publication is the build's table publish, state `not-needed`), so its reader only has
// to show its saved layer equal to its published one (savedquery-published.js).

const readSystemFormLayers = (client, group) => require('./systemform-published.js').readSystemFormLayers(client, group);
const readSystemFormRootLayers = (client, group) => require('./systemform-published.js').readSystemFormRootLayers(client, group);

const readSavedQueryLayers = (family) => (client, group) => require('./savedquery-published.js').readSavedQueryLayers(family, client, group);

const LAYER_READERS = Object.freeze({
  form: readSystemFormLayers,
  dashboard: readSystemFormRootLayers,
  view: readSavedQueryLayers('view'),
  chart: readSavedQueryLayers('chart'),
});

module.exports = { LAYER_READERS };

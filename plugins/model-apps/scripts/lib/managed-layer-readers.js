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
// Families add their entry with the change that commits their groups with a publication scope. A dashboard is a
// systemform row like a form, so both read the same way, and a dashboard's `desiredSha256` is the same layer hash
// (systemform-published.js systemFormLayerSha256).

const readSystemFormLayers = (client, group) => require('./systemform-published.js').readSystemFormLayers(client, group);

const LAYER_READERS = Object.freeze({
  form: readSystemFormLayers,
  dashboard: readSystemFormLayers,
});

module.exports = { LAYER_READERS };

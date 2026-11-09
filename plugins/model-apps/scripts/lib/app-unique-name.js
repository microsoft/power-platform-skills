'use strict';
// The app module's uniquename, as the build names the app it creates and finds (lib/sdk-build.js re-exports it), the teardown
// resolves it, and the standalone entries name the app's managed binding store (lib/managed-standalone-fence.js). One rule in one
// place: a store is named by this name (managed-bindings.js storeFileName), so an entry that derived it any other way would look
// for another file and read a build's debt as none.
//
// A DOWNLOADED/edit spec carries the app's REAL, immutable uniquename in `spec.app.uniqueName` — return it VERBATIM so the build's
// existing-app lookup (findArtifact) AND teardown resolve the SAME deployed app even after a display-name RENAME. A Dataverse
// appmodule uniquename never changes once created, so deriving it from the MUTABLE display name would miss the existing app on a
// rebuild and CREATE A DUPLICATE. An AUTHORED create-fresh spec has no `app.uniqueName`, so derive it deterministically from the
// publisher prefix + display name — the exact rule the builder creates with:
//   { solution: { publisherPrefix: 'contoso' }, app: { name: 'Stable Ids' } }  ->  'contoso_stableids'
function appUniqueName(spec) {
  if (spec.app && spec.app.uniqueName) return String(spec.app.uniqueName);
  const sol = spec.solution;
  return `${sol.publisherPrefix}_${spec.app.name}`.replace(/[^a-z0-9_]/gi, '').toLowerCase();
}

module.exports = { appUniqueName };

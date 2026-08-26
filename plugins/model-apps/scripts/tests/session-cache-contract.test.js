'use strict';
// SESSION-CACHE ORDERING INVARIANT — the guard for the plugin's persistent workspace.
//
// The vendored SDK enforces its workspace as an EPHEMERAL SESSION CACHE: `MakerSdk` records
// `sessionStartedAt`, and its internal read seam refuses a cached artifact whose `meta.fetchedAt`
// predates the instance, throwing `ARTIFACT_CACHE_PREDATES_SESSION`.
//
// The plugin does the opposite by design — `provisionSdk` owns a PERSISTENT `workspaceDir` that
// survives across runs, and the build engine has ~10 `getArtifact` reads.
//
// Live-probed against the real bundle while investigating this (issue #469): a second SDK instance
// reading an artifact that a PREVIOUS instance had fetched/pushed does throw
// `ARTIFACT_CACHE_PREDATES_SESSION`. A merely *created* entry does not — the guard keys on
// `fetchedAt`, which a create has not set. So the hazard is real but narrow.
//
// The engine is safe from it today only because every `getArtifact` read is preceded, IN THE SAME
// RUN, by either a `fetchArtifact` or a create. That is an ordering invariant nothing enforced, and
// it is invisible to the rest of the suite: every other test runs inside a single SDK session, so a
// violation would pass all of them and fail only on a user's SECOND build.
//
// Rather than re-probe SDK internals here (brittle, and it asserts the SDK's behaviour rather than
// the plugin's), this pins the invariant the PLUGIN owns and can break.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

test('the build engine never reads an artifact kind it does not also fetch or create', () => {
  // A kind that is only ever READ from the workspace is, by construction, reading a cache entry it
  // did not put there — which across runs is exactly ARTIFACT_CACHE_PREDATES_SESSION.
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'sdk-build.js'), 'utf8');
  const reads = [...src.matchAll(/provision\.getArtifact\(\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(reads.length > 0, 'the scan found the getArtifact reads it is meant to guard');

  for (const kind of new Set(reads)) {
    const fetched = new RegExp(`provision\\.fetchArtifact\\(\\s*'${kind}'`).test(src);
    const created = new RegExp(`provision\\.createArtifact\\(\\s*'${kind}'`).test(src)
      // Forms are built through createFormShell rather than a direct createArtifact, because the
      // adapter's createDefault serializes authored tabs before minting ids and throws.
      || (kind === 'form' && /createFormShell\(/.test(src));
    assert.ok(fetched || created,
      `'${kind}' is read from the workspace but never fetched or created in the same engine — `
      + "a user's SECOND build would hit ARTIFACT_CACHE_PREDATES_SESSION (see issue #469)");
  }
});

test('the changed-only flow does not read SDK artifacts across runs', () => {
  // --changed-only is the one flow built around state that OUTLIVES a run, so it is the obvious
  // place for a cross-run SDK read to appear. It must keep reading only its OWN snapshot metadata
  // and delegate all artifact work to a fresh buildModelApp (and therefore a fresh SDK session).
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'changed-only-flow.js'), 'utf8');
  for (const banned of ['getArtifact', 'fetchArtifact', 'pushArtifact', 'listArtifacts', 'queryTree', 'findElements']) {
    assert.ok(!new RegExp(`\\.${banned}\\(`).test(src),
      `changed-only-flow.js must not call ${banned} directly — it spans runs, so an SDK artifact `
      + 'read there would read a previous session\'s cache (issue #469). Delegate to buildModelApp instead.');
  }
});

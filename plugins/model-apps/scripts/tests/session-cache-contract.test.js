'use strict';
// WORKSPACE-CACHE ORDERING INVARIANT — the guard for the plugin's persistent workspace.
//
// HISTORY, because the rationale changed under us and the old one is misleading. The bundle this
// test was written against ENFORCED the workspace as an ephemeral session cache: `MakerSdk`
// recorded `sessionStartedAt` and refused a cached artifact whose `meta.fetchedAt` predated the
// instance, throwing `ARTIFACT_CACHE_PREDATES_SESSION` (issue #469).
//
// That enforcement is GONE from the SDK the plugin now vendors. Upstream replaced it with a 300s
// TIME-based staleness window: a read whose cached copy is older than the window revalidates
// against the server instead of failing, and the error no longer exists in the bundle at all.
// So #469's hard-failure hazard — a user's SECOND build throwing — is closed by the SDK, not here.
//
// The invariant below is kept anyway, because the replacement has its own sharp edge. Reads inside
// the 300s window are served from the local copy, and a mutation applied after a revalidation
// refreshed that copy can now raise `StaleArtifactError` ("any pointer derived from the old copy
// may now identify a different node"). Both hazards have the same root cause and the same fix:
// never READ or PUSH an artifact kind this run did not itself FETCH or CREATE, and re-derive a
// pointer from a fresh read rather than carrying one across a mutation.
//
// This asserts the invariant the PLUGIN owns, by source scan, rather than re-probing SDK internals
// (brittle, and it would assert the SDK's behaviour rather than the plugin's).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

test('the build engine never reads an artifact kind it does not also fetch or create', () => {
  // A kind that is only ever READ from the workspace is, by construction, reading a cache entry it
  // did not put there — a copy of unknown age from an earlier run.
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
      + "on a user's SECOND build that serves a previous run's copy, silently while it is inside "
      + 'the SDK 300s staleness window (see issue #469)');
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

test('the build engine never PUSHES an artifact kind it does not also fetch or create', () => {
  // The residual half of #469, and the one the read-side guard above does not cover.
  //
  // `pushArtifact` reads the artifact through the same internal seam `getArtifact` uses, so a push
  // of something cached by an EARLIER run serves that stale copy — and separately trips
  // ARTIFACT_LANGUAGE_MISMATCH once the plugin passes `languageCode`, because the stored artifact
  // language would disagree with the pushing SDK.
  //
  // Both are currently unreachable only because every push is preceded, in the same run, by a fetch
  // or a create. A future batch optimisation that pushed "known clean" artifacts without re-fetching
  // would make both reachable, and no other test would notice: the whole suite runs in one session,
  // so the failure appears on a user's SECOND build, not in CI.
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'sdk-build.js'), 'utf8');
  const pushes = [...src.matchAll(/provision\.pushArtifact\(\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(pushes.length > 0, 'the scan found the pushArtifact calls it is meant to guard');

  for (const kind of new Set(pushes)) {
    const fetched = new RegExp(`provision\\.fetchArtifact\\(\\s*'${kind}'`).test(src);
    const created = new RegExp(`provision\\.createArtifact\\(\\s*'${kind}'`).test(src)
      // Forms are built through createFormShell rather than a direct createArtifact, because the
      // adapter's createDefault serializes authored tabs before minting ids and throws.
      || (kind === 'form' && /createFormShell\(/.test(src));
    assert.ok(fetched || created,
      `'${kind}' is PUSHED but never fetched or created in the same engine — a second build would `
      + 'push a previous run\'s cached copy, and a non-default --language-code would additionally '
      + 'hit ARTIFACT_LANGUAGE_MISMATCH (see issue #469)');
  }
});
